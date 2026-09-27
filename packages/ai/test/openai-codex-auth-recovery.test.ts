import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	streamSimpleOpenAICodexResponses,
} from "../src/providers/openai-codex-responses.ts";
import type { Model, SimpleStreamOptions } from "../src/types.ts";

const apiKey = `e30.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } }),
).toString("base64url")}.signature`;
const replacementKey = `${apiKey}-rotated`;

const model: Model<"openai-codex-responses"> = {
	id: "fixture",
	name: "Fixture",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

const unauthorized = () => new Response(JSON.stringify({ error: { message: "Unauthorized token" } }), { status: 401 });
const invalid = () => new Response(JSON.stringify({ error: { message: "Invalid request body" } }), { status: 400 });
const networkDown = (): Response => {
	throw new TypeError("fetch failed");
};
const unavailable = () => new Response(JSON.stringify({ error: { message: "Service unavailable" } }), { status: 503 });

const websocketUnauthorized = {
	type: "error",
	status: 401,
	error: { code: "invalid_api_key", message: "Expired token" },
};

const websocketSuccess = [
	{
		type: "response.output_item.added",
		item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
	},
	{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
	{ type: "response.output_text.delta", delta: "Recovered" },
	{
		type: "response.output_item.done",
		item: {
			type: "message",
			id: "msg_1",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "Recovered" }],
		},
	},
	{
		type: "response.completed",
		response: {
			id: "resp_1",
			status: "completed",
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				total_tokens: 2,
				input_tokens_details: { cached_tokens: 0 },
			},
		},
	},
];

type WebSocketScript =
	| ReadonlyArray<Record<string, unknown>>
	| ((dispatch: (type: string, event: unknown) => void) => void);

function installWebSocketResponses(scripts: ReadonlyArray<WebSocketScript>): {
	authorizations: string[];
	fedrampHeaders: Array<string | null>;
	routingHeaders: Array<string | null>;
	urls: string[];
} {
	const authorizations: string[] = [];
	const fedrampHeaders: Array<string | null> = [];
	const routingHeaders: Array<string | null> = [];
	const urls: string[] = [];

	class MockWebSocket {
		readyState = 1;
		private readonly connectionIndex: number;
		private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

		constructor(url: string, protocols?: string | string[] | { headers?: Record<string, string> }) {
			this.connectionIndex = authorizations.length;
			const headers =
				protocols && typeof protocols === "object" && !Array.isArray(protocols) ? protocols.headers : undefined;
			const requestHeaders = new Headers(headers);
			urls.push(url);
			authorizations.push(requestHeaders.get("Authorization") ?? "");
			fedrampHeaders.push(requestHeaders.get("X-OpenAI-Fedramp"));
			routingHeaders.push(requestHeaders.get("X-Routing-Key"));
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
				const script = scripts[this.connectionIndex] ?? [];
				if (typeof script === "function") {
					script((type, event) => this.dispatch(type, event));
					return;
				}
				for (const event of script) {
					this.dispatch("message", { data: JSON.stringify(event) });
				}
			});
		}

		close(): void {
			this.readyState = 3;
			this.dispatch("close", { code: 1000, reason: "client closed", wasClean: true });
		}

		private dispatch(type: string, event: unknown): void {
			for (const listener of this.listeners.get(type) ?? []) listener(event);
		}
	}

	vi.stubGlobal("WebSocket", MockWebSocket);
	return { authorizations, fedrampHeaders, routingHeaders, urls };
}

async function run(responses: Array<() => Response>, options: Partial<SimpleStreamOptions>) {
	const sent: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_input: unknown, init?: RequestInit) => {
			sent.push(new Headers(init?.headers).get("Authorization") ?? "");
			const next = responses[sent.length - 1];
			if (!next) throw new Error("captured");
			return next();
		}),
	);
	const result = await streamSimpleOpenAICodexResponses(
		model,
		{ messages: [] },
		{ apiKey, transport: "sse", maxRetryDelayMs: 1, ...options },
	).result();
	return { sent, errorMessage: result.errorMessage ?? "" };
}

afterEach(() => {
	closeOpenAICodexWebSocketSessions();
	vi.unstubAllGlobals();
});

