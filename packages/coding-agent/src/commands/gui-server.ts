import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { guiServerHelp as commandHelp } from "../cli/command-help";
import { OmpGuiBackend } from "../gui-server/backend";
import { OmpGuiServer } from "../gui-server/server";

export default class GuiServer extends Command {
	static description = commandHelp.description;
	static flags = {
		socket: Flags.string({ description: "Unix domain socket path" }),
		"state-dir": Flags.string({ description: "Directory for GUI daemon ownership state" }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(GuiServer);
		const runtimeDir = process.env.XDG_RUNTIME_DIR;
		if (!flags.socket && !runtimeDir) {
			throw new Error("XDG_RUNTIME_DIR is unavailable; pass --socket explicitly.");
		}
		const socketPath = flags.socket ?? path.join(runtimeDir as string, "omp-gui", "v1.sock");
		const backend = await OmpGuiBackend.create({ stateDir: flags["state-dir"] });
		const server = new OmpGuiServer(backend, socketPath);
		const shutdown = () => {
			void server.stop().catch(error => logger.error("GUI server shutdown failed", { error }));
		};
		process.once("SIGINT", shutdown);
		process.once("SIGTERM", shutdown);
		try {
			await server.start();
			logger.info("GUI server listening", { socket: socketPath, protocolVersion: 1 });
			await server.waitForShutdown();
		} finally {
			process.off("SIGINT", shutdown);
			process.off("SIGTERM", shutdown);
		}
	}
}
