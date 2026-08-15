import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { processResponsesStream } from "../src/providers/openai-responses-shared.ts";
import { completeAssistantStream } from "../src/providers/provider-runtime.ts";
import type { AssistantMessage, AssistantMessageEvent, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function createModel(): Model<"openai-responses"> {
	return {
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

function createFuguUltraModel(): Model<"openai-responses"> {
	return {
		...createModel(),
		id: "fugu-ultra",
		name: "Fugu Ultra",
		provider: "fugu",
		baseUrl: "https://api.sakana.ai/v1",
		cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 10_000,
	};
}

function createOutput(model: Model<"openai-responses">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
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
		timestamp: Date.now(),
	};
}

async function* createEarlyEofEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.created",
		response: { id: "resp_early_eof" },
	} as ResponseStreamEvent;
}

async function* createCompletedEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.completed",
		response: {
			id: "resp_completed",
			status: "completed",
			usage: {
				input_tokens: 20,
				output_tokens: 7,
				total_tokens: 27,
				input_tokens_details: { cached_tokens: 2 },
			},
		},
	} as ResponseStreamEvent;
}

async function* createCompletedEventsWithOrchestrationUsage(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.completed",
		response: {
			id: "resp_completed_with_orchestration",
			status: "completed",
			usage: {
				input_tokens: 20,
				output_tokens: 7,
				total_tokens: 66,
				input_tokens_details: {
					cached_tokens: 2,
					orchestration_input_tokens: 30,
					orchestration_input_cached_tokens: 3,
				},
				output_tokens_details: {
					orchestration_output_tokens: 6,
				},
			},
		},
	} as unknown as ResponseStreamEvent;
}

async function* createHighContextFuguUltraEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.completed",
		response: {
			id: "resp_high_context_fugu_ultra",
			status: "completed",
			usage: {
				input_tokens: 300_000,
				output_tokens: 1_000,
				total_tokens: 301_000,
				input_tokens_details: { cached_tokens: 100_000 },
			},
		},
	} as unknown as ResponseStreamEvent;
}

async function* createIncompleteEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.incomplete",
		response: {
			id: "resp_incomplete",
			status: "incomplete",
			usage: {
				input_tokens: 30,
				output_tokens: 12,
				total_tokens: 42,
				input_tokens_details: { cached_tokens: 5 },
			},
		},
	} as ResponseStreamEvent;
}

async function* createOutputTextDeltasWithoutContentPartEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.output_item.added",
		item: { id: "msg_text", type: "message", role: "assistant", status: "in_progress", content: [] },
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_text.delta",
		item_id: "msg_text",
		content_index: 0,
		delta: "Hello",
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_text.delta",
		item_id: "msg_text",
		content_index: 0,
		delta: " world",
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		item: {
			id: "msg_text",
			type: "message",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "Hello world", annotations: [] }],
		},
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.completed",
		response: { id: "resp_text", status: "completed" },
	} as unknown as ResponseStreamEvent;
}

async function* createRefusalDeltasWithoutContentPartEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.output_item.added",
		item: { id: "msg_refusal", type: "message", role: "assistant", status: "in_progress", content: [] },
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.refusal.delta",
		item_id: "msg_refusal",
		content_index: 0,
		delta: "No",
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.refusal.delta",
		item_id: "msg_refusal",
		content_index: 0,
		delta: " thanks",
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		item: {
			id: "msg_refusal",
			type: "message",
			role: "assistant",
			status: "completed",
			content: [{ type: "refusal", refusal: "No thanks" }],
		},
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.completed",
		response: { id: "resp_refusal", status: "completed" },
	} as unknown as ResponseStreamEvent;
}

