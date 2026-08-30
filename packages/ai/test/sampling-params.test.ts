import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/stream.ts";
import type { Context, Model } from "../src/types.ts";

// buildParams (openai-completions.ts) is what actually merges samplingParams and routes the
// thinking-budget compat field into the request body, so the payload must be captured from a real
// streamOpenAICompletions() call — a fake "faux" provider stream never builds an OpenAI-shaped body.
// Mocking the openai SDK client (as the sibling openai-completions-*.test.ts files do) keeps this
// deterministic and network-free while still exercising the real code path.
const mockState = vi.hoisted(() => ({ lastParams: undefined as unknown }));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
							};
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

describe("P2a: samplingParams and thinkingTokenBudgetField", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("merges samplingParams after named fields in openai-completions requests", async () => {
		const model: Model<"openai-completions"> = {
			id: "test-model",
			name: "Test Model",
			api: "openai-completions",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
			samplingParams: {
				top_p: 0.85,
				min_p: 0.05,
				repetition_penalty: 1.1,
			},
		};

		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		};

		let capturedBody: any;
		await streamSimple(model, context, {
			apiKey: "test-key",
			onPayload: (payload) => {
				capturedBody = payload;
				return payload;
			},
		}).result();

		const params = (capturedBody ?? mockState.lastParams) as {
			top_p?: number;
			min_p?: number;
			repetition_penalty?: number;
		};
		expect(params).toBeDefined();
		expect(params.top_p).toBe(0.85);
		expect(params.min_p).toBe(0.05);
		expect(params.repetition_penalty).toBe(1.1);
	});

	it("routes the thinking budget to the compat-specified field name when thinkingTokenBudgetField is set", async () => {
		const model: Model<"openai-completions"> = {
			id: "qwen-model",
			name: "Qwen Model",
			api: "openai-completions",
			provider: "openai",
			baseUrl: "http://localhost:8000/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32768,
			maxTokens: 4096,
			compat: {
				thinkingTokenBudgetField: "thinking_token_budget",
			},
			thinkingBudgets: {
				medium: 2048,
			},
		};

		const context: Context = {
			messages: [{ role: "user", content: "think deeply", timestamp: Date.now() }],
		};

		let capturedBody: any;
		await streamSimple(model, context, {
			apiKey: "test-key",
			reasoning: "medium",
			onPayload: (payload) => {
				capturedBody = payload;
				return payload;
			},
		}).result();

		const params = (capturedBody ?? mockState.lastParams) as { thinking_token_budget?: number };
		expect(params).toBeDefined();
		// Clamped to leave at least 1024 tokens for the answer: 4096 - 1024 = 3072, requested is 2048.
		expect(params.thinking_token_budget).toBe(2048);
	});

	it("omits the budget field entirely when thinkingBudgets has no entry for the active reasoning level", async () => {
		const model: Model<"openai-completions"> = {
			id: "qwen-model-no-budget",
			name: "Qwen Model",
			api: "openai-completions",
			provider: "openai",
			baseUrl: "http://localhost:8000/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32768,
			maxTokens: 4096,
			compat: {
				thinkingTokenBudgetField: "thinking_token_budget",
			},
			// No "medium" entry: the active reasoning level below has nothing configured for it.
			thinkingBudgets: {
				high: 8192,
			},
		};

		const context: Context = {
			messages: [{ role: "user", content: "think deeply", timestamp: Date.now() }],
		};

		let capturedBody: any;
		await streamSimple(model, context, {
			apiKey: "test-key",
			reasoning: "medium",
			onPayload: (payload) => {
				capturedBody = payload;
				return payload;
			},
		}).result();

		const params = (capturedBody ?? mockState.lastParams) as Record<string, unknown>;
		expect(params).toBeDefined();
		expect("thinking_token_budget" in params).toBe(false);
	});
});
