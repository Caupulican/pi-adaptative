import type { AgentTool } from "@caupulican/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	type SimpleStreamOptions,
	type Usage,
} from "@caupulican/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createHarness } from "./suite/harness.ts";

function usage(input: number, output: number, cost: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function withUsage(message: AssistantMessage, value: Usage): AssistantMessage {
	return { ...message, usage: value };
}

describe("isolated child tool loop", () => {
	it("executes multiple turns, aggregates usage, and leaks no child history into the foreground", async () => {
		const harness = await createHarness();
		try {
			const execute = vi.fn(async () => ({
				content: [{ type: "text" as const, text: "probe result" }],
				details: {},
			}));
			const probeTool: AgentTool = {
				name: "probe",
				label: "probe",
				description: "Read-only test probe",
				parameters: Type.Object({}),
				execute,
			};
			const replies = [
				withUsage(fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }), usage(10, 2, 0.01)),
				withUsage(fauxAssistantMessage("final child answer"), usage(3, 4, 0.02)),
			];
			const contexts: Context[] = [];
			const streamOptions: Array<SimpleStreamOptions | undefined> = [];
			harness.session.agent.streamFn = (_model, context, options) => {
				contexts.push(context);
				streamOptions.push(options);
				const reply = replies.shift();
				if (!reply) throw new Error("No deterministic isolated reply queued");
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					const reason =
						reply.stopReason === "toolUse" || reply.stopReason === "length" ? reply.stopReason : "stop";
					stream.push({ type: "done", reason, message: reply });
					stream.end(reply);
				});
				return stream;
			};

			const historyBefore = harness.session.messages.length;
			const entriesBefore = harness.sessionManager.getEntries().length;
			const result = await harness.session.runIsolatedCompletion({
				systemPrompt: "isolated",
				messages: [{ role: "user", content: "inspect", timestamp: Date.now() }],
				tools: [probeTool],
				maxTurns: 4,
			});

			expect(execute).toHaveBeenCalledOnce();
			expect(contexts[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
			expect(contexts[1]?.tools?.map((tool) => tool.name)).toEqual(["probe"]);
			expect(streamOptions[1]?.sessionId).toBeUndefined();
			expect(result.text).toBe("final child answer");
			expect(result.usage).toMatchObject({ input: 13, output: 6, totalTokens: 19 });
			expect(result.usage.cost.total).toBeCloseTo(0.03, 10);
			expect(harness.session.messages).toHaveLength(historyBefore);
			expect(harness.sessionManager.getEntries()).toHaveLength(entriesBefore);
		} finally {
			harness.cleanup();
		}
	});

	it("stops after the configured child-turn bound", async () => {
		const harness = await createHarness();
		try {
			const probeTool: AgentTool = {
				name: "probe",
				label: "probe",
				description: "Read-only test probe",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			};
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("must remain queued"),
			]);

			const result = await harness.session.runIsolatedCompletion({
				systemPrompt: "isolated",
				messages: [{ role: "user", content: "inspect", timestamp: Date.now() }],
				tools: [probeTool],
				maxTurns: 1,
			});

			expect(result.stopReason).toBe("toolUse");
			expect(harness.getPendingResponseCount()).toBe(1);
		} finally {
			harness.cleanup();
		}
	});

	it("forwards isolated tool-repair telemetry through the session hook", async () => {
		const harness = await createHarness();
		try {
			const events: unknown[] = [];
			const previous = harness.session.agent.onToolArgumentValidation;
			harness.session.agent.onToolArgumentValidation = (event) => {
				events.push(event);
				previous?.(event);
			};
			const execute = vi.fn(async (_toolCallId: string, _args: unknown) => ({
				content: [{ type: "text" as const, text: "ok" }],
				details: {},
			}));
			const probeTool: AgentTool = {
				name: "numeric_probe",
				label: "numeric_probe",
				description: "Probe numeric argument repair",
				parameters: Type.Object({ value: Type.Number() }),
				execute,
			};
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("numeric_probe", { value: "7" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.runIsolatedCompletion({
				systemPrompt: "isolated",
				messages: [{ role: "user", content: "inspect", timestamp: Date.now() }],
				tools: [probeTool],
				maxTurns: 2,
			});

			expect(execute).toHaveBeenCalledOnce();
			expect(execute.mock.calls[0]?.[1]).toEqual({ value: 7 });
			expect(events).toMatchObject([
				{
					outcome: "repaired",
					tool: "numeric_probe",
					repairsApplied: ["numberFromString"],
					executionOutcome: "succeeded",
				},
			]);
		} finally {
			harness.cleanup();
		}
	});
});
