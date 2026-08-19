import type { AgentMessage, AgentTool } from "@caupulican/pi-agent-core";
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
	it("resumes persisted child history and records only new messages in execution order", async () => {
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
			const history = [
				{ role: "user" as const, content: "first task", timestamp: 1 },
				withUsage(fauxAssistantMessage("first answer"), usage(1, 1, 0)),
			];
			const replies = [
				withUsage(fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }), usage(2, 1, 0)),
				withUsage(fauxAssistantMessage("continued answer"), usage(2, 1, 0)),
			];
			const contexts: Context[] = [];
			harness.session.agent.streamFn = (_model, context) => {
				contexts.push(context);
				const reply = replies.shift();
				if (!reply) throw new Error("No deterministic isolated reply queued");
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					const reason = reply.stopReason === "toolUse" ? "toolUse" : "stop";
					stream.push({ type: "done", reason, message: reply });
					stream.end(reply);
				});
				return stream;
			};
			const persistedRoles: string[] = [];

			const result = await harness.session.runIsolatedCompletion({
				systemPrompt: "isolated",
				history,
				messages: [{ role: "user", content: "continue", timestamp: 2 }],
				tools: [probeTool],
				maxTurns: 3,
				onMessage: (message) => {
					persistedRoles.push(message.role);
				},
				cacheRetention: "none",
			});

			expect(contexts[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
			expect(persistedRoles).toEqual(["user", "assistant", "toolResult", "assistant"]);
			expect(result.messages?.map((message) => message.role)).toEqual([
				"user",
				"assistant",
				"user",
				"assistant",
				"toolResult",
				"assistant",
			]);
			expect(execute).toHaveBeenCalledOnce();
		} finally {
			harness.cleanup();
		}
	});

	it("stops before tool execution when durable assistant persistence fails", async () => {
		const harness = await createHarness();
		try {
			const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "unsafe" }], details: {} }));
			const probeTool: AgentTool = {
				name: "probe",
				label: "probe",
				description: "Read-only test probe",
				parameters: Type.Object({}),
				execute,
			};
			harness.setResponses([fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" })]);

			await expect(
				harness.session.runIsolatedCompletion({
					systemPrompt: "isolated",
					messages: [{ role: "user", content: "inspect", timestamp: Date.now() }],
					tools: [probeTool],
					onMessage: (message) => {
						if (message.role === "assistant") throw new Error("transcript unavailable");
					},
					cacheRetention: "none",
				}),
			).rejects.toThrow("transcript unavailable");
			expect(execute).not.toHaveBeenCalled();
		} finally {
			harness.cleanup();
		}
	});

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
				cacheRetention: "none",
			});

			expect(execute).toHaveBeenCalledOnce();
			expect(contexts[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
			expect(contexts[1]?.tools?.map((tool) => tool.name)).toEqual(["probe"]);
			// The child loop never carries the real sessionId, but every turn of the SAME isolated
			// call shares one stable synthetic cache-affinity key.
			expect(streamOptions[1]?.sessionId).toBeDefined();
			expect(streamOptions[1]?.sessionId).toMatch(/^lane:/);
			expect(streamOptions[1]?.sessionId).not.toBe(harness.session.sessionId);
			expect(streamOptions[0]?.sessionId).toBe(streamOptions[1]?.sessionId);
			expect(result.text).toBe("final child answer");
			expect(result.usage).toMatchObject({ input: 13, output: 6, totalTokens: 19 });
			expect(result.usage.cost.total).toBeCloseTo(0.03, 10);
			expect(result.messages?.map((message) => message.role)).toEqual([
				"user",
				"assistant",
				"toolResult",
				"assistant",
			]);
			expect(result.messages?.[1]).toMatchObject({
				role: "assistant",
				content: [{ type: "toolCall", name: "probe" }],
			});
			expect(result.messages?.[2]).toMatchObject({
				role: "toolResult",
				toolName: "probe",
				content: [{ type: "text", text: "probe result" }],
			});
			expect(harness.session.messages).toHaveLength(historyBefore);
			expect(harness.sessionManager.getEntries()).toHaveLength(entriesBefore);
		} finally {
			harness.cleanup();
		}
	});

	it("repairs a hallucinated tool call when the caller explicitly supplies an empty tool surface", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("memory", { query: "private" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("continued without the unavailable tool"),
			]);

			const result = await harness.session.runIsolatedCompletion({
				systemPrompt: "isolated",
				messages: [{ role: "user", content: "inspect", timestamp: Date.now() }],
				tools: [],
				cacheRetention: "none",
			});

			expect(result.text).toBe("continued without the unavailable tool");
			expect(result.messages).toEqual([
				expect.objectContaining({ role: "user" }),
				expect.objectContaining({ role: "assistant" }),
				expect.objectContaining({ role: "toolResult", toolName: "memory", isError: true }),
				expect.objectContaining({ role: "assistant" }),
			]);
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			harness.cleanup();
		}
	});

	it("returns the final provider error detail to the isolated lane owner", async () => {
		const harness = await createHarness();
		try {
			const errorMessage = "Provider service overloaded; try again later";
			harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage })]);

			const result = await harness.session.runIsolatedCompletion({
				systemPrompt: "isolated",
				messages: [{ role: "user", content: "inspect", timestamp: Date.now() }],
				tools: [],
				cacheRetention: "none",
			});

			expect(result).toMatchObject({ stopReason: "error", errorMessage });
		} finally {
			harness.cleanup();
		}
	});

	it("applies a child-owned context projection before every provider turn while returning raw history", async () => {
		const harness = await createHarness();
		try {
			const probeTool: AgentTool = {
				name: "probe",
				label: "probe",
				description: "Read-only test probe",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text" as const, text: "probe result" }], details: {} }),
			};
			const replies = [
				fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("projected child answer"),
			];
			const contexts: Context[] = [];
			harness.session.agent.streamFn = (_model, context) => {
				contexts.push(context);
				const reply = replies.shift();
				if (!reply) throw new Error("No deterministic isolated reply queued");
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({
						type: "done",
						reason: reply.stopReason === "toolUse" ? "toolUse" : "stop",
						message: reply,
					});
					stream.end(reply);
				});
				return stream;
			};
			// Keep the projection deliberately small; the durable/raw result must remain complete.
			const project = vi.fn(async (messages: AgentMessage[]): Promise<AgentMessage[]> => messages.slice(-2));

			const result = await harness.session.runIsolatedCompletion({
				systemPrompt: "isolated",
				messages: [{ role: "user", content: "inspect", timestamp: Date.now() }],
				tools: [probeTool],
				transformContext: project,
				cacheRetention: "none",
			});

			expect(project).toHaveBeenCalledTimes(2);
			expect(contexts[1]?.messages.map((message) => message.role)).toEqual(["assistant", "toolResult"]);
			expect(result.messages?.map((message) => message.role)).toEqual([
				"user",
				"assistant",
				"toolResult",
				"assistant",
			]);
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
				cacheRetention: "none",
			});

			expect(result.stopReason).toBe("toolUse");
			expect(harness.getPendingResponseCount()).toBe(1);
		} finally {
			harness.cleanup();
		}
	});

	it("honors an explicit owner turn budget above the previous implicit ceiling", async () => {
		const harness = await createHarness();
		try {
			const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }));
			const probeTool: AgentTool = {
				name: "probe",
				label: "probe",
				description: "Read-only test probe",
				parameters: Type.Object({ index: Type.Number() }),
				execute,
			};
			harness.setResponses([
				...Array.from({ length: 13 }, (_entry, index) =>
					fauxAssistantMessage(fauxToolCall("probe", { index }), { stopReason: "toolUse" }),
				),
				fauxAssistantMessage("completed after thirteen tools"),
			]);

			const result = await harness.session.runIsolatedCompletion({
				systemPrompt: "isolated",
				messages: [{ role: "user", content: "inspect", timestamp: Date.now() }],
				tools: [probeTool],
				maxTurns: 14,
				cacheRetention: "none",
			});

			expect(execute).toHaveBeenCalledTimes(13);
			expect(result.text).toBe("completed after thirteen tools");
		} finally {
			harness.cleanup();
		}
	});

	it("leaves tool turns unbounded when no owner budget is supplied and stops on completion", async () => {
		const harness = await createHarness();
		try {
			const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }));
			const probeTool: AgentTool = {
				name: "probe",
				label: "probe",
				description: "Read-only test probe",
				parameters: Type.Object({ index: Type.Number() }),
				execute,
			};
			harness.setResponses([
				...Array.from({ length: 13 }, (_entry, index) =>
					fauxAssistantMessage(fauxToolCall("probe", { index }), { stopReason: "toolUse" }),
				),
				fauxAssistantMessage("completed without a turn cap"),
			]);

			const result = await harness.session.runIsolatedCompletion({
				systemPrompt: "isolated",
				messages: [{ role: "user", content: "inspect", timestamp: Date.now() }],
				tools: [probeTool],
				cacheRetention: "none",
			});

			expect(execute).toHaveBeenCalledTimes(13);
			expect(result.text).toBe("completed without a turn cap");
		} finally {
			harness.cleanup();
		}
	});

	it("keeps the runaway stall guard active when no owner turn budget is supplied", async () => {
		const harness = await createHarness();
		try {
			harness.session.agent.maxStallTurns = 2;
			const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }));
			const probeTool: AgentTool = {
				name: "probe",
				label: "probe",
				description: "Read-only test probe",
				parameters: Type.Object({}),
				execute,
			};
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("stall summary"),
			]);

			const result = await harness.session.runIsolatedCompletion({
				systemPrompt: "isolated",
				messages: [{ role: "user", content: "inspect", timestamp: Date.now() }],
				tools: [probeTool],
				cacheRetention: "none",
			});

			expect(execute).toHaveBeenCalledTimes(2);
			expect(result.stopReason).toBe("stop");
			expect(result.text).toBe("stall summary");
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			harness.cleanup();
		}
	});

	it("rejects invalid explicit owner turn budgets", async () => {
		const harness = await createHarness();
		try {
			const options = {
				systemPrompt: "isolated",
				messages: [{ role: "user" as const, content: "inspect", timestamp: Date.now() }],
				tools: [],
				cacheRetention: "none" as const,
			};
			await expect(harness.session.runIsolatedCompletion({ ...options, maxTurns: 0 })).rejects.toThrow(
				"maxTurns must be a positive safe integer",
			);
			await expect(harness.session.runIsolatedCompletion({ ...options, maxTurns: 1.5 })).rejects.toThrow(
				"maxTurns must be a positive safe integer",
			);
			await expect(
				harness.session.runIsolatedCompletion({ ...options, maxTurns: Number.MAX_SAFE_INTEGER + 1 }),
			).rejects.toThrow("maxTurns must be a positive safe integer");
		} finally {
			harness.cleanup();
		}
	});

	it("uses one tool-free finalization turn when the child bound ends on a tool call", async () => {
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
				withUsage(fauxAssistantMessage("bounded synthesis"), usage(3, 4, 0.02)),
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
					const reason = reply.stopReason === "toolUse" ? "toolUse" : "stop";
					stream.push({ type: "done", reason, message: reply });
					stream.end(reply);
				});
				return stream;
			};

			const result = await harness.session.runIsolatedCompletion({
				systemPrompt: "isolated",
				messages: [{ role: "user", content: "inspect", timestamp: Date.now() }],
				tools: [probeTool],
				maxTurns: 1,
				maxTokens: 16,
				finalTextPrompt: "Synthesize without tools.",
				requestPreflight: async ({ context }) => ({ maxTokens: context.tools?.length ? 16 : 8 }),
				cacheRetention: "none",
			});

			expect(execute).toHaveBeenCalledOnce();
			expect(contexts).toHaveLength(2);
			expect(streamOptions.map((options) => options?.maxTokens)).toEqual([16, 8]);
			expect(contexts[1]?.tools).toEqual([]);
			expect(contexts[1]?.messages.map((message) => message.role)).toEqual([
				"user",
				"assistant",
				"toolResult",
				"user",
			]);
			expect(result.text).toBe("bounded synthesis");
			expect(result.usage).toMatchObject({ input: 13, output: 6, totalTokens: 19 });
			expect(result.usage.cost.total).toBeCloseTo(0.03, 10);
			expect(result.messages?.map((message) => message.role)).toEqual([
				"user",
				"assistant",
				"toolResult",
				"user",
				"assistant",
			]);
			expect(result.messages?.at(-1)).toMatchObject({
				role: "assistant",
				content: [{ type: "text", text: "bounded synthesis" }],
			});
		} finally {
			harness.cleanup();
		}
	});

	it("routes tool-free finalization through sanitizer, transform, preflight, and fresh auth", async () => {
		const harness = await createHarness();
		try {
			const probeTool: AgentTool = {
				name: "probe",
				label: "probe",
				description: "Failing test probe",
				parameters: Type.Object({}),
				execute: async () => ({
					content: [{ type: "text" as const, text: "bounded failed diagnostic survives" }],
					details: {},
					isError: true,
				}),
			};
			const replies = [
				fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("sanitized synthesis"),
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
					stream.push({
						type: "done",
						reason: reply.stopReason === "toolUse" ? "toolUse" : "stop",
						message: reply,
					});
					stream.end(reply);
				});
				return stream;
			};
			const authKeys = ["fresh-key-1", "fresh-key-2"];
			const getApiKey = vi.fn(async () => authKeys.shift());
			harness.session.agent.getApiKey = getApiKey;
			const transformedRoles: string[][] = [];
			const preflightContexts: Context[] = [];

			const result = await harness.session.runIsolatedCompletion({
				systemPrompt: "isolated",
				messages: [{ role: "user", content: "inspect", timestamp: Date.now() }],
				tools: [probeTool],
				maxTurns: 1,
				maxTokens: 16,
				finalTextPrompt: "Synthesize without tools.",
				transformContext: async (messages) => {
					transformedRoles.push(messages.map((message) => message.role));
					return messages;
				},
				requestPreflight: async ({ context }) => {
					preflightContexts.push(context);
					return { maxTokens: preflightContexts.length === 1 ? 16 : 8 };
				},
				cacheRetention: "none",
			});

			expect(result.text).toBe("sanitized synthesis");
			expect(getApiKey).toHaveBeenCalledTimes(2);
			expect(streamOptions.map((options) => options?.apiKey)).toEqual(["fresh-key-1", "fresh-key-2"]);
			expect(streamOptions.map((options) => options?.maxTokens)).toEqual([16, 8]);
			expect(transformedRoles).toHaveLength(2);
			expect(preflightContexts).toHaveLength(2);
			expect(contexts[1]?.messages.map((message) => message.role)).toEqual([
				"user",
				"assistant",
				"toolResult",
				"user",
			]);
			expect(contexts[1]?.messages.find((message) => message.role === "assistant")).toMatchObject({
				role: "assistant",
				content: [{ type: "toolCall", name: "probe" }],
			});
			const retainedFailure = contexts[1]?.messages.find((message) => message.role === "toolResult");
			expect(retainedFailure).toMatchObject({ role: "toolResult", toolName: "probe", isError: true });
			if (retainedFailure?.role === "toolResult") {
				expect(retainedFailure.content[0]).toMatchObject({
					type: "text",
					text: expect.stringContaining("[harness]"),
				});
			}
			expect(contexts[1]?.systemPrompt).toContain("ACTIVE TOOL FAILURES");
			expect(JSON.stringify(contexts[1]?.messages)).toContain("bounded failed diagnostic survives");
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
				cacheRetention: "none",
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