describe("OpenAI Codex auth recovery", () => {
	it("replays a WebSocket response rejected with 401 using the recovered credential", async () => {
		const harness = installWebSocketResponses([[websocketUnauthorized], websocketSuccess]);
		const onAuthRejection = vi.fn(() => replacementKey);

		const result = await streamSimpleOpenAICodexResponses(
			model,
			{ messages: [] },
			{
				apiKey,
				transport: "websocket",
				maxRetries: 0,
				onAuthRejection,
				credentialHeadersFor: (key) => (key === replacementKey ? { "X-OpenAI-Fedramp": "true" } : undefined),
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "Recovered" }));
		expect(harness.authorizations).toEqual([`Bearer ${apiKey}`, `Bearer ${replacementKey}`]);
		expect(harness.fedrampHeaders).toEqual([null, "true"]);
		expect(onAuthRejection).toHaveBeenCalledTimes(1);
	});

	it("keeps the recovered credential's socket as the session cache owner", async () => {
		const harness = installWebSocketResponses([[websocketUnauthorized], websocketSuccess]);
		const sessionId = "recovered-websocket-owner";

		const recovered = await streamSimpleOpenAICodexResponses(
			model,
			{ messages: [] },
			{
				apiKey,
				sessionId,
				transport: "websocket",
				onAuthRejection: () => replacementKey,
			},
		).result();
		const reused = await streamSimpleOpenAICodexResponses(
			model,
			{ messages: [] },
			{ apiKey: replacementKey, sessionId, transport: "websocket" },
		).result();

		expect(recovered.stopReason).toBe("stop");
		expect(reused.stopReason).toBe("stop");
		expect(harness.authorizations).toEqual([`Bearer ${apiKey}`, `Bearer ${replacementKey}`]);
	});

	it("replaces a cached session socket when the provider endpoint changes", async () => {
		const harness = installWebSocketResponses([websocketSuccess, websocketSuccess]);
		const sessionId = "websocket-endpoint-owner";
		const replacementModel = { ...model, baseUrl: "https://replacement.invalid" };

		await streamSimpleOpenAICodexResponses(
			model,
			{ messages: [] },
			{ apiKey, sessionId, transport: "websocket" },
		).result();
		await streamSimpleOpenAICodexResponses(
			replacementModel,
			{ messages: [] },
			{ apiKey, sessionId, transport: "websocket" },
		).result();
		await streamSimpleOpenAICodexResponses(
			replacementModel,
			{ messages: [] },
			{ apiKey, sessionId, transport: "websocket" },
		).result();

		expect(harness.urls).toEqual([
			"wss://example.invalid/codex/responses",
			"wss://replacement.invalid/codex/responses",
		]);
	});

	it("replaces a cached session socket when effective connection headers change", async () => {
		const harness = installWebSocketResponses([websocketSuccess, websocketSuccess]);
		const sessionId = "websocket-header-owner";

		await streamSimpleOpenAICodexResponses(
			model,
			{ messages: [] },
			{ apiKey, sessionId, transport: "websocket", headers: { "X-Routing-Key": "route-a" } },
		).result();
		await streamSimpleOpenAICodexResponses(
			model,
			{ messages: [] },
			{ apiKey, sessionId, transport: "websocket", headers: { "X-Routing-Key": "route-b" } },
		).result();

		expect(harness.routingHeaders).toEqual(["route-a", "route-b"]);
	});

	it("does not close a busy old-identity socket while installing its replacement", async () => {
		let releaseHeldResponse: (() => void) | undefined;
		installWebSocketResponses([
			(dispatch) => {
				releaseHeldResponse = () => {
					for (const event of websocketSuccess) dispatch("message", { data: JSON.stringify(event) });
				};
			},
			websocketSuccess,
		]);
		const sessionId = "websocket-busy-identity-handoff";
		const firstResult = streamSimpleOpenAICodexResponses(
			model,
			{ messages: [] },
			{ apiKey, sessionId, transport: "websocket" },
		).result();
		await vi.waitFor(() => expect(releaseHeldResponse).toBeTypeOf("function"));

		const replacementResult = await streamSimpleOpenAICodexResponses(
			{ ...model, baseUrl: "https://replacement.invalid" },
			{ messages: [] },
			{ apiKey, sessionId, transport: "websocket" },
		).result();
		releaseHeldResponse?.();
		const originalResult = await firstResult;

		expect(replacementResult.stopReason).toBe("stop");
		expect(originalResult.stopReason).toBe("stop");
	});

	it("ignores a stale idle-expiry callback after the cached socket is rearmed", async () => {
		const timerSpy = vi.spyOn(globalThis, "setTimeout");
		const harness = installWebSocketResponses([websocketSuccess]);
		const sessionId = "websocket-stale-expiry";

		try {
			await streamSimpleOpenAICodexResponses(
				model,
				{ messages: [] },
				{ apiKey, sessionId, transport: "websocket" },
			).result();
			const staleExpiry = timerSpy.mock.calls.find(([, delay]) => delay === 5 * 60 * 1000)?.[0];
			expect(staleExpiry).toBeTypeOf("function");

			await streamSimpleOpenAICodexResponses(
				model,
				{ messages: [] },
				{ apiKey, sessionId, transport: "websocket" },
			).result();
			if (typeof staleExpiry === "function") staleExpiry();
			await streamSimpleOpenAICodexResponses(
				model,
				{ messages: [] },
				{ apiKey, sessionId, transport: "websocket" },
			).result();

			expect(harness.urls).toEqual(["wss://example.invalid/codex/responses"]);
		} finally {
			for (const result of timerSpy.mock.results) {
				if (result.type === "return") clearTimeout(result.value as ReturnType<typeof setTimeout>);
			}
		}
	});

	it("processes an already-delivered terminal Blob frame before the following socket close", async () => {
		let releaseTerminalDecode: (() => void) | undefined;
		installWebSocketResponses([
			(dispatch) => {
				const terminalBytes = new TextEncoder().encode(JSON.stringify(websocketSuccess.at(-1)));
				dispatch("message", {
					data: {
						arrayBuffer: () =>
							new Promise<ArrayBuffer>((resolve) => {
								releaseTerminalDecode = () => resolve(terminalBytes.buffer as ArrayBuffer);
							}),
					},
				});
				dispatch("close", { code: 1000, reason: "response complete", wasClean: true });
				setTimeout(() => releaseTerminalDecode?.(), 0);
			},
		]);

		const result = await streamSimpleOpenAICodexResponses(
			model,
			{ messages: [] },
			{ apiKey, transport: "websocket" },
		).result();

		expect(result.stopReason).toBe("stop");
	});

	it("decodes WebSocket Blob frames in wire arrival order", async () => {
		let releaseDeltaDecode: (() => void) | undefined;
		installWebSocketResponses([
			(dispatch) => {
				for (const event of websocketSuccess.slice(0, 2)) {
					dispatch("message", { data: JSON.stringify(event) });
				}
				const deltaBytes = new TextEncoder().encode(JSON.stringify(websocketSuccess[2]));
				dispatch("message", {
					data: {
						arrayBuffer: () =>
							new Promise<ArrayBuffer>((resolve) => {
								releaseDeltaDecode = () => resolve(deltaBytes.buffer as ArrayBuffer);
							}),
					},
				});
				const terminalBytes = new TextEncoder().encode(JSON.stringify(websocketSuccess.at(-1)));
				dispatch("message", { data: { arrayBuffer: async () => terminalBytes.buffer as ArrayBuffer } });
				setTimeout(() => releaseDeltaDecode?.(), 0);
			},
		]);

		const result = await streamSimpleOpenAICodexResponses(
			model,
			{ messages: [] },
			{ apiKey, transport: "websocket" },
		).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "Recovered" }));
	});

	it("rejects an oversized WebSocket Blob before materializing its bytes", async () => {
		const terminalBytes = new TextEncoder().encode(JSON.stringify(websocketSuccess.at(-1)));
		const arrayBuffer = vi.fn(async () => terminalBytes.buffer as ArrayBuffer);
		installWebSocketResponses([
			(dispatch) => {
				dispatch("message", { data: JSON.stringify(websocketSuccess[0]) });
				dispatch("message", { data: { size: 8 * 1024 * 1024 + 1, arrayBuffer } });
			},
		]);
		const fetchMock = vi.fn(async () => {
			throw new Error("must not replay after WebSocket output");
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await streamSimpleOpenAICodexResponses(
			model,
			{ messages: [] },
			{ apiKey, transport: "websocket" },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("WebSocket frame exceeded");
		expect(arrayBuffer).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("accepts a WebSocket Blob reported at the frame-size boundary", async () => {
		const terminalBytes = new TextEncoder().encode(JSON.stringify(websocketSuccess.at(-1)));
		const arrayBuffer = vi.fn(async () => terminalBytes.buffer as ArrayBuffer);
		installWebSocketResponses([
			(dispatch) => {
				dispatch("message", { data: { size: 8 * 1024 * 1024, arrayBuffer } });
			},
		]);

		const result = await streamSimpleOpenAICodexResponses(
			model,
			{ messages: [] },
			{ apiKey, transport: "websocket" },
		).result();

		expect(result.stopReason).toBe("stop");
		expect(arrayBuffer).toHaveBeenCalledTimes(1);
	});

	it("rechecks WebSocket Blob size after materializing untrusted bytes", async () => {
		const arrayBuffer = vi.fn(async () => new ArrayBuffer(8 * 1024 * 1024 + 1));
		installWebSocketResponses([
			(dispatch) => {
				dispatch("message", { data: JSON.stringify(websocketSuccess[0]) });
				dispatch("message", { data: { size: 1, arrayBuffer } });
			},
		]);
		const fetchMock = vi.fn(async () => {
			throw new Error("must not replay after WebSocket output");
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await streamSimpleOpenAICodexResponses(
			model,
			{ messages: [] },
			{ apiKey, transport: "websocket" },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("WebSocket frame exceeded");
		expect(arrayBuffer).toHaveBeenCalledTimes(1);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("fails a stalled WebSocket decoder when its pending frame backlog reaches the bound", async () => {
		installWebSocketResponses([
			(dispatch) => {
				dispatch("message", { data: { arrayBuffer: () => new Promise<ArrayBuffer>(() => {}) } });
				for (let index = 0; index < 256; index++) {
					dispatch("message", { data: "{}" });
				}
			},
		]);
		const fetchMock = vi.fn(async () => invalid());
		vi.stubGlobal("fetch", fetchMock);

		const result = await streamSimpleOpenAICodexResponses(
			model,
			{ messages: [] },
			{ apiKey, transport: "websocket", timeoutMs: 20 },
		).result();

		expect(result.stopReason).toBe("error");
		expect(JSON.stringify(result.diagnostics)).toContain("pending frame limit");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("accepts a synchronous WebSocket burst at the pending frame bound", async () => {
		installWebSocketResponses([
			(dispatch) => {
				for (let index = 0; index < 255; index++) {
					dispatch("message", { data: "{}" });
				}
				dispatch("message", { data: JSON.stringify(websocketSuccess.at(-1)) });
			},
		]);

		const result = await streamSimpleOpenAICodexResponses(
			model,
			{ messages: [] },
			{ apiKey, transport: "websocket" },
		).result();

		expect(result.stopReason).toBe("stop");
	});

	it("does not replay a WebSocket 401 when credential recovery declines (control)", async () => {
		const harness = installWebSocketResponses([[websocketUnauthorized]]);
		const onAuthRejection = vi.fn(() => undefined);

		const result = await streamSimpleOpenAICodexResponses(
			model,
			{ messages: [] },
			{
				apiKey,
				transport: "websocket",
				maxRetries: 2,
				onAuthRejection,
			},
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Expired token");
		expect(harness.authorizations).toEqual([`Bearer ${apiKey}`]);
		expect(onAuthRejection).toHaveBeenCalledTimes(1);
	});

	it("shares the one-shot auth recovery budget when WebSocket falls back to SSE", async () => {
		installWebSocketResponses([
			[websocketUnauthorized],
			(dispatch) => dispatch("close", { code: 1006, reason: "network lost", wasClean: false }),
		]);
		const fetchMock = vi.fn(async () => unauthorized());
		vi.stubGlobal("fetch", fetchMock);
		const onAuthRejection = vi.fn().mockReturnValueOnce(replacementKey).mockReturnValueOnce(undefined);

		const result = await streamSimpleOpenAICodexResponses(
			model,
			{ messages: [] },
			{
				apiKey,
				transport: "auto",
				maxRetries: 0,
				onAuthRejection,
			},
		).result();

		expect(result.stopReason).toBe("error");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(onAuthRejection).toHaveBeenCalledTimes(1);
	});

	it("replays a rejected request once with the recovered key even when no retries are allowed", async () => {
		const onAuthRejection = vi.fn(() => replacementKey);
		const { sent } = await run([unauthorized], { maxRetries: 0, onAuthRejection });
		expect(sent).toEqual([`Bearer ${apiKey}`, `Bearer ${replacementKey}`]);
		expect(onAuthRejection).toHaveBeenCalledTimes(1);
	});

	it("reports the rejection itself when no replacement key is recovered", async () => {
		const { sent, errorMessage } = await run([unauthorized], { maxRetries: 0, onAuthRejection: () => undefined });
		expect(sent).toHaveLength(1);
		expect(errorMessage).toContain("Unauthorized token");
		expect(errorMessage).not.toContain("Failed after retries");
	});

	it("ends the request when the replay is rejected too, without spending transient retries", async () => {
		const onAuthRejection = vi.fn(() => replacementKey);
		const { sent, errorMessage } = await run([unauthorized, unauthorized, unauthorized], {
			maxRetries: 2,
			onAuthRejection,
		});
		expect(sent).toEqual([`Bearer ${apiKey}`, `Bearer ${replacementKey}`]);
		expect(onAuthRejection).toHaveBeenCalledTimes(1);
		expect(errorMessage).toContain("Unauthorized token");
	});

	it("never retries a final HTTP error", async () => {
		const { sent, errorMessage } = await run([invalid, invalid, invalid], { maxRetries: 2 });
		expect(sent).toHaveLength(1);
		expect(errorMessage).toContain("Invalid request body");
	});

	it("keeps the retry budget for other failures (control)", async () => {
		expect((await run([unavailable, unavailable, unavailable], { maxRetries: 0 })).sent).toHaveLength(1);
		expect((await run([unavailable, unavailable, unavailable], { maxRetries: 2 })).sent).toHaveLength(3);
		expect((await run([networkDown, networkDown, networkDown], { maxRetries: 2 })).sent).toHaveLength(3);
	});
});
