import { afterEach, describe, expect, it, vi } from "vitest";
import { streamAntigravity } from "../src/providers/google-antigravity.ts";
import type { Model } from "../src/types.ts";
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
		expect(getOAuthProvider("google-antigravity")?.name).toContain("Antigravity");
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
		const result = await streamAntigravity(model, { messages: [] }, { apiKey: "fixture" }).result();
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
			{ apiKey: "fixture", signal: controller.signal },
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
		const result = await streamAntigravity(model, { messages: [] }, { apiKey: "fixture" }).result();
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
		const result = await streamAntigravity(model, { messages: [] }, { apiKey: "fixture" }).result();
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
			{ apiKey: "fixture" },
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
			{ apiKey: "fixture", signal: AbortSignal.abort() },
		).result();
		expect(result.stopReason).toBe("aborted");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
