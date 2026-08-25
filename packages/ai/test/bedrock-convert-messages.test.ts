import { afterEach, describe, expect, it, vi } from "vitest";

const bedrockMock = vi.hoisted(() => ({
	constructorCalls: [] as Array<Record<string, unknown>>,
	streamEvents: undefined as unknown[] | undefined,
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		constructor(config: Record<string, unknown>) {
			bedrockMock.constructorCalls.push(config);
		}

		send(): Promise<{ $metadata: Record<string, unknown>; stream: AsyncIterable<unknown> }> {
			if (!bedrockMock.streamEvents) return Promise.reject(new Error("mock send"));
			const events = bedrockMock.streamEvents;
			return Promise.resolve({
				$metadata: {},
				stream: {
					async *[Symbol.asyncIterator]() {
						for (const event of events) yield event;
					},
				},
			});
		}
	}

	class ConverseStreamCommand {
		readonly input: unknown;

		constructor(input: unknown) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import { getModel } from "../src/models.ts";
import { streamBedrock } from "../src/providers/amazon-bedrock.ts";
import type { AssistantMessage, Context, Message, UserMessage } from "../src/types.ts";

const baseModel = getModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0");

afterEach(() => {
	bedrockMock.streamEvents = undefined;
});

async function capturePayload(context: Context, model = baseModel): Promise<unknown> {
	let capturedPayload: unknown;
	const s = streamBedrock(model, context, {
		cacheRetention: "none",
		signal: AbortSignal.abort(),
		onPayload: (payload) => {
			capturedPayload = payload;
			return payload;
		},
	});
	for await (const event of s) {
		if (event.type === "error") break;
	}
	return capturedPayload;
}

function makeAssistant(content: AssistantMessage["content"], model = baseModel): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("bedrock redacted thinking", () => {
	it("captures streamed redacted reasoning content", async () => {
		const redacted = new Uint8Array([1, 2, 3, 4]);
		bedrockMock.streamEvents = [
			{ messageStart: { role: "assistant" } },
			{ contentBlockStart: { contentBlockIndex: 0, start: { reasoningContent: {} } } },
			{ contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { redactedContent: redacted } } } },
			{ contentBlockStop: { contentBlockIndex: 0 } },
			{ messageStop: { stopReason: "end_turn" } },
			{ metadata: { usage: { inputTokens: 1, outputTokens: 1 } } },
		];

		const result = await streamBedrock(baseModel, {
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content[0]).toMatchObject({
			type: "thinking",
			redacted: true,
			thinkingSignature: Buffer.from(redacted).toString("base64"),
		});
	});

	it("replays redacted thinking as Bedrock redacted reasoning content", async () => {
		const redacted = Buffer.from([5, 6, 7]).toString("base64");
		const messages: Message[] = [
			{
				role: "assistant",
				content: [{ type: "thinking", thinking: "", thinkingSignature: redacted, redacted: true }],
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				model: baseModel.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];

		const payload = await capturePayload({ messages });
		const p = payload as { messages: Array<{ role: string; content: Array<{ reasoningContent: unknown }> }> };
		expect(p.messages).toHaveLength(1);
		expect(p.messages[0].content).toEqual([{ reasoningContent: { redactedContent: new Uint8Array([5, 6, 7]) } }]);
	});
});

describe("bedrock Anthropic signed thinking replay", () => {
	it("replays signed thinking in the latest assistant message without text normalization", async () => {
		const rawThinking = `raw ${String.fromCharCode(0xd800)}`;
		const payload = await capturePayload({
			messages: [makeAssistant([{ type: "thinking", thinking: rawThinking, thinkingSignature: "signature" }])],
		});
		const request = payload as {
			messages: Array<{
				content: Array<{ reasoningContent?: { reasoningText?: { text: string; signature?: string } } }>;
			}>;
		};

		expect(request.messages[0].content[0]).toEqual({
			reasoningContent: { reasoningText: { text: rawThinking, signature: "signature" } },
		});
	});

	it("keeps normalizing signed thinking outside the latest assistant message", async () => {
		const rawThinking = `older ${String.fromCharCode(0xd800)}`;
		const payload = await capturePayload({
			messages: [
				makeAssistant([{ type: "thinking", thinking: rawThinking, thinkingSignature: "signature" }]),
				{ role: "user", content: "continue", timestamp: 2 },
				makeAssistant([{ type: "text", text: "latest" }]),
			],
		});
		const request = payload as {
			messages: Array<{
				content: Array<{ reasoningContent?: { reasoningText?: { text: string; signature?: string } } }>;
			}>;
		};

		expect(request.messages[0].content[0]).toEqual({
			reasoningContent: { reasoningText: { text: "older ", signature: "signature" } },
		});
	});

	it("keeps normalizing latest signed thinking for non-Anthropic Bedrock models", async () => {
		const nonAnthropicModel = {
			...baseModel,
			id: "amazon.nova-pro-v1:0",
			name: "Amazon Nova Pro",
		};
		const rawThinking = `raw ${String.fromCharCode(0xd800)}`;
		const payload = await capturePayload(
			{
				messages: [
					makeAssistant(
						[{ type: "thinking", thinking: rawThinking, thinkingSignature: "signature" }],
						nonAnthropicModel,
					),
				],
			},
			nonAnthropicModel,
		);
		const request = payload as {
			messages: Array<{
				content: Array<{ reasoningContent?: { reasoningText?: { text: string; signature?: string } } }>;
			}>;
		};

		expect(request.messages[0].content[0]).toEqual({
			reasoningContent: { reasoningText: { text: "raw " } },
		});
	});
});

describe("bedrock tool-name routing", () => {
	it("restores the local name on streamed tool calls", async () => {
		bedrockMock.streamEvents = [
			{ messageStart: { role: "assistant" } },
			{
				contentBlockStart: {
					contentBlockIndex: 0,
					start: { toolUse: { toolUseId: "tool-1", name: "mcp_server_do_thing" } },
				},
			},
			{ contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: "{}" } } } },
			{ contentBlockStop: { contentBlockIndex: 0 } },
			{ messageStop: { stopReason: "tool_use" } },
		];
		const result = await streamBedrock(baseModel, {
			messages: [{ role: "user", content: "Use the MCP tool", timestamp: 1 }],
			tools: [
				{ name: "mcp.server:do_thing", description: "MCP tool", parameters: { type: "object" } },
				{ name: "mcp_server_do_thing", description: "Collision", parameters: { type: "object" } },
			],
		}).result();

		expect(result.content[0]).toMatchObject({ type: "toolCall", name: "mcp.server:do_thing", arguments: {} });
	});
});

