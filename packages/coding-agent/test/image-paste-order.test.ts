/**
 * A character typed right after an image paste must land AFTER the image.
 *
 * The composer's bracketed-paste and Ctrl+V paths already serialize this: they
 * register the clipboard read with `CustomEditor`'s in-flight paste counter, so
 * later keystrokes queue behind it. The OSC 5522 enhanced-paste path (kitty,
 * Tern) reaches the composer through a TUI input listener instead, and that
 * listener never told the editor a paste was running, so a fast typist's next
 * character was inserted at the cursor while the clipboard read was still
 * resolving, and the image chip landed after it.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { chipLabel } from "@oh-my-pi/pi-tui/prompt/composer-attachments";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { getEditorTheme } from "@oh-my-pi/pi-tui/theme/tui-adapters";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EnhancedPasteController, PASTE_READ_TIMEOUT_MS } from "@oh-my-pi/pi-coding-agent/utils/enhanced-paste";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD3sAAAAASUVORK5CYII=";

type InputListenerResult = { consume: boolean } | undefined;
type InputListener = (data: string) => InputListenerResult;

/** One kitty OSC 5522 clipboard packet. */
const packet = (metadata: string, payload?: string) =>
	`\x1b]5522;${metadata}${payload === undefined ? "" : `;${payload}`}\x1b\\`;

const IMAGE_MIME = Buffer.from("image/png").toString("base64");
const TEXT_MIME = Buffer.from("text/plain").toString("base64");

/** The listing half of an enhanced paste: the terminal offers text and PNG. */
const LISTING = [
	packet("type=read:status=OK:pw=secret"),
	packet(`type=read:status=DATA:mime=${TEXT_MIME}`),
	packet(`type=read:status=DATA:mime=${IMAGE_MIME}`),
	packet("type=read:status=DONE"),
];

/** The read half: the terminal answers the controller's request with the PNG bytes. */
const IMAGE_BODY = [
	packet("type=read:status=OK"),
	packet(`type=read:status=DATA:mime=${IMAGE_MIME}`, Buffer.from(TINY_PNG, "base64").toString("base64")),
	packet("type=read:status=DONE"),
];

/** The read half for a request that carried `id`, which the terminal echoes on every response.
 *  `body` names the payload so a test can tell which paste's image landed. */
const imageBodyFor = (id: string, body: string) => [
	packet(`type=read:status=OK:id=${id}`),
	packet(`type=read:status=DATA:mime=${IMAGE_MIME}:id=${id}`, Buffer.from(body, "utf8").toString("base64")),
	packet(`type=read:status=DONE:id=${id}`),
];

