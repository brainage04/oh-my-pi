import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, toError, VERSION } from "@oh-my-pi/pi-utils";
import { AgentRegistry, createAgentSession } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionEvent } from "../session/agent-session-events";
import type { SessionEntry } from "../session/session-entries";
import type { SessionInfo, SessionStatus } from "../session/session-listing";
import { loadEntriesFromFile } from "../session/session-loader";
import { SessionManager } from "../session/session-manager";
import { FileSessionStorage } from "../session/session-storage";
import {
	type GuiBackend,
	GuiBackendError,
	type GuiBackendEvent,
	type GuiBackendIdentity,
	type GuiLiveMessage,
	type GuiSessionSummary,
	type GuiTranscriptItem,
	type GuiTranscriptPage,
} from "./backend-types";
import { type ManagedSessionRecord, ManagedSessionStore } from "./managed-session-store";
import { projectMessage, projectSessionEvent } from "./message-projection";

const DEFAULT_TRANSCRIPT_LIMIT = 100;
const MAX_TRANSCRIPT_LIMIT = 500;

interface ManagedRuntime {
	record: ManagedSessionRecord;
	session: AgentSession;
	operationId?: string;
	unsubscribe: () => void;
}

function statusToState(status: SessionStatus | undefined): GuiSessionSummary["state"] {
	switch (status) {
		case "complete":
			return "completed";
		case "interrupted":
		case "aborted":
			return "interrupted";
		case "error":
			return "failed";
		case "pending":
			return "queued";
		default:
			return "idle";
	}
}

function transcriptItems(entries: readonly SessionEntry[]): GuiTranscriptItem[] {
	const items: GuiTranscriptItem[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const item = projectMessage(entry.message, entry.id, entry.timestamp);
		if (item.text.length > 0 || item.role === "tool") items.push(item);
	}
	return items;
}

function decodeBefore(before: string | undefined, itemCount: number): number {
	if (before === undefined) return itemCount;
	if (!/^\d+$/.test(before)) throw new GuiBackendError("invalid_cursor", "Transcript cursor is invalid.");
	const parsed = Number.parseInt(before, 10);
	if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > itemCount) {
		throw new GuiBackendError("invalid_cursor", "Transcript cursor is outside this transcript.");
	}
	return parsed;
}

function boundedLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_TRANSCRIPT_LIMIT;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TRANSCRIPT_LIMIT) {
		throw new GuiBackendError("invalid_limit", `Transcript limit must be between 1 and ${MAX_TRANSCRIPT_LIMIT}.`);
	}
	return limit;
}

function summaryFromInfo(info: SessionInfo, managed: boolean, runtime: ManagedRuntime | undefined): GuiSessionSummary {
	return {
		id: info.id,
		cwd: info.cwd,
		title: info.title?.trim() || info.firstMessage.trim() || "Untitled session",
		createdAt: info.created.toISOString(),
		modifiedAt: info.modified.toISOString(),
		messageCount: info.messageCount,
		managed,
		writable: managed,
		state: runtime?.session.isStreaming ? "streaming" : statusToState(info.status),
	};
}

export interface OmpGuiBackendOptions {
	stateDir?: string;
}

export class OmpGuiBackend implements GuiBackend {
	readonly #storage = new FileSessionStorage();
	readonly #runtimes = new Map<string, ManagedRuntime>();
	readonly #listeners = new Set<(event: GuiBackendEvent) => void>();
	readonly #daemonId = crypto.randomUUID();
	#managed: ManagedSessionStore | undefined;
	readonly #stateDir: string;

	constructor(options: OmpGuiBackendOptions) {
		this.#stateDir = options.stateDir ?? path.join(getAgentDir(), "gui-server");
	}

	static async create(options: OmpGuiBackendOptions = {}): Promise<OmpGuiBackend> {
		const backend = new OmpGuiBackend(options);
		backend.#managed = await ManagedSessionStore.create(backend.#stateDir);
		return backend;
	}

