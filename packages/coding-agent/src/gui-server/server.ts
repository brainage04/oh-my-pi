import * as fs from "node:fs/promises";
import * as path from "node:path";
import { toError, VERSION } from "@oh-my-pi/pi-utils";
import { type GuiBackend, GuiBackendError, type GuiBackendEvent, type GuiBackendIdentity } from "./backend-types";
import {
	GUI_CAPABILITIES,
	GUI_MAX_FRAME_BYTES,
	GUI_PROTOCOL_VERSION,
	type GuiProtocolError,
	type GuiRequestFrame,
	type GuiServerFrame,
	guiErrorResponse,
	guiEvent,
	guiResponse,
	parseGuiRequest,
} from "./protocol";

const SHUTDOWN_CONFIRMATION_TTL_MS = 30_000;
const MAX_RETAINED_OPERATIONS = 256;
const GUI_FRAME_ENCODER = new TextEncoder();

interface ConnectionState {
	connectionId: string;
	decoder: TextDecoder;
	input: string;
	negotiated: boolean;
	output: Uint8Array[];
	outputIndex: number;
	outputByteOffset: number;
}

interface GuiOperation {
	operationId: string;
	requestId: string;
	kind: "prompt" | "shutdown_session";
	sessionId: string;
	state: "queued" | "streaming" | "completed" | "failed";
	startedAt: string;
	completedAt?: string;
	error?: GuiProtocolError;
}

interface ShutdownConfirmation {
	connectionId: string;
	sessionId: string;
	expiresAt: number;
}

function requiredString(params: Record<string, unknown>, key: string): string {
	const value = params[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new GuiBackendError("invalid_params", `${key} must be a non-empty string.`);
	}
	return value;
}

function requiredRawString(params: Record<string, unknown>, key: string, maxBytes: number): string {
	const value = params[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new GuiBackendError("invalid_params", `${key} must be a non-empty string.`);
	}
	if (Buffer.byteLength(value) > maxBytes) {
		throw new GuiBackendError("invalid_params", `${key} exceeds the maximum size.`);
	}
	return value;
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
	const value = params[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new GuiBackendError("invalid_params", `${key} must be a string.`);
	return value;
}

function optionalNumber(params: Record<string, unknown>, key: string): number | undefined {
	const value = params[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new GuiBackendError("invalid_params", `${key} must be a finite number.`);
	}
	return value;
}

function requiredInteger(params: Record<string, unknown>, key: string, minimum: number, maximum: number): number {
	const value = params[key];
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new GuiBackendError("invalid_params", `${key} must be an integer between ${minimum} and ${maximum}.`);
	}
	return value as number;
}

export class OmpGuiServer {
	readonly #backend: GuiBackend;
	readonly #socketPath: string;
	readonly #identity: GuiBackendIdentity;
	readonly #connections = new Set<Bun.Socket<ConnectionState>>();
	readonly #operations = new Map<string, GuiOperation>();
	readonly #confirmations = new Map<string, ShutdownConfirmation>();
	readonly #finished = Promise.withResolvers<void>();
	#listener: Bun.UnixSocketListener<ConnectionState> | undefined;
	#unsubscribeBackend: (() => void) | undefined;
	#stopping = false;

	constructor(backend: GuiBackend, socketPath: string) {
		this.#backend = backend;
		this.#socketPath = path.resolve(socketPath);
		this.#identity = backend.identity?.() ?? { daemonId: "test-daemon", runtimeVersion: VERSION };
	}

