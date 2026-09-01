import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
	type Message,
	type Model,
	type ToolResultMessage,
	type UserMessage,
} from "@caupulican/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { agentLoop, agentLoopContinue } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";
import { createAgentToolFailureRecoveryAuthority } from "../src/types.ts";

// Mock stream for testing - mimics MockAssistantStream
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

/**
 * The failure ledger reaches the model as the LAST message of the request, never in the system
 * prompt (see sanitizeToolFailureContext): ledger text in the cached prefix re-prefills the whole
 * conversation each time a failure appears, its counts change, or a success clears it. Empty string
 * means no ledger was projected this request.
 */
function ledgerOf(context: Context | undefined): string {
	const last = context?.messages.at(-1);
	if (!last || last.role !== "user") return "";
	const text =
		typeof last.content === "string"
			? last.content
			: last.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
	return text.startsWith("MANDATORY TOOL FAILURE RECOVERY") ? text : "";
}

/**
 * The verification-obligation instruction reaches the model as a trailing transient message, never
 * in the system prompt (see agent-loop.ts's `trailingInstruction` composition): the active id set
 * changes as obligations appear and resolve, and system-prompt text sits at byte zero of the
 * request, where a change invalidates the whole cached prefix. Empty string means no obligation
 * instruction was projected this request.
 */
function obligationInstructionOf(context: Context | undefined): string {
	for (const message of context?.messages ?? []) {
		if (message.role !== "user") continue;
		const text =
			typeof message.content === "string"
				? message.content
				: message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		if (text.startsWith("ACTIVE VERIFICATION FAILURES")) return text;
	}
	return "";
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

function pushDone(response: MockAssistantStream, message: AssistantMessage): void {
	const { stopReason } = message;
	if (stopReason !== "stop" && stopReason !== "length" && stopReason !== "toolUse") {
		throw new Error(`Invalid provider done reason: ${stopReason}`);
	}
	response.push({ type: "done", reason: stopReason, message });
}

function createUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: text,
		timestamp: Date.now(),
	};
}

// Simple identity converter for tests - just passes through standard messages
function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

