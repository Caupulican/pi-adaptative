import { beforeEach, describe, expect, it, vi } from "vitest";
import { complete } from "../src/stream.ts";
import type { Model } from "../src/types.ts";

// Router/virtual ids (e.g. OpenRouter `auto`) keep `model` pinned to the
// requested id and surface the routed concrete id on `responseModel`.

const mockState = vi.hoisted(() => ({
	chunks: [] as unknown[],
	requests: [] as unknown[],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.requests.push(params);
					const chunks = mockState.chunks;
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of chunks) yield chunk;
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

function openRouterAuto(): Model<"openai-completions"> {
	return {
		id: "openrouter/auto",
		name: "OpenRouter Auto",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	};
}

describe("openai-completions responseModel", () => {
	beforeEach(() => {
		mockState.chunks = [];
		mockState.requests = [];
	});

	it("surfaces routed chunk.model on responseModel without changing model", async () => {
		mockState.chunks = [
			{ id: "chatcmpl-1", model: "anthropic/claude-opus-4.8", choices: [{ index: 0, delta: { content: "hi" } }] },
			{
				id: "chatcmpl-1",
				model: "anthropic/claude-opus-4.8",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 5,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const message = await complete(
			openRouterAuto(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);

		expect(message.model).toBe("openrouter/auto");
		expect(message.responseModel).toBe("anthropic/claude-opus-4.8");
		expect(message.provider).toBe("openrouter");
		expect(message.stopReason).toBe("stop");
	});

	it("leaves responseModel undefined when chunks echo the requested id", async () => {
		mockState.chunks = [
			{ id: "chatcmpl-2", model: "openrouter/auto", choices: [{ index: 0, delta: { content: "hi" } }] },
			{
				id: "chatcmpl-2",
				model: "openrouter/auto",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 1,
					completion_tokens: 1,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const message = await complete(
			openRouterAuto(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);

		expect(message.model).toBe("openrouter/auto");
		expect(message.responseModel).toBeUndefined();
	});

	it("synthesizes ids for streamed tool calls that omit them", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-missing-id",
				model: "openrouter/auto",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{ index: 0, type: "function", function: { name: "first", arguments: '{"value":1}' } },
								{ index: 1, type: "function", function: { name: "second", arguments: '{"value":2}' } },
							],
						},
						finish_reason: "tool_calls",
					},
				],
				usage: {
					prompt_tokens: 1,
					completion_tokens: 1,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const message = await complete(
			openRouterAuto(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);

		const toolCalls = message.content.filter((block) => block.type === "toolCall");
		expect(toolCalls.map((toolCall) => toolCall.id)).toEqual(["call_0", "call_1"]);
		expect(toolCalls.map((toolCall) => toolCall.name)).toEqual(["first", "second"]);
	});

	it("disambiguates duplicate streamed tool call ids", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-duplicate-id",
				model: "openrouter/auto",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "dup",
									type: "function",
									function: { name: "first", arguments: '{"value":1}' },
								},
								{
									index: 1,
									id: "dup",
									type: "function",
									function: { name: "second", arguments: '{"value":2}' },
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
				usage: {
					prompt_tokens: 1,
					completion_tokens: 1,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const message = await complete(
			openRouterAuto(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);

		const toolCalls = message.content.filter((block) => block.type === "toolCall");
		expect(toolCalls.map((toolCall) => toolCall.id)).toEqual(["dup", "dup_2"]);
		expect(toolCalls.map((toolCall) => toolCall.name)).toEqual(["first", "second"]);
	});

	it("round-trips sanitized OpenAI-compatible tool names", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-sanitized-tool",
				model: "openrouter/auto",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									type: "function",
									function: { name: "mcp_server_do-thing", arguments: '{"value":"ok"}' },
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
				usage: {
					prompt_tokens: 1,
					completion_tokens: 1,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const message = await complete(
			openRouterAuto(),
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
				tools: [
					{
						name: "mcp.server:do-thing",
						description: "Do thing",
						parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
					},
				],
			},
			{ apiKey: "test" },
		);

		const request = mockState.requests[0] as { tools?: Array<{ function: { name: string } }> };
		const toolCall = message.content.find((block) => block.type === "toolCall");
		expect(request.tools?.[0]?.function.name).toBe("mcp_server_do-thing");
		expect(toolCall).toMatchObject({ type: "toolCall", name: "mcp.server:do-thing" });
	});

	it("disambiguates colliding sanitized OpenAI-compatible tool names", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-sanitized-collision",
				model: "openrouter/auto",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									type: "function",
									function: { name: "mcp_server_do_thing_2", arguments: "{}" },
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
				usage: {
					prompt_tokens: 1,
					completion_tokens: 1,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const message = await complete(
			openRouterAuto(),
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
				tools: [
					{ name: "mcp.server:do_thing", description: "First", parameters: { type: "object", properties: {} } },
					{ name: "mcp/server:do_thing", description: "Second", parameters: { type: "object", properties: {} } },
				],
			},
			{ apiKey: "test" },
		);

		const request = mockState.requests[0] as { tools?: Array<{ function: { name: string } }> };
		const toolCall = message.content.find((block) => block.type === "toolCall");
		expect(request.tools?.map((tool) => tool.function.name)).toEqual([
			"mcp_server_do_thing",
			"mcp_server_do_thing_2",
		]);
		expect(toolCall).toMatchObject({ type: "toolCall", name: "mcp/server:do_thing" });
	});

	it("marks truncated streamed tool arguments as provider tool errors", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-truncated-tool",
				model: "openrouter/auto",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									type: "function",
									function: { name: "echo", arguments: '{"value":"hel' },
								},
							],
						},
						finish_reason: "length",
					},
				],
				usage: {
					prompt_tokens: 1,
					completion_tokens: 1,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const message = await complete(
			openRouterAuto(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);

		const toolCall = message.content.find((block) => block.type === "toolCall");
		expect(message.stopReason).toBe("length");
		expect(toolCall).toMatchObject({
			type: "toolCall",
			id: "call_1",
			name: "echo",
			errorMessage:
				"Tool call arguments were truncated before complete JSON was received (stop reason: length). Retry the tool call with complete JSON arguments.",
		});
	});

	it("does not mark complete streamed tool arguments", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-complete-tool",
				model: "openrouter/auto",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									type: "function",
									function: { name: "echo", arguments: '{"value":"hello"}' },
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
				usage: {
					prompt_tokens: 1,
					completion_tokens: 1,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const message = await complete(
			openRouterAuto(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);

		const toolCall = message.content.find((block) => block.type === "toolCall");
		expect(message.stopReason).toBe("toolUse");
		expect(toolCall).toMatchObject({ type: "toolCall", id: "call_1", name: "echo", arguments: { value: "hello" } });
		expect(toolCall).not.toHaveProperty("errorMessage");
	});

	it("buffers reasoning_details that arrive before matching streamed tool calls", async () => {
		const detail = { type: "reasoning.encrypted", id: "call_1", data: "encrypted" };
		mockState.chunks = [
			{
				id: "chatcmpl-r",
				model: "openrouter/auto",
				choices: [{ index: 0, delta: { reasoning_details: [detail] } }],
			},
			{
				id: "chatcmpl-r",
				model: "openrouter/auto",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q"' } },
							],
						},
					},
				],
			},
			{
				id: "chatcmpl-r",
				model: "openrouter/auto",
				choices: [
					{
						index: 0,
						delta: { tool_calls: [{ index: 0, function: { arguments: ':"x"}' } }] },
						finish_reason: "tool_calls",
					},
				],
				usage: {
					prompt_tokens: 1,
					completion_tokens: 1,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const message = await complete(
			openRouterAuto(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);

		const toolCall = message.content.find((block) => block.type === "toolCall");
		expect(toolCall?.thoughtSignature).toBe(JSON.stringify(detail));
	});

	it("ignores empty or missing chunk.model", async () => {
		mockState.chunks = [
			{ id: "chatcmpl-3", choices: [{ index: 0, delta: { content: "hi" } }] },
			{ id: "chatcmpl-3", model: "", choices: [{ index: 0, delta: { content: "!" } }] },
			{
				id: "chatcmpl-3",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 1,
					completion_tokens: 2,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const message = await complete(
			openRouterAuto(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);

		expect(message.model).toBe("openrouter/auto");
		expect(message.responseModel).toBeUndefined();
	});
});
