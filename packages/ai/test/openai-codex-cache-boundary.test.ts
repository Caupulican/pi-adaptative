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
