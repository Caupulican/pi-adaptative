import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimpleOpenAICodexResponses } from "../src/providers/openai-codex-responses.ts";
import * as providerRuntime from "../src/providers/provider-runtime.ts";
import type { Model, SimpleStreamOptions } from "../src/types.ts";

const model: Model<"openai-codex-responses"> = {
	id: "fixture",
	name: "Fixture",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
	defaultThinkingLevel: "high",
};
const apiKey = `e30.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } }),
).toString("base64url")}.signature`;

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("Codex simple options ownership", () => {
	it("rejects absent authentication through the shared option builder", () => {
		const build = vi.spyOn(providerRuntime, "buildClampedSimpleOptions");
		expect(() => streamSimpleOpenAICodexResponses(model, { messages: [] })).toThrow(
			"No API key for provider: openai-codex",
		);
		expect(build).toHaveBeenCalledExactlyOnceWith(model, undefined);
	});

	it.each([
		[undefined, undefined],
		["off", { effort: "none" }],
		["ultra", { effort: "high", summary: "auto" }],
	] satisfies Array<[SimpleStreamOptions["reasoning"], unknown]>)(
		"preserves the %s reasoning projection and explicit service tier",
		async (reasoning, expectedReasoning) => {
			const build = vi.spyOn(providerRuntime, "buildClampedSimpleOptions");
			const fetch = vi.fn();
			vi.stubGlobal("fetch", fetch);
			let payload: unknown;
			const result = await streamSimpleOpenAICodexResponses(
				model,
				{ messages: [] },
				{
					apiKey,
					reasoning,
					serviceTier: "priority",
					transport: "sse",
					onPayload: (value) => {
						payload = value;
						throw new Error("captured before transport");
					},
				},
			).result();

			expect(build).toHaveBeenCalledOnce();
			expect(payload).toMatchObject({ service_tier: "priority" });
			if (expectedReasoning === undefined) expect(payload).not.toHaveProperty("reasoning");
			else expect(payload).toHaveProperty("reasoning", expectedReasoning);
			expect(result.errorMessage).toContain("captured before transport");
			expect(fetch).not.toHaveBeenCalled();
		},
	);
});
