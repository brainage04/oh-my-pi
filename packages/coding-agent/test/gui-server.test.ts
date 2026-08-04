import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { commands } from "../src/cli-commands";
import { KEYBINDINGS } from "../src/config/keybindings";
import { SETTINGS_SCHEMA } from "../src/config/settings-schema";
import { OmpGuiBackend } from "../src/gui-server/backend";
import type {
	GuiBackend,
	GuiBackendEvent,
	GuiConsoleRequest,
	GuiLiveMessage,
	GuiSessionSummary,
	GuiTranscriptPage,
} from "../src/gui-server/backend-types";
import { GuiBackendError } from "../src/gui-server/backend-types";
import { GuiConsoleSession, type GuiConsoleState } from "../src/gui-server/console";
import { buildGuiControlCatalog, type GuiControlCatalog } from "../src/gui-server/control-catalog";
import { ManagedSessionStore } from "../src/gui-server/managed-session-store";
import { GUI_PROTOCOL_VERSION } from "../src/gui-server/protocol";
import { GuiServer } from "../src/gui-server/server";
import { BUILTIN_SLASH_COMMANDS_INTERNAL } from "../src/slash-commands/builtin-registry";

interface TestFrame {
	protocolVersion: number;
	kind: string;
	requestId?: string;
	requestKind?: string;
	event?: string;
	operationId?: string;
	ok?: boolean;
	data?: unknown;
	error?: { code: string; message: string };
}

class FakeBackend implements GuiBackend {
	readonly #listeners = new Set<(event: GuiBackendEvent) => void>();
	readonly #sessions = new Map<string, GuiSessionSummary>();
	#console: GuiConsoleState | undefined;
	largeCatalog = false;
	#createCount = 0;

	constructor() {
		this.#sessions.set("terminal-session", this.#summary("terminal-session", false));
	}