async function* createCapturedReasoningSummaryDelimiterEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.output_item.added",
		item: { id: "rs_captured", type: "reasoning", summary: [], content: [] },
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.reasoning_summary_part.added",
		item_id: "rs_captured",
		part: { type: "summary_text", text: "" },
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.reasoning_summary_text.delta",
		item_id: "rs_captured",
		delta: "<!-- -->",
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.reasoning_summary_part.done",
		item_id: "rs_captured",
		part: { type: "summary_text", text: "<!-- -->" },
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.reasoning_summary_part.added",
		item_id: "rs_captured",
		part: { type: "summary_text", text: "" },
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.reasoning_summary_text.delta",
		item_id: "rs_captured",
		delta: "Checking the repository state.",
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.reasoning_summary_part.done",
		item_id: "rs_captured",
		part: { type: "summary_text", text: "Checking the repository state." },
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		item: {
			id: "rs_captured",
			type: "reasoning",
			summary: [
				{ type: "summary_text", text: "<!-- -->" },
				{ type: "summary_text", text: "Checking the repository state." },
			],
			content: [],
		},
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.completed",
		response: { id: "resp_reasoning_summary", status: "completed" },
	} as unknown as ResponseStreamEvent;
}

async function* createCompletedOnlyMessageEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.completed",
		response: {
			id: "resp_completed_only",
			status: "completed",
			usage: {
				input_tokens: 8,
				output_tokens: 4,
				total_tokens: 12,
				input_tokens_details: { cached_tokens: 0 },
			},
			output: [
				{
					id: "msg_fast",
					type: "message",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "hello from a fast response", annotations: [] }],
				},
			],
		},
	} as unknown as ResponseStreamEvent;
}

async function* createCompletedThenIteratorAbortEvents(): AsyncIterable<ResponseStreamEvent> {
	yield* createCompletedOnlyMessageEvents();
	throw new Error("Request was aborted");
}

async function* createCompletedOnlyFunctionCallEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.completed",
		response: {
			id: "resp_completed_only_tool",
			status: "completed",
			output: [
				{
					type: "function_call",
					id: "fc_fast",
					call_id: "call_fast",
					name: "read",
					arguments: '{"path":"README.md"}',
				},
			],
		},
	} as unknown as ResponseStreamEvent;
}

async function* createDoneWithoutAddedEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.output_item.done",
		item: {
			id: "msg_done",
			type: "message",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "done without added", annotations: [] }],
		},
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		item: {
			type: "function_call",
			id: "fc_done",
			call_id: "call_done",
			name: "bash",
			arguments: '{"command":"pwd"}',
		},
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.completed",
		response: { id: "resp_done_without_added", status: "completed" },
	} as unknown as ResponseStreamEvent;
}

async function* createFunctionCallAddedThenMessageThenFunctionCallDoneEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.output_item.added",
		item: {
			type: "function_call",
			id: "fc_xai",
			call_id: "call_xai",
			name: "python",
			arguments: "",
		},
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.function_call_arguments.delta",
		item_id: "fc_xai",
		delta: '{"code":"print(1)"}',
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_item.added",
		item: { id: "msg_after", type: "message", role: "assistant", status: "in_progress", content: [] },
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_text.delta",
		item_id: "msg_after",
		content_index: 0,
		delta: "Running the extractor.",
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		item: {
			id: "msg_after",
			type: "message",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "Running the extractor.", annotations: [] }],
		},
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		item: {
			type: "function_call",
			id: "fc_xai",
			call_id: "call_xai",
			name: "python",
			arguments: '{"code":"print(1)"}',
		},
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.completed",
		response: {
			id: "resp_xai_tool_interleaved",
			status: "completed",
			output: [
				{
					type: "function_call",
					id: "fc_xai",
					call_id: "call_xai",
					name: "python",
					arguments: '{"code":"print(1)"}',
				},
				{
					id: "msg_after",
					type: "message",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Running the extractor.", annotations: [] }],
				},
			],
		},
	} as unknown as ResponseStreamEvent;
}

