import { afterEach, describe, expect, it, vi } from "vitest";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import type { Model } from "../src/types.ts";

const model: Model<"anthropic-messages"> = {
	id: "local-stream",
	name: "Local stream",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://unused.invalid",
	reasoning: true,
	input: ["text"],
	contextWindow: 1000,
	maxTokens: 100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const start = { type: "message_start", message: { id: "local", usage: { input_tokens: 2, output_tokens: 0 } } };
function frame(event: { type: string }): string {
	return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

afterEach(() => vi.unstubAllGlobals());

describe("Anthropic wire stream", () => {
	it("publishes seeded content and replaces the signature", async () => {
		const events = [
			start,
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "thinking", thinking: "seed", signature: "old" },
			},
			{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "new" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "content_block_start", index: 1, content_block: { type: "text", text: "answer" } },
			{ type: "content_block_stop", index: 1 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
			{ type: "message_stop" },
		];
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					new Response(events.map(frame).join(""), { headers: { "content-type": "text/event-stream" } }),
				),
		);
		const stream = streamAnthropic(model, { messages: [] }, { apiKey: "local-key" });
		const deltas: string[] = [];
		for await (const event of stream) {
			if (event.type === "text_delta" || event.type === "thinking_delta") deltas.push(event.delta);
		}
		const output = await stream.result();
		expect(output.stopReason).toBe("stop");
		expect(deltas).toEqual(["seed", "answer"]);
		expect(output.content[0]).toEqual({ type: "thinking", thinking: "seed", thinkingSignature: "new" });
		expect(output.usage.totalTokens).toBe(5);
	});

	it.each(["", ":keepalive\n\n", frame(start)])("rejects incomplete streams %j", async (wire) => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(wire, { headers: { "content-type": "text/event-stream" } })),
		);
		const output = await streamAnthropic(model, { messages: [] }, { apiKey: "local-key" }).result();
		expect(output.stopReason).toBe("error");
		expect(output.errorMessage).toContain("complete message_start/message_stop");
	});

	it("cancels acquired bodies if the response hook fails", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(body, { headers: { "content-type": "text/event-stream" } })),
		);
		const output = await streamAnthropic(
			model,
			{ messages: [] },
			{
				apiKey: "local-key",
				onResponse: () => {
					throw new Error("hook failure");
				},
			},
		).result();
		expect(output.stopReason).toBe("error");
		// The stream publishes its terminal error before the enclosing cleanup's awaited microtask.
		await Promise.resolve();
		expect(cancelled).toBe(true);
		expect(body.locked).toBe(false);
	});
});