describe("agentLoop with AgentMessage", () => {
	it("emits agent_end when the async loop fails before producing a model response", async () => {
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [],
		};
		const stream = agentLoop([createUserMessage("hello")], context, {
			model: createModel(),
			convertToLlm: () => {
				throw new Error("converter exploded");
			},
		});
		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const result = await Promise.race([
			stream.result(),
			new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 25)),
		]);
		expect(result).not.toBe("timeout");
		const messages = result as AgentMessage[];
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: "converter exploded",
		});
		expect(events.at(-1)).toMatchObject({ type: "agent_end", messages });
	});

	it("settles when a fast provider stream ends without a terminal event", async () => {
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [],
		};
		const streamFn = () => {
			const stream = new MockAssistantStream();
			const partial = createAssistantMessage([{ type: "text", text: "partial" }]);
			stream.push({ type: "start", partial });
			stream.end();
			return stream;
		};
		const loop = agentLoop(
			[createUserMessage("hello")],
			context,
			{
				model: createModel(),
				convertToLlm: identityConverter,
			},
			undefined,
			streamFn,
		);

		const events: AgentEvent[] = [];
		for await (const event of loop) events.push(event);

		const result = await Promise.race([
			loop.result(),
			new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
		]);
		expect(result).not.toBe("timeout");
		const messages = result as AgentMessage[];
		expect(messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: "stream ended without a terminal result",
		});
		expect(events.at(-1)).toMatchObject({ type: "agent_end" });
	});

	it("should emit events with AgentMessage types", async () => {
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [],
		};

		const userPrompt: AgentMessage = createUserMessage("Hello");

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Hi there!" }]);
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();

		// Should have user message and assistant message
		expect(messages.length).toBe(2);
		expect(messages[0].role).toBe("user");
		expect(messages[1].role).toBe("assistant");

		// Verify event sequence
		const eventTypes = events.map((e) => e.type);
		expect(eventTypes).toContain("agent_start");
		expect(eventTypes).toContain("turn_start");
		expect(eventTypes).toContain("message_start");
		expect(eventTypes).toContain("message_end");
		expect(eventTypes).toContain("turn_end");
		expect(eventTypes).toContain("agent_end");
	});

	it("should handle custom message types via convertToLlm", async () => {
		// Create a custom message type
		interface CustomNotification {
			role: "notification";
			text: string;
			timestamp: number;
		}

		const notification: CustomNotification = {
			role: "notification",
			text: "This is a notification",
			timestamp: Date.now(),
		};

		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [notification as unknown as AgentMessage], // Custom message in context
			tools: [],
		};

		const userPrompt: AgentMessage = createUserMessage("Hello");

		let convertedMessages: Message[] = [];
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: (messages) => {
				// Filter out notifications, convert rest
				convertedMessages = messages
					.filter((m) => (m as { role: string }).role !== "notification")
					.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
				return convertedMessages;
			},
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Response" }]);
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		for await (const event of stream) {
			events.push(event);
		}

		// The notification should have been filtered out in convertToLlm
		expect(convertedMessages.length).toBe(1); // Only user message
		expect(convertedMessages[0].role).toBe("user");
	});

	it("should apply transformContext before convertToLlm", async () => {
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [
				createUserMessage("old message 1"),
				createAssistantMessage([{ type: "text", text: "old response 1" }]),
				createUserMessage("old message 2"),
				createAssistantMessage([{ type: "text", text: "old response 2" }]),
			],
			tools: [],
		};

		const userPrompt: AgentMessage = createUserMessage("new message");

		let transformedMessages: AgentMessage[] = [];
		let convertedMessages: Message[] = [];

		const config: AgentLoopConfig = {
			model: createModel(),
			transformContext: async (messages) => {
				// Keep only last 2 messages (prune old ones)
				transformedMessages = messages.slice(-2);
				return transformedMessages;
			},
			convertToLlm: (messages) => {
				convertedMessages = messages.filter(
					(m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
				) as Message[];
				return convertedMessages;
			},
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Response" }]);
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		for await (const _ of stream) {
			// consume
		}

		// transformContext should have been called first, keeping only last 2
		expect(transformedMessages.length).toBe(2);
		// Then convertToLlm receives the pruned messages
		expect(convertedMessages.length).toBe(2);
	});

	it("runs request preflight after context transformation and narrows the request output cap", async () => {
		const order: string[] = [];
		let transportedMaxTokens: number | undefined;
		const context: AgentContext = {
			systemPrompt: "preflight",
			messages: [],
			tools: [],
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			maxTokens: 128,
			transformContext: async (messages) => {
				order.push("transform");
				return messages;
			},
			requestPreflight: ({ context: requestContext, maxTokens }) => {
				order.push("preflight");
				expect(requestContext.messages.at(-1)?.role).toBe("user");
				expect(maxTokens).toBe(128);
				return { maxTokens: 64 };
			},
			getApiKey: async () => {
				order.push("auth");
				return "fresh-key";
			},
			convertToLlm: identityConverter,
		};
		const stream = agentLoop(
			[createUserMessage("bounded request")],
			context,
			config,
			undefined,
			(_model, _ctx, opts) => {
				order.push("transport");
				transportedMaxTokens = opts?.maxTokens;
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					response.push({ type: "done", reason: "stop", message });
				});
				return response;
			},
		);

		for await (const _ of stream) {
			// consume
		}

		expect(order).toEqual(["transform", "preflight", "auth", "transport"]);
		expect(transportedMaxTokens).toBe(64);
	});

	it("fails before transport when request preflight rejects and never widens the owner cap", async () => {
		let transportCalls = 0;
		const context: AgentContext = {
			systemPrompt: "preflight",
			messages: [],
			tools: [],
		};
		const widened = agentLoop(
			[createUserMessage("do not widen")],
			context,
			{
				model: createModel(),
				maxTokens: 32,
				requestPreflight: () => ({ maxTokens: 1_024 }),
				convertToLlm: identityConverter,
			},
			undefined,
			(_model, _ctx, opts) => {
				transportCalls++;
				expect(opts?.maxTokens).toBe(32);
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					const message = createAssistantMessage([{ type: "text", text: "bounded" }]);
					response.push({ type: "done", reason: "stop", message });
				});
				return response;
			},
		);
		for await (const _ of widened) {
			// consume
		}

		let authCalls = 0;
		const rejected = agentLoop(
			[createUserMessage("reject")],
			context,
			{
				model: createModel(),
				requestPreflight: () => {
					throw new Error("request budget exhausted");
				},
				getApiKey: async () => {
					authCalls += 1;
					return "must-not-be-read";
				},
				convertToLlm: identityConverter,
			},
			undefined,
			() => {
				transportCalls++;
				throw new Error("transport must not be called");
			},
		);
		const messages = await rejected.result();

		expect(transportCalls).toBe(1);
		expect(authCalls).toBe(0);
		expect(messages.at(-1)).toMatchObject({
			stopReason: "error",
			errorMessage: "request budget exhausted",
		});

		const invalid = agentLoop(
			[createUserMessage("invalid allowance")],
			context,
			{
				model: createModel(),
				requestPreflight: () => ({ maxTokens: 0 }),
				convertToLlm: identityConverter,
			},
			undefined,
			() => {
				transportCalls++;
				throw new Error("transport must not be called");
			},
		);
		const invalidMessages = await invalid.result();
		expect(transportCalls).toBe(1);
		expect(invalidMessages.at(-1)).toMatchObject({
			stopReason: "error",
			errorMessage: "requestPreflight.maxTokens must be a positive safe integer",
		});
	});

	it("treats a nonpositive model output limit as unspecified during request preflight", async () => {
		let transportedMaxTokens: number | undefined;
		const stream = agentLoop(
			[createUserMessage("model limit is unspecified")],
			{ systemPrompt: "preflight", messages: [], tools: [] },
			{
				model: { ...createModel(), maxTokens: 0 },
				requestPreflight: () => ({ maxTokens: 64 }),
				convertToLlm: identityConverter,
			},
			undefined,
			(_model, _ctx, opts) => {
				transportedMaxTokens = opts?.maxTokens;
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					const message = createAssistantMessage([{ type: "text", text: "bounded" }]);
					response.push({ type: "done", reason: "stop", message });
				});
				return response;
			},
		);
		for await (const _ of stream) {
			// consume
		}

		expect(transportedMaxTokens).toBe(64);
	});

	it("should handle tool calls and results", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("echo something");

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					// First call: return tool call
					const message = createAssistantMessage(
						[
							{
								type: "toolCall",
								id: "tool-1",
								name: "echo",
								arguments: { value: "hello" },
							},
						],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					// Second call: return final response
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					stream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		for await (const event of stream) {
			events.push(event);
		}

		// Tool should have been executed
		expect(executed).toEqual(["hello"]);

		// Should have tool execution events
		const toolStart = events.find((e) => e.type === "tool_execution_start");
		const toolEnd = events.find((e) => e.type === "tool_execution_end");
		expect(toolStart).toBeDefined();
		expect(toolEnd).toBeDefined();
		if (toolEnd?.type === "tool_execution_end") {
			expect(toolEnd.isError).toBe(false);
		}
	});

	it("does not persist repeated thinking across changed tool turns", async () => {
		const toolSchema = Type.Object({ path: Type.String() });
		const tool: AgentTool<typeof toolSchema, { path: string }> = {
			name: "read",
			label: "Read",
			description: "Read a file",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `read ${params.path}` }],
					details: { path: params.path },
				};
			},
		};
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};
		const repeatedThinking = "The operation was rejected. I will inspect the result and correct the request.";
		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex < 2) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[
								{
									type: "thinking",
									thinking: repeatedThinking,
									thinkingSignature: "reasoning",
								},
								{
									type: "toolCall",
									id: `read-${callIndex}`,
									name: "read",
									arguments: {
										path: callIndex === 0 ? "src/file.ts" : "src/other.ts",
									},
								},
							],
							"toolUse",
						),
					});
				} else {
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
				callIndex++;
			});
			return stream;
		};

		const assistantEnds: AssistantMessage[] = [];
		const loop = agentLoop(
			[{ role: "user", content: "read", timestamp: 1 }],
			context,
			{
				model: createModel(),
				convertToLlm: identityConverter,
				maxStallTurns: 0,
			},
			undefined,
			streamFn,
		);
		for await (const event of loop) {
			if (event.type === "message_end" && event.message.role === "assistant") assistantEnds.push(event.message);
		}

		expect(assistantEnds).toHaveLength(3);
		expect(assistantEnds[0]?.content[0]).toMatchObject({
			type: "thinking",
			thinking: repeatedThinking,
		});
		expect(assistantEnds[1]?.content).toEqual([
			expect.objectContaining({
				type: "toolCall",
				name: "read",
				arguments: { path: "src/other.ts" },
			}),
		]);
	});

	it("preserves repeated thinking after a queued steering message boundary", async () => {
		const toolSchema = Type.Object({ path: Type.String() });
		const tool: AgentTool<typeof toolSchema, { path: string }> = {
			name: "read",
			label: "Read",
			description: "Read a file",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `read ${params.path}` }],
					details: { path: params.path },
				};
			},
		};
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};
		const repeatedThinking = "The operation was rejected. I will inspect the result and correct the request.";
		let callIndex = 0;
		let steeringPolls = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex < 2) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[
								{
									type: "thinking",
									thinking: repeatedThinking,
									thinkingSignature: "reasoning",
								},
								{
									type: "toolCall",
									id: `read-steering-${callIndex}`,
									name: "read",
									arguments: { path: `src/steering-${callIndex}.ts` },
								},
							],
							"toolUse",
						),
					});
				} else {
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
				callIndex++;
			});
			return stream;
		};

		const assistantEnds: AssistantMessage[] = [];
		const loop = agentLoop(
			[{ role: "user", content: "read", timestamp: 1 }],
			context,
			{
				model: createModel(),
				convertToLlm: identityConverter,
				maxStallTurns: 0,
				getSteeringMessages: async () => {
					steeringPolls++;
					return steeringPolls === 2 ? [createUserMessage("inspect this new result")] : [];
				},
			},
			undefined,
			streamFn,
		);
		for await (const event of loop) {
			if (event.type === "message_end" && event.message.role === "assistant") assistantEnds.push(event.message);
		}

		expect(assistantEnds).toHaveLength(3);
		expect(assistantEnds[0]?.content[0]).toMatchObject({
			type: "thinking",
			thinking: repeatedThinking,
		});
		expect(assistantEnds[1]?.content[0]).toMatchObject({
			type: "thinking",
			thinking: repeatedThinking,
		});
	});

	it("enriches the third identical validation bounce and emits escalation", async () => {
		const toolSchema = Type.Object({ count: Type.Number() });
		const executed: number[] = [];
		const tool: AgentTool<typeof toolSchema, { count: number }> = {
			name: "count",
			label: "Count",
			description: "Count tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.count);
				return {
					content: [{ type: "text", text: String(params.count) }],
					details: { count: params.count },
				};
			},
		};
		const escalations: Array<{ tool: string; repeats: number }> = [];
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};
		const userPrompt: AgentMessage = createUserMessage("count");
		let providerSawEscalation = false;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: (messages) => {
				providerSawEscalation = messages.some(
					(message) =>
						message.role === "toolResult" &&
						message.content.some((block) => block.type === "text" && block.text.includes("Full tool schema:")),
				);
				return identityConverter(messages);
			},
			onToolValidationEscalation: (event) => escalations.push({ tool: event.tool, repeats: event.repeats }),
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (!providerSawEscalation) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[
								{
									type: "toolCall",
									id: `tool-${callIndex}`,
									name: "count",
									arguments: { count: "nope" },
									rawArguments: {
										parseDiagnostic: {
											kind: "malformed-json",
											offset: 14,
											context: "expected closing number token",
										},
									},
								},
							],
							"toolUse",
						),
					});
				} else {
					stream.push({
						type: "done",
						reason: callIndex === 3 ? "toolUse" : "stop",
						message:
							callIndex === 3
								? createAssistantMessage(
										[
											{
												type: "toolCall",
												id: "tool-corrected",
												name: "count",
												arguments: { count: 7 },
											},
										],
										"toolUse",
									)
								: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
				callIndex++;
			});
			return stream;
		};

		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);
		for await (const _ of stream) {
			// consume
		}

		const messages = await stream.result();
		const toolResults = messages.filter((message) => message.role === "toolResult");
		expect(executed).toEqual([7]);
		expect(escalations).toEqual([{ tool: "count", repeats: 3 }]);
		const resultTexts = toolResults.map((result) =>
			result.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n"),
		);
		const thirdResultText = resultTexts[2];
		expect(resultTexts[0]).not.toContain("Full tool schema:");
		expect(resultTexts[1]).not.toContain("Full tool schema:");
		expect(thirdResultText).toContain('"occ":3');
		expect(thirdResultText).toContain('"state":"rejected"');
		expect(thirdResultText).toContain('"failure_code":"invalid_arguments"');
		expect(thirdResultText).toContain("expected number, received string");
		expect(thirdResultText).toContain("Full tool schema:");
		expect(thirdResultText).toContain("Valid example:");
		expect(thirdResultText).toContain("Provider parse diagnostic (malformed-json at offset 14)");
		expect(thirdResultText).toContain("expected closing number token");
	});

	it("keeps a validation episode across valid sibling calls until the live schema converges the provider", async () => {
		const editSchema = Type.Object({ count: Type.Number() });
		const bashSchema = Type.Object({ command: Type.String() });
		const edits: number[] = [];
		const bashCommands: string[] = [];
		const edit: AgentTool<typeof editSchema, { count: number }> = {
			name: "edit",
			label: "Edit",
			description: "Edit a count",
			parameters: editSchema,
			async execute(_toolCallId, params) {
				edits.push(params.count);
				return {
					content: [{ type: "text", text: String(params.count) }],
					details: { count: params.count },
				};
			},
		};
		const bash: AgentTool<typeof bashSchema, { command: string }> = {
			name: "bash",
			label: "Bash",
			description: "Run a command",
			parameters: bashSchema,
			async execute(_toolCallId, params) {
				bashCommands.push(params.command);
				return {
					content: [{ type: "text", text: params.command }],
					details: { command: params.command },
				};
			},
		};
		let providerSawSchema = false;
		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const invalid = !providerSawSchema;
				stream.push({
					type: "done",
					reason: invalid || callIndex === 3 ? "toolUse" : "stop",
					message: invalid
						? createAssistantMessage(
								[
									{
										type: "toolCall",
										id: `edit-${callIndex}`,
										name: "edit",
										arguments: { count: "nope" },
									},
									{
										type: "toolCall",
										id: `bash-${callIndex}`,
										name: "bash",
										arguments: { command: `echo ${callIndex}` },
									},
								],
								"toolUse",
							)
						: callIndex === 3
							? createAssistantMessage(
									[
										{
											type: "toolCall",
											id: "edit-corrected",
											name: "edit",
											arguments: { count: 9 },
										},
									],
									"toolUse",
								)
							: createAssistantMessage([{ type: "text", text: "done" }]),
				});
				callIndex++;
			});
			return stream;
		};

		const stream = agentLoop(
			[createUserMessage("edit")],
			{ systemPrompt: "", messages: [], tools: [edit, bash] },
			{
				model: createModel(),
				maxProviderTurns: 5,
				convertToLlm: (messages) => {
					providerSawSchema = messages.some(
						(message) =>
							message.role === "toolResult" &&
							message.content.some((block) => block.type === "text" && block.text.includes("Full tool schema:")),
					);
					return identityConverter(messages);
				},
			},
			undefined,
			streamFn,
		);
		for await (const _ of stream) {
			// consume
		}

		const editResultTexts = (await stream.result())
			.filter(
				(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "edit",
			)
			.map((message) =>
				message.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n"),
			);
		expect(editResultTexts[0]).not.toContain("Full tool schema:");
		expect(editResultTexts[1]).not.toContain("Full tool schema:");
		expect(editResultTexts[2]).toContain("Full tool schema:");
		expect(edits).toEqual([9]);
		expect(bashCommands).toEqual(["echo 0", "echo 1", "echo 2"]);
	});

	it("resets validation episodes after a clean tool turn", async () => {
		const editSchema = Type.Object({ count: Type.Number() });
		const bashSchema = Type.Object({ command: Type.String() });
		let bashExecutions = 0;
		const edit: AgentTool<typeof editSchema, { count: number }> = {
			name: "edit",
			label: "Edit",
			description: "Edit a count",
			parameters: editSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: "should not run" }],
					details: { count: params.count },
				};
			},
		};
		const bash: AgentTool<typeof bashSchema, { command: string }> = {
			name: "bash",
			label: "Bash",
			description: "Run a command",
			parameters: bashSchema,
			async execute(_toolCallId, params) {
				bashExecutions++;
				return {
					content: [{ type: "text", text: "clean" }],
					details: { command: params.command },
				};
			},
		};
		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const toolCall =
					callIndex === 2
						? {
								type: "toolCall" as const,
								id: "clean-bash",
								name: "bash",
								arguments: { command: "echo clean" },
							}
						: {
								type: "toolCall" as const,
								id: `invalid-${callIndex}`,
								name: "edit",
								arguments: { count: "nope" },
							};
				stream.push({
					type: "done",
					reason: callIndex < 4 ? "toolUse" : "stop",
					message:
						callIndex < 4
							? createAssistantMessage([toolCall], "toolUse")
							: createAssistantMessage([{ type: "text", text: "done" }]),
				});
				callIndex++;
			});
			return stream;
		};

		const stream = agentLoop(
			[createUserMessage("edit")],
			{ systemPrompt: "", messages: [], tools: [edit, bash] },
			{ model: createModel(), convertToLlm: identityConverter },
			undefined,
			streamFn,
		);
		for await (const _ of stream) {
			// consume
		}

		const invalidResults = (await stream.result()).filter(
			(message) => message.role === "toolResult" && message.toolName === "edit",
		);
		expect(bashExecutions).toBe(1);
		expect(JSON.stringify(invalidResults)).not.toContain("Full tool schema:");
	});

	it("does not accumulate distinct validation failures", async () => {
		const toolSchema = Type.Object({ count: Type.Number() });
		const tool: AgentTool<typeof toolSchema, { count: number }> = {
			name: "count",
			label: "Count",
			description: "Count tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: String(params.count) }],
					details: { count: params.count },
				};
			},
		};
		const escalations: unknown[] = [];
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};
		const userPrompt: AgentMessage = createUserMessage("count");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			onToolValidationEscalation: (event) => escalations.push(event),
		};
		const argumentsByTurn = [{ count: "nope" }, {}, { count: "nope" }];
		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex < argumentsByTurn.length) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[
								{
									type: "toolCall",
									id: `tool-${callIndex}`,
									name: "count",
									arguments: argumentsByTurn[callIndex] ?? {},
								},
							],
							"toolUse",
						),
					});
				} else {
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
				callIndex++;
			});
			return stream;
		};

		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);
		for await (const _ of stream) {
			// consume
		}

		expect(escalations).toEqual([]);
	});

	it("consolidates repeated identical execution failures before runaway stop", async () => {
		const toolSchema = Type.Object({ path: Type.String() });
		const tool: AgentTool<typeof toolSchema, { path: string }> = {
			name: "read_file",
			label: "Read file",
			description: "Read a file",
			parameters: toolSchema,
			async execute() {
				throw new TypeError("backend exploded");
			},
		};
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			maxStallTurns: 12,
		};
		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex < 2) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[
								{
									type: "toolCall",
									id: `tool-${callIndex}`,
									name: "read_file",
									arguments: { path: "missing.txt" },
								},
							],
							"toolUse",
						),
					});
				} else {
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
				callIndex++;
			});
			return stream;
		};

		const stream = agentLoop([createUserMessage("read")], context, config, undefined, streamFn);
		for await (const _ of stream) {
			// consume
		}

		const messages = await stream.result();
		const toolResults = messages.filter((message) => message.role === "toolResult");
		expect(toolResults).toHaveLength(2);
		expect(toolResults[0]?.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining('"occ":1'),
		});
		expect(toolResults[1]?.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining('"occ":2'),
		});
		expect(JSON.stringify(toolResults)).toContain('"diagnostic":"backend exploded"');
	});

	it("retains one bounded failure ledger through recovery and clears it after matching success", async () => {
		const toolSchema = Type.Object({ command: Type.String() });
		const targetKind = "test.command.available";
		const recoveryAuthority = createAgentToolFailureRecoveryAuthority();
		let attempts = 0;
		let repaired = false;
		const command = `svn status -q; ${"x".repeat(300)}; svn diff --stat`;
		const recoveryCommand = "svn help status";
		const tool: AgentTool<typeof toolSchema, { command: string }> = {
			name: "shell",
			label: "Shell",
			description: "Run a command",
			parameters: toolSchema,
			failureRecovery: {
				getFailureTargets: (params, failure) =>
					failure.failureCode === "invalid_option"
						? [
								{
									authority: recoveryAuthority,
									kind: targetKind,
									scope: params.command,
								},
							]
						: [],
				actions: [
					{
						kind: "repair",
						authority: recoveryAuthority,
						targetKind,
						instruction: "Run the declared shell recovery check.",
					},
				],
			},
			async execute(_toolCallId, params) {
				attempts++;
				if (params.command === recoveryCommand) {
					repaired = true;
					return {
						content: [{ type: "text", text: "recovery command succeeded" }],
						details: { command: params.command },
					};
				}
				if (!repaired) {
					throw new Error(
						`RAW_FAILURE_OUTPUT:${"x".repeat(20_000)}\nsvn: invalid option: --stat\nCommand exited with code 1`,
					);
				}
				return {
					content: [{ type: "text", text: "command succeeded" }],
					details: { command: params.command },
				};
			},
		};
		const context: AgentContext = {
			systemPrompt: "base prompt",
			messages: [],
			tools: [tool],
		};
		const providerContexts: Array<{
			systemPrompt: string;
			messages: Message[];
		}> = [];
		let callIndex = 0;
		const stream = agentLoop(
			[createUserMessage("run it")],
			context,
			{ model: createModel(), convertToLlm: identityConverter },
			undefined,
			(_model, providerContext) => {
				providerContexts.push({
					systemPrompt: providerContext.systemPrompt ?? "",
					messages: structuredClone(providerContext.messages),
				});
				const mockStream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callIndex < 4) {
						mockStream.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								[
									{
										type: "toolCall",
										id: `tool-${callIndex}`,
										name: "shell",
										arguments: {
											command: callIndex === 2 ? recoveryCommand : command,
										},
									},
								],
								"toolUse",
							),
						});
					} else {
						mockStream.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "done" }]),
						});
					}
					callIndex++;
				});
				return mockStream;
			},
		);

		const events: AgentEvent[] = [];
		for await (const event of stream) events.push(event);

		const messages = await stream.result();
		const failedResults = messages.filter(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.isError === true,
		);
		expect(providerContexts).toHaveLength(5);
		expect(providerContexts[1]?.systemPrompt).not.toContain("ACTIVE TOOL FAILURES");
		expect(ledgerOf(providerContexts[1])).toContain("ACTIVE TOOL FAILURES");
		expect(ledgerOf(providerContexts[1])).toContain('"occ":1');
		expect(ledgerOf(providerContexts[1])).toContain('"state":"failed"');
		expect(ledgerOf(providerContexts[1])).toContain("svn status -q");
		expect(ledgerOf(providerContexts[1])).toContain("svn diff --stat");
		expect(ledgerOf(providerContexts[1])).toContain('"diagnostic":"svn: invalid option: --stat"');
		expect(ledgerOf(providerContexts[1])).toContain('"next_action":');
		expect(ledgerOf(providerContexts[1])).not.toContain('"repair":');
		expect(ledgerOf(providerContexts[1])).not.toContain("Change the arguments or approach before retrying");
		expect(JSON.stringify(providerContexts[1])).not.toContain("RAW_FAILURE_OUTPUT");
		// The call the agent made and its bounded record both stay in the transcript: the ledger
		// summarizes what is unresolved, it does not replace the agent's record of its own actions.
		expect(providerContexts[1]?.messages.some((message) => message.role === "toolResult")).toBe(true);
		expect(ledgerOf(providerContexts[2])).toContain('"occ":2');
		expect(ledgerOf(providerContexts[2]).match(/failure_key/g) ?? []).toHaveLength(1);
		expect(ledgerOf(providerContexts[3])).toContain('"occ":2');
		expect(ledgerOf(providerContexts[4])).toBe("");
		expect(JSON.stringify(providerContexts[4])).not.toContain("RAW_FAILURE_OUTPUT");
		expect(providerContexts[4]?.messages.some((message) => message.role === "toolResult")).toBe(true);
		expect(attempts).toBe(3);
		expect(failedResults).toHaveLength(2);
		expect(events.filter((event) => event.type === "tool_execution_end")).toHaveLength(4);
		expect(
			events.filter((event) => event.type === "message_end" && event.message.role === "toolResult"),
		).toHaveLength(4);
		expect(JSON.stringify(failedResults)).not.toContain("RAW_FAILURE_OUTPUT");
		expect(JSON.stringify(failedResults).length).toBeLessThan(3_000);
		expect(failedResults[1]?.content).toEqual([
			expect.objectContaining({
				type: "text",
				text: expect.stringContaining('"failure_code":"repeated_failed_operation"'),
			}),
		]);
		expect(failedResults[1]?.details).toMatchObject({
			piToolFailureMemory: {
				occurrence: 2,
				failureCode: "invalid_option",
				diagnostic: "svn: invalid option: --stat",
			},
		});
	});

	it("converts a returned structured tool failure into compact failure memory and clears it on a matching success", async () => {
		const toolSchema = Type.Object({ command: Type.String() });
		const targetKind = "test.command.ready";
		const recoveryAuthority = createAgentToolFailureRecoveryAuthority();
		const usage = { ...createUsage(), output: 7, totalTokens: 7 };
		let attempts = 0;
		let repaired = false;
		const observedAfterCall: Array<{
			isError: boolean;
			text: string;
			usage: unknown;
		}> = [];
		const tool: AgentTool<typeof toolSchema, { exitCode: number }> = {
			name: "direct_argv",
			label: "Direct argv",
			description: "Run a constrained direct argv operation",
			parameters: toolSchema,
			failureRecovery: {
				getFailureTargets: (params, failure) =>
					failure.failureCode === "exit_3"
						? [
								{
									authority: recoveryAuthority,
									kind: targetKind,
									scope: params.command,
								},
							]
						: [],
				actions: [
					{
						kind: "repair",
						authority: recoveryAuthority,
						targetKind,
						instruction: "Run the constrained repair check.",
					},
				],
			},
			async execute(_toolCallId, params) {
				attempts++;
				if (params.command === "repair check") {
					repaired = true;
					return {
						content: [{ type: "text", text: "repair complete" }],
						details: { exitCode: 0 },
						usage,
					};
				}
				if (!repaired) {
					return {
						content: [
							{
								// The stderr line must carry a strong diagnostic signal (e.g. an
								// "error:" prefix): assessToolFailure requires one once an
								// authoritative exit code is present (requireStrongSignal), so
								// captured output that merely echoes bare uncatalogued text is never
								// fabricated into a diagnostic.
								type: "text",
								text: "outcome: failed\nexitCode: 3\nstdout: (empty)\nstderr:\nerror: repair marker",
							},
						],
						details: { exitCode: 3 },
						usage,
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: "completed" }],
					details: { exitCode: 0 },
					usage,
				};
			},
		};
		const providerContexts: Array<{
			systemPrompt: string;
			messages: Message[];
		}> = [];
		let callIndex = 0;
		const stream = agentLoop(
			[createUserMessage("run")],
			{ systemPrompt: "base", messages: [], tools: [tool] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				afterToolCall: async ({ isError, result }) => {
					observedAfterCall.push({
						isError,
						text: result.content[0]?.type === "text" ? result.content[0].text : "",
						usage: result.usage,
					});
					return undefined;
				},
			},
			undefined,
			(_model, providerContext) => {
				providerContexts.push({
					systemPrompt: providerContext.systemPrompt ?? "",
					messages: structuredClone(providerContext.messages),
				});
				const mockStream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callIndex < 3) {
						mockStream.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								[
									{
										type: "toolCall",
										id: `tool-${callIndex}`,
										name: "direct_argv",
										arguments: {
											command: callIndex === 1 ? "repair check" : "check",
										},
									},
								],
								"toolUse",
							),
						});
					} else {
						mockStream.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "done" }]),
						});
					}
					callIndex++;
				});
				return mockStream;
			},
		);

		const events: AgentEvent[] = [];
		for await (const event of stream) events.push(event);

		const messages = await stream.result();
		const toolResults = messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
		expect(attempts).toBe(3);
		expect(observedAfterCall).toEqual([
			{ isError: true, text: expect.stringContaining("repair marker"), usage },
			{ isError: false, text: "repair complete", usage },
			{ isError: false, text: "completed", usage },
		]);
		expect(events.filter((event) => event.type === "tool_execution_end")[0]).toMatchObject({ isError: true });
		expect(toolResults[0]).toMatchObject({ isError: true, usage });
		expect(toolResults[0]?.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining('"failure_code":"exit_3"'),
		});
		expect(JSON.stringify(toolResults[0])).not.toContain("stdout: (empty)");
		expect(ledgerOf(providerContexts[1])).toContain('"diagnostic":"error: repair marker"');
		expect(providerContexts[1]?.messages.some((message) => message.role === "toolResult")).toBe(true);
		expect(ledgerOf(providerContexts[2])).toContain('"diagnostic":"error: repair marker"');
		expect(ledgerOf(providerContexts[3])).toBe("");
		expect(toolResults[1]).toMatchObject({ isError: false, usage });
		expect(toolResults[2]).toMatchObject({ isError: false, usage });
	});

	it("preserves termination from a returned structured tool failure", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { outcome: string }> = {
			name: "bounded_failure",
			label: "Bounded failure",
			description: "Return a bounded operation failure",
			parameters: toolSchema,
			async execute() {
				return {
					content: [
						{
							type: "text",
							text: "outcome: failed\nexitCode: 1\nstderr:\nno permission",
						},
					],
					details: { outcome: "failed" },
					isError: true,
					terminate: true,
				};
			},
		};
		let providerCalls = 0;
		const stream = agentLoop(
			[createUserMessage("run")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			{ model: createModel(), convertToLlm: identityConverter },
			undefined,
			() => {
				providerCalls++;
				const mockStream = new MockAssistantStream();
				queueMicrotask(() => {
					mockStream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[
								{
									type: "toolCall",
									id: "tool-1",
									name: "bounded_failure",
									arguments: { value: "x" },
								},
							],
							"toolUse",
						),
					});
				});
				return mockStream;
			},
		);

		for await (const _event of stream) {
			// consume
		}

		const toolResult = (await stream.result()).find((message) => message.role === "toolResult");
		expect(providerCalls).toBe(1);
		expect(toolResult).toMatchObject({ isError: true });
		expect(toolResult?.role === "toolResult" ? toolResult.details : undefined).toMatchObject({
			piToolFailureMemory: expect.any(Object),
		});
	});

	it("keeps a failed verification active through unrelated work until the same id passes", async () => {
		const verificationSchema = Type.Object({ status: Type.Union([Type.Literal("failed"), Type.Literal("passed")]) });
		const readSchema = Type.Object({ path: Type.String() });
		const verificationId = "focused-suite";
		const verificationCalls: string[] = [];
		const readCalls: string[] = [];
		const verify: AgentTool<
			typeof verificationSchema,
			{ piVerification: { version: 1; id: string; status: "failed" | "passed" } }
		> = {
			name: "verify",
			label: "Verify",
			description: "Run focused verification",
			parameters: verificationSchema,
			async execute(_toolCallId, params) {
				verificationCalls.push(params.status);
				return {
					content: [{ type: "text", text: `focused suite ${params.status}` }],
					details: { piVerification: { version: 1, id: verificationId, status: params.status } },
					isError: params.status === "failed",
				};
			},
		};
		const read: AgentTool<typeof readSchema, { path: string }> = {
			name: "read",
			label: "Read",
			description: "Inspect the changed source",
			parameters: readSchema,
			async execute(_toolCallId, params) {
				readCalls.push(params.path);
				return { content: [{ type: "text", text: "source inspected" }], details: { path: params.path } };
			},
		};

		const providerPrompts: string[] = [];
		let providerCalls = 0;
		const stream = agentLoop(
			[createUserMessage("fix the regression and verify it")],
			{ systemPrompt: "base", messages: [], tools: [verify, read] },
			{ model: createModel(), convertToLlm: identityConverter },
			undefined,
			(_model, providerContext) => {
				providerPrompts.push(obligationInstructionOf(providerContext));
				const response = new MockAssistantStream();
				const turn = providerCalls++;
				queueMicrotask(() => {
					const message =
						turn === 0
							? createAssistantMessage(
									[
										{
											type: "toolCall",
											id: "verify-failed",
											name: "verify",
											arguments: { status: "failed" },
										},
									],
									"toolUse",
								)
							: turn === 1 || turn === 3
								? createAssistantMessage([{ type: "text", text: "done" }])
								: turn === 2
									? createAssistantMessage(
											[
												{
													type: "toolCall",
													id: "read-source",
													name: "read",
													arguments: { path: "src/changed.ts" },
												},
											],
											"toolUse",
										)
									: turn === 4
										? createAssistantMessage(
												[
													{
														type: "toolCall",
														id: "verify-passed",
														name: "verify",
														arguments: { status: "passed" },
													},
												],
												"toolUse",
											)
										: createAssistantMessage([{ type: "text", text: "done" }]);
					pushDone(response, message);
				});
				return response;
			},
		);
		for await (const _event of stream) {
			// consume
		}

		const toolResults = (await stream.result()).filter(
			(message): message is ToolResultMessage => message.role === "toolResult",
		);
		expect({
			providerCalls,
			verificationCalls,
			readCalls,
			verificationPromptStates: providerPrompts.map((prompt) => ({
				active: prompt.includes("ACTIVE VERIFICATION FAILURES"),
				id: prompt.includes(verificationId),
			})),
			toolResultIds: toolResults.map((result) => result.toolCallId),
		}).toEqual({
			providerCalls: 6,
			verificationCalls: ["failed", "passed"],
			readCalls: ["src/changed.ts"],
			verificationPromptStates: [
				{ active: false, id: false },
				{ active: true, id: true },
				{ active: true, id: true },
				{ active: true, id: true },
				{ active: true, id: true },
				{ active: false, id: false },
			],
			toolResultIds: ["verify-failed", "read-source", "verify-passed"],
		});
	});

	it("does not let a terminating tool batch bypass an active verification obligation", async () => {
		const schema = Type.Object({});
		const verificationId = "terminating-batch-check";
		let terminatingCalls = 0;
		const verify: AgentTool<typeof schema, { piVerification: { version: 1; id: string; status: "failed" } }> = {
			name: "verify",
			label: "Verify",
			description: "Run verification",
			parameters: schema,
			async execute() {
				return {
					content: [{ type: "text", text: "verification failed" }],
					details: { piVerification: { version: 1, id: verificationId, status: "failed" } },
					isError: true,
				};
			},
		};
		const terminate: AgentTool<typeof schema, { terminal: true }> = {
			name: "terminate",
			label: "Terminate",
			description: "Return a terminal result",
			parameters: schema,
			async execute() {
				terminatingCalls++;
				return {
					content: [{ type: "text", text: "terminal tool completed" }],
					details: { terminal: true },
					terminate: true,
				};
			},
		};

		const handoff = `VERIFICATION_UNRESOLVED ${verificationId}: the suite remains red`;
		const providerPrompts: string[] = [];
		let providerCalls = 0;
		const stream = agentLoop(
			[createUserMessage("verify before stopping")],
			{ systemPrompt: "base", messages: [], tools: [verify, terminate] },
			{ model: createModel(), convertToLlm: identityConverter },
			undefined,
			(_model, providerContext) => {
				providerPrompts.push(obligationInstructionOf(providerContext));
				const response = new MockAssistantStream();
				const turn = providerCalls++;
				queueMicrotask(() => {
					const message =
						turn === 0
							? createAssistantMessage(
									[{ type: "toolCall", id: "verify-failed", name: "verify", arguments: {} }],
									"toolUse",
								)
							: turn === 1
								? createAssistantMessage(
										[{ type: "toolCall", id: "terminate-now", name: "terminate", arguments: {} }],
										"toolUse",
									)
								: createAssistantMessage([{ type: "text", text: handoff }]);
					pushDone(response, message);
				});
				return response;
			},
		);
		for await (const _event of stream) {
			// consume
		}

		const assistantTexts = (await stream.result())
			.filter((message): message is AssistantMessage => message.role === "assistant")
			.flatMap((message) => message.content)
			.filter(
				(block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text",
			)
			.map((block) => block.text);
		expect(providerCalls).toBe(3);
		expect(terminatingCalls).toBe(1);
		expect(providerPrompts[2]).toContain("ACTIVE VERIFICATION FAILURES");
		expect(assistantTexts).toContain(handoff);
	});

	it("permits terminal output only for an exact unresolved verification handoff", async () => {
		const schema = Type.Object({});
		const verificationId = "focused-suite";
		const verify: AgentTool<typeof schema, { piVerification: { version: 1; id: string; status: "failed" } }> = {
			name: "verify",
			label: "Verify",
			description: "Run focused verification",
			parameters: schema,
			async execute() {
				return {
					content: [{ type: "text", text: "focused suite failed" }],
					details: { piVerification: { version: 1, id: verificationId, status: "failed" } },
					isError: true,
				};
			},
		};

		const providerPrompts: string[] = [];
		let providerCalls = 0;
		const handoff = `VERIFICATION_UNRESOLVED ${verificationId}: owner approval is required to repair the fixture.`;
		const stream = agentLoop(
			[createUserMessage("verify")],
			{ systemPrompt: "base", messages: [], tools: [verify] },
			{ model: createModel(), convertToLlm: identityConverter },
			undefined,
			(_model, providerContext) => {
				providerPrompts.push(obligationInstructionOf(providerContext));
				const response = new MockAssistantStream();
				const turn = providerCalls++;
				queueMicrotask(() => {
					const message =
						turn === 0
							? createAssistantMessage(
									[
										{
											type: "toolCall",
											id: "verify-failed",
											name: "verify",
											arguments: {},
										},
									],
									"toolUse",
								)
							: createAssistantMessage([{ type: "text", text: handoff }]);
					pushDone(response, message);
				});
				return response;
			},
		);
		for await (const _event of stream) {
			// consume
		}

		const assistantText = (await stream.result())
			.filter((message): message is AssistantMessage => message.role === "assistant")
			.flatMap((message) => message.content)
			.filter(
				(block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text",
			)
			.map((block) => block.text);
		expect({
			providerCalls,
			secondPrompt: providerPrompts[1],
			assistantText,
		}).toEqual({
			providerCalls: 2,
			secondPrompt: expect.stringContaining(`ACTIVE VERIFICATION FAILURES`),
			assistantText: [handoff],
		});
	});

	it("requires an unresolved handoff for every active verification id", async () => {
		const schema = Type.Object({ id: Type.String() });
		const verify: AgentTool<typeof schema, { piVerification: { version: 1; id: string; status: "failed" } }> = {
			name: "verify",
			label: "Verify",
			description: "Run focused verification",
			parameters: schema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `${params.id} failed` }],
					details: { piVerification: { version: 1, id: params.id, status: "failed" } },
					isError: true,
				};
			},
		};
		const handoff = "VERIFICATION_UNRESOLVED alpha: first blocker\nVERIFICATION_UNRESOLVED beta: second blocker";
		let providerCalls = 0;
		const stream = agentLoop(
			[createUserMessage("verify both")],
			{ systemPrompt: "base", messages: [], tools: [verify] },
			{ model: createModel(), convertToLlm: identityConverter, maxProviderTurns: 3 },
			undefined,
			() => {
				const response = new MockAssistantStream();
				const turn = providerCalls++;
				queueMicrotask(() => {
					const message =
						turn === 0
							? createAssistantMessage(
									[
										{
											type: "toolCall",
											id: "verify-alpha",
											name: "verify",
											arguments: { id: "alpha" },
										},
										{
											type: "toolCall",
											id: "verify-beta",
											name: "verify",
											arguments: { id: "beta" },
										},
									],
									"toolUse",
								)
							: turn === 1
								? createAssistantMessage([{ type: "text", text: handoff }])
								: createAssistantMessage([
										{ type: "text", text: "VERIFICATION_UNRESOLVED alpha: fallback blocker" },
									]);
					pushDone(response, message);
				});
				return response;
			},
		);
		for await (const _event of stream) {
			// consume
		}

		expect(providerCalls).toBe(2);
	});

	it("restores active verification obligations from a compaction snapshot", async () => {
		const verificationId = "compacted-check";
		const providerPrompts: string[] = [];
		let providerCalls = 0;
		const stream = agentLoop(
			[createUserMessage("continue")],
			{
				systemPrompt: "base",
				messages: [
					{
						role: "compactionSummary",
						summary: "Compacted history",
						tokensBefore: 100,
						details: { piVerificationObligations: { version: 1, activeIds: [verificationId] } },
						timestamp: 1,
					} as AgentMessage,
				],
				tools: [],
			},
			{ model: createModel(), convertToLlm: identityConverter },
			undefined,
			(_model, providerContext) => {
				providerPrompts.push(obligationInstructionOf(providerContext));
				const response = new MockAssistantStream();
				const turn = providerCalls++;
				queueMicrotask(() => {
					const text =
						turn === 0 ? "done" : `VERIFICATION_UNRESOLVED ${verificationId}: external owner must repair it`;
					const message = createAssistantMessage([{ type: "text", text }]);
					pushDone(response, message);
				});
				return response;
			},
		);
		for await (const _event of stream) {
			// consume
		}

		expect(providerCalls).toBe(2);
		expect(providerPrompts[0]).toContain(`ACTIVE VERIFICATION FAILURES`);
		expect(providerPrompts[0]).toContain(verificationId);
	});

	it("applies pending custom verification events before requesting the provider", async () => {
		const verificationId = "background-check";
		const providerPrompts: string[] = [];
		let providerCalls = 0;
		let steeringReads = 0;
		const stream = agentLoop(
			[createUserMessage("continue")],
			{ systemPrompt: "base", messages: [], tools: [] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				getSteeringMessages: async () => {
					if (steeringReads++ !== 0) return [];
					return [
						{
							role: "custom",
							customType: "background-terminal",
							content: "Background verification failed",
							display: false,
							details: {
								piVerificationEvents: [{ version: 1, id: verificationId, status: "failed" }],
							},
							timestamp: 1,
						},
					];
				},
			},
			undefined,
			(_model, providerContext) => {
				providerPrompts.push(obligationInstructionOf(providerContext));
				const response = new MockAssistantStream();
				const turn = providerCalls++;
				queueMicrotask(() => {
					const text =
						turn === 0 ? "done" : `VERIFICATION_UNRESOLVED ${verificationId}: background owner is unavailable`;
					const message = createAssistantMessage([{ type: "text", text }]);
					pushDone(response, message);
				});
				return response;
			},
		);
		for await (const _event of stream) {
			// consume
		}

		expect(providerCalls).toBe(2);
		expect(providerPrompts[0]).toContain(`ACTIVE VERIFICATION FAILURES`);
		expect(providerPrompts[0]).toContain(verificationId);
	});

	it("rejects a tool-free completion at the provider limit while verification remains active", async () => {
		const schema = Type.Object({});
		const verify: AgentTool<typeof schema, { piVerification: { version: 1; id: string; status: "failed" } }> = {
			name: "verify",
			label: "Verify",
			description: "Run verification",
			parameters: schema,
			async execute() {
				return {
					content: [{ type: "text", text: "verification failed" }],
					details: { piVerification: { version: 1, id: "limit-check", status: "failed" } },
					isError: true,
				};
			},
		};
		let providerCalls = 0;
		const stream = agentLoop(
			[createUserMessage("verify")],
			{ systemPrompt: "base", messages: [], tools: [verify] },
			{ model: createModel(), convertToLlm: identityConverter, maxProviderTurns: 2 },
			undefined,
			() => {
				const response = new MockAssistantStream();
				const turn = providerCalls++;
				queueMicrotask(() => {
					const message =
						turn === 0
							? createAssistantMessage(
									[
										{
											type: "toolCall",
											id: "verify-limit",
											name: "verify",
											arguments: {},
										},
									],
									"toolUse",
								)
							: createAssistantMessage([{ type: "text", text: "done" }]);
					pushDone(response, message);
				});
				return response;
			},
		);
		for await (const _event of stream) {
			// consume
		}

		const assistants = (await stream.result()).filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(providerCalls).toBe(2);
		expect(assistants.at(-1)).toMatchObject({
			content: [],
			stopReason: "error",
			errorMessage: "verification_handoff_required",
		});
	});

	it("requires a valid unresolved handoff from the runaway closing turn", async () => {
		const schema = Type.Object({});
		const providerPrompts: string[] = [];
		const verify: AgentTool<typeof schema, { piVerification: { version: 1; id: string; status: "failed" } }> = {
			name: "verify",
			label: "Verify",
			description: "Run verification",
			parameters: schema,
			async execute() {
				return {
					content: [{ type: "text", text: "verification failed" }],
					details: { piVerification: { version: 1, id: "runaway-check", status: "failed" } },
					isError: true,
				};
			},
		};
		let providerCalls = 0;
		const stream = agentLoop(
			[createUserMessage("verify")],
			{ systemPrompt: "base", messages: [], tools: [verify] },
			{ model: createModel(), convertToLlm: identityConverter, maxStallTurns: 2 },
			undefined,
			(_model, providerContext) => {
				providerPrompts.push(obligationInstructionOf(providerContext));
				const response = new MockAssistantStream();
				const turn = providerCalls++;
				queueMicrotask(() => {
					const message =
						turn < 2
							? createAssistantMessage(
									[
										{
											type: "toolCall",
											id: `verify-runaway-${turn}`,
											name: "verify",
											arguments: {},
										},
									],
									"toolUse",
								)
							: createAssistantMessage([{ type: "text", text: "done" }]);
					pushDone(response, message);
				});
				return response;
			},
		);
		for await (const _event of stream) {
			// consume
		}

		const assistants = (await stream.result()).filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(providerCalls).toBe(3);
		expect(providerPrompts.at(-1)).toContain("ACTIVE VERIFICATION FAILURES");
		expect(assistants.at(-1)).toMatchObject({
			content: [],
			stopReason: "error",
			errorMessage: "verification_handoff_required",
		});
	});

	it("does not treat an untagged operation outcome as an unresolved verification", async () => {
		const schema = Type.Object({});
		const tool: AgentTool<typeof schema, { exitCode: number }> = {
			name: "bash",
			label: "Bash",
			description: "Run a command",
			parameters: schema,
			async execute() {
				return {
					content: [{ type: "text", text: "test command failed" }],
					details: { exitCode: 1 },
					isError: true,
					errorKind: "operation_outcome",
				};
			},
		};

		let providerCalls = 0;
		const stream = agentLoop(
			[createUserMessage("run the test")],
			{ systemPrompt: "base", messages: [], tools: [tool] },
			{ model: createModel(), convertToLlm: identityConverter },
			undefined,
			() => {
				const response = new MockAssistantStream();
				const turn = providerCalls++;
				queueMicrotask(() => {
					const message =
						turn === 0
							? createAssistantMessage(
									[
										{
											type: "toolCall",
											id: "bash-failed",
											name: "bash",
											arguments: {},
										},
									],
									"toolUse",
								)
							: createAssistantMessage([{ type: "text", text: "done" }]);
					pushDone(response, message);
				});
				return response;
			},
		);
		for await (const _event of stream) {
			// consume
		}

		expect(providerCalls).toBe(2);
	});

	it("sanitizes legacy failed tool turns before provider conversion", async () => {
		const failedAssistant = createAssistantMessage(
			[
				{
					type: "toolCall",
					id: "legacy-call",
					name: "shell",
					arguments: { command: "legacy command" },
				},
			],
			"toolUse",
		);
		const context: AgentContext = {
			systemPrompt: "base prompt",
			messages: [
				createUserMessage("old turn"),
				failedAssistant,
				{
					role: "toolResult",
					toolCallId: "legacy-call",
					toolName: "shell",
					content: [{ type: "text", text: `LEGACY_RAW_OUTPUT:${"y".repeat(20_000)}` }],
					details: {},
					isError: true,
					timestamp: Date.now(),
				},
			],
			tools: [],
		};
		let providerContext: Context | undefined;
		let transformInput: AgentMessage[] | undefined;
		const stream = agentLoop(
			[createUserMessage("continue")],
			context,
			{
				model: createModel(),
				transformContext: async (messages) => {
					transformInput = structuredClone(messages);
					return messages;
				},
				convertToLlm: identityConverter,
			},
			undefined,
			(_model, nextContext) => {
				providerContext = structuredClone(nextContext);
				const mockStream = new MockAssistantStream();
				queueMicrotask(() => {
					mockStream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				});
				return mockStream;
			},
		);

		for await (const _event of stream) {
			// consume
		}

		expect(providerContext?.systemPrompt).not.toContain("ACTIVE TOOL FAILURES");
		expect(ledgerOf(providerContext)).toContain("ACTIVE TOOL FAILURES");
		expect(ledgerOf(providerContext)).toContain("legacy command");
		// The unbounded legacy result is bounded in place; the call that produced it still stands.
		expect(JSON.stringify(providerContext)).not.toContain("LEGACY_RAW_OUTPUT");
		expect(providerContext?.messages.some((message) => message.role === "toolResult")).toBe(true);
		expect(JSON.stringify(transformInput)).not.toContain("LEGACY_RAW_OUTPUT");
	});

	it("reduces matching tool execution errors to a stable failure code", async () => {
		const toolSchema = Type.Object({ path: Type.String() });
		const tool: AgentTool<typeof toolSchema, { path: string }> = {
			name: "read_file",
			label: "Read file",
			description: "Read a file",
			parameters: toolSchema,
			async execute() {
				throw new Error("ENOENT: no such file or directory, open 'missing.txt'");
			},
		};
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};
		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[
								{
									type: "toolCall",
									id: "tool-1",
									name: "read_file",
									arguments: { path: "missing.txt" },
								},
							],
							"toolUse",
						),
					});
				} else {
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
				callIndex++;
			});
			return stream;
		};

		const stream = agentLoop([createUserMessage("read")], context, config, undefined, streamFn);
		for await (const _ of stream) {
			// consume
		}

		const messages = await stream.result();
		const toolResult = messages.find((message) => message.role === "toolResult");
		expect(toolResult?.content).toEqual([
			expect.objectContaining({
				type: "text",
				text: expect.stringContaining('"failure_code":"file_not_found"'),
			}),
		]);
		expect(JSON.stringify(toolResult)).toContain(
			"Path not found. List parent directory or re-read path before retry. The operation is readmitted after another tool succeeds or a new user turn",
		);
		expect(JSON.stringify(toolResult)).toContain("ENOENT: no such file or directory, open 'missing.txt'");
	});

	it("routes phone argument repairs through shared teaching and execution telemetry without argument values", async () => {
		const toolSchema = Type.Object({
			items: Type.Array(Type.Object({ value: Type.String() })),
		});
		const tool: AgentTool<typeof toolSchema, { items: Array<{ value: string }> }> = {
			name: "collect",
			label: "Collect",
			description: "Collect items",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: "ok" }], details: params };
			},
		};
		const telemetry: NonNullable<AgentLoopConfig["onToolArgumentValidation"]>[] = [];
		const events: Parameters<NonNullable<AgentLoopConfig["onToolArgumentValidation"]>>[0][] = [];
		telemetry.push((event) => events.push(event));
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			onToolArgumentValidation: telemetry[0],
		};
		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[
								{
									type: "toolCall",
									id: "tool-1",
									name: "collect",
									arguments: {
										items: JSON.stringify([{ value: "secret-value" }]),
									},
									source: "text-protocol",
								},
							],
							"toolUse",
						),
					});
				} else {
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
				callIndex++;
			});
			return stream;
		};

		const stream = agentLoop([createUserMessage("collect")], context, config, undefined, streamFn);
		for await (const _ of stream) {
			// consume
		}

		expect(events).toEqual([
			expect.objectContaining({
				outcome: "repaired",
				failureModes: expect.arrayContaining(["jsonStringParse"]),
				repairsApplied: ["jsonStringParse"],
				taught: "note",
				executionOutcome: "succeeded",
				source: "text-protocol",
			}),
		]);
		expect(JSON.stringify(events)).not.toContain("secret-value");
	});

	it("adds throttled teach-back notes to repaired tool results", async () => {
		const toolSchema = Type.Object({
			items: Type.Array(Type.Object({ value: Type.String() })),
		});
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { items: Array<{ value: string }> }> = {
			name: "collect",
			label: "Collect",
			description: "Collect items",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.items[0]?.value ?? "");
				return {
					content: [{ type: "text", text: `ran ${params.items[0]?.value ?? ""}` }],
					details: { items: params.items },
				};
			},
		};
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};
		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex < 5) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[
								{
									type: "toolCall",
									id: `tool-${callIndex}`,
									name: "collect",
									arguments: {
										items: JSON.stringify([{ value: String(callIndex + 1) }]),
									},
								},
							],
							"toolUse",
						),
					});
				} else {
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
				callIndex++;
			});
			return stream;
		};

		const stream = agentLoop([createUserMessage("collect")], context, config, undefined, streamFn);
		for await (const _ of stream) {
			// consume
		}

		const messages = await stream.result();
		const toolResults = messages.filter((message) => message.role === "toolResult");
		const resultTexts = toolResults.map((message) =>
			message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n"),
		);
		expect(executed).toEqual(["1", "2", "3", "4", "5"]);
		expect(resultTexts.map((text) => text.includes("[harness] jsonStringParse:"))).toEqual([
			true,
			false,
			false,
			false,
			true,
		]);
		expect(resultTexts[0]).toContain("send raw array/object");
	});

	it("retains repair teaching and telemetry when repaired execution fails", async () => {
		const toolSchema = Type.Object({
			items: Type.Array(Type.Object({ value: Type.String() })),
		});
		const validationEvents: Parameters<NonNullable<AgentLoopConfig["onToolArgumentValidation"]>>[0][] = [];
		const tool: AgentTool<typeof toolSchema, { items: Array<{ value: string }> }> = {
			name: "collect",
			label: "Collect",
			description: "Collect items",
			parameters: toolSchema,
			async execute() {
				throw new Error("storage refused the request");
			},
		};
		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex < 2) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[
								{
									type: "toolCall",
									id: `failing-${callIndex}`,
									name: "collect",
									arguments:
										callIndex === 0
											? { items: JSON.stringify([{ value: "repaired" }]) }
											: { items: [{ value: "already-valid" }] },
								},
							],
							"toolUse",
						),
					});
				} else {
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
				callIndex++;
			});
			return stream;
		};

		const stream = agentLoop(
			[createUserMessage("collect")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				onToolArgumentValidation: (event) => validationEvents.push(event),
			},
			undefined,
			streamFn,
		);
		for await (const _ of stream) {
			// consume
		}

		const failureTexts = (await stream.result())
			.filter((message) => message.role === "toolResult")
			.map((message) =>
				message.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n"),
			);
		expect(failureTexts[0]).toContain('"state":"failed"');
		expect(failureTexts[0]).toContain("storage refused the request");
		expect(failureTexts[0]).toContain("[harness] jsonStringParse:");
		expect(failureTexts[1]).toContain('"state":"failed"');
		expect(failureTexts[1]).not.toContain("[harness] jsonStringParse:");
		expect(validationEvents).toEqual([
			expect.objectContaining({
				outcome: "repaired",
				repairsApplied: ["jsonStringParse"],
				executionOutcome: "failed",
				taught: "note",
			}),
		]);
	});

	it("stores repaired tool args on the assistant message while preserving raw args", async () => {
		const toolSchema = Type.Object({ count: Type.Number() });
		const executed: number[] = [];
		const tool: AgentTool<typeof toolSchema, { count: number }> = {
			name: "count",
			label: "Count",
			description: "Count tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.count);
				return {
					content: [{ type: "text", text: String(params.count) }],
					details: { count: params.count },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};
		const userPrompt: AgentMessage = createUserMessage("count");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{
								type: "toolCall",
								id: "tool-1",
								name: "count",
								arguments: { count: "42" as unknown as number },
							},
						],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					stream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);
		for await (const _ of stream) {
			// consume
		}

		const messages = await stream.result();
		const assistant = messages.find(
			(message) => message.role === "assistant" && message.content[0]?.type === "toolCall",
		);
		const toolCall =
			assistant?.role === "assistant" ? assistant.content.find((block) => block.type === "toolCall") : undefined;
		expect(executed).toEqual([42]);
		expect(toolCall).toMatchObject({
			type: "toolCall",
			id: "tool-1",
			name: "count",
			arguments: { count: 42 },
			rawArguments: { count: "42" },
		});
	});

	it("bounces provider-marked tool call errors without executing the tool", async () => {
		const toolSchema = Type.Object({ value: Type.Optional(Type.String()) });
		const executed: unknown[] = [];
		const tool: AgentTool<typeof toolSchema, { value?: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params);
				return {
					content: [{ type: "text", text: "should not run" }],
					details: {},
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};
		const userPrompt: AgentMessage = createUserMessage("echo something");
		const validationEvents: Parameters<NonNullable<AgentLoopConfig["onToolArgumentValidation"]>>[0][] = [];
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			onToolArgumentValidation: (event) => validationEvents.push(event),
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{
								type: "toolCall",
								id: "tool-1",
								name: "echo",
								arguments: { value: "partial" },
								errorMessage: "Tool call arguments were truncated before complete JSON was received.",
							},
						],
						"length",
					);
					stream.push({ type: "done", reason: "length", message });
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					stream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);
		for await (const _ of stream) {
			// consume
		}

		const messages = await stream.result();
		const toolResult = messages.find((message) => message.role === "toolResult");
		expect(executed).toEqual([]);
		expect(toolResult).toMatchObject({
			role: "toolResult",
			isError: true,
			toolCallId: "tool-1",
			toolName: "echo",
		});
		expect(toolResult?.content).toEqual([
			expect.objectContaining({
				type: "text",
				text: expect.stringContaining('"failure_code":"malformed_call"'),
			}),
		]);
		expect(JSON.stringify(toolResult)).toContain('"phase":"validation"');
		expect(validationEvents).toHaveLength(1);
		expect(validationEvents[0]?.errorKeywords).toEqual(["malformed_call"]);
		expect(JSON.stringify(toolResult)).toContain("complete JSON argument object");
		expect(JSON.stringify(toolResult)).toContain("truncated before complete JSON");
	});

	it("teaches the live schema for repeated provider-marked malformed calls without losing parser detail", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		let executed = 0;
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed++;
				return {
					content: [{ type: "text", text: "should not run" }],
					details: { value: params.value },
				};
			},
		};
		const parserDetail = "Provider parser rejected the JSON token sequence before the value closed.";
		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: callIndex < 3 ? "toolUse" : "stop",
					message:
						callIndex < 3
							? createAssistantMessage(
									[
										{
											type: "toolCall",
											id: `malformed-${callIndex}`,
											name: "echo",
											arguments: { value: "partial" },
											errorMessage: parserDetail,
										},
									],
									"toolUse",
								)
							: createAssistantMessage([{ type: "text", text: "done" }]),
				});
				callIndex++;
			});
			return stream;
		};

		const stream = agentLoop(
			[createUserMessage("echo")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			{ model: createModel(), convertToLlm: identityConverter },
			undefined,
			streamFn,
		);
		for await (const _ of stream) {
			// consume
		}

		const resultTexts = (await stream.result())
			.filter((message) => message.role === "toolResult")
			.map((message) =>
				message.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n"),
			);
		expect(executed).toBe(0);
		expect(resultTexts[0]).not.toContain("Full tool schema:");
		expect(resultTexts[1]).not.toContain("Full tool schema:");
		expect(resultTexts[2]).toContain("Full tool schema:");
		expect(resultTexts[2]).toContain("Valid example:");
		expect(resultTexts[2]).toContain(parserDetail);
	});

	it("classifies an unknown phone tool by tool identity before its parser error", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		let executed = false;
		const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute() {
				executed = true;
				return {
					content: [{ type: "text", text: "should not run" }],
					details: {},
				};
			},
		};
		const validationEvents: Parameters<NonNullable<AgentLoopConfig["onToolArgumentValidation"]>>[0][] = [];
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			onToolArgumentValidation: (event) => validationEvents.push(event),
		};
		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: callIndex++ === 0 ? "toolUse" : "stop",
					message:
						callIndex === 1
							? createAssistantMessage(
									[
										{
											type: "toolCall",
											id: "phone-unknown",
											name: "missing",
											arguments: {},
											source: "text-protocol",
											errorMessage: 'Unknown tool "missing". Valid tools: echo.',
										},
									],
									"toolUse",
								)
							: createAssistantMessage([{ type: "text", text: "done" }]),
				});
			});
			return stream;
		};

		const stream = agentLoop(
			[createUserMessage("call a tool")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			config,
			undefined,
			streamFn,
		);
		for await (const _ of stream) {
			// consume
		}
		const result = await stream.result();
		const toolResult = result.find((message) => message.role === "toolResult");
		const failureText =
			toolResult?.role === "toolResult"
				? toolResult.content.find((block) => block.type === "text")?.text
				: undefined;

		expect(executed).toBe(false);
		expect(failureText).toContain('"failure_code":"unknown_tool"');
		expect(failureText).toContain('"phase":"validation"');
		expect(failureText).toContain("currently available tool list");
		expect(failureText).not.toContain('"failure_code":"malformed_call"');
		expect(validationEvents[0]?.source).toBe("text-protocol");
		expect(validationEvents[0]?.errorKeywords).toEqual(["unknown_tool"]);
	});

	it("preserves preflight identity and diagnostics without blaming valid arguments", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		let executed = false;
		const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute() {
				executed = true;
				return {
					content: [{ type: "text", text: "should not run" }],
					details: {},
				};
			},
		};
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			beforeToolCall: async () => {
				throw new Error("host capability lookup unavailable");
			},
		};
		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: callIndex++ === 0 ? "toolUse" : "stop",
					message:
						callIndex === 1
							? createAssistantMessage(
									[
										{
											type: "toolCall",
											id: "tool-preflight",
											name: "echo",
											arguments: { value: "ok" },
										},
									],
									"toolUse",
								)
							: createAssistantMessage([{ type: "text", text: "done" }]),
				});
			});
			return stream;
		};

		const stream = agentLoop([createUserMessage("echo")], context, config, undefined, streamFn);
		for await (const _ of stream) {
			// consume
		}
		const result = await stream.result();
		const toolResult = result.find((message) => message.role === "toolResult");
		const failureText = toolResult?.content[0]?.type === "text" ? toolResult.content[0].text : "";
		expect(executed).toBe(false);
		expect(failureText).toContain('"failure_code":"preflight_error"');
		expect(failureText).toContain('"phase":"preflight"');
		expect(failureText).toContain('"diagnostic":"host capability lookup unavailable"');
		expect(failureText).toMatch(/arguments valid/i);
		expect(failureText).not.toContain("change the invalid operation");
	});

	it("should execute mutated beforeToolCall args without revalidation", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: Array<string | number> = [];
		const tool: AgentTool<typeof toolSchema, { value: string | number }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value as string | number);
				return {
					content: [{ type: "text", text: `echoed: ${String(params.value)}` }],
					details: { value: params.value as string | number },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("echo something");

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			beforeToolCall: async ({ args }) => {
				const mutableArgs = args as { value: string | number };
				mutableArgs.value = 123;
				return undefined;
			},
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{
								type: "toolCall",
								id: "tool-1",
								name: "echo",
								arguments: { value: "hello" },
							},
						],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					stream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);
		for await (const _event of stream) {
			// consume
		}

		expect(executed).toEqual([123]);
	});

	it("should prepare tool arguments for validation", async () => {
		const replaceSchema = Type.Object({
			oldText: Type.String(),
			newText: Type.String(),
		});
		const toolSchema = Type.Object({ edits: Type.Array(replaceSchema) });
		const executed: Array<Array<{ oldText: string; newText: string }>> = [];
		const tool: AgentTool<typeof toolSchema, { count: number }> = {
			name: "edit",
			label: "Edit",
			description: "Edit tool",
			parameters: toolSchema,
			prepareArguments(args) {
				if (!args || typeof args !== "object") {
					return args as { edits: { oldText: string; newText: string }[] };
				}
				const input = args as {
					edits?: Array<{ oldText: string; newText: string }>;
					oldText?: string;
					newText?: string;
				};
				if (typeof input.oldText !== "string" || typeof input.newText !== "string") {
					return args as { edits: { oldText: string; newText: string }[] };
				}
				return {
					edits: [...(input.edits ?? []), { oldText: input.oldText, newText: input.newText }],
				};
			},
			async execute(_toolCallId, params) {
				executed.push(params.edits);
				return {
					content: [{ type: "text", text: `edited ${params.edits.length}` }],
					details: { count: params.edits.length },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("edit something");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{
								type: "toolCall",
								id: "tool-1",
								name: "edit",
								arguments: { oldText: "before", newText: "after" },
							},
						],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					stream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);
		for await (const _event of stream) {
			// consume
		}

		expect(executed).toEqual([[{ oldText: "before", newText: "after" }]]);
	});

	it("should emit tool_execution_end in completion order but persist tool results in source order", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		let firstResolved = false;
		let parallelObserved = false;
		let releaseFirst: (() => void) | undefined;
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				if (params.value === "first") {
					await firstDone;
					firstResolved = true;
				}
				if (params.value === "second" && !firstResolved) {
					parallelObserved = true;
				}
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("echo both");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolExecution: "parallel",
		};

		let callIndex = 0;
		const stream = agentLoop([userPrompt], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{
								type: "toolCall",
								id: "tool-1",
								name: "echo",
								arguments: { value: "first" },
							},
							{
								type: "toolCall",
								id: "tool-2",
								name: "echo",
								arguments: { value: "second" },
							},
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
					setTimeout(() => releaseFirst?.(), 20);
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const toolExecutionEndIds = events.flatMap((event) => {
			if (event.type !== "tool_execution_end") {
				return [];
			}
			return [event.toolCallId];
		});
		const toolResultIds = events.flatMap((event) => {
			if (event.type !== "message_end" || event.message.role !== "toolResult") {
				return [];
			}
			return [event.message.toolCallId];
		});
		const turnToolResultIds = events.flatMap((event) => {
			if (event.type !== "turn_end") {
				return [];
			}
			return event.toolResults.map((toolResult) => toolResult.toolCallId);
		});

		expect(parallelObserved).toBe(true);
		expect(toolExecutionEndIds).toEqual(["tool-2", "tool-1"]);
		expect(toolResultIds).toEqual(["tool-1", "tool-2"]);
		expect(turnToolResultIds).toEqual(["tool-1", "tool-2"]);
	});

	it("keeps mixed read, edit, and bash batch results paired, ordered, and recoverable after sibling failures", async () => {
		const readSchema = Type.Object({ path: Type.String() });
		const editSchema = Type.Object({
			path: Type.String(),
			replacement: Type.String(),
		});
		const bashSchema = Type.Object({ command: Type.String() });
		let releaseFirstRead: (() => void) | undefined;
		const firstReadReleased = new Promise<void>((resolve) => {
			releaseFirstRead = resolve;
		});
		const executed: string[] = [];
		const read: AgentTool<typeof readSchema, { path: string }> = {
			name: "read",
			label: "Read",
			description: "Read a file",
			parameters: readSchema,
			async execute(_toolCallId, params) {
				executed.push(`read:${params.path}`);
				if (params.path === "/one") await firstReadReleased;
				if (params.path === "/two") releaseFirstRead?.();
				return {
					content: [{ type: "text", text: `read:${params.path}` }],
					details: { path: params.path },
				};
			},
		};
		const edit: AgentTool<typeof editSchema, { path: string; replacement: string }> = {
			name: "edit",
			label: "Edit",
			description: "Edit a file",
			parameters: editSchema,
			async execute(_toolCallId, params) {
				executed.push(`edit:${params.path}:${params.replacement}`);
				return {
					content: [{ type: "text", text: `edit:${params.path}:${params.replacement}` }],
					details: { path: params.path, replacement: params.replacement },
				};
			},
		};
		const bash: AgentTool<typeof bashSchema, { command: string }> = {
			name: "bash",
			label: "Bash",
			description: "Run a command",
			parameters: bashSchema,
			async execute(_toolCallId, params) {
				executed.push(`bash:${params.command}`);
				throw new Error("bash fixture failed");
			},
		};

		let providerCall = 0;
		const events: AgentEvent[] = [];
		const stream = agentLoop(
			[createUserMessage("apply batch")],
			{ systemPrompt: "", messages: [], tools: [read, edit, bash] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				maxStallTurns: 0,
			},
			undefined,
			(_model, context) => {
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					if (providerCall === 0) {
						response.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								[
									{
										type: "toolCall",
										id: "read-1",
										name: "read",
										arguments: { path: "/one" },
									},
									{
										type: "toolCall",
										id: "edit-1",
										name: "edit",
										arguments: { path: "/one", replacement: "A" },
									},
									{
										type: "toolCall",
										id: "bash-fail",
										name: "bash",
										arguments: { command: "false" },
									},
									{
										type: "toolCall",
										id: "read-2",
										name: "read",
										arguments: { path: "/two" },
									},
									{
										type: "toolCall",
										id: "edit-invalid",
										name: "edit",
										arguments: { path: "/bad", replacement: 1 },
									},
									{
										type: "toolCall",
										id: "edit-2",
										name: "edit",
										arguments: { path: "/two", replacement: "B" },
									},
								],
								"toolUse",
							),
						});
					} else if (providerCall === 1) {
						const priorResultIds = context.messages.flatMap((message) =>
							message.role === "toolResult" ? [message.toolCallId] : [],
						);
						expect(priorResultIds).toEqual(["read-1", "edit-1", "bash-fail", "read-2", "edit-invalid", "edit-2"]);
						response.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								[
									{
										type: "toolCall",
										id: "edit-corrected",
										name: "edit",
										arguments: { path: "/bad", replacement: "C" },
									},
								],
								"toolUse",
							),
						});
					} else {
						response.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "done" }]),
						});
					}
					providerCall++;
				});
				return response;
			},
		);
		for await (const event of stream) events.push(event);

		const results = (await stream.result()).filter(
			(message): message is ToolResultMessage => message.role === "toolResult",
		);
		expect(results.map((result) => result.toolCallId)).toEqual([
			"read-1",
			"edit-1",
			"bash-fail",
			"read-2",
			"edit-invalid",
			"edit-2",
			"edit-corrected",
		]);
		expect(new Set(results.map((result) => result.toolCallId)).size).toBe(results.length);
		expect(results.find((result) => result.toolCallId === "bash-fail")?.isError).toBe(true);
		expect(results.find((result) => result.toolCallId === "edit-invalid")?.isError).toBe(true);
		expect(executed).toEqual(
			expect.arrayContaining(["read:/one", "read:/two", "edit:/one:A", "edit:/two:B", "bash:false", "edit:/bad:C"]),
		);
		expect(executed).not.toContain("edit:/bad:1");
		const completedIds = events.flatMap((event) => (event.type === "tool_execution_end" ? [event.toolCallId] : []));
		expect(completedIds.indexOf("edit-1")).toBeLessThan(completedIds.indexOf("read-1"));
	});

	it("executes sequential edit batches in source order despite an invalid sibling", async () => {
		const schema = Type.Object({
			path: Type.String(),
			replacement: Type.String(),
		});
		const started: string[] = [];
		const completed: string[] = [];
		let inFlight = false;
		let overlapped = false;
		const edit: AgentTool<typeof schema, { path: string; replacement: string }> = {
			name: "edit",
			label: "Edit",
			description: "Sequential edit",
			parameters: schema,
			executionMode: "sequential",
			async execute(toolCallId, params) {
				if (inFlight) overlapped = true;
				inFlight = true;
				started.push(toolCallId);
				await Promise.resolve();
				inFlight = false;
				completed.push(toolCallId);
				return {
					content: [{ type: "text", text: `${params.path}:${params.replacement}` }],
					details: { path: params.path, replacement: params.replacement },
				};
			},
		};
		let providerCall = 0;
		const events: AgentEvent[] = [];
		const stream = agentLoop(
			[createUserMessage("edit batch")],
			{ systemPrompt: "", messages: [], tools: [edit] },
			{ model: createModel(), convertToLlm: identityConverter },
			undefined,
			() => {
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					response.push(
						providerCall++ === 0
							? {
									type: "done",
									reason: "toolUse",
									message: createAssistantMessage(
										[
											{
												type: "toolCall",
												id: "edit-1",
												name: "edit",
												arguments: { path: "/one", replacement: "A" },
											},
											{
												type: "toolCall",
												id: "edit-invalid",
												name: "edit",
												arguments: { path: "/invalid", replacement: 1 },
											},
											{
												type: "toolCall",
												id: "edit-2",
												name: "edit",
												arguments: { path: "/two", replacement: "B" },
											},
										],
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
				return response;
			},
		);
		for await (const event of stream) events.push(event);

		const results = (await stream.result()).filter(
			(message): message is ToolResultMessage => message.role === "toolResult",
		);
		expect(overlapped).toBe(false);
		expect(started).toEqual(["edit-1", "edit-2"]);
		expect(completed).toEqual(["edit-1", "edit-2"]);
		expect(results.map((result) => result.toolCallId)).toEqual(["edit-1", "edit-invalid", "edit-2"]);
		expect(new Set(results.map((result) => result.toolCallId)).size).toBe(3);
		expect(results.find((result) => result.toolCallId === "edit-invalid")?.isError).toBe(true);
		const endIds = events.flatMap((event) => (event.type === "tool_execution_end" ? [event.toolCallId] : []));
		expect(endIds).toEqual(["edit-1", "edit-invalid", "edit-2"]);
	});

	it("reserves a prepared parallel wave once before any tool body starts", async () => {
		const schema = Type.Object({ value: Type.String() });
		const executed: string[] = [];
		const reservations: string[][] = [];
		const events: AgentEvent[] = [];
		const tool: AgentTool<typeof schema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: schema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: params.value }],
					details: params,
				};
			},
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			onToolCallStart: async (calls) => {
				reservations.push(calls.map((call) => `${call.callId}:${call.toolName}`));
				throw new Error("tool reservation failed");
			},
		};
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};
		let transportCalls = 0;
		const stream = agentLoop([createUserMessage("run both")], context, config, undefined, () => {
			transportCalls++;
			const response = new MockAssistantStream();
			queueMicrotask(() =>
				response.push({
					type: "done",
					reason: "toolUse",
					message: createAssistantMessage(
						[
							{
								type: "toolCall",
								id: "tool-1",
								name: "echo",
								arguments: { value: "one" },
							},
							{
								type: "toolCall",
								id: "tool-2",
								name: "echo",
								arguments: { value: "two" },
							},
						],
						"toolUse",
					),
				}),
			);
			return response;
		});

		for await (const event of stream) events.push(event);

		expect(reservations).toEqual([["tool-1:echo", "tool-2:echo"]]);
		expect(executed).toEqual([]);
		expect(transportCalls).toBe(1);
		expect(events.filter((event) => event.type === "tool_execution_start")).toHaveLength(0);
		expect(events.filter((event) => event.type === "tool_execution_end")).toHaveLength(0);
		await expect(stream.result()).resolves.toEqual(
			expect.arrayContaining([expect.objectContaining({ role: "assistant", stopReason: "error" })]),
		);
	});

	it("reserves sequential prepared bodies individually and threads one request id", async () => {
		const schema = Type.Object({ value: Type.String() });
		const order: string[] = [];
		const reservations: string[][] = [];
		const requestIds: string[] = [];
		const tool: AgentTool<typeof schema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: schema,
			executionMode: "sequential",
			async execute(_toolCallId, params) {
				order.push(`execute:${params.value}`);
				return {
					content: [{ type: "text", text: params.value }],
					details: params,
				};
			},
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolExecution: "sequential",
			onToolCallStart: (calls) => {
				reservations.push(calls.map((call) => call.toolCall.id));
				requestIds.push(...calls.map((call) => call.requestId));
				order.push(`reserve:${calls[0]?.toolCall.id}`);
			},
		};
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};
		let callIndex = 0;
		const stream = agentLoop([createUserMessage("run both")], context, config, undefined, () => {
			const response = new MockAssistantStream();
			queueMicrotask(() => {
				response.push({
					type: "done",
					reason: callIndex++ === 0 ? "toolUse" : "stop",
					message:
						callIndex === 1
							? createAssistantMessage(
									[
										{
											type: "toolCall",
											id: "tool-1",
											name: "echo",
											arguments: { value: "one" },
										},
										{
											type: "toolCall",
											id: "tool-2",
											name: "echo",
											arguments: { value: "two" },
										},
									],
									"toolUse",
								)
							: createAssistantMessage([{ type: "text", text: "done" }]),
				});
			});
			return response;
		});

		for await (const _event of stream) {
			// consume
		}

		expect(reservations).toEqual([["tool-1"], ["tool-2"]]);
		expect(order).toEqual(["reserve:tool-1", "execute:one", "reserve:tool-2", "execute:two"]);
		expect(requestIds).toHaveLength(2);
		expect(requestIds[0]).toBe(requestIds[1]);
	});

	it("does not reserve immediate validation, policy, or replay outcomes", async () => {
		const schema = Type.Object({ value: Type.String() });
		let executions = 0;
		let reservations = 0;
		const tool: AgentTool<typeof schema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: schema,
			async execute() {
				executions++;
				return {
					content: [{ type: "text", text: "ok" }],
					details: { value: "ok" },
				};
			},
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			onToolCallStart: () => {
				reservations++;
			},
			beforeToolCall: async ({ args }) => {
				if ((args as { value: string }).value === "blocked") return { block: true };
				return undefined;
			},
		};
		let callIndex = 0;
		const stream = agentLoop(
			[createUserMessage("run")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			config,
			undefined,
			() => {
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					if (callIndex === 0) {
						response.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								[
									{
										type: "toolCall",
										id: "invalid",
										name: "echo",
										arguments: { value: 1 },
									},
									{
										type: "toolCall",
										id: "blocked",
										name: "echo",
										arguments: { value: "blocked" },
									},
								],
								"toolUse",
							),
						});
					} else {
						response.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "done" }]),
						});
					}
					callIndex++;
				});
				return response;
			},
		);
		for await (const _event of stream) {
			// consume
		}

		expect(reservations).toBe(0);
		expect(executions).toBe(0);

		let replayCallIndex = 0;
		reservations = 0;
		executions = 0;
		const replayStream = agentLoop(
			[createUserMessage("repeat")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			config,
			undefined,
			() => {
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					const toolCall = {
						type: "toolCall" as const,
						id: `repeat-${replayCallIndex}`,
						name: "echo",
						arguments: { value: "same" },
						source: "text-protocol" as const,
					};
					response.push(
						replayCallIndex++ < 2
							? {
									type: "done",
									reason: "toolUse",
									message: createAssistantMessage([toolCall], "toolUse"),
								}
							: {
									type: "done",
									reason: "stop",
									message: createAssistantMessage([{ type: "text", text: "done" }]),
								},
					);
				});
				return response;
			},
		);
		for await (const _event of replayStream) {
			// consume
		}
		expect(reservations).toBe(1);
		expect(executions).toBe(1);
	});

	it("should inject queued messages after all tool calls complete", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `ok:${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("start");
		const queuedUserMessage: AgentMessage = createUserMessage("interrupt");

		let queuedDelivered = false;
		let callIndex = 0;
		let sawInterruptInContext = false;

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolExecution: "sequential",
			getSteeringMessages: async () => {
				// Return steering message after tool execution has started.
				if (executed.length >= 1 && !queuedDelivered) {
					queuedDelivered = true;
					return [queuedUserMessage];
				}
				return [];
			},
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([userPrompt], context, config, undefined, (_model, ctx, _options) => {
			// Check if interrupt message is in context on second call
			if (callIndex === 1) {
				sawInterruptInContext = ctx.messages.some(
					(m) => m.role === "user" && typeof m.content === "string" && m.content === "interrupt",
				);
			}

			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					// First call: return two tool calls
					const message = createAssistantMessage(
						[
							{
								type: "toolCall",
								id: "tool-1",
								name: "echo",
								arguments: { value: "first" },
							},
							{
								type: "toolCall",
								id: "tool-2",
								name: "echo",
								arguments: { value: "second" },
							},
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
				} else {
					// Second call: return final response
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		for await (const event of stream) {
			events.push(event);
		}

		// Both tools should execute before steering is injected
		expect(executed).toEqual(["first", "second"]);

		const toolEnds = events.filter(
			(e): e is Extract<AgentEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end",
		);
		expect(toolEnds.length).toBe(2);
		expect(toolEnds[0].isError).toBe(false);
		expect(toolEnds[1].isError).toBe(false);

		// Queued message should appear in events after both tool result messages
		const eventSequence = events.flatMap((event) => {
			if (event.type !== "message_start") return [];
			if (event.message.role === "toolResult") return [`tool:${event.message.toolCallId}`];
			if (event.message.role === "user" && typeof event.message.content === "string") {
				return [event.message.content];
			}
			return [];
		});
		expect(eventSequence).toContain("interrupt");
		expect(eventSequence.indexOf("tool:tool-1")).toBeLessThan(eventSequence.indexOf("interrupt"));
		expect(eventSequence.indexOf("tool:tool-2")).toBeLessThan(eventSequence.indexOf("interrupt"));

		// Interrupt message should be in context when second LLM call is made
		expect(sawInterruptInContext).toBe(true);
	});

	it("should force sequential execution when a tool has executionMode=sequential even with default parallel config", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		let firstResolved = false;
		let parallelObserved = false;
		let releaseFirst: (() => void) | undefined;
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const slowTool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "slow",
			label: "Slow",
			description: "Slow tool",
			parameters: toolSchema,
			executionMode: "sequential",
			async execute(_toolCallId, params) {
				if (params.value === "first") {
					await firstDone;
					firstResolved = true;
				}
				if (params.value === "second" && !firstResolved) {
					parallelObserved = true;
				}
				return {
					content: [{ type: "text", text: `slow: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [slowTool],
		};

		const userPrompt: AgentMessage = createUserMessage("run both");
		// config is parallel (default), but tool forces sequential
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let callIndex = 0;
		const stream = agentLoop([userPrompt], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{
								type: "toolCall",
								id: "tool-1",
								name: "slow",
								arguments: { value: "first" },
							},
							{
								type: "toolCall",
								id: "tool-2",
								name: "slow",
								arguments: { value: "second" },
							},
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
					setTimeout(() => releaseFirst?.(), 20);
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		// With sequential execution, second tool should NOT start before first finishes
		expect(parallelObserved).toBe(false);

		const toolResultIds = events.flatMap((event) => {
			if (event.type !== "message_end" || event.message.role !== "toolResult") {
				return [];
			}
			return [event.message.toolCallId];
		});
		expect(toolResultIds).toEqual(["tool-1", "tool-2"]);
	});

	it("should force sequential execution when one of multiple tools has executionMode=sequential", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executionOrder: string[] = [];
		let releaseSlow: (() => void) | undefined;
		const slowDone = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});

		const slowTool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "slow",
			label: "Slow",
			description: "Slow tool",
			parameters: toolSchema,
			executionMode: "sequential",
			async execute(_toolCallId, params) {
				executionOrder.push(`slow:${params.value}`);
				if (params.value === "a") {
					await slowDone;
				}
				return {
					content: [{ type: "text", text: `slow: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const fastTool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "fast",
			label: "Fast",
			description: "Fast tool",
			parameters: toolSchema,
			// no executionMode = defaults to parallel
			async execute(_toolCallId, params) {
				executionOrder.push(`fast:${params.value}`);
				return {
					content: [{ type: "text", text: `fast: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [slowTool, fastTool],
		};

		const userPrompt: AgentMessage = createUserMessage("run both");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			// parallel by default, but slowTool forces sequential
		};

		let callIndex = 0;
		const stream = agentLoop([userPrompt], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{
								type: "toolCall",
								id: "tool-1",
								name: "slow",
								arguments: { value: "a" },
							},
							{
								type: "toolCall",
								id: "tool-2",
								name: "fast",
								arguments: { value: "b" },
							},
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
					setTimeout(() => releaseSlow?.(), 20);
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		// Fast tool should NOT run before slow tool finishes
		expect(executionOrder[0]).toBe("slow:a");
		expect(executionOrder).toContain("fast:b");
	});

	it("should allow parallel execution when all tools have executionMode=parallel", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		let firstResolved = false;
		let parallelObserved = false;
		let releaseFirst: (() => void) | undefined;
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			executionMode: "parallel",
			async execute(_toolCallId, params) {
				if (params.value === "first") {
					await firstDone;
					firstResolved = true;
				}
				if (params.value === "second" && !firstResolved) {
					parallelObserved = true;
				}
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("echo both");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let callIndex = 0;
		const stream = agentLoop([userPrompt], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{
								type: "toolCall",
								id: "tool-1",
								name: "echo",
								arguments: { value: "first" },
							},
							{
								type: "toolCall",
								id: "tool-2",
								name: "echo",
								arguments: { value: "second" },
							},
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
					setTimeout(() => releaseFirst?.(), 20);
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		// With executionMode=parallel, second tool should start before first finishes
		expect(parallelObserved).toBe(true);
	});

	it("should use prepareNextTurn snapshot before continuing", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};
		const context: AgentContext = {
			systemPrompt: "first prompt",
			messages: [],
			tools: [tool],
		};
		let convertedSecondTurnSystemPrompt = "";
		let prepared = false;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			prepareNextTurn: async ({ context: currentContext }) => {
				if (prepared) return undefined;
				prepared = true;
				return {
					context: {
						systemPrompt: "second prompt",
						messages: currentContext.messages.slice(),
						tools: currentContext.tools,
					},
				};
			},
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, (_model, ctx) => {
			llmCalls++;
			if (llmCalls === 2) {
				convertedSecondTurnSystemPrompt = ctx.systemPrompt ?? "";
			}
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (llmCalls === 1) {
					mockStream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[
								{
									type: "toolCall",
									id: "tool-1",
									name: "echo",
									arguments: { value: "hello" },
								},
							],
							"toolUse",
						),
					});
				} else {
					mockStream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
			});
			return mockStream;
		});

		for await (const _event of stream) {
			// consume
		}

		expect(llmCalls).toBe(2);
		expect(convertedSecondTurnSystemPrompt).toBe("second prompt");
	});

	it("should stop after the current turn when shouldStopAfterTurn returns true", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		let steeringPolls = 0;
		let followUpPolls = 0;
		let callbackToolResultIds: string[] = [];
		let callbackContextRoles: string[] = [];
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			getSteeringMessages: async () => {
				steeringPolls++;
				return [];
			},
			getFollowUpMessages: async () => {
				followUpPolls++;
				return [createUserMessage("follow up should stay queued")];
			},
			shouldStopAfterTurn: async ({ message, toolResults, context }) => {
				expect(message.role).toBe("assistant");
				callbackToolResultIds = toolResults.map((toolResult) => toolResult.toolCallId);
				callbackContextRoles = context.messages.map((contextMessage) => contextMessage.role);
				return true;
			},
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, () => {
			llmCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (llmCalls === 1) {
					const message = createAssistantMessage(
						[
							{
								type: "toolCall",
								id: "tool-1",
								name: "echo",
								arguments: { value: "hello" },
							},
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
				} else {
					mockStream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "should not run" }]),
					});
				}
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		expect(llmCalls).toBe(1);
		expect(executed).toEqual(["hello"]);
		expect(steeringPolls).toBe(1);
		expect(followUpPolls).toBe(0);
		expect(callbackToolResultIds).toEqual(["tool-1"]);
		expect(callbackContextRoles).toEqual(["user", "assistant", "toolResult"]);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(events.map((event) => event.type)).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_end",
			"tool_execution_start",
			"tool_execution_end",
			"message_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);
	});

	it("should stop after a tool batch when every tool result sets terminate=true", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
					terminate: true,
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, () => {
			llmCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage(
					[
						{
							type: "toolCall",
							id: "tool-1",
							name: "echo",
							arguments: { value: "hello" },
						},
					],
					"toolUse",
				);
				mockStream.push({ type: "done", reason: "toolUse", message });
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		expect(llmCalls).toBe(1);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(events.filter((event) => event.type === "turn_end")).toHaveLength(1);
	});

	it("should continue after parallel tool calls when not all tool results terminate", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
					terminate: params.value === "first",
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolExecution: "parallel",
		};

		let callIndex = 0;
		const stream = agentLoop([createUserMessage("echo both")], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{
								type: "toolCall",
								id: "tool-1",
								name: "echo",
								arguments: { value: "first" },
							},
							{
								type: "toolCall",
								id: "tool-2",
								name: "echo",
								arguments: { value: "second" },
							},
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		for await (const _event of stream) {
			// consume
		}

		const messages = await stream.result();
		expect(callIndex).toBe(2);
		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"toolResult",
			"assistant",
		]);
	});

	it("should allow afterToolCall to mark a tool batch as terminating", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			afterToolCall: async () => ({ terminate: true }),
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, () => {
			llmCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage(
					[
						{
							type: "toolCall",
							id: "tool-1",
							name: "echo",
							arguments: { value: "hello" },
						},
					],
					"toolUse",
				);
				mockStream.push({ type: "done", reason: "toolUse", message });
			});
			return mockStream;
		});

		for await (const _event of stream) {
			// consume
		}

		expect(llmCalls).toBe(1);
	});
});

