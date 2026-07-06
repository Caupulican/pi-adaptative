import type { Context, Model } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamProxy } from "../src/proxy.ts";

function createModel(): Model<any> {
	return {
		id: "model",
		name: "model",
		provider: "test",
		api: "test",
		baseUrl: "https://example.test",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000,
		maxTokens: 100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function sseResponse(text: string): Response {
	return new Response(new TextEncoder().encode(text), { status: 200, statusText: "OK" });
}

describe("streamProxy", () => {
	afterEach(() => vi.restoreAllMocks());

	it("turns proxy stream close without a terminal event into an error result", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				sseResponse(
					[
						'data: {"type":"start"}',
						'data: {"type":"text_start","contentIndex":0}',
						'data: {"type":"text_delta","contentIndex":0,"delta":"partial"}',
						"",
					].join("\n"),
				),
			),
		);

		const stream = streamProxy(createModel(), { messages: [] } as unknown as Context, {
			proxyUrl: "https://proxy.test",
			authToken: "token",
		});

		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("stream ended before terminal event");
	});
});