async function createHarness() {
	const tempDir = await TempDir.create("@omp-paste-order-");
	const sessionManager = SessionManager.inMemory(tempDir.path());
	const editor = new CustomEditor(getEditorTheme());
	const listeners: InputListener[] = [];
	const startListeners: Array<() => void> = [];
	const showStatus = vi.fn();
	const session = {
		isStreaming: false,
		isCompacting: false,
		isGeneratingHandoff: false,
		isBashRunning: false,
		isEvalRunning: false,
		extensionRunner: undefined,
		prompt: vi.fn(async () => {}),
		queuedMessageCount: 0,
		abort: vi.fn(async () => {}),
		retry: vi.fn(async () => true),
		prewarmModelConnection: vi.fn(),
	};
	const ctx = {
		editor,
		session,
		viewSession: session,
		sessionManager,
		eventController: { isAwaitingAsyncWork: () => false },
		settings: Settings.isolated({}),
		keybindings: KeybindingsManager.inMemory(),
		dictationSpaceHold: vi.fn(),
		ui: {
			requestRender: vi.fn(),
			addInputListener: (listener: InputListener) => {
				listeners.push(listener);
				return () => {};
			},
			addStartListener: (listener: () => void) => {
				startListeners.push(listener);
				return () => {};
			},
			getFocused: () => editor,
			hasOverlay: () => false,
			terminal: { write: vi.fn(), refreshAppearance: vi.fn() },
		},
		compactionQueuedMessages: [],
		skillCommands: new Map(),
		fileSlashCommands: new Set(),
		locallySubmittedUserSignatures: new Set(),
		mcpTestEscapeHandlers: new Set(),
		isBashMode: false,
		isPythonMode: false,
		isBtwMode: false,
		hideToolActivity: false,
		toolOutputExpanded: false,
		lastSigintTime: 0,
		hasActiveBtw: () => false,
		hasActiveOmfg: () => false,
		hasActiveCleanse: () => false,
		dismissCommandReport: () => false,
		updateEditorBorderColor: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		syncIdleMaintenanceView: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		showStatus,
		showError: vi.fn(),
		handleClearCommand: vi.fn(),
		resetDisplayAfterAppearanceRefresh: vi.fn(),
		shutdown: vi.fn(async () => {}),
		clearEditor: () => editor.clearDraft(),
		withLocalSubmission: async <T>(_text: string, submit: () => Promise<T>) => submit(),
		isGuidedGoalInterviewActive: () => false,
		chatContainer: { children: [], setToolActivityVisible: vi.fn() },
		pendingShellContainer: { children: [] },
		showModelSelector: vi.fn(),
		showTreeSelector: vi.fn(),
		showUserMessageSelector: vi.fn(),
		showSessionSelector: vi.fn(),
		showDebugSelector: vi.fn(),
		showHistorySearch: vi.fn(),
		toggleThinkingBlockVisibility: vi.fn(),
		handleHotkeysCommand: vi.fn(),
		handlePlanModeCommand: vi.fn(),
		handleNewCommand: vi.fn(),
		handleSTTToggle: vi.fn(),
		handleBtwBranchKey: vi.fn(async () => true),
		handleBtwCopyKey: vi.fn(async () => true),
		canBranchBtw: () => false,
		canCopyBtw: () => false,
		canFollowUpBtw: () => false,
		handleBtwFollowUpKey: () => true,
		handlesBtwBranchKey: () => false,
		showAgentHub: vi.fn(),
	} as unknown as InteractiveModeContext;

	const controller = new InputController(ctx, {
		readImage: async () => ({ data: Buffer.from(TINY_PNG, "base64"), mimeType: "image/png" }),
		readText: async () => "",
		readMacFileUrls: async () => [],
		isTerminalLocal: () => true,
	});
	controller.setupKeyHandlers();
	for (const start of startListeners) start();

	/** One stdin read, dispatched the way `Tui` does: listeners first, then the focused component. */
	function send(data: string): void {
		for (const listener of listeners) {
			if (listener(data)?.consume) return;
		}
		editor.handleInput(data);
	}

	/** Wait for the chip to reach the buffer, failing rather than hanging if it never does. The
	 *  insert writes a file, so it needs macrotask turns, not just microtasks. The bound is a wall
	 *  clock, not a turn count: the base commit needs about 108 turns and a loaded host more. */
	async function chipLanded(): Promise<void> {
		// A turn cap, not a clock: `vi.useFakeTimers()` fakes `Date.now` and `performance.now`, so a
		// wall-clock bound would never expire and the loop would spin instead of failing.
		for (let i = 0; i < 5_000 && editor.pendingImages.length === 0; i++) {
			await new Promise(resolve => setImmediate(resolve));
		}
		expect(editor.pendingImages).toHaveLength(1);
	}

	return { editor, send, showStatus, tempDir, chipLanded };
}

