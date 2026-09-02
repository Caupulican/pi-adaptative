import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	streamOpenAICodexResponses,
} from "../src/providers/openai-codex-responses.ts";
import type { Context, Model } from "../src/types.ts";

function mockToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.1-codex",
	name: "GPT-5.1 Codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400_000,
	maxTokens: 128_000,
};

function context(messages: Context["messages"]): Context {
	return { systemPrompt: "You are helpful.", messages };
}

function responseEvents(responseId: string, messageId: string, text: string): unknown[] {
	return [
		{ type: "response.created", response: { id: responseId } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: messageId, role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: messageId,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: responseId,
				status: "completed",
				usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
			},
		},
	];
}

function completedSse(text = "ok"): Response {
	const payload = `${responseEvents("resp_sse", "msg_sse", text)
		.map((event) => `data: ${JSON.stringify(event)}\n\n`)
		.join("")}data: [DONE]\n\n`;
	return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
}

afterEach(() => {
	closeOpenAICodexWebSocketSessions();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("OpenAI Codex cache boundary", () => {
	it("omits SSE cache affinity when cache retention is disabled", async () => {
		let headers: Headers | undefined;
		let body: Record<string, unknown> | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				headers = new Headers(init?.headers);
				body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return completedSse();
			}),
		);

		await streamOpenAICodexResponses(model, context([{ role: "user", content: "hello", timestamp: 1 }]), {
			apiKey: mockToken(),
			transport: "sse",
			cacheRetention: "none",
			sessionId: "one-shot-summary",
		}).result();

		expect(headers?.has("session-id")).toBe(false);
		expect(headers?.has("x-client-request-id")).toBe(false);
		expect(body).not.toHaveProperty("prompt_cache_key");
	});

	it("forwards a required tool choice", async () => {
		let body: Record<string, unknown> | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return completedSse();
			}),
		);

		await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: "You are helpful.",
				messages: [{ role: "user", content: "Use the tool.", timestamp: 1 }],
				tools: [{ name: "ping", description: "Ping", parameters: Type.Object({}) }],
			},
			{ apiKey: mockToken(), transport: "sse", toolChoice: "required" },
		).result();

		expect(body?.tool_choice).toBe("required");
	});

	it("replays a missing cached continuation once on a fresh websocket before output", async () => {
		const sentBodies: Array<{ connectionId: number; previous_response_id?: string }> = [];
		let connections = 0;

		class MockWebSocket {
			static readonly OPEN = 1;
			static readonly CLOSED = 3;
			readyState = MockWebSocket.OPEN;
			private readonly connectionId = ++connections;
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
				const body = JSON.parse(data) as { previous_response_id?: string };
				sentBodies.push({ ...body, connectionId: this.connectionId });
				if (sentBodies.length === 2) {
					queueMicrotask(() =>
						this.dispatch("message", {
							data: JSON.stringify({
								type: "error",
								status: 400,
								error: {
									code: "previous_response_not_found",
									message: "Previous response was evicted",
								},
							}),
						}),
					);
					return;
				}
				const responseId = sentBodies.length === 1 ? "resp_1" : "resp_2";
				const messageId = sentBodies.length === 1 ? "msg_1" : "msg_2";
				const text = sentBodies.length === 1 ? "first" : "recovered";
				queueMicrotask(() => {
					for (const event of responseEvents(responseId, messageId, text)) {
						this.dispatch("message", { data: JSON.stringify(event) });
					}
				});
			}

			close(): void {
				this.readyState = MockWebSocket.CLOSED;
			}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) listener(event);
			}
		}

		vi.stubGlobal("WebSocket", MockWebSocket);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("unexpected", { status: 500 })),
		);
		const firstContext = context([{ role: "user", content: "hello", timestamp: 1 }]);
		const first = await streamOpenAICodexResponses(model, firstContext, {
			apiKey: mockToken(),
			transport: "websocket-cached",
			sessionId: "continuation-session",
		}).result();
		const secondContext = context([
			...firstContext.messages,
			first,
			{ role: "user", content: "continue", timestamp: 2 },
		]);
		const eventTypes: string[] = [];
		const secondStream = streamOpenAICodexResponses(model, secondContext, {
			apiKey: mockToken(),
			transport: "websocket-cached",
			sessionId: "continuation-session",
		});
		for await (const event of secondStream) eventTypes.push(event.type);
		const second = await secondStream.result();

		expect(second.stopReason).toBe("stop");
		expect(second.content.find((part) => part.type === "text")?.text).toBe("recovered");
		expect(eventTypes.filter((type) => type === "start")).toHaveLength(1);
		expect(eventTypes).not.toContain("error");
		expect(connections).toBe(2);
		expect(sentBodies).toHaveLength(3);
		expect(sentBodies[1]?.previous_response_id).toBe("resp_1");
		expect(sentBodies[2]?.previous_response_id).toBeUndefined();
		expect(global.fetch).not.toHaveBeenCalled();
	});
});