describe("bedrock tool arguments", () => {
	it("preserves empty property names in the streamed assistant message", async () => {
		bedrockMock.streamEvents = [
			{ messageStart: { role: "assistant" } },
			{
				contentBlockStart: {
					contentBlockIndex: 0,
					start: { toolUse: { toolUseId: "tool-1", name: "edit" } },
				},
			},
			{
				contentBlockDelta: {
					contentBlockIndex: 0,
					delta: { toolUse: { input: '{"edits":[{"path":"file.ts","":"invalid"}]}' } },
				},
			},
			{ contentBlockStop: { contentBlockIndex: 0 } },
			{ messageStop: { stopReason: "tool_use" } },
		];

		const result = await streamBedrock(baseModel, {
			messages: [{ role: "user", content: "Use the tool", timestamp: Date.now() }],
		}).result();

		expect(result.content[0]).toMatchObject({
			type: "toolCall",
			arguments: { edits: [{ path: "file.ts", "": "invalid" }] },
		});
	});

	it("removes empty property names only from outbound replay documents", async () => {
		const toolArguments = {
			path: "/workspace/file.ts",
			metadata: {},
			edits: [
				{ oldText: "first", newText: "updated first" },
				{ oldText: "second", newText: "updated second", "": { nested: true } },
			],
		};
		const messages: Message[] = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "tool-1", name: "edit", arguments: toolArguments }],
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				model: baseModel.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "edit",
				content: [{ type: "text", text: "done" }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const payload = await capturePayload({ messages });
		const request = payload as {
			messages: Array<{ content: Array<{ toolUse?: { input: unknown } }> }>;
		};
		expect(request.messages[0].content[0].toolUse?.input).toEqual({
			path: "/workspace/file.ts",
			metadata: {},
			edits: [
				{ oldText: "first", newText: "updated first" },
				{ oldText: "second", newText: "updated second" },
			],
		});
		expect(toolArguments.edits[1]).toEqual({
			oldText: "second",
			newText: "updated second",
			"": { nested: true },
		});
	});
});

describe("bedrock image format downgrade", () => {
	it("downgrades unsupported image formats without dropping supported content", async () => {
		const payload = await capturePayload({
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "look" },
						{ type: "image", mimeType: "image/bmp", data: "AQID" },
						{ type: "image", mimeType: "image/png", data: "BAUG" },
					],
					timestamp: Date.now(),
				},
			],
		});

		const p = payload as {
			messages: Array<{
				role: string;
				content: Array<{ text?: string; image?: { format: string; source: { bytes: Uint8Array } } }>;
			}>;
		};
		expect(p.messages).toHaveLength(1);
		expect(p.messages[0].content).toHaveLength(3);
		expect(p.messages[0].content[0]).toEqual({ text: "look" });
		expect(p.messages[0].content[1]).toEqual({ text: "(image omitted: model does not support images)" });
		expect(p.messages[0].content[2].image?.format).toBe("png");
		expect(Array.from(p.messages[0].content[2].image?.source.bytes ?? [])).toEqual([4, 5, 6]);
	});
});

