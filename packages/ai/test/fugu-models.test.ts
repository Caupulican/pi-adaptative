import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { getModel, getModels, getSupportedThinkingLevels } from "../src/models.ts";
import { complete } from "../src/stream.ts";
import type { Context } from "../src/types.ts";

const FUGU_BASE_URL = "https://api.sakana.ai/v1";
const REQUEST_CONTEXT: Context = {
	messages: [{ role: "user", content: "hi", timestamp: 1 }],
};

async function capturePayload(modelId: "fugu" | "fugu-ultra"): Promise<ResponseCreateParamsStreaming> {
	let captured: unknown;
	const response = await complete(getModel("fugu", modelId), REQUEST_CONTEXT, {
		apiKey: "test-key",
		reasoningEffort: "high",
		onPayload: (payload) => {
			captured = payload;
			throw new Error("captured payload");
		},
	});

	expect(response.stopReason).toBe("error");
	expect(captured).toBeDefined();
	return captured as ResponseCreateParamsStreaming;
}

describe("Fugu models", () => {
	it("registers both Sakana Fugu models as a distinct provider", () => {
		const models = getModels("fugu");

		expect(models.map((model) => model.id)).toEqual(["fugu", "fugu-ultra"]);
		for (const model of models) {
			expect(model.provider).toBe("fugu");
			expect(model.api).toBe("openai-responses");
			expect(model.baseUrl).toBe(FUGU_BASE_URL);
			expect(model.reasoning).toBe(true);
			expect(model.input).toEqual(["text", "image"]);
			expect(model.contextWindow).toBe(1_000_000);
			expect(model.autoCompactionTriggerTokens).toBe(272_000);
			expect(model.maxTokens).toBe(10_000);
			expect(getSupportedThinkingLevels(model)).toEqual(["high", "xhigh"]);
		}
	});

	it("uses standard pricing for Fugu Ultra and unknown pricing for base Fugu", () => {
		expect(getModel("fugu", "fugu").cost).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});
		expect(getModel("fugu", "fugu-ultra").cost).toEqual({
			input: 5,
			output: 30,
			cacheRead: 0.5,
			cacheWrite: 0,
		});
	});

	it("omits reasoning summaries for base Fugu", async () => {
		const payload = await capturePayload("fugu");

		expect(payload.reasoning).toEqual({ effort: "high" });
		expect(payload.include).toBeUndefined();
	});

	it("requests reasoning summaries for Fugu Ultra", async () => {
		const payload = await capturePayload("fugu-ultra");

		expect(payload.reasoning).toEqual({ effort: "high", summary: "auto" });
		expect(payload.include).toEqual(["reasoning.encrypted_content"]);
	});
});