describe("OpenAI Codex continuation across a response-level rejection", () => {
	it("keeps the socket and the continuation, so the retry sends only the delta under the last response id", async () => {
		const sentBodies: Array<{ connectionId: number; previous_response_id?: string; inputItems: number }> = [];
		let connections = 0;

		class MockWebSocket {
			static readonly OPEN = 1;
			static readonly CLOSED = 3;
			readyState = MockWebSocket.OPEN;
			private readonly connectionId = ++connections;
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
				const body = JSON.parse(data) as { previous_response_id?: string; input?: unknown[] };
				sentBodies.push({
					connectionId: this.connectionId,
					previous_response_id: body.previous_response_id,
					inputItems: body.input?.length ?? 0,
				});
				if (sentBodies.length === 2) {
					// The server rejects the response; the connection stays open.
					queueMicrotask(() =>
						this.dispatch("message", {
							data: JSON.stringify({
								type: "error",
								status: 503,
								error: { code: "server_is_overloaded", message: "Our servers are currently overloaded." },
							}),
						}),
					);
					return;
				}
				const responseId = sentBodies.length === 1 ? "resp_1" : "resp_3";
				const messageId = sentBodies.length === 1 ? "msg_1" : "msg_3";
				const text = sentBodies.length === 1 ? "first" : "retried";
				queueMicrotask(() => {
					for (const event of responseEvents(responseId, messageId, text)) {
						this.dispatch("message", { data: JSON.stringify(event) });
					}
				});
			}

			close(): void {
				this.readyState = MockWebSocket.CLOSED;
			}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) listener(event);
			}
		}

		vi.stubGlobal("WebSocket", MockWebSocket);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("unexpected", { status: 500 })),
		);
		const options = { apiKey: mockToken(), transport: "websocket-cached" as const, sessionId: "rejection-session" };
		const firstContext = context([{ role: "user", content: "hello", timestamp: 1 }]);
		const first = await streamOpenAICodexResponses(model, firstContext, options).result();
		const secondContext = context([
			...firstContext.messages,
			first,
			{ role: "user", content: "continue", timestamp: 2 },
		]);
		const rejected = await streamOpenAICodexResponses(model, secondContext, options).result();
		expect(rejected.stopReason).toBe("error");
		expect(rejected.errorMessage).toContain("server_is_overloaded");

		const retried = await streamOpenAICodexResponses(model, secondContext, options).result();
		expect(retried.stopReason).toBe("stop");
		expect(retried.content.find((part) => part.type === "text")?.text).toBe("retried");

		expect(connections).toBe(1);
		expect(sentBodies).toHaveLength(3);
		expect(sentBodies[1]).toMatchObject({ connectionId: 1, previous_response_id: "resp_1" });
		// The retry is the same delta under the same anchor, not the whole conversation.
		expect(sentBodies[2]).toMatchObject({
			connectionId: 1,
			previous_response_id: "resp_1",
			inputItems: sentBodies[1]?.inputItems,
		});
		// One item each time: hello, then continue, then continue again; a full re-send would carry all three.
		expect(sentBodies.map((body) => body.inputItems)).toEqual([1, 1, 1]);
		expect(global.fetch).not.toHaveBeenCalled();
	});
});

describe("OpenAI Codex transient rejection retry", () => {
	it("retries an overloaded rejection inside the stream as one delta, so the model never sees a failed turn", async () => {
		const sentBodies: Array<{ connectionId: number; previous_response_id?: string; inputItems: number }> = [];
		let connections = 0;

		class MockWebSocket {
			static readonly OPEN = 1;
			static readonly CLOSED = 3;
			readyState = MockWebSocket.OPEN;
			private readonly connectionId = ++connections;
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
				const body = JSON.parse(data) as { previous_response_id?: string; input?: unknown[] };
				sentBodies.push({
					connectionId: this.connectionId,
					previous_response_id: body.previous_response_id,
					inputItems: body.input?.length ?? 0,
				});
				if (sentBodies.length === 2) {
					queueMicrotask(() =>
						this.dispatch("message", {
							data: JSON.stringify({
								type: "error",
								status: 503,
								error: { code: "server_is_overloaded", message: "Our servers are currently overloaded." },
							}),
						}),
					);
					return;
				}
				const responseId = sentBodies.length === 1 ? "resp_1" : "resp_2";
				const messageId = sentBodies.length === 1 ? "msg_1" : "msg_2";
				const text = sentBodies.length === 1 ? "first" : "second";
				queueMicrotask(() => {
					for (const event of responseEvents(responseId, messageId, text)) {
						this.dispatch("message", { data: JSON.stringify(event) });
					}
				});
			}

			close(): void {
				this.readyState = MockWebSocket.CLOSED;
			}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) listener(event);
			}
		}

		vi.stubGlobal("WebSocket", MockWebSocket);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("unexpected", { status: 500 })),
		);
		const options = {
			apiKey: mockToken(),
			transport: "websocket-cached" as const,
			sessionId: "transient-session",
			maxRetries: 2,
		};
		const firstContext = context([{ role: "user", content: "hello", timestamp: 1 }]);
		const first = await streamOpenAICodexResponses(model, firstContext, options).result();
		const secondContext = context([
			...firstContext.messages,
			first,
			{ role: "user", content: "continue", timestamp: 2 },
		]);
		const eventTypes: string[] = [];
		const secondStream = streamOpenAICodexResponses(model, secondContext, options);
		for await (const event of secondStream) eventTypes.push(event.type);
		const second = await secondStream.result();

		expect(second.stopReason).toBe("stop");
		expect(second.content.find((part) => part.type === "text")?.text).toBe("second");
		expect(eventTypes).not.toContain("error");
		expect(eventTypes.filter((type) => type === "start")).toHaveLength(1);
		expect(connections).toBe(1);
		expect(sentBodies.map((body) => [body.previous_response_id, body.inputItems])).toEqual([
			[undefined, 1],
			["resp_1", 1],
			["resp_1", 1],
		]);
		expect(global.fetch).not.toHaveBeenCalled();
	});
});

