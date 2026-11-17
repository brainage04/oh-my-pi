import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { getAgentTombstonePath } from "@oh-my-pi/pi-coding-agent/registry/agent-tombstone";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { restoreSession } from "@oh-my-pi/pi-coding-agent/task/restore";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { TempDir } from "@oh-my-pi/pi-utils";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(fields: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: zeroUsage,
		stopReason: "stop",
		timestamp: Date.now(),
		...fields,
	};
}

/** A turn the process died in, mid tool call (no result, no exit record). */
const cutOff: Message[] = [
	{ role: "user", content: "work", timestamp: Date.now() },
	assistant({
		content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } }],
		stopReason: "toolUse",
	}),
];
/** A turn that ended on the model's own answer. */
const finished: Message[] = [
	{ role: "user", content: "work", timestamp: Date.now() },
	assistant({ content: [{ type: "text", text: "all done" }] }),
];

/** Writes subagent `id`'s transcript under the main session `mainFile`, with its spawn contract. */
async function writeSubagent(
	mainFile: string,
	cwd: string,
	id: string,
	messages: Message[],
	agent?: string,
): Promise<string> {
	const file = path.join(mainFile.slice(0, -6), `${id}.jsonl`);
	const manager = await SessionManager.open(file, undefined, undefined, {
		initialCwd: cwd,
		parentSession: mainFile,
		suppressBreadcrumb: true,
	});
	manager.appendSessionInit({ systemPrompt: ["sub prompt"], task: `${id} task`, tools: ["read", "yield"], agent });
	for (const message of messages) manager.appendMessage(message);
	await manager.close();
	return file;
}