async function* createMessageAddedThenFunctionCallThenMessageDoneEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.output_item.added",
		item: { id: "msg_xai", type: "message", role: "assistant", status: "in_progress", content: [] },
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_text.delta",
		item_id: "msg_xai",
		content_index: 0,
		delta: "Checking Claude project sessions for that UUID.",
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_item.added",
		item: {
			type: "function_call",
			id: "fc_xai",
			call_id: "call_xai",
			name: "bash",
			arguments: "",
		},
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.function_call_arguments.delta",
		item_id: "fc_xai",
		delta: '{"command":"ls"}',
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		item: {
			type: "function_call",
			id: "fc_xai",
			call_id: "call_xai",
			name: "bash",
			arguments: '{"command":"ls"}',
		},
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		item: {
			id: "msg_xai",
			type: "message",
			role: "assistant",
			status: "completed",
			content: [
				{
					type: "output_text",
					text: "Checking Claude project sessions for that UUID.",
					annotations: [],
				},
			],
		},
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.completed",
		response: {
			id: "resp_xai_interleaved",
			status: "completed",
			output: [
				{
					id: "msg_xai",
					type: "message",
					role: "assistant",
					status: "completed",
					content: [
						{
							type: "output_text",
							text: "Checking Claude project sessions for that UUID.",
							annotations: [],
						},
					],
				},
				{
					type: "function_call",
					id: "fc_xai",
					call_id: "call_xai",
					name: "bash",
					arguments: '{"command":"ls"}',
				},
			],
		},
	} as unknown as ResponseStreamEvent;
}

async function* createOutputTextDeltasWithTerminalOutputEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.output_item.added",
		item: { id: "msg_text", type: "message", role: "assistant", status: "in_progress", content: [] },
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_text.delta",
		item_id: "msg_text",
		content_index: 0,
		delta: "Hello",
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_text.delta",
		item_id: "msg_text",
		content_index: 0,
		delta: " world",
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		item: {
			id: "msg_text",
			type: "message",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "Hello world", annotations: [] }],
		},
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.completed",
		response: {
			id: "resp_text",
			status: "completed",
			output: [
				{
					id: "msg_text",
					type: "message",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello world", annotations: [] }],
				},
			],
		},
	} as unknown as ResponseStreamEvent;
}

async function* createTerminalReasoningSignatureEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.output_item.added",
		item: { id: "rs_terminal", type: "reasoning", summary: [], content: [] },
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		item: { id: "rs_terminal", type: "reasoning", summary: [], content: [] },
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.completed",
		response: {
			id: "resp_terminal_reasoning",
			status: "completed",
			output: [
				{
					id: "rs_terminal",
					type: "reasoning",
					summary: [],
					content: [],
					encrypted_content: "encrypted-terminal-reasoning",
				},
			],
		},
	} as unknown as ResponseStreamEvent;
}

