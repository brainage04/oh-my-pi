export const GUI_PROTOCOL_VERSION = 1 as const;
export const GUI_MAX_FRAME_BYTES = 1024 * 1024;

export const GUI_CAPABILITIES = [
	"health",
	"sessions.list",
	"sessions.create",
	"sessions.fork",
	"sessions.transcript.page",
	"sessions.prompt",
	"sessions.reconcile",
	"sessions.shutdown.confirmed",
	"controls.catalog",
	"console.start",
	"console.state",
	"console.input",
	"console.resize",
	"console.stop",
	"events.console",
	"events.message.incremental",
	"events.tool",
] as const;

export type GuiCapability = (typeof GUI_CAPABILITIES)[number];

export interface GuiRequestFrame {
	protocolVersion: number;
	kind: "request";
	requestId: string;
	command: string;
	params: Record<string, unknown>;
}

export interface GuiProtocolError {
	code: string;
	message: string;
}

export interface GuiResponseFrame {
	protocolVersion: typeof GUI_PROTOCOL_VERSION;
	kind: "response";
	requestId: string;
	requestKind: string;
	ok: boolean;
	data?: unknown;
	error?: GuiProtocolError;
}

export interface GuiEventFrame {
	protocolVersion: typeof GUI_PROTOCOL_VERSION;
	kind: "event";
	event: string;
	operationId?: string;
	sessionId?: string;
	data: unknown;
}

export type GuiServerFrame = GuiResponseFrame | GuiEventFrame;

export type GuiParseResult =
	| { ok: true; request: GuiRequestFrame }
	| { ok: false; requestId: string; requestKind: string; error: GuiProtocolError };

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

export function parseGuiRequest(line: string): GuiParseResult {
	let decoded: unknown;
	try {
		decoded = JSON.parse(line);
	} catch {
		return {
			ok: false,
			requestId: "invalid",
			requestKind: "invalid",
			error: { code: "malformed_json", message: "Frame is not valid JSON." },
		};
	}

	const frame = asRecord(decoded);
	if (!frame) {
		return {
			ok: false,
			requestId: "invalid",
			requestKind: "invalid",
			error: { code: "malformed_frame", message: "Frame must be a JSON object." },
		};
	}

	const requestId = typeof frame.requestId === "string" && frame.requestId.length > 0 ? frame.requestId : "invalid";
	const requestKind = typeof frame.command === "string" && frame.command.length > 0 ? frame.command : "invalid";
	if (
		frame.kind !== "request" ||
		requestId === "invalid" ||
		requestKind === "invalid" ||
		typeof frame.protocolVersion !== "number"
	) {
		return {
			ok: false,
			requestId,
			requestKind,
			error: {
				code: "malformed_frame",
				message: "Request requires protocolVersion, requestId, command, and kind=request.",
			},
		};
	}

	const params = frame.params === undefined ? {} : asRecord(frame.params);
	if (!params) {
		return {
			ok: false,
			requestId,
			requestKind,
			error: { code: "malformed_params", message: "Request params must be a JSON object." },
		};
	}

	return {
		ok: true,
		request: {
			protocolVersion: frame.protocolVersion,
			kind: "request",
			requestId,
			command: requestKind,
			params,
		},
	};
}

export function guiResponse(request: Pick<GuiRequestFrame, "requestId" | "command">, data: unknown): GuiResponseFrame {
	return {
		protocolVersion: GUI_PROTOCOL_VERSION,
		kind: "response",
		requestId: request.requestId,
		requestKind: request.command,
		ok: true,
		data,
	};
}

export function guiErrorResponse(
	request: Pick<GuiRequestFrame, "requestId" | "command">,
	error: GuiProtocolError,
): GuiResponseFrame {
	return {
		protocolVersion: GUI_PROTOCOL_VERSION,
		kind: "response",
		requestId: request.requestId,
		requestKind: request.command,
		ok: false,
		error,
	};
}

export function guiEvent(
	event: string,
	data: unknown,
	options?: { operationId?: string; sessionId?: string },
): GuiEventFrame {
	return {
		protocolVersion: GUI_PROTOCOL_VERSION,
		kind: "event",
		event,
		operationId: options?.operationId,
		sessionId: options?.sessionId,
		data,
	};
}