describe("agentLoopContinue with AgentMessage", () => {
	it("should throw when context has no messages", () => {
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		expect(() => agentLoopContinue(context, config)).toThrow("Cannot continue: no messages in context");
	});

	it("should continue from existing context without emitting user message events", async () => {
		const userMessage: AgentMessage = createUserMessage("Hello");

		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [userMessage],
			tools: [],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Response" }]);
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoopContinue(context, config, undefined, streamFn);

		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();

		// Should only return the new assistant message (not the existing user message)
		expect(messages.length).toBe(1);
		expect(messages[0].role).toBe("assistant");

		// Should NOT have user message events (that's the key difference from agentLoop)
		const messageEndEvents = events.filter((e) => e.type === "message_end");
		expect(messageEndEvents.length).toBe(1);
		expect((messageEndEvents[0] as any).message.role).toBe("assistant");
	});

	it("does not mutate the caller's context.messages array in place", async () => {
		const userMessage: AgentMessage = createUserMessage("Hello");

		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [userMessage],
			tools: [],
		};
		const callerMessagesArray = context.messages;
		const callerMessagesSnapshot = [...context.messages];

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Response" }]);
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const stream = agentLoopContinue(context, config, undefined, streamFn);

		for await (const _event of stream) {
			// drain
		}

		const newMessages = await stream.result();

		// The caller's array must remain the same reference with the same contents:
		// runAgentLoopContinue must copy before appending, matching runAgentLoop's symmetry.
		expect(context.messages).toBe(callerMessagesArray);
		expect(context.messages).toEqual(callerMessagesSnapshot);
		expect(context.messages.length).toBe(1);

		// The returned newMessages array carries the appended assistant response.
		expect(newMessages.length).toBe(1);
		expect(newMessages[0].role).toBe("assistant");
	});

	it("should allow custom message types as last message (caller responsibility)", async () => {
		// Custom message that will be converted to user message by convertToLlm
		interface CustomMessage {
			role: "custom";
			text: string;
			timestamp: number;
		}

		const customMessage: CustomMessage = {
			role: "custom",
			text: "Hook content",
			timestamp: Date.now(),
		};

		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [customMessage as unknown as AgentMessage],
			tools: [],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: (messages) => {
				// Convert custom to user message
				return messages
					.map((m) => {
						if ((m as any).role === "custom") {
							return {
								role: "user" as const,
								content: (m as any).text,
								timestamp: m.timestamp,
							};
						}
						return m;
					})
					.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
			},
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Response to custom message" }]);
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		// Should not throw - the custom message will be converted to user message
		const stream = agentLoopContinue(context, config, undefined, streamFn);

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		expect(messages.length).toBe(1);
		expect(messages[0].role).toBe("assistant");
	});
});

