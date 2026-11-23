/**
 * A character typed right after an image paste must land AFTER the image.
 *
 * The composer's bracketed-paste and Ctrl+V paths already serialize this: they
 * register the clipboard read with `CustomEditor`'s in-flight paste counter, so
 * later keystrokes queue behind it. The OSC 5522 enhanced-paste path (kitty,
 * Tern) reaches the composer through a TUI input listener instead, and that
 * listener never told the editor a paste was running — so a fast typist's next
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
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

/** Mirrors `PASTE_HOLD_TIMEOUT_MS` in `utils/enhanced-paste.ts`. */
const PASTE_HOLD_TIMEOUT_MS = 5000;

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

	// The chip lands through `insertAtom`; its call is the paste's completion signal.
	const chipInserted = Promise.withResolvers<void>();
	const insertAtom = editor.insertAtom.bind(editor);
	editor.insertAtom = (label: string, expansion: string) => {
		insertAtom(label, expansion);
		chipInserted.resolve();
	};

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

	return { editor, send, showStatus, tempDir, chipInserted: chipInserted.promise };
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
		const { editor, send, tempDir, chipInserted } = await createHarness();
		try {
			for (const input of LISTING) send(input);
			for (const input of IMAGE_BODY) send(input);
			// The user keeps typing while the clipboard bytes are still being
			// normalized, persisted and measured.
			send("x");
			await chipInserted;
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

			vi.advanceTimersByTime(PASTE_HOLD_TIMEOUT_MS + 1);

			expect(editor.getText()).toBe("x");
			expect(showStatus).toHaveBeenCalledWith("Clipboard paste timed out");
		} finally {
			vi.useRealTimers();
			await tempDir.remove();
		}
	});
});
