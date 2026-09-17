import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import type { Model } from "../src/types.ts";

const now = 1_800_000_000_000;
const model: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://fixture.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4096,
};

function limited(): Response {
	return new Response(
		JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Rate limited" } }),
		{
			status: 429,
			headers: {
				"content-type": "application/json",
				"anthropic-ratelimit-unified-reset": String((now + 5_000) / 1000),
			},
		},
	);
}

function completed(): Response {
	const events = [
		{ type: "message_start", message: { id: "msg_test", usage: { input_tokens: 1, output_tokens: 0 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "delivered" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());

describe("Claude reset through the real SDK transport", () => {
	it("delivers after the reset without an early SDK or host retry", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(limited())
			.mockResolvedValueOnce(completed());
		const client = new Anthropic({ apiKey: "fixture", baseURL: model.baseUrl, fetch, maxRetries: 3 });
		const stream = streamAnthropic(model, { messages: [] }, { client, maxRetries: 1 });
		await vi.advanceTimersByTimeAsync(4_999);
		expect(fetch).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(await stream.result()).toMatchObject({
			stopReason: "stop",
			content: [{ type: "text", text: "delivered" }],
		});
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("preserves reset guidance in the terminal assistant error when transport retries are disabled", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(limited());
		const client = new Anthropic({ apiKey: "fixture", baseURL: model.baseUrl, fetch });
		const message = await streamAnthropic(model, { messages: [] }, { client, maxRetries: 0 }).result();
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("Provider retry directive: retry after 5s.");
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("delivers a successful response without interpreting its reset as rejection", async () => {
		const response = completed();
		response.headers.set("anthropic-ratelimit-unified-reset", String((now + 5_000) / 1000));
		response.headers.set("anthropic-ratelimit-unified-status", "allowed");
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response);
		const client = new Anthropic({ apiKey: "fixture", baseURL: model.baseUrl, fetch });
		const message = await streamAnthropic(model, { messages: [] }, { client, maxRetries: 1 }).result();
		expect(message.stopReason).toBe("stop");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(Date.now()).toBe(now);
	});

	it.each([0, 1])(
		"hands an excessive reset to the caller without an SDK retry (maxRetries=%s)",
		async (maxRetries) => {
			const response = limited();
			response.headers.set("anthropic-ratelimit-unified-reset", String((now + 120_000) / 1000));
			const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response);
			const client = new Anthropic({ apiKey: "fixture", baseURL: model.baseUrl, fetch, maxRetries: 3 });
			const message = await streamAnthropic(model, { messages: [] }, { client, maxRetries }).result();
			expect(message.stopReason).toBe("error");
			expect(message.errorMessage).toContain("Server requested 120s retry delay (max: 60s)");
			expect(message.errorMessage).toContain("Provider retry directive: do not retry.");
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(Date.now()).toBe(now);
		},
	);
});
