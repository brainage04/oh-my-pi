import { commands } from "../cli-commands";
import { KEYBINDINGS } from "../config/keybindings";
import { isCredential, SETTINGS_SCHEMA } from "../config/settings-schema";
import type { InternalAvailableSlashCommand } from "../slash-commands/available-commands";
import { BUILTIN_SLASH_COMMANDS_INTERNAL } from "../slash-commands/builtin-registry";

export type GuiControlKind = "keybinding" | "slash_command" | "cli_command" | "cli_option" | "cli_argument" | "setting";

export interface GuiControlItem {
	kind: GuiControlKind;
	id: string;
	title: string;
	description?: string;
	detail?: string;
	keys?: string[];
	insertText?: string;
}

export interface GuiControlCatalog {
	keybindingCount: number;
	slashCommandCount: number;
	settingCount: number;
	cliCommandCount: number;
	cliOptionCount: number;
	cliArgumentCount: number;
	items: GuiControlItem[];
}

interface CommandSurface {
	name: string;
	aliases?: readonly string[];
	description?: string;
	hidden: boolean;
	flags: Record<string, Record<string, unknown>>;
	args: Record<string, Record<string, unknown>>;
}

interface SlashSurface {
	name: string;
	aliases?: readonly string[];
	description?: string;
	input?: { hint?: string };
	subcommands?: ReadonlyArray<{ name: string; description?: string; usage?: string }>;
}

