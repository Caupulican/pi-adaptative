import { AssistantMessageEventStream } from "@caupulican/pi-ai/event-stream";
import type { Model } from "@caupulican/pi-ai/types";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../src/agent-loop.ts";
import type { AgentMessage, AgentTool } from "../src/types.ts";
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

describe("tool batch cleanup result retention", () => {
	it.each(["error", "undefined", "clean"] as const)(
		"retains already published output when last-resort cleanup is %s",
		async (cleanup) => {
			const abort = new AbortController();
			let failReasonRead = false;
			Object.defineProperty(abort.signal, "reason", {
				get() {
					if (failReasonRead) {
						failReasonRead = false;
						throw new Error("abandonment observer failed");
					}
					return undefined;
				},
			});
			const parameters = Type.Object({});
			const execute = vi.fn(async () => ({
				content: [{ type: "text" as const, text: "committed output" }],
				details: {},
			}));
			const neverExecute = vi.fn(async () => {
				throw new Error("Undispatched body must not run");
			});
			const tools: AgentTool<typeof parameters>[] = [
				{ name: "first", label: "First", description: "Barrier", parameters, executionMode: "sequential", execute },
				{ name: "later", label: "Later", description: "Parallel", parameters, execute: neverExecute },
			];
			const released: string[] = [];
			const published: AgentMessage[] = [];
			let terminal: AgentMessage[] | undefined;
			const messages = await runAgentLoop(
				[{ role: "user", content: "Run fixture", timestamp: 0 }],
				{ systemPrompt: "Fixture", messages: [], tools },
				{
					model,
					maxProviderTurns: 1,
					toolConcurrency: 2,
					convertToLlm: (history) =>
						history.filter(
							(message) =>
								message.role === "user" || message.role === "assistant" || message.role === "toolResult",
						),
					beforeToolCall: async ({ toolCall, registerCleanup }) => {
						registerCleanup?.(() => {
							released.push(toolCall.id);
							if (toolCall.id !== "third" || cleanup === "clean") return;
							if (cleanup === "undefined") throw undefined;
							throw new Error("last pending cleanup failed");
						});
						return undefined;
					},
					onToolCallStart: (calls) => {
						if (calls[0].callId === "first") return;
						// Fail during abandonment of the first parallel preparation, leaving the next
						// preparation to the batch's last-resort cleanup. The signal itself is not aborted.
						failReasonRead = true;
						throw new Error("reservation refused");
					},
				},
				(event) => {
					if (event.type === "message_end") published.push(event.message);
					if (event.type === "agent_end") terminal = event.messages;
				},
				abort.signal,
				() => {
					const stream = new AssistantMessageEventStream();
					stream.push({
						type: "done",
						reason: "toolUse",
						message: {
							role: "assistant",
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: createEmptyUsage(),
							timestamp: 0,
							stopReason: "toolUse",
							content: [
								{ type: "toolCall", id: "first", name: "first", arguments: {} },
								{ type: "toolCall", id: "second", name: "later", arguments: {} },
								{ type: "toolCall", id: "third", name: "later", arguments: {} },
							],
						},
					});
					return stream;
				},
			);
			expect(execute).toHaveBeenCalledOnce();
			expect(neverExecute).not.toHaveBeenCalled();
			expect(released).toEqual(["first", "second", "third"]);
			expect(messages.filter((message) => message.role === "toolResult")).toEqual([
				expect.objectContaining({ toolCallId: "first", content: [{ type: "text", text: "committed output" }] }),
			]);
			expect(messages).toEqual(published);
			expect(terminal).toEqual(messages);
			expect(messages.at(-1)).toMatchObject({
				role: "assistant",
				stopReason: "error",
				errorMessage: cleanup === "clean" ? "abandonment observer failed" : "Prepared tool cleanup failed",
			});
		},
	);
});