describe("OpenAI Responses terminal events", () => {
	it("rejects streams that end before a terminal response event", async () => {
		const model = createModel();

		await expect(
			processResponsesStream(createEarlyEofEvents(), createOutput(model), new AssistantMessageEventStream(), model),
		).rejects.toThrow("OpenAI Responses stream ended before a terminal response event");
	});

	it("accepts completed terminal events and records usage", async () => {
		const model = createModel();
		const output = createOutput(model);

		await processResponsesStream(createCompletedEvents(), output, new AssistantMessageEventStream(), model);

		expect(output.responseId).toBe("resp_completed");
		expect(output.stopReason).toBe("stop");
		expect(output.usage.input).toBe(18);
		expect(output.usage.cacheRead).toBe(2);
		expect(output.usage.output).toBe(7);
	});

	it("categorizes Sakana Fugu Ultra orchestration tokens without double-counting the provider total", async () => {
		const model = createFuguUltraModel();
		const output = createOutput(model);

		await processResponsesStream(
			createCompletedEventsWithOrchestrationUsage(),
			output,
			new AssistantMessageEventStream(),
			model,
		);

		expect(output.responseId).toBe("resp_completed_with_orchestration");
		expect(output.usage.input).toBe(48);
		expect(output.usage.cacheRead).toBe(5);
		expect(output.usage.output).toBe(13);
		expect(output.usage.totalTokens).toBe(66);
		expect(output.usage.cost.input).toBeCloseTo(0.00024);
		expect(output.usage.cost.cacheRead).toBeCloseTo(0.0000025);
		expect(output.usage.cost.output).toBeCloseTo(0.00039);
	});

	it("applies the high-context Sakana Fugu Ultra pricing tier", async () => {
		const model = createFuguUltraModel();
		const output = createOutput(model);

		await processResponsesStream(
			createHighContextFuguUltraEvents(),
			output,
			new AssistantMessageEventStream(),
			model,
		);

		expect(output.responseId).toBe("resp_high_context_fugu_ultra");
		expect(output.usage.input).toBe(200_000);
		expect(output.usage.cacheRead).toBe(100_000);
		expect(output.usage.output).toBe(1_000);
		expect(output.usage.cost.input).toBeCloseTo(2);
		expect(output.usage.cost.cacheRead).toBeCloseTo(0.1);
		expect(output.usage.cost.output).toBeCloseTo(0.045);
	});

	it("accepts incomplete terminal events as length stops", async () => {
		const model = createModel();
		const output = createOutput(model);

		await processResponsesStream(createIncompleteEvents(), output, new AssistantMessageEventStream(), model);

		expect(output.responseId).toBe("resp_incomplete");
		expect(output.stopReason).toBe("length");
		expect(output.usage.input).toBe(25);
		expect(output.usage.cacheRead).toBe(5);
		expect(output.usage.output).toBe(12);
	});

	it("emits output text deltas even when content_part.added is absent", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		await processResponsesStream(createOutputTextDeltasWithoutContentPartEvents(), output, stream, model);
		stream.end(output);

		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		expect(events.flatMap((event) => (event.type === "text_delta" ? [event.delta] : []))).toEqual([
			"Hello",
			" world",
		]);
		expect(output.content).toHaveLength(1);
		expect(output.content[0]).toMatchObject({ type: "text", text: "Hello world" });
	});

	it("emits refusal deltas even when content_part.added is absent", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		await processResponsesStream(createRefusalDeltasWithoutContentPartEvents(), output, stream, model);
		stream.end(output);

		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		expect(events.flatMap((event) => (event.type === "text_delta" ? [event.delta] : []))).toEqual(["No", " thanks"]);
		expect(output.content).toHaveLength(1);
		expect(output.content[0]).toMatchObject({ type: "text", text: "No thanks" });
	});

	it("filters delimiter-only reasoning summary parts before they become thinking content", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		await processResponsesStream(createCapturedReasoningSummaryDelimiterEvents(), output, stream, model);
		stream.end(output);

		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const thinkingDeltas = events.flatMap((event) => (event.type === "thinking_delta" ? [event.delta] : []));
		expect(thinkingDeltas.join("")).toBe("Checking the repository state.\n\n");
		expect(thinkingDeltas.join("")).not.toContain("<!-- -->");
		expect(output.content).toHaveLength(1);
		expect(output.content[0]).toMatchObject({ type: "thinking", thinking: "Checking the repository state." });
	});

	it("backfills terminal encrypted reasoning into the persisted thinking signature", async () => {
		const model = createModel();
		const output = createOutput(model);

		await processResponsesStream(
			createTerminalReasoningSignatureEvents(),
			output,
			new AssistantMessageEventStream(),
			model,
		);

		const thinking = output.content.find((block) => block.type === "thinking");
		expect(thinking?.thinkingSignature).toBeDefined();
		expect(JSON.parse(thinking?.thinkingSignature ?? "{}")).toMatchObject({
			id: "rs_terminal",
			encrypted_content: "encrypted-terminal-reasoning",
		});
	});

	it("materializes assistant text from a completed-only response.output payload", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		await processResponsesStream(createCompletedOnlyMessageEvents(), output, stream, model);

		expect(output.content).toHaveLength(1);
		expect(output.content[0]).toMatchObject({ type: "text", text: "hello from a fast response" });
		expect(output.stopReason).toBe("stop");
		expect(output.responseId).toBe("resp_completed_only");
	});

	it("materializes a tool call from a completed-only response.output payload", async () => {
		const model = createModel();
		const output = createOutput(model);

		await processResponsesStream(
			createCompletedOnlyFunctionCallEvents(),
			output,
			new AssistantMessageEventStream(),
			model,
		);

		expect(output.content).toHaveLength(1);
		expect(output.content[0]).toMatchObject({
			type: "toolCall",
			id: "call_fast|fc_fast",
			name: "read",
			arguments: { path: "README.md" },
		});
		expect(output.stopReason).toBe("toolUse");
	});

	it("applies output_item.done message and function_call items when added/delta events were skipped", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		await processResponsesStream(createDoneWithoutAddedEvents(), output, stream, model);

		expect(output.content).toEqual([
			expect.objectContaining({ type: "text", text: "done without added" }),
			expect.objectContaining({
				type: "toolCall",
				id: "call_done|fc_done",
				name: "bash",
				arguments: { command: "pwd" },
			}),
		]);
		expect(output.content[1]).not.toHaveProperty("partialJson");
		expect(output.stopReason).toBe("toolUse");
	});

	it("keeps a completed-only payload when abort races the terminal push", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();
		const controller = new AbortController();

		await processResponsesStream(createCompletedOnlyMessageEvents(), output, stream, model);
		controller.abort();
		completeAssistantStream(stream, output, controller.signal);

		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
		expect(result.content[0]).toMatchObject({ type: "text", text: "hello from a fast response" });
	});

	it("keeps a completed-only payload when the iterator throws abort after the terminal event", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		await processResponsesStream(createCompletedThenIteratorAbortEvents(), output, stream, model);
		completeAssistantStream(stream, output);

		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
		expect(result.content[0]).toMatchObject({ type: "text", text: "hello from a fast response" });
	});

	it("does not duplicate blocks when incremental events already materialized response.output", async () => {
		const model = createModel();
		const output = createOutput(model);

		await processResponsesStream(
			createOutputTextDeltasWithTerminalOutputEvents(),
			output,
			new AssistantMessageEventStream(),
			model,
		);

		expect(output.content).toHaveLength(1);
		expect(output.content[0]).toMatchObject({ type: "text", text: "Hello world" });
	});

	it("reuses the added function-call block when another item arrives before function_call.done", async () => {
		const model = createModel();
		const output = createOutput(model);

		await processResponsesStream(
			createFunctionCallAddedThenMessageThenFunctionCallDoneEvents(),
			output,
			new AssistantMessageEventStream(),
			model,
		);

		expect(output.content.filter((block) => block.type === "toolCall")).toHaveLength(1);
		expect(output.content).toEqual([
			expect.objectContaining({
				type: "toolCall",
				id: "call_xai|fc_xai",
				name: "python",
			}),
			expect.objectContaining({
				type: "text",
				text: "Running the extractor.",
			}),
		]);
		expect(output.stopReason).toBe("toolUse");
	});

	it("reuses the added message block when function calls arrive before message.done", async () => {
		const model = createModel();
		const output = createOutput(model);

		await processResponsesStream(
			createMessageAddedThenFunctionCallThenMessageDoneEvents(),
			output,
			new AssistantMessageEventStream(),
			model,
		);

		expect(output.content).toEqual([
			expect.objectContaining({
				type: "text",
				text: "Checking Claude project sessions for that UUID.",
			}),
			expect.objectContaining({
				type: "toolCall",
				id: "call_xai|fc_xai",
				name: "bash",
			}),
		]);
		expect(output.content.filter((block) => block.type === "text")).toHaveLength(1);
		expect(output.stopReason).toBe("toolUse");
	});
});
