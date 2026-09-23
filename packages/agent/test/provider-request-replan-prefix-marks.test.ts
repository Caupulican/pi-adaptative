import { EventStream } from "@caupulican/pi-ai/event-stream";
import type { AssistantMessage, AssistantMessageEvent, Message, Model } from "@caupulican/pi-ai/types";
import { describe, expect, it } from "vitest";
import { startPlannedAgentProviderRequest } from "../src/provider-request-planner.ts";
import { createToolFailureContextMemory } from "../src/tool-failure-memory.ts";
import type { AgentLoopConfig, AgentMessage, ProviderRequestPrefixState } from "../src/types.ts";

/**
 * A compaction replaces the history the sent-prefix marks were counting. Only the leading messages the
 * compacted history shares with the old one by reference were ever sent; everything else is new. The
 * marks must drop to that shared prefix, or the monotone post-acceptance write keeps the pre-compaction
 * count and the whole compacted history reads as already sent (context GC could not pack it and the
 * sanitizer could not dedup it until the history regrew past the old count).
 */

const MODEL: Model<"openai-responses"> = {
	id: "model",
	name: "model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8_192,
	maxTokens: 2_048,
};

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function doneStream() {
	const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
		(event) => event.type === "done" || event.type === "error",
		(event) => {
			if (event.type === "done") return event.message;
			if (event.type === "error") return event.error;
			throw new Error("Unexpected event type");
		},
	);
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
	queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
	return stream;
}

function run(history: AgentMessage[], replanned: AgentMessage[], state: ProviderRequestPrefixState) {
	const plannedMarks: number[] = [];
	let admissions = 0;
	const config: AgentLoopConfig = {
		model: MODEL,
		convertToLlm: (messages) => messages as Message[],
		providerRequestPrefixState: state,
		planContext: async (request) => {
			plannedMarks.push(request.sentPrefixCount);
			return { messages: request.messages };
		},
		admitProviderRequest: async (request) =>
			admissions++ === 0
				? { action: "replan", context: { ...request.sourceContext, messages: replanned } }
				: { action: "send" },
	};
	return {
		plannedMarks,
		done: startPlannedAgentProviderRequest(
			{ systemPrompt: "system", messages: history, tools: [] },
			config,
			undefined,
			() => doneStream(),
		),
	};
}

describe("provider request replan: sent-prefix marks follow the replaced history", () => {
	it("lowers both marks to the prefix the compacted history shares by reference, and drops the erasure memory", async () => {
		const history = [user("a"), user("b"), user("c"), user("d")];
		// Compaction keeps the first message object and replaces the rest with a summary and a new turn.
		const compacted = [history[0], user("summary"), user("e")];
		const memory = createToolFailureContextMemory();
		const state: ProviderRequestPrefixState = {
			sentPrefixCount: history.length,
			sanitizerSentPrefixCount: history.length,
			sanitizerMemory: memory,
		};
		const { plannedMarks, done } = run(history, compacted, state);
		await done;
		// First plan sees the old history fully sent; the replanned plan sees only the shared message.
		expect(plannedMarks).toEqual([4, 1]);
		// After acceptance the marks grow from the shared prefix to the compacted history's length, not
		// back to the stale pre-compaction count.
		expect(state.sentPrefixCount).toBe(compacted.length);
		expect(state.sanitizerSentPrefixCount).toBe(compacted.length);
		expect(state.sanitizerMemory).not.toBe(memory);
	});

	it("keeps the marks and the erasure memory when the replanned history extends the sent prefix", async () => {
		const history = [user("a"), user("b")];
		const extended = [...history, user("c")];
		const memory = createToolFailureContextMemory();
		const state: ProviderRequestPrefixState = {
			sentPrefixCount: 2,
			sanitizerSentPrefixCount: 2,
			sanitizerMemory: memory,
		};
		const { plannedMarks, done } = run(history, extended, state);
		await done;
		expect(plannedMarks).toEqual([2, 2]);
		expect(state.sanitizerMemory).toBe(memory);
	});
});
