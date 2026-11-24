import { describe, expect, it } from "bun:test";
import {
	applyChatCompletionsReasoningParams,
	type OpenAICompletionsParams,
} from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

// Z.ai's docs (docs.z.ai/guides/capabilities/thinking-mode, "Preserved thinking"): before GLM-5.4 the
// standard API endpoint clears earlier reasoning unless the request sets `thinking.clear_thinking: false`.

function zaiFormatModel(overrides: Partial<ModelSpec<"openai-completions">>): Model<"openai-completions"> {
	const base = getBundledModel("openai", "gpt-4o-mini");
	return buildModel({
		...base,
		api: "openai-completions",
		reasoning: true,
		compat: base.compatConfig,
		...overrides,
	} as ModelSpec<"openai-completions">);
}

function requestThinking(
	model: Model<"openai-completions">,
	options: Parameters<typeof applyChatCompletionsReasoningParams>[3],
): OpenAICompletionsParams["thinking"] {
	const params: OpenAICompletionsParams = { model: model.id, messages: [], stream: true };
	applyChatCompletionsReasoningParams(params, model, model.compat, options);
	return params.thinking;
}

describe("GLM preserved thinking on Z.ai hosts", () => {
	it("sends clear_thinking: false on the standard API endpoint", () => {
		const model = zaiFormatModel({ provider: "zai", baseUrl: "https://api.z.ai/api/paas/v4", id: "glm-4.7" });
		expect(model.compat.thinkingFormat).toBe("zai");
		expect(requestThinking(model, { reasoning: "high" })).toEqual({ type: "enabled", clear_thinking: false });
	});

	it("sends clear_thinking: false to the bundled Z.ai coding endpoint model", () => {
		const model = getBundledModel("zai", "glm-5.3-flash") as Model<"openai-completions">;
		expect(model.api).toBe("openai-completions");
		expect(requestThinking(model, { reasoning: "high" })).toEqual({ type: "enabled", clear_thinking: false });
	});

	it("sends clear_thinking: false to Zhipu's coding endpoint", () => {
		const model = getBundledModel("zhipu-coding-plan", "glm-5.3") as Model<"openai-completions">;
		expect(model.compat.thinkingFormat).toBe("zai");
		expect(requestThinking(model, { reasoning: "high" })).toEqual({ type: "enabled", clear_thinking: false });
	});

	it("leaves clear_thinking out of a disabled-thinking request", () => {
		const model = zaiFormatModel({ provider: "zai", baseUrl: "https://api.z.ai/api/paas/v4", id: "glm-4.7" });
		const thinking = requestThinking(model, { disableReasoning: true });
		expect(thinking).toEqual({ type: "disabled" });
	});

	it("leaves clear_thinking out for GLM models before 4.7", () => {
		const model = zaiFormatModel({ provider: "zai", baseUrl: "https://api.z.ai/api/paas/v4", id: "glm-4.6" });
		expect(requestThinking(model, { reasoning: "high" })).toEqual({ type: "enabled" });
	});

	it("leaves clear_thinking out for other models that share the zai thinking format", () => {
		const kimi = zaiFormatModel({ provider: "moonshot", baseUrl: "https://api.moonshot.ai/v1", id: "kimi-k2.5" });
		expect(kimi.compat.thinkingFormat).toBe("zai");
		expect(requestThinking(kimi, { reasoning: "high" })).not.toHaveProperty("clear_thinking");
		const mimo = zaiFormatModel({
			provider: "xiaomi",
			baseUrl: "https://api.xiaomimimo.com/v1",
			id: "mimo-v2.5-pro",
		});
		expect(mimo.compat.thinkingFormat).toBe("zai");
		expect(requestThinking(mimo, { reasoning: "high" })).not.toHaveProperty("clear_thinking");
	});

	it("leaves GLM on a gateway that is not a Z.ai host unchanged", () => {
		const model = getBundledModel("opencode-go", "glm-5.3") as Model<"openai-completions">;
		expect(requestThinking(model, { reasoning: "high" })).toBeUndefined();
	});
});
