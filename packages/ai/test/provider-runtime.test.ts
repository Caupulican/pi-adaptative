import { afterEach, describe, expect, it, vi } from "vitest";
import {
	applyProviderPayloadHook,
	beginAssistantResponseStream,
	buildClampedSimpleOptions,
	completeAssistantStream,
	createAssistantMessage,
	createProviderRetryOptions,
	createRetryFreeRequestOptions,
	finishTextOrThinkingBlock,
	mapStandardThinkingEffort,
	resolveCacheRetention,
	terminateAssistantStreamWithError,
} from "../src/providers/provider-runtime.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const model: Model<"openai-responses"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-responses",
	provider: "test-provider",
	baseUrl: "https://example.test/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

describe("provider runtime", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("creates independent zero-state assistant messages", () => {
		const first = createAssistantMessage(model);
		const second = createAssistantMessage(model, { stopReason: "error", errorMessage: "load failed" });

		first.usage.input = 9;
		expect(first).toMatchObject({
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
		});
		expect(second).toMatchObject({ stopReason: "error", errorMessage: "load failed" });
		expect(second.usage.input).toBe(0);
		expect(second.content).not.toBe(first.content);
	});

	it("resolves explicit cache retention before the environment default", () => {
		vi.stubEnv("PI_CACHE_RETENTION", "long");
		expect(resolveCacheRetention(undefined)).toBe("long");
		expect(resolveCacheRetention("none")).toBe("none");
		vi.stubEnv("PI_CACHE_RETENTION", "invalid");
		expect(resolveCacheRetention(undefined)).toBe("short");
	});

	it("passes a large payload through without reading or rebuilding it", async () => {
		let contentReads = 0;
		const payload = Object.defineProperty({}, "content", {
			enumerable: true,
			get: () => {
				contentReads++;
				return "x".repeat(8 * 1024 * 1024);
			},
		});

		const result = await applyProviderPayloadHook(payload, model, undefined);

		expect(result).toBe(payload);
		expect(contentReads).toBe(0);
	});

	it("keeps SDK retries disabled while preserving caller retry policy", () => {
		const controller = new AbortController();
		expect(createRetryFreeRequestOptions({ signal: controller.signal, timeoutMs: 123 })).toEqual({
			signal: controller.signal,
			timeout: 123,
			maxRetries: 0,
		});
		expect(createProviderRetryOptions({ signal: controller.signal, maxRetries: 7, maxRetryDelayMs: 456 }, 3)).toEqual(
			{ signal: controller.signal, maxRetries: 7, maxRetryDelayMs: 456 },
		);
	});

	it("emits exactly one successful terminal event", async () => {
		const output = createAssistantMessage(model);
		const stream = new AssistantMessageEventStream();

		completeAssistantStream(stream, output);

		expect(await stream.result()).toBe(output);
		const events = [];
		for await (const event of stream) events.push(event);
		expect(events).toEqual([{ type: "done", reason: "stop", message: output }]);
	});

	it("reports response metadata before starting the assistant stream", async () => {
		const output = createAssistantMessage(model);
		const stream = new AssistantMessageEventStream();
		const observed: string[] = [];
		await beginAssistantResponseStream(
			stream,
			output,
			{ status: 201, headers: new Headers({ "x-request-id": "request-1" }) },
			model,
			(response, observedModel) => {
				observed.push(`${response.status}:${response.headers["x-request-id"]}:${observedModel.id}`);
			},
		);
		stream.end(output);

		expect(observed).toEqual(["201:request-1:test-model"]);
		const events = [];
		for await (const event of stream) events.push(event);
		expect(events).toEqual([{ type: "start", partial: output }]);
	});

	it("fails closed on aborted completion and strips streaming scratch fields on errors", async () => {
		const aborted = createAssistantMessage(model);
		const controller = new AbortController();
		controller.abort();
		expect(() => completeAssistantStream(new AssistantMessageEventStream(), aborted, controller.signal)).toThrow(
			"Request was aborted",
		);

		const output = createAssistantMessage(model);
		output.content.push({
			type: "toolCall",
			id: "call-1",
			name: "read",
			arguments: {},
			partialJson: "{",
			index: 2,
		} as AssistantMessage["content"][number] & { partialJson: string; index: number });
		const stream = new AssistantMessageEventStream();
		terminateAssistantStreamWithError(stream, output, undefined, new Error("boom"), {
			formatError: (error) => (error instanceof Error ? error.message : String(error)),
			scratchFields: ["index", "partialJson"],
		});

		const result = await stream.result();
		expect(result).toBe(output);
		expect(result).toMatchObject({ stopReason: "error", errorMessage: "boom" });
		expect(result.content[0]).not.toHaveProperty("index");
		expect(result.content[0]).not.toHaveProperty("partialJson");
	});

	it("finishes text and thinking blocks through one event owner", async () => {
		const output = createAssistantMessage(model);
		const stream = new AssistantMessageEventStream();
		const text = { type: "text" as const, text: "answer" };
		const thinking = { type: "thinking" as const, thinking: "reason" };
		output.content.push(text, thinking);

		finishTextOrThinkingBlock(stream, output, text, 0);
		finishTextOrThinkingBlock(stream, output, thinking, 1);
		stream.end(output);

		const events = [];
		for await (const event of stream) events.push(event);
		expect(events).toEqual([
			{ type: "text_end", contentIndex: 0, content: "answer", partial: output },
			{ type: "thinking_end", contentIndex: 1, content: "reason", partial: output },
		]);
	});

	it("maps standard thinking levels and respects provider overrides", () => {
		expect(mapStandardThinkingEffort(model, "minimal")).toBe("low");
		expect(mapStandardThinkingEffort(model, "medium")).toBe("medium");
		expect(mapStandardThinkingEffort(model, undefined)).toBe("high");
		expect(mapStandardThinkingEffort({ ...model, thinkingLevelMap: { high: "max" } }, "high")).toBe("max");
	});

	it("builds provider-neutral simple options with one API-key and reasoning policy", () => {
		const result = buildClampedSimpleOptions(model, { apiKey: "test-key", reasoning: "ultra", maxTokens: 77 });
		expect(result.base).toMatchObject({ apiKey: "test-key", maxTokens: 77 });
		expect(result.clampedReasoning).toBe("high");
		expect(() => buildClampedSimpleOptions(model, undefined)).toThrow("No API key for provider: test-provider");
	});
});
