import { AssistantMessageEventStream } from "@caupulican/pi-ai/event-stream";
import type { Model } from "@caupulican/pi-ai/types";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop, runAgentLoop } from "../src/agent-loop.ts";
import type { AgentEvent, AgentLoopConfig, AgentMessage, AgentTool, StreamFn } from "../src/types.ts";
import { createEmptyUsage } from "../src/usage.ts";

const model: Model<"openai-responses"> = {
	id: "fixture",
	name: "fixture",
	api: "openai-responses",
	provider: "fixture",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};

describe("tool batch terminal settlement", () => {
	it.each(
		["stream", "direct"].flatMap((entry) =>
			["throw", "reject", "throw-undefined", "abort", "control"].map((fault) => ({ entry, fault })),
		),
	)("retains completed siblings before terminating: $entry / $fault", async ({ entry, fault }) => {
		const release = Promise.withResolvers<void>();
		const reservation = Promise.withResolvers<void>();
		const controller = new AbortController();
		const effects: string[] = [];
		const events: AgentEvent[] = [];
		const calls = ["fast", "held", "refill", "never"];
		const tool: AgentTool = {
			name: "operate",
			label: "Operate",
			description: "Synthetic mutation",
			parameters: Type.Object({}),
			execute: async (id) => {
				if (id === "held") await release.promise;
				effects.push(id);
				return { content: [{ type: "text", text: id }], details: { effect: id } };
			},
		};
		let requests = 0;
		const streamFn: StreamFn = () => {
			const first = requests++ === 0;
			const response = new AssistantMessageEventStream();
			response.push({
				type: "done",
				reason: first ? "toolUse" : "stop",
				message: {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: createEmptyUsage(),
					timestamp: requests,
					stopReason: first ? "toolUse" : "stop",
					content: first
						? calls.map((id) => ({ type: "toolCall", id, name: tool.name, arguments: {} }))
						: [{ type: "text", text: "Finished" }],
				},
			});
			return response;
		};
		const config: AgentLoopConfig = {
			model,
			toolConcurrency: 2,
			convertToLlm: (messages) =>
				messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult"),
			onToolCallStart: async (batch) => {
				if (!batch.some((call) => call.callId === "refill")) return;
				reservation.resolve();
				if (fault === "throw") throw new Error("synthetic reservation failure");
				if (fault === "throw-undefined") throw undefined;
				if (fault === "reject") {
					await Promise.resolve();
					throw new Error("synthetic async reservation failure");
				}
				if (fault === "abort") controller.abort();
			},
		};
		const prompts: AgentMessage[] = [{ role: "user", content: "Run fixture", timestamp: 0 }];
		const context = { systemPrompt: "Fixture", messages: [], tools: [tool] };
		let settled = false;
		const run =
			entry === "direct"
				? runAgentLoop(
						prompts,
						context,
						config,
						(event) => {
							events.push(event);
						},
						controller.signal,
						streamFn,
					)
				: (async () => {
						const stream = agentLoop(prompts, context, config, controller.signal, streamFn);
						for await (const event of stream) events.push(event);
						return stream.result();
					})();
		const completion = run.then(
			(messages) => ({ messages }),
			(error: unknown) => ({ error }),
		);
		void completion.then(() => {
			settled = true;
		});
		await reservation.promise;
		// An event-loop boundary lets the broken implementation terminal while a sibling is held.
		await new Promise<void>((resolve) => setImmediate(resolve));
		const settledBeforeRelease = settled;
		release.resolve();
		const outcome = await completion;
		expect(settledBeforeRelease).toBe(false);
		expect(outcome).not.toHaveProperty("error");
		if (!("messages" in outcome)) return;
		const results = outcome.messages.filter((message) => message.role === "toolResult");
		const expected = fault === "control" ? calls : ["fast", "held"];
		expect(results.map((message) => message.toolCallId)).toEqual(expected);
		expect(effects.sort()).toEqual([...expected].sort());
		expect(results.every((message) => !message.isError)).toBe(true);
		for (const result of results) {
			expect(result.details).toMatchObject({
				piToolInvocation: { execution: "completed", operationStatus: "success", postprocessingFailures: [] },
			});
		}
		expect(outcome.messages).toEqual(
			events.flatMap((event) => (event.type === "message_end" ? [event.message] : [])),
		);
		expect(events.at(-1)).toMatchObject({ type: "agent_end", messages: outcome.messages });
		expect(outcome.messages.at(-1)).toMatchObject({
			stopReason: fault === "control" ? "stop" : fault === "abort" ? "aborted" : "error",
		});
		expect(requests).toBe(fault === "control" ? 2 : 1);
	});
});
