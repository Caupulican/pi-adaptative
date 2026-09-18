import { createAssistantMessageEventStream } from "@caupulican/pi-ai/event-stream";
import type { AssistantMessage, Message } from "@caupulican/pi-ai/types";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createAgentLoopContinuationState, runAgentLoop } from "../src/agent-loop.ts";
import { retainedToolInvocation } from "../src/tool-invocation-receipt.ts";
import type { AgentTool } from "../src/types.ts";
import { createEmptyUsage } from "../src/usage.ts";

describe("pre-execution cancellation recovery", () => {
	it.each(["cancel", "preflight_error", "blocked"] as const)(
		"preserves %s semantics before execution",
		async (outcome) => {
			const controller = new AbortController();
			const state = createAgentLoopContinuationState();
			let executions = 0;
			let releases = 0;
			const parameters = Type.Object({ command: Type.String() });
			const tool: AgentTool<typeof parameters> = {
				name: "preflight_fixture",
				label: "Preflight fixture",
				description: "Preflight recovery fixture",
				parameters,
				async execute() {
					throw new Error("Expected the bound executor");
				},
				async bindInvocation() {
					return {
						executionContext: {
							attachment: {
								workspaceId: "fixture",
								attachmentId: "fixture",
								root: "/fixture",
								flavor: "posix",
								caseSensitive: true,
							},
							sessionId: "fixture",
							generation: 0,
							cwd: "/fixture",
						},
						async execute() {
							executions++;
							return { content: [{ type: "text", text: "executed" }], details: {} };
						},
						release() {
							releases++;
						},
					};
				},
			};
			const messages = await runAgentLoop(
				[{ role: "user", content: "Run the fixture", timestamp: 1 }],
				{ systemPrompt: "", messages: [], tools: [tool] },
				{
					model: {
						id: "fixture",
						name: "fixture",
						api: "openai-responses",
						provider: "openai",
						baseUrl: "https://example.invalid",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 8192,
						maxTokens: 1024,
					},
					convertToLlm: (history) =>
						history.filter((message): message is Message =>
							["user", "assistant", "toolResult"].includes(message.role),
						),
					toolExecution: "sequential",
					maxProviderTurns: 1,
					beforeToolCall: async () => {
						if (outcome === "preflight_error") throw new Error("Host lookup failed");
						if (outcome === "blocked") return { block: true, reason: "Host policy denied" };
						controller.abort();
						return undefined;
					},
				},
				() => {},
				controller.signal,
				() => {
					const message: AssistantMessage = {
						role: "assistant",
						content: [
							{ type: "toolCall", id: "fixture-call", name: tool.name, arguments: { command: "fixture" } },
						],
						api: "openai-responses",
						provider: "openai",
						model: "fixture",
						usage: createEmptyUsage(),
						stopReason: "toolUse",
						timestamp: 1,
					};
					const stream = createAssistantMessageEventStream();
					stream.push({ type: "done", reason: "toolUse", message });
					return stream;
				},
				state,
			);
			expect(executions).toBe(0);
			expect(releases).toBe(1);
			expect(state.toolFailureRecoveryGate.isEmpty()).toBe(outcome === "cancel");
			const result = messages.find((message) => message.role === "toolResult");
			expect(result?.isError).toBe(true);
			expect(retainedToolInvocation(result?.details)).toMatchObject({ execution: "not_started" });
			if (outcome === "cancel") {
				expect(result?.content).toEqual([{ type: "text", text: "Operation aborted" }]);
				expect(result?.details).not.toHaveProperty("piToolFailureMemory");
			} else {
				expect(result?.details).toHaveProperty("piToolFailureMemory.failureCode", outcome);
			}
		},
	);
});
