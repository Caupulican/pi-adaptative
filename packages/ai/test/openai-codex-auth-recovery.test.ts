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
} {
	const authorizations: string[] = [];
	const fedrampHeaders: Array<string | null> = [];

	class MockWebSocket {
		readyState = 1;
		private readonly connectionIndex: number;
		private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

		constructor(_url: string, protocols?: string | string[] | { headers?: Record<string, string> }) {
			this.connectionIndex = authorizations.length;
			const headers =
				protocols && typeof protocols === "object" && !Array.isArray(protocols) ? protocols.headers : undefined;
			const requestHeaders = new Headers(headers);
			authorizations.push(requestHeaders.get("Authorization") ?? "");
			fedrampHeaders.push(requestHeaders.get("X-OpenAI-Fedramp"));
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
		}

		private dispatch(type: string, event: unknown): void {
			for (const listener of this.listeners.get(type) ?? []) listener(event);
		}
	}

	vi.stubGlobal("WebSocket", MockWebSocket);
	return { authorizations, fedrampHeaders };
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
