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
import { describe, expect, it } from "vitest";
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
		const context: AgentContext = { systemPrompt: "You are helpful.", messages: [], tools: [] };
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
		expect(messages[0]).toMatchObject({ role: "assistant", stopReason: "error", errorMessage: "converter exploded" });
		expect(events.at(-1)).toMatchObject({ type: "agent_end", messages });
	});

	it("settles when a fast provider stream ends without a terminal event", async () => {
		const context: AgentContext = { systemPrompt: "You are helpful.", messages: [], tools: [] };
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
		const context: AgentContext = { systemPrompt: "preflight", messages: [], tools: [] };
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
		const context: AgentContext = { systemPrompt: "preflight", messages: [], tools: [] };
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
		expect(messages.at(-1)).toMatchObject({ stopReason: "error", errorMessage: "request budget exhausted" });

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
						[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
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

	it("enriches the third identical validation bounce and emits escalation", async () => {
		const toolSchema = Type.Object({ count: Type.Number() });
		let executed = 0;
		const tool: AgentTool<typeof toolSchema, { count: number }> = {
			name: "count",
			label: "Count",
			description: "Count tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed++;
				return { content: [{ type: "text", text: String(params.count) }], details: { count: params.count } };
			},
		};
		const escalations: Array<{ tool: string; repeats: number }> = [];
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const userPrompt: AgentMessage = createUserMessage("count");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			onToolValidationEscalation: (event) => escalations.push({ tool: event.tool, repeats: event.repeats }),
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex < 3) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[{ type: "toolCall", id: `tool-${callIndex}`, name: "count", arguments: { count: "nope" } }],
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

		const messages = await stream.result();
		const toolResults = messages.filter((message) => message.role === "toolResult");
		expect(executed).toBe(0);
		expect(escalations).toEqual([{ tool: "count", repeats: 3 }]);
		const thirdResultText = toolResults[2]?.content[0]?.type === "text" ? toolResults[2].content[0].text : undefined;
		expect(thirdResultText).toContain('"occ":3');
		expect(thirdResultText).toContain('"state":"rejected"');
		expect(thirdResultText).toContain('"failure_code":"invalid_arguments"');
		expect(thirdResultText).toContain("expected number, received string");
		expect(thirdResultText).not.toContain("Full tool schema:");
	});

	it("does not accumulate distinct validation failures", async () => {
		const toolSchema = Type.Object({ count: Type.Number() });
		const tool: AgentTool<typeof toolSchema, { count: number }> = {
			name: "count",
			label: "Count",
			description: "Count tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: String(params.count) }], details: { count: params.count } };
			},
		};
		const escalations: unknown[] = [];
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
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
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter, maxStallTurns: 12 };
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
						? [{ authority: recoveryAuthority, kind: targetKind, scope: params.command }]
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
		const context: AgentContext = { systemPrompt: "base prompt", messages: [], tools: [tool] };
		const providerContexts: Array<{ systemPrompt: string; messages: Message[] }> = [];
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
										arguments: { command: callIndex === 2 ? recoveryCommand : command },
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
		expect(providerContexts[1]?.systemPrompt).toContain("ACTIVE TOOL FAILURES");
		expect(providerContexts[1]?.systemPrompt).toContain('"occ":1');
		expect(providerContexts[1]?.systemPrompt).toContain('"state":"failed"');
		expect(providerContexts[1]?.systemPrompt).toContain("svn status -q");
		expect(providerContexts[1]?.systemPrompt).toContain("svn diff --stat");
		expect(providerContexts[1]?.systemPrompt).toContain('"diagnostic":"svn: invalid option: --stat"');
		expect(providerContexts[1]?.systemPrompt).toContain('"next_action":');
		expect(providerContexts[1]?.systemPrompt).not.toContain('"repair":');
		expect(providerContexts[1]?.systemPrompt).not.toContain("Change the arguments or approach before retrying");
		expect(JSON.stringify(providerContexts[1])).not.toContain("RAW_FAILURE_OUTPUT");
		// The call the agent made and its bounded record both stay in the transcript: the ledger
		// summarizes what is unresolved, it does not replace the agent's record of its own actions.
		expect(providerContexts[1]?.messages.some((message) => message.role === "toolResult")).toBe(true);
		expect(providerContexts[2]?.systemPrompt).toContain('"occ":2');
		expect(providerContexts[2]?.systemPrompt.match(/failure_key/g) ?? []).toHaveLength(1);
		expect(providerContexts[3]?.systemPrompt).toContain('"occ":2');
		expect(providerContexts[4]?.systemPrompt).not.toContain("ACTIVE TOOL FAILURES");
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
		const observedAfterCall: Array<{ isError: boolean; text: string; usage: unknown }> = [];
		const tool: AgentTool<typeof toolSchema, { exitCode: number }> = {
			name: "direct_argv",
			label: "Direct argv",
			description: "Run a constrained direct argv operation",
			parameters: toolSchema,
			failureRecovery: {
				getFailureTargets: (params, failure) =>
					failure.failureCode === "exit_3"
						? [{ authority: recoveryAuthority, kind: targetKind, scope: params.command }]
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
					return { content: [{ type: "text", text: "repair complete" }], details: { exitCode: 0 }, usage };
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
				return { content: [{ type: "text", text: "completed" }], details: { exitCode: 0 }, usage };
			},
		};
		const providerContexts: Array<{ systemPrompt: string; messages: Message[] }> = [];
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
										arguments: { command: callIndex === 1 ? "repair check" : "check" },
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
		expect(providerContexts[1]?.systemPrompt).toContain('"diagnostic":"error: repair marker"');
		expect(providerContexts[1]?.messages.some((message) => message.role === "toolResult")).toBe(true);
		expect(providerContexts[2]?.systemPrompt).toContain('"diagnostic":"error: repair marker"');
		expect(providerContexts[3]?.systemPrompt).not.toContain("ACTIVE TOOL FAILURES");
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
					content: [{ type: "text", text: "outcome: failed\nexitCode: 1\nstderr:\nno permission" }],
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
							[{ type: "toolCall", id: "tool-1", name: "bounded_failure", arguments: { value: "x" } }],
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

		expect(providerContext?.systemPrompt).toContain("ACTIVE TOOL FAILURES");
		expect(providerContext?.systemPrompt).toContain("legacy command");
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
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };
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
			expect.objectContaining({ type: "text", text: expect.stringContaining('"failure_code":"file_not_found"') }),
		]);
		expect(JSON.stringify(toolResult)).toContain(
			"Path not found. List parent directory or re-read path before retry. The operation is readmitted after another tool succeeds or a new user turn",
		);
		expect(JSON.stringify(toolResult)).toContain("ENOENT: no such file or directory, open 'missing.txt'");
	});

	it("routes phone argument repairs through shared teaching and execution telemetry without argument values", async () => {
		const toolSchema = Type.Object({ items: Type.Array(Type.Object({ value: Type.String() })) });
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
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
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
									arguments: { items: JSON.stringify([{ value: "secret-value" }]) },
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
		const toolSchema = Type.Object({ items: Type.Array(Type.Object({ value: Type.String() })) });
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
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };
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
									arguments: { items: JSON.stringify([{ value: String(callIndex + 1) }]) },
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
				return { content: [{ type: "text", text: String(params.count) }], details: { count: params.count } };
			},
		};

		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const userPrompt: AgentMessage = createUserMessage("count");
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[{ type: "toolCall", id: "tool-1", name: "count", arguments: { count: "42" as unknown as number } }],
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
				return { content: [{ type: "text", text: "should not run" }], details: {} };
			},
		};

		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
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
			expect.objectContaining({ type: "text", text: expect.stringContaining('"failure_code":"malformed_call"') }),
		]);
		expect(JSON.stringify(toolResult)).toContain('"phase":"validation"');
		expect(validationEvents).toHaveLength(1);
		expect(validationEvents[0]?.errorKeywords).toEqual(["malformed_call"]);
		expect(JSON.stringify(toolResult)).toContain("complete JSON argument object");
		expect(JSON.stringify(toolResult)).not.toContain("truncated before complete JSON");
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
				return { content: [{ type: "text", text: "should not run" }], details: {} };
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
				return { content: [{ type: "text", text: "should not run" }], details: {} };
			},
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
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
									[{ type: "toolCall", id: "tool-preflight", name: "echo", arguments: { value: "ok" } }],
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
						[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
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
		const replaceSchema = Type.Object({ oldText: Type.String(), newText: Type.String() });
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
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
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
				return { content: [{ type: "text", text: params.value }], details: params };
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
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
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
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "one" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "two" } },
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
				return { content: [{ type: "text", text: params.value }], details: params };
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
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
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
										{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "one" } },
										{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "two" } },
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
				return { content: [{ type: "text", text: "ok" }], details: { value: "ok" } };
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
									{ type: "toolCall", id: "invalid", name: "echo", arguments: { value: 1 } },
									{ type: "toolCall", id: "blocked", name: "echo", arguments: { value: "blocked" } },
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
							? { type: "done", reason: "toolUse", message: createAssistantMessage([toolCall], "toolUse") }
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
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
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
							{ type: "toolCall", id: "tool-1", name: "slow", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "slow", arguments: { value: "second" } },
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
							{ type: "toolCall", id: "tool-1", name: "slow", arguments: { value: "a" } },
							{ type: "toolCall", id: "tool-2", name: "fast", arguments: { value: "b" } },
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
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
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
							[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
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
						[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
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
					[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
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
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
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
					[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
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
