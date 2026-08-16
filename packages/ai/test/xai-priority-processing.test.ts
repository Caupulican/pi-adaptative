import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { streamSimpleOpenAIResponses } from "../src/providers/openai-responses.ts";
import type { Context, SimpleStreamOptions } from "../src/types.ts";

const context: Context = {
	messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
};

function completedResponsesSse(): Response {
	return new Response(
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				id: "resp_xai_priority_test",
				status: "completed",
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				output: [
					{
						id: "msg_xai_priority_test",
						type: "message",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "ok", annotations: [] }],
					},
				],
			},
		})}\n\n`,
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

async function captureRequestBody(options: SimpleStreamOptions): Promise<Record<string, unknown>> {
	let capturedInit: RequestInit | undefined;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
		capturedInit = init;
		return completedResponsesSse();
	}) as typeof fetch;

	try {
		await streamSimpleOpenAIResponses(getModel("xai", "grok-4.6"), context, options).result();
	} finally {
		globalThis.fetch = originalFetch;
	}

	if (!capturedInit) throw new Error("Request was not captured");
	return JSON.parse(String(capturedInit.body)) as Record<string, unknown>;
}

describe("xAI Priority Processing", () => {
	it("forwards the priority service tier through the simple harness path", async () => {
		const body = await captureRequestBody({ apiKey: "test-key", serviceTier: "priority" });

		expect(body.service_tier).toBe("priority");
	});

	it("omits the service tier when priority processing was not requested", async () => {
		const body = await captureRequestBody({ apiKey: "test-key" });

		expect(body.service_tier).toBeUndefined();
	});
});
