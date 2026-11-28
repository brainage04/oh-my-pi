import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import {
	__resetProfileSnapshotForTests,
	getActiveProfile,
	getAgentDir,
	setAgentDir,
	setProfile,
} from "@oh-my-pi/pi-utils/dirs";
import { runCli } from "../src/cli";

/**
 * Snapshots the process-wide profile state a test group changes (the active profile, the agent
 * directory and the profile and config-directory environment) and returns what puts it back.
 */
function captureProfileState(): () => void {
	const profile = getActiveProfile();
	const agentDir = getAgentDir();
	const env = {
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		OMP_PROFILE: process.env.OMP_PROFILE,
		PI_PROFILE: process.env.PI_PROFILE,
		PI_CONFIG_DIR: process.env.PI_CONFIG_DIR,
	};
	const setEnv = (key: keyof typeof env) => {
		const value = env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	};
	return () => {
		setProfile(undefined);
		setEnv("PI_CONFIG_DIR");
		if (profile) setProfile(profile);
		else if (env.PI_CODING_AGENT_DIR !== undefined) setAgentDir(agentDir);
		else setProfile(undefined);
		// `setProfile` clears the profile variables, so they go back last.
		setEnv("OMP_PROFILE");
		setEnv("PI_PROFILE");
		setEnv("PI_CODING_AGENT_DIR");
		__resetProfileSnapshotForTests();
	};
}

describe("--restore of a profile session", () => {
	let configDir = "";
	let restoreProfileState: () => void;

	beforeEach(() => {
		restoreProfileState = captureProfileState();
		configDir = `.omp-restore-profile-test-${process.pid}-${Date.now()}`;
		process.env.PI_CONFIG_DIR = configDir;
		process.exitCode = 0;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		restoreProfileState();
		process.exitCode = 0;
		await removeWithRetries(path.join(os.homedir(), configDir));
	});

	/** A session file inside profile `work`'s agent directory. */
	async function workSessionFile(): Promise<string> {
		const file = path.join(os.homedir(), configDir, "profiles", "work", "agent", "sessions", "-tmp", "s.jsonl");
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, "");
		return file;
	}

	// Profile bootstrap runs before command dispatch, so `--version` exercises
	// the selection without opening a session (a bare `--restore` launch does).
	it("activates the profile that owns the restored session file", async () => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		setProfile(undefined);
		delete process.env.OMP_PROFILE;
		delete process.env.PI_PROFILE;
		const sessionFile = await workSessionFile();

		await runCli(["--version", "--restore", sessionFile]);

		expect(process.exitCode).toBe(0);
		expect(getActiveProfile()).toBe("work");
		expect(getAgentDir()).toBe(path.join(os.homedir(), configDir, "profiles", "work", "agent"));
	});

	it("refuses a --profile that does not own the restored session file", async () => {
		const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		setProfile(undefined);
		delete process.env.OMP_PROFILE;
		delete process.env.PI_PROFILE;
		const sessionFile = await workSessionFile();

		await runCli(["--version", "--profile", "personal", "--restore", sessionFile]);

		expect(process.exitCode).toBe(1);
		expect(errSpy.mock.calls.map(call => String(call[0] ?? "")).join("\n")).toContain(
			`does not match the session's profile "work"`,
		);
	});
});

describe("--restore=<path> inline spelling", () => {
	let configDir = "";
	let restoreProfileState: () => void;

	beforeEach(() => {
		restoreProfileState = captureProfileState();
		configDir = `.omp-restore-inline-test-${process.pid}-${Date.now()}`;
		process.env.PI_CONFIG_DIR = configDir;
		process.exitCode = 0;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		restoreProfileState();
		process.exitCode = 0;
		await removeWithRetries(path.join(os.homedir(), configDir));
	});

	it("activates the profile that owns the inline --restore=<path> session", async () => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		setProfile(undefined);
		delete process.env.OMP_PROFILE;
		delete process.env.PI_PROFILE;
		const sessionFile = path.join(
			os.homedir(),
			configDir,
			"profiles",
			"work",
			"agent",
			"sessions",
			"-tmp",
			"s.jsonl",
		);
		await fs.mkdir(path.dirname(sessionFile), { recursive: true });
		await fs.writeFile(sessionFile, "");

		await runCli(["--version", `--restore=${sessionFile}`]);

		expect(process.exitCode).toBe(0);
		expect(getActiveProfile()).toBe("work");
	});

	it("refuses an inline --restore=<path> under a different --profile", async () => {
		const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		setProfile(undefined);
		delete process.env.OMP_PROFILE;
		delete process.env.PI_PROFILE;
		const sessionFile = path.join(
			os.homedir(),
			configDir,
			"profiles",
			"work",
			"agent",
			"sessions",
			"-tmp",
			"s.jsonl",
		);
		await fs.mkdir(path.dirname(sessionFile), { recursive: true });
		await fs.writeFile(sessionFile, "");

		await runCli(["--version", "--profile", "personal", `--resume=${sessionFile}`]);

		expect(process.exitCode).toBe(1);
		expect(errSpy.mock.calls.map(call => String(call[0] ?? "")).join("\n")).toContain(
			`does not match the session's profile "work"`,
		);
	});
});

