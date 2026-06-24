import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { processResponsesStream } from "../src/providers/openai-responses-shared.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
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

	it("includes Sakana Fugu Ultra orchestration tokens in usage and cost", async () => {
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
});
