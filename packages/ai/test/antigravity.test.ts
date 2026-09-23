import { afterEach, describe, expect, it, vi } from "vitest";
import { streamAntigravity } from "../src/providers/google-antigravity.ts";
import type { Model } from "../src/types.ts";
import { discoverAntigravityAccount, parseAntigravityModels } from "../src/utils/antigravity.ts";
import { getOAuthProvider } from "../src/utils/oauth/index.ts";

const model: Model<"google-antigravity"> = {
	id: "gemini-3-flash",
	name: "Gemini",
	provider: "google-antigravity",
	api: "google-antigravity",
	baseUrl: "https://daily-cloudcode-pa.googleapis.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 1000,
};
afterEach(() => vi.unstubAllGlobals());

describe("Antigravity OAuth and transport", () => {
	it("registers its own OAuth owner", () => {
		expect(getOAuthProvider("google-antigravity")?.name).toBe("Google Antigravity");
	});

	it("accepts advertised Claude, GPT, and Gemini models under google-antigravity", () => {
		const models = parseAntigravityModels({
			"gemini-2.5-pro": {
				displayName: "Gemini 2.5 Pro",
				maxTokens: 1000000,
				maxOutputTokens: 8192,
				supportsThinking: true,
				supportsImages: true,
			},
			"claude-sonnet-4-6": {
				displayName: "Claude Sonnet 4.6",
				maxTokens: 200000,
				maxOutputTokens: 8192,
				supportsThinking: true,
				supportsImages: true,
			},
			"gpt-4o": {
				displayName: "GPT-4o",
				maxTokens: 128000,
				maxOutputTokens: 4096,
				supportsThinking: false,
				supportsImages: true,
			},
			"o3-mini": {
				displayName: "o3-mini",
				maxTokens: 200000,
				maxOutputTokens: 100000,
				supportsThinking: true,
				supportsImages: false,
			},
			"gemini-image-gen": {
				displayName: "Gemini Image Gen",
				maxTokens: 10000,
				maxOutputTokens: 1000,
			},
			"unsupported-model": {
				displayName: "Unsupported",
				maxTokens: 10000,
				maxOutputTokens: 1000,
			},
		});

		expect(models.map((m) => m.id)).toEqual(["gemini-2.5-pro", "claude-sonnet-4-6", "gpt-4o", "o3-mini"]);
		for (const m of models) {
			expect(m.provider).toBe("google-antigravity");
			expect(m.api).toBe("google-antigravity");
			expect(m.baseUrl).toBe("https://daily-cloudcode-pa.googleapis.com");
		}
	});

	it("discovers advertised Claude and GPT models in discoverAntigravityAccount", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ cloudaicompanionProject: { id: "fixture-project" } }))
			.mockResolvedValueOnce(
				Response.json({
					models: {
						"claude-sonnet-4-6": {
							displayName: "Claude Sonnet 4.6",
							maxTokens: 200000,
							maxOutputTokens: 8192,
							supportsThinking: true,
							supportsImages: true,
						},
						"gpt-4o": {
							displayName: "GPT-4o",
							maxTokens: 128000,
							maxOutputTokens: 4096,
							supportsThinking: false,
							supportsImages: true,
						},
					},
					agentModelSorts: [
						{
							groups: [{ modelIds: ["claude-sonnet-4-6", "gpt-4o"] }],
						},
					],
				}),
			);
		vi.stubGlobal("fetch", fetchMock);
		const account = await discoverAntigravityAccount("fixture-token");
		expect(account.projectId).toBe("fixture-project");
		expect(Object.keys(account.modelCatalog as Record<string, unknown>)).toEqual(["claude-sonnet-4-6", "gpt-4o"]);
	});

	it("streams the Cloud Code Assist envelope without replacing the system prompt", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ cloudaicompanionProject: "fixture-project" }))
			.mockResolvedValue(
				new Response(
					'data: {"response":{"candidates":[{"content":{"parts":[{"text":"OK"}]},"finishReason":"STOP"}]}}\n\n',
					{ headers: { "Content-Type": "text/event-stream" } },
				),
			);
		vi.stubGlobal("fetch", fetchMock);
		const result = await streamAntigravity(
			{ ...model, headers: { authorization: "wrong-model-token" } },
			{ systemPrompt: "User-owned instructions", messages: [{ role: "user", content: "Hello", timestamp: 0 }] },
			{ apiKey: "fixture-token", maxTokens: 32, headers: { AUTHORIZATION: "wrong-option-token" } },
		).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "OK" }]);
		expect(fetchMock.mock.calls[0][0]).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist");
		const [url, options] = fetchMock.mock.calls[1] as [string, RequestInit];
		expect(url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
		expect(new Headers(options.headers).get("Authorization")).toBe("Bearer fixture-token");
		expect(new Headers(options.headers).get("User-Agent")).toMatch(/^antigravity\/cli\/1\.2\.4 \(aidev_client;/);
		const payload = JSON.parse(String(options.body));
		expect(payload.project).toBe("fixture-project");
		expect(payload.request.systemInstruction).toEqual({ role: "user", parts: [{ text: "User-owned instructions" }] });
		expect(payload.enabled_credit_types).toBeUndefined();
		expect(payload.enabledCreditTypes).toBeUndefined();
	});

	it("does not generate when the startup account check fails", async () => {
		const fetchMock = vi.fn().mockResolvedValue(Response.json({}, { status: 401 }));
		vi.stubGlobal("fetch", fetchMock);
		const result = await streamAntigravity(model, { messages: [] }, { apiKey: "fixture-144" }).result();
		expect(result.stopReason).toBe("error");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("cancels after account startup before inference", async () => {
		const controller = new AbortController();
		const fetchMock = vi.fn().mockImplementation(async () => {
			controller.abort();
			return Response.json({ cloudaicompanionProject: "project" });
		});
		vi.stubGlobal("fetch", fetchMock);
		const result = await streamAntigravity(
			model,
			{ messages: [] },
			{ apiKey: "fixture-159", signal: controller.signal },
		).result();
		expect(result.stopReason).toBe("aborted");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each([
		["empty", ""],
		["truncated", 'data: {"response":{"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}}\n\n'],
		["malformed JSON", "data: {broken secret-fixture}\n\n"],
		["error", 'data: {"error":{"message":"secret-fixture"}}\n\n'],
		["invalid candidates", 'data: {"response":{"candidates":{}}}\n\n'],
		[
			"invalid text",
			'data: {"response":{"candidates":[{"content":{"parts":[{"text":{"secret":"fixture"}}]},"finishReason":"STOP"}]}}\n\n',
		],
	])("rejects %s streams without leaking raw response data", async (_label, body) => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(Response.json({ cloudaicompanionProject: "fixture-project" }))
				.mockResolvedValue(new Response(body)),
		);
		const result = await streamAntigravity(model, { messages: [] }, { apiKey: "fixture-183" }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).not.toContain("secret-fixture");
	});

	it("decodes byte-fragmented Unicode, CRLF, multiline frames and terminal EOF", async () => {
		const body =
			': heartbeat\r\ndata: {"response":\r\ndata: {"candidates":[{"content":{"parts":[{"text":"café中"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":2,"totalTokenCount":10}},"traceId":"fixture-trace"}';
		const bytes = new TextEncoder().encode(body);
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(Response.json({ cloudaicompanionProject: "fixture-project" }))
				.mockResolvedValue(
					new Response(
						new ReadableStream({
							start(controller) {
								for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
								controller.close();
							},
						}),
					),
				),
		);
		const result = await streamAntigravity(model, { messages: [] }, { apiKey: "fixture-208" }).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "café中" }]);
		expect(result.responseId).toBe("fixture-trace");
		expect(result.usage.totalTokens).toBe(10);
	});

	it("refuses a credential-bearing request to an untrusted endpoint", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const result = await streamAntigravity(
			{ ...model, baseUrl: "https://untrusted.invalid" },
			{ messages: [] },
			{ apiKey: "fixture-221" },
		).result();
		expect(result.stopReason).toBe("error");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects a pre-aborted request without network access", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const result = await streamAntigravity(
			model,
			{ messages: [] },
			{ apiKey: "fixture-233", signal: AbortSignal.abort() },
		).result();
		expect(result.stopReason).toBe("aborted");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("recovers from 401 using onAuthRejection and retries once with the replacement key", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ cloudaicompanionProject: "fixture-project" }))
			.mockResolvedValueOnce(Response.json({}, { status: 401 }))
			.mockResolvedValueOnce(Response.json({ cloudaicompanionProject: "fixture-project" }))
			.mockResolvedValueOnce(
				new Response(
					'data: {"response":{"candidates":[{"content":{"parts":[{"text":"recovered"}]},"finishReason":"STOP"}]}}\n\n',
					{ headers: { "Content-Type": "text/event-stream" } },
				),
			);
		vi.stubGlobal("fetch", fetchMock);

		let rejectionNotified = false;
		const result = await streamAntigravity(
			model,
			{ messages: [{ role: "user", content: "Hello", timestamp: 0 }] },
			{
				apiKey: "expired-token",
				onAuthRejection: async (event) => {
					rejectionNotified = true;
					expect(event.providerId).toBe("google-antigravity");
					expect(event.status).toBe(401);
					expect(event.attempt).toBe(1);
					return "refreshed-token";
				},
			},
		).result();

		expect(rejectionNotified).toBe(true);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
		const [, secondCallOptions] = fetchMock.mock.calls[1] as [string, RequestInit];
		expect(new Headers(secondCallOptions.headers).get("Authorization")).toBe("Bearer expired-token");
		const [, fourthCallOptions] = fetchMock.mock.calls[3] as [string, RequestInit];
		expect(new Headers(fourthCallOptions.headers).get("Authorization")).toBe("Bearer refreshed-token");
	});

	it("runs each model at its catalog budget, answer cap on top, and speaks each upstream's tool field", async () => {
		const [claude] = parseAntigravityModels({
			"claude-sonnet-4-6": {
				displayName: "Claude Sonnet 4.6",
				maxTokens: 200000,
				maxOutputTokens: 64000,
				supportsThinking: true,
				thinkingBudget: 1024,
				apiProvider: "API_PROVIDER_ANTHROPIC_VERTEX",
			},
		});
		expect(claude).toMatchObject({
			upstream: "anthropic",
			defaultThinkingLevel: "low",
			thinkingBudgets: { low: 1024 },
		});
		const bodies: Record<string, unknown>[] = [];
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(Response.json({ cloudaicompanionProject: "fixture-project" }))
				.mockImplementation(async (_url: string, init: { body: string }) => {
					bodies.push(JSON.parse(init.body));
					// A role-only opening event, then text and the terminal event.
					return new Response(
						[
							`data: ${JSON.stringify({ response: { candidates: [{ content: { role: "model" } }] } })}`,
							"",
							`data: ${JSON.stringify({ response: { candidates: [{ content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP" }] } })}`,
							"",
							"",
						].join("\n"),
						{ headers: { "content-type": "text/event-stream" } },
					);
				}),
		);
		const result = await streamAntigravity(
			claude!,
			{
				messages: [{ role: "user", content: "hi", timestamp: 1 }],
				tools: [
					{ name: "get_weather", description: "weather", parameters: { type: "object", properties: {} } as never },
				],
			},
			{ apiKey: "fixture-budget", maxTokens: 4096 },
		).result();
		expect(result.stopReason).toBe("stop");
		const request = bodies[0]?.request as {
			generationConfig: { maxOutputTokens: number; thinkingConfig: unknown };
			tools: { functionDeclarations: Record<string, unknown>[] }[];
		};
		expect(request.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 1024, includeThoughts: true });
		expect(request.generationConfig.maxOutputTokens).toBe(4096 + 1024);
		expect(request.tools[0]?.functionDeclarations[0]).toHaveProperty("parameters");
		expect(request.tools[0]?.functionDeclarations[0]).not.toHaveProperty("parametersJsonSchema");
		expect(request).not.toHaveProperty("max_tokens");
		expect(request).not.toHaveProperty("messages");
		expect(bodies[0]).toMatchObject({ model: "claude-sonnet-4-6", requestType: "agent", userAgent: "antigravity" });
	});

	it("reads a Claude stream that opens with an empty part before the thought and the answer", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(Response.json({ cloudaicompanionProject: "fixture-project" }))
				.mockResolvedValueOnce(
					new Response(
						[
							`data: ${JSON.stringify({ response: { candidates: [{ content: { role: "model", parts: [{ text: "" }] } }] } })}`,
							"",
							`data: ${JSON.stringify({ response: { candidates: [{ content: { role: "model", parts: [{ thought: true, text: "ok" }] } }] } })}`,
							"",
							`data: ${JSON.stringify({ response: { candidates: [{ content: { role: "model", parts: [{ thought: true, text: "", thoughtSignature: "c2ln" }] } }] } })}`,
							"",
							`data: ${JSON.stringify({ response: { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] } })}`,
							"",
							"",
						].join("\n"),
						{ headers: { "content-type": "text/event-stream" } },
					),
				),
		);
		const [claude] = parseAntigravityModels({
			"claude-sonnet-4-6": {
				displayName: "Claude Sonnet 4.6",
				maxTokens: 200000,
				maxOutputTokens: 64000,
				supportsThinking: true,
				thinkingBudget: 1024,
				apiProvider: "API_PROVIDER_ANTHROPIC_VERTEX",
			},
		});
		const result = await streamAntigravity(
			claude!,
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{ apiKey: "fixture-claude-stream", maxTokens: 64 },
		).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "ok", thinkingSignature: "c2ln" },
			{ type: "text", text: "ok", textSignature: undefined },
		]);
	});
});