/**
 * Phase 3 S0 — characterization tests (parity oracle).
 *
 * These pin EXACTLY how `executeToolCalls`'s sequential/parallel branches behave today, at
 * `packages/agent/src/agent-loop.ts`, before the S1-S5 refactor (waves -> sliding pool,
 * whole-batch-sequential -> partition scheduling). See
 * `packages/coding-agent/docs/parallelism-and-alias-display-roadmap-2026-08-29.md` section 6.
 * Every assertion here is a fact about current code, not a spec for the new code: two are
 * documented as INTENDED to change (the mixed-batch poisoning in S0.4, updated by S2; the wave
 * barrier in S0.wave, replaced by S3's pool). Everything else is a guarantee the refactor must
 * preserve byte-for-byte.
 */
describe("Phase 3 S0 - tool-execution scheduler characterization", () => {
	describe("S0.1 - sequential branch (today)", () => {
		it("an erroring call does not stop later calls; reservePreparedToolCalls receives singleton arrays in emission order", async () => {
			const schema = Type.Object({ value: Type.String() });
			const executed: string[] = [];
			const reservations: string[][] = [];
			const tool: AgentTool<typeof schema, { value: string }> = {
				name: "step",
				label: "Step",
				description: "Step tool",
				parameters: schema,
				async execute(_toolCallId, params) {
					executed.push(params.value);
					if (params.value === "b") throw new Error("boom");
					return { content: [{ type: "text", text: params.value }], details: { value: params.value } };
				},
			};
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				toolExecution: "sequential",
				onToolCallStart: (calls) => {
					reservations.push(calls.map((call) => call.callId));
				},
			};
			const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
			let providerCall = 0;
			const stream = agentLoop([createUserMessage("run three")], context, config, undefined, () => {
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					if (providerCall === 0) {
						response.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								[
									{ type: "toolCall", id: "call-a", name: "step", arguments: { value: "a" } },
									{ type: "toolCall", id: "call-b", name: "step", arguments: { value: "b" } },
									{ type: "toolCall", id: "call-c", name: "step", arguments: { value: "c" } },
								],
								"toolUse",
							),
						});
					} else {
						response.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "done" }]),
						});
					}
					providerCall++;
				});
				return response;
			});

			for await (const _event of stream) {
				// consume
			}

			// b's runtime error does not stop c from running.
			expect(executed).toEqual(["a", "b", "c"]);
			const results = (await stream.result()).filter(
				(message): message is ToolResultMessage => message.role === "toolResult",
			);
			expect(results.map((r) => r.toolCallId)).toEqual(["call-a", "call-b", "call-c"]);
			expect(results.map((r) => r.isError ?? false)).toEqual([false, true, false]);
			// One singleton reservation per call, in emission order (E5).
			expect(reservations).toEqual([["call-a"], ["call-b"], ["call-c"]]);
		});
	});

	describe("S0.2 - parallel branch (today)", () => {
		it("reserves the whole wave once, returns results in emission order despite reverse completion, and a sibling error never cancels others", async () => {
			const schema = Type.Object({ value: Type.String() });
			const executed: string[] = [];
			const reservations: string[][] = [];
			const completionOrder: string[] = [];
			const releases = new Map<string, () => void>();
			const gates = new Map<string, Promise<void>>();
			for (const value of ["a", "b", "c"]) {
				gates.set(value, new Promise<void>((resolve) => releases.set(value, resolve)));
			}
			let startedCount = 0;
			let resolveAllStarted: () => void;
			const allStarted = new Promise<void>((resolve) => {
				resolveAllStarted = resolve;
			});
			const tool: AgentTool<typeof schema, { value: string }> = {
				name: "step",
				label: "Step",
				description: "Step tool",
				parameters: schema,
				async execute(_toolCallId, params) {
					executed.push(params.value);
					startedCount++;
					if (startedCount === 3) resolveAllStarted();
					await gates.get(params.value);
					completionOrder.push(params.value);
					if (params.value === "b") throw new Error("boom");
					return { content: [{ type: "text", text: params.value }], details: { value: params.value } };
				},
			};
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				toolExecution: "parallel",
				onToolCallStart: (calls) => {
					reservations.push(calls.map((call) => call.callId));
				},
			};
			const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
			let providerCall = 0;
			const stream = agentLoop([createUserMessage("run three")], context, config, undefined, () => {
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					if (providerCall === 0) {
						response.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								[
									{ type: "toolCall", id: "call-a", name: "step", arguments: { value: "a" } },
									{ type: "toolCall", id: "call-b", name: "step", arguments: { value: "b" } },
									{ type: "toolCall", id: "call-c", name: "step", arguments: { value: "c" } },
								],
								"toolUse",
							),
						});
					} else {
						response.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "done" }]),
						});
					}
					providerCall++;
				});
				return response;
			});

			const events: AgentEvent[] = [];
			const consuming = (async () => {
				for await (const event of stream) events.push(event);
			})();

			// Wait for all three bodies to actually start before releasing them out of emission
			// order - proves the whole wave was dispatched together, not one-at-a-time.
			await allStarted;
			expect(executed.sort()).toEqual(["a", "b", "c"]);
			releases.get("c")?.();
			releases.get("b")?.();
			releases.get("a")?.();
			await consuming;

			const results = (await stream.result()).filter(
				(message): message is ToolResultMessage => message.role === "toolResult",
			);
			expect(completionOrder).toEqual(["c", "b", "a"]);
			// Results are still in ORIGINAL emission order, not completion order (E6).
			expect(results.map((r) => r.toolCallId)).toEqual(["call-a", "call-b", "call-c"]);
			// b's error does not affect a or c (E6).
			expect(results.map((r) => r.isError ?? false)).toEqual([false, true, false]);
			// One reservation call for the WHOLE wave, arity 3 (E5).
			expect(reservations).toEqual([["call-a", "call-b", "call-c"]]);
		});
	});

	describe("S0.3 - abort mid-batch (both branches)", () => {
		it("sequential: a call whose OWN preparation observes an already-aborted signal is finalized as an explicit error result; later calls are simply absent (never prepared) - no throw", async () => {
			const schema = Type.Object({ value: Type.String() });
			const executed: string[] = [];
			const controller = new AbortController();
			const tool: AgentTool<typeof schema, { value: string }> = {
				name: "step",
				label: "Step",
				description: "Step tool",
				parameters: schema,
				async execute(_toolCallId, params) {
					executed.push(params.value);
					return { content: [{ type: "text", text: params.value }], details: { value: params.value } };
				},
			};
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				toolExecution: "sequential",
				// This batch never sets terminate:true, so without a cap the outer loop would request
				// a second provider turn on the now-aborted signal - that unrelated request throws at
				// its own preflight (provider-request-planner.ts throwIfAborted) and collapses the
				// WHOLE run's result (see the dedicated pin below). Capping isolates the fact this test
				// actually characterizes: executeToolCalls's OWN behavior within the first turn.
				maxProviderTurns: 1,
				beforeToolCall: async ({ toolCall }) => {
					if (toolCall.id === "call-a") controller.abort();
					return undefined;
				},
			};
			const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
			let providerCall = 0;
			const stream = agentLoop([createUserMessage("run three")], context, config, controller.signal, () => {
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					if (providerCall === 0) {
						response.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								[
									{ type: "toolCall", id: "call-a", name: "step", arguments: { value: "a" } },
									{ type: "toolCall", id: "call-b", name: "step", arguments: { value: "b" } },
									{ type: "toolCall", id: "call-c", name: "step", arguments: { value: "c" } },
								],
								"toolUse",
							),
						});
					} else {
						response.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "done" }]),
						});
					}
					providerCall++;
				});
				return response;
			});

			for await (const _event of stream) {
				// consume
			}

			// call-a's own preparation absorbed the abort before its body ever ran; b and c were
			// never even prepared.
			expect(executed).toEqual([]);
			const finalMessages = await stream.result();
			const results = finalMessages.filter((message): message is ToolResultMessage => message.role === "toolResult");
			// b and c are completely ABSENT - not error placeholders, just missing.
			expect(results.map((r) => r.toolCallId)).toEqual(["call-a"]);
			expect(results[0]?.isError).toBe(true);
			// No throw: the assistant message carrying the batch is still in the final result.
			expect(finalMessages.some((m) => m.role === "assistant" && m.content.some((c) => c.type === "toolCall"))).toBe(
				true,
			);
		});

		it("parallel: the same already-aborted-at-prepare-time shape reached via the wave-building loop's own early break", async () => {
			const schema = Type.Object({ value: Type.String() });
			const executed: string[] = [];
			const controller = new AbortController();
			const tool: AgentTool<typeof schema, { value: string }> = {
				name: "step",
				label: "Step",
				description: "Step tool",
				parameters: schema,
				async execute(_toolCallId, params) {
					executed.push(params.value);
					return { content: [{ type: "text", text: params.value }], details: { value: params.value } };
				},
			};
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				toolExecution: "parallel",
				// See the sequential variant of this test for why this cap is needed to isolate
				// executeToolCallsParallel's own behavior from the unrelated second-turn throw.
				maxProviderTurns: 1,
				beforeToolCall: async ({ toolCall }) => {
					if (toolCall.id === "call-a") controller.abort();
					return undefined;
				},
			};
			const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
			let providerCall = 0;
			const stream = agentLoop([createUserMessage("run three")], context, config, controller.signal, () => {
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					if (providerCall === 0) {
						response.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								[
									{ type: "toolCall", id: "call-a", name: "step", arguments: { value: "a" } },
									{ type: "toolCall", id: "call-b", name: "step", arguments: { value: "b" } },
									{ type: "toolCall", id: "call-c", name: "step", arguments: { value: "c" } },
								],
								"toolUse",
							),
						});
					} else {
						response.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "done" }]),
						});
					}
					providerCall++;
				});
				return response;
			});

			for await (const _event of stream) {
				// consume
			}

			expect(executed).toEqual([]);
			const results = (await stream.result()).filter(
				(message): message is ToolResultMessage => message.role === "toolResult",
			);
			expect(results.map((r) => r.toolCallId)).toEqual(["call-a"]);
			expect(results[0]?.isError).toBe(true);
		});

		it("sequential: an abort raised from inside an already-started call's own execute() does not corrupt that call's real result; the loop awaits it, then stops - no throw", async () => {
			const schema = Type.Object({ value: Type.String() });
			const executed: string[] = [];
			const controller = new AbortController();
			const tool: AgentTool<typeof schema, { value: string }> = {
				name: "step",
				label: "Step",
				description: "Step tool",
				parameters: schema,
				async execute(_toolCallId, params) {
					executed.push(params.value);
					if (params.value === "a") controller.abort();
					return { content: [{ type: "text", text: `real:${params.value}` }], details: { value: params.value } };
				},
			};
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				toolExecution: "sequential",
				// Isolates executeToolCallsSequential's own behavior from the unrelated second-turn
				// throw (see the dedicated pin further below).
				maxProviderTurns: 1,
			};
			const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
			let providerCall = 0;
			const stream = agentLoop([createUserMessage("run three")], context, config, controller.signal, () => {
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					if (providerCall === 0) {
						response.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								[
									{ type: "toolCall", id: "call-a", name: "step", arguments: { value: "a" } },
									{ type: "toolCall", id: "call-b", name: "step", arguments: { value: "b" } },
									{ type: "toolCall", id: "call-c", name: "step", arguments: { value: "c" } },
								],
								"toolUse",
							),
						});
					} else {
						response.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "done" }]),
						});
					}
					providerCall++;
				});
				return response;
			});

			for await (const _event of stream) {
				// consume
			}

			// b and c never even started.
			expect(executed).toEqual(["a"]);
			const finalMessages = await stream.result();
			const results = finalMessages.filter((message): message is ToolResultMessage => message.role === "toolResult");
			expect(results.map((r) => r.toolCallId)).toEqual(["call-a"]);
			// The REAL result is preserved, not overwritten with a synthesized aborted error.
			expect(results[0]?.isError ?? false).toBe(false);
			expect(results[0]?.content).toEqual([{ type: "text", text: "real:a" }]);
			expect(finalMessages.some((m) => m.role === "assistant" && m.content.some((c) => c.type === "toolCall"))).toBe(
				true,
			);
		});

		it("parallel: an abort raised inside one wave's tool body still lets the WHOLE wave finish (every already-started call is awaited); the next wave never starts", async () => {
			const schema = Type.Object({ value: Type.String() });
			const executed: string[] = [];
			const controller = new AbortController();
			const tool: AgentTool<typeof schema, { value: string }> = {
				name: "step",
				label: "Step",
				description: "Step tool",
				parameters: schema,
				async execute(_toolCallId, params) {
					executed.push(params.value);
					if (params.value === "1") controller.abort();
					return { content: [{ type: "text", text: `real:${params.value}` }], details: { value: params.value } };
				},
			};
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				toolExecution: "parallel",
				// Isolates executeToolCallsParallel's own behavior from the unrelated second-turn throw.
				maxProviderTurns: 1,
			};
			const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
			let providerCall = 0;
			const stream = agentLoop([createUserMessage("run six")], context, config, controller.signal, () => {
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					if (providerCall === 0) {
						response.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								["1", "2", "3", "4", "5", "6"].map((value) => ({
									type: "toolCall" as const,
									id: `call-${value}`,
									name: "step",
									arguments: { value },
								})),
								"toolUse",
							),
						});
					} else {
						response.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "done" }]),
						});
					}
					providerCall++;
				});
				return response;
			});

			for await (const _event of stream) {
				// consume
			}

			// Wave 1 (calls 1-4) always fully executes and settles, regardless of the abort raised
			// partway through it (TOOL_EXECUTION_WAVE_SIZE = 4).
			expect(executed.sort()).toEqual(["1", "2", "3", "4"]);
			const finalMessages = await stream.result();
			const results = finalMessages.filter((message): message is ToolResultMessage => message.role === "toolResult");
			// Original emission order is preserved even in an aborted batch (positional, not timing-based).
			expect(results.map((r) => r.toolCallId)).toEqual(["call-1", "call-2", "call-3", "call-4"]);
			expect(results.every((r) => !r.isError)).toBe(true);
			// Wave 2 (calls 5, 6) never even started.
			expect(executed).not.toContain("5");
			expect(executed).not.toContain("6");
		});

		it("sequential: an abort observed between reservePreparedToolCalls's two throwIfAborted checks throws, collapsing the WHOLE turn's result to one synthetic aborted message", async () => {
			const schema = Type.Object({ value: Type.String() });
			const executed: string[] = [];
			const controller = new AbortController();
			const tool: AgentTool<typeof schema, { value: string }> = {
				name: "step",
				label: "Step",
				description: "Step tool",
				parameters: schema,
				async execute(_toolCallId, params) {
					executed.push(params.value);
					return { content: [{ type: "text", text: params.value }], details: { value: params.value } };
				},
			};
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				toolExecution: "sequential",
				onToolCallStart: (calls) => {
					// Fires for call-b's reservation, AFTER call-a already succeeded - simulates the
					// signal flipping in the narrow window this hook straddles inside
					// reservePreparedToolCalls (agent-loop.ts, between its two throwIfAborted checks).
					if (calls[0]?.callId === "call-b") controller.abort();
				},
			};
			const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
			let providerCall = 0;
			const stream = agentLoop([createUserMessage("run two")], context, config, controller.signal, () => {
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					if (providerCall === 0) {
						response.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								[
									{ type: "toolCall", id: "call-a", name: "step", arguments: { value: "a" } },
									{ type: "toolCall", id: "call-b", name: "step", arguments: { value: "b" } },
								],
								"toolUse",
							),
						});
					} else {
						response.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "done" }]),
						});
					}
					providerCall++;
				});
				return response;
			});

			const events: AgentEvent[] = [];
			for await (const event of stream) events.push(event);

			// The event STREAM shows call-a's real progress...
			expect(executed).toEqual(["a"]);
			expect(events.some((e) => e.type === "tool_execution_end" && e.toolCallId === "call-a")).toBe(true);

			// ...but the final RESULT collapses to exactly one synthetic message. call-a's success is
			// gone from the returned array even though it already happened and was already emitted.
			const finalMessages = await stream.result();
			expect(finalMessages).toHaveLength(1);
			expect(finalMessages[0]).toMatchObject({ role: "assistant", stopReason: "aborted" });
			expect(finalMessages.some((m) => m.role === "toolResult")).toBe(false);
		});

		it("parallel: the same reservePreparedToolCalls throw collapses the whole turn even after an entire prior WAVE already succeeded", async () => {
			const schema = Type.Object({ value: Type.String() });
			const executed: string[] = [];
			const controller = new AbortController();
			const tool: AgentTool<typeof schema, { value: string }> = {
				name: "step",
				label: "Step",
				description: "Step tool",
				parameters: schema,
				async execute(_toolCallId, params) {
					executed.push(params.value);
					return { content: [{ type: "text", text: params.value }], details: { value: params.value } };
				},
			};
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				toolExecution: "parallel",
				onToolCallStart: (calls) => {
					// Wave 2 (the 5th call alone, since TOOL_EXECUTION_WAVE_SIZE = 4) triggers the
					// abort during its reservation.
					if (calls.some((call) => call.callId === "call-5")) controller.abort();
				},
			};
			const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
			let providerCall = 0;
			const stream = agentLoop([createUserMessage("run five")], context, config, controller.signal, () => {
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					if (providerCall === 0) {
						response.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								["1", "2", "3", "4", "5"].map((value) => ({
									type: "toolCall" as const,
									id: `call-${value}`,
									name: "step",
									arguments: { value },
								})),
								"toolUse",
							),
						});
					} else {
						response.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "done" }]),
						});
					}
					providerCall++;
				});
				return response;
			});

			for await (const _event of stream) {
				// consume
			}

			// Wave 1 (calls 1-4) fully ran and succeeded.
			expect(executed.sort()).toEqual(["1", "2", "3", "4"]);
			// But the final result still collapses to exactly one synthetic aborted message.
			const finalMessages = await stream.result();
			expect(finalMessages).toHaveLength(1);
			expect(finalMessages[0]).toMatchObject({ role: "assistant", stopReason: "aborted" });
			expect(finalMessages.some((m) => m.role === "toolResult")).toBe(false);
		});
	});

	describe("S0.4 - mixed batch (updated for S2: order-preserving partition, not whole-batch poisoning)", () => {
		it("[read, sequential-tool, read] still runs all three fully serialized: the two reads are NOT adjacent, so S2's partition puts them in separate singleton groups", async () => {
			// UPDATED for Phase 3 S2 (partition scheduling, roadmap section 6). Before S2,
			// `hasSequentialToolCall` poisoned the WHOLE batch to the sequential branch, so this
			// exact order was incidental to that poisoning. Read section 6's FIXED partition
			// algorithm literally: a "sequential" call closes the current parallel group and becomes
			// its own barrier group; the NEXT non-sequential call opens a FRESH parallel group. For
			// `[read-1, ask-1, read-2]` that yields three groups - Parallel[read-1], Barrier[ask-1],
			// Parallel[read-2] - run strictly in order, each a singleton, so read-1 and read-2 do NOT
			// overlap with each other (there is nothing else in their own group to overlap with).
			// The observable order below is therefore UNCHANGED from before S2 - this test now pins
			// that specific fact (non-adjacent same-type calls split by a barrier stay serialized),
			// which matters as a regression guard against a naive partition that groups same-tool
			// calls wherever they sit in the batch instead of preserving emission order. Contrast
			// with S5.6's adjacent-reads cases, where the two reads DO end up in the same group and
			// DO run concurrently.
			const readSchema = Type.Object({ id: Type.String() });
			let inFlight = 0;
			let overlapped = false;
			const order: string[] = [];
			const makeTool = (
				name: string,
				executionMode?: "sequential",
			): AgentTool<typeof readSchema, { id: string }> => ({
				name,
				label: name,
				description: name,
				parameters: readSchema,
				...(executionMode ? { executionMode } : {}),
				async execute(_toolCallId, params) {
					inFlight++;
					if (inFlight > 1) overlapped = true;
					order.push(`start:${params.id}`);
					await Promise.resolve();
					await Promise.resolve();
					order.push(`end:${params.id}`);
					inFlight--;
					return { content: [{ type: "text", text: params.id }], details: { id: params.id } };
				},
			});
			const read = makeTool("read");
			const ask = makeTool("ask-question", "sequential");
			const context: AgentContext = { systemPrompt: "", messages: [], tools: [read, ask] };
			const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };
			let providerCall = 0;
			const stream = agentLoop([createUserMessage("do three")], context, config, undefined, () => {
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					if (providerCall === 0) {
						response.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								[
									{ type: "toolCall", id: "read-1", name: "read", arguments: { id: "read-1" } },
									{ type: "toolCall", id: "ask-1", name: "ask-question", arguments: { id: "ask-1" } },
									{ type: "toolCall", id: "read-2", name: "read", arguments: { id: "read-2" } },
								],
								"toolUse",
							),
						});
					} else {
						response.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "done" }]),
						});
					}
					providerCall++;
				});
				return response;
			});

			for await (const _event of stream) {
				// consume
			}

			expect(overlapped).toBe(false);
			expect(order).toEqual([
				"start:read-1",
				"end:read-1",
				"start:ask-1",
				"end:ask-1",
				"start:read-2",
				"end:read-2",
			]);
		});
	});

	describe("S0.wave -> updated for S3: a freed pool slot refills immediately, it is not a fixed wave barrier", () => {
		it("starts the 5th of 5 independent parallel calls as soon as ONE of the first four's slots frees, without waiting for the other three to settle", async () => {
			// UPDATED for Phase 3 S3 (pooled execution, roadmap section 6). This test used to prove
			// TOOL_EXECUTION_WAVE_SIZE=4 was a hard barrier: the 5th call could not even be prepared
			// until ALL of the first four had settled, because "wave 2" only began after
			// `Promise.all(wave1)` resolved. The refill-batch pool replaces that: a slot is eligible
			// for refill the instant ITS call finishes, independent of its three siblings. To prove
			// that (rather than just re-confirm the old shared-gate setup, which happens to block all
			// four on the very same promise and therefore can't tell a pool apart from a wave), each
			// of the first four calls now has its OWN release gate, and only ONE of them - not all
			// four - is released before asserting the 5th has started.
			const schema = Type.Object({ value: Type.String() });
			const started: string[] = [];
			const finished: string[] = [];
			const releases = new Map<string, () => void>();
			const gates = new Map<string, Promise<void>>();
			for (const value of ["1", "2", "3", "4"]) {
				gates.set(value, new Promise<void>((resolve) => releases.set(value, resolve)));
			}
			let firstFourStartedCount = 0;
			let resolveFirstFourStarted: () => void;
			const firstFourStarted = new Promise<void>((resolve) => {
				resolveFirstFourStarted = resolve;
			});
			let resolveFifthStarted: () => void;
			const fifthStarted = new Promise<void>((resolve) => {
				resolveFifthStarted = resolve;
			});

			const tool: AgentTool<typeof schema, { value: string }> = {
				name: "step",
				label: "Step",
				description: "Step tool",
				parameters: schema,
				async execute(_toolCallId, params) {
					started.push(params.value);
					if (params.value === "5") {
						resolveFifthStarted();
						return { content: [{ type: "text", text: "5" }], details: { value: "5" } };
					}
					firstFourStartedCount++;
					if (firstFourStartedCount === 4) resolveFirstFourStarted();
					await gates.get(params.value);
					finished.push(params.value);
					return { content: [{ type: "text", text: params.value }], details: { value: params.value } };
				},
			};
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				toolExecution: "parallel",
			};
			const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
			let providerCall = 0;
			const stream = agentLoop([createUserMessage("run five")], context, config, undefined, () => {
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					if (providerCall === 0) {
						response.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								["1", "2", "3", "4", "5"].map((value) => ({
									type: "toolCall" as const,
									id: `call-${value}`,
									name: "step",
									arguments: { value },
								})),
								"toolUse",
							),
						});
					} else {
						response.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "done" }]),
						});
					}
					providerCall++;
				});
				return response;
			});

			const consuming = (async () => {
				for await (const _event of stream) {
					// consume
				}
			})();

			await firstFourStarted;
			// All 4 pool slots (default width) are occupied by 1-4; the 5th cannot have started yet.
			expect(started.sort()).toEqual(["1", "2", "3", "4"]);

			// Free exactly ONE slot - not the whole wave.
			releases.get("2")?.();
			await fifthStarted;
			// The 5th started once ONE slot freed, while the other three of the first batch are
			// still blocked on their own never-released gates: proof this is a per-slot pool, not a
			// fixed-size wave that waits for everything before refilling.
			expect(finished).toEqual(["2"]);
			expect(started).toContain("5");

			releases.get("1")?.();
			releases.get("3")?.();
			releases.get("4")?.();
			await consuming;

			expect(started).toHaveLength(5);
			expect(finished.sort()).toEqual(["1", "2", "3", "4"]);
		});
	});
});