describe("restoreSession (omp --restore)", () => {
	const ids = ["Cut", "Done", "Killed"];
	let tempDir: TempDir | undefined;
	let manager: AsyncJobManager | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const id of ids) AgentRegistry.global().unregister(id);
		await manager?.dispose({ timeoutMs: 1000 });
		manager = undefined;
		tempDir?.removeSync();
		tempDir = undefined;
	});

	it("goes on with each subagent cut off mid-turn as a job its parent receives, not with finished or killed ones", async () => {
		tempDir = TempDir.createSync("@pi-restore-subagents-");
		const cwd = tempDir.path();
		const main = SessionManager.create(cwd, path.join(cwd, "sessions"));
		main.appendMessage({ role: "user", content: "fan out", timestamp: Date.now() });
		const mainFile = main.getSessionFile();
		if (!mainFile) throw new Error("Expected a persisted session file");
		await main.close();
		await writeSubagent(mainFile, cwd, "Cut", cutOff, "scout");
		await writeSubagent(mainFile, cwd, "Done", finished);
		const killed = await writeSubagent(mainFile, cwd, "Killed", cutOff);
		await fs.writeFile(getAgentTombstonePath(killed), "");

		manager = new AsyncJobManager({});
		const delivered: string[] = [];
		manager.registerDeliverySink(MAIN_AGENT_ID, jobId => {
			delivered.push(jobId);
		});
		const result: SingleResult = {
			index: 0,
			id: "Cut",
			agent: "Cut",
			agentSource: "user",
			task: "Cut task",
			exitCode: 0,
			output: "finished after the restart",
			stderr: "",
			truncated: false,
			durationMs: 5,
			tokens: 0,
			requests: 1,
		};
		const followUp = vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockResolvedValue(result);
		const restoreTurn = vi.fn(async () => true);
		const session = {
			sessionManager: { getSessionFile: () => mainFile, getEntries: () => main.getEntries() },
			asyncJobManager: manager,
			settings: Settings.isolated(),
			restoreInterruptedTurn: restoreTurn,
		} as unknown as AgentSession;

		const outcome = await restoreSession(session);

		expect(outcome).toEqual({ turn: true, subagents: ["Cut"] });
		expect(followUp).toHaveBeenCalledTimes(1);
		expect(followUp.mock.calls[0]![0]).toMatchObject({
			id: "Cut",
			agent: { name: "Cut" },
			restore: true,
			message: "Cut task",
			softRequestBudget: 100,
		});
		await manager.getJob("Cut")!.promise;
		await manager.drainDeliveries({ filter: { ownerId: MAIN_AGENT_ID } });
		expect(delivered).toEqual(["Cut"]);
	});

	it("leaves a subagent whose run already delivered a terminal result alone", async () => {
		tempDir = TempDir.createSync("@pi-restore-finished-");
		const cwd = tempDir.path();
		const main = SessionManager.create(cwd, path.join(cwd, "sessions"));
		main.appendMessage({ role: "user", content: "fan out", timestamp: Date.now() });
		const mainFile = main.getSessionFile();
		if (!mainFile) throw new Error("Expected a persisted session file");
		// Both children stop mid-turn, as a parked subagent's transcript does: its
		// process was disposed without appending the final message.
		await writeSubagent(mainFile, cwd, "Finished", cutOff, "scout");
		await writeSubagent(mainFile, cwd, "Cut", cutOff, "scout");
		// The parent's own journal records that Finished's run ended.
		main.appendCustomMessageEntry("async-result", "Background job Finished has completed.", true, {
			jobs: [{ jobId: "Finished", type: "task", status: "completed", agentId: "Finished" }],
		});
		await main.close();

		manager = new AsyncJobManager({});
		const result: SingleResult = {
			index: 0,
			id: "Cut",
			agent: "Cut",
			agentSource: "user",
			task: "Cut task",
			exitCode: 0,
			output: "finished after the restart",
			stderr: "",
			truncated: false,
			durationMs: 5,
			tokens: 0,
			requests: 1,
		};
		const followUp = vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockResolvedValue(result);
		const session = {
			sessionManager: { getSessionFile: () => mainFile, getEntries: () => main.getEntries() },
			asyncJobManager: manager,
			settings: Settings.isolated(),
			restoreInterruptedTurn: vi.fn(async () => true),
		} as unknown as AgentSession;

		const outcome = await restoreSession(session);

		expect(outcome.subagents).toEqual(["Cut"]);
		expect(followUp).toHaveBeenCalledTimes(1);
		expect(followUp.mock.calls[0]![0]).toMatchObject({ id: "Cut" });
		await manager.getJob("Cut")!.promise;
	});
});
describe("restoreSession with an older journal", () => {
	const ids = ["OldJob", "OldJobIdOnly"];
	let tempDir: TempDir | undefined;
	let manager: AsyncJobManager | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const id of ids) AgentRegistry.global().unregister(id);
		await manager?.dispose({ timeoutMs: 1000 });
		manager = undefined;
		tempDir?.removeSync();
		tempDir = undefined;
	});

	/**
	 * The pre-status delivery shape: older journals carry `agentId`/`status` as null
	 * or omit them, so they cannot prove a run ended and must not become a cutoff.
	 */
	it.each([
		["agentId and status null", { jobId: "OldJob", agentId: null, status: null }],
		["agentId absent, status absent", { jobId: "OldJobIdOnly" }],
	])("still restores a finished child when the delivery has %s", async (_label, job) => {
		tempDir = TempDir.createSync("@pi-restore-legacy-");
		const cwd = tempDir.path();
		const main = SessionManager.create(cwd, path.join(cwd, "sessions"));
		main.appendMessage({ role: "user", content: "fan out", timestamp: Date.now() });
		const mainFile = main.getSessionFile();
		if (!mainFile) throw new Error("Expected a persisted session file");
		const id = String((job as { jobId: string }).jobId);
		await writeSubagent(mainFile, cwd, id, cutOff, "scout");
		main.appendCustomMessageEntry("async-result", "Background job has completed.", true, { jobs: [job] });
		await main.close();

		manager = new AsyncJobManager({});
		const result: SingleResult = {
			index: 0,
			id,
			agent: id,
			agentSource: "user",
			task: `${id} task`,
			exitCode: 0,
			output: "restored",
			stderr: "",
			truncated: false,
			durationMs: 5,
			tokens: 0,
			requests: 1,
		};
		const followUp = vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockResolvedValue(result);
		const session = {
			sessionManager: { getSessionFile: () => mainFile, getEntries: () => main.getEntries() },
			asyncJobManager: manager,
			settings: Settings.isolated(),
			restoreInterruptedTurn: vi.fn(async () => true),
		} as unknown as AgentSession;

		const outcome = await restoreSession(session);

		expect(outcome.subagents).toEqual([id]);
		expect(followUp).toHaveBeenCalledTimes(1);
		await manager.getJob(id)!.promise;
	});
});
describe("restoreSession with a nested subagent", () => {
	const ids = ["NestedParent", "NestedChild"];
	let tempDir: TempDir | undefined;
	let manager: AsyncJobManager | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const id of ids) AgentRegistry.global().unregister(id);
		await manager?.dispose({ timeoutMs: 1000 });
		manager = undefined;
		tempDir?.removeSync();
		tempDir = undefined;
	});

	/**
	 * A grandchild's run ends in its own parent subagent's journal, not the main
	 * session's: `<main>/<Parent>/<Child>.jsonl` delivers the terminal result. The
	 * cutoff must be read from that journal, or a finished grandchild relaunches.
	 */
	it("reads a grandchild's terminal result from its parent subagent's journal", async () => {
		tempDir = TempDir.createSync("@pi-restore-nested-");
		const cwd = tempDir.path();
		const main = SessionManager.create(cwd, path.join(cwd, "sessions"));
		main.appendMessage({ role: "user", content: "fan out", timestamp: Date.now() });
		const mainFile = main.getSessionFile();
		if (!mainFile) throw new Error("Expected a persisted session file");
		// The parent subagent is cut off too, so it restores and the child is reached
		// through its own journal either way.
		const parentFile = await writeSubagent(mainFile, cwd, "NestedParent", cutOff, "scout");
		const childFile = await SessionManager.open(
			path.join(parentFile.slice(0, -6), "NestedChild.jsonl"),
			undefined,
			undefined,
			{ initialCwd: cwd, parentSession: parentFile, suppressBreadcrumb: true },
		);
		childFile.appendSessionInit({
			systemPrompt: ["sub prompt"],
			task: "child task",
			tools: ["read"],
			agent: "scout",
		});
		for (const message of cutOff) childFile.appendMessage(message);
		await childFile.close();
		// The child's delivery lands in its parent subagent's journal, not the main
		// session's: that is the journal the cutoff must be read from.
		const parentJournal = await SessionManager.open(parentFile, undefined, undefined, { throwIfMissing: true });
		parentJournal.appendCustomMessageEntry("async-result", "Background job NestedChild has completed.", true, {
			jobs: [{ jobId: "NestedChild", type: "task", status: "completed", agentId: "NestedChild" }],
		});
		await parentJournal.close();
		await main.close();

		manager = new AsyncJobManager({});
		const result: SingleResult = {
			index: 0,
			id: "NestedParent",
			agent: "NestedParent",
			agentSource: "user",
			task: "NestedParent task",
			exitCode: 0,
			output: "restored",
			stderr: "",
			truncated: false,
			durationMs: 5,
			tokens: 0,
			requests: 1,
		};
		const followUp = vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockResolvedValue(result);
		const session = {
			sessionManager: { getSessionFile: () => mainFile, getEntries: () => main.getEntries() },
			asyncJobManager: manager,
			settings: Settings.isolated(),
			restoreInterruptedTurn: vi.fn(async () => true),
		} as unknown as AgentSession;

		const outcome = await restoreSession(session);

		expect(outcome.subagents).toEqual(["NestedParent"]);
		expect(followUp).toHaveBeenCalledTimes(1);
		expect(followUp.mock.calls[0]![0]).toMatchObject({ id: "NestedParent" });
		await manager.getJob("NestedParent")!.promise;
	});
});
