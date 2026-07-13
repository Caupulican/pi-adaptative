import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getOpenAICodexWebSocketDebugStats,
	resetOpenAICodexWebSocketDebugStats,
	streamOpenAICodexResponses,
	streamSimpleOpenAICodexResponses,
} from "../src/providers/openai-codex-responses.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type { Context, Model } from "../src/types.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const __dirname = dirname(fileURLToPath(import.meta.url));

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	}
	resetOpenAICodexWebSocketDebugStats();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function mockToken(accountId = "acc_test"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
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
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

function createCodexContext(): Context {
	return {
		systemPrompt: "You are a helpful assistant.",
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

function buildSSEPayload({
	status,
	includeDone = false,
}: {
	status: "completed" | "incomplete";
	includeDone?: boolean;
}): string {
	const terminalType = status === "incomplete" ? "response.incomplete" : "response.completed";
	const events = [
		`data: ${JSON.stringify({
			type: "response.output_item.added",
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		})}`,
		`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
		`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Hello" }],
			},
		})}`,
		`data: ${JSON.stringify({
			type: terminalType,
			response: {
				status,
				incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
				usage: {
					input_tokens: 5,
					output_tokens: 3,
					total_tokens: 8,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		})}`,
	];

	if (includeDone) {
		events.push("data: [DONE]");
	}

	return `${events.join("\n\n")}\n\n`;
}

const websocketConnectionLimitEvent: Record<string, unknown> = {
	type: "error",
	status: 400,
	error: {
		type: "invalid_request_error",
		code: "websocket_connection_limit_reached",
		message:
			"Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue.",
	},
};

function buildWebSocketSuccessEvents(text = "Hello"): Record<string, unknown>[] {
	return [
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: text },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp_1",
				status: "completed",
				usage: {
					input_tokens: 5,
					output_tokens: 3,
					total_tokens: 8,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		},
	];
}

interface ScriptedWebSocketSend {
	connectionIndex: number;
	sendIndex: number;
	body: Record<string, unknown>;
	emit: (events: readonly Record<string, unknown>[]) => void;
}

type WebSocketScript = readonly Record<string, unknown>[] | ((send: ScriptedWebSocketSend) => void);

function installScriptedWebSocket(scripts: readonly WebSocketScript[]): {
	connections: Array<{ readyState: number }>;
	closedConnectionIndexes: Set<number>;
	sentBodies: Array<{ connectionIndex: number; body: Record<string, unknown> }>;
} {
	const connections: Array<{ readyState: number }> = [];
	const closedConnectionIndexes = new Set<number>();
	const sentBodies: Array<{ connectionIndex: number; body: Record<string, unknown> }> = [];
	const sendCounts: number[] = [];

	class MockWebSocket {
		static OPEN = 1;
		readyState = MockWebSocket.OPEN;
		private readonly connectionIndex: number;
		private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

		constructor() {
			this.connectionIndex = connections.length;
			connections.push(this);
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
			const body = JSON.parse(data) as Record<string, unknown>;
			sentBodies.push({ connectionIndex: this.connectionIndex, body });
			const script = scripts[this.connectionIndex] ?? [];
			const sendIndex = sendCounts[this.connectionIndex] ?? 0;
			sendCounts[this.connectionIndex] = sendIndex + 1;
			const emit = (events: readonly Record<string, unknown>[]) => {
				for (const event of events) {
					this.dispatch("message", { data: JSON.stringify(event) });
				}
			};
			queueMicrotask(() => {
				if (typeof script === "function") {
					script({ connectionIndex: this.connectionIndex, sendIndex, body, emit });
				} else {
					emit(script);
				}
			});
		}

		close(): void {
			this.readyState = 3;
			closedConnectionIndexes.add(this.connectionIndex);
		}

		private dispatch(type: string, event: unknown): void {
			for (const listener of this.listeners.get(type) ?? []) {
				listener(event);
			}
		}
	}

	vi.stubGlobal("WebSocket", MockWebSocket);
	return { connections, closedConnectionIndexes, sentBodies };
}

describe("openai-codex streaming", () => {
	it("emits an error event for cancelled SSE responses", async () => {
		const sse = `data: ${JSON.stringify({
			type: "response.completed",
			response: {
				status: "cancelled",
				usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
			},
		})}\n\n`;
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL) => {
				const url = typeof input === "string" ? input : input.toString();
				if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
					return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
				}
				if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
					return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
				}
				return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
			}),
		);

		const events = [];
		for await (const event of streamOpenAICodexResponses(createCodexModel(), createCodexContext(), {
			apiKey: mockToken(),
			transport: "sse",
		})) {
			events.push(event);
		}

		expect(events.at(-1)).toMatchObject({ type: "error", reason: "error" });
		expect(events.some((event) => event.type === "done")).toBe(false);
	});

	it("emits an error event for cancelled WebSocket responses", async () => {
		class MockWebSocket {
			private listeners = new Map<string, Set<(event: unknown) => void>>();
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
			send(_data: string): void {
				queueMicrotask(() => {
					this.dispatch("message", {
						data: JSON.stringify({
							type: "response.completed",
							response: {
								status: "cancelled",
								usage: {
									input_tokens: 1,
									output_tokens: 0,
									total_tokens: 1,
									input_tokens_details: { cached_tokens: 0 },
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
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("unexpected", { status: 500 })),
		);
		vi.stubGlobal("WebSocket", MockWebSocket);

		const events = [];
		for await (const event of streamOpenAICodexResponses(createCodexModel(), createCodexContext(), {
			apiKey: mockToken(),
			transport: "websocket",
		})) {
			events.push(event);
		}

		expect(events.at(-1)).toMatchObject({ type: "error", reason: "error" });
		expect(events.some((event) => event.type === "done")).toBe(false);
	});

	it("recreates the websocket and replays the request after the Codex connection lifetime limit", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("unexpected", { status: 500 })),
		);
		const harness = installScriptedWebSocket([[websocketConnectionLimitEvent], buildWebSocketSuccessEvents()]);
		const sessionId = "ws-connection-limit";

		const result = await streamOpenAICodexResponses(createCodexModel(), createCodexContext(), {
			apiKey: mockToken(),
			sessionId,
			transport: "websocket",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content.find((content) => content.type === "text")?.text).toBe("Hello");
		expect(harness.connections).toHaveLength(2);
		expect(harness.closedConnectionIndexes.has(0)).toBe(true);
		expect(harness.sentBodies.map(({ connectionIndex }) => connectionIndex)).toEqual([0, 1]);
		expect(harness.sentBodies[1]?.body.previous_response_id).toBeUndefined();
		expect(harness.sentBodies[1]?.body.input).toEqual(harness.sentBodies[0]?.body.input);
		expect(getOpenAICodexWebSocketDebugStats(sessionId)).toMatchObject({
			requests: 2,
			connectionsCreated: 2,
			fullContextRequests: 2,
			deltaRequests: 0,
		});
		cleanupSessionResources(sessionId);
	});

	it("bounds Codex websocket connection lifetime recovery to one replay", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("unexpected", { status: 500 })),
		);
		const harness = installScriptedWebSocket([
			[websocketConnectionLimitEvent],
			[websocketConnectionLimitEvent],
			buildWebSocketSuccessEvents(),
		]);
		const sessionId = "ws-connection-limit-bounded";

		const result = await streamOpenAICodexResponses(createCodexModel(), createCodexContext(), {
			apiKey: mockToken(),
			sessionId,
			transport: "websocket",
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Responses websocket connection limit reached (60 minutes)");
		expect(harness.connections).toHaveLength(2);
		expect(harness.sentBodies).toHaveLength(2);
		expect(harness.closedConnectionIndexes).toEqual(new Set([0, 1]));
		cleanupSessionResources(sessionId);
	});

	it("does not replay a Codex websocket request after response output has started", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("unexpected", { status: 500 })),
		);
		const responseStarted = {
			type: "response.output_item.added",
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		};
		const harness = installScriptedWebSocket([[responseStarted, websocketConnectionLimitEvent]]);
		const sessionId = "ws-connection-limit-after-output";

		const result = await streamOpenAICodexResponses(createCodexModel(), createCodexContext(), {
			apiKey: mockToken(),
			sessionId,
			transport: "websocket",
		}).result();

		expect(result.stopReason).toBe("error");
		expect(harness.connections).toHaveLength(1);
		expect(harness.sentBodies).toHaveLength(1);
		expect(harness.closedConnectionIndexes).toEqual(new Set([0]));
		cleanupSessionResources(sessionId);
	});

	it("keeps a replacement authenticated socket cached when an older in-flight request releases", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("unexpected", { status: 500 })),
		);
		let releaseHeldResponse: (() => void) | undefined;
		const harness = installScriptedWebSocket([
			({ sendIndex, emit }) => {
				if (sendIndex === 0) {
					emit(buildWebSocketSuccessEvents("token-a-first"));
					return;
				}
				releaseHeldResponse = () => emit(buildWebSocketSuccessEvents("token-a-held"));
			},
			buildWebSocketSuccessEvents("token-b"),
		]);
		const sessionId = "ws-auth-replacement-release-race";
		const model = createCodexModel();
		const context = createCodexContext();
		const tokenA = mockToken("acc_a");
		const tokenB = mockToken("acc_b");

		await streamOpenAICodexResponses(model, context, {
			apiKey: tokenA,
			sessionId,
			transport: "websocket",
		}).result();
		const heldTokenAResult = streamOpenAICodexResponses(model, context, {
			apiKey: tokenA,
			sessionId,
			transport: "websocket",
		}).result();
		await vi.waitFor(() => expect(harness.sentBodies).toHaveLength(2));

		await streamOpenAICodexResponses(model, context, {
			apiKey: tokenB,
			sessionId,
			transport: "websocket",
		}).result();
		expect(releaseHeldResponse).toBeTypeOf("function");
		releaseHeldResponse?.();
		await heldTokenAResult;

		await streamOpenAICodexResponses(model, context, {
			apiKey: tokenB,
			sessionId,
			transport: "websocket",
		}).result();

		expect(harness.connections).toHaveLength(2);
		expect(harness.sentBodies.map(({ connectionIndex }) => connectionIndex)).toEqual([0, 0, 1, 1]);
		cleanupSessionResources(sessionId);
	});

	it("strips the live GPT-5.5 empty HTML comment tail from reasoning summaries", async () => {
		const token = mockToken();
		const fixture = readFileSync(join(__dirname, "data", "openai-codex-gpt55-reasoning-summary-tail.ndjson"), "utf8")
			.trim()
			.split("\n")
			.map((line) => `data: ${line}`)
			.join("\n\n");
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(`${fixture}\n\n`));
				controller.close();
			},
		});

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })),
		);

		const result = await streamOpenAICodexResponses(createCodexModel(), createCodexContext(), {
			apiKey: token,
			transport: "sse",
		}).result();

		const thinking = result.content.find((content) => content.type === "thinking");
		expect(thinking).toMatchObject({ type: "thinking", thinking: "**Confirming exact answer requirement**" });
		expect(JSON.stringify(thinking)).not.toContain("<!--");
		expect(result.content.find((content) => content.type === "text")).toMatchObject({ type: "text", text: "OK" });
	});

	it("attaches Codex subscription rate-limit reset diagnostics from response headers", async () => {
		const token = mockToken();
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(buildSSEPayload({ status: "completed" })));
				controller.close();
			},
		});

		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(stream, {
						status: 200,
						headers: {
							"content-type": "text/event-stream",
							"x-codex-primary-reset-after-seconds": "15325",
							"x-codex-primary-reset-at": "1783612570",
							"x-codex-secondary-reset-after-seconds": "396966",
							"x-codex-secondary-reset-at": "1783994211",
							"x-codex-bengalfox-primary-used-percent": "40.5",
							"x-codex-bengalfox-primary-window-minutes": "300",
							"x-codex-bengalfox-primary-reset-at": "1783615246",
							"x-codex-bengalfox-limit-name": "gpt-5.5",
						},
					}),
			),
		);

		const result = await streamOpenAICodexResponses(createCodexModel(), createCodexContext(), {
			apiKey: token,
			transport: "sse",
		}).result();

		expect(result.usage.cost.total).toBe(0);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				type: "openai_codex_subscription_rate_limits",
				details: expect.objectContaining({
					rollover: "server_reset_at_epoch_seconds",
					unit: "subscription_metered_limit_window",
					rateLimits: expect.arrayContaining([
						expect.objectContaining({
							limitId: "codex",
							primary: { resetAfterSeconds: 15325, resetsAt: 1783612570 },
							secondary: { resetAfterSeconds: 396966, resetsAt: 1783994211 },
						}),
						expect.objectContaining({
							limitId: "codex_bengalfox",
							limitName: "gpt-5.5",
							primary: { usedPercent: 40.5, windowMinutes: 300, resetsAt: 1783615246 },
						}),
					]),
				}),
			}),
		);
	});

	it("streams SSE responses into AssistantMessageEventStream", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-codex-stream-"));
		process.env.PI_CODING_AGENT_DIR = tempDir;

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toString("base64");
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			})}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			})}`,
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}`,
		].join("\n\n")}\n\n`;

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});

		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				const headers = init?.headers instanceof Headers ? init.headers : undefined;
				expect(headers?.get("Authorization")).toBe(`Bearer ${token}`);
				expect(headers?.get("chatgpt-account-id")).toBe("acc_test");
				expect(headers?.get("OpenAI-Beta")).toBe("responses=experimental");
				expect(headers?.get("originator")).toBe("pi");
				expect(headers?.get("accept")).toBe("text/event-stream");
				expect(headers?.has("x-api-key")).toBe(false);
				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		vi.stubGlobal("fetch", fetchMock);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const streamResult = streamOpenAICodexResponses(model, context, { apiKey: token, transport: "sse" });
		let sawTextDelta = false;
		let sawDone = false;

		for await (const event of streamResult) {
			if (event.type === "text_delta") {
				sawTextDelta = true;
			}
			if (event.type === "done") {
				sawDone = true;
				expect(event.message.content.find((c) => c.type === "text")?.text).toBe("Hello");
			}
		}

		expect(sawTextDelta).toBe(true);
		expect(sawDone).toBe(true);
	});

	it("completes after response.completed even when the SSE body stays open", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-codex-stream-"));
		process.env.PI_CODING_AGENT_DIR = tempDir;
		const token = mockToken();
		const encoder = new TextEncoder();
		const sse = buildSSEPayload({ status: "completed", includeDone: true });

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
			},
		});

		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const result = await Promise.race([
			streamOpenAICodexResponses(model, context, { apiKey: token, transport: "sse" }).result(),
			new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error("Timed out waiting for completed SSE stream")), 1000);
			}),
		]);

		expect(result.content.find((c) => c.type === "text")?.text).toBe("Hello");
		expect(result.stopReason).toBe("stop");
	});

	it("maps response.incomplete to stopReason length even when the SSE body stays open", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-codex-stream-"));
		process.env.PI_CODING_AGENT_DIR = tempDir;
		const token = mockToken();
		const encoder = new TextEncoder();
		const sse = buildSSEPayload({ status: "incomplete" });

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
			},
		});

		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const result = await Promise.race([
			streamOpenAICodexResponses(model, context, { apiKey: token, transport: "sse" }).result(),
			new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error("Timed out waiting for incomplete SSE stream")), 1000);
			}),
		]);

		expect(result.content.find((c) => c.type === "text")?.text).toBe("Hello");
		expect(result.stopReason).toBe("length");
	});

	it("preserves caller cancellation while waiting for SSE response headers", async () => {
		vi.useFakeTimers();
		const token = mockToken();

		const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url !== "https://chatgpt.com/backend-api/codex/responses") {
				throw new Error(`Unexpected URL: ${url}`);
			}

			const signal = init?.signal;
			if (!signal) {
				throw new Error("Expected SSE fetch to receive an abort signal");
			}

			return new Promise<Response>((_, reject) => {
				const onAbort = () => {
					const reason = signal.reason;
					reject(reason instanceof Error ? reason : new Error("SSE fetch aborted"));
				};
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const controller = new AbortController();
		const resultPromise = streamOpenAICodexResponses(model, context, {
			apiKey: token,
			transport: "sse",
			signal: controller.signal,
		}).result();
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		controller.abort(new Error("caller cancelled"));
		const result = await resultPromise;
		expect(result.stopReason).toBe("aborted");
	});

	it("aborts SSE body reads after response headers arrive", async () => {
		const token = mockToken();
		const encoder = new TextEncoder();
		const timers: ReturnType<typeof setTimeout>[] = [];
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const enqueue = (chunk: string) => {
					if (!cancelled) controller.enqueue(encoder.encode(chunk));
				};
				enqueue(
					`${[
						`data: ${JSON.stringify({
							type: "response.output_item.added",
							item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
						})}`,
						`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
						`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "one" })}`,
					].join("\n\n")}\n\n`,
				);
				timers.push(
					setTimeout(() => {
						enqueue(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "two" })}\n\n`);
					}, 10),
				);
				timers.push(
					setTimeout(() => {
						if (cancelled) return;
						enqueue(
							`${[
								`data: ${JSON.stringify({
									type: "response.output_item.done",
									item: {
										type: "message",
										id: "msg_1",
										role: "assistant",
										status: "completed",
										content: [{ type: "output_text", text: "onetwo" }],
									},
								})}`,
								`data: ${JSON.stringify({
									type: "response.completed",
									response: {
										status: "completed",
										usage: {
											input_tokens: 5,
											output_tokens: 3,
											total_tokens: 8,
											input_tokens_details: { cached_tokens: 0 },
										},
									},
								})}`,
							].join("\n\n")}\n\n`,
						);
						controller.close();
					}, 20),
				);
			},
			cancel() {
				cancelled = true;
				for (const timer of timers) clearTimeout(timer);
			},
		});

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })),
		);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const controller = new AbortController();
		const events: string[] = [];

		const resultStream = streamOpenAICodexResponses(model, context, {
			apiKey: token,
			transport: "sse",
			signal: controller.signal,
		});
		for await (const event of resultStream) {
			events.push(event.type === "text_delta" ? `text_delta:${event.delta}` : event.type);
			if (event.type === "text_delta" && event.delta === "one") {
				controller.abort();
			}
		}

		const result = await resultStream.result();
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("Request was aborted");
		expect(events).toContain("text_delta:one");
		expect(events).not.toContain("text_delta:two");
		expect(cancelled).toBe(true);
	});

	it("sets session-id/x-client-request-id headers and prompt_cache_key when sessionId is provided", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-codex-stream-"));
		process.env.PI_CODING_AGENT_DIR = tempDir;

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toString("base64");
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			})}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			})}`,
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}`,
		].join("\n\n")}\n\n`;

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});

		const sessionId = "test-session-123";
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				const headers = init?.headers instanceof Headers ? init.headers : undefined;
				// Verify sessionId is set in headers
				expect(headers?.get("session-id")).toBe(sessionId);
				expect(headers?.has("session_id")).toBe(false);
				expect(headers?.get("x-client-request-id")).toBe(sessionId);

				// Verify sessionId is set in request body as prompt_cache_key
				const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
				expect(body?.prompt_cache_key).toBe(sessionId);

				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		vi.stubGlobal("fetch", fetchMock);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const streamResult = streamOpenAICodexResponses(model, context, { apiKey: token, sessionId, transport: "sse" });
		await streamResult.result();
	});

	it("clamps prompt_cache_key to OpenAI's 64-character limit", async () => {
		const token = mockToken();
		const sessionId = "x".repeat(67);
		let capturedPayload: { prompt_cache_key?: string } | undefined;
		const encoder = new TextEncoder();
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(encoder.encode(buildSSEPayload({ status: "completed" })));
								controller.close();
							},
						}),
						{ status: 200, headers: { "content-type": "text/event-stream" } },
					),
			),
		);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			transport: "sse",
			sessionId,
			onPayload: (payload) => {
				capturedPayload = payload as { prompt_cache_key?: string };
			},
		}).result();

		expect(capturedPayload?.prompt_cache_key).toBe("x".repeat(64));
	});

	it("preserves gpt-5.5 xhigh reasoning effort from simple options", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-codex-stream-"));
		process.env.PI_CODING_AGENT_DIR = tempDir;
		const token = mockToken();
		const sse = buildSSEPayload({ status: "completed" });
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});
		let requestedReasoning: unknown;

		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
				requestedReasoning = body?.reasoning;
				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.5",
			name: "GPT-5.5",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			thinkingLevelMap: { xhigh: "xhigh" },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		await streamSimpleOpenAICodexResponses(model, context, {
			apiKey: token,
			reasoning: "xhigh",
			transport: "sse",
		}).result();

		expect(requestedReasoning).toEqual({ effort: "xhigh", summary: "auto" });
	});

	it.each(["gpt-5.3-codex", "gpt-5.4", "gpt-5.5"])("clamps %s minimal reasoning effort to low", async (modelId) => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-codex-stream-"));
		process.env.PI_CODING_AGENT_DIR = tempDir;

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toString("base64");
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			})}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			})}`,
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}`,
		].join("\n\n")}\n\n`;

		let requestedReasoning: unknown;
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});

		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
				requestedReasoning = body?.reasoning;

				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		vi.stubGlobal("fetch", fetchMock);

		const model: Model<"openai-codex-responses"> = {
			id: modelId,
			name: modelId,
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			thinkingLevelMap: { minimal: "low" },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const streamResult = streamOpenAICodexResponses(model, context, {
			apiKey: token,
			reasoningEffort: "minimal",
			transport: "sse",
		});
		await streamResult.result();
		expect(requestedReasoning).toEqual({ effort: "low", summary: "auto" });
	});

	it.each([
		["gpt-5.1-codex", "flex", 0.5],
		["gpt-5.1-codex", "priority", 2],
		["gpt-5.5", "flex", 0.5],
		["gpt-5.5", "priority", 2.5],
	] as const)(
		"uses the client-sent %s service tier for %s when Codex echoes default",
		async (modelId, serviceTier, multiplier) => {
			const tempDir = mkdtempSync(join(tmpdir(), "pi-codex-stream-"));
			process.env.PI_CODING_AGENT_DIR = tempDir;
			const token = mockToken();
			const sse = `${[
				`data: ${JSON.stringify({
					type: "response.output_item.added",
					item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
				})}`,
				`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
				`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
				`data: ${JSON.stringify({
					type: "response.output_item.done",
					item: {
						type: "message",
						id: "msg_1",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Hello" }],
					},
				})}`,
				`data: ${JSON.stringify({
					type: "response.completed",
					response: {
						status: "completed",
						service_tier: "default",
						usage: {
							input_tokens: 1000000,
							output_tokens: 1000000,
							total_tokens: 2000000,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				})}`,
			].join("\n\n")}\n\n`;

			const encoder = new TextEncoder();
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(encoder.encode(sse));
					controller.close();
				},
			});

			const fetchMock = vi.fn(async (input: string | URL) => {
				const url = typeof input === "string" ? input : input.toString();
				if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
					return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
				}
				if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
					return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
				}
				if (url === "https://chatgpt.com/backend-api/codex/responses") {
					return new Response(stream, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					});
				}
				return new Response("not found", { status: 404 });
			});
			vi.stubGlobal("fetch", fetchMock);

			const model: Model<"openai-codex-responses"> = {
				id: modelId,
				name: modelId === "gpt-5.5" ? "GPT-5.5" : "GPT-5.1 Codex",
				api: "openai-codex-responses",
				provider: "openai-codex",
				baseUrl: "https://chatgpt.com/backend-api",
				reasoning: true,
				input: ["text"],
				cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 400000,
				maxTokens: 128000,
			};

			const context: Context = {
				systemPrompt: "You are a helpful assistant.",
				messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
			};

			const result = await streamOpenAICodexResponses(model, context, {
				apiKey: token,
				serviceTier,
				transport: "sse",
			}).result();

			expect(result.usage.cost.input).toBe(1 * multiplier);
			expect(result.usage.cost.output).toBe(2 * multiplier);
			expect(result.usage.cost.total).toBe(3 * multiplier);
		},
	);

	it("does not set session-id/x-client-request-id headers when sessionId is not provided", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-codex-stream-"));
		process.env.PI_CODING_AGENT_DIR = tempDir;

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toString("base64");
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			})}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			})}`,
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}`,
		].join("\n\n")}\n\n`;

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});

		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				const headers = init?.headers instanceof Headers ? init.headers : undefined;
				// Verify headers are not set when sessionId is not provided
				expect(headers?.has("session-id")).toBe(false);
				expect(headers?.has("session_id")).toBe(false);
				expect(headers?.has("x-client-request-id")).toBe(false);

				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		vi.stubGlobal("fetch", fetchMock);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		// No sessionId provided
		const streamResult = streamOpenAICodexResponses(model, context, { apiKey: token, transport: "sse" });
		await streamResult.result();
	});
	it("forwards auto transport from streamSimple options and uses cached websocket context", async () => {
		const token = mockToken();
		const sentBodies: unknown[] = [];
		let capturedWebSocketHeaders: Record<string, string> | undefined;

		const fetchMock = vi.fn(async () => new Response("unexpected fetch", { status: 500 }));
		vi.stubGlobal("fetch", fetchMock);

		class MockWebSocket {
			private listeners = new Map<string, Set<(event: unknown) => void>>();

			constructor(_url: string, protocols?: string | string[] | { headers?: Record<string, string> }) {
				if (protocols && typeof protocols === "object" && !Array.isArray(protocols)) {
					capturedWebSocketHeaders = protocols.headers;
				}
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
				sentBodies.push(JSON.parse(data));
				const events = [
					{
						type: "response.output_item.added",
						item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
					},
					{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
					{ type: "response.output_text.delta", delta: "Hello" },
					{
						type: "response.output_item.done",
						item: {
							type: "message",
							id: "msg_1",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "Hello" }],
						},
					},
					{
						type: "response.completed",
						response: {
							status: "completed",
							usage: {
								input_tokens: 5,
								output_tokens: 3,
								total_tokens: 8,
								input_tokens_details: { cached_tokens: 0 },
							},
						},
					},
				];
				queueMicrotask(() => {
					for (const event of events) {
						this.dispatch("message", { data: JSON.stringify(event) });
					}
				});
			}

			close(): void {}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) {
					listener(event);
				}
			}
		}

		vi.stubGlobal("WebSocket", MockWebSocket);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
		};

		await streamSimpleOpenAICodexResponses(model, context, {
			apiKey: token,
			sessionId: "session-auto",
			transport: "auto",
		}).result();

		expect(sentBodies).toHaveLength(1);
		expect(capturedWebSocketHeaders?.["session-id"]).toBe("session-auto");
		expect(capturedWebSocketHeaders?.session_id).toBeUndefined();
		expect(capturedWebSocketHeaders?.["x-client-request-id"]).toBe("session-auto");
		expect(global.fetch).not.toHaveBeenCalled();
		expect(getOpenAICodexWebSocketDebugStats("session-auto")).toMatchObject({
			cachedContextRequests: 1,
			fullContextRequests: 1,
		});
	});

	it("falls back to SSE when websocket connect does not open before the connect timeout", async () => {
		vi.useFakeTimers();
		const token = mockToken();
		const encoder = new TextEncoder();
		const sse = buildSSEPayload({ status: "completed" });

		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url !== "https://chatgpt.com/backend-api/codex/responses") {
				throw new Error(`Unexpected URL: ${url}`);
			}

			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode(sse));
						controller.close();
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		class MockWebSocket {
			private listeners = new Map<string, Set<(event: unknown) => void>>();

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

			send(): void {
				throw new Error("send should not be called before websocket open");
			}

			close(): void {}
		}

		vi.stubGlobal("WebSocket", MockWebSocket);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
		};

		const resultPromise = streamOpenAICodexResponses(model, context, {
			apiKey: token,
			sessionId: "ws-connect-timeout",
			transport: "auto",
			timeoutMs: 300_000,
			websocketConnectTimeoutMs: 50,
		}).result();

		await vi.advanceTimersByTimeAsync(50);

		const result = await resultPromise;
		expect(result.content.find((content) => content.type === "text")?.text).toBe("Hello");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(getOpenAICodexWebSocketDebugStats("ws-connect-timeout")).toMatchObject({
			websocketFailures: 1,
			sseFallbacks: 1,
			websocketFallbackActive: false,
			lastWebSocketError: "WebSocket connect timeout after 50ms",
		});
	});

	it("falls back to SSE when a websocket is idle before the first event", async () => {
		vi.useFakeTimers();
		const token = mockToken();
		const sentBodies: unknown[] = [];
		const encoder = new TextEncoder();
		const sse = buildSSEPayload({ status: "completed" });

		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url !== "https://chatgpt.com/backend-api/codex/responses") {
				throw new Error(`Unexpected URL: ${url}`);
			}

			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode(sse));
						controller.close();
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		class MockWebSocket {
			static OPEN = 1;
			readyState = MockWebSocket.OPEN;
			private listeners = new Map<string, Set<(event: unknown) => void>>();

			constructor(_url: string, _protocols?: string | string[] | { headers?: Record<string, string> }) {
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
				sentBodies.push(JSON.parse(data));
			}

			close(): void {
				this.readyState = 3;
			}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) {
					listener(event);
				}
			}
		}

		vi.stubGlobal("WebSocket", MockWebSocket);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
		};

		const resultPromise = streamOpenAICodexResponses(model, context, {
			apiKey: token,
			sessionId: "ws-idle-before-start",
			transport: "auto",
			timeoutMs: 50,
		}).result();

		await vi.advanceTimersByTimeAsync(0);
		expect(sentBodies).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(50);

		const result = await resultPromise;
		expect(result.content.find((content) => content.type === "text")?.text).toBe("Hello");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(getOpenAICodexWebSocketDebugStats("ws-idle-before-start")).toMatchObject({
			websocketFailures: 1,
			sseFallbacks: 1,
			websocketFallbackActive: false,
		});
	});

	it("errors when a websocket is idle after the stream started", async () => {
		vi.useFakeTimers();
		const token = mockToken();

		const fetchMock = vi.fn(async () => new Response("unexpected fetch", { status: 500 }));
		vi.stubGlobal("fetch", fetchMock);

		class MockWebSocket {
			static OPEN = 1;
			readyState = MockWebSocket.OPEN;
			private listeners = new Map<string, Set<(event: unknown) => void>>();

			constructor(_url: string, _protocols?: string | string[] | { headers?: Record<string, string> }) {
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

			send(): void {
				queueMicrotask(() => {
					this.dispatch("message", {
						data: JSON.stringify({
							type: "response.output_item.added",
							item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
						}),
					});
				});
			}

			close(): void {
				this.readyState = 3;
			}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) {
					listener(event);
				}
			}
		}

		vi.stubGlobal("WebSocket", MockWebSocket);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
		};

		const resultPromise = streamOpenAICodexResponses(model, context, {
			apiKey: token,
			transport: "auto",
			timeoutMs: 50,
		}).result();

		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(50);

		const result = await resultPromise;
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("WebSocket idle timeout after 50ms");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("sends only response input deltas without reserializing the retained prefix", async () => {
		const token = mockToken();
		const historicalPrefix = "historical-prefix-marker";
		const nativeStringify = JSON.stringify;
		let historicalPrefixSerializations = 0;
		vi.spyOn(JSON, "stringify").mockImplementation(((
			...args: Parameters<typeof JSON.stringify>
		): ReturnType<typeof JSON.stringify> => {
			const encoded = Reflect.apply(nativeStringify, JSON, args) as ReturnType<typeof JSON.stringify>;
			if (encoded?.includes(historicalPrefix)) historicalPrefixSerializations++;
			return encoded;
		}) as typeof JSON.stringify);
		const sentBodies: unknown[] = [];
		const responses = [
			{ responseId: "resp_1", messageId: "msg_1", text: "Hello" },
			{ responseId: "resp_2", messageId: "msg_2", text: "Done" },
		];

		class MockWebSocket {
			static OPEN = 1;
			readyState = MockWebSocket.OPEN;
			private listeners = new Map<string, Set<(event: unknown) => void>>();

			constructor(_url: string, _protocols?: string | string[] | { headers?: Record<string, string> }) {
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
				sentBodies.push(JSON.parse(data));
				const response = responses.shift();
				if (!response) throw new Error("unexpected websocket request");
				const events = [
					{ type: "response.created", response: { id: response.responseId } },
					{
						type: "response.output_item.added",
						item: {
							type: "message",
							id: response.messageId,
							role: "assistant",
							status: "in_progress",
							content: [],
						},
					},
					{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
					{ type: "response.output_text.delta", delta: response.text },
					{
						type: "response.output_item.done",
						item: {
							type: "message",
							id: response.messageId,
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: response.text }],
						},
					},
					{
						type: "response.completed",
						response: {
							id: response.responseId,
							status: "completed",
							usage: {
								input_tokens: 5,
								output_tokens: 3,
								total_tokens: 8,
								input_tokens_details: { cached_tokens: 0 },
							},
						},
					},
				];
				queueMicrotask(() => {
					for (const event of events) {
						this.dispatch("message", { data: JSON.stringify(event) });
					}
				});
			}

			close(): void {
				this.readyState = 3;
			}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) {
					listener(event);
				}
			}
		}

		vi.stubGlobal("WebSocket", MockWebSocket);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const firstContext: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: historicalPrefix, timestamp: 1 }],
		};

		const first = await streamOpenAICodexResponses(model, firstContext, {
			apiKey: token,
			sessionId: "session-1",
			transport: "websocket-cached",
		}).result();

		const secondContext: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [...firstContext.messages, first, { role: "user", content: "Now finish", timestamp: 2 }],
		};
		await streamOpenAICodexResponses(model, secondContext, {
			apiKey: token,
			sessionId: "session-1",
			transport: "websocket-cached",
		}).result();

		expect(sentBodies).toHaveLength(2);
		const firstBody = sentBodies[0] as { input: unknown[]; previous_response_id?: string; store?: boolean };
		const secondBody = sentBodies[1] as { input: unknown[]; previous_response_id?: string; store?: boolean };
		expect(firstBody.store).toBe(false);
		expect(firstBody.previous_response_id).toBeUndefined();
		expect(firstBody.input).toEqual([{ role: "user", content: [{ type: "input_text", text: historicalPrefix }] }]);
		expect(historicalPrefixSerializations).toBe(1);
		expect(secondBody.store).toBe(false);
		expect(secondBody.previous_response_id).toBe("resp_1");
		expect(secondBody.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "Now finish" }] }]);
		expect(getOpenAICodexWebSocketDebugStats("session-1")).toMatchObject({
			requests: 2,
			connectionsCreated: 1,
			connectionsReused: 1,
			cachedContextRequests: 2,
			storeTrueRequests: 0,
			fullContextRequests: 1,
			deltaRequests: 1,
			lastDeltaInputItems: 1,
			lastPreviousResponseId: "resp_1",
		});
	});

	it.each([
		["retry-after-ms", () => ({ "content-type": "application/json", "retry-after-ms": "1500" }), 1500],
		["retry-after seconds", () => ({ "content-type": "application/json", "retry-after": "60" }), 60_000],
		[
			"retry-after HTTP date",
			() => ({ "content-type": "application/json", "retry-after": new Date(Date.now() + 45_000).toUTCString() }),
			45_000,
		],
	] as const)("uses %s for SSE retries", async (_name, makeHeaders, expectedDelay) => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-13T00:00:00Z"));
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const token = mockToken();
		const encoder = new TextEncoder();
		const sse = buildSSEPayload({ status: "completed" });
		let codexRequests = 0;

		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url !== "https://chatgpt.com/backend-api/codex/responses") {
				throw new Error(`Unexpected URL: ${url}`);
			}

			codexRequests++;
			if (codexRequests === 1) {
				return new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "rate limited" } }), {
					status: 429,
					headers: makeHeaders(),
				});
			}

			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode(sse));
						controller.close();
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const resultPromise = streamOpenAICodexResponses(model, context, {
			apiKey: token,
			transport: "sse",
			maxRetries: 1,
		}).result();
		await vi.advanceTimersByTimeAsync(0);
		expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), expectedDelay);

		await vi.advanceTimersToNextTimerAsync();
		const result = await resultPromise;
		expect(result.content.find((content) => content.type === "text")?.text).toBe("Hello");
		expect(codexRequests).toBe(2);
	});

	it("uses exponential backoff across repeated SSE retries without retry headers", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-13T00:00:00Z"));
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const token = mockToken();
		const encoder = new TextEncoder();
		const sse = buildSSEPayload({ status: "completed" });
		let codexRequests = 0;

		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url !== "https://chatgpt.com/backend-api/codex/responses") {
				throw new Error(`Unexpected URL: ${url}`);
			}

			codexRequests++;
			if (codexRequests <= 3) {
				return new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "rate limited" } }), {
					status: 429,
					headers: { "content-type": "application/json" },
				});
			}

			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode(sse));
						controller.close();
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const retryTimeoutDelays = () =>
			setTimeoutSpy.mock.calls
				.map((call) => call[1])
				.filter((delay): delay is number => delay === 1000 || delay === 2000 || delay === 4000);

		const resultPromise = streamOpenAICodexResponses(model, context, {
			apiKey: token,
			transport: "sse",
			maxRetries: 3,
		}).result();
		await vi.advanceTimersByTimeAsync(0);
		expect(retryTimeoutDelays()).toEqual([1000]);

		await vi.advanceTimersToNextTimerAsync();
		expect(retryTimeoutDelays()).toEqual([1000, 2000]);

		await vi.advanceTimersToNextTimerAsync();
		expect(retryTimeoutDelays()).toEqual([1000, 2000, 4000]);

		await vi.advanceTimersToNextTimerAsync();
		const result = await resultPromise;
		expect(result.content.find((content) => content.type === "text")?.text).toBe("Hello");
		expect(codexRequests).toBe(4);
	});

	it("clears websocket debug stats and fallback state when session resources are cleaned up", async () => {
		vi.useFakeTimers();
		const token = mockToken();
		const encoder = new TextEncoder();
		const sse = buildSSEPayload({ status: "completed" });

		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url !== "https://chatgpt.com/backend-api/codex/responses") {
				throw new Error(`Unexpected URL: ${url}`);
			}

			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode(sse));
						controller.close();
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		class MockWebSocket {
			private listeners = new Map<string, Set<(event: unknown) => void>>();

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

			send(): void {
				throw new Error("send should not be called before websocket open");
			}

			close(): void {}
		}

		vi.stubGlobal("WebSocket", MockWebSocket);

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
		};

		const resultPromise = streamOpenAICodexResponses(model, context, {
			apiKey: token,
			sessionId: "ws-cleanup-session",
			transport: "auto",
			timeoutMs: 300_000,
			websocketConnectTimeoutMs: 50,
		}).result();

		await vi.advanceTimersByTimeAsync(50);
		await resultPromise;
		expect(getOpenAICodexWebSocketDebugStats("ws-cleanup-session")).toBeDefined();

		cleanupSessionResources("ws-cleanup-session");

		expect(getOpenAICodexWebSocketDebugStats("ws-cleanup-session")).toBeUndefined();
	});
});
