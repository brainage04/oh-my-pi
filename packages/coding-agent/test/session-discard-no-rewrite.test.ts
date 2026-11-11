import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	type SessionStorageWriteOptions,
	type SessionStorageWriter,
	type WriteTextAtomicOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";

const USAGE = {
	input: 900,
	output: 40,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 940,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Counts whole-file publishes and entry-sized appends handed to a file backend. */
class CountingStorage extends FileSessionStorage {
	/** Bytes handed to an atomic (async) whole-file publish. */
	publishBytes = 0;
	/** Bytes handed to a synchronous whole-file rewrite. */
	syncBytes = 0;
	/** Bytes handed to an entry-by-entry append. */
	appendBytes = 0;
	/** Whole-file publishes started, sync and async. */
	publishes = 0;

	#countLines(lines: readonly string[]): number {
		let bytes = 0;
		for (const line of lines) bytes += Buffer.byteLength(line, "utf8");
		return bytes;
	}

	// Count in the line variants only: the base class routes an overridden
	// `writeText*` through itself, so counting both would count each publish twice.
	override writeLinesSync(fpath: string, lines: readonly string[], options?: SessionStorageWriteOptions): void {
		this.syncBytes += this.#countLines(lines);
		this.publishes++;
		super.writeLinesSync(fpath, lines, options);
	}

	override async writeLinesAtomic(
		fpath: string,
		lines: readonly string[],
		options?: WriteTextAtomicOptions,
	): Promise<void> {
		this.publishBytes += this.#countLines(lines);
		this.publishes++;
		await super.writeLinesAtomic(fpath, lines, options);
	}

	override openWriter(
		fpath: string,
		options?: { flags?: "a" | "w"; onError?: (err: Error) => void },
	): SessionStorageWriter {
		const writer = super.openWriter(fpath, options);
		const count = (line: string) => {
			this.appendBytes += Buffer.byteLength(line, "utf8");
		};
		const appendSync = writer.appendSync?.bind(writer);
		const append = writer.append.bind(writer);
		return {
			append: (line: string) => {
				count(line);
				return append(line);
			},
			appendSync: appendSync
				? (line: string) => {
						count(line);
						appendSync(line);
					}
				: undefined,
			flush: () => writer.flush(),
			flushSync: writer.flushSync?.bind(writer),
			isOpen: () => writer.isOpen(),
			close: () => writer.close(),
			getError: () => writer.getError(),
		};
	}
}

