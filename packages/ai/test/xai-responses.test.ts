import { describe, expect, it } from "vitest";
import { getModel, getModels } from "../src/models.ts";
import { streamOpenAIResponses } from "../src/providers/openai-responses.ts";
import type { Context } from "../src/types.ts";

// Regression coverage for the xAI subscription polish layer: the built-in catalog is grok-4.5
// and grok-4.6 on the Responses API. Both must echo reasoning.encrypted_content once reasoning
// is active, even when the caller requested no explicit reasoning effort (WP-7).

const context: Context = {
	messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
};

function completedResponsesSse(): Response {
	return new Response(
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				id: "resp_xai_test",
				status: "completed",
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			},
		})}\n\n`,
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

/** Drive a real Responses-lane request through a stubbed global fetch and capture the raw HTTP call. */
async function captureResponsesRequest(
	modelId: "grok-4.5" | "grok-4.6",
	options: Parameters<typeof streamOpenAIResponses>[2],
): Promise<{ url: string; headers: Headers; body: Record<string, unknown> }> {
	let capturedUrl: string | undefined;
	let capturedInit: RequestInit | undefined;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		capturedUrl = String(input);
		capturedInit = init;
		return completedResponsesSse();
	}) as typeof fetch;

	try {
		const model = getModel("xai", modelId);
		await streamOpenAIResponses(model, context, options).result();
	} finally {
		globalThis.fetch = originalFetch;
	}

	if (!capturedUrl || !capturedInit) throw new Error("Request was not captured");
	return {
		url: capturedUrl,
		headers: new Headers(capturedInit.headers),
		body: JSON.parse(String(capturedInit.body)) as Record<string, unknown>,
	};
}

describe.each(["grok-4.5", "grok-4.6"] as const)("xAI Responses lane (%s)", (modelId) => {
	it("authenticates with a Bearer token derived from the API key", async () => {
		const { url, headers } = await captureResponsesRequest(modelId, { apiKey: "test-key-123" });
		expect(url).toBe("https://api.x.ai/v1/responses");
		expect(headers.get("authorization")).toBe("Bearer test-key-123");
	});

	it("sends store:false and omits prompt_cache_retention/prompt_cache_key by default", async () => {
		const { body } = await captureResponsesRequest(modelId, { apiKey: "test-key-123" });
		expect(body.store).toBe(false);
		expect(body.prompt_cache_retention).toBeUndefined();
		expect(body.prompt_cache_key).toBeUndefined();
	});

	it("sets reasoning.effort when a reasoning effort is requested", async () => {
		const { body } = await captureResponsesRequest(modelId, { apiKey: "test-key-123", reasoningEffort: "high" });
		expect(body.reasoning).toMatchObject({ effort: "high" });
	});

	// WP-7 regression: thinkingLevelMap.off is null, so the "no explicit effort" branch that
	// would otherwise set params.reasoning is skipped entirely for xAI. Before the fix, that
	// also meant include:["reasoning.encrypted_content"] was never sent, silently dropping
	// encrypted reasoning across turns. It must be present regardless of the reasoning field.
	it("sets include:[reasoning.encrypted_content] even with no explicit reasoning effort", async () => {
		const { body } = await captureResponsesRequest(modelId, { apiKey: "test-key-123" });
		expect(body.reasoning).toBeUndefined();
		expect(body.include).toEqual(["reasoning.encrypted_content"]);
	});

	it("still sets include:[reasoning.encrypted_content] when a reasoning effort is requested", async () => {
		const { body } = await captureResponsesRequest(modelId, { apiKey: "test-key-123", reasoningEffort: "high" });
		expect(body.include).toEqual(["reasoning.encrypted_content"]);
	});
});

describe("xAI Responses lane (grok-4.6 xhigh)", () => {
	it("sends reasoning.effort xhigh", async () => {
		const { body } = await captureResponsesRequest("grok-4.6", { apiKey: "test-key-123", reasoningEffort: "xhigh" });
		expect(body.reasoning).toMatchObject({ effort: "xhigh" });
		expect(body.include).toEqual(["reasoning.encrypted_content"]);
	});
});

describe("xAI built-in catalog", () => {
	it("keeps only grok-4.5 and grok-4.6", () => {
		expect(
			getModels("xai")
				.map((model) => model.id)
				.sort(),
		).toEqual(["grok-4.5", "grok-4.6"]);
	});

	it("excludes retired and redundant models", () => {
		const ids = getModels("xai").map((model) => model.id);
		for (const modelId of [
			"grok-3",
			"grok-3-fast",
			"grok-4.20-0309-non-reasoning",
			"grok-4.20-0309-reasoning",
			"grok-code-fast-1",
			"grok-4.3",
			"grok-build-0.1",
		]) {
			expect(ids).not.toContain(modelId);
		}
	});
});