let commandSurfacePromise: Promise<CommandSurface[]> | undefined;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if ((typeof value !== "object" && typeof value !== "function") || value === null || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

function recordSurface(value: unknown): Record<string, Record<string, unknown>> {
	const record = asRecord(value);
	if (!record) return {};
	const surface: Record<string, Record<string, unknown>> = {};
	for (const [key, nested] of Object.entries(record)) {
		const definition = asRecord(nested);
		if (definition) surface[key] = definition;
	}
	return surface;
}

async function loadCommandSurface(): Promise<CommandSurface[]> {
	const result: CommandSurface[] = [];
	for (const entry of commands) {
		const command = await entry.load();
		const commandRecord = asRecord(command) ?? {};
		result.push({
			name: entry.name,
			aliases: entry.aliases,
			description: entry.help?.description,
			hidden: entry.help?.hidden === true,
			flags: recordSurface(commandRecord.flags),
			args: recordSurface(commandRecord.args),
		});
	}
	return result;
}

function commandSurface(): Promise<CommandSurface[]> {
	commandSurfacePromise ??= loadCommandSurface();
	return commandSurfacePromise;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function valueDetail(label: string, value: unknown): string | undefined {
	if (value === undefined || typeof value === "function") return undefined;
	const encoded = typeof value === "string" ? value : JSON.stringify(value);
	return encoded === undefined ? undefined : `${label}: ${encoded}`;
}

function joinDetails(parts: Array<string | undefined>): string | undefined {
	const present = parts.filter((part): part is string => part !== undefined && part.length > 0);
	return present.length > 0 ? present.join("\n") : undefined;
}

function keybindingItems(): GuiControlItem[] {
	return Object.entries(KEYBINDINGS).map(([id, definition]) => {
		const keys = Array.isArray(definition.defaultKeys) ? [...definition.defaultKeys] : [definition.defaultKeys];
		return {
			kind: "keybinding",
			id,
			title: definition.description ?? id,
			description: id,
			detail: keys.length > 0 ? `Default: ${keys.join(", ")}` : "No default chord; available as an action.",
			keys,
		};
	});
}

function slashItems(commands: readonly SlashSurface[]): GuiControlItem[] {
	const items: GuiControlItem[] = [];
	for (const command of commands) {
		const argumentHint = command.input?.hint;
		items.push({
			kind: "slash_command",
			id: `slash:${command.name}`,
			title: `/${command.name}`,
			description: command.description,
			detail: joinDetails([
				command.aliases?.length ? `Aliases: ${command.aliases.map(alias => `/${alias}`).join(", ")}` : undefined,
				argumentHint ? `Input: ${argumentHint}` : undefined,
			]),
			insertText: `/${command.name}${argumentHint ? " " : ""}`,
		});
		for (const subcommand of command.subcommands ?? []) {
			items.push({
				kind: "slash_command",
				id: `slash:${command.name}:${subcommand.name}`,
				title: `/${command.name} ${subcommand.name}`,
				description: subcommand.description ?? command.description,
				detail: subcommand.usage ? `Usage: /${command.name} ${subcommand.name} ${subcommand.usage}` : undefined,
				insertText: `/${command.name} ${subcommand.name}${subcommand.usage ? " " : ""}`,
			});
		}
	}
	return items;
}

function cliItems(commandDefinitions: readonly CommandSurface[]): GuiControlItem[] {
	const items: GuiControlItem[] = [];
	for (const command of commandDefinitions) {
		items.push({
			kind: "cli_command",
			id: `cli:${command.name}`,
			title: `omp ${command.name}`,
			description: command.description ?? (command.hidden ? "Internal CLI command" : undefined),
			detail: command.aliases?.length ? `Aliases: ${command.aliases.join(", ")}` : undefined,
			insertText: `${command.name} `,
		});
		for (const [flag, definition] of Object.entries(command.flags)) {
			const options = Array.isArray(definition.options) ? definition.options : undefined;
			items.push({
				kind: "cli_option",
				id: `cli-option:${command.name}:${flag}`,
				title: `omp ${command.name} --${flag}`,
				description: text(definition.description),
				detail: joinDetails([
					valueDetail("Type", definition.kind),
					valueDetail("Short", definition.char),
					valueDetail("Default", definition.default),
					options ? `Values: ${options.map(option => String(option)).join(", ")}` : undefined,
					definition.multiple === true ? "Repeatable" : undefined,
				]),
				insertText: `${command.name} --${flag}${definition.kind === "boolean" ? "" : " "}`,
			});
		}
		for (const [argument, definition] of Object.entries(command.args)) {
			const options = Array.isArray(definition.options) ? definition.options : undefined;
			items.push({
				kind: "cli_argument",
				id: `cli-argument:${command.name}:${argument}`,
				title: `omp ${command.name} <${argument}>`,
				description: text(definition.description),
				detail: joinDetails([
					definition.required === true ? "Required" : "Optional",
					definition.multiple === true ? "Repeatable" : undefined,
					options ? `Values: ${options.map(option => String(option)).join(", ")}` : undefined,
				]),
				insertText: `${command.name} `,
			});
		}
	}
	return items;
}

function settingItems(): GuiControlItem[] {
	return Object.entries(SETTINGS_SCHEMA).map(([path, definition]) => {
		const record = asRecord(definition) ?? {};
		const ui = asRecord(record.ui);
		const credential = isCredential(path as keyof typeof SETTINGS_SCHEMA);
		const values = Array.isArray(record.values) ? record.values : undefined;
		return {
			kind: "setting",
			id: `setting:${path}`,
			title: text(ui?.label) ?? path,
			description: text(ui?.description) ?? path,
			detail: joinDetails([
				`Path: ${path}`,
				valueDetail("Type", record.type),
				credential ? "Credential value (never disclosed by the catalog)" : valueDetail("Default", record.default),
				values ? `Values: ${values.map(value => String(value)).join(", ")}` : undefined,
			]),
			insertText: `config set ${path} `,
		};
	});
}

function builtinSlashSurface(): SlashSurface[] {
	return BUILTIN_SLASH_COMMANDS_INTERNAL.map(command => ({
		name: command.name,
		aliases: command.aliases,
		description: command.description,
		input:
			command.acpInputHint || command.inlineHint ? { hint: command.acpInputHint ?? command.inlineHint } : undefined,
		subcommands: command.subcommands,
	}));
}

function mergeSlashSurface(dynamicCommands: readonly InternalAvailableSlashCommand[] | undefined): SlashSurface[] {
	const merged = builtinSlashSurface();
	const seen = new Set(merged.map(command => command.name));
	for (const command of dynamicCommands ?? []) {
		if (seen.has(command.name)) continue;
		seen.add(command.name);
		merged.push(command);
	}
	return merged;
}

export async function buildGuiControlCatalog(
	dynamicCommands?: readonly InternalAvailableSlashCommand[],
): Promise<GuiControlCatalog> {
	const commandDefinitions = await commandSurface();
	const slashDefinitions = mergeSlashSurface(dynamicCommands);
	const keybindings = keybindingItems();
	const slashCommands = slashItems(slashDefinitions);
	const cli = cliItems(commandDefinitions);
	const settings = settingItems();
	return {
		keybindingCount: keybindings.length,
		slashCommandCount: slashDefinitions.length,
		settingCount: settings.length,
		cliCommandCount: commandDefinitions.length,
		cliOptionCount: cli.filter(item => item.kind === "cli_option").length,
		cliArgumentCount: cli.filter(item => item.kind === "cli_argument").length,
		items: [...keybindings, ...slashCommands, ...cli, ...settings],
	};
}