	#summary(id: string, managed: boolean): GuiSessionSummary {
		return {
			id,
			cwd: "/tmp/project",
			title: id,
			createdAt: "2026-08-03T00:00:00.000Z",
			modifiedAt: "2026-08-03T00:00:00.000Z",
			messageCount: 0,
			state: "idle",
			managed,
			writable: managed,
		};
	}

	async listSessions(): Promise<GuiSessionSummary[]> {
		return [...this.#sessions.values()];
	}

	async createSession(_cwd: string, _name?: string): Promise<GuiSessionSummary> {
		const session = this.#summary(`managed-${++this.#createCount}`, true);
		this.#sessions.set(session.id, session);
		return session;
	}

	async forkSession(sessionId: string, name?: string): Promise<GuiSessionSummary> {
		if (!this.#sessions.has(sessionId)) throw new GuiBackendError("session_not_found", "missing");
		const session = this.#summary(`fork-${++this.#createCount}`, true);
		session.title = name ?? `${sessionId} (GUI fork)`;
		this.#sessions.set(session.id, session);
		return session;
	}

	async transcriptPage(_sessionId: string, _before?: string, _limit?: number): Promise<GuiTranscriptPage> {
		return { items: [] };
	}

	async prompt(sessionId: string, _text: string, operationId: string): Promise<{ agentInvoked: boolean }> {
		if (!this.isManaged(sessionId)) throw new GuiBackendError("read_only_session", "read only");
		this.#emit({
			event: "message_started",
			sessionId,
			operationId,
			data: {
				id: `live:${operationId}`,
				timestamp: "2026-08-03T00:00:01.000Z",
				kind: "message",
				role: "assistant",
				text: "",
			},
		});
		this.#emit({ event: "message_delta", sessionId, operationId, data: { delta: "fixture", contentIndex: 0 } });
		await Bun.sleep(5);
		return { agentInvoked: true };
	}

	async controlCatalog(_sessionId?: string): Promise<GuiControlCatalog> {
		if (this.largeCatalog) {
			return {
				keybindingCount: 0,
				slashCommandCount: 0,
				settingCount: 1,
				cliCommandCount: 0,
				cliOptionCount: 0,
				cliArgumentCount: 0,
				items: [{ kind: "setting", id: "setting:large", title: "Large", detail: "x".repeat(900_000) }],
			};
		}
		return {
			keybindingCount: 0,
			slashCommandCount: 0,
			settingCount: 0,
			cliCommandCount: 0,
			cliOptionCount: 0,
			cliArgumentCount: 0,
			items: [],
		};
	}

	consoleState(): GuiConsoleState | undefined {
		return this.#console;
	}

	async startConsole(request: GuiConsoleRequest): Promise<GuiConsoleState> {
		this.#console = {
			consoleId: "test-console",
			mode: request.mode,
			status: "running",
			sessionId: request.sessionId,
			commandLine: request.commandLine ?? "omp launch",
			cwd: request.cwd ?? "/tmp/project",
			cols: request.cols ?? 120,
			rows: request.rows ?? 40,
			screen: "OMP console",
			cursorX: 0,
			cursorY: 0,
		};
		return this.#console;
	}

	writeConsole(consoleId: string, data: string): void {
		if (!this.#console || this.#console.consoleId !== consoleId)
			throw new GuiBackendError("console_not_found", "missing");
		this.#console.screen += data;
	}

	resizeConsole(consoleId: string, cols: number, rows: number): GuiConsoleState {
		if (!this.#console || this.#console.consoleId !== consoleId)
			throw new GuiBackendError("console_not_found", "missing");
		this.#console.cols = cols;
		this.#console.rows = rows;
		return this.#console;
	}

	async stopConsole(consoleId: string): Promise<GuiConsoleState> {
		if (!this.#console || this.#console.consoleId !== consoleId)
			throw new GuiBackendError("console_not_found", "missing");
		this.#console.status = "exited";
		this.#console.exitCode = 0;
		return this.#console;
	}

	async shutdownSession(sessionId: string): Promise<void> {
		if (!this.isManaged(sessionId)) throw new GuiBackendError("read_only_session", "read only");
		this.#sessions.delete(sessionId);
	}

	isManaged(sessionId: string): boolean {
		return this.#sessions.get(sessionId)?.managed === true;
	}

	liveMessages(): GuiLiveMessage[] {
		return [];
	}

	subscribe(listener: (event: GuiBackendEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async dispose(): Promise<void> {}

	#emit(event: GuiBackendEvent): void {
		for (const listener of this.#listeners) listener(event);
	}
}

class TestClient {
	readonly #frames: TestFrame[] = [];
	readonly #waiters = new Set<() => void>();
	#input = "";
	#socket: Bun.Socket<undefined> | undefined;

	static async connect(socketPath: string): Promise<TestClient> {
		const client = new TestClient();
		client.#socket = await Bun.connect({
			unix: socketPath,
			socket: {
				data: (_socket, data) => client.#receive(data),
			},
		});
		return client;
	}

	#receive(data: Uint8Array): void {
		this.#input += Buffer.from(data).toString("utf8");
		while (true) {
			const newline = this.#input.indexOf("\n");
			if (newline < 0) break;
			const line = this.#input.slice(0, newline);
			this.#input = this.#input.slice(newline + 1);
			this.#frames.push(JSON.parse(line) as TestFrame);
		}
		for (const waiter of this.#waiters) waiter();
	}

	send(requestId: string, command: string, params: Record<string, unknown> = {}): void {
		this.#socket?.write(
			`${JSON.stringify({ protocolVersion: GUI_PROTOCOL_VERSION, kind: "request", requestId, command, params })}\n`,
		);
	}

	sendRaw(line: string): void {
		this.#socket?.write(`${line}\n`);
	}

	async next(predicate: (frame: TestFrame) => boolean): Promise<TestFrame> {
		const deadline = Date.now() + 2_000;
		while (true) {
			const index = this.#frames.findIndex(predicate);
			if (index >= 0) return this.#frames.splice(index, 1)[0] as TestFrame;
			if (Date.now() >= deadline) throw new Error("Timed out waiting for GUI protocol frame.");
			const wake = Promise.withResolvers<void>();
			const listener = (): void => wake.resolve();
			this.#waiters.add(listener);
			await Promise.race([wake.promise, Bun.sleep(25)]);
			this.#waiters.delete(listener);
		}
	}

	async request(requestId: string, command: string, params: Record<string, unknown> = {}): Promise<TestFrame> {
		this.send(requestId, command, params);
		return await this.next(frame => frame.kind === "response" && frame.requestId === requestId);
	}

	close(): void {
		this.#socket?.end();
		this.#socket = undefined;
	}
}

let server: GuiServer | undefined;
let temporaryDirectory: string | undefined;
const clients: TestClient[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) client.close();
	await server?.stop();
	server = undefined;
	if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
	temporaryDirectory = undefined;
});

