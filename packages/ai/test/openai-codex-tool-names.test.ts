import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.ts";
import type { Context, Model } from "../src/types.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function mockToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

function createCodexModel(): Model<"openai-codex-responses"> {
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
	};
}

describe("OpenAI Codex reserved tool names", () => {
	it("maps reserved names on the wire and restores local names in streamed calls", async () => {
		let requestBody: Record<string, unknown> | undefined;
		const events = [
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_new",
					call_id: "call_new",
					name: "python_tool",
					arguments: "",
				},
			},
			{
				type: "response.output_item.done",
				item: {
					type: "function_call",
					id: "fc_new",
					call_id: "call_new",
					name: "python_tool",
					arguments: JSON.stringify({ code: "print('ok')" }),
				},
			},
			{
				type: "response.completed",
				response: {
					id: "resp_1",
					status: "completed",
					usage: {
						input_tokens: 10,
						output_tokens: 5,
						total_tokens: 15,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		];
		const sse = `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL, init?: RequestInit) => {
				requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
			}),
		);

		const context: Context = {
			systemPrompt: "Use the available tools.",
			tools: [
				{ name: "python", description: "Run Python", parameters: Type.Object({ code: Type.String() }) },
				{ name: "python_tool", description: "Collision sentinel", parameters: Type.Object({}) },
			],
			messages: [
				{ role: "user", content: "Run it", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call_old|fc_old", name: "python", arguments: { code: "print(1)" } }],
					api: "openai-codex-responses",
					provider: "openai-codex",
					model: "gpt-5.1-codex",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call_old|fc_old",
					toolName: "python",
					content: [{ type: "text", text: "1" }],
					isError: false,
					timestamp: 3,
				},
			],
		};

		const result = await streamOpenAICodexResponses(createCodexModel(), context, {
			apiKey: mockToken(),
			transport: "sse",
		}).result();

		const tools = requestBody?.tools as Array<{ name: string }>;
		const input = requestBody?.input as Array<{ type: string; name?: string }>;
		expect(tools.map((tool) => tool.name)).toEqual(["python_tool", "python_tool_2"]);
		expect(input.find((item) => item.type === "function_call")?.name).toBe("python_tool");
		expect(result.content).toContainEqual({
			type: "toolCall",
			id: "call_new|fc_new",
			name: "python",
			arguments: { code: "print('ok')" },
		});
	});

	it("uses the same reversible mapping over the WebSocket transport", async () => {
		let requestBody: Record<string, unknown> | undefined;

		class MockWebSocket {
			static OPEN = 1;
			readyState = MockWebSocket.OPEN;
			private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

			constructor() {
				queueMicrotask(() => this.dispatch("open", {}));
			}

			addEventListener(type: string, listener: (event: unknown) => void): void {
				let listeners = this.listeners.get(type);
				if (!listeners) {
					listeners = new Set();
					this.listeners.set(type, listeners);
				}
				listeners.add(listener);
			}

			removeEventListener(type: string, listener: (event: unknown) => void): void {
				this.listeners.get(type)?.delete(listener);
			}

			send(data: string): void {
				requestBody = JSON.parse(data) as Record<string, unknown>;
				const events = [
					{
						type: "response.output_item.added",
						item: {
							type: "function_call",
							id: "fc_ws",
							call_id: "call_ws",
							name: "python_tool",
							arguments: "",
						},
					},
					{
						type: "response.output_item.done",
						item: {
							type: "function_call",
							id: "fc_ws",
							call_id: "call_ws",
							name: "python_tool",
							arguments: JSON.stringify({ code: "print('ws')" }),
						},
					},
					{
						type: "response.completed",
						response: {
							id: "resp_ws",
							status: "completed",
							usage: {
								input_tokens: 8,
								output_tokens: 4,
								total_tokens: 12,
								input_tokens_details: { cached_tokens: 0 },
							},
						},
					},
				];
				queueMicrotask(() => {
					for (const event of events) this.dispatch("message", { data: JSON.stringify(event) });
				});
			}

			close(): void {
				this.readyState = 3;
			}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) listener(event);
			}
		}

		vi.stubGlobal("WebSocket", MockWebSocket);
		const context: Context = {
			systemPrompt: "Use the available tools.",
			tools: [
				{ name: "python", description: "Run Python", parameters: Type.Object({ code: Type.String() }) },
				{ name: "python_tool", description: "Collision sentinel", parameters: Type.Object({}) },
			],
			messages: [{ role: "user", content: "Run it", timestamp: 1 }],
		};

		const result = await streamOpenAICodexResponses(createCodexModel(), context, {
			apiKey: mockToken(),
			transport: "websocket",
		}).result();

		const tools = requestBody?.tools as Array<{ name: string }>;
		expect(tools.map((tool) => tool.name)).toEqual(["python_tool", "python_tool_2"]);
		expect(result.content).toContainEqual({
			type: "toolCall",
			id: "call_ws|fc_ws",
			name: "python",
			arguments: { code: "print('ws')" },
		});
	});
});
