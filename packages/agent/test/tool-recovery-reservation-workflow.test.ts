import { createAssistantMessageEventStream } from "@caupulican/pi-ai/event-stream";
import type { AssistantMessage, Message } from "@caupulican/pi-ai/types";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createAgentLoopContinuationState, runAgentLoop } from "../src/agent-loop.ts";
import { restoreToolFailureRecord } from "../src/tool-failure-memory.ts";
import { retainedToolInvocation } from "../src/tool-invocation-receipt.ts";
import { type AgentTool, AgentToolExecutionError } from "../src/types.ts";
import { createEmptyUsage } from "../src/usage.ts";

describe("retry reservation workflow", () => {
	it.each([
		"before_cancel",
		"before_throw",
		"reservation_cancel",
		"reservation_throw",
		"background_throw",
		"execute",
	] as const)("settles admission at %s", async (boundary) => {
		const controller = new AbortController();
		const continuation = createAgentLoopContinuationState();
		const executed: string[] = [];
		const released: string[] = [];
		const args = { command: "fixture", timeout: 60 };
		const parameters = Type.Object({ command: Type.String(), timeout: Type.Number() });
		const tool: AgentTool<typeof parameters> = {
			name: "retry_fixture",
			label: "Retry fixture",
			description: "Exercise admission ownership across host callbacks",
			parameters,
			async execute() {
				throw new Error("Expected bound execution");
			},
			async bindInvocation(id) {
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
					failureRecovery: { getTimeoutMs: ({ timeout }) => timeout * 1000 },
					async execute() {
						executed.push(id);
						throw new AgentToolExecutionError("Timed out", "timeout", "fixture-output", "operation_outcome");
					},
					release() {
						released.push(id);
					},
				};
			},
		};
		let turn = 0;
		const messages = await runAgentLoop(
			[{ role: "user", content: "Run fixture", timestamp: 1 }],
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
				maxProviderTurns: 2,
				beforeToolCall: async ({ toolCall }) => {
					if (toolCall.id !== "retry") return;
					if (boundary === "before_cancel") controller.abort();
					if (boundary === "before_throw") throw new Error("Preflight failed");
				},
				onToolCallStart: async (calls) => {
					if (calls[0]?.callId !== "retry") return;
					if (boundary === "reservation_cancel") controller.abort();
					if (boundary === "reservation_throw") throw new Error("Reservation failed");
				},
				isBackgroundRequested: () => {
					if (turn === 2 && boundary === "background_throw") throw new Error("Background selection failed");
					return false;
				},
			},
			() => {},
			controller.signal,
			() => {
				const id = ++turn === 1 ? "initial" : "retry";
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "toolCall", id, name: tool.name, arguments: { ...args } }],
					api: "openai-responses",
					provider: "openai",
					model: "fixture",
					usage: createEmptyUsage(),
					stopReason: "toolUse",
					timestamp: turn,
				};
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: "toolUse", message });
				return stream;
			},
			continuation,
		);
		expect(executed).toEqual(boundary === "execute" ? ["initial", "retry"] : ["initial"]);
		expect(released).toEqual(["initial", "retry"]);
		const firstResult = messages.find((message) => message.role === "toolResult");
		const scope = retainedToolInvocation(firstResult?.details)?.executionScope;
		expect(scope).toBeDefined();
		const retryResult = messages
			.filter((message) => message.role === "toolResult")
			.find((message) => message.toolCallId === "retry");
		if (boundary !== "execute" && boundary !== "before_throw") {
			expect(retryResult).toBeDefined();
			expect(retainedToolInvocation(retryResult?.details)).toMatchObject({
				execution: "not_started",
				failureCode: "aborted",
				executionScope: scope,
			});
			if (!retryResult) throw new Error("Missing abandoned retry result");
			// A hostile-looking abort diagnostic cannot create a timeout episode on replay.
			expect(
				restoreToolFailureRecord(
					{ ...retryResult, content: [{ type: "text", text: "Timed out" }] },
					tool.name,
					args,
				),
			).toBeUndefined();
		} else if (boundary === "execute") {
			if (!retryResult) throw new Error("Missing executed retry result");
			expect(restoreToolFailureRecord(retryResult, tool.name, args)?.failureCode).toBe("timeout");
		}
		const next = continuation.toolFailureRecoveryGate.reserve(tool, args, undefined, messages, scope);
		expect(next.kind).toBe(boundary === "execute" ? "blocked" : "allowed");
		if (next.kind === "allowed") next.reservation.cancel();
	});
});
