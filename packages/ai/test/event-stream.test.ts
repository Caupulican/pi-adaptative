import { describe, expect, it } from "vitest";
import { registerApiProvider, unregisterApiProviders } from "../src/api-registry.ts";
import { complete } from "../src/stream.ts";
import type { Api, AssistantMessage, Model, Tool } from "../src/types.ts";
import { createEmptyUsage } from "../src/usage.ts";
import { createAssistantMessageEventStream, EventStream } from "../src/utils/event-stream.ts";

function settleOrTimeout<T>(promise: Promise<T>, ms = 50): Promise<T | "timeout"> {
	return Promise.race([promise, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms))]);
}

function createPartial(model: { api: string; provider: string; id: string }, text = "partial"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createEmptyUsage(),
		stopReason: "stop",
		timestamp: 1,
	};
}

function streamThatEndsWithoutDone(model: Model<Api>): ReturnType<typeof createAssistantMessageEventStream> {
	const stream = createAssistantMessageEventStream();
	const partial = createPartial(model);
	stream.push({ type: "start", partial });
	stream.end();
	return stream;
}

describe("EventStream burst queue", () => {
	it("drains a large producer burst in order and preserves the terminal result", async () => {
		const stream = new EventStream<number, number>(
			(event) => event === 9_999,
			(event) => event,
		);
		for (let event = 0; event < 10_000; event++) stream.push(event);

		const received: number[] = [];
		for await (const event of stream) received.push(event);

		expect(received).toHaveLength(10_000);
		expect(received[0]).toBe(0);
		expect(received[5_000]).toBe(5_000);
		expect(received[9_999]).toBe(9_999);
		expect(await stream.result()).toBe(9_999);
	});

	it("settles result() when end() is called without a terminal event", async () => {
		const stream = new EventStream<number, number>(
			(event) => event < 0,
			(event) => event,
		);
		stream.push(1);
		stream.end();

		const settled = await settleOrTimeout(
			stream.result().then(
				() => "resolved" as const,
				() => "rejected" as const,
			),
		);
		expect(settled).toBe("rejected");
	});

	it("does not reject result() when a complete event already settled it", async () => {
		const stream = new EventStream<number, number>(
			(event) => event === 7,
			(event) => event,
		);
		stream.push(7);
		stream.end();
		expect(await stream.result()).toBe(7);
	});
});

describe("AssistantMessageEventStream terminal settlement", () => {
	it("resolves result() when a fast stream ends without pushing done", async () => {
		const stream = createAssistantMessageEventStream();
		const partial = createPartial({ api: "openai-responses", provider: "test", id: "test" }, "fast");
		stream.push({ type: "start", partial });
		stream.end();

		const settled = await settleOrTimeout(stream.result());
		expect(settled).not.toBe("timeout");
		if (settled === "timeout") return;
		expect(settled.stopReason).toBe("error");
		expect(settled.errorMessage).toContain("stream ended without a terminal result");
		expect(settled.content).toEqual([{ type: "text", text: "fast" }]);
	});
});

describe("complete() on a provider that ends without done", () => {
	it("does not hang for a raw stream or a text-protocol wrapper", async () => {
		const sourceId = "event-stream-fast-eof";
		const api = "event-stream-fast-eof";
		const endWithoutDone = (model: Model<Api>) => streamThatEndsWithoutDone(model);
		registerApiProvider({ api, stream: endWithoutDone, streamSimple: endWithoutDone }, sourceId);

		const model: Model<typeof api> = {
			id: "fast-eof",
			name: "fast-eof",
			api,
			provider: "test",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		};
		const tools: Tool[] = [
			{
				name: "echo",
				description: "Echo",
				parameters: { type: "object", properties: { value: { type: "string" } } } as Tool["parameters"],
			},
		];
		const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 1 }], tools };

		try {
			const settled = await settleOrTimeout(complete(model, context), 200);
			expect(settled).not.toBe("timeout");
			if (settled === "timeout") return;
			expect(settled.stopReason).toBe("error");
			expect(settled.errorMessage).toContain("stream ended without a terminal result");

			const protocolSettled = await settleOrTimeout(complete(model, context, { textToolCallProtocol: true }), 200);
			expect(protocolSettled).not.toBe("timeout");
			if (protocolSettled === "timeout") return;
			expect(protocolSettled.stopReason).toBe("error");
			expect(protocolSettled.errorMessage).toContain("stream ended without a terminal result");
		} finally {
			unregisterApiProviders(sourceId);
		}
	});
});
