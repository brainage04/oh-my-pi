/**
 * `omp --restore`: a session goes on with what its last process left unfinished when
 * it ended ({@link restoreSession}): the turn it was in
 * ({@link AgentSession.restoreInterruptedTurn}) and the subagents it was running.
 *
 * Every persisted subagent transcript under the session ({@link collectSubSessions})
 * that its process left mid-turn ({@link hasRestorableTurn}), was not killed (no
 * tombstone), did not already deliver a terminal result for that run
 * ({@link completedRunCutoffs}) and can be revived (a `session_init` contract, not
 * isolated) runs one more monitored turn as a background job of its parent: the
 * lifecycle reviver rebuilds it from its transcript,
 * {@link runSubagentFollowUpTurn} goes on with the cut-off turn and drives it to
 * `yield` (then through the steps a stepped run had not sent yet), and the parent
 * receives the result as the ordinary `async-result` of a job with the subagent's
 * id, the id its first run's job had, so a parent waiting on that job finds it again.
 */
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { AsyncJobError } from "../async";
import { ensurePersistedRoster } from "../registry/persisted-agents";
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import { ASYNC_RESULT_MESSAGE_TYPE } from "../session/async-job-delivery";
import { hasRestorableTurn } from "../session/exit-diagnostics";
import type { SessionEntry } from "../session/session-entries";
import { extractSessionInit } from "../session/session-manager";
import { collectSubSessions } from "../session/sub-sessions";
import type { EventBus } from "../utils/event-bus";
import { runSubagentFollowUpTurn, softRequestBudgetFor } from "./executor";
import { persistedAgentDefinition, persistedAgentName } from "./persisted-revive";
import { readStepProgress } from "./steps";
import { formatTaskResultSummary } from "./result-summary";
import { cfgTaskMaxRuntimeMs } from "./settings";

/** Where restored subagents' lifecycle and progress frames go, as a live run's do. */
export interface RestoreOptions {
	eventBus?: EventBus;
	subagentEventBus?: EventBus;
}

/** What `omp --restore` went on with. */
export interface RestoreOutcome {
	/** The session's own interrupted turn goes on. */
	turn: boolean;
	/** Ids of the subagents that go on with theirs, parents before their children. */
	subagents: string[];
}

/**
 * Has `session` go on with what its last process left unfinished: its subagents'
 * interrupted turns, each as a background job of its parent (registered first, so
 * a resumed turn waiting on such a job finds it), then its own interrupted turn.
 */
export async function restoreSession(session: AgentSession, options: RestoreOptions = {}): Promise<RestoreOutcome> {
	const subagents = await restoreSubagents(session, options);
	const turn = await session.restoreInterruptedTurn();
	return { turn, subagents };
}

/**
 * Statuses a delivered `async-result` can carry when the run ended. `cancelled`
 * is absent because a cancelled job never delivers one
 * (`job-manager.ts:573-590` sets its result text and returns, and the catch arm
 * enqueues only when the status is not `cancelled`), so no journal holds it.
 */
const TERMINAL_JOB_STATUSES: Readonly<Record<string, true>> = { completed: true, failed: true };

function jobStatusOf(job: unknown): { agentId?: string; terminal: boolean } | undefined {
	if (typeof job !== "object" || job === null) return undefined;
	const record = job as { agentId?: unknown; jobId?: unknown; status?: unknown; type?: unknown };
	// Only a task job's id names a subagent transcript. A background bash job's id
	// is minted by the same manager, so a collision would otherwise read as a cutoff.
	if (record.type !== "task") return undefined;
	const agentId =
		typeof record.agentId === "string" ? record.agentId : typeof record.jobId === "string" ? record.jobId : undefined;
	if (agentId === undefined) return undefined;
	return { agentId, terminal: typeof record.status === "string" && TERMINAL_JOB_STATUSES[record.status] === true };
}

/**
 * When each subagent's run last ended, from the parent journal's `async-result`
 * deliveries: a delivered `completed` or `failed` result is the parent's own
 * record that the run ended, written after the child's last transcript entry. A
 * child that finished leaves a mid-turn tail when its process was parked instead
 * of disposed (nothing appends its final message), so {@link hasRestorableTurn}
 * alone reads it as interrupted; this is the signal that says the run was over. A
 * child that woke again afterward has a newer transcript entry, and
 * {@link restoreSubagents} keeps restoring it.
 *
 * A journal written before deliveries carried `status` and `agentId` cannot prove
 * a run ended, so such an entry is not a cutoff: a finished child from that era
 * still restores, the way it did before this check existed.
 */