describe("transport telemetry (turn-economics transport-observability task)", () => {
	it("records which transport carried a directly-configured SSE request", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => completedSse()),
		);

		const result = await streamOpenAICodexResponses(
			model,
			context([{ role: "user", content: "hello", timestamp: 1 }]),
			{ apiKey: mockToken(), transport: "sse" },
		).result();

		const transportDiagnostics = result.diagnostics?.filter((diagnostic) => diagnostic.type === "provider_transport");
		expect(transportDiagnostics).toHaveLength(1);
		expect(transportDiagnostics?.[0]?.details).toEqual({
			transport: "sse",
			deltaEngaged: false,
			fallbackFromWebsocket: false,
		});
	});

	it("records deltaEngaged=false for a full-context websocket send, then deltaEngaged=true once the cached continuation engages", async () => {
		const sentBodies: Array<{ previous_response_id?: string }> = [];

		class MockWebSocket {
			static readonly OPEN = 1;
			static readonly CLOSED = 3;
			readyState = MockWebSocket.OPEN;
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
				const body = JSON.parse(data) as { previous_response_id?: string };
				sentBodies.push(body);
				const responseId = sentBodies.length === 1 ? "resp_1" : "resp_2";
				const messageId = sentBodies.length === 1 ? "msg_1" : "msg_2";
				const text = sentBodies.length === 1 ? "first" : "second";
				queueMicrotask(() => {
					for (const event of responseEvents(responseId, messageId, text)) {
						this.dispatch("message", { data: JSON.stringify(event) });
					}
				});
			}

			close(): void {
				this.readyState = MockWebSocket.CLOSED;
			}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) listener(event);
			}
		}

		vi.stubGlobal("WebSocket", MockWebSocket);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("unexpected", { status: 500 })),
		);

		const firstContext = context([{ role: "user", content: "hello", timestamp: 1 }]);
		const first = await streamOpenAICodexResponses(model, firstContext, {
			apiKey: mockToken(),
			transport: "websocket-cached",
			sessionId: "delta-telemetry-session",
		}).result();
		const firstTransport = first.diagnostics?.filter((diagnostic) => diagnostic.type === "provider_transport");
		expect(firstTransport).toHaveLength(1);
		expect(firstTransport?.[0]?.details).toMatchObject({ transport: "websocket", deltaEngaged: false });

		const secondContext = context([
			...firstContext.messages,
			first,
			{ role: "user", content: "continue", timestamp: 2 },
		]);
		const second = await streamOpenAICodexResponses(model, secondContext, {
			apiKey: mockToken(),
			transport: "websocket-cached",
			sessionId: "delta-telemetry-session",
		}).result();
		const secondTransport = second.diagnostics?.filter((diagnostic) => diagnostic.type === "provider_transport");
		expect(secondTransport).toHaveLength(1);
		expect(secondTransport?.[0]?.details).toMatchObject({ transport: "websocket", deltaEngaged: true });
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("records a websocket-to-sse fallback, alongside the existing failure diagnostic, when the connection cannot be established", async () => {
		vi.useFakeTimers();
		try {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => completedSse()),
			);
			class NeverOpensWebSocket {
				addEventListener(): void {}
				removeEventListener(): void {}
				send(): void {
					throw new Error("send should not be called before websocket open");
				}
				close(): void {}
			}
			vi.stubGlobal("WebSocket", NeverOpensWebSocket);

			const resultPromise = streamOpenAICodexResponses(
				model,
				context([{ role: "user", content: "hello", timestamp: 1 }]),
				{ apiKey: mockToken(), transport: "auto", websocketConnectTimeoutMs: 50 },
			).result();

			await vi.advanceTimersByTimeAsync(50);
			const result = await resultPromise;

			const transportDiagnostics = result.diagnostics?.filter(
				(diagnostic) => diagnostic.type === "provider_transport",
			);
			expect(transportDiagnostics).toHaveLength(1);
			expect(transportDiagnostics?.[0]?.details).toEqual({
				transport: "sse",
				deltaEngaged: false,
				fallbackFromWebsocket: true,
			});
			expect(result.diagnostics?.some((diagnostic) => diagnostic.type === "provider_transport_failure")).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});
