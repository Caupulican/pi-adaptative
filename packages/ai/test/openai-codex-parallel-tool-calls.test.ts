import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	streamOpenAICodexResponses,
} from "../src/providers/openai-codex-responses.ts";
import type { Context, Model } from "../src/types.ts";

// Guard for E10 / Phase 1 T4.2: OpenAI-Codex must keep sending
// `parallel_tool_calls === !lite` on every request (openai-codex-responses.ts:636).

function mockToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

function makeModel(openaiResponsesLite?: boolean): Model<"openai-codex-responses"> {
	return {
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
		...(openaiResponsesLite !== undefined ? { openaiResponsesLite } : {}),
	};
}

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

describe("OpenAI-Codex parallel tool-call wire guard", () => {
	it("sends parallel_tool_calls: true for a non-lite model", async () => {
		let body: Record<string, unknown> | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return completedSse();
			}),
		);

		await streamOpenAICodexResponses(makeModel(false), context([{ role: "user", content: "hello", timestamp: 1 }]), {
			apiKey: mockToken(),
			transport: "sse",
		}).result();

		expect(body?.parallel_tool_calls).toBe(true);
	});

	it("sends parallel_tool_calls: false for a lite model", async () => {
		let body: Record<string, unknown> | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return completedSse();
			}),
		);

		await streamOpenAICodexResponses(makeModel(true), context([{ role: "user", content: "hello", timestamp: 1 }]), {
			apiKey: mockToken(),
			transport: "sse",
		}).result();

		expect(body?.parallel_tool_calls).toBe(false);
	});
});