function completedRunCutoffs(entries: readonly SessionEntry[]): Map<string, number> {
	const cutoffs = new Map<string, number>();
	for (const entry of entries) {
		if (entry.type !== "custom_message" || entry.customType !== ASYNC_RESULT_MESSAGE_TYPE) continue;
		const jobs = (entry.details as { jobs?: unknown } | undefined)?.jobs;
		if (!Array.isArray(jobs)) continue;
		const at = Date.parse(entry.timestamp);
		if (!Number.isFinite(at)) continue;
		for (const job of jobs) {
			const status = jobStatusOf(job);
			if (!status?.terminal || status.agentId === undefined) continue;
			const previous = cutoffs.get(status.agentId);
			if (previous === undefined || at > previous) cutoffs.set(status.agentId, at);
		}
	}
	return cutoffs;
}

/** Timestamp of a transcript's last entry, in ms, or undefined when it has none. */
function lastEntryAt(entries: readonly SessionEntry[]): number | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const at = Date.parse(entries[index]!.timestamp);
		if (Number.isFinite(at)) return at;
	}
	return undefined;
}

/**
 * Whether a subagent transcript's run ended before `cutoff`: the parent delivered
 * the job's terminal result and the child wrote nothing after it.
 */
function runEndedBefore(lastAt: number | undefined, cutoff: number | undefined): boolean {
	if (cutoff === undefined) return false;
	return lastAt === undefined || lastAt <= cutoff;
}

/**
 * Has every subagent of `session` that its last process left mid-turn go on with that
 * turn (see the module docs). Nothing is restored for a session without a file, or
 * without background jobs (the `async.enabled` setting off), which could not deliver
 * the results.
 */
async function restoreSubagents(session: AgentSession, options: RestoreOptions): Promise<string[]> {
	const sessionFile = session.sessionManager.getSessionFile();
	const manager = session.asyncJobManager;
	if (!sessionFile || !manager) return [];
	const registry = AgentRegistry.global();
	await ensurePersistedRoster(registry, sessionFile);
	const subSessions = await collectSubSessions(sessionFile, {
		onUnreadable: key => logger.warn("Subagent transcript unreadable; not restored", { key }),
	});
	const mainEntries = session.sessionManager.getEntries();
	const cutoffsByJournal = new Map<string, Map<string, number>>();
	const cutoffsOf = (key: string | null): Map<string, number> => {
		const journal = key ?? "";
		let cutoffs = cutoffsByJournal.get(journal);
		if (!cutoffs) {
			cutoffs = completedRunCutoffs(key === null ? mainEntries : (subSessions[key]?.entries ?? []));
			cutoffsByJournal.set(journal, cutoffs);
		}
		return cutoffs;
	};
	// Parents first: a child's result is delivered to its parent's session.
	const keys = Object.keys(subSessions).sort((a, b) => a.split("/").length - b.split("/").length);
	const restored: string[] = [];
	for (const key of keys) {
		const sub = subSessions[key]!;
		const id = sub.agentId;
		if (runEndedBefore(lastEntryAt(sub.entries), cutoffsOf(sub.parent).get(id))) {
			logger.debug("Subagent run already ended; not restored", { id });
			continue;
		}
		if (sub.aborted || !hasRestorableTurn(sub.entries)) continue;
		const ref = registry.get(id);
		const init = extractSessionInit(sub.entries);
		if (!ref?.sessionFile || ref.kind !== "sub" || !init || init.isolated) {
			logger.debug("Interrupted subagent cannot be revived; not restored", { id });
			continue;
		}
		const sessionFileOfRef = ref.sessionFile;
		const agentName = persistedAgentName(ref.displayName, init);
		const steps = readStepProgress(sub.entries);
		manager.register(
			"task",
			id,
			async ({ signal }) => {
				const result = await runSubagentFollowUpTurn({
					id,
					agent: persistedAgentDefinition(ref.displayName, init),
					message: init.task,
					restore: true,
					steps,
					workPoolYieldItems: init.workPoolYieldItems,
					outputSchema: init.outputSchema,
					outputSchemaMode: init.outputSchemaMode,
					signal,
					eventBus: options.eventBus,
					subagentEventBus: options.subagentEventBus,
					artifactsDir: path.dirname(sessionFileOfRef),
					maxRuntimeMs: cfgTaskMaxRuntimeMs.get(session.settings),
					...softRequestBudgetFor(agentName, session.settings),
				});
				const text = formatTaskResultSummary(result, { totalDurationMs: result.durationMs });
				const structuredOutput = result.structuredOutput;
				if (result.aborted || result.exitCode !== 0 || result.error !== undefined) {
					throw new AsyncJobError(text, structuredOutput);
				}
				return structuredOutput ? { text, structured: structuredOutput } : text;
			},
			{ id, agentId: id, ownerId: ref.parentId },
		);
		restored.push(id);
	}
	if (restored.length > 0) logger.info("Restored interrupted subagents", { ids: restored });
	return restored;
}
