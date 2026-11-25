/**
 * Contract: `history://current/user/<n>` is the exact text of one of the
 * caller's own user messages, so an agent can put it in a file or a subagent
 * brief with `cp` instead of writing it out again. It works with
 * `compaction.experimentalContextManagement` off, the default.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter, resolveLocalRoot } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { sessionResolveContext } from "@oh-my-pi/pi-coding-agent/internal-urls/context";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { resourceText } from "../helpers/resource-text";

const OWN_SESSION_ID = "own-session";
const LONG_MESSAGE = [
	"Voice note, 3 paragraphs.",
	"",
	'Keep `backticks`, "quotes", $HOME, tabs\tand unicode: café, 日本語, 🙂.',
	"",
	"No trailing newline",
].join("\n");

function messageEntry(id: string, message: Record<string, unknown>): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: { timestamp: 0, ...message },
	} as unknown as SessionEntry;
}

const branch: SessionEntry[] = [
	messageEntry("u1", { role: "user", content: "first request" }),
	messageEntry("a1", { role: "assistant", content: [{ type: "text", text: "assistant reply" }] }),
	messageEntry("u2", { role: "user", content: [{ type: "text", text: LONG_MESSAGE }] }),
	messageEntry("u3", { role: "user", content: "auto-continue nudge", synthetic: true }),
];

function makeSession(
	managerSessionId: string,
	entries: SessionEntry[] = branch,
	sessionId = OWN_SESSION_ID,
): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionId: () => sessionId,
		sessionManager: { getSessionId: () => managerSessionId, getBranch: () => entries },
		settings: Settings.isolated(),
	} as unknown as ToolSession;
}

async function readUrl(session: ToolSession, url: string): Promise<string> {
	return resourceText(await InternalUrlRouter.instance().resolve(url, sessionResolveContext(session)));
}

describe("history://current/user/<n>", () => {
	beforeEach(() => InternalUrlRouter.resetForTests());
	afterEach(() => InternalUrlRouter.resetForTests());

	it("returns the latest real user message byte for byte, skipping synthetic nudges, with the experimental flag off", async () => {
		const text = await readUrl(makeSession(OWN_SESSION_ID), "history://current/user/-1");

		expect(text).toBe(LONG_MESSAGE);
	});

	it("counts user messages from the end with a negative n and from the start with a positive n", async () => {
		const session = makeSession(OWN_SESSION_ID);

		expect(await readUrl(session, "history://current/user/-2")).toBe("first request");
		expect(await readUrl(session, "history://current/user/1")).toBe("first request");
		expect(await readUrl(session, "history://current/user/2")).toBe(LONG_MESSAGE);
	});

	it("refuses an index outside the journal and says how many user messages it has", async () => {
		const session = makeSession(OWN_SESSION_ID);

		await expect(readUrl(session, "history://current/user/3")).rejects.toThrow("2 user messages");
		await expect(readUrl(session, "history://current/user/0")).rejects.toThrow("Invalid history://current route");
	});

	it("reads only the caller's own journal, never a manager another session owns", async () => {
		await expect(readUrl(makeSession("parent-session"), "history://current/user/-1")).rejects.toThrow("does not own");
	});

	it("returns only the text blocks of a message, joined by newlines, and refuses a message with no text", async () => {
		const image = { type: "image", data: "AAAA", mimeType: "image/png" };
		const session = makeSession(OWN_SESSION_ID, [
			messageEntry("m1", {
				role: "user",
				content: [image, { type: "text", text: "first block" }, { type: "text", text: "second block" }],
			}),
			messageEntry("m2", { role: "user", content: [image] }),
		]);

		expect(await readUrl(session, "history://current/user/1")).toBe("first block\nsecond block");
		await expect(readUrl(session, "history://current/user/2")).rejects.toThrow("holds no text");
	});

	it("rejects an index before the first message, a malformed index, a query and a fragment", async () => {
		const session = makeSession(OWN_SESSION_ID);

		await expect(readUrl(session, "history://current/user/-3")).rejects.toThrow("2 user messages");
		for (const url of [
			"history://current/user/1.5",
			"history://current/user/01",
			"history://current/user/-0",
			"history://current/user/-1?x=1",
			"history://current/user/-1#top",
			"history://current/user/-1/",
		]) {
			await expect(readUrl(session, url)).rejects.toThrow("Invalid history://current route");
		}
	});

	it("still reaches messages from before a compaction, which the model's own context no longer holds", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "before compaction", timestamp: 1 });
		const keptId = manager.appendMessage({ role: "user", content: "kept across compaction", timestamp: 2 });
		manager.appendCompaction("summary of the first window", undefined, keptId, 10);
		manager.appendMessage({ role: "user", content: "after compaction", timestamp: 3 });
		const session = {
			...makeSession(manager.getSessionId()),
			getSessionId: () => manager.getSessionId(),
			sessionManager: manager,
		} as unknown as ToolSession;

		expect(JSON.stringify(manager.buildSessionContext().messages)).not.toContain("before compaction");
		expect(await readUrl(session, "history://current/user/1")).toBe("before compaction");
		expect(await readUrl(session, "history://current/user/-1")).toBe("after compaction");
	});

	it("gives each session its own journal", async () => {
		const sessionFor = (text: string): ToolSession => {
			const manager = SessionManager.inMemory();
			manager.appendMessage({ role: "user", content: text, timestamp: 1 });
			return {
				...makeSession(manager.getSessionId()),
				getSessionId: () => manager.getSessionId(),
				sessionManager: manager,
			} as unknown as ToolSession;
		};
		const first = sessionFor("message of A");
		const second = sessionFor("message of B");

		expect(await readUrl(first, "history://current/user/-1")).toBe("message of A");
		expect(await readUrl(second, "history://current/user/-1")).toBe("message of B");
	});

	it("copies into a file with cp, byte for byte, through the bash tool", async () => {
		const tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "history-user-")));
		try {
			const localProtocolOptions = { getArtifactsDir: () => tempDir, getSessionId: () => OWN_SESSION_ID };
			const session = {
				...makeSession(OWN_SESSION_ID),
				cwd: tempDir,
				localProtocolOptions,
				skills: [],
				getClientBridge: () => undefined,
				settings: Settings.isolated({
					"async.enabled": false,
					"bash.autoBackground.enabled": false,
					"bashInterceptor.enabled": false,
				}),
			} as unknown as ToolSession;

			const result = await new BashTool(session).execute("call", {
				command: "cp history://current/user/-1 local://copy.txt",
			});

			expect(result.isError).toBeUndefined();
			expect(await fs.readFile(path.join(resolveLocalRoot(localProtocolOptions), "copy.txt"), "utf-8")).toBe(
				LONG_MESSAGE,
			);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
