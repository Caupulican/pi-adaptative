import type { Context, Model } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamProxy } from "../src/proxy.ts";

function createModel(): Model<any> {
	return {
		id: "model",
		name: "model",
		provider: "test",
		api: "test",
		baseUrl: "https://example.test",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000,
		maxTokens: 100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function sseResponse(text: string): Response {
	return new Response(new TextEncoder().encode(text), { status: 200, statusText: "OK" });
}

describe("streamProxy", () => {
	afterEach(() => vi.restoreAllMocks());

	it("turns proxy stream close without a terminal event into an error result", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				sseResponse(
					[
						'data: {"type":"start"}',
						'data: {"type":"text_start","contentIndex":0}',
						'data: {"type":"text_delta","contentIndex":0,"delta":"partial"}',
						"",
					].join("\n"),
				),
			),
		);

		const stream = streamProxy(createModel(), { messages: [] } as unknown as Context, {
			proxyUrl: "https://proxy.test",
			authToken: "token",
		});

		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("stream ended before terminal event");
		const content = result.content[0];
		expect(content?.type).toBe("text");
		if (content?.type === "text") {
			expect(content.text).toBe("partial");
			const descriptor = Object.getOwnPropertyDescriptor(content, "text");
			expect(descriptor?.get).toBeUndefined();
			expect(descriptor?.value).toBe("partial");
		}
	});

	it("preserves background interaction mode across the proxy boundary", async () => {
		let requestBody: string | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				requestBody = typeof init?.body === "string" ? init.body : undefined;
				return sseResponse("");
			}),
		);

		const stream = streamProxy(createModel(), { messages: [] } as unknown as Context, {
			proxyUrl: "https://proxy.test",
			authToken: "token",
			interactionMode: "background",
		});
		await stream.result();

		expect(requestBody).toBeDefined();
		const request = JSON.parse(requestBody ?? "{}") as { options?: { interactionMode?: string } };
		expect(request.options?.interactionMode).toBe("background");
	});

	it("reconstructs lazy text, thinking, and tool arguments without changing stream events", async () => {
		const usage = {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				sseResponse(
					[
						'data: {"type":"start"}',
						'data: {"type":"text_start","contentIndex":0}',
						'data: {"type":"text_delta","contentIndex":0,"delta":"hel"}',
						'data: {"type":"text_delta","contentIndex":0,"delta":"lo"}',
						'data: {"type":"text_end","contentIndex":0}',
						'data: {"type":"thinking_start","contentIndex":1}',
						'data: {"type":"thinking_delta","contentIndex":1,"delta":"plan"}',
						'data: {"type":"thinking_end","contentIndex":1}',
						'data: {"type":"toolcall_start","contentIndex":2,"id":"call-1","toolName":"read"}',
						'data: {"type":"toolcall_delta","contentIndex":2,"delta":"{\\"path\\":"}',
						'data: {"type":"toolcall_delta","contentIndex":2,"delta":"\\"file.ts\\"}"}',
						`data: ${JSON.stringify({ type: "done", reason: "toolUse", usage })}`,
						"",
					].join("\n"),
				),
			),
		);

		const stream = streamProxy(createModel(), { messages: [] } as unknown as Context, {
			proxyUrl: "https://proxy.test",
			authToken: "token",
		});
		const observedText: string[] = [];
		for await (const event of stream) {
			if (event.type === "text_delta") {
				const content = event.partial.content[event.contentIndex];
				if (content.type === "text") observedText.push(content.text);
			}
		}

		const result = await stream.result();
		// Queued proxy events share the live partial object, matching the existing stream contract.
		expect(observedText).toEqual(["hello", "hello"]);
		expect(result.content).toEqual([
			{ type: "text", text: "hello", textSignature: undefined },
			{ type: "thinking", thinking: "plan", thinkingSignature: undefined },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "file.ts" } },
		]);
	});
});
