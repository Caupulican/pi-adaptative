// @isolated: mocked fetch and WebSocket transport globals
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	streamSimpleOpenAICodexResponses,
} from "../src/providers/openai-codex-responses.ts";
import type { Model, ServiceTier } from "../src/types.ts";

const model: Model<"openai-codex-responses"> = {
	id: "gpt-6.1-sol",
	name: "GPT-6.1 Sol",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://example.invalid/backend-api",
	reasoning: true,
	input: ["text"],
	contextWindow: 128000,
	maxTokens: 1024,
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
	serviceTiers: [
		{ id: "priority", name: "Fast", description: "Priority" },
		{ id: "ultrafast", name: "Ultrafast", description: "Lower latency" },
	],
};
const apiKey = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.sig`;

function completed(tier: ServiceTier) {
	return {
		type: "response.completed",
		response: {
			id: "resp_fixture",
			status: "completed",
			service_tier: tier,
			output: [
				{
					type: "message",
					id: "msg_fixture",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "ok", annotations: [] }],
				},
			],
			usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
		},
	};
}

afterEach(() => {
	closeOpenAICodexWebSocketSessions();
	vi.unstubAllGlobals();
});

describe("Codex advertised Ultrafast transport", () => {
	it("cancels an admitted Ultra request before paid transport", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const result = await streamSimpleOpenAICodexResponses(
			model,
			{ messages: [] },
			{
				apiKey,
				transport: "sse",
				serviceTier: "ultrafast",
				signal: AbortSignal.abort(),
			},
		).result();
		expect(result.stopReason).toBe("aborted");
		expect(fetch).not.toHaveBeenCalled();
	});
	it.each(["sse", "websocket"] as const)(
		"aligns %s routing hint and body with the admitted tier",
		async (transport) => {
			let body: Record<string, unknown> | undefined;
			let headers: Headers | undefined;
			const handshakes: Headers[] = [];
			vi.stubGlobal(
				"fetch",
				vi.fn(async (_input: unknown, init?: RequestInit) => {
					body = JSON.parse(String(init?.body));
					headers = new Headers(init?.headers);
					return new Response(`data: ${JSON.stringify(completed("default"))}\n\n`);
				}),
			);
			vi.stubGlobal(
				"WebSocket",
				class {
					listeners = new Map<string, Set<(event: unknown) => void>>();
					readyState = 1;
					constructor(_url: string, init: { headers: Record<string, string> }) {
						headers = new Headers(init.headers);
						handshakes.push(headers);
						queueMicrotask(() => this.emit("open", {}));
					}
					addEventListener(type: string, listener: (event: unknown) => void) {
						const listeners = this.listeners.get(type) ?? new Set();
						listeners.add(listener);
						this.listeners.set(type, listeners);
					}
					removeEventListener(type: string, listener: (event: unknown) => void) {
						this.listeners.get(type)?.delete(listener);
					}
					emit(type: string, event: unknown) {
						for (const listener of this.listeners.get(type) ?? []) listener(event);
					}
					send(data: string) {
						body = JSON.parse(data);
						queueMicrotask(() => this.emit("message", { data: JSON.stringify(completed("default")) }));
					}
					close() {
						this.readyState = 3;
					}
				},
			);
			const result = await streamSimpleOpenAICodexResponses(
				model,
				{ messages: [] },
				{
					apiKey,
					transport,
					serviceTier: "ultrafast",
					sessionId: "ultrafast-routing-fixture",
					reasoning: "high",
					headers: { "x-codex-routing-hint": "model=forged;tier=priority" },
				},
			).result();
			expect(result.stopReason).toBe("stop");
			expect(body?.service_tier).toBe("ultrafast");
			expect(body?.reasoning).toMatchObject({ effort: "high" });
			expect(headers?.get("x-codex-routing-hint")).toBe("model=gpt-6.1-sol;tier=ultrafast");
			expect(result.usage.cost.estimate).toBe("base-rates");
			expect(
				result.diagnostics?.filter((diagnostic) => diagnostic.type === "service_tier_cost_estimate"),
			).toHaveLength(1);
			if (transport === "websocket") {
				for (let index = 0; index < 2; index++) {
					const next = await streamSimpleOpenAICodexResponses(
						model,
						{ messages: [] },
						{
							apiKey,
							transport: "websocket-cached",
							serviceTier: "priority",
							reasoning: "high",
							sessionId: "ultrafast-routing-fixture",
						},
					).result();
					expect(next.stopReason).toBe("stop");
					expect(body?.service_tier).toBe("priority");
				}
				expect(handshakes.map((handshake) => handshake.get("x-codex-routing-hint"))).toEqual([
					"model=gpt-6.1-sol;tier=ultrafast",
					"model=gpt-6.1-sol;tier=priority",
				]);
			}
		},
	);

	it.each([{ serviceTiers: undefined }, { serviceTiers: [] }])(
		"rejects Ultra without advertised metadata $serviceTiers before transport",
		async ({ serviceTiers }) => {
			const fetch = vi.fn();
			vi.stubGlobal("fetch", fetch);
			const result = await streamSimpleOpenAICodexResponses(
				{ ...model, serviceTiers },
				{ messages: [] },
				{ apiKey, serviceTier: "ultrafast", transport: "sse" },
			).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("does not advertise ultrafast");
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it("aligns routing and pricing with the final host payload", async () => {
		let headers: Headers | undefined;
		vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
			headers = new Headers(init?.headers);
			expect(JSON.parse(String(init?.body)).service_tier).toBe("ultrafast");
			return new Response(`data: ${JSON.stringify(completed("default"))}\n\n`);
		});
		const result = await streamSimpleOpenAICodexResponses(
			model,
			{ messages: [] },
			{
				apiKey,
				transport: "sse",
				serviceTier: "priority",
				onPayload: (payload) => ({ ...(payload as Record<string, unknown>), service_tier: "ultrafast" }),
			},
		).result();
		expect(result.stopReason).toBe("stop");
		expect(headers?.get("x-codex-routing-hint")).toBe("model=gpt-6.1-sol;tier=ultrafast");
		expect(result.usage.cost.estimate).toBe("base-rates");
	});

	it("does not let a rewritten host payload claim Ultra on a different unadvertised model", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const result = await streamSimpleOpenAICodexResponses(
			model,
			{ messages: [] },
			{
				apiKey,
				transport: "sse",
				serviceTier: "priority",
				onPayload: (payload) => ({
					...(payload as Record<string, unknown>),
					model: "other-model",
					service_tier: "ultrafast",
				}),
			},
		).result();
		expect(result.errorMessage).toContain("does not advertise ultrafast");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("uses a concrete response tier for pricing when the server selects priority", async () => {
		vi.stubGlobal("fetch", async () => new Response(`data: ${JSON.stringify(completed("priority"))}\n\n`));
		const result = await streamSimpleOpenAICodexResponses(
			model,
			{ messages: [] },
			{ apiKey, serviceTier: "ultrafast", transport: "sse" },
		).result();
		expect(result.stopReason).toBe("stop");
		expect(result.usage.cost.estimate).toBeUndefined();
		expect(result.usage.cost.input).toBeCloseTo(20 / 1_000_000);
	});
});
