import { describe, expect, it } from "bun:test";
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
