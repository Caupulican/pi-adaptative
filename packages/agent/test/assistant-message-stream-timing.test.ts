import { EventStream } from "@caupulican/pi-ai/event-stream";
import type { AssistantMessage, AssistantMessageEvent, Message, Model } from "@caupulican/pi-ai/types";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentLoopConfig, AgentMessage } from "../src/types.ts";

/**
 * D1 observability regression test for `AssistantMessage.firstTokenAt` / `.streamEndAt` (see
 * types.ts). Both are stamped by `streamAssistantResponse` in agent-loop.ts as it consumes the
 * provider event stream.
 *
 * Ordering note, verified against the real provider implementations rather than assumed: every
 * provider in `packages/ai/src/providers` (directly, or via the shared `createAssistantMessage` /
 * `completeAssistantStream` helpers in `provider-runtime.ts`) builds its output `AssistantMessage`
 * object ONCE, up front, with `timestamp: Date.now()` captured before the request is even sent, then
 * mutates that SAME object through the whole stream and hands it back unchanged in the `done`/`error`
 * event - `timestamp` is never refreshed at stream end. So for a real stream the true ordering is
 * `message.timestamp <= firstTokenAt <= streamEndAt`: `timestamp` is the EARLIEST of the three, not
 * the latest. This test's mock mirrors that real construct-once-at-start behavior instead of
 * asserting an ordering that does not hold for any provider in this codebase.
 */

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8_192,
		maxTokens: 2_048,
	};
}

function createUserMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function baseAssistantMessage(model: Model<"openai-responses">, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(),
		stopReason: "stop",
		timestamp,
	};
}

async function runOneTurn(streamFn: () => MockAssistantStream): Promise<AssistantMessage | undefined> {
	const model = createModel();
	const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
	const config: AgentLoopConfig = { model, convertToLlm: identityConverter };
	const loop = agentLoop([createUserMessage("hi")], context, config, undefined, streamFn);
	for await (const _event of loop) {
		// drain
	}
	const messages = await loop.result();
	return messages.find((m): m is AssistantMessage => m.role === "assistant");
}

describe("assistant message stream timing (D1)", () => {
	it("stamps firstTokenAt and streamEndAt, ordered after message.timestamp, on a normal turn", async () => {
		const streamFn = (): MockAssistantStream => {
			const stream = new MockAssistantStream();
			queueMicrotask(async () => {
				// Mirrors real provider construction: `timestamp` is fixed at request start, before
				// any content streams - see the module doc comment above.
				const model = createModel();
				const requestStartedAt = Date.now();
				const base = baseAssistantMessage(model, requestStartedAt);
				stream.push({ type: "start", partial: base });
				await delay(15);
				const opened = { ...base, content: [{ type: "text" as const, text: "" }] };
				stream.push({ type: "text_start", contentIndex: 0, partial: opened });
				await delay(15);
				const withDelta = { ...base, content: [{ type: "text" as const, text: "Hello" }] };
				stream.push({ type: "text_delta", contentIndex: 0, delta: "Hello", partial: withDelta });
				await delay(15);
				const final = { ...base, content: [{ type: "text" as const, text: "Hello" }] };
				stream.push({ type: "text_end", contentIndex: 0, content: "Hello", partial: final });
				stream.push({ type: "done", reason: "stop", message: final });
			});
			return stream;
		};

		const assistant = await runOneTurn(streamFn);

		expect(assistant).toBeDefined();
		expect(typeof assistant?.firstTokenAt).toBe("number");
		expect(typeof assistant?.streamEndAt).toBe("number");
		// True ordering (see module doc comment): timestamp is EARLIEST, not latest.
		expect(assistant?.timestamp).toBeLessThan(assistant?.firstTokenAt as number);
		expect(assistant?.firstTokenAt as number).toBeLessThanOrEqual(assistant?.streamEndAt as number);
	});

	it("leaves firstTokenAt absent - never 0, never a copy of streamEndAt - when the stream aborts before any content arrives", async () => {
		const streamFn = (): MockAssistantStream => {
			const stream = new MockAssistantStream();
			queueMicrotask(async () => {
				const model = createModel();
				const base = baseAssistantMessage(model, Date.now());
				stream.push({ type: "start", partial: base });
				await delay(10);
				// The pi-ai stream contract's own definition of abort: a well-formed `error` event
				// carrying stopReason "aborted" - no `_delta` event was ever pushed before it.
				const aborted: AssistantMessage = {
					...base,
					stopReason: "aborted",
					errorMessage: "aborted before any content",
				};
				stream.push({ type: "error", reason: "aborted", error: aborted });
			});
			return stream;
		};

		const assistant = await runOneTurn(streamFn);

		expect(assistant).toBeDefined();
		expect(assistant?.stopReason).toBe("aborted");
		expect(assistant && "firstTokenAt" in assistant).toBe(false);
		expect(assistant?.firstTokenAt).toBeUndefined();
		// streamEndAt is still meaningful here: the stream DID terminate (the `error` event above
		// IS how abort surfaces per the pi-ai contract) - only "a token arrived" is false, not "the
		// stream ended". Only firstTokenAt is conditional on content actually having streamed.
		expect(typeof assistant?.streamEndAt).toBe("number");
	});
});
