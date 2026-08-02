import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@caupulican/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentMessage, AgentTool, BackgroundToolCallCompletion } from "../src/types.ts";

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
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

describe("background tool handoff", () => {
	it("continues the foreground while preserving one policy-finalized completion", async () => {
		const schema = Type.Object({ value: Type.String() });
		let releaseTool: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		let toolCompleted = false;
		let afterToolCallCount = 0;
		let providerContinuedBeforeCompletion = false;
		let handedOffCompletion: Promise<BackgroundToolCallCompletion> | undefined;

		const tool: AgentTool<typeof schema, { phase: string }> = {
			name: "slow",
			label: "Slow",
			description: "Controlled slow tool",
			parameters: schema,
			async execute(_toolCallId, _params, _signal, onUpdate) {
				onUpdate?.({ content: [{ type: "text", text: "started" }], details: { phase: "started" } });
				await toolRelease;
				toolCompleted = true;
				onUpdate?.({ content: [{ type: "text", text: "finished" }], details: { phase: "finished" } });
				return { content: [{ type: "text", text: "actual result" }], details: { phase: "finished" } };
			},
		};

		let providerCall = 0;
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const stream = agentLoop(
			[createUserMessage("run")],
			context,
			{
				model: createModel(),
				convertToLlm: identityConverter,
				backgroundToolCallAfterMs: 5,
				handoffToolCall: ({ completion }) => {
					handedOffCompletion = completion;
					return {
						result: {
							content: [{ type: "text", text: "moved to task tool-task-1" }],
							details: { taskId: "tool-task-1" },
						},
					};
				},
				afterToolCall: async () => {
					afterToolCallCount++;
					return undefined;
				},
			},
			undefined,
			() => {
				const mockStream = new MockAssistantStream();
				queueMicrotask(() => {
					if (providerCall === 0) {
						mockStream.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								[{ type: "toolCall", id: "tool-1", name: "slow", arguments: { value: "x" } }],
								"toolUse",
							),
						});
					} else {
						providerContinuedBeforeCompletion = !toolCompleted;
						mockStream.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "continued" }]),
						});
					}
					providerCall++;
				});
				return mockStream;
			},
		);

		const safetyRelease = setTimeout(() => releaseTool?.(), 200);
		const events: AgentEvent[] = [];
		for await (const event of stream) events.push(event);
		clearTimeout(safetyRelease);

		expect(providerContinuedBeforeCompletion).toBe(true);
		expect(handedOffCompletion).toBeDefined();
		expect(afterToolCallCount).toBe(0);
		const foregroundResult = (await stream.result()).find((message) => message.role === "toolResult");
		expect(foregroundResult).toMatchObject({
			role: "toolResult",
			isError: false,
			content: [{ type: "text", text: "moved to task tool-task-1" }],
		});

		releaseTool?.();
		await expect(handedOffCompletion).resolves.toMatchObject({
			toolCall: { id: "tool-1", name: "slow" },
			result: { content: [{ type: "text", text: "actual result" }] },
			isError: false,
		});
		expect(afterToolCallCount).toBe(1);
		const updateTexts = events.flatMap((event) =>
			event.type === "tool_execution_update" && event.partialResult.content[0]?.type === "text"
				? [event.partialResult.content[0].text]
				: [],
		);
		expect(updateTexts).toEqual(["started"]);
		expect(events.filter((event) => event.type === "tool_execution_end")).toHaveLength(1);
	});

	it("does not hand off a tool that completes before the threshold", async () => {
		const schema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof schema, { value: string }> = {
			name: "fast",
			label: "Fast",
			description: "Immediate tool",
			parameters: schema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: params.value }], details: { value: params.value } };
			},
		};
		let handoffs = 0;
		let providerCall = 0;
		const stream = agentLoop(
			[createUserMessage("run")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				backgroundToolCallAfterMs: 20,
				handoffToolCall: () => {
					handoffs++;
					return undefined;
				},
			},
			undefined,
			() => {
				const mockStream = new MockAssistantStream();
				queueMicrotask(() => {
					mockStream.push(
						providerCall++ === 0
							? {
									type: "done",
									reason: "toolUse",
									message: createAssistantMessage(
										[{ type: "toolCall", id: "tool-1", name: "fast", arguments: { value: "ok" } }],
										"toolUse",
									),
								}
							: {
									type: "done",
									reason: "stop",
									message: createAssistantMessage([{ type: "text", text: "done" }]),
								},
					);
				});
				return mockStream;
			},
		);

		for await (const _event of stream) {
			// consume
		}
		expect(handoffs).toBe(0);
	});

	it("accepts an event-driven manual handoff before the automatic threshold", async () => {
		const schema = Type.Object({ value: Type.String() });
		let releaseTool: (() => void) | undefined;
		const release = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		let completed = false;
		let requestHandoff: (() => void) | undefined;
		let unsubscribed = false;
		let elapsedAtHandoff: number | undefined;
		let continuedBeforeCompletion = false;
		const tool: AgentTool<typeof schema, Record<string, never>> = {
			name: "slow",
			label: "Slow",
			description: "Controlled slow tool",
			parameters: schema,
			async execute() {
				await release;
				completed = true;
				return { content: [{ type: "text", text: "actual" }], details: {} };
			},
		};
		let providerCall = 0;
		const stream = agentLoop(
			[createUserMessage("run")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				backgroundToolCallAfterMs: 60_000,
				subscribeToolCallHandoffRequest: (_toolCallId, request) => {
					requestHandoff = request;
					return () => {
						unsubscribed = true;
					};
				},
				handoffToolCall: (context) => {
					elapsedAtHandoff = context.elapsedMs;
					return {
						result: { content: [{ type: "text", text: "backgrounded" }], details: {} },
					};
				},
			},
			undefined,
			() => {
				const mockStream = new MockAssistantStream();
				queueMicrotask(() => {
					if (providerCall++ === 0) {
						mockStream.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								[{ type: "toolCall", id: "tool-1", name: "slow", arguments: { value: "x" } }],
								"toolUse",
							),
						});
					} else {
						continuedBeforeCompletion = !completed;
						mockStream.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "continued" }]),
						});
					}
				});
				return mockStream;
			},
		);

		const manualRequest = setTimeout(() => requestHandoff?.(), 10);
		const safetyRelease = setTimeout(() => releaseTool?.(), 200);
		for await (const _event of stream) {
			// consume
		}
		clearTimeout(manualRequest);
		clearTimeout(safetyRelease);
		expect(continuedBeforeCompletion).toBe(true);
		expect(elapsedAtHandoff).toBeLessThan(15_000);
		expect(unsubscribed).toBe(true);
		releaseTool?.();
	});

	it("detaches from foreground abort while preserving task-local cancellation", async () => {
		const schema = Type.Object({ value: Type.String() });
		let toolSignal: AbortSignal | undefined;
		const tool: AgentTool<typeof schema, Record<string, never>> = {
			name: "slow",
			label: "Slow",
			description: "Abort-aware slow tool",
			parameters: schema,
			async execute(_toolCallId, _params, signal) {
				toolSignal = signal;
				await new Promise<void>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("task-local cancellation")), { once: true });
				});
				return { content: [{ type: "text", text: "unreachable" }], details: {} };
			},
		};
		let cancelTask: (() => void) | undefined;
		let completion: Promise<BackgroundToolCallCompletion> | undefined;
		let providerCall = 0;
		const foregroundAbort = new AbortController();
		const stream = agentLoop(
			[createUserMessage("run")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				backgroundToolCallAfterMs: 5,
				handoffToolCall: (context) => {
					cancelTask = context.cancel;
					completion = context.completion;
					return { result: { content: [{ type: "text", text: "backgrounded" }], details: {} } };
				},
			},
			foregroundAbort.signal,
			() => {
				const mockStream = new MockAssistantStream();
				queueMicrotask(() => {
					mockStream.push(
						providerCall++ === 0
							? {
									type: "done",
									reason: "toolUse",
									message: createAssistantMessage(
										[{ type: "toolCall", id: "tool-1", name: "slow", arguments: { value: "x" } }],
										"toolUse",
									),
								}
							: {
									type: "done",
									reason: "stop",
									message: createAssistantMessage([{ type: "text", text: "continued" }]),
								},
					);
				});
				return mockStream;
			},
		);

		for await (const _event of stream) {
			// consume
		}
		foregroundAbort.abort();
		await Promise.resolve();
		expect(toolSignal?.aborted).toBe(false);
		cancelTask?.();
		expect(toolSignal?.aborted).toBe(true);
		await expect(completion).resolves.toMatchObject({ isError: true });
	});
});
