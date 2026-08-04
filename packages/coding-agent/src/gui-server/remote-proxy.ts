import * as fs from "node:fs/promises";
import * as path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { GUI_MAX_FRAME_BYTES } from "./protocol";

const FRAME_ENCODER = new TextEncoder();
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const MAX_BEARER_BYTES = 256;

export interface GuiRemoteProxyOptions {
	hostname: string;
	port: number;
	token: string;
}

interface RemoteClientState {
	upstream?: Bun.Socket<UpstreamState>;
	pending: Uint8Array[];
	pendingOffset: number;
	closed: boolean;
}

interface UpstreamState {
	websocket: Bun.ServerWebSocket<RemoteClientState>;
}

function authorized(request: Request, expectedToken: string): boolean {
	const authorization = request.headers.get("authorization");
	if (!authorization?.startsWith("Bearer ")) return false;
	const supplied = Buffer.from(authorization.slice("Bearer ".length), "utf8");
	const expected = Buffer.from(expectedToken, "utf8");
	return (
		supplied.byteLength > 0 &&
		supplied.byteLength <= MAX_BEARER_BYTES &&
		supplied.byteLength === expected.byteLength &&
		timingSafeEqual(supplied, expected)
	);
}

function protocolPayload(message: string | Buffer): Uint8Array | undefined {
	const bytes = typeof message === "string" ? FRAME_ENCODER.encode(message) : new Uint8Array(message);
	const needsNewline = bytes.byteLength === 0 || bytes[bytes.byteLength - 1] !== 0x0a;
	const size = bytes.byteLength + (needsNewline ? 1 : 0);
	if (size > GUI_MAX_FRAME_BYTES) return undefined;
	if (!needsNewline) return bytes;
	const framed = new Uint8Array(size);
	framed.set(bytes);
	framed[size - 1] = 0x0a;
	return framed;
}

export async function readGuiRemoteToken(tokenPath: string): Promise<string> {
	const resolved = path.resolve(tokenPath);
	const file = await fs.open(resolved, "r");
	try {
		const metadata = await file.stat();
		if (!metadata.isFile()) throw new Error(`GUI remote token path is not a file: ${resolved}`);
		if ((metadata.mode & 0o777) !== 0o600) throw new Error(`GUI remote token must be mode 0600: ${resolved}`);
		const token = (await file.readFile("utf8")).trim();
		if (!/^[A-Za-z0-9_-]{43,128}$/u.test(token)) {
			throw new Error("GUI remote token must be 43-128 URL-safe base64 characters.");
		}
		return token;
	} finally {
		await file.close();
	}
}

export class GuiRemoteProxy {
	readonly #socketPath: string;
	readonly #options: GuiRemoteProxyOptions;
	readonly #clients = new Set<Bun.ServerWebSocket<RemoteClientState>>();
	#server: Bun.Server<RemoteClientState> | undefined;

	constructor(socketPath: string, options: GuiRemoteProxyOptions) {
		if (!LOOPBACK_HOSTS.has(options.hostname)) {
			throw new Error("GUI remote proxy must bind to loopback and be exposed through authenticated Tailnet HTTPS.");
		}
		if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65_535) {
			throw new Error("GUI remote proxy port must be an integer between 1 and 65535.");
		}
		this.#socketPath = path.resolve(socketPath);
		this.#options = options;
	}

	start(): void {
		if (this.#server) throw new Error("GUI remote proxy is already running.");
		this.#server = Bun.serve<RemoteClientState>({
			hostname: this.#options.hostname,
			port: this.#options.port,
			fetch: (request, server) => {
				const url = new URL(request.url);
				if (url.pathname !== "/v1/ws") return new Response("Not found", { status: 404 });
				if (!authorized(request, this.#options.token)) return new Response("Unauthorized", { status: 401 });
				if (!server.upgrade(request, { data: { pending: [], pendingOffset: 0, closed: false } })) {
					return new Response("WebSocket upgrade required", { status: 426 });
				}
				return undefined;
			},
			websocket: {
				open: websocket => {
					this.#clients.add(websocket);
					void this.#connectUpstream(websocket);
				},
				message: (websocket, message) => {
					const payload = protocolPayload(message);
					if (!payload) {
						websocket.close(1009, "Protocol frame exceeds the maximum size.");
						return;
					}
					websocket.data.pending.push(payload);
					this.#flush(websocket);
				},
				drain: websocket => websocket.data.upstream?.resume(),
				close: websocket => this.#closeClient(websocket),
			},
		});
	}

	stop(): void {
		for (const websocket of this.#clients) {
			websocket.data.closed = true;
			websocket.data.upstream?.end();
			websocket.close(1001, "GUI daemon shutting down.");
		}
		this.#clients.clear();
		this.#server?.stop(true);
		this.#server = undefined;
	}

	async #connectUpstream(websocket: Bun.ServerWebSocket<RemoteClientState>): Promise<void> {
		try {
			const upstream = await Bun.connect<UpstreamState>({
				unix: this.#socketPath,
				socket: {
					open: socket => {
						socket.data = { websocket };
					},
					data: (socket, data) => {
						const status = socket.data.websocket.send(data);
						if (status === 0) socket.end();
						else if (status === -1) socket.pause();
					},
					drain: socket => this.#flush(socket.data.websocket),
					close: socket => this.#closeFromUpstream(socket.data.websocket),
					error: socket => this.#closeFromUpstream(socket.data.websocket),
				},
			});
			if (websocket.data.closed) {
				upstream.end();
				return;
			}
			websocket.data.upstream = upstream;
			this.#flush(websocket);
		} catch {
			if (!websocket.data.closed) websocket.close(1011, "GUI daemon is unavailable.");
		}
	}

	#flush(websocket: Bun.ServerWebSocket<RemoteClientState>): void {
		const upstream = websocket.data.upstream;
		if (!upstream) return;
		while (websocket.data.pending.length > 0) {
			const bytes = websocket.data.pending[0] as Uint8Array;
			const remaining = bytes.byteLength - websocket.data.pendingOffset;
			const written = upstream.write(bytes, websocket.data.pendingOffset, remaining);
			if (written < 0) {
				websocket.close(1011, "GUI daemon connection failed.");
				return;
			}
			if (written === 0) return;
			websocket.data.pendingOffset += written;
			if (websocket.data.pendingOffset < bytes.byteLength) return;
			websocket.data.pending.shift();
			websocket.data.pendingOffset = 0;
		}
	}

	#closeClient(websocket: Bun.ServerWebSocket<RemoteClientState>): void {
		websocket.data.closed = true;
		websocket.data.upstream?.end();
		websocket.data.upstream = undefined;
		websocket.data.pending = [];
		this.#clients.delete(websocket);
	}

	#closeFromUpstream(websocket: Bun.ServerWebSocket<RemoteClientState>): void {
		websocket.data.upstream = undefined;
		if (!websocket.data.closed) websocket.close(1011, "GUI daemon disconnected.");
	}
}