/**
 * Phase 3 S5 - invariant pin-tests under the new partition + pool scheduler (roadmap section 6).
 * Unlike S0 (which characterizes pre-refactor behavior), these assert the INTENDED post-refactor
 * behavior and are new tests, not updates to S0's parity oracle.
 */
describe("Phase 3 S5 - pool invariants, partition semantics, env matrix, full-loop abort", () => {
	/**
	 * S5.1-4 mock the SAME reader/writer locking invariant as
	 * `packages/coding-agent/src/core/tools/file-mutation-queue.ts` (edit/write = readers, per-file
	 * FIFO, parallel across files; bash/python = exclusive writers, FIFO among themselves, wait for
	 * readers to drain and block new readers/writers while active) rather than importing that real
	 * module or the real edit/bash/python tools. `packages/agent` cannot depend on
	 * `packages/coding-agent` (the real tools and the real queue live there, one layer up, and
	 * depending downward would invert the package graph), so this mirrors the file's documented
	 * contract at the unit-lock level. What these tests actually prove is scheduler-side: the new
	 * pool must dispatch calls concurrently enough for a real per-file/exclusive-writer lock to ever
	 * see contention at all - a scheduler that accidentally serialized everything would make S5.2-4
	 * pass trivially for the wrong reason, which is why S5.1 (independent files - MUST overlap) is
	 * included as the positive control.
	 */
	describe("S5.1-4 - reader/writer mutation locking (file-mutation-queue equivalent) survives the pool", () => {
		function createMutationLock() {
			const fileQueues = new Map<string, Promise<void>>();
			let activeReaders = 0;
			let readersDrained: (() => void) | undefined;
			let writerQueue: Promise<void> = Promise.resolve();
			let writerActive: Promise<void> | undefined;

			function acquireReader(): Promise<void> {
				if (!writerActive) {
					activeReaders++;
					return Promise.resolve();
				}
				return writerActive.then(() => {
					activeReaders++;
				});
			}
			function releaseReader(): void {
				activeReaders--;
				if (activeReaders === 0 && readersDrained) {
					const drained = readersDrained;
					readersDrained = undefined;
					drained();
				}
			}
			async function withReader<T>(file: string, fn: () => Promise<T>): Promise<T> {
				const previous = fileQueues.get(file) ?? Promise.resolve();
				let releaseNext!: () => void;
				const next = new Promise<void>((resolve) => {
					releaseNext = resolve;
				});
				fileQueues.set(
					file,
					previous.then(() => next),
				);
				await acquireReader();
				await previous;
				try {
					return await fn();
				} finally {
					releaseReader();
					releaseNext();
				}
			}
			async function withWriter<T>(fn: () => Promise<T>): Promise<T> {
				const run = writerQueue.then(async () => {
					let release!: () => void;
					writerActive = new Promise<void>((resolve) => {
						release = resolve;
					});
					try {
						if (activeReaders > 0) {
							await new Promise<void>((resolve) => {
								readersDrained = resolve;
							});
						}
						return await fn();
					} finally {
						writerActive = undefined;
						release();
					}
				});
				writerQueue = run.then(
					() => undefined,
					() => undefined,
				);
				return run;
			}
			return { withReader, withWriter };
		}

		function createLockedTool(
			name: string,
			lock: ReturnType<typeof createMutationLock>,
			kind: "reader" | "writer",
			order: string[],
		): AgentTool<ReturnType<typeof Type.Object>, { path: string }> {
			const schema = Type.Object({ path: Type.String() });
			const tool: AgentTool<typeof schema, { path: string }> = {
				name,
				label: name,
				description: name,
				parameters: schema,
				async execute(_toolCallId, params) {
					const label = `${name}:${params.path}`;
					const body = async () => {
						order.push(`start:${label}`);
						await Promise.resolve();
						await Promise.resolve();
						order.push(`end:${label}`);
						return { content: [{ type: "text" as const, text: label }], details: { path: params.path } };
					};
					return kind === "reader" ? lock.withReader(params.path, body) : lock.withWriter(body);
				},
			};
			return tool;
		}

		async function runBatch(
			tools: AgentTool<any>[],
			calls: { id: string; name: string; path: string }[],
		): Promise<void> {
			const context: AgentContext = { systemPrompt: "", messages: [], tools };
			const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };
			let providerCall = 0;
			const stream = agentLoop([createUserMessage("run batch")], context, config, undefined, () => {
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					if (providerCall === 0) {
						response.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								calls.map((call) => ({
									type: "toolCall" as const,
									id: call.id,
									name: call.name,
									arguments: { path: call.path },
								})),
								"toolUse",
							),
						});
					} else {
						response.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "done" }]),
						});
					}
					providerCall++;
				});
				return response;
			});
			for await (const _event of stream) {
				// consume
			}
		}

		it("S5.1 [edit A, edit B] on different files run concurrently (per-file reader lock, parallel across files)", async () => {
			const lock = createMutationLock();
			const order: string[] = [];
			const edit = createLockedTool("edit", lock, "reader", order);
			await runBatch(
				[edit],
				[
					{ id: "edit-a", name: "edit", path: "/a" },
					{ id: "edit-b", name: "edit", path: "/b" },
				],
			);
			// edit-b starts before edit-a ends: a real overlap, not just adjacent scheduling.
			expect(order.indexOf("start:edit:/b")).toBeLessThan(order.indexOf("end:edit:/a"));
		});

		it("S5.2 [edit A, bash] do not overlap (reader vs exclusive writer)", async () => {
			const lock = createMutationLock();
			const order: string[] = [];
			const edit = createLockedTool("edit", lock, "reader", order);
			const bash = createLockedTool("bash", lock, "writer", order);
			await runBatch(
				[edit, bash],
				[
					{ id: "edit-a", name: "edit", path: "/a" },
					{ id: "bash-1", name: "bash", path: "ignored" },
				],
			);
			const editRange = [order.indexOf("start:edit:/a"), order.indexOf("end:edit:/a")];
			const bashRange = [order.indexOf("start:bash:ignored"), order.indexOf("end:bash:ignored")];
			const noOverlap = editRange[1] < bashRange[0] || bashRange[1] < editRange[0];
			expect(noOverlap).toBe(true);
		});

		it("S5.3 [bash, bash] do not overlap (exclusive writer FIFO)", async () => {
			const lock = createMutationLock();
			const order: string[] = [];
			const bash = createLockedTool("bash", lock, "writer", order);
			await runBatch(
				[bash],
				[
					{ id: "bash-1", name: "bash", path: "one" },
					{ id: "bash-2", name: "bash", path: "two" },
				],
			);
			const firstRange = [order.indexOf("start:bash:one"), order.indexOf("end:bash:one")];
			const secondRange = [order.indexOf("start:bash:two"), order.indexOf("end:bash:two")];
			const noOverlap = firstRange[1] < secondRange[0] || secondRange[1] < firstRange[0];
			expect(noOverlap).toBe(true);
		});

		it("S5.4 [python, bash] do not overlap (both are exclusive writers)", async () => {
			const lock = createMutationLock();
			const order: string[] = [];
			const python = createLockedTool("python", lock, "writer", order);
			const bash = createLockedTool("bash", lock, "writer", order);
			await runBatch(
				[python, bash],
				[
					{ id: "python-1", name: "python", path: "one" },
					{ id: "bash-1", name: "bash", path: "two" },
				],
			);
			const pythonRange = [order.indexOf("start:python:one"), order.indexOf("end:python:one")];
			const bashRange = [order.indexOf("start:bash:two"), order.indexOf("end:bash:two")];
			const noOverlap = pythonRange[1] < bashRange[0] || bashRange[1] < pythonRange[0];
			expect(noOverlap).toBe(true);
		});
	});

	describe("S5.5 - six reads at width 4: sliding pool refill, results still in emission order", () => {
		it("starts the 5th (and cascades to the 6th) as slots free, without waiting for the whole first batch of four; results stay in emission order", async () => {
			const schema = Type.Object({ value: Type.String() });
			const started: string[] = [];
			const finished: string[] = [];
			const releases = new Map<string, () => void>();
			const gates = new Map<string, Promise<void>>();
			for (const value of ["1", "2", "3", "4"]) {
				gates.set(value, new Promise<void>((resolve) => releases.set(value, resolve)));
			}
			let firstFourStartedCount = 0;
			let resolveFirstFourStarted: () => void;
			const firstFourStarted = new Promise<void>((resolve) => {
				resolveFirstFourStarted = resolve;
			});
			let resolveSixthStarted: () => void;
			const sixthStarted = new Promise<void>((resolve) => {
				resolveSixthStarted = resolve;
			});

			const tool: AgentTool<typeof schema, { value: string }> = {
				name: "read",
				label: "Read",
				description: "Read",
				parameters: schema,
				async execute(_toolCallId, params) {
					started.push(params.value);
					if (params.value === "5" || params.value === "6") {
						if (params.value === "6") resolveSixthStarted();
						finished.push(params.value);
						return { content: [{ type: "text", text: params.value }], details: { value: params.value } };
					}
					firstFourStartedCount++;
					if (firstFourStartedCount === 4) resolveFirstFourStarted();
					await gates.get(params.value);
					finished.push(params.value);
					return { content: [{ type: "text", text: params.value }], details: { value: params.value } };
				},
			};
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				toolExecution: "parallel",
			};
			const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
			let providerCall = 0;
			const stream = agentLoop([createUserMessage("run six")], context, config, undefined, () => {
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					if (providerCall === 0) {
						response.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								["1", "2", "3", "4", "5", "6"].map((value) => ({
									type: "toolCall" as const,
									id: `call-${value}`,
									name: "read",
									arguments: { value },
								})),
								"toolUse",
							),
						});
					} else {
						response.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "done" }]),
						});
					}
					providerCall++;
				});
				return response;
			});

			await firstFourStarted;
			expect(started.sort()).toEqual(["1", "2", "3", "4"]);

			// Free exactly ONE of the first four's slots. That alone must be enough to cascade
			// through both remaining queued calls (5 then 6, neither of which blocks), proving the
			// pool refills per-slot rather than waiting for the other three to settle.
			releases.get("2")?.();
			await sixthStarted;
			expect(finished).toEqual(expect.arrayContaining(["2", "5", "6"]));
			expect(finished).not.toEqual(expect.arrayContaining(["1", "3", "4"]));

			releases.get("1")?.();
			releases.get("3")?.();
			releases.get("4")?.();

			const finalMessages = await stream.result();
			const results = finalMessages.filter((message): message is ToolResultMessage => message.role === "toolResult");
			expect(results.map((result) => result.toolCallId)).toEqual([
				"call-1",
				"call-2",
				"call-3",
				"call-4",
				"call-5",
				"call-6",
			]);
		});
	});

	describe("S5.6 - partition semantics: adjacent same-type calls share one group and run concurrently", () => {
		function makeTrackedTool(
			name: string,
			executionMode: "sequential" | undefined,
			order: string[],
		): AgentTool<ReturnType<typeof Type.Object>, { id: string }> {
			const schema = Type.Object({ id: Type.String() });
			const tool: AgentTool<typeof schema, { id: string }> = {
				name,
				label: name,
				description: name,
				parameters: schema,
				...(executionMode ? { executionMode } : {}),
				async execute(_toolCallId, params) {
					order.push(`start:${params.id}`);
					await Promise.resolve();
					await Promise.resolve();
					order.push(`end:${params.id}`);
					return { content: [{ type: "text", text: params.id }], details: { id: params.id } };
				},
			};
			return tool;
		}

		it("[read, read, ask-question]: the two adjacent reads run concurrently, then the barrier runs alone", async () => {
			const order: string[] = [];
			const read = makeTrackedTool("read", undefined, order);
			const ask = makeTrackedTool("ask-question", "sequential", order);
			const context: AgentContext = { systemPrompt: "", messages: [], tools: [read, ask] };
			const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };
			let providerCall = 0;
			const stream = agentLoop([createUserMessage("do three")], context, config, undefined, () => {
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					if (providerCall === 0) {
						response.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								[
									{ type: "toolCall", id: "read-1", name: "read", arguments: { id: "read-1" } },
									{ type: "toolCall", id: "read-2", name: "read", arguments: { id: "read-2" } },
									{ type: "toolCall", id: "ask-1", name: "ask-question", arguments: { id: "ask-1" } },
								],
								"toolUse",
							),
						});
					} else {
						response.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "done" }]),
						});
					}
					providerCall++;
				});
				return response;
			});
			for await (const _event of stream) {
				// consume
			}
			// The two reads overlap: read-2 starts before read-1 ends.
			expect(order.indexOf("start:read-2")).toBeLessThan(order.indexOf("end:read-1"));
			// The barrier call starts only after BOTH reads have fully ended.
			const askStart = order.indexOf("start:ask-1");
			expect(askStart).toBeGreaterThan(order.indexOf("end:read-1"));
			expect(askStart).toBeGreaterThan(order.indexOf("end:read-2"));
		});

		it("[ask-question, read, read]: the barrier runs alone first, then the two adjacent reads run concurrently", async () => {
			const order: string[] = [];
			const read = makeTrackedTool("read", undefined, order);
			const ask = makeTrackedTool("ask-question", "sequential", order);
			const context: AgentContext = { systemPrompt: "", messages: [], tools: [read, ask] };
			const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };
			let providerCall = 0;
			const stream = agentLoop([createUserMessage("do three")], context, config, undefined, () => {
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					if (providerCall === 0) {
						response.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								[
									{ type: "toolCall", id: "ask-1", name: "ask-question", arguments: { id: "ask-1" } },
									{ type: "toolCall", id: "read-1", name: "read", arguments: { id: "read-1" } },
									{ type: "toolCall", id: "read-2", name: "read", arguments: { id: "read-2" } },
								],
								"toolUse",
							),
						});
					} else {
						response.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "done" }]),
						});
					}
					providerCall++;
				});
				return response;
			});
			for await (const _event of stream) {
				// consume
			}
			// The two reads overlap: read-2 starts before read-1 ends.
			expect(order.indexOf("start:read-2")).toBeLessThan(order.indexOf("end:read-1"));
			// Both reads start only after the barrier call has fully ended.
			const askEnd = order.indexOf("end:ask-1");
			expect(order.indexOf("start:read-1")).toBeGreaterThan(askEnd);
			expect(order.indexOf("start:read-2")).toBeGreaterThan(askEnd);
		});
	});

	describe("S5.7 - env matrix: PI_TOOL_PARALLELISM_DISABLED and PI_TOOL_CONCURRENCY", () => {
		const originalDisabled = process.env.PI_TOOL_PARALLELISM_DISABLED;
		const originalConcurrency = process.env.PI_TOOL_CONCURRENCY;
		afterEach(() => {
			if (originalDisabled === undefined) delete process.env.PI_TOOL_PARALLELISM_DISABLED;
			else process.env.PI_TOOL_PARALLELISM_DISABLED = originalDisabled;
			if (originalConcurrency === undefined) delete process.env.PI_TOOL_CONCURRENCY;
			else process.env.PI_TOOL_CONCURRENCY = originalConcurrency;
		});

		it("PI_TOOL_PARALLELISM_DISABLED=1 reproduces the legacy sequential characterization exactly, even though config.toolExecution is left at its parallel default", async () => {
			process.env.PI_TOOL_PARALLELISM_DISABLED = "1";
			const schema = Type.Object({ value: Type.String() });
			const executed: string[] = [];
			const reservations: string[][] = [];
			let inFlight = 0;
			let overlapped = false;
			const tool: AgentTool<typeof schema, { value: string }> = {
				name: "step",
				label: "Step",
				description: "Step tool",
				parameters: schema,
				async execute(_toolCallId, params) {
					inFlight++;
					if (inFlight > 1) overlapped = true;
					executed.push(params.value);
					await Promise.resolve();
					await Promise.resolve();
					inFlight--;
					if (params.value === "b") throw new Error("boom");
					return { content: [{ type: "text", text: params.value }], details: { value: params.value } };
				},
			};
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				// Deliberately NOT "sequential" - absent the env var this would run through the new
				// partitioned pool at the default width and these three calls WOULD overlap.
				toolExecution: "parallel",
				onToolCallStart: (calls) => {
					reservations.push(calls.map((call) => call.callId));
				},
			};
			const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
			let providerCall = 0;
			const stream = agentLoop([createUserMessage("run three")], context, config, undefined, () => {
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					if (providerCall === 0) {
						response.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								[
									{ type: "toolCall", id: "call-a", name: "step", arguments: { value: "a" } },
									{ type: "toolCall", id: "call-b", name: "step", arguments: { value: "b" } },
									{ type: "toolCall", id: "call-c", name: "step", arguments: { value: "c" } },
								],
								"toolUse",
							),
						});
					} else {
						response.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "done" }]),
						});
					}
					providerCall++;
				});
				return response;
			});
			for await (const _event of stream) {
				// consume
			}
			// Matches S0.1's sequential characterization exactly: singleton reservations in emission
			// order, no overlap, an error in the middle never stops the sibling after it.
			expect(reservations).toEqual([["call-a"], ["call-b"], ["call-c"]]);
			expect(overlapped).toBe(false);
			expect(executed).toEqual(["a", "b", "c"]);
			const results = (await stream.result()).filter(
				(message): message is ToolResultMessage => message.role === "toolResult",
			);
			expect(results.map((r) => r.toolCallId)).toEqual(["call-a", "call-b", "call-c"]);
			expect(results.map((r) => r.isError ?? false)).toEqual([false, true, false]);
		});

		it("PI_TOOL_CONCURRENCY=1 serializes a default-parallel batch through the NEW partitioned/pooled path", async () => {
			process.env.PI_TOOL_CONCURRENCY = "1";
			const schema = Type.Object({ value: Type.String() });
			let inFlight = 0;
			let overlapped = false;
			const order: string[] = [];
			const tool: AgentTool<typeof schema, { value: string }> = {
				name: "step",
				label: "Step",
				description: "Step tool",
				parameters: schema,
				async execute(_toolCallId, params) {
					inFlight++;
					if (inFlight > 1) overlapped = true;
					order.push(`start:${params.value}`);
					await Promise.resolve();
					await Promise.resolve();
					order.push(`end:${params.value}`);
					inFlight--;
					return { content: [{ type: "text", text: params.value }], details: { value: params.value } };
				},
			};
			// config.toolExecution is left at its "parallel" default and PI_TOOL_PARALLELISM_DISABLED
			// is unset, so `executeToolCalls`'s dispatcher (agent-loop.ts) sends this batch through
			// `executeToolCallsPartitioned`/`pooledExecuteToolCalls` by construction - PI_TOOL_CONCURRENCY
			// is a pool-width knob, not a second kill-switch. What this test actually verifies is that
			// the knob is not a silent no-op: at the default width 4 this batch WOULD overlap (three
			// calls, no gating), so observing zero overlap here proves the env var reached
			// `resolveToolConcurrency` and constrained the pool to one in-flight call at a time.
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				toolExecution: "parallel",
			};
			const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
			let providerCall = 0;
			const stream = agentLoop([createUserMessage("run three")], context, config, undefined, () => {
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					if (providerCall === 0) {
						response.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								[
									{ type: "toolCall", id: "call-a", name: "step", arguments: { value: "a" } },
									{ type: "toolCall", id: "call-b", name: "step", arguments: { value: "b" } },
									{ type: "toolCall", id: "call-c", name: "step", arguments: { value: "c" } },
								],
								"toolUse",
							),
						});
					} else {
						response.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "done" }]),
						});
					}
					providerCall++;
				});
				return response;
			});
			for await (const _event of stream) {
				// consume
			}
			expect(overlapped).toBe(false);
			expect(order).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
			const results = (await stream.result()).filter(
				(message): message is ToolResultMessage => message.role === "toolResult",
			);
			expect(results.map((r) => r.toolCallId)).toEqual(["call-a", "call-b", "call-c"]);
		});

		it("ignores a malformed PI_TOOL_CONCURRENCY decimal prefix instead of overriding the default", async () => {
			process.env.PI_TOOL_CONCURRENCY = "1junk";
			const schema = Type.Object({ value: Type.String() });
			let inFlight = 0;
			let overlapped = false;
			const tool: AgentTool<typeof schema, { value: string }> = {
				name: "step",
				label: "Step",
				description: "Step tool",
				parameters: schema,
				async execute(_toolCallId, params) {
					inFlight++;
					if (inFlight > 1) overlapped = true;
					await Promise.resolve();
					await Promise.resolve();
					inFlight--;
					return { content: [{ type: "text", text: params.value }], details: { value: params.value } };
				},
			};
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				toolExecution: "parallel",
			};
			const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
			let providerCall = 0;
			const stream = agentLoop([createUserMessage("run two")], context, config, undefined, () => {
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					if (providerCall === 0) {
						response.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								[
									{ type: "toolCall", id: "call-a", name: "step", arguments: { value: "a" } },
									{ type: "toolCall", id: "call-b", name: "step", arguments: { value: "b" } },
								],
								"toolUse",
							),
						});
					} else {
						response.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "done" }]),
						});
					}
					providerCall++;
				});
				return response;
			});
			for await (const _event of stream) {
				// consume
			}

			expect(overlapped).toBe(true);
		});

		it("PI_TOOL_CONCURRENCY=8 widens the pool past the default width 4, so six calls all fit in ONE refill", async () => {
			process.env.PI_TOOL_CONCURRENCY = "8";
			const schema = Type.Object({ value: Type.String() });
			const started: string[] = [];
			let startedCount = 0;
			let resolveAllStarted: () => void;
			const allStarted = new Promise<void>((resolve) => {
				resolveAllStarted = resolve;
			});
			const releases: Array<() => void> = [];
			const tool: AgentTool<typeof schema, { value: string }> = {
				name: "step",
				label: "Step",
				description: "Step tool",
				parameters: schema,
				async execute(_toolCallId, params) {
					started.push(params.value);
					startedCount++;
					if (startedCount === 6) resolveAllStarted();
					await new Promise<void>((resolve) => releases.push(resolve));
					return { content: [{ type: "text", text: params.value }], details: { value: params.value } };
				},
			};
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				toolExecution: "parallel",
			};
			const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
			let providerCall = 0;
			const stream = agentLoop([createUserMessage("run six")], context, config, undefined, () => {
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					if (providerCall === 0) {
						response.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								["1", "2", "3", "4", "5", "6"].map((value) => ({
									type: "toolCall" as const,
									id: `call-${value}`,
									name: "step",
									arguments: { value },
								})),
								"toolUse",
							),
						});
					} else {
						response.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "done" }]),
						});
					}
					providerCall++;
				});
				return response;
			});
			const consuming = (async () => {
				for await (const _event of stream) {
					// consume
				}
			})();
			// At the default width 4 this would need two refills before all six could be in flight.
			// At width 8, all six fit in the FIRST refill: every one of them starts before any is
			// released, proving the env var actually widened the pool rather than being a no-op.
			await allStarted;
			expect(started.sort()).toEqual(["1", "2", "3", "4", "5", "6"]);
			for (const release of releases) release();
			await consuming;
		});
	});

	describe("S5.8 - MANDATORY full-loop abort regression (no maxProviderTurns escape hatch)", () => {
		it("a graceful mid-batch abort (all three shapes) still collapses the WHOLE run to one synthetic aborted message, because the batch never sets terminate:true and runLoop attempts another (doomed) provider turn", async () => {
			// This is the bug S0 discovered and the roadmap requires pinning (section 6, S5 item 8):
			// `executeToolCallsPartitioned`/`pooledExecuteToolCalls` themselves behave gracefully on
			// abort (verified below via the EVENT STREAM), but `runLoop` (agent-loop.ts) only skips
			// the next provider turn when a batch sets `terminate: true`. An aborted-but-not-terminated
			// batch therefore falls through to `hasMoreToolCalls = true`, `runLoop` starts another
			// provider request, that request's own preflight throws on the already-aborted signal
			// (provider-request-planner.ts), and the throw is never caught inside `runLoop` - it
			// unwinds all the way to `streamAgentLoop`'s outer catch, which discards every message
			// accumulated so far and replaces the ENTIRE result with one synthetic
			// `{role:"assistant", stopReason:"aborted"}` message. Fixing that outer-loop gap is out of
			// scope for Phase 3 S1-S6 (it lives in `runLoop`, not the scheduler); this test's job is
			// only to make the current, actual behavior visible and pinned so a future change to
			// `terminate` semantics or to the pool's abort timing cannot silently flip it unnoticed.
			//
			// Batch of 6, width 4 (default): calls 1-4 are the first refill and complete for REAL
			// before any abort (shape c - already-dispatched work is always awaited and keeps its
			// real result). `beforeToolCall` aborts precisely when call 5 - the next entry the pool
			// prepares - is itself being prepared, so call 5 becomes an explicit finalized error
			// result (shape a) with nothing else sitting unreserved alongside it (avoiding the
			// UNRELATED reservation-throw path that S0.3's last two tests characterize). Call 6 is
			// never even attempted (shape b - absent, not a placeholder).
			const schema = Type.Object({ value: Type.String() });
			const executed: string[] = [];
			const controller = new AbortController();
			const tool: AgentTool<typeof schema, { value: string }> = {
				name: "step",
				label: "Step",
				description: "Step tool",
				parameters: schema,
				async execute(_toolCallId, params) {
					executed.push(params.value);
					return { content: [{ type: "text", text: `real:${params.value}` }], details: { value: params.value } };
				},
			};
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				toolExecution: "parallel",
				// No maxProviderTurns cap - this is the whole point of S5.8 versus S0.3's isolated
				// scheduler-level abort tests.
				beforeToolCall: async ({ toolCall }) => {
					if (toolCall.id === "call-5") controller.abort();
					return undefined;
				},
			};
			const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
			let providerCall = 0;
			const stream = agentLoop([createUserMessage("run six")], context, config, controller.signal, () => {
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					if (providerCall === 0) {
						response.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								["1", "2", "3", "4", "5", "6"].map((value) => ({
									type: "toolCall" as const,
									id: `call-${value}`,
									name: "step",
									arguments: { value },
								})),
								"toolUse",
							),
						});
					} else {
						response.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "done" }]),
						});
					}
					providerCall++;
				});
				return response;
			});

			const events: AgentEvent[] = [];
			for await (const event of stream) events.push(event);

			// The SCHEDULER behaved gracefully: calls 1-4 really executed (shape c), call 5 never
			// executed a body (its own preparation absorbed the abort - shape a), call 6 never even
			// started (shape b).
			expect(executed.sort()).toEqual(["1", "2", "3", "4"]);
			const endEvents = events.filter((event) => event.type === "tool_execution_end");
			expect(endEvents.map((event) => event.toolCallId).sort()).toEqual([
				"call-1",
				"call-2",
				"call-3",
				"call-4",
				"call-5",
			]);
			const call5End = endEvents.find((event) => event.toolCallId === "call-5");
			expect(call5End && "isError" in call5End ? call5End.isError : undefined).toBe(true);
			expect(events.some((event) => event.type === "tool_execution_start" && event.toolCallId === "call-6")).toBe(
				false,
			);

			// ...but the FINAL RESULT still collapses to exactly one synthetic message: the documented
			// bug. Every real result the event stream just showed (including calls 1-4's successes)
			// is gone from the returned array.
			const finalMessages = await stream.result();
			expect(finalMessages).toHaveLength(1);
			expect(finalMessages[0]).toMatchObject({ role: "assistant", stopReason: "aborted" });
			expect(finalMessages.some((message) => message.role === "toolResult")).toBe(false);
		});
	});
});