	async start(): Promise<void> {
		if (this.#listener) throw new Error("GUI server is already running.");
		await fs.mkdir(path.dirname(this.#socketPath), { recursive: true, mode: 0o700 });
		try {
			await fs.lstat(this.#socketPath);
			throw new GuiBackendError("socket_in_use", `Socket path already exists: ${this.#socketPath}`);
		} catch (error) {
			if (!(error instanceof GuiBackendError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			if (error instanceof GuiBackendError) throw error;
		}

		this.#listener = Bun.listen<ConnectionState>({
			unix: this.#socketPath,
			socket: {
				open: socket => {
					socket.data = {
						connectionId: crypto.randomUUID(),
						decoder: new TextDecoder(),
						input: "",
						negotiated: false,
						output: [],
						outputIndex: 0,
						outputByteOffset: 0,
					};
					this.#connections.add(socket);
				},
				data: (socket, data) => this.#receive(socket, data),
				drain: socket => this.#flush(socket),
				close: socket => {
					this.#connections.delete(socket);
				},
				error: (socket, _error) => {
					this.#connections.delete(socket);
				},
			},
		});
		await fs.chmod(this.#socketPath, 0o600);
		this.#unsubscribeBackend = this.#backend.subscribe(event => this.#broadcastBackendEvent(event));
	}

	waitForShutdown(): Promise<void> {
		return this.#finished.promise;
	}

	async stop(): Promise<void> {
		if (this.#stopping) return this.#finished.promise;
		this.#stopping = true;
		this.#unsubscribeBackend?.();
		this.#unsubscribeBackend = undefined;
		this.#listener?.stop(true);
		this.#listener = undefined;
		this.#connections.clear();
		try {
			await fs.unlink(this.#socketPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await this.#backend.dispose();
		this.#finished.resolve();
	}

	#receive(socket: Bun.Socket<ConnectionState>, data: Buffer): void {
		socket.data.input += socket.data.decoder.decode(data, { stream: true });
		if (Buffer.byteLength(socket.data.input) > GUI_MAX_FRAME_BYTES) {
			this.#write(
				socket,
				guiErrorResponse(
					{ requestId: "invalid", command: "invalid" },
					{ code: "frame_too_large", message: "Protocol frame exceeds the maximum size." },
				),
			);
			socket.close();
			return;
		}
		while (true) {
			const newline = socket.data.input.indexOf("\n");
			if (newline < 0) return;
			const line = socket.data.input.slice(0, newline).trim();
			socket.data.input = socket.data.input.slice(newline + 1);
			if (line.length > 0) void this.#handleLine(socket, line);
		}
	}

	async #handleLine(socket: Bun.Socket<ConnectionState>, line: string): Promise<void> {
		const parsed = parseGuiRequest(line);
		if (!parsed.ok) {
			this.#write(
				socket,
				guiErrorResponse({ requestId: parsed.requestId, command: parsed.requestKind }, parsed.error),
			);
			return;
		}
		const request = parsed.request;
		try {
			if (request.command === "negotiate") {
				this.#negotiate(socket, request);
				return;
			}
			if (!socket.data.negotiated) {
				throw new GuiBackendError(
					"negotiation_required",
					"Protocol negotiation is required before other requests.",
				);
			}
			if (request.protocolVersion !== GUI_PROTOCOL_VERSION) {
				throw new GuiBackendError("protocol_mismatch", "Request does not use the negotiated protocol version.");
			}
			switch (request.command) {
				case "health":
					this.#write(
						socket,
						guiResponse(request, {
							status: "ok",
							...this.#identity,
							protocolVersion: GUI_PROTOCOL_VERSION,
						}),
					);
					break;
				case "list_sessions":
					this.#write(socket, guiResponse(request, { sessions: await this.#backend.listSessions() }));
					break;
				case "create_session":
					await this.#createSession(socket, request);
					break;
				case "fork_session":
					await this.#forkSession(socket, request);
					break;
				case "transcript_page":
					{
						const sessionId = requiredString(request.params, "sessionId");
						this.#write(
							socket,
							guiResponse(request, {
								sessionId,
								...(await this.#backend.transcriptPage(
									sessionId,
									optionalString(request.params, "before"),
									optionalNumber(request.params, "limit"),
								)),
							}),
						);
					}
					break;
				case "get_control_catalog":
					this.#write(
						socket,
						guiResponse(request, {
							catalog: await this.#backend.controlCatalog(optionalString(request.params, "sessionId")),
						}),
					);
					break;
				case "console_state":
					this.#write(socket, guiResponse(request, { console: this.#backend.consoleState() }));
					break;
				case "start_console":
					{
						const mode = requiredString(request.params, "mode");
						if (mode !== "session" && mode !== "command") {
							throw new GuiBackendError("invalid_params", "mode must be session or command.");
						}
						const console = await this.#backend.startConsole({
							mode,
							sessionId: optionalString(request.params, "sessionId"),
							commandLine: optionalString(request.params, "commandLine"),
							cwd: optionalString(request.params, "cwd"),
							cols: optionalNumber(request.params, "cols"),
							rows: optionalNumber(request.params, "rows"),
						});
						this.#write(socket, guiResponse(request, { console }));
					}
					break;
				case "console_input":
					{
						const consoleId = requiredString(request.params, "consoleId");
						this.#backend.writeConsole(consoleId, requiredRawString(request.params, "data", 64 * 1024));
						this.#write(socket, guiResponse(request, { accepted: true }));
					}
					break;
				case "console_resize":
					this.#write(
						socket,
						guiResponse(request, {
							console: this.#backend.resizeConsole(
								requiredString(request.params, "consoleId"),
								requiredInteger(request.params, "cols", 40, 300),
								requiredInteger(request.params, "rows", 10, 120),
							),
						}),
					);
					break;
				case "stop_console":
					this.#write(
						socket,
						guiResponse(request, {
							console: await this.#backend.stopConsole(requiredString(request.params, "consoleId")),
						}),
					);
					break;
				case "prompt":
					this.#acceptPrompt(socket, request);
					break;
				case "reconcile":
					this.#write(
						socket,
						guiResponse(request, {
							sessions: await this.#backend.listSessions(),
							operations: [...this.#operations.values()],
							liveMessages: this.#backend.liveMessages(),
							console: this.#backend.consoleState(),
						}),
					);
					break;
				case "request_shutdown_confirmation":
					this.#issueShutdownConfirmation(socket, request);
					break;
				case "shutdown_session":
					await this.#shutdownSession(socket, request);
					break;
				default:
					throw new GuiBackendError("unsupported_command", `Unsupported command: ${request.command}`);
			}
		} catch (error) {
			const failure =
				error instanceof GuiBackendError
					? { code: error.code, message: error.message }
					: { code: "internal_error", message: toError(error).message };
			this.#write(socket, guiErrorResponse(request, failure));
		}
	}

	#negotiate(socket: Bun.Socket<ConnectionState>, request: GuiRequestFrame): void {
		const versions = request.params.protocolVersions ?? request.params.supportedVersions;
		if (!Array.isArray(versions) || !versions.includes(GUI_PROTOCOL_VERSION)) {
			this.#write(
				socket,
				guiErrorResponse(request, {
					code: "protocol_mismatch",
					message: `Server supports protocol version ${GUI_PROTOCOL_VERSION}.`,
				}),
			);
			return;
		}
		socket.data.negotiated = true;
		this.#write(
			socket,
			guiResponse(request, {
				selectedVersion: GUI_PROTOCOL_VERSION,
				capabilities: GUI_CAPABILITIES,
				...this.#identity,
			}),
		);
	}

	async #createSession(socket: Bun.Socket<ConnectionState>, request: GuiRequestFrame): Promise<void> {
		const title = optionalString(request.params, "title");
		const session = await this.#backend.createSession(requiredString(request.params, "cwd"), title);
		this.#write(socket, guiResponse(request, { session }));
		this.#broadcast(guiEvent("session_catalog_changed", { session }));
	}

	async #forkSession(socket: Bun.Socket<ConnectionState>, request: GuiRequestFrame): Promise<void> {
		const session = await this.#backend.forkSession(
			requiredString(request.params, "sessionId"),
			optionalString(request.params, "title"),
		);
		this.#write(socket, guiResponse(request, { session }));
		this.#broadcast(guiEvent("session_catalog_changed", { session }));
	}

	#acceptPrompt(socket: Bun.Socket<ConnectionState>, request: GuiRequestFrame): void {
		const sessionId = requiredString(request.params, "sessionId");
		const text = requiredString(request.params, "text");
		for (const operation of this.#operations.values()) {
			if (operation.sessionId === sessionId && (operation.state === "queued" || operation.state === "streaming")) {
				throw new GuiBackendError("session_busy", "Session already has an active operation.");
			}
		}
		const operation: GuiOperation = {
			operationId: crypto.randomUUID(),
			requestId: request.requestId,
			kind: "prompt",
			sessionId,
			state: "queued",
			startedAt: new Date().toISOString(),
		};
		this.#operations.set(operation.operationId, operation);
		this.#write(socket, guiResponse(request, { accepted: true, operationId: operation.operationId }));
		this.#emitOperation(operation);
		void this.#runPrompt(operation, text);
	}

	async #runPrompt(operation: GuiOperation, text: string): Promise<void> {
		operation.state = "streaming";
		this.#emitOperation(operation);
		try {
			const result = await this.#backend.prompt(operation.sessionId, text, operation.operationId);
			operation.state = "completed";
			operation.completedAt = new Date().toISOString();
			this.#broadcast(
				guiEvent(
					"operation_completed",
					{ ...operation, ...result },
					{
						operationId: operation.operationId,
						sessionId: operation.sessionId,
					},
				),
			);
		} catch (error) {
			operation.state = "failed";
			operation.completedAt = new Date().toISOString();
			operation.error =
				error instanceof GuiBackendError
					? { code: error.code, message: error.message }
					: { code: "operation_failed", message: toError(error).message };
			this.#broadcast(
				guiEvent("operation_failed", operation, {
					operationId: operation.operationId,
					sessionId: operation.sessionId,
				}),
			);
		} finally {
			this.#trimOperations();
		}
	}

	#issueShutdownConfirmation(socket: Bun.Socket<ConnectionState>, request: GuiRequestFrame): void {
		const sessionId = requiredString(request.params, "sessionId");
		if (!this.#backend.isManaged(sessionId)) {
			throw new GuiBackendError(
				"read_only_session",
				"Terminal-created sessions cannot be shut down by the GUI daemon.",
			);
		}
		const confirmationId = crypto.randomUUID();
		const expiresAt = Date.now() + SHUTDOWN_CONFIRMATION_TTL_MS;
		this.#confirmations.set(confirmationId, { connectionId: socket.data.connectionId, sessionId, expiresAt });
		this.#write(socket, guiResponse(request, { confirmationId, expiresAt: new Date(expiresAt).toISOString() }));
	}

	async #shutdownSession(socket: Bun.Socket<ConnectionState>, request: GuiRequestFrame): Promise<void> {
		const sessionId = requiredString(request.params, "sessionId");
		const confirmationId = requiredString(request.params, "confirmationId");
		const confirmation = this.#confirmations.get(confirmationId);
		this.#confirmations.delete(confirmationId);
		if (
			!confirmation ||
			confirmation.connectionId !== socket.data.connectionId ||
			confirmation.sessionId !== sessionId ||
			confirmation.expiresAt < Date.now()
		) {
			throw new GuiBackendError("invalid_confirmation", "Shutdown confirmation is invalid or expired.");
		}
		const operation: GuiOperation = {
			operationId: crypto.randomUUID(),
			requestId: request.requestId,
			kind: "shutdown_session",
			sessionId,
			state: "queued",
			startedAt: new Date().toISOString(),
		};
		this.#operations.set(operation.operationId, operation);
		this.#emitOperation(operation);
		try {
			await this.#backend.shutdownSession(sessionId);
			operation.state = "completed";
			operation.completedAt = new Date().toISOString();
			this.#write(socket, guiResponse(request, { operationId: operation.operationId }));
			this.#broadcast(
				guiEvent("operation_completed", operation, {
					operationId: operation.operationId,
					sessionId,
				}),
			);
			this.#broadcast(guiEvent("session_catalog_changed", { sessionId }));
		} catch (error) {
			operation.state = "failed";
			operation.completedAt = new Date().toISOString();
			operation.error =
				error instanceof GuiBackendError
					? { code: error.code, message: error.message }
					: { code: "shutdown_failed", message: toError(error).message };
			throw error;
		} finally {
			this.#trimOperations();
		}
	}

	#broadcastBackendEvent(event: GuiBackendEvent): void {
		this.#broadcast(
			guiEvent(event.event, event.data, {
				operationId: event.operationId,
				sessionId: event.sessionId,
			}),
		);
	}

	#emitOperation(operation: GuiOperation): void {
		this.#broadcast(
			guiEvent("operation_state", operation, {
				operationId: operation.operationId,
				sessionId: operation.sessionId,
			}),
		);
	}

	#trimOperations(): void {
		if (this.#operations.size <= MAX_RETAINED_OPERATIONS) return;
		for (const [operationId, operation] of this.#operations) {
			if (operation.state === "queued" || operation.state === "streaming") continue;
			this.#operations.delete(operationId);
			if (this.#operations.size <= MAX_RETAINED_OPERATIONS) break;
		}
	}

	#broadcast(frame: GuiServerFrame): void {
		for (const socket of this.#connections) {
			if (socket.data.negotiated) this.#write(socket, frame);
		}
	}

	#write(socket: Bun.Socket<ConnectionState>, frame: GuiServerFrame): void {
		try {
			const encoded = GUI_FRAME_ENCODER.encode(`${JSON.stringify(frame)}\n`);
			if (encoded.byteLength > GUI_MAX_FRAME_BYTES) {
				socket.close();
				return;
			}
			socket.data.output.push(encoded);
			this.#flush(socket);
		} catch {
			socket.close();
		}
	}

	#flush(socket: Bun.Socket<ConnectionState>): void {
		const state = socket.data;
		try {
			while (state.outputIndex < state.output.length) {
				const bytes = state.output[state.outputIndex] as Uint8Array;
				const remaining = bytes.byteLength - state.outputByteOffset;
				const written = socket.write(bytes, state.outputByteOffset, remaining);
				if (written < 0) {
					socket.close();
					return;
				}
				if (written === 0) return;
				state.outputByteOffset += written;
				if (state.outputByteOffset < bytes.byteLength) return;
				state.outputIndex += 1;
				state.outputByteOffset = 0;
			}
			state.output = [];
			state.outputIndex = 0;
		} catch {
			socket.close();
		}
	}
}

export class GuiServer extends OmpGuiServer {
	constructor(socketPath: string, backend: GuiBackend) {
		super(backend, socketPath);
	}

	static async start(socketPath: string, backend: GuiBackend): Promise<GuiServer> {
		const server = new GuiServer(socketPath, backend);
		await server.start();
		return server;
	}
}