async function setup(): Promise<{ backend: FakeBackend; socketPath: string }> {
	temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-server-test-"));
	const socketPath = path.join(temporaryDirectory, "gui.sock");
	const backend = new FakeBackend();
	server = await GuiServer.start(socketPath, backend);
	return { backend, socketPath };
}

async function connectNegotiated(socketPath: string): Promise<TestClient> {
	const client = await TestClient.connect(socketPath);
	clients.push(client);
	const response = await client.request("negotiate", "negotiate", { supportedVersions: [1] });
	expect(response.ok).toBe(true);
	return client;
}

describe("GUI server protocol", () => {
	test("negotiates capabilities and rejects unknown commands without dropping the connection", async () => {
		const { socketPath } = await setup();
		const client = await connectNegotiated(socketPath);
		const unknown = await client.request("unknown", "future_command");
		expect(unknown.error?.code).toBe("unsupported_command");
		const health = await client.request("health", "health");
		expect(health.ok).toBe(true);
		expect((health.data as { status: string }).status).toBe("ok");
	});

	test("keeps managed sessions alive across client disconnect and reconnect", async () => {
		const { socketPath } = await setup();
		const first = await connectNegotiated(socketPath);
		const created = await first.request("create", "create_session", { cwd: "/tmp/project" });
		const sessionId = (created.data as { session: GuiSessionSummary }).session.id;
		first.close();
		const second = await connectNegotiated(socketPath);
		const catalog = await second.request("list", "list_sessions");
		const sessions = (catalog.data as { sessions: GuiSessionSummary[] }).sessions;
		expect(sessions.find(session => session.id === sessionId)?.writable).toBe(true);
	});

	test("forks a terminal-created session into an independently writable GUI session", async () => {
		const { socketPath } = await setup();
		const client = await connectNegotiated(socketPath);
		const forked = await client.request("fork", "fork_session", {
			sessionId: "terminal-session",
			title: "Writable branch",
		});
		expect(forked.ok).toBe(true);
		expect(forked.data).toEqual({
			session: expect.objectContaining({
				id: "fork-1",
				title: "Writable branch",
				managed: true,
				writable: true,
			}),
		});
		const sessions = (await client.request("list-after-fork", "list_sessions")).data as {
			sessions: GuiSessionSummary[];
		};
		expect(sessions.sessions.find(session => session.id === "terminal-session")?.writable).toBe(false);
		expect(sessions.sessions.find(session => session.id === "fork-1")?.writable).toBe(true);
	});

	test("correlates prompt acceptance, streaming events, and terminal completion", async () => {
		const { socketPath } = await setup();
		const client = await connectNegotiated(socketPath);
		const created = await client.request("create", "create_session", { cwd: "/tmp/project" });
		const sessionId = (created.data as { session: GuiSessionSummary }).session.id;
		const accepted = await client.request("prompt", "prompt", { sessionId, text: "fixture" });
		const operationId = (accepted.data as { operationId: string }).operationId;
		const delta = await client.next(frame => frame.event === "message_delta" && frame.operationId === operationId);
		expect((delta.data as { delta: string }).delta).toBe("fixture");
		const completed = await client.next(
			frame => frame.event === "operation_completed" && frame.operationId === operationId,
		);
		expect((completed.data as { agentInvoked: boolean }).agentInvoked).toBe(true);
	});

	test("requires connection-bound confirmation and refuses terminal-created shutdown", async () => {
		const { socketPath } = await setup();
		const client = await connectNegotiated(socketPath);
		const terminal = await client.request("terminal-confirm", "request_shutdown_confirmation", {
			sessionId: "terminal-session",
		});
		expect(terminal.error?.code).toBe("read_only_session");

		const created = await client.request("create", "create_session", { cwd: "/tmp/project" });
		const sessionId = (created.data as { session: GuiSessionSummary }).session.id;
		const confirmation = await client.request("confirm", "request_shutdown_confirmation", { sessionId });
		const confirmationId = (confirmation.data as { confirmationId: string }).confirmationId;
		const accepted = await client.request("shutdown", "shutdown_session", { sessionId, confirmationId });
		const operationId = (accepted.data as { operationId: string }).operationId;
		await client.next(frame => frame.event === "operation_completed" && frame.operationId === operationId);
		const catalog = await client.request("list", "list_sessions");
		expect(
			(catalog.data as { sessions: GuiSessionSummary[] }).sessions.some(session => session.id === sessionId),
		).toBe(false);
	});

	test("exposes catalog and persistent console lifecycle commands", async () => {
		const { socketPath } = await setup();
		const client = await connectNegotiated(socketPath);
		const catalog = await client.request("catalog", "get_control_catalog");
		expect(catalog.data).toEqual({ catalog: expect.objectContaining({ items: [] }) });

		const started = await client.request("console-start", "start_console", {
			mode: "command",
			commandLine: "models --json",
			cwd: "/tmp/project",
			cols: 100,
			rows: 30,
		});
		const consoleId = "test-console";
		expect(started.data).toEqual({ console: expect.objectContaining({ consoleId }) });
		expect((await client.request("console-input", "console_input", { consoleId, data: "x" })).ok).toBe(true);
		const state = await client.request("console-state", "console_state");
		expect(state.data).toEqual({ console: expect.objectContaining({ screen: "OMP consolex" }) });
		const resized = await client.request("console-resize", "console_resize", { consoleId, cols: 90, rows: 24 });
		expect(resized.data).toEqual({ console: expect.objectContaining({ cols: 90, rows: 24 }) });
		const stopped = await client.request("console-stop", "stop_console", { consoleId });
		expect(stopped.data).toEqual({ console: expect.objectContaining({ status: "exited" }) });
	});
});
test("serializes concurrent responses under socket backpressure", async () => {
	const { backend, socketPath } = await setup();
	backend.largeCatalog = true;
	const client = await connectNegotiated(socketPath);
	client.send("large-catalog", "get_control_catalog");
	client.send("parallel-health", "health");
	client.send("parallel-reconcile", "reconcile");
	const [catalog, health, reconcile] = await Promise.all([
		client.next(frame => frame.requestId === "large-catalog"),
		client.next(frame => frame.requestId === "parallel-health"),
		client.next(frame => frame.requestId === "parallel-reconcile"),
	]);
	expect(catalog).toEqual(
		expect.objectContaining({
			ok: true,
			data: expect.objectContaining({
				catalog: expect.objectContaining({ settingCount: 1 }),
			}),
		}),
	);
	expect(health.ok).toBe(true);
	expect(reconcile.ok).toBe(true);
});