describe("bedrock convertMessages skips unknown content types", () => {
	it("maps custom tool names in declarations and assistant history", async () => {
		const localName = "mcp.server:do_thing";
		const messages: Message[] = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "tool-1", name: localName, arguments: {} }],
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				model: baseModel.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 1,
			},
		];
		const payload = await capturePayload({
			messages,
			tools: [
				{ name: localName, description: "MCP tool", parameters: { type: "object" } },
				{ name: "mcp_server_do_thing", description: "Collision", parameters: { type: "object" } },
			],
		});
		const request = payload as {
			messages: Array<{ content: Array<{ toolUse: { name: string } }> }>;
			toolConfig: { tools: Array<{ toolSpec: { name: string } }> };
		};
		expect(request.toolConfig.tools.map((tool) => tool.toolSpec.name)).toEqual([
			"mcp_server_do_thing",
			"mcp_server_do_thing_2",
		]);
		expect(request.messages[0].content[0].toolUse.name).toBe("mcp_server_do_thing");
	});

	it("skips unknown user content blocks instead of throwing", async () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "hello" },
					{ type: "unknown", data: "foo" },
				] as unknown as UserMessage["content"],
				timestamp: Date.now(),
			},
		];
		const payload = await capturePayload({ messages });
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(1);
		expect(p.messages[0].content).toHaveLength(1);
		expect(p.messages[0].content[0]).toEqual({ text: "hello" });
	});

	it("skips unknown assistant content blocks instead of throwing", async () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "hello" },
					{ type: "unknown", data: "foo" },
				] as unknown as AssistantMessage["content"],
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				model: baseModel.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];
		const payload = await capturePayload({ messages });
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(1);
		expect(p.messages[0].content).toHaveLength(1);
		expect(p.messages[0].content[0]).toEqual({ text: "hello" });
	});

	it("skips empty user text blocks", async () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "   " },
					{ type: "text", text: "hello" },
				],
				timestamp: Date.now(),
			},
		];
		const payload = await capturePayload({ messages });
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(1);
		expect(p.messages[0].content).toEqual([{ text: "hello" }]);
	});

	it("replaces user messages with only empty text blocks with a placeholder", async () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: "   " }],
				timestamp: Date.now(),
			},
		];
		const payload = await capturePayload({ messages });
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(1);
		expect(p.messages[0].content).toEqual([{ text: "<empty>" }]);
	});

	it("replaces user messages with only unknown content blocks with a placeholder", async () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "unknown", data: "foo" }] as unknown as UserMessage["content"],
				timestamp: Date.now(),
			},
		];
		const payload = await capturePayload({ messages });
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(1);
		expect(p.messages[0].content).toEqual([{ text: "<empty>" }]);
	});

	it("replaces blank user string content with a placeholder", async () => {
		const payload = await capturePayload({
			messages: [{ role: "user", content: "   ", timestamp: Date.now() }],
		});
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(1);
		expect(p.messages[0].content).toEqual([{ text: "<empty>" }]);
	});

	it("replaces user content emptied by surrogate sanitization with a placeholder", async () => {
		const payload = await capturePayload({
			messages: [{ role: "user", content: String.fromCharCode(0xd83d), timestamp: Date.now() }],
		});
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(1);
		expect(p.messages[0].content).toEqual([{ text: "<empty>" }]);
	});

	it("skips assistant text blocks emptied by surrogate sanitization", async () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [{ type: "text", text: String.fromCharCode(0xd83d) }],
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				model: baseModel.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];
		const payload = await capturePayload({ messages });
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(0);
	});

	it("replaces blank tool result content with a placeholder", async () => {
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "tool",
				content: [{ type: "text", text: "" }],
				isError: false,
				timestamp: Date.now(),
			},
		];
		const payload = await capturePayload({ messages });
		expect(payload).toBeDefined();
		const p = payload as {
			messages: Array<{ role: string; content: Array<{ toolResult: { content: unknown[] } }> }>;
		};
		expect(p.messages).toHaveLength(1);
		expect(p.messages[0].content[0].toolResult.content).toEqual([{ text: "<empty>" }]);
	});

	it("skips assistant messages with only unknown content blocks", async () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [{ type: "unknown", data: "foo" }] as unknown as AssistantMessage["content"],
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				model: baseModel.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];
		const payload = await capturePayload({ messages });
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(0);
	});
});
