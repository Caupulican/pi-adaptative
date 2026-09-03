import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/models.ts";
import {
	streamOpenAICodexResponses,
	streamSimpleOpenAICodexResponses,
} from "../src/providers/openai-codex-responses.ts";
import { streamOpenAIResponses, streamSimpleOpenAIResponses } from "../src/providers/openai-responses.ts";
import { processResponsesStream } from "../src/providers/openai-responses-shared.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function mockCodexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

function completedSse(): Response {
	const payload = `data: ${JSON.stringify({
		type: "response.completed",
		response: {
			id: "resp_gpt56",
			status: "completed",
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				total_tokens: 2,
				input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
			},
		},
	})}\n\n`;
	return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function contextWithImageAndTool(): Context {
	return {
		systemPrompt: "Use tools when useful.",
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "Inspect this image." },
					{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
				],
				timestamp: Date.now(),
			},
		],
		tools: [
			{
				name: "read_file",
				description: "Read a file",
				parameters: Type.Object({ path: Type.String() }),
			},
		],
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

async function* highContextUsageEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.completed",
		response: {
			id: "resp_high_context_gpt56",
			status: "completed",
			usage: {
				input_tokens: 300_000,
				output_tokens: 1_000,
				total_tokens: 301_000,
				input_tokens_details: { cached_tokens: 50_000, cache_write_tokens: 20_000 },
			},
		},
	} as unknown as ResponseStreamEvent;
}

