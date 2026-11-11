import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	type SessionStorageWriteOptions,
	type WriteTextAtomicOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";

const ZERO_USAGE = {
	input: 10,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 12,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Counts whole-file publishes, split by the synchronous and atomic paths. */
class CountingStorage extends FileSessionStorage {
	/** Bytes handed to an atomic (async) whole-file publish. */
	publishBytes = 0;
	/** Bytes handed to a synchronous whole-file rewrite. */
	syncBytes = 0;
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
}

describe("session rewrite amplification", () => {
	let tempDir: TempDir;
	let storage: CountingStorage;
	let manager: SessionManager;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-rewrite-amplification-");
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
			usage: ZERO_USAGE,
			timestamp: Date.now() - 1,
		});
		// ~8 MB of conversation, the size long subagent sessions reach.
		const chunk = "x".repeat(200_000);
		for (let i = 0; i < 40; i++) manager.appendCustomEntry("bulk", { index: i, blob: chunk });
		await manager.flush();
	});

	afterEach(async () => {
		try {
			await manager?.close();
		} finally {
			await tempDir?.remove();
		}
	});

	it("publishes once when two rewrites are requested in the same turn", async () => {
		storage.publishBytes = 0;
		storage.syncBytes = 0;
		storage.publishes = 0;
		// Two in-place history rewrites requested before the first publish starts
		// serializing carry the same journal body, so one publish serves both.
		await Promise.all([manager.rewriteEntries(), manager.rewriteEntries()]);
		expect(storage.publishes).toBe(1);
	});
});