describe("an environment profile against the session's own", () => {
	let configDir = "";
	let restoreProfileState: () => void;

	beforeEach(() => {
		restoreProfileState = captureProfileState();
		configDir = `.omp-restore-env-test-${process.pid}-${Date.now()}`;
		process.env.PI_CONFIG_DIR = configDir;
		process.exitCode = 0;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		restoreProfileState();
		process.exitCode = 0;
		await removeWithRetries(path.join(os.homedir(), configDir));
	});

	it("lets the session win over OMP_PROFILE and says so on stderr", async () => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		setProfile(undefined);
		process.env.OMP_PROFILE = "personal";
		delete process.env.PI_PROFILE;
		const sessionFile = path.join(
			os.homedir(),
			configDir,
			"profiles",
			"work",
			"agent",
			"sessions",
			"-tmp",
			"s.jsonl",
		);
		await fs.mkdir(path.dirname(sessionFile), { recursive: true });
		await fs.writeFile(sessionFile, "");

		await runCli(["--version", "--restore", sessionFile]);

		expect(process.exitCode).toBe(0);
		expect(getActiveProfile()).toBe("work");
		expect(errSpy.mock.calls.map(call => String(call[0] ?? "")).join("")).toContain(
			'the session belongs to profile "work"; ignoring OMP_PROFILE=personal',
		);
	});

	it("says nothing when the environment names the session's profile", async () => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		setProfile(undefined);
		process.env.OMP_PROFILE = "work";
		delete process.env.PI_PROFILE;
		const sessionFile = path.join(
			os.homedir(),
			configDir,
			"profiles",
			"work",
			"agent",
			"sessions",
			"-tmp",
			"s.jsonl",
		);
		await fs.mkdir(path.dirname(sessionFile), { recursive: true });
		await fs.writeFile(sessionFile, "");

		await runCli(["--version", "--restore", sessionFile]);

		expect(process.exitCode).toBe(0);
		expect(errSpy.mock.calls.map(call => String(call[0] ?? "")).join("")).not.toContain("belongs to profile");
	});

	it("starts under a valid --profile when OMP_PROFILE is invalid", async () => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		setProfile(undefined);
		process.env.OMP_PROFILE = "..";
		delete process.env.PI_PROFILE;

		await runCli(["--version", "--profile", "work"]);

		expect(process.exitCode).toBe(0);
		expect(getActiveProfile()).toBe("work");
	});

	it("starts under the session's profile when OMP_PROFILE is invalid", async () => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		setProfile(undefined);
		process.env.OMP_PROFILE = "..";
		delete process.env.PI_PROFILE;
		const sessionFile = path.join(
			os.homedir(),
			configDir,
			"profiles",
			"work",
			"agent",
			"sessions",
			"-tmp",
			"s.jsonl",
		);
		await fs.mkdir(path.dirname(sessionFile), { recursive: true });
		await fs.writeFile(sessionFile, "");

		await runCli(["--version", "--restore", sessionFile]);

		expect(process.exitCode).toBe(0);
		expect(getActiveProfile()).toBe("work");
		expect(errSpy.mock.calls.map(call => String(call[0] ?? "")).join("")).not.toContain("Invalid OMP profile");
	});
});

describe("captureProfileState", () => {
	it("puts back the profile variables a test group clears, when the run started with them set", () => {
		const before = { OMP_PROFILE: process.env.OMP_PROFILE, PI_PROFILE: process.env.PI_PROFILE };
		try {
			process.env.OMP_PROFILE = "inherited-omp";
			process.env.PI_PROFILE = "inherited-pi";
			const restore = captureProfileState();
			setProfile(undefined);
			expect(process.env.OMP_PROFILE).toBeUndefined();
			expect(process.env.PI_PROFILE).toBeUndefined();

			restore();

			expect(process.env.OMP_PROFILE).toBe("inherited-omp");
			expect(process.env.PI_PROFILE).toBe("inherited-pi");
		} finally {
			setProfile(undefined);
			for (const [key, value] of Object.entries(before)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});
