import { beforeEach, describe, expect, it, vi } from "vitest";

const googleGenAiMock = vi.hoisted(() => ({
	payloads: [] as unknown[],
}));

vi.mock("@google/genai", () => {
	class GoogleGenAI {
		models = {
			generateContentStream: async function* (payload: unknown) {
				googleGenAiMock.payloads.push(payload);
				yield {
					responseId: "thinking-off-response",
					candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
					usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
				};
			},
		};
	}

	return {
		FinishReason: { STOP: "STOP" },
		FunctionCallingConfigMode: { AUTO: "AUTO", NONE: "NONE", ANY: "ANY" },
		GoogleGenAI,
		ResourceScope: { COLLECTION: "COLLECTION" },
		ThinkingLevel: {
			THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED",
			MINIMAL: "MINIMAL",
			LOW: "LOW",
			MEDIUM: "MEDIUM",
			HIGH: "HIGH",
		},
	};
});

import { getModel } from "../src/models.ts";
import { streamSimpleGoogle } from "../src/providers/google.ts";
import { streamSimpleGoogleVertex } from "../src/providers/google-vertex.ts";
import type { Context } from "../src/types.ts";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

beforeEach(() => {
	googleGenAiMock.payloads.length = 0;
});

describe("Google explicit reasoning off", () => {
	it("sends a disabled thinking config to the Gemini API", async () => {
		const result = await streamSimpleGoogle(getModel("google", "gemini-2.5-flash"), context, {
			apiKey: "test-key",
			reasoning: "off",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(googleGenAiMock.payloads).toHaveLength(1);
		expect(googleGenAiMock.payloads[0]).toMatchObject({
			config: { thinkingConfig: { thinkingBudget: 0 } },
		});
		expect(googleGenAiMock.payloads[0]).not.toMatchObject({
			config: { thinkingConfig: { includeThoughts: true } },
		});
	});

	it("sends a disabled thinking config to Vertex", async () => {
		const result = await streamSimpleGoogleVertex(getModel("google-vertex", "gemini-2.5-flash"), context, {
			apiKey: "test-key",
			reasoning: "off",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(googleGenAiMock.payloads).toHaveLength(1);
		expect(googleGenAiMock.payloads[0]).toMatchObject({
			config: { thinkingConfig: { thinkingBudget: 0 } },
		});
		expect(googleGenAiMock.payloads[0]).not.toMatchObject({
			config: { thinkingConfig: { includeThoughts: true } },
		});
	});
});
