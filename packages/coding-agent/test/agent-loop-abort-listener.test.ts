import { getEventListeners } from "node:events";
import {
	type Api,
	type AssistantMessage,
	AssistantMessageEventStream,
	createEmptyUsage,
	type Model,
} from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { type AgentEventSink, runAgentLoop, runAgentLoopContinue } from "../src/kernel/agent-loop.ts";
import type { AgentContext, AgentLoopConfig, StreamFn } from "../src/kernel/loop-config.ts";
import { convertToLlm } from "../src/kernel/messages.ts";

const model: Model<Api> = {
	id: "abort-listener-fixture",
	name: "Abort listener fixture",
	api: "openai-completions",
	provider: "fixture",
	baseUrl: "https://unused.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 100_000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const prompt = { role: "user" as const, content: "Inspect this project.", timestamp: 1 };
const emptyContext: AgentContext = { systemPrompt: "Follow the owner.", messages: [], tools: [] };
const config: AgentLoopConfig = { model, convertToLlm };

function setupSignal() {
	const controller = new AbortController();
	const unrelated = () => {};
	controller.signal.addEventListener("abort", unrelated);
	const before = getEventListeners(controller.signal, "abort");
	return { signal: controller.signal, before };
}

function assistantReply(): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [{ type: "text", text: "Done." }],
		usage: createEmptyUsage(),
		stopReason: "stop",
		timestamp: 2,
	};
}

function responseStream(): AssistantMessageEventStream {
	const response = assistantReply();
	const stream = new AssistantMessageEventStream();
	stream.push({ type: "start", partial: response });
	stream.push({ type: "done", reason: "stop", message: response });
	return stream;
}

describe("agent-loop outer abort listener lifetime", () => {
	it("removes its listener when provider context planning rejects", async () => {
		const { signal, before } = setupSignal();
		const failure = new Error("planning failed");
		const provider = vi.fn<StreamFn>();
		const failing: AgentLoopConfig = {
			...config,
			planContext: async () => {
				expect(getEventListeners(signal, "abort")).toHaveLength(before.length + 1);
				throw failure;
			},
		};
		await expect(runAgentLoop([prompt], emptyContext, failing, () => {}, signal, provider)).rejects.toBe(failure);
		expect(provider).not.toHaveBeenCalled();
		expect(getEventListeners(signal, "abort")).toEqual(before);
	});

	it("removes its listener when the sink rejects an assistant stream event", async () => {
		const { signal, before } = setupSignal();
		const failure = new Error("event sink failed");
		const sink: AgentEventSink = (event) => {
			if (event.type === "message_start" && event.message.role === "assistant") {
				expect(getEventListeners(signal, "abort")).toHaveLength(before.length + 1);
				throw failure;
			}
		};
		const context: AgentContext = { ...emptyContext, messages: [prompt] };
		await expect(runAgentLoopContinue(context, config, sink, signal, () => responseStream())).rejects.toBe(failure);
		expect(getEventListeners(signal, "abort")).toEqual(before);
	});

	it("removes its listener on normal completion while preserving the caller's listener", async () => {
		const { signal, before } = setupSignal();
		await runAgentLoop(
			[prompt],
			emptyContext,
			config,
			() => {},
			signal,
			() => responseStream(),
		);
		expect(getEventListeners(signal, "abort")).toEqual(before);
	});
});
