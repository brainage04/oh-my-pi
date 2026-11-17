import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { resumeCommand } from "@oh-my-pi/pi-coding-agent/utils/resume-command";
import { APP_NAME, getActiveProfile, getProfileRootDir, setProfile } from "@oh-my-pi/pi-utils/dirs";

describe("resumeCommand", () => {
	const originalProfile = getActiveProfile();

	afterEach(() => {
		setProfile(originalProfile);
	});

	it("omits the profile flag in the default profile", () => {
		setProfile(undefined);
		expect(resumeCommand("abc123")).toBe(`${APP_NAME} --resume abc123`);
	});

	it("carries the active profile so the emitted hint is runnable verbatim", () => {
		// Profile sessions live in ~/.omp/profiles/<name>/agent, so a resume hint
		// without --profile fails with "Session not found" (issue #9018).
		setProfile("personal");
		expect(resumeCommand("abc123")).toBe(`${APP_NAME} --profile personal --resume abc123`);
	});

	it("names the session's own profile when the process runs without one", () => {
		// A process launched without --profile (a Tern replay, a bare `omp`) still
		// prints a hint for a session stored under a profile's root.
		setProfile(undefined);
		const sessionFile = path.join(getProfileRootDir("work"), "agent", "sessions", "-tmp", "s.jsonl");
		expect(resumeCommand("abc123", sessionFile)).toBe(`${APP_NAME} --profile work --resume abc123`);
	});

	it("keeps the default profile's hint free of a flag", () => {
		setProfile(undefined);
		expect(resumeCommand("abc123", "/tmp/sessions/s.jsonl")).toBe(`${APP_NAME} --resume abc123`);
	});
});
