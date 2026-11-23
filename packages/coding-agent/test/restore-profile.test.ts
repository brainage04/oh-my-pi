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

describe("--restore of a profile session", () => {
	let configDir = "";
	let originalProfile: string | undefined;
	let originalAgentDir: string;
	let originalAgentDirEnv: string | undefined;
	let originalOmpProfileEnv: string | undefined;
	let originalPiProfileEnv: string | undefined;
	let originalConfigDir: string | undefined;

	beforeEach(() => {
		originalProfile = getActiveProfile();
		originalAgentDir = getAgentDir();
		originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
		originalOmpProfileEnv = process.env.OMP_PROFILE;
		originalPiProfileEnv = process.env.PI_PROFILE;
		originalConfigDir = process.env.PI_CONFIG_DIR;
		configDir = `.omp-restore-profile-test-${process.pid}-${Date.now()}`;
		process.env.PI_CONFIG_DIR = configDir;
		process.exitCode = 0;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setProfile(undefined);
		if (originalConfigDir === undefined) {
			delete process.env.PI_CONFIG_DIR;
		} else {
			process.env.PI_CONFIG_DIR = originalConfigDir;
		}
		if (originalProfile) {
			setProfile(originalProfile);
		} else if (originalAgentDirEnv !== undefined) {
			setAgentDir(originalAgentDir);
		} else {
			setProfile(undefined);
		}
		if (originalOmpProfileEnv === undefined) {
			delete process.env.OMP_PROFILE;
		} else {
			process.env.OMP_PROFILE = originalOmpProfileEnv;
		}
		if (originalPiProfileEnv === undefined) {
			delete process.env.PI_PROFILE;
		} else {
			process.env.PI_PROFILE = originalPiProfileEnv;
		}
		if (originalAgentDirEnv === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
		}
		__resetProfileSnapshotForTests();
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
	let originalConfigDir: string | undefined;

	beforeEach(() => {
		originalConfigDir = process.env.PI_CONFIG_DIR;
		configDir = `.omp-restore-inline-test-${process.pid}-${Date.now()}`;
		process.env.PI_CONFIG_DIR = configDir;
		process.exitCode = 0;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setProfile(undefined);
		if (originalConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
		else process.env.PI_CONFIG_DIR = originalConfigDir;
		__resetProfileSnapshotForTests();
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
	let originalConfigDir: string | undefined;
	let originalOmpProfileEnv: string | undefined;

	beforeEach(() => {
		originalConfigDir = process.env.PI_CONFIG_DIR;
		originalOmpProfileEnv = process.env.OMP_PROFILE;
		configDir = `.omp-restore-env-test-${process.pid}-${Date.now()}`;
		process.env.PI_CONFIG_DIR = configDir;
		process.exitCode = 0;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setProfile(undefined);
		if (originalConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
		else process.env.PI_CONFIG_DIR = originalConfigDir;
		if (originalOmpProfileEnv === undefined) delete process.env.OMP_PROFILE;
		else process.env.OMP_PROFILE = originalOmpProfileEnv;
		delete process.env.PI_PROFILE;
		__resetProfileSnapshotForTests();
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
