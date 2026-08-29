import type Anthropic from "@anthropic-ai/sdk";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import type { Context } from "../src/types.ts";

// Guard for E10 / Phase 1 T4.1: Anthropic must never set `disable_parallel_tool_use`.
// Its absence is what keeps parallel tool-call emission allowed on the wire; this test
// pins that absence so a future change cannot silently reintroduce the flag.

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

const minimalAnthropicEvents = [
	{
		event: "message_start",
		data: JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_test",
				usage: {
					input_tokens: 12,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		}),
	},
	{
		event: "content_block_start",
		data: JSON.stringify({
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		}),
	},
	{
		event: "content_block_delta",
		data: JSON.stringify({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "Hello" },
		}),
	},
	{
		event: "content_block_stop",
		data: JSON.stringify({ type: "content_block_stop", index: 0 }),
	},
	{
		event: "message_delta",
		data: JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: {
				input_tokens: 12,
				output_tokens: 5,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		}),
	},
	{
		event: "message_stop",
		data: JSON.stringify({ type: "message_stop" }),
	},
];

function createFakeAnthropicClient(response: Response, onCreate?: (params: unknown) => void): Anthropic {
	return {
		messages: {
			create: (params: unknown) => {
				onCreate?.(params);
				return {
					asResponse: async () => response,
				};
			},
		},
	} as unknown as Anthropic;
}

describe("Anthropic parallel tool-call wire guard", () => {
	it("never sets disable_parallel_tool_use on a plain request", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context: Context = {
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		let payload: unknown;

		await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(createSseResponse(minimalAnthropicEvents), (value) => {
				payload = value;
			}),
		}).result();

		expect(payload).not.toHaveProperty("disable_parallel_tool_use");
		expect(JSON.stringify(payload)).not.toContain("disable_parallel_tool_use");
	});

	it("keeps disable_parallel_tool_use absent even with tools and an explicit forced tool_choice", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context: Context = {
			messages: [{ role: "user", content: "Use the tool.", timestamp: 1 }],
			tools: [{ name: "ping", description: "Ping", parameters: Type.Object({}) }],
		};
		let payload: unknown;

		await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(createSseResponse(minimalAnthropicEvents), (value) => {
				payload = value;
			}),
			toolChoice: { type: "tool", name: "ping" },
		}).result();

		const request = payload as { tool_choice?: Record<string, unknown> };
		expect(request.tool_choice).toEqual({ type: "tool", name: "ping" });
		expect(request.tool_choice).not.toHaveProperty("disable_parallel_tool_use");
		expect(JSON.stringify(payload)).not.toContain("disable_parallel_tool_use");
	});
});
