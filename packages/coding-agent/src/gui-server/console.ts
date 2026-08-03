import { PtySession } from "@oh-my-pi/pi-natives";
import { Terminal } from "@xterm/headless";
import { resolveOmpCommand } from "../task/omp-command";
import { parseCommandArgs } from "../utils/command-args";
import { GuiBackendError } from "./backend-types";

const DEFAULT_COLUMNS = 120;
const DEFAULT_ROWS = 40;
const MIN_COLUMNS = 40;
const MAX_COLUMNS = 300;
const MIN_ROWS = 10;
const MAX_ROWS = 120;

export type GuiConsoleMode = "session" | "command";
export type GuiConsoleStatus = "starting" | "running" | "exited";

export interface GuiConsoleState {
	consoleId: string;
	mode: GuiConsoleMode;
	status: GuiConsoleStatus;
	sessionId?: string;
	commandLine: string;
	cwd: string;
	cols: number;
	rows: number;
	screen: string;
	cursorX: number;
	cursorY: number;
	pid?: number;
	exitCode?: number;
	cancelled?: boolean;
	timedOut?: boolean;
}

export interface GuiConsoleStartOptions {
	mode: GuiConsoleMode;
	sessionId?: string;
	sessionPath?: string;
	cwd: string;
	commandLine?: string;
	cols?: number;
	rows?: number;
}

export type GuiConsoleListener = (
	event: "console_started" | "console_updated" | "console_exited",
	state: GuiConsoleState,
) => void;

function boundedDimension(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new GuiBackendError("invalid_console_size", `Console dimension must be between ${minimum} and ${maximum}.`);
	}
	return value;
}

function displayCommand(args: readonly string[]): string {
	return ["omp", ...args]
		.map(argument => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(argument) ? argument : JSON.stringify(argument)))
		.join(" ");
}

function resolveArguments(options: GuiConsoleStartOptions): string[] {
	const requested = parseCommandArgs(options.commandLine?.trim() ?? "");
	if (options.mode === "command") {
		if (requested.length === 0) throw new GuiBackendError("empty_command", "An OMP command is required.");
		return requested;
	}
	if (!options.sessionId || !options.sessionPath) {
		throw new GuiBackendError("invalid_session", "A managed session is required for the full OMP console.");
	}
	return ["launch", "--resume", options.sessionPath, "--cwd", options.cwd, ...requested];
}

export class GuiConsoleSession {
	readonly #consoleId = crypto.randomUUID();
	readonly #pty = new PtySession();
	readonly #terminal: Terminal;
	readonly #listener: GuiConsoleListener;
	readonly #mode: GuiConsoleMode;
	readonly #sessionId: string | undefined;
	readonly #cwd: string;
	readonly #commandLine: string;
	#status: GuiConsoleStatus = "starting";
	#cols: number;
	#rows: number;
	#pid: number | undefined;
	#exitCode: number | undefined;
	#cancelled: boolean | undefined;
	#timedOut: boolean | undefined;
	#snapshotQueued = false;
	#runPromise: Promise<void>;
	#writePromise = Promise.resolve();

	constructor(options: GuiConsoleStartOptions, listener: GuiConsoleListener) {
		this.#mode = options.mode;
		this.#sessionId = options.sessionId;
		this.#cwd = options.cwd;
		this.#cols = boundedDimension(options.cols, DEFAULT_COLUMNS, MIN_COLUMNS, MAX_COLUMNS);
		this.#rows = boundedDimension(options.rows, DEFAULT_ROWS, MIN_ROWS, MAX_ROWS);
		this.#terminal = new Terminal({ cols: this.#cols, rows: this.#rows, allowProposedApi: true });
		this.#listener = listener;
		const args = resolveArguments(options);
		this.#commandLine = displayCommand(args);
		this.#runPromise = this.#run(args);
	}

	state(): GuiConsoleState {
		const buffer = this.#terminal.buffer.active;
		const lines: string[] = [];
		for (let index = 0; index < this.#rows; index += 1) {
			lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
		}
		while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
		return {
			consoleId: this.#consoleId,
			mode: this.#mode,
			status: this.#status,
			sessionId: this.#sessionId,
			commandLine: this.#commandLine,
			cwd: this.#cwd,
			cols: this.#cols,
			rows: this.#rows,
			screen: lines.join("\n"),
			cursorX: buffer.cursorX,
			cursorY: buffer.cursorY,
			pid: this.#pid,
			exitCode: this.#exitCode,
			cancelled: this.#cancelled,
			timedOut: this.#timedOut,
		};
	}

	write(data: string): void {
		if (this.#status === "exited") throw new GuiBackendError("console_exited", "The OMP console has exited.");
		this.#pty.write(data);
	}

	resize(cols: number, rows: number): void {
		this.#cols = boundedDimension(cols, this.#cols, MIN_COLUMNS, MAX_COLUMNS);
		this.#rows = boundedDimension(rows, this.#rows, MIN_ROWS, MAX_ROWS);
		this.#terminal.resize(this.#cols, this.#rows);
		if (this.#status !== "exited") this.#pty.resize(this.#cols, this.#rows);
		this.#emit("console_updated");
	}

	async stop(): Promise<void> {
		if (this.#status !== "exited") this.#pty.kill();
		await this.#runPromise;
	}

	async dispose(): Promise<void> {
		if (this.#status !== "exited") {
			try {
				this.#pty.kill();
			} catch {}
		}
		await this.#runPromise.catch(() => {});
		this.#terminal.dispose();
	}

	async #run(args: string[]): Promise<void> {
		const command = resolveOmpCommand();
		if (command.shell)
			throw new GuiBackendError("console_unavailable", "The GUI console requires direct OMP execution.");
		try {
			const result = await this.#pty.startArgv(
				{
					application: command.cmd,
					args: [...command.args, ...args],
					cwd: this.#cwd,
					env: {
						...Bun.env,
						TERM: "xterm-256color",
						COLORTERM: "truecolor",
						OMP_GUI_CONSOLE: "1",
					},
					cols: this.#cols,
					rows: this.#rows,
				},
				(error, chunk) => {
					if (error) {
						this.#writeTerminal(`\r\nConsole error: ${error.message}\r\n`);
						return;
					}
					if (chunk) this.#writeTerminal(chunk);
				},
				(error, pid) => {
					if (error) {
						this.#writeTerminal(`Console start failed: ${error.message}\r\n`);
						return;
					}
					this.#pid = pid;
					this.#status = "running";
					this.#emit("console_started");
				},
			);
			this.#exitCode = result.exitCode;
			this.#cancelled = result.cancelled;
			this.#timedOut = result.timedOut;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#writeTerminal(`\r\nConsole failed: ${message}\r\n`);
		} finally {
			await this.#writePromise;
			this.#status = "exited";
			this.#emit("console_exited");
		}
	}

	#writeTerminal(data: string): void {
		this.#writePromise = this.#writePromise.then(() => {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#terminal.write(data, () => {
				this.#queueSnapshot();
				resolve();
			});
			return promise;
		});
	}

	#queueSnapshot(): void {
		if (this.#snapshotQueued) return;
		this.#snapshotQueued = true;
		queueMicrotask(() => {
			this.#snapshotQueued = false;
			this.#emit("console_updated");
		});
	}

	#emit(event: "console_started" | "console_updated" | "console_exited"): void {
		this.#listener(event, this.state());
	}
}
