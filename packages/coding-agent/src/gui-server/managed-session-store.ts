import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { GuiBackendError } from "./backend-types";
import { asRecord } from "./message-projection";

const MANIFEST_VERSION = 1 as const;

export interface ManagedSessionRecord {
	id: string;
	path: string;
	cwd: string;
	createdAt: string;
}

interface ManagedSessionManifest {
	version: typeof MANIFEST_VERSION;
	sessions: ManagedSessionRecord[];
}

export class ManagedSessionStore {
	readonly #manifestPath: string;
	readonly #records = new Map<string, ManagedSessionRecord>();

	constructor(stateDir: string) {
		this.#manifestPath = path.join(stateDir, "managed-sessions.json");
	}

	static async create(stateDir: string): Promise<ManagedSessionStore> {
		await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
		await fs.chmod(stateDir, 0o700);
		const store = new ManagedSessionStore(stateDir);
		await store.#load();
		return store;
	}

	get(sessionId: string): ManagedSessionRecord | undefined {
		return this.#records.get(sessionId);
	}

	has(sessionId: string): boolean {
		return this.#records.has(sessionId);
	}

	values(): IterableIterator<ManagedSessionRecord> {
		return this.#records.values();
	}

	async set(record: ManagedSessionRecord): Promise<void> {
		this.#records.set(record.id, record);
		await this.#save();
	}

	async delete(sessionId: string): Promise<void> {
		this.#records.delete(sessionId);
		await this.#save();
	}

	async #load(): Promise<void> {
		let decoded: unknown;
		try {
			await fs.chmod(this.#manifestPath, 0o600);
			decoded = await Bun.file(this.#manifestPath).json();
		} catch (error) {
			if (isEnoent(error)) return;
			throw error;
		}
		const manifest = asRecord(decoded);
		if (manifest?.version !== MANIFEST_VERSION || !Array.isArray(manifest.sessions)) {
			throw new GuiBackendError("invalid_manifest", "GUI managed-session manifest is invalid.");
		}
		for (const value of manifest.sessions) {
			const record = asRecord(value);
			if (
				!record ||
				typeof record.id !== "string" ||
				typeof record.path !== "string" ||
				typeof record.cwd !== "string" ||
				typeof record.createdAt !== "string"
			) {
				throw new GuiBackendError("invalid_manifest", "GUI managed-session manifest contains an invalid entry.");
			}
			this.#records.set(record.id, {
				id: record.id,
				path: record.path,
				cwd: record.cwd,
				createdAt: record.createdAt,
			});
		}
	}

	async #save(): Promise<void> {
		const directory = path.dirname(this.#manifestPath);
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
		await fs.chmod(directory, 0o700);
		const manifest: ManagedSessionManifest = {
			version: MANIFEST_VERSION,
			sessions: [...this.#records.values()],
		};
		const temporary = `${this.#manifestPath}.${crypto.randomUUID()}.tmp`;
		await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		await fs.rename(temporary, this.#manifestPath);
	}
}