describe("image paste ordering in the composer", () => {
	let settingsState: SettingsTestState | undefined;

	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		await Settings.init({ inMemory: true, overrides: { "images.autoResize": false } });
	});

	afterEach(() => {
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
	});

	it("keeps a character typed during an OSC 5522 image paste after the image", async () => {
		const { editor, send, tempDir, chipLanded } = await createHarness();
		try {
			for (const input of LISTING) send(input);
			for (const input of IMAGE_BODY) send(input);
			// The user keeps typing while the clipboard bytes are still being
			// normalized, persisted and measured.
			send("x");
			await chipLanded();
			// The hold releases once the paste handler returns, and the queued key drains then.
			for (let i = 0; i < 10; i++) await Promise.resolve();

			expect(editor.pendingImages).toHaveLength(1);
			expect(editor.getText()).toBe(`${chipLabel("image", 1)} x`);
		} finally {
			await tempDir.remove();
		}
	});

	it("releases the queue when the enhanced paste carries no image, so the next key still lands", async () => {
		const { editor, send, showStatus, tempDir } = await createHarness();
		try {
			// A listing that offers only text, then an empty read: the paste fails.
			send(packet("type=read:status=OK:pw=secret"));
			send(packet(`type=read:status=DATA:mime=${TEXT_MIME}`));
			send(packet("type=read:status=DONE"));
			send(packet("type=read:status=OK"));
			send(packet("type=read:status=DONE"));
			send("x");
			for (let i = 0; i < 50; i++) await Promise.resolve();

			expect(editor.pendingImages).toHaveLength(0);
			expect(editor.getText()).toBe("x");
			expect(showStatus).toHaveBeenCalledWith("Clipboard paste was empty");
		} finally {
			await tempDir.remove();
		}
	});

	it("keeps a second paste that arrives while the first insert is still running", async () => {
		const log: string[] = [];
		const insert = Promise.withResolvers<void>();
		let held = 0;
		const controller = new EnhancedPasteController({
			write: () => {},
			pasteText: () => log.push("text"),
			pasteImage: async () => {
				log.push("image");
				await insert.promise;
			},
			acceptsHtml: () => false,
			pasteHtml: () => {},
			showStatus: message => log.push(`status:${message}`),
			pasteNative: () => false,
			holdInput: () => {
				held++;
				return () => {
					held--;
				};
			},
		});

		for (const input of LISTING) controller.handleInput(input);
		for (const input of IMAGE_BODY) controller.handleInput(input);
		// The first insert is still running when the second paste's read is under way.
		for (const input of LISTING) controller.handleInput(input);
		for (const input of IMAGE_BODY.slice(0, 2)) controller.handleInput(input);
		insert.resolve();
		for (let i = 0; i < 50; i++) await Promise.resolve();
		// The second read finishes after the first insert settled.
		controller.handleInput(IMAGE_BODY[2]!);
		for (let i = 0; i < 50; i++) await Promise.resolve();

		expect(log).toEqual(["image", "image"]);
		expect(held).toBe(0);
	});

	it("keeps the hold through a slow insert instead of timing out mid-paste", async () => {
		vi.useFakeTimers();
		const log: string[] = [];
		const insert = Promise.withResolvers<void>();
		let held = 0;
		const controller = new EnhancedPasteController({
			write: () => {},
			pasteText: () => log.push("text"),
			pasteImage: async () => {
				log.push("image");
				await insert.promise;
			},
			acceptsHtml: () => false,
			pasteHtml: () => {},
			showStatus: message => log.push(`status:${message}`),
			pasteNative: () => false,
			holdInput: () => {
				held++;
				return () => {
					held--;
				};
			},
		});
		try {
			for (const input of LISTING) controller.handleInput(input);
			for (const input of IMAGE_BODY) controller.handleInput(input);
			// The insert is still running when the read deadline would have expired.
			vi.advanceTimersByTime(PASTE_READ_TIMEOUT_MS + 1);
			expect(held).toBe(1);

			insert.resolve();
			for (let i = 0; i < 50; i++) await Promise.resolve();

			expect(log).toEqual(["image"]);
			expect(held).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("drops a read that answers after the deadline instead of landing it late", async () => {
		vi.useFakeTimers();
		const log: string[] = [];
		const controller = new EnhancedPasteController({
			write: () => {},
			pasteText: () => log.push("text"),
			pasteImage: () => {
				log.push("image");
			},
			acceptsHtml: () => false,
			pasteHtml: () => {},
			showStatus: message => log.push(`status:${message}`),
			pasteNative: () => false,
			holdInput: () => () => {},
		});
		try {
			for (const input of LISTING) controller.handleInput(input);
			vi.advanceTimersByTime(PASTE_READ_TIMEOUT_MS + 1);
			for (const input of IMAGE_BODY) controller.handleInput(input);
			for (let i = 0; i < 50; i++) await Promise.resolve();

			expect(log).toEqual(["status:Clipboard paste timed out"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("drops a late answer to an abandoned read instead of landing it in the next paste", async () => {
		vi.useFakeTimers();
		const log: string[] = [];
		const writes: string[] = [];
		let held = 0;
		const controller = new EnhancedPasteController({
			write: data => writes.push(data),
			pasteText: () => log.push("text"),
			pasteImage: image => {
				log.push(`image:${Buffer.from(image.data, "base64").toString("utf8")}`);
			},
			acceptsHtml: () => false,
			pasteHtml: () => {},
			showStatus: message => log.push(`status:${message}`),
			pasteNative: () => false,
			holdInput: () => {
				held++;
				return () => {
					held--;
				};
			},
		});
		/** The `id` the controller put on its last read request. */
		const lastReadId = () => /id=([a-zA-Z0-9\-_+.]+)/.exec(writes.at(-1) ?? "")?.[1];
		try {
			// Paste A's read is never answered, so its deadline ends it.
			for (const input of LISTING) controller.handleInput(input);
			const idA = lastReadId();
			expect(idA).toBeDefined();
			vi.advanceTimersByTime(PASTE_READ_TIMEOUT_MS + 1);
			expect(held).toBe(0);

			// Paste B arrives whole and must land its own image.
			for (const input of LISTING) controller.handleInput(input);
			const idB = lastReadId();
			expect(idB).not.toBe(idA);
			for (const input of imageBodyFor(idB!, "B")) controller.handleInput(input);
			for (let i = 0; i < 50; i++) await Promise.resolve();
			expect(log).toEqual(["status:Clipboard paste timed out", "image:B"]);
			expect(held).toBe(0);

			// A's answer finally arrives. It must not land anywhere or take the hold.
			for (const input of imageBodyFor(idA!, "A")) controller.handleInput(input);
			for (let i = 0; i < 50; i++) await Promise.resolve();
			expect(log).toEqual(["status:Clipboard paste timed out", "image:B"]);
			expect(held).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("honours a host-supplied read deadline", async () => {
		vi.useFakeTimers();
		const log: string[] = [];
		let held = 0;
		const controller = new EnhancedPasteController(
			{
				write: () => {},
				pasteText: () => log.push("text"),
				pasteImage: () => {
					log.push("image");
				},
				acceptsHtml: () => false,
				pasteHtml: () => {},
				showStatus: message => log.push(`status:${message}`),
				pasteNative: () => false,
				holdInput: () => {
					held++;
					return () => {
						held--;
					};
				},
			},
			() => 1_000,
		);
		try {
			for (const input of LISTING) controller.handleInput(input);
			vi.advanceTimersByTime(1_001);

			expect(log).toEqual(["status:Clipboard paste timed out"]);
			expect(held).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("falls back to the default deadline for a value setTimeout cannot use", async () => {
		vi.useFakeTimers();
		const log: string[] = [];
		let held = 0;
		const handlers = {
			write: () => {},
			pasteText: () => log.push("text"),
			pasteImage: () => {
				log.push("image");
			},
			acceptsHtml: () => false,
			pasteHtml: () => {},
			showStatus: (message: string) => log.push(`status:${message}`),
			pasteNative: () => false,
			holdInput: () => {
				held++;
				return () => {
					held--;
				};
			},
		};
		try {
			// 0, a negative, NaN, Infinity and 2^31 all make setTimeout fire on the next tick, which
			// would drop every paste. Each must fall back to the default instead.
			for (const value of [0, -1, -5000, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
				log.length = 0;
				const controller = new EnhancedPasteController(handlers, () => value);
				for (const input of LISTING) controller.handleInput(input);
				vi.advanceTimersByTime(1);
				expect(log, `value ${value} must not fire at once`).toEqual([]);
				expect(held, `value ${value} keeps its hold`).toBe(1);

				vi.advanceTimersByTime(PASTE_READ_TIMEOUT_MS);
				expect(log, `value ${value} falls back to the default`).toEqual(["status:Clipboard paste timed out"]);
				expect(held).toBe(0);
			}

			// A fraction is truncated, not rejected: 1.5 ms becomes the 1 ms floor.
			log.length = 0;
			const fractional = new EnhancedPasteController(handlers, () => 1.5);
			for (const input of LISTING) fractional.handleInput(input);
			vi.advanceTimersByTime(1);
			expect(log).toEqual(["status:Clipboard paste timed out"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("lands a paste from a terminal that does not echo the read id", async () => {
		vi.useFakeTimers();
		const log: string[] = [];
		let held = 0;
		const controller = new EnhancedPasteController({
			write: () => {},
			pasteText: () => log.push("text"),
			pasteImage: image => {
				log.push(`image:${Buffer.from(image.data, "base64").toString("utf8")}`);
			},
			acceptsHtml: () => false,
			pasteHtml: () => {},
			showStatus: message => log.push(`status:${message}`),
			pasteNative: () => false,
			holdInput: () => {
				held++;
				return () => {
					held--;
				};
			},
		});
		try {
			// A terminal that ignores the `id` answers without it, which must not drop the paste.
			for (const input of LISTING) controller.handleInput(input);
			for (const input of imageBodyFor("", "A").map(input => input.replace(/:id=/g, ":unused="))) {
				controller.handleInput(input);
			}
			for (let i = 0; i < 50; i++) await Promise.resolve();

			expect(log).toEqual(["image:A"]);
			expect(held).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not start a phantom paste from a late answer with no paste after it", async () => {
		vi.useFakeTimers();
		const log: string[] = [];
		const writes: string[] = [];
		let held = 0;
		const controller = new EnhancedPasteController({
			write: data => writes.push(data),
			pasteText: () => log.push("text"),
			pasteImage: image => {
				log.push(`image:${Buffer.from(image.data, "base64").toString("utf8")}`);
			},
			acceptsHtml: () => false,
			pasteHtml: () => {},
			showStatus: message => log.push(`status:${message}`),
			pasteNative: () => false,
			holdInput: () => {
				held++;
				return () => {
					held--;
				};
			},
		});
		try {
			for (const input of LISTING) controller.handleInput(input);
			const idA = /id=([a-zA-Z0-9\-_+.]+)/.exec(writes.at(-1) ?? "")?.[1];
			expect(idA).toBeDefined();
			vi.advanceTimersByTime(PASTE_READ_TIMEOUT_MS + 1);
			expect(held).toBe(0);

			for (const input of imageBodyFor(idA!, "A")) controller.handleInput(input);
			for (let i = 0; i < 50; i++) await Promise.resolve();

			expect(log).toEqual(["status:Clipboard paste timed out"]);
			expect(held).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("lets typing resume after a read the terminal never answered, then takes the next paste", async () => {
		vi.useFakeTimers();
		const { editor, send, showStatus, tempDir, chipLanded } = await createHarness();
		try {
			// The first paste's read is never answered.
			for (const input of LISTING) send(input);
			vi.advanceTimersByTime(PASTE_READ_TIMEOUT_MS + 1);
			expect(showStatus).toHaveBeenCalledWith("Clipboard paste timed out");

			// Typing is not frozen, and the next paste still lands.
			send("x");
			expect(editor.getText()).toBe("x");
			for (const input of LISTING) send(input);
			for (const input of IMAGE_BODY) send(input);
			await chipLanded();

			expect(editor.pendingImages).toHaveLength(1);
			expect(editor.getText()).toBe(`x${chipLabel("image", 1)} `);
		} finally {
			vi.useRealTimers();
			await tempDir.remove();
		}
	});

	it("resumes typing when the terminal never answers the read request", async () => {
		vi.useFakeTimers();
		const { editor, send, showStatus, tempDir } = await createHarness();
		try {
			// The listing arrives, then the terminal goes silent: no read reply ever comes.
			send(packet("type=read:status=OK:pw=secret"));
			send(packet(`type=read:status=DATA:mime=${IMAGE_MIME}`));
			send(packet("type=read:status=DONE"));
			send("x");
			expect(editor.getText()).toBe("");

			vi.advanceTimersByTime(PASTE_READ_TIMEOUT_MS + 1);

			expect(editor.getText()).toBe("x");
			expect(showStatus).toHaveBeenCalledWith("Clipboard paste timed out");
		} finally {
			vi.useRealTimers();
			await tempDir.remove();
		}
	});
});