describe("discarding a failed turn on a long session", () => {
	let tempDir: TempDir;
	let storage: CountingStorage;
	let manager: SessionManager;
	let sessionFile: string;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-discard-no-rewrite-");
		storage = new CountingStorage();
		manager = SessionManager.create(tempDir.path(), tempDir.path(), storage);
		manager.appendMessage({ role: "user", content: "Seed the session.", timestamp: Date.now() - 2 });
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Seeded." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: USAGE,
			timestamp: Date.now() - 1,
		});
		// About 8 MB, the size the subagent sessions that rewrote themselves
		// every failed turn reached in the field.
		const chunk = "x".repeat(200_000);
		for (let i = 0; i < 40; i++) manager.appendCustomEntry("bulk", { index: i, blob: chunk });
		await manager.flush();
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected a persisted session file");
		sessionFile = file;
	});

	afterEach(async () => {
		try {
			await manager?.close();
		} finally {
			await tempDir?.remove();
		}
	});

	it("appends the branch marker instead of rewriting the journal", async () => {
		const failedId = manager.appendMessage({
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "deepseek-v4.1-flash",
			stopReason: "error",
			errorMessage: "Injected provider error",
			usage: USAGE,
			timestamp: Date.now(),
		});
		await manager.flush();
		const usageBefore = manager.getUsageStatistics();
		const branchBefore = manager.getBranch().map(entry => entry.id);
		const sizeBefore = fs.statSync(sessionFile).size;

		storage.publishBytes = 0;
		storage.syncBytes = 0;
		storage.appendBytes = 0;
		storage.publishes = 0;
		await manager.discardEntryDurably(failedId);

		// No whole-file publish; the file grew by the appended marker only.
		expect(storage.syncBytes).toBe(0);
		expect(storage.publishBytes).toBe(0);
		expect(storage.publishes).toBe(0);
		expect(storage.appendBytes).toBeGreaterThan(0);
		expect(storage.appendBytes).toBeLessThan(4096);
		expect(fs.statSync(sessionFile).size).toBe(sizeBefore + storage.appendBytes);

		// A reload rebuilds exactly the live branch, which no longer holds the
		// failed reply, and the journal still keeps it off-branch.
		const reloaded = await SessionManager.open(sessionFile, tempDir.path());
		try {
			const live = manager.getBranch().map(entry => entry.id);
			expect(reloaded.getBranch().map(entry => entry.id)).toEqual(live);
			expect(live).not.toContain(failedId);
			expect(live.slice(0, -1)).toEqual(branchBefore.filter(id => id !== failedId));
			expect(reloaded.getEntries()).toContainEqual(expect.objectContaining({ id: failedId }));
			expect(reloaded.getEntries().some(entry => entry.type === "model_usage")).toBe(false);

			// The loaded context has no failed reply, and its usage is counted once.
			const loadedContext = reloaded.buildSessionContext();
			expect(
				loadedContext.messages.some(
					message => message.role === "assistant" && "stopReason" in message && message.stopReason === "error",
				),
			).toBe(false);
			expect(reloaded.getUsageStatistics()).toEqual(usageBefore);
		} finally {
			await reloaded.close();
		}
	});

	it("re-appends a metadata child on the kept chain", async () => {
		const seedId = manager.getBranch().at(-1)?.id;
		if (!seedId) throw new Error("Expected a seeded leaf");
		const failedId = manager.appendMessage({
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "deepseek-v4.1-flash",
			stopReason: "error",
			errorMessage: "Injected provider error",
			usage: USAGE,
			timestamp: Date.now(),
		});
		// A metadata child of the failed turn, as a tier change during a retried
		// turn would be: it must stay on the chain without touching the failed
		// entry's persisted parent links.
		const originalTierId = manager.appendServiceTierChange(null);
		await manager.flush();
		expect(
			manager
				.getBranch()
				.map(entry => entry.id)
				.slice(-3),
		).toEqual([seedId, failedId, originalTierId]);
		const branchLengthBefore = manager.getBranch().length;

		await manager.discardEntryDurably(failedId);

		const reloaded = await SessionManager.open(sessionFile, tempDir.path());
		try {
			const branch = reloaded.getBranch();
			expect(branch.some(entry => entry.id === failedId)).toBe(false);
			expect(branch.some(entry => entry.id === originalTierId)).toBe(false);
			const tiers = branch.filter(entry => entry.type === "service_tier_change");
			expect(tiers).toHaveLength(1);
			expect(tiers[0]?.parentId).toBe(seedId);
			expect(branch.at(-1)).toMatchObject({
				type: "branch_summary",
				details: { kind: "discarded-entry-branch", discardedEntryId: failedId },
				parentId: tiers[0]?.id,
			});
			// The failed turn and its original child leave the branch; the
			// re-appended child and the marker join it.
			expect(branch.length).toBe(branchLengthBefore - 2 + 2);
			// Both the failed turn and its original metadata child stay in the
			// journal, off-branch; the new tier line is the one on the chain.
			expect(reloaded.getEntries()).toContainEqual(expect.objectContaining({ id: failedId }));
			expect(reloaded.getEntries()).toContainEqual(expect.objectContaining({ id: originalTierId }));
		} finally {
			await reloaded.close();
		}
	});
	it("is a no-op when the entry already has a discard marker", async () => {
		const failedId = manager.appendMessage({
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "deepseek-v4.1-flash",
			stopReason: "error",
			errorMessage: "Injected provider error",
			usage: USAGE,
			timestamp: Date.now(),
		});
		await manager.flush();
		await manager.discardEntryDurably(failedId);
		manager.appendMessage({ role: "user", content: "A later turn.", timestamp: Date.now() });
		await manager.flush();
		const branchAfter = manager.getBranch().map(entry => entry.id);
		const sizeAfter = fs.statSync(sessionFile).size;

		storage.publishBytes = 0;
		storage.syncBytes = 0;
		storage.appendBytes = 0;
		storage.publishes = 0;
		// A second discard must not branch back to the failed entry's parent and
		// drop the marker and the turn that came after it.
		await manager.discardEntryDurably(failedId);

		expect(manager.getBranch().map(entry => entry.id)).toEqual(branchAfter);
		expect(fs.statSync(sessionFile).size).toBe(sizeAfter);
		expect(storage.appendBytes).toBe(0);
		expect(storage.publishes).toBe(0);
	});
	it("keeps a content subtree off-branch without rewriting the journal", async () => {
		const failedId = manager.appendMessage({
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "deepseek-v4.1-flash",
			stopReason: "error",
			errorMessage: "Injected provider error",
			usage: USAGE,
			timestamp: Date.now(),
		});
		const childId = manager.appendMessage({
			role: "user",
			content: "Preserved off branch.",
			timestamp: Date.now(),
		});
		await manager.flush();

		storage.publishBytes = 0;
		storage.syncBytes = 0;
		storage.appendBytes = 0;
		storage.publishes = 0;
		await manager.discardEntryDurably(failedId);

		expect(storage.publishes).toBe(0);
		expect(storage.appendBytes).toBeLessThan(4096);

		const reloaded = await SessionManager.open(sessionFile, tempDir.path());
		try {
			const branch = reloaded.getBranch();
			expect(branch.some(entry => entry.id === failedId || entry.id === childId)).toBe(false);
			expect(reloaded.getEntries()).toContainEqual(expect.objectContaining({ id: failedId }));
			expect(reloaded.getEntries()).toContainEqual(expect.objectContaining({ id: childId }));
		} finally {
			await reloaded.close();
		}
	});
	it("writes the marker when the caller already moved the leaf to the parent", async () => {
		// This is the production order: turn-recovery's discardAssistantTurn moves
		// the leaf to the failed turn's parent before discarding the entry, which
		// writes nothing, so the entry is off-branch by the time we get here.
		const failedId = manager.appendMessage({
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "deepseek-v4.1-flash",
			stopReason: "error",
			errorMessage: "Injected provider error",
			usage: USAGE,
			timestamp: Date.now(),
		});
		await manager.flush();
		const failedEntry = manager.getEntries().find(entry => entry.id === failedId);
		const parentId = failedEntry?.parentId;
		if (!parentId) throw new Error("Expected the failed turn to hang off a parent");
		manager.branch(parentId);

		storage.publishBytes = 0;
		storage.syncBytes = 0;
		storage.appendBytes = 0;
		storage.publishes = 0;
		await manager.discardEntryDurably(failedId);

		expect(storage.publishes).toBe(0);
		expect(storage.appendBytes).toBeGreaterThan(0);
		expect(storage.appendBytes).toBeLessThan(4096);

		const reloaded = await SessionManager.open(sessionFile, tempDir.path());
		try {
			const branch = reloaded.getBranch();
			expect(branch.some(entry => entry.id === failedId)).toBe(false);
			expect(branch.at(-1)).toMatchObject({
				type: "branch_summary",
				details: { kind: "discarded-entry-branch", discardedEntryId: failedId },
				parentId,
			});
		} finally {
			await reloaded.close();
		}
	});

	it("re-appends a metadata child when the caller already moved the leaf", async () => {
		const failedId = manager.appendMessage({
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "deepseek-v4.1-flash",
			stopReason: "error",
			errorMessage: "Injected provider error",
			usage: USAGE,
			timestamp: Date.now(),
		});
		const tierId = manager.appendServiceTierChange(null);
		await manager.flush();
		const failedEntry = manager.getEntries().find(entry => entry.id === failedId);
		const parentId = failedEntry?.parentId;
		if (!parentId) throw new Error("Expected the failed turn to hang off a parent");
		manager.branch(parentId);

		await manager.discardEntryDurably(failedId);

		const reloaded = await SessionManager.open(sessionFile, tempDir.path());
		try {
			const branch = reloaded.getBranch();
			expect(branch.some(entry => entry.id === failedId)).toBe(false);
			const tiers = branch.filter(entry => entry.type === "service_tier_change");
			expect(tiers).toHaveLength(1);
			expect(tiers[0]?.parentId).toBe(parentId);
			expect(branch.at(-1)).toMatchObject({
				type: "branch_summary",
				details: { kind: "discarded-entry-branch", discardedEntryId: failedId },
				parentId: tiers[0]?.id,
			});
			// The original entries stay in the journal, off the branch.
			expect(reloaded.getEntries()).toContainEqual(expect.objectContaining({ id: failedId }));
			expect(reloaded.getEntries()).toContainEqual(expect.objectContaining({ id: tierId }));
		} finally {
			await reloaded.close();
		}
	});
});
