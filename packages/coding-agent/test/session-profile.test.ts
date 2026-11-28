import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getProfileRootDir, profileFromSessionPath } from "@oh-my-pi/pi-utils/dirs";
import { chooseSessionProfile } from "../src/cli/session-profile";

describe("profileFromSessionPath", () => {
	it("names the profile whose root holds the session file", () => {
		const file = path.join(getProfileRootDir("work"), "agent", "sessions", "-tmp", "s.jsonl");
		expect(profileFromSessionPath(file)).toBe("work");
	});

	it("returns undefined for a default-profile session", () => {
		expect(profileFromSessionPath(path.join(os.homedir(), ".omp", "agent", "sessions", "s.jsonl"))).toBeUndefined();
	});

	it("returns undefined for a path outside every profile root", () => {
		expect(profileFromSessionPath("/tmp/s.jsonl")).toBeUndefined();
	});

	it("accepts a relative path", () => {
		const file = path.join(getProfileRootDir("work"), "agent", "sessions", "-tmp", "s.jsonl");
		expect(profileFromSessionPath(path.relative(process.cwd(), file))).toBe("work");
	});

	it("resolves a session file behind a symlinked directory, even before it exists", async () => {
		const sessions = path.join(getProfileRootDir("work"), "agent", "sessions");
		await fs.mkdir(sessions, { recursive: true });
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-profile-link-"));
		const link = path.join(root, "via-link");
		await fs.symlink(sessions, link);
		try {
			expect(profileFromSessionPath(path.join(link, "not-written-yet.jsonl"))).toBe("work");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("does not claim a symlink that leaves the profile root", async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-profile-outside-"));
		const link = path.join(getProfileRootDir("work"), "zz-escape");
		await fs.mkdir(getProfileRootDir("work"), { recursive: true });
		await fs.symlink(outside, link);
		try {
			expect(profileFromSessionPath(path.join(link, "s.jsonl"))).toBeUndefined();
		} finally {
			await fs.rm(link, { force: true });
			await fs.rm(outside, { recursive: true, force: true });
		}
	});

	it("names a profile whose root directory is itself a symlink", async () => {
		const profilesDir = path.dirname(getProfileRootDir("work"));
		const target = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-profile-root-"));
		const root = path.join(profilesDir, "zz-linked-root");
		await fs.mkdir(path.join(target, "agent", "sessions"), { recursive: true });
		await fs.mkdir(profilesDir, { recursive: true });
		await fs.symlink(target, root);
		try {
			expect(profileFromSessionPath(path.join(root, "agent", "sessions", "s.jsonl"))).toBe("zz-linked-root");
			// A link inside that root that leaves it is still not the profile's.
			const outside = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-profile-root-out-"));
			await fs.symlink(outside, path.join(target, "escape"));
			try {
				expect(profileFromSessionPath(path.join(root, "escape", "s.jsonl"))).toBeUndefined();
			} finally {
				await fs.rm(outside, { recursive: true, force: true });
			}
		} finally {
			await fs.rm(root, { force: true });
			await fs.rm(target, { recursive: true, force: true });
		}
	});
});

describe("chooseSessionProfile", () => {
	const workSession = path.join(getProfileRootDir("work"), "agent", "sessions", "-tmp", "s.jsonl");

	it("takes the profile from the session file when no --profile was given", () => {
		expect(chooseSessionProfile(undefined, workSession)).toEqual({ kind: "session", profile: "work" });
	});

	it("keeps an explicit --profile that matches the session's profile", () => {
		expect(chooseSessionProfile("work", workSession)).toEqual({ kind: "flag", profile: "work" });
	});

	it("refuses an explicit --profile that names a different profile", () => {
		expect(() => chooseSessionProfile("personal", workSession)).toThrow(/does not match the session's profile/);
	});

	it("falls back to the environment when neither names a profile", () => {
		expect(chooseSessionProfile(undefined, undefined)).toEqual({ kind: "none" });
		expect(chooseSessionProfile(undefined, "/tmp/s.jsonl")).toEqual({ kind: "none" });
	});
});