describe("managed GUI session ownership", () => {
	test("persists private state and reloads managed records", async () => {
		temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-store-test-"));
		const store = await ManagedSessionStore.create(temporaryDirectory);
		const record = {
			id: "managed-session",
			path: "/tmp/managed-session.jsonl",
			cwd: "/tmp/project",
			createdAt: "2026-08-03T00:00:00.000Z",
		};
		await store.set(record);

		const stateDirectory = await fs.stat(temporaryDirectory);
		const manifest = await fs.stat(path.join(temporaryDirectory, "managed-sessions.json"));
		expect(stateDirectory.mode & 0o777).toBe(0o700);
		expect(manifest.mode & 0o777).toBe(0o600);
		await expect(
			ManagedSessionStore.create(temporaryDirectory).then(reloaded => reloaded.get(record.id)),
		).resolves.toEqual(record);
	});
});

describe("GUI console process", () => {
	test("runs a fixed executable in a PTY and retains the final emulated screen", async () => {
		if (process.platform === "win32") return;
		const previousCommand = Bun.env.PI_SUBPROCESS_CMD;
		Bun.env.PI_SUBPROCESS_CMD = "/bin/echo";
		const exited = Promise.withResolvers<GuiConsoleState>();
		const events: string[] = [];
		const console = new GuiConsoleSession(
			{
				mode: "command",
				commandLine: "models --json",
				cwd: process.cwd(),
				cols: 80,
				rows: 24,
			},
			(event, state) => {
				events.push(event);
				if (event === "console_exited") exited.resolve(state);
			},
		);
		try {
			const state = await exited.promise;
			expect(events).toContain("console_started");
			expect(events).toContain("console_exited");
			expect(state.status).toBe("exited");
			expect(state.commandLine).toBe("omp models --json");
			expect(state.screen).toContain("models --json");
			expect(state.exitCode).toBe(0);
		} finally {
			await console.dispose();
			if (previousCommand === undefined) {
				delete Bun.env.PI_SUBPROCESS_CMD;
			} else {
				Bun.env.PI_SUBPROCESS_CMD = previousCommand;
			}
		}
	});

	test("backend accepts the first console and publishes its lifecycle", async () => {
		if (process.platform === "win32") return;
		temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-console-test-"));
		const previousCommand = Bun.env.PI_SUBPROCESS_CMD;
		Bun.env.PI_SUBPROCESS_CMD = "/bin/echo";
		const backend = await OmpGuiBackend.create({ stateDir: temporaryDirectory });
		const exited = Promise.withResolvers<GuiConsoleState>();
		const unsubscribe = backend.subscribe(event => {
			const current = backend.consoleState();
			if (event.event === "console_exited" && current) exited.resolve(current);
		});
		try {
			const started = await backend.startConsole({
				mode: "command",
				commandLine: "--version",
				cwd: process.cwd(),
			});
			expect(started.status).not.toBe("exited");
			expect((await exited.promise).exitCode).toBe(0);
		} finally {
			unsubscribe();
			await backend.dispose();
			if (previousCommand === undefined) {
				delete Bun.env.PI_SUBPROCESS_CMD;
			} else {
				Bun.env.PI_SUBPROCESS_CMD = previousCommand;
			}
		}
	});
});