	identity(): GuiBackendIdentity {
		return { daemonId: this.#daemonId, runtimeVersion: VERSION };
	}

	subscribe(listener: (event: GuiBackendEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async listSessions(): Promise<GuiSessionSummary[]> {
		const managed = this.#store();
		const sessions = await SessionManager.listAll(this.#storage);
		return sessions.map(info => summaryFromInfo(info, managed.has(info.id), this.#runtimes.get(info.id)));
	}

	async createSession(cwd: string, name?: string): Promise<GuiSessionSummary> {
		const resolvedCwd = path.resolve(cwd);
		let stat: Stats;
		try {
			stat = await fs.stat(resolvedCwd);
		} catch (error) {
			throw new GuiBackendError("invalid_cwd", `Working directory is unavailable: ${toError(error).message}`);
		}
		if (!stat.isDirectory()) throw new GuiBackendError("invalid_cwd", "Working directory must be a directory.");

		const sessionFile = SessionManager.createEmptySessionFile(resolvedCwd, this.#storage);
		const manager = await SessionManager.open(sessionFile, undefined, this.#storage, {
			initialCwd: resolvedCwd,
			suppressBreadcrumb: true,
		});
		const record: ManagedSessionRecord = {
			id: manager.getSessionId(),
			path: sessionFile,
			cwd: resolvedCwd,
			createdAt: new Date().toISOString(),
		};
		try {
			const runtime = await this.#createRuntime(record, manager);
			this.#runtimes.set(record.id, runtime);
			if (name?.trim()) await runtime.session.setSessionName(name.trim(), "user");
			await this.#store().set(record);
			const info = (await SessionManager.list(resolvedCwd, undefined, this.#storage)).find(
				item => item.id === record.id,
			);
			return info
				? summaryFromInfo(info, true, runtime)
				: {
						id: record.id,
						cwd: resolvedCwd,
						title: name?.trim() || "Untitled session",
						createdAt: record.createdAt,
						modifiedAt: record.createdAt,
						messageCount: 0,
						managed: true,
						writable: true,
						state: "idle",
					};
		} catch (error) {
			await manager.close().catch(() => {});
			throw error;
		}
	}

	async transcriptPage(sessionId: string, before?: string, limit?: number): Promise<GuiTranscriptPage> {
		const info = await this.#findSession(sessionId);
		const runtime = this.#runtimes.get(sessionId);
		const entries = runtime
			? runtime.session.sessionManager.getEntries()
			: ((await loadEntriesFromFile(info.path, this.#storage)).filter(entry => "id" in entry) as SessionEntry[]);
		const items = transcriptItems(entries);
		const end = decodeBefore(before, items.length);
		const start = Math.max(0, end - boundedLimit(limit));
		return { items: items.slice(start, end), nextBefore: start > 0 ? String(start) : undefined };
	}

	async prompt(sessionId: string, text: string, operationId: string): Promise<{ agentInvoked: boolean }> {
		if (text.trim().length === 0) throw new GuiBackendError("empty_prompt", "Prompt must not be empty.");
		const runtime = await this.#runtimeForOwned(sessionId);
		if (runtime.session.isStreaming) throw new GuiBackendError("session_busy", "Session is already streaming.");
		runtime.operationId = operationId;
		try {
			return { agentInvoked: await runtime.session.prompt(text) };
		} finally {
			runtime.operationId = undefined;
		}
	}

	async shutdownSession(sessionId: string): Promise<void> {
		if (!this.#store().has(sessionId)) {
			throw new GuiBackendError("read_only_session", "Only daemon-managed sessions may be shut down.");
		}
		const runtime = this.#runtimes.get(sessionId);
		if (runtime) {
			if (runtime.session.isStreaming) await runtime.session.abort({ reason: "Explicit GUI shutdown" });
			runtime.unsubscribe();
			await runtime.session.dispose();
			this.#runtimes.delete(sessionId);
		}
		await this.#store().delete(sessionId);
	}

	isManaged(sessionId: string): boolean {
		return this.#store().has(sessionId);
	}

	liveMessages(): GuiLiveMessage[] {
		const messages: GuiLiveMessage[] = [];
		for (const [sessionId, runtime] of this.#runtimes) {
			const message = runtime.session.state.streamMessage;
			if (!message) continue;
			messages.push({
				sessionId,
				operationId: runtime.operationId,
				message: projectMessage(message, `live:${runtime.operationId ?? sessionId}`, new Date().toISOString()),
			});
		}
		return messages;
	}

	async dispose(): Promise<void> {
		const runtimes = [...this.#runtimes.values()];
		this.#runtimes.clear();
		await Promise.all(
			runtimes.map(async runtime => {
				runtime.unsubscribe();
				await runtime.session.dispose();
			}),
		);
	}

	async #findSession(sessionId: string): Promise<SessionInfo> {
		const session = (await SessionManager.listAll(this.#storage)).find(item => item.id === sessionId);
		if (!session) throw new GuiBackendError("session_not_found", "Session does not exist.");
		return session;
	}

	async #runtimeForOwned(sessionId: string): Promise<ManagedRuntime> {
		const existing = this.#runtimes.get(sessionId);
		if (existing) return existing;
		const record = this.#store().get(sessionId);
		if (!record) throw new GuiBackendError("read_only_session", "Terminal-created sessions are read-only.");
		const manager = await SessionManager.open(record.path, undefined, this.#storage, {
			initialCwd: record.cwd,
			suppressBreadcrumb: true,
		});
		const runtime = await this.#createRuntime(record, manager);
		this.#runtimes.set(sessionId, runtime);
		return runtime;
	}

	async #createRuntime(record: ManagedSessionRecord, manager: SessionManager): Promise<ManagedRuntime> {
		const { session } = await createAgentSession({
			cwd: record.cwd,
			sessionManager: manager,
			agentRegistry: new AgentRegistry(),
			agentId: "Main",
			hasUI: false,
		});
		const runtime: ManagedRuntime = { record, session, unsubscribe: () => {} };
		runtime.unsubscribe = session.subscribe(event => this.#onSessionEvent(runtime, event));
		return runtime;
	}

	#onSessionEvent(runtime: ManagedRuntime, event: AgentSessionEvent): void {
		const projected = projectSessionEvent({
			event,
			sessionId: runtime.record.id,
			operationId: runtime.operationId,
		});
		if (!projected) return;
		for (const listener of this.#listeners) listener(projected);
	}

	#store(): ManagedSessionStore {
		if (!this.#managed) throw new Error("GUI backend has not been initialized.");
		return this.#managed;
	}
}