describe("GPT-5.6 integration", () => {
	it("publishes family capabilities and the eligible GPT-5.6 Ultra reasoning alias", () => {
		const alias = getModel("openai", "gpt-5.6");
		const directSol = getModel("openai", "gpt-5.6-sol");
		const directTerra = getModel("openai", "gpt-5.6-terra");
		const directLuna = getModel("openai", "gpt-5.6-luna");
		const codexSol = getModel("openai-codex", "gpt-5.6-sol");
		const codexTerra = getModel("openai-codex", "gpt-5.6-terra");
		const codexLuna = getModel("openai-codex", "gpt-5.6-luna");

		// Prices, the 272k context tier and limits come from models.dev; the advertised window stops at
		// the tier threshold (short-context pricing by default, as in Codex's own catalogue).
		expect(alias).toMatchObject({
			contextWindow: 272_000,
			maxTokens: 128_000,
			defaultThinkingLevel: "medium",
			cost: {
				input: 4,
				output: 20,
				cacheRead: 0.4,
				cacheWrite: 5,
				tiers: [{ inputTokensAbove: 272_000, input: 8, output: 30, cacheRead: 0.8, cacheWrite: 10 }],
			},
		});
		expect(alias.longContextPricing).toBeUndefined();
		expect(alias.autoCompactionTriggerTokens).toBeUndefined();
		expect(directTerra.cost).toMatchObject({ input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 });
		expect(directLuna.cost).toMatchObject({ input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 });
		// ChatGPT plans are not billed per token; the Codex entries mirror the OpenAI list prices.
		expect(codexSol.cost).toEqual(directSol.cost);
		expect(codexTerra.cost).toEqual(directTerra.cost);
		expect(codexLuna.cost).toEqual(directLuna.cost);
		expect(directSol.defaultThinkingLevel).toBe("medium");
		expect(directTerra.defaultThinkingLevel).toBe("medium");
		expect(directLuna.defaultThinkingLevel).toBe("medium");
		expect(getSupportedThinkingLevels(directSol)).toEqual(["off", "low", "medium", "high", "xhigh", "max", "ultra"]);
		expect(getSupportedThinkingLevels(directLuna)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
		expect(codexSol).toMatchObject({
			contextWindow: 272_000,
			maxTokens: 128_000,
			defaultThinkingLevel: "low",
			openaiResponsesLite: true,
		});
		expect(codexTerra).toMatchObject({ defaultThinkingLevel: "medium", openaiResponsesLite: true });
		expect(getSupportedThinkingLevels(codexSol)).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
		expect(getSupportedThinkingLevels(codexLuna)).toEqual(["low", "medium", "high", "xhigh", "max"]);
	});

	it("publishes GPT-6 Astra: list prices with the long tier on the API, Responses Lite and ultra on Codex", () => {
		const direct = getModel("openai", "gpt-6-astra");
		const astra = getModel("openai-codex", "gpt-6-astra");
		// OpenAI model page 2026-09-03: $10 / $1 cached / $12.5 cache write / $50 per 1M; above 272k
		// input tokens 2x input and cache, 1.5x output; 1,050,000 window, 128,000 max output. The
		// advertised window stops at the tier threshold, as for GPT-5.6.
		expect(direct).toMatchObject({
			contextWindow: 272_000,
			maxTokens: 128_000,
			defaultThinkingLevel: "medium",
			cost: {
				input: 10,
				output: 50,
				cacheRead: 1,
				cacheWrite: 12.5,
				tiers: [{ inputTokensAbove: 272_000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }],
			},
		});
		// The API lists low, medium, high, xhigh and max; no minimal, no ultra.
		expect(getSupportedThinkingLevels(direct)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
		expect(astra).toMatchObject({
			contextWindow: 272_000,
			maxTokens: 128_000,
			defaultThinkingLevel: "low",
			openaiResponsesLite: true,
			input: ["text", "image"],
		});
		expect(astra.cost).toEqual(direct.cost);
		expect(getSupportedThinkingLevels(astra)).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
		expect(astra.thinkingLevelMap?.ultra).toBe("ultra");
	});

	it("sends direct GPT-5.6 pro reasoning, cache policy, safety identifier, and Ultra as max", async () => {
		let capturedPayload: unknown;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => completedSse()),
		);

		const result = await streamOpenAIResponses(
			getModel("openai", "gpt-5.6-sol"),
			{ messages: [{ role: "user", content: "Solve this.", timestamp: Date.now() }] },
			{
				apiKey: "test-key",
				sessionId: "session-gpt56",
				reasoningEffort: "ultra",
				reasoningMode: "pro",
				reasoningContext: "all_turns",
				promptCacheOptions: { mode: "explicit", ttl: "30m" },
				metadata: { safety_identifier: "user_123" },
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(capturedPayload).toMatchObject({
			model: "gpt-5.6-sol",
			reasoning: { effort: "max", mode: "pro", context: "all_turns", summary: "auto" },
			prompt_cache_options: { mode: "explicit", ttl: "30m" },
			prompt_cache_key: "session-gpt56",
			safety_identifier: "user_123",
		});
		expect(capturedPayload).not.toHaveProperty("prompt_cache_retention");
	});

	it("uses the direct GPT-5.6 reasoning default without changing explicit off or older models", async () => {
		const capturedPayloads: unknown[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => completedSse()),
		);
		const context: Context = {
			messages: [{ role: "user", content: "Solve this.", timestamp: Date.now() }],
		};
		const capturePayload = (payload: unknown) => {
			capturedPayloads.push(payload);
		};

		await streamSimpleOpenAIResponses(getModel("openai", "gpt-5.6-sol"), context, {
			apiKey: "test-key",
			onPayload: capturePayload,
		}).result();
		await streamSimpleOpenAIResponses(getModel("openai", "gpt-5.6-sol"), context, {
			apiKey: "test-key",
			reasoning: "off",
			reasoningMode: "pro",
			reasoningContext: "all_turns",
			onPayload: capturePayload,
		}).result();
		await streamSimpleOpenAIResponses(getModel("openai", "gpt-5.5"), context, {
			apiKey: "test-key",
			onPayload: capturePayload,
		}).result();

		expect(capturedPayloads[0]).toMatchObject({ reasoning: { effort: "medium", summary: "auto" } });
		expect(capturedPayloads[1]).toMatchObject({
			reasoning: { effort: "none", mode: "pro", context: "all_turns" },
		});
		expect(capturedPayloads[2]).toMatchObject({ reasoning: { effort: "none" } });
	});

	it("does not send GPT-5.6-only cache options to older Responses models", async () => {
		let capturedPayload: unknown;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => completedSse()),
		);

		await streamOpenAIResponses(
			getModel("openai", "gpt-5.5"),
			{ messages: [{ role: "user", content: "Solve this.", timestamp: Date.now() }] },
			{
				apiKey: "test-key",
				promptCacheOptions: { mode: "explicit", ttl: "30m" },
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			},
		).result();

		expect(capturedPayload).not.toHaveProperty("prompt_cache_options");
	});

	it("turns GPT-5.6 caching off with explicit mode and no breakpoints when retention is none", async () => {
		let capturedPayload: Record<string, unknown> | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => completedSse()),
		);

		await streamOpenAIResponses(
			getModel("openai", "gpt-5.6-sol"),
			{ messages: [{ role: "user", content: "Summarize this.", timestamp: Date.now() }] },
			{
				apiKey: "test-key",
				sessionId: "session-gpt56",
				cacheRetention: "none",
				onPayload: (payload) => {
					capturedPayload = payload as Record<string, unknown>;
				},
			},
		).result();

		// Explicit mode without a breakpoint neither reads nor writes the cache, so a one-shot request
		// (compaction summary, branch summary) pays no 1.25× cache-write charge.
		expect(capturedPayload).toMatchObject({ prompt_cache_options: { mode: "explicit" } });
		expect(capturedPayload?.prompt_cache_key).toBeUndefined();
		expect(capturedPayload).not.toHaveProperty("prompt_cache_retention");
	});

	it("uses the ChatGPT Responses Lite contract for Codex GPT-5.6", async () => {
		let requestBody: Record<string, unknown> | undefined;
		let requestHeaders: Headers | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
				requestHeaders = new Headers(init?.headers);
				return completedSse();
			}),
		);

		const result = await streamOpenAICodexResponses(
			getModel("openai-codex", "gpt-5.6-sol"),
			contextWithImageAndTool(),
			{ apiKey: mockCodexToken(), transport: "sse", reasoningEffort: "ultra" },
		).result();

		expect(result.stopReason).toBe("stop");
		expect(requestHeaders?.get("x-openai-internal-codex-responses-lite")).toBe("true");
		expect(requestBody).not.toHaveProperty("instructions");
		expect(requestBody).not.toHaveProperty("tools");
		expect(requestBody).toMatchObject({
			parallel_tool_calls: false,
			reasoning: { effort: "max", summary: "auto", context: "all_turns" },
		});
		const input = requestBody?.input;
		if (!Array.isArray(input)) throw new Error("Expected Responses Lite input array");
		expect(input[0]).toMatchObject({
			type: "additional_tools",
			role: "developer",
			tools: [
				{
					type: "namespace",
					name: "functions",
					description: "",
					tools: [{ type: "function", name: "read_file", strict: false }],
				},
			],
		});
		expect(input[1]).toMatchObject({ type: "message", role: "developer" });
		expect(input[2]).toMatchObject({ type: "message", role: "user" });

		const serializedBody = JSON.stringify(requestBody);
		expect(serializedBody).toContain('"type":"input_image"');
		expect(serializedBody).not.toContain('"detail"');
	});

	it("omits the Responses Lite developer message when no instructions exist", async () => {
		let requestBody: Record<string, unknown> | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return completedSse();
			}),
		);

		await streamOpenAICodexResponses(
			getModel("openai-codex", "gpt-5.6-luna"),
			{ messages: [{ role: "user", content: "Answer briefly.", timestamp: Date.now() }] },
			{ apiKey: mockCodexToken(), transport: "sse" },
		).result();

		const input = requestBody?.input;
		if (!Array.isArray(input)) throw new Error("Expected Responses Lite input array");
		expect(input).toHaveLength(2);
		expect(input[0]).toEqual({ type: "additional_tools", role: "developer", tools: [] });
		expect(input[1]).toMatchObject({ type: "message", role: "user" });
	});

	it("keeps the legacy Codex Responses contract unchanged for pre-5.6 models", async () => {
		let requestBody: Record<string, unknown> | undefined;
		let requestHeaders: Headers | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
				requestHeaders = new Headers(init?.headers);
				return completedSse();
			}),
		);

		await streamOpenAICodexResponses(getModel("openai-codex", "gpt-5.5"), contextWithImageAndTool(), {
			apiKey: mockCodexToken(),
			transport: "sse",
		}).result();

		expect(requestHeaders?.has("x-openai-internal-codex-responses-lite")).toBe(false);
		expect(requestBody?.instructions).toBe("Use tools when useful.");
		expect(requestBody?.tools).toEqual([
			expect.objectContaining({ type: "function", name: "read_file", strict: null }),
		]);
		expect(JSON.stringify(requestBody?.input)).not.toContain("additional_tools");
	});

	it("preserves supported Codex off and clamps unsupported GPT-5.6 off explicitly", async () => {
		const capturedPayloads: unknown[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => completedSse()),
		);
		const context: Context = {
			messages: [{ role: "user", content: "Solve this.", timestamp: Date.now() }],
		};
		const capturePayload = (payload: unknown) => {
			capturedPayloads.push(payload);
		};

		await streamSimpleOpenAICodexResponses(getModel("openai-codex", "gpt-5.5"), context, {
			apiKey: mockCodexToken(),
			transport: "sse",
			reasoning: "off",
			onPayload: capturePayload,
		}).result();
		await streamSimpleOpenAICodexResponses(getModel("openai-codex", "gpt-5.6-terra"), context, {
			apiKey: mockCodexToken(),
			transport: "sse",
			reasoning: "off",
			onPayload: capturePayload,
		}).result();

		expect(capturedPayloads[0]).toMatchObject({ reasoning: { effort: "none" } });
		expect(capturedPayloads[1]).toMatchObject({
			reasoning: { effort: "low", summary: "auto", context: "all_turns" },
		});
	});

	it("marks each GPT-5.6 Responses Lite WebSocket request with client metadata", async () => {
		let sentBody: Record<string, unknown> | undefined;
		class MockWebSocket {
			readonly readyState = 1;
			private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

			constructor() {
				queueMicrotask(() => this.dispatch("open", {}));
			}

			addEventListener(type: string, listener: (event: unknown) => void): void {
				const listeners = this.listeners.get(type) ?? new Set<(event: unknown) => void>();
				listeners.add(listener);
				this.listeners.set(type, listeners);
			}

			removeEventListener(type: string, listener: (event: unknown) => void): void {
				this.listeners.get(type)?.delete(listener);
			}

			send(data: string): void {
				sentBody = JSON.parse(data) as Record<string, unknown>;
				queueMicrotask(() => {
					this.dispatch("message", {
						data: JSON.stringify({
							type: "response.completed",
							response: {
								id: "resp_ws_gpt56",
								status: "completed",
								usage: {
									input_tokens: 1,
									output_tokens: 1,
									total_tokens: 2,
									input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
								},
							},
						}),
					});
				});
			}

			close(): void {}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) listener(event);
			}
		}
		vi.stubGlobal("WebSocket", MockWebSocket);

		const result = await streamOpenAICodexResponses(
			getModel("openai-codex", "gpt-5.6-terra"),
			{ messages: [{ role: "user", content: "Plan this.", timestamp: Date.now() }] },
			{ apiKey: mockCodexToken(), transport: "websocket", reasoningEffort: "max" },
		).result();

		expect(result.stopReason).toBe("stop");
		expect(sentBody).toMatchObject({
			type: "response.create",
			client_metadata: { ws_request_header_x_openai_internal_codex_responses_lite: "true" },
			reasoning: { effort: "max", context: "all_turns" },
		});
	});

	it("accounts for cache writes and GPT-5.6 long-context pricing", async () => {
		const model = getModel("openai", "gpt-5.6-sol");
		const output = createOutput(model);

		await processResponsesStream(highContextUsageEvents(), output, new AssistantMessageEventStream(), model);

		expect(output.usage).toMatchObject({
			input: 230_000,
			cacheRead: 50_000,
			cacheWrite: 20_000,
			output: 1_000,
			totalTokens: 301_000,
		});
		// 300k total input exceeds the 272k tier: the whole request bills at the long-context rate
		// (Sol: 8 / 30 / 0.8 / 10 per million).
		expect(output.usage.cost.input).toBeCloseTo(1.84);
		expect(output.usage.cost.cacheRead).toBeCloseTo(0.04);
		expect(output.usage.cost.cacheWrite).toBeCloseTo(0.2);
		expect(output.usage.cost.output).toBeCloseTo(0.03);
		expect(output.usage.cost.total).toBeCloseTo(2.11);
	});
});