describe("GUI control catalog parity", () => {
	test("exports every canonical keybinding, slash command, setting, CLI command, option, and argument", async () => {
		const catalog = await buildGuiControlCatalog();
		const ids = new Set(catalog.items.map(item => item.id));

		expect(catalog.keybindingCount).toBe(Object.keys(KEYBINDINGS).length);
		for (const id of Object.keys(KEYBINDINGS)) expect(ids.has(id)).toBe(true);

		expect(catalog.slashCommandCount).toBe(BUILTIN_SLASH_COMMANDS_INTERNAL.length);
		for (const command of BUILTIN_SLASH_COMMANDS_INTERNAL) {
			expect(ids.has(`slash:${command.name}`)).toBe(true);
			for (const subcommand of command.subcommands ?? []) {
				expect(ids.has(`slash:${command.name}:${subcommand.name}`)).toBe(true);
			}
		}

		expect(catalog.settingCount).toBe(Object.keys(SETTINGS_SCHEMA).length);
		for (const path of Object.keys(SETTINGS_SCHEMA)) expect(ids.has(`setting:${path}`)).toBe(true);

		expect(catalog.cliCommandCount).toBe(commands.length);
		let flagCount = 0;
		let argumentCount = 0;
		for (const entry of commands) {
			expect(ids.has(`cli:${entry.name}`)).toBe(true);
			const command = await entry.load();
			for (const flag of Object.keys(command.flags ?? {})) {
				flagCount += 1;
				expect([...ids]).toContain(`cli-option:${entry.name}:${flag}`);
			}
			for (const argument of Object.keys(command.args ?? {})) {
				argumentCount += 1;
				expect([...ids]).toContain(`cli-argument:${entry.name}:${argument}`);
			}
		}
		expect(catalog.cliOptionCount).toBe(flagCount);
		expect(catalog.cliArgumentCount).toBe(argumentCount);
	});
});
