import { describe, expect, it } from "bun:test";
import { convertMessages } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { AssistantMessage, Model, ModelSpec, ThinkingContent } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

// DeepSeek's thinking mode wants the reasoning of every earlier assistant turn back, not only tool-call turns.
// OpenRouter forwards that field to DeepSeek, so a DeepSeek model reached through OpenRouter gets the same rule
// as one reached directly. Other OpenRouter reasoning models keep tool-call-only replay.

function openRouterCompletionsModel(id: string): Model<"openai-completions"> {
	const base = getBundledModel("openai", "gpt-4o-mini");
	return buildModel({
		...base,
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		id,
		reasoning: true,
		compat: base.compatConfig,
	} as ModelSpec<"openai-completions">);
}

function plainAssistantTurn(model: Model<"openai-completions">, thinking: string | undefined): AssistantMessage {
	return {
		role: "assistant",
		content: [
			...(thinking === undefined
				? []
				: [{ type: "thinking", thinking, thinkingSignature: "reasoning_content" } as ThinkingContent]),
			{ type: "text", text: "Plain answer." },
		],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function assistantWireMessage(messages: readonly unknown[]): { reasoning_content?: unknown } | undefined {
	return messages.find(
		(message): message is { role: "assistant"; reasoning_content?: unknown } =>
			typeof message === "object" && message !== null && "role" in message && message.role === "assistant",
	);
}

describe("OpenRouter DeepSeek reasoning replay on every assistant turn", () => {
	it("requires reasoning_content on all turns for a DeepSeek model on the chat route", () => {
		const model = openRouterCompletionsModel("deepseek/deepseek-v4-pro");
		expect(model.compat.requiresReasoningContentForAllAssistantTurns).toBe(true);
	});

	it("requires reasoning_content on all turns for the bundled OpenRouter DeepSeek model", () => {
		const model = getBundledModel("openrouter", "deepseek/deepseek-v4-pro");
		expect(model.compat).toHaveProperty("requiresReasoningContentForAllAssistantTurns", true);
	});

	it("replays the reasoning of a turn that made no tool call", () => {
		const model = openRouterCompletionsModel("deepseek/deepseek-v4-pro");
		const messages = convertMessages(
			model,
			{ messages: [plainAssistantTurn(model, "Reasoning before the answer.")] },
			model.compat,
		);
		expect(assistantWireMessage(messages)?.reasoning_content).toBe("Reasoning before the answer.");
	});

	it("writes an empty reasoning_content when a no-tool turn kept none", () => {
		const model = openRouterCompletionsModel("deepseek/deepseek-v4-pro");
		const messages = convertMessages(model, { messages: [plainAssistantTurn(model, undefined)] }, model.compat);
		expect(assistantWireMessage(messages)?.reasoning_content).toBe("");
	});

	it("keeps tool-call-only replay for other OpenRouter reasoning models", () => {
		const model = openRouterCompletionsModel("qwen/qwq-32b");
		expect(model.compat.requiresReasoningContentForAllAssistantTurns).toBe(false);
	});
});
