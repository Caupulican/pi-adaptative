import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICompletions } from "../src/providers/openai-completions.ts";
import type { Context, Model } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	requestOptions: [] as unknown[],
	failuresRemaining: 0,
	failureHeaders: { "retry-after-ms": "0" } as Record<string, string>,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (_params: unknown, options: unknown) => {
					mockState.requestOptions.push(options);
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								id: "chatcmpl-test",
								choices: [{ index: 0, delta: { content: "ok" } }],
							};
							yield {
								id: "chatcmpl-test",
								choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => {
						if (mockState.failuresRemaining > 0) {
							mockState.failuresRemaining--;
							throw Object.assign(new Error("retry"), {
								status: 429,
								headers: new Headers(mockState.failureHeaders),
							});
						}
						return {
							data: stream,
							response: { status: 200, headers: new Headers() },
						};
					};
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

const model: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "opencode-go",
	baseUrl: "https://opencode.ai/zen/go/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

const context: Context = {
	systemPrompt: "",
	messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
	tools: [],
};

async function consume(options?: { maxRetries?: number }) {
	const stream = streamOpenAICompletions(model, context, { apiKey: "test", ...options });
	for await (const _event of stream) {
		void _event;
	}
	return stream.result();
}

describe("openai-completions provider retries", () => {
	beforeEach(() => {
		mockState.requestOptions = [];
		mockState.failuresRemaining = 0;
		mockState.failureHeaders = { "retry-after-ms": "0" };
	});

	it("disables SDK retries by default", async () => {
		await consume();
		expect(mockState.requestOptions).toEqual([expect.objectContaining({ maxRetries: 0 })]);
	});

	it("retries outside the SDK while keeping every SDK request retry-free", async () => {
		mockState.failuresRemaining = 1;
		await consume({ maxRetries: 2 });
		expect(mockState.requestOptions).toHaveLength(2);
		expect(mockState.requestOptions).toEqual([
			expect.objectContaining({ maxRetries: 0 }),
			expect.objectContaining({ maxRetries: 0 }),
		]);
	});

	it("preserves final Retry-After guidance for every downstream retry owner", async () => {
		mockState.failuresRemaining = 1;
		mockState.failureHeaders = { "retry-after": "19.542" };

		const result = await consume();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Provider retry directive: retry after 19.542s.");
	});

	it("fails closed instead of shortening a Retry-After above the configured bound", async () => {
		mockState.failuresRemaining = 1;
		mockState.failureHeaders = { "retry-after": "79.542" };

		const result = await consume();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Server requested 79.542s retry delay (max: 60s).");
		expect(result.errorMessage).toContain("Provider retry directive: do not retry.");
	});

	it("preserves an explicit provider no-retry directive", async () => {
		mockState.failuresRemaining = 1;
		mockState.failureHeaders = { "x-should-retry": "false" };

		const result = await consume();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Provider retry directive: do not retry.");
	});

	it("does not invent retry guidance when the provider sends none", async () => {
		mockState.failuresRemaining = 1;
		mockState.failureHeaders = {};

		const result = await consume();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).not.toContain("Provider retry directive:");
	});
});
