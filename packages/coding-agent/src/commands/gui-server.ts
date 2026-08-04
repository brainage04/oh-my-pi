import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { guiServerHelp as commandHelp } from "../cli/command-help";
import { OmpGuiBackend } from "../gui-server/backend";
import { OmpGuiServer } from "../gui-server/server";
import { GuiRemoteProxy, readGuiRemoteToken } from "../gui-server/remote-proxy";

export default class GuiServer extends Command {
	static description = commandHelp.description;
	static flags = {
		socket: Flags.string({ description: "Unix domain socket path" }),
		"state-dir": Flags.string({ description: "Directory for GUI daemon ownership state" }),
		"remote-host": Flags.string({ description: "Loopback host for the authenticated WebSocket proxy" }),
		"remote-port": Flags.integer({ description: "Loopback port for the authenticated WebSocket proxy" }),
		"remote-token-file": Flags.string({ description: "Mode-0600 bearer token file for remote clients" }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(GuiServer);
		const runtimeDir = process.env.XDG_RUNTIME_DIR;
		if (!flags.socket && !runtimeDir) {
			throw new Error("XDG_RUNTIME_DIR is unavailable; pass --socket explicitly.");
		}
		const socketPath = flags.socket ?? path.join(runtimeDir as string, "omp-gui", "v1.sock");
		const remotePort = flags["remote-port"];
		const remoteTokenFile = flags["remote-token-file"];
		if ((remotePort === undefined) !== (remoteTokenFile === undefined)) {
			throw new Error("--remote-port and --remote-token-file must be provided together.");
		}
		if (flags["remote-host"] && remotePort === undefined) {
			throw new Error("--remote-host requires --remote-port and --remote-token-file.");
		}
		const backend = await OmpGuiBackend.create({ stateDir: flags["state-dir"] });
		const server = new OmpGuiServer(backend, socketPath);
		const remoteProxy =
			remotePort === undefined || remoteTokenFile === undefined
				? undefined
				: new GuiRemoteProxy(socketPath, {
						hostname: flags["remote-host"] ?? "127.0.0.1",
						port: remotePort,
						token: await readGuiRemoteToken(remoteTokenFile),
					});
		const shutdown = () => {
			remoteProxy?.stop();
			void server.stop().catch(error => logger.error("GUI server shutdown failed", { error }));
		};
		process.once("SIGINT", shutdown);
		process.once("SIGTERM", shutdown);
		try {
			await server.start();
			remoteProxy?.start();
			logger.info("GUI server listening", {
				socket: socketPath,
				protocolVersion: 1,
				remote: remoteProxy ? `${flags["remote-host"] ?? "127.0.0.1"}:${remotePort}` : undefined,
			});
			await server.waitForShutdown();
		} finally {
			remoteProxy?.stop();
			await server.stop();
			process.off("SIGINT", shutdown);
			process.off("SIGTERM", shutdown);
		}
	}
}
