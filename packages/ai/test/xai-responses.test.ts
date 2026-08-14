import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { streamOpenAICompletions } from "../src/providers/openai-completions.ts";
import { streamOpenAIResponses } from "../src/providers/openai-responses.ts";
import type { Context } from "../src/types.ts";

// Regression coverage for the xAI subscription polish layer: grok-4.5 is routed through the
// Responses API and must always echo back reasoning.encrypted_content once reasoning is active,
// even when the caller requested no explicit reasoning effort (WP-7). grok-4.3/grok-4.6 stay on
// the Completions API, which never sends reasoning_effort to xAI (detectCompat treats all xAI
// models as not supporting it, regardless of reasoningEffort).

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

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function stopAfterPayload<TPayload>(capture: (payload: TPayload) => void): (payload: unknown) => never {
	return (payload: unknown): never => {
		capture(payload as TPayload);
		throw new PayloadCaptured();
	};
}

/** Drive a real Responses-lane request through a stubbed global fetch and capture the raw HTTP call. */
async function captureResponsesRequest(
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
		const model = getModel("xai", "grok-4.5");
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

describe("xAI Responses lane (grok-4.5)", () => {
	it("authenticates with a Bearer token derived from the API key", async () => {
		const { url, headers } = await captureResponsesRequest({ apiKey: "test-key-123" });
		expect(url).toBe("https://api.x.ai/v1/responses");
		expect(headers.get("authorization")).toBe("Bearer test-key-123");
	});

	it("sends store:false and omits prompt_cache_retention/prompt_cache_key by default", async () => {
		const { body } = await captureResponsesRequest({ apiKey: "test-key-123" });
		expect(body.store).toBe(false);
		expect(body.prompt_cache_retention).toBeUndefined();
		expect(body.prompt_cache_key).toBeUndefined();
	});

	it("sets reasoning.effort when a reasoning effort is requested", async () => {
		const { body } = await captureResponsesRequest({ apiKey: "test-key-123", reasoningEffort: "high" });
		expect(body.reasoning).toMatchObject({ effort: "high" });
	});

	// WP-7 regression: grok-4.5's thinkingLevelMap.off is null, so the "no explicit effort" branch
	// that would otherwise set params.reasoning is skipped entirely for xAI. Before the fix, that
	// also meant include:["reasoning.encrypted_content"] was never sent, silently dropping
	// encrypted reasoning across turns. It must be present regardless of the reasoning field.
	it("sets include:[reasoning.encrypted_content] even with no explicit reasoning effort", async () => {
		const { body } = await captureResponsesRequest({ apiKey: "test-key-123" });
		expect(body.reasoning).toBeUndefined();
		expect(body.include).toEqual(["reasoning.encrypted_content"]);
	});

	it("still sets include:[reasoning.encrypted_content] when a reasoning effort is requested", async () => {
		const { body } = await captureResponsesRequest({ apiKey: "test-key-123", reasoningEffort: "high" });
		expect(body.include).toEqual(["reasoning.encrypted_content"]);
	});
});

describe("xAI Completions lane (grok-4.3, grok-4.6)", () => {
	for (const modelId of ["grok-4.3", "grok-4.6"] as const) {
		it(`${modelId} omits reasoning_effort with no explicit effort`, async () => {
			const model = getModel("xai", modelId);
			let capturedPayload: Record<string, unknown> | undefined;
			try {
				const s = streamOpenAICompletions(model, context, {
					apiKey: "test-key",
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload as Record<string, unknown>;
					}),
				});
				for await (const _event of s) {
					// draining is unreachable once onPayload throws
				}
			} catch (error) {
				if (!(error instanceof PayloadCaptured)) throw error;
			}
			expect(capturedPayload).toBeDefined();
			expect(capturedPayload).not.toHaveProperty("reasoning_effort");
		});

		it(`${modelId} omits reasoning_effort even when an explicit effort is requested`, async () => {
			const model = getModel("xai", modelId);
			let capturedPayload: Record<string, unknown> | undefined;
			try {
				const s = streamOpenAICompletions(model, context, {
					apiKey: "test-key",
					reasoningEffort: "high",
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload as Record<string, unknown>;
					}),
				});
				for await (const _event of s) {
					// draining is unreachable once onPayload throws
				}
			} catch (error) {
				if (!(error instanceof PayloadCaptured)) throw error;
			}
			expect(capturedPayload).toBeDefined();
			expect(capturedPayload).not.toHaveProperty("reasoning_effort");
		});
	}
});
