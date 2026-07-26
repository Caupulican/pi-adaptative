import type Anthropic from "@anthropic-ai/sdk";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { calculateCost, getModel } from "../src/models.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import type { Context, ToolCall } from "../src/types.ts";

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

describe("Anthropic raw SSE parsing", () => {
	it("maps custom tool names reversibly across declarations, forced choice, and returned calls", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const localName = "mcp.server:do_thing";
		const providerName = "mcp_server_do_thing";
		const context: Context = {
			messages: [{ role: "user", content: "Use the MCP tool.", timestamp: 1 }],
			tools: [
				{ name: localName, description: "MCP tool", parameters: Type.Object({}) },
				{ name: providerName, description: "Collision sentinel", parameters: Type.Object({}) },
			],
		};
		let payload: unknown;
		const response = createSseResponse([
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: { id: "msg_tools", usage: { input_tokens: 1, output_tokens: 0 } },
				}),
			},
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 0,
					content_block: { type: "tool_use", id: "toolu_1", name: providerName, input: {} },
				}),
			},
			{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "tool_use" },
					usage: { output_tokens: 1 },
				}),
			},
			{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
		]);

		const result = await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response, (value) => {
				payload = value;
			}),
			toolChoice: { type: "tool", name: localName },
		}).result();

		const request = payload as { tools: Array<{ name: string }>; tool_choice: { name: string } };
		expect(request.tools.map((tool) => tool.name)).toEqual([providerName, `${providerName}_2`]);
		expect(request.tool_choice.name).toBe(providerName);
		expect((result.content[0] as ToolCall).name).toBe(localName);
	});

	it("keeps content_block_start tool input when no deltas arrive", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context: Context = {
			messages: [{ role: "user", content: "Use the lookup tool.", timestamp: Date.now() }],
			tools: [
				{
					name: "lookup",
					description: "Look up a value.",
					parameters: Type.Object({ value: Type.String() }),
				},
			],
		};
		const baseEvents = [
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: { id: "msg_test", usage: { input_tokens: 12, output_tokens: 0 } },
				}),
			},
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 0,
					content_block: {
						type: "tool_use",
						id: "toolu_test",
						name: "lookup",
						input: { value: "seeded" },
					},
				}),
			},
		] satisfies Array<{ event: string; data: string }>;
		const stopEvents = [
			{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "tool_use" },
					usage: { output_tokens: 5 },
				}),
			},
			{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
		] satisfies Array<{ event: string; data: string }>;

		const seededOnly = await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(createSseResponse([...baseEvents, ...stopEvents])),
		}).result();
		expect((seededOnly.content[0] as ToolCall).arguments).toEqual({ value: "seeded" });

		const mixed = await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(
				createSseResponse([
					...baseEvents,
					{
						event: "content_block_delta",
						data: JSON.stringify({
							type: "content_block_delta",
							index: 0,
							delta: { type: "input_json_delta", partial_json: '{"value":"delta"}' },
						}),
					},
					...stopEvents,
				]),
			),
		}).result();
		expect((mixed.content[0] as ToolCall).arguments).toEqual({ value: "delta" });
	});

	it("repairs malformed SSE JSON and malformed streamed tool JSON", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context: Context = {
			messages: [{ role: "user", content: "Use the edit tool.", timestamp: Date.now() }],
			tools: [
				{
					name: "edit",
					description: "Edit a file.",
					parameters: Type.Object({
						path: Type.String(),
						text: Type.String(),
					}),
				},
			],
		};

		const malformedToolJsonDelta = String.raw`{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"A\H\",\"text\":\"col1	col2\"}"}}`;

		const response = createSseResponse([
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
					content_block: {
						type: "tool_use",
						id: "toolu_test",
						name: "edit",
						input: {},
					},
				}),
			},
			{ event: "content_block_delta", data: malformedToolJsonDelta },
			{
				event: "content_block_stop",
				data: JSON.stringify({ type: "content_block_stop", index: 0 }),
			},
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "tool_use" },
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
		]);

		const stream = streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.errorMessage).toBeUndefined();

		const toolCall = result.content.find((block): block is ToolCall => block.type === "toolCall");
		expect(toolCall).toBeDefined();
		expect(toolCall?.arguments).toEqual({
			path: "A\\H",
			text: "col1\tcol2",
		});
	});

	it("ignores unknown SSE events after message_stop", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context: Context = {
			messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }],
		};
		const response = createSseResponse([
			...minimalAnthropicEvents,
			{ event: "done", data: "[DONE]" },
			{ event: "proxy.stats", data: "not json" },
		]);

		const stream = streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
		const expectedTotal =
			result.usage.cost.input +
			result.usage.cost.output +
			result.usage.cost.cacheRead +
			result.usage.cost.cacheWrite;
		expect(result.usage.cost.total).toBe(expectedTotal);
		expect(result.usage.cost.output).toBeGreaterThan(0);
	});

	it("preserves accumulated usage when message_delta omits usage", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context: Context = {
			messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }],
		};
		const response = createSseResponse(
			minimalAnthropicEvents.map((event) =>
				event.event === "message_delta"
					? {
							event: "message_delta",
							data: JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
						}
					: event,
			),
		);

		const result = await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response),
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
		expect(result.usage.input).toBe(12);
		expect(result.usage.totalTokens).toBe(12);
	});

	it("rejects a multi-line SSE event whose total exceeds the event bound", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
		const chunk = "x".repeat(1024 * 1024);
		const response = new Response(Array.from({ length: 9 }, () => `data: ${chunk}`).join("\n"), {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const result = await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response),
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Anthropic SSE event exceeded");
	});

	it("preserves explicitly provider-supplied usage cost totals", () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const usage = {
			input: 12,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 17,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 123 },
		};

		calculateCost(model, usage, { providerSuppliedTotal: true });

		expect(usage.cost.total).toBe(123);
	});
});
