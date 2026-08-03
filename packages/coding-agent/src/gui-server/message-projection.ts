import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSessionEvent } from "../session/agent-session";
import type { GuiBackendEvent, GuiTranscriptItem } from "./backend-types";

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

export function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const value of content) {
		const block = asRecord(value);
		if (!block) continue;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}

export function projectMessage(message: AgentMessage | unknown, id: string, timestamp: string): GuiTranscriptItem {
	const value = asRecord(message) ?? {};
	const rawRole = typeof value.role === "string" ? value.role : "system";
	const role = rawRole === "user" || rawRole === "assistant" || rawRole === "toolResult" ? rawRole : "system";
	const toolName = typeof value.toolName === "string" ? value.toolName : undefined;
	return {
		id,
		timestamp,
		kind: role === "toolResult" ? "tool" : "message",
		role: role === "toolResult" ? "tool" : role,
		text: textFromContent(value.content),
		toolName,
		isError: value.isError === true,
	};
}

export function projectSessionEvent(options: {
	event: AgentSessionEvent;
	sessionId: string;
	operationId?: string;
}): GuiBackendEvent | undefined {
	const { event, sessionId, operationId } = options;
	const common = { sessionId, operationId };
	if (event.type === "message_start") {
		return {
			event: "message_started",
			...common,
			data: projectMessage(event.message, `live:${operationId ?? crypto.randomUUID()}`, new Date().toISOString()),
		};
	}
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		return {
			event: "message_delta",
			...common,
			data: { delta: event.assistantMessageEvent.delta, contentIndex: event.assistantMessageEvent.contentIndex },
		};
	}
	if (event.type === "message_end") {
		return {
			event: "message_completed",
			...common,
			data: projectMessage(event.message, `live:${operationId ?? crypto.randomUUID()}`, new Date().toISOString()),
		};
	}
	if (event.type === "tool_execution_start") {
		return {
			event: "tool_started",
			...common,
			data: { toolCallId: event.toolCallId, toolName: event.toolName },
		};
	}
	if (event.type === "tool_execution_end") {
		const result = asRecord(event.result);
		return {
			event: "tool_completed",
			...common,
			data: {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				text: textFromContent(result?.content),
				isError: event.isError === true,
			},
		};
	}
	return undefined;
}
