import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
	GuiBackend,
	GuiBackendEvent,
	GuiLiveMessage,
	GuiSessionSummary,
	GuiTranscriptPage,
} from "../src/gui-server/backend-types";
import { GuiBackendError } from "../src/gui-server/backend-types";
import { ManagedSessionStore } from "../src/gui-server/managed-session-store";
import { GUI_PROTOCOL_VERSION } from "../src/gui-server/protocol";
import { GuiServer } from "../src/gui-server/server";

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
