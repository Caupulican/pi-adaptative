import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHistoryWork, registerProviderMessagePrefix } from "../src/history-work.ts";
import { streamAnthropic, streamSimpleAnthropic } from "../src/providers/anthropic.ts";
import { registerBuiltInApiProviders } from "../src/providers/register-builtins.ts";
import { getProviderResponseAccount, ProviderResponseAccountScope, stream } from "../src/stream.ts";
import type { Message, Model, ToolCall } from "../src/types.ts";
import { createEmptyUsage } from "../src/usage.ts";

const model: Model<"anthropic-messages"> = {
	id: "local-stream",
	name: "Local stream",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://unused.invalid",
	reasoning: true,
	input: ["text"],
	contextWindow: 1000,
	maxTokens: 100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const start = { type: "message_start", message: { id: "local", usage: { input_tokens: 2, output_tokens: 0 } } };
function frame(event: { type: string }): string {
	return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

afterEach(() => vi.unstubAllGlobals());

describe("Anthropic wire stream", () => {
	it.each(["simple-high", "simple-off", "explicit-effort"] as const)(
		"preserves mandatory Opus 5.5 thinking on a custom deployment for %s",
		async (route) => {
			const deployment = { ...model, name: "Claude Opus 5.5" };
			const bodies: Record<string, unknown>[] = [];
			vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
				bodies.push(await new Request(input, init).json());
				return new Response(frame(start) + frame({ type: "message_stop" }), {
					headers: { "content-type": "text/event-stream" },
				});
			});
			const options = { apiKey: "local-key", maxTokens: 37, temperature: 0.5 };
			const context = { messages: [] };
			const response =
				route === "explicit-effort"
					? streamAnthropic(deployment, context, { ...options, thinkingEnabled: false, effort: "high" })
					: streamSimpleAnthropic(deployment, context, {
							...options,
							reasoning: route === "simple-high" ? "high" : "off",
						});
			await response.result();
			expect(bodies).toHaveLength(1);
			expect(bodies[0].max_tokens).toBe(37);
			expect(bodies[0]).not.toHaveProperty("temperature");
			if (route === "simple-off") {
				expect(bodies[0]).not.toHaveProperty("thinking");
				expect(bodies[0]).not.toHaveProperty("output_config");
			} else {
				expect(bodies[0].thinking).toMatchObject({ type: "adaptive" });
				expect(bodies[0].output_config).toMatchObject({ effort: "high" });
			}
		},
	);

	it.each(["adapter", "caller"] as const)(
		"checks refusal provenance when the %s owns the SDK client",
		async (owner) => {
			registerBuiltInApiProviders();
			const sent: (string | null)[] = [];
			const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
				const request = new Request(input, init);
				expect(new URL(request.url).origin).toBe(model.baseUrl);
				sent.push(request.headers.get("x-api-key"));
				return Response.json(
					{ type: "error", error: { type: "invalid_request_error", message: "model_not_supported" } },
					{ status: 400 },
				);
			};
			vi.stubGlobal("fetch", fetch);
			vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "");
			try {
				const scope = new ProviderResponseAccountScope();
				const client =
					owner === "caller"
						? new Anthropic({ apiKey: "fixture-key-b", authToken: null, baseURL: model.baseUrl, fetch })
						: undefined;
				const response = stream(
					model,
					{ messages: [] },
					scope.bind({
						apiKey: "fixture-key-a",
						providerAccountKey: "anthropic#account-a",
						maxRetries: 0,
						client,
					}),
				);
				const message = scope.project(await response.result());
				expect(sent).toEqual([owner === "caller" ? "fixture-key-b" : "fixture-key-a"]);
				expect(message.errorMessage).toContain("model_not_supported");
				expect(getProviderResponseAccount(message)?.accountKey).toBe(
					owner === "caller" ? undefined : "anthropic#account-a",
				);
			} finally {
				vi.unstubAllEnvs();
			}
		},
	);

	it("reuses history while resolving provisional tool output and preserving historical names", async () => {
		const bodies: { messages: { content: unknown }[] }[] = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			bodies.push(await new Request(input, init).json());
			return new Response(frame(start) + frame({ type: "message_stop" }), {
				headers: { "content-type": "text/event-stream" },
			});
		});
		const options = { apiKey: "local-key", cacheRetention: "short" } as const;
		const tool = (id: string, name: string): ToolCall => ({ type: "toolCall", id, name, arguments: {} });
		const assistant = (content: ToolCall[]): Message => ({
			role: "assistant",
			model: model.id,
			api: model.api,
			provider: model.provider,
			timestamp: 2,
			stopReason: "toolUse",
			usage: createEmptyUsage(),
			content,
		});
		const result = (call: ToolCall): Message => ({
			role: "toolResult",
			toolName: call.name,
			toolCallId: call.id,
			isError: false,
			timestamp: 3,
			content: [{ type: "text", text: call.id }],
		});
		const first = tool("first", "a.b");
		const second = tool("second", "a/b");
		const third = tool("third", second.name);
		const prior: Message[] = [
			{ role: "user", timestamp: 1, content: [{ type: "text", text: "Boundary", cacheBoundary: true }] },
			assistant([first, second]),
			result(first),
		];
		const next = [...prior, result(second), assistant([third]), result(third)];
		Object.freeze(prior);
		Object.freeze(next);
		registerProviderMessagePrefix(prior, undefined, 0);
		registerProviderMessagePrefix(next, prior, prior.length);
		const work = observeHistoryWork(next);

		for (const messages of [prior, next, [...next]]) {
			expect((await streamAnthropic(model, { messages }, options).result()).stopReason).toBe("stop");
		}
		expect(bodies[1]).toEqual(bodies[2]);
		expect(bodies[1]?.messages[1]?.content).toMatchObject([{ name: "a_b" }, { name: "a_b_2" }]);
		expect(bodies[1]?.messages[2]?.content).toMatchObject([
			{ tool_use_id: first.id, content: first.id },
			{ tool_use_id: second.id, content: second.id },
		]);
		expect(bodies[1]?.messages[3]?.content).toMatchObject([{ name: "a_b_2" }]);
		expect(work.wireRowsConverted).toBeLessThan(next.length);
	});

	it("publishes seeded content and replaces the signature", async () => {
		const events = [
			start,
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "thinking", thinking: "seed", signature: "old" },
			},
			{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "new" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "content_block_start", index: 1, content_block: { type: "text", text: "answer" } },
			{ type: "content_block_stop", index: 1 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
			{ type: "message_stop" },
		];
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					new Response(events.map(frame).join(""), { headers: { "content-type": "text/event-stream" } }),
				),
		);
		const stream = streamAnthropic(model, { messages: [] }, { apiKey: "local-key" });
		const deltas: string[] = [];
		for await (const event of stream) {
			if (event.type === "text_delta" || event.type === "thinking_delta") deltas.push(event.delta);
		}
		const output = await stream.result();
		expect(output.stopReason).toBe("stop");
		expect(deltas).toEqual(["seed", "answer"]);
		expect(output.content[0]).toEqual({ type: "thinking", thinking: "seed", thinkingSignature: "new" });
		expect(output.usage.totalTokens).toBe(5);
	});

	it.each(["", ":keepalive\n\n", frame(start)])("rejects incomplete streams %j", async (wire) => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(wire, { headers: { "content-type": "text/event-stream" } })),
		);
		const output = await streamAnthropic(model, { messages: [] }, { apiKey: "local-key" }).result();
		expect(output.stopReason).toBe("error");
		expect(output.errorMessage).toContain("complete message_start/message_stop");
	});

	it("cancels acquired bodies if the response hook fails", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(body, { headers: { "content-type": "text/event-stream" } })),
		);
		const output = await streamAnthropic(
			model,
			{ messages: [] },
			{
				apiKey: "local-key",
				onResponse: () => {
					throw new Error("hook failure");
				},
			},
		).result();
		expect(output.stopReason).toBe("error");
		// The stream publishes its terminal error before the enclosing cleanup's awaited microtask.
		await Promise.resolve();
		expect(cancelled).toBe(true);
		expect(body.locked).toBe(false);
	});
});
