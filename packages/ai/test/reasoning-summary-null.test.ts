import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.ts";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.ts";
import { streamOpenAIResponses } from "../src/providers/openai-responses.ts";
import type { Context } from "../src/types.ts";

const context: Context = {
	messages: [{ role: "user", content: "Solve this.", timestamp: Date.now() }],
};

function completedSse(): Response {
	return new Response(
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				id: "resp_summary_null",
				status: "completed",
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			},
		})}\n\n`,
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function mockCodexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("reasoningSummary: null", () => {
	it("preserves default reasoning while omitting the OpenAI Responses summary", async () => {
		let payload: { reasoning?: Record<string, unknown> } | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => completedSse()),
		);

		await streamOpenAIResponses(getModel("openai", "gpt-5.6-sol"), context, {
			apiKey: "test-key",
			reasoningSummary: null,
			onPayload: (value) => {
				payload = value as { reasoning?: Record<string, unknown> };
			},
		}).result();

		expect(payload?.reasoning).toEqual({ effort: "medium" });
	});

	it("omits the summary field from OpenAI Responses reasoning", async () => {
		let payload: { reasoning?: Record<string, unknown> } | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => completedSse()),
		);

		await streamOpenAIResponses(getModel("openai", "gpt-5.6-sol"), context, {
			apiKey: "test-key",
			reasoningEffort: "high",
			reasoningSummary: null,
			onPayload: (value) => {
				payload = value as { reasoning?: Record<string, unknown> };
			},
		}).result();

		expect(payload?.reasoning).toMatchObject({ effort: "high" });
		expect(payload?.reasoning).not.toHaveProperty("summary");
	});

	it("omits the summary field from ChatGPT Codex Responses reasoning", async () => {
		let payload: { reasoning?: Record<string, unknown> } | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => completedSse()),
		);

		await streamOpenAICodexResponses(getModel("openai-codex", "gpt-5.6-sol"), context, {
			apiKey: mockCodexToken(),
			transport: "sse",
			reasoningEffort: "high",
			reasoningSummary: null,
			onPayload: (value) => {
				payload = value as { reasoning?: Record<string, unknown> };
			},
		}).result();

		expect(payload?.reasoning).toMatchObject({ effort: "high" });
		expect(payload?.reasoning).not.toHaveProperty("summary");
	});
});
