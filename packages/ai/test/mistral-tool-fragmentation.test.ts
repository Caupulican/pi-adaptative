import type { CompletionEvent } from "@mistralai/mistralai/models/components";
import { describe, expect, it } from "vitest";
import { consumeChatStream } from "../src/providers/mistral.ts";
import { createAssistantMessage } from "../src/providers/provider-runtime.ts";
import type { Model, ToolCall } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { createToolNameMap } from "../src/utils/tool-names.ts";

const mockModel: Model<"mistral-conversations"> = {
	id: "mistral-small-latest",
	name: "Mistral Small",
	provider: "mistral",
	api: "mistral-conversations",
	baseUrl: "https://api.mistral.ai/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8192,
};

async function* makeEvents(chunks: any[]): AsyncIterable<CompletionEvent> {
	for (const data of chunks) {
		yield { data } as CompletionEvent;
	}
}

describe("Mistral tool-call stream fragmentation (F10)", () => {
	it("stitches continuation chunks that omit id onto the open tool call", async () => {
		const output = createAssistantMessage(mockModel);
		const stream = new AssistantMessageEventStream();

		// First chunk has id "call_123" and partial args; continuation has index 0 but NO id and NO function.name
		const chunks = [
			{
				id: "resp-1",
				choices: [
					{
						delta: {
							toolCalls: [
								{
									id: "call_123",
									index: 0,
									function: { name: "edit_file", arguments: '{"path":' },
								},
							],
						},
					},
				],
			},
			{
				id: "resp-1",
				choices: [
					{
						delta: {
							toolCalls: [
								{
									index: 0,
									function: { arguments: '"foo.ts"}' },
								},
							],
						},
					},
				],
			},
		];

		await consumeChatStream(mockModel, output, stream, makeEvents(chunks), createToolNameMap([]));

		expect(output.content).toHaveLength(1);
		const toolCall = output.content[0] as ToolCall;
		expect(toolCall.type).toBe("toolCall");
		expect(toolCall.id).toBe("call_123");
		expect(toolCall.name).toBe("edit_file");
		expect(toolCall.arguments).toEqual({ path: "foo.ts" });
	});

	it("stitches index 0 tool call without creating empty duplicate blocks", async () => {
		const output = createAssistantMessage(mockModel);
		const stream = new AssistantMessageEventStream();

		const chunks = [
			{
				id: "resp-2",
				choices: [
					{
						delta: {
							toolCalls: [
								{
									id: "call_idx0",
									index: 0,
									function: { name: "read_file", arguments: '{"path":' },
								},
							],
						},
					},
				],
			},
			{
				id: "resp-2",
				choices: [
					{
						delta: {
							toolCalls: [
								{
									index: 0,
									function: { arguments: '"bar.ts"}' },
								},
							],
						},
					},
				],
			},
		];

		await consumeChatStream(mockModel, output, stream, makeEvents(chunks), createToolNameMap([]));

		expect(output.content).toHaveLength(1);
		expect(output.content[0]).toMatchObject({
			type: "toolCall",
			id: "call_idx0",
			name: "read_file",
			arguments: { path: "bar.ts" },
		});
	});

	it("keeps tool calls with distinct indexes separate (negative control)", async () => {
		const output = createAssistantMessage(mockModel);
		const stream = new AssistantMessageEventStream();

		const chunks = [
			{
				id: "resp-3",
				choices: [
					{
						delta: {
							toolCalls: [
								{
									id: "call_0",
									index: 0,
									function: { name: "tool_a", arguments: '{"a":1}' },
								},
								{
									id: "call_1",
									index: 1,
									function: { name: "tool_b", arguments: '{"b":2}' },
								},
							],
						},
					},
				],
			},
		];

		await consumeChatStream(mockModel, output, stream, makeEvents(chunks), createToolNameMap([]));

		expect(output.content).toHaveLength(2);
		expect(output.content[0]).toMatchObject({
			type: "toolCall",
			id: "call_0",
			name: "tool_a",
			arguments: { a: 1 },
		});
		expect(output.content[1]).toMatchObject({
			type: "toolCall",
			id: "call_1",
			name: "tool_b",
			arguments: { b: 2 },
		});
	});

	it("derives consistent callId when all chunks omit id", async () => {
		const output = createAssistantMessage(mockModel);
		const stream = new AssistantMessageEventStream();

		const chunks = [
			{
				id: "resp-4",
				choices: [
					{
						delta: {
							toolCalls: [
								{
									index: 0,
									function: { name: "tool_c", arguments: '{"val":1}' },
								},
							],
						},
					},
				],
			},
		];

		await consumeChatStream(mockModel, output, stream, makeEvents(chunks), createToolNameMap([]));

		expect(output.content).toHaveLength(1);
		const block = output.content[0] as ToolCall;
		expect(block.type).toBe("toolCall");
		expect(block.name).toBe("tool_c");
		expect(block.id).toBeDefined();
		expect(block.arguments).toEqual({ val: 1 });
	});
});
