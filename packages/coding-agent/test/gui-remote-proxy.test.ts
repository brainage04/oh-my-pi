import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GuiRemoteProxy, readGuiRemoteToken } from "../src/gui-server/remote-proxy";

let proxy: GuiRemoteProxy | undefined;
let upstream: Bun.UnixSocketListener<undefined> | undefined;
let temporaryDirectory: string | undefined;

async function reservePort(): Promise<number> {
	const reservation = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: { data() {} },
	});
	const port = reservation.port;
	reservation.stop(true);
	return port;
}

async function messageText(value: unknown): Promise<string> {
	if (typeof value === "string") return value;
	if (value instanceof Blob) return await value.text();
	if (value instanceof ArrayBuffer) return Buffer.from(value).toString("utf8");
	if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8");
	throw new Error("Unexpected WebSocket message type.");
}

afterEach(async () => {
	proxy?.stop();
	proxy = undefined;
	upstream?.stop(true);
	upstream = undefined;
	if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
	temporaryDirectory = undefined;
});

describe("GUI authenticated remote proxy", () => {
	test("rejects unauthenticated upgrades and bridges authorized protocol frames", async () => {
		temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-remote-test-"));
		const socketPath = path.join(temporaryDirectory, "gui.sock");
		upstream = Bun.listen<undefined>({
			unix: socketPath,
			socket: {
				data: (socket, data) => {
					socket.write(data);
				},
			},
		});
		const token = "A".repeat(43);
		const port = await reservePort();
		proxy = new GuiRemoteProxy(socketPath, { hostname: "127.0.0.1", port, token });
		proxy.start();

		const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/ws`);
		expect(unauthorized.status).toBe(401);

		const websocket = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		const opened = Promise.withResolvers<void>();
		const received = Promise.withResolvers<string>();
		websocket.addEventListener("open", () => opened.resolve());
		websocket.addEventListener("message", event => void messageText(event.data).then(received.resolve));
		websocket.addEventListener("error", () => opened.reject(new Error("WebSocket connection failed.")));
		await opened.promise;
		websocket.send('{"kind":"request"}');
		await expect(received.promise).resolves.toBe('{"kind":"request"}\n');
		websocket.close();
	});

	test("accepts only private URL-safe bearer token files", async () => {
		temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-token-test-"));
		const tokenPath = path.join(temporaryDirectory, "remote.token");
		const token = "a".repeat(43);
		await fs.writeFile(tokenPath, `${token}\n`, { mode: 0o644 });
		await expect(readGuiRemoteToken(tokenPath)).rejects.toThrow("mode 0600");
		await fs.chmod(tokenPath, 0o700);
		await expect(readGuiRemoteToken(tokenPath)).rejects.toThrow("mode 0600");
		await fs.chmod(tokenPath, 0o600);
		await expect(readGuiRemoteToken(tokenPath)).resolves.toBe(token);
	});
});
