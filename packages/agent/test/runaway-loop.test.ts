import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Message } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { agentLoop } from "../src/agent-loop.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolResult,
	StreamFn,
} from "../src/types.ts";
import { createAgentToolFailureRecoveryAuthority } from "../src/types.ts";

/**
 * Runaway-loop backstop (cost guard, bug #23): a model wedged repeating the SAME tool call forever
 * makes no progress but keeps spending tokens. The loop must detect the repetition and stop gracefully,
 * while legitimate varied tool use must run to completion untouched.
 */

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

function createModel() {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses" as const,
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function assistantMessage<TStopReason extends AssistantMessage["stopReason"]>(
	content: AssistantMessage["content"],
	stopReason: TStopReason,
) {
	return {
		role: "assistant" as const,
		content,
		api: "openai-responses" as const,
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 1,
	} satisfies AssistantMessage;
}

function completeMandatoryDelivery(
	stream: MockAssistantStream,
	providerContext: { tools?: readonly unknown[] },
): boolean {
	if (providerContext.tools?.length !== 0) return false;
	stream.push({
		type: "done",
		reason: "stop",
		message: assistantMessage([{ type: "text", text: "reported mandatory recovery blocker" }], "stop"),
	});
	return true;
}

const toolSchema = Type.Object({ value: Type.String() });
function createEchoTool(onExecute?: () => void): AgentTool<typeof toolSchema, { value: string }> {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo tool",
		parameters: toolSchema,
		async execute(_id, params) {
			onExecute?.();
			return { content: [{ type: "text", text: `echoed: ${params.value}` }], details: { value: params.value } };
		},
	};
}

const echoTool = createEchoTool();

const writeLikeSchema = Type.Union([
	Type.Object({ path: Type.String(), content: Type.String() }),
	Type.Object({ path: Type.String(), contentRef: Type.String() }),
]);

const identityConverter = (messages: AgentMessage[]): Message[] =>
	messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];

const TEST_RECOVERY_AUTHORITY = createAgentToolFailureRecoveryAuthority();

async function drain(stream: ReturnType<typeof agentLoop>) {
	const events: AgentEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function resultContainsFailureCode(result: AgentToolResult<unknown>, failureCode: string): boolean {
	return result.content.some(
		(block) => block.type === "text" && block.text.includes(`"failure_code":"${failureCode}"`),
	);
}

/**
 * What the model actually reads: the system prompt plus the failure ledger, which rides as the
 * LAST message rather than in the system prompt (ledger text in the cached prefix re-prefills the
 * whole conversation whenever a failure appears, its counts change, or a success clears it).
 */
function promptWithLedger(context: { systemPrompt?: string; messages?: readonly unknown[] }): string {
	const last = (context.messages ?? []).at(-1) as { role?: string; content?: unknown } | undefined;
	let ledger = "";
	if (last?.role === "user") {
		const text =
			typeof last.content === "string"
				? last.content
				: Array.isArray(last.content)
					? last.content
							.map((part) =>
								part && typeof part === "object" && "text" in part && typeof part.text === "string"
									? part.text
									: "",
							)
							.join("\n")
					: "";
		if (text.startsWith("MANDATORY TOOL FAILURE RECOVERY")) ledger = text;
	}
	return [context.systemPrompt ?? "", ledger].filter(Boolean).join("\n\n");
}

describe("runaway-loop backstop", () => {
	it("does not impose an implicit provider-turn budget on varied work", async () => {
		const stalls: Array<{ reason?: string; signature: string; repeats: number }> = [];
		let providerTurns = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				providerTurns++;
				if (providerTurns <= 24) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: assistantMessage(
							[
								{
									type: "toolCall",
									id: `varied-${providerTurns}`,
									name: "echo",
									arguments: { value: `different-${providerTurns}` },
								},
							],
							"toolUse",
						),
					});
					return;
				}
				stream.push({
					type: "done",
					reason: "stop",
					message: assistantMessage([{ type: "text", text: "late stop" }], "stop"),
				});
			});
			return stream;
		};

		const events = await drain(
			agentLoop(
				[{ role: "user", content: "inspect and implement", timestamp: 1 }],
				{ systemPrompt: "", messages: [], tools: [echoTool] },
				{
					model: createModel(),
					convertToLlm: identityConverter,
					maxStallTurns: 12,
					onRunawayStop: (info) => stalls.push(info),
				},
				undefined,
				streamFn,
			),
		);

		expect(providerTurns).toBe(25);
		expect(stalls).toEqual([]);
		expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
		expect(
			events.some(
				(event) =>
					event.type === "message_end" &&
					event.message.role === "assistant" &&
					event.message.content.some((block) => block.type === "text" && block.text === "late stop"),
			),
		).toBe(true);
	});

	it("retains the unchanged-result window across a host continuation after compaction", async () => {
		const stalls: Array<{ reason: string; signature: string; repeats: number }> = [];
		let providerCalls = 0;
		const streamFn = (_model: unknown, providerContext: { tools?: readonly unknown[] }) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				providerCalls++;
				if (completeMandatoryDelivery(stream, providerContext)) return;
				if (providerCalls === 3) {
					stream.push({
						type: "done",
						reason: "stop",
						message: assistantMessage([{ type: "text", text: "compaction boundary" }], "stop"),
					});
					return;
				}
				stream.push({
					type: "done",
					reason: "toolUse",
					message: assistantMessage(
						[{ type: "toolCall", id: `t${providerCalls}`, name: "echo", arguments: { value: "stuck" } }],
						"toolUse",
					),
				});
			});
			return stream;
		};
		const agent = new Agent({
			streamFn,
			initialState: {
				model: createModel(),
				systemPrompt: "",
				tools: [echoTool],
			},
		});
		agent.maxStallTurns = 4;
		agent.onRunawayStop = (info) => stalls.push(info);

		await agent.prompt("start");
		agent.state.messages.push({
			role: "custom",
			customType: "compactionSummary",
			content: "continue after compaction",
			display: false,
			timestamp: Date.now(),
		});
		await agent.continue();

		expect(stalls).toEqual([expect.objectContaining({ reason: "stagnant_tool_cycle", repeats: 3 })]);
		// Three unchanged tool-result turns plus the compaction boundary and one tool-free closing request.
		expect(providerCalls).toBe(5);
	});

	it("retains an explicit provider-turn fuse across a host continuation", async () => {
		let providerCalls = 0;
		const stalls: Array<{ reason?: string; signature: string; repeats: number }> = [];
		const localTerminalMessages: AssistantMessage[] = [];
		const events: AgentEvent[] = [];
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				providerCalls++;
				if (providerCalls === 2) {
					stream.push({
						type: "done",
						reason: "stop",
						message: assistantMessage([{ type: "text", text: "compaction boundary" }], "stop"),
					});
					return;
				}
				stream.push({
					type: "done",
					reason: "toolUse",
					message: assistantMessage(
						[{ type: "toolCall", id: `provider-${providerCalls}`, name: "echo", arguments: { value: "work" } }],
						"toolUse",
					),
				});
			});
			return stream;
		};
		const agent = new Agent({
			streamFn,
			maxProviderTurns: 3,
			initialState: { model: createModel(), systemPrompt: "", tools: [echoTool] },
			onRunawayStop: (info) => stalls.push(info),
		});
		agent.maxStallTurns = 0;
		agent.subscribe((event) => {
			events.push(event);
			if (event.type === "message_end" && event.origin === "local" && event.message.role === "assistant") {
				localTerminalMessages.push(event.message);
			}
		});

		await agent.prompt("start");
		agent.state.messages.push({
			role: "custom",
			customType: "compactionSummary",
			content: "continue after compaction",
			display: false,
			timestamp: Date.now(),
		});
		await agent.continue();

		expect(providerCalls).toBe(3);
		expect(stalls).toEqual([
			expect.objectContaining({ reason: "provider_turn_limit", signature: "provider_turn_limit", repeats: 3 }),
		]);
		expect(localTerminalMessages).toEqual([]);
		expect(JSON.stringify(agent.state.messages)).not.toContain("Configured provider turn limit");
		// A provider-limit stop is not an assistant turn, so removing the old synthetic assistant must
		// not leave an unmatched turn_start behind for extensions or UI state machines.
		expect(events.filter((event) => event.type === "turn_start")).toHaveLength(3);
		expect(events.filter((event) => event.type === "turn_end")).toHaveLength(3);
		expect(events.at(-1)?.type).toBe("agent_end");
	});

	it("does not accumulate changed-operation failures across a host continuation", async () => {
		let providerCalls = 0;
		let sawToollessProviderTurn = false;
		const failingTool = createEchoTool(() => {
			throw new Error("unsupported option");
		});
		const streamFn: StreamFn = (_model, context) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				providerCalls++;
				if (context.tools?.length === 0) {
					sawToollessProviderTurn = true;
					completeMandatoryDelivery(stream, context);
					return;
				}
				if (providerCalls === 3 || providerCalls === 6) {
					stream.push({
						type: "done",
						reason: "stop",
						message: assistantMessage([{ type: "text", text: "boundary" }], "stop"),
					});
					return;
				}
				stream.push({
					type: "done",
					reason: "toolUse",
					message: assistantMessage(
						[
							{
								type: "toolCall",
								id: `failure-${providerCalls}`,
								name: "echo",
								arguments: { value: `variant-${providerCalls}` },
							},
						],
						"toolUse",
					),
				});
			});
			return stream;
		};
		const agent = new Agent({
			streamFn,
			initialState: { model: createModel(), systemPrompt: "", tools: [failingTool] },
		});

		await agent.prompt("start");
		agent.state.messages.push({
			role: "custom",
			customType: "compactionSummary",
			content: "continue after compaction",
			display: false,
			timestamp: Date.now(),
		});
		await agent.continue();

		expect(sawToollessProviderTurn).toBe(false);
		expect(providerCalls).toBe(6);
	});

	it("stops a loop that repeats the identical tool call, firing onRunawayStop", async () => {
		let executions = 0;
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [createEchoTool(() => executions++)],
		};
		let toolCalls = 0;
		const stalls: Array<{ reason: string; signature: string; repeats: number }> = [];

		// Always returns the SAME tool call (same args) and never stops — without the backstop this is
		// an infinite token sink.
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				toolCalls++;
				stream.push({
					type: "done",
					reason: "toolUse",
					message: assistantMessage(
						[
							{
								type: "toolCall",
								id: `t${toolCalls}`,
								name: "echo",
								arguments: { value: "stuck" },
								source: "text-protocol",
							},
						],
						"toolUse",
					),
				});
			});
			return stream;
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			maxStallTurns: 4,
			onRunawayStop: (info) => stalls.push(info),
		};

		const events = await drain(
			agentLoop([{ role: "user", content: "go", timestamp: 1 }], context, config, undefined, streamFn),
		);

		// After the initial success, three identical repeated-success results trip the stronger stagnant guard.
		expect(stalls).toMatchObject([{ reason: "stagnant_tool_cycle", repeats: 3 }]);
		expect(toolCalls).toBe(5); // four looping turns, then one tool-free closing request
		expect(executions).toBe(1); // repeated phone calls teach without replaying the successful operation
		const rejectedRepeats = events.filter((event) => event.type === "tool_execution_end" && event.isError);
		expect(rejectedRepeats).toHaveLength(3);
		for (const event of rejectedRepeats) {
			if (event.type !== "tool_execution_end") throw new Error("Expected tool_execution_end");
			const text =
				event.result.content.find((block: { type: string; text?: string }) => block.type === "text")?.text ?? "";
			expect(text).toContain('"failure_code":"repeated_successful_call"');
			expect(text).toContain('"next_action":"Use prior successful result; continue');
			expect(text).toContain("echoed: stuck");
		}
		expect(events.filter((e) => e.type === "agent_end")).toHaveLength(1);
	});

	it("teaches a phone model after one repeated success and lets it recover without halting", async () => {
		let executions = 0;
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [createEchoTool(() => executions++)],
		};
		const stalls: Array<{ signature: string; repeats: number }> = [];
		let turn = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				turn++;
				if (turn <= 2) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: assistantMessage(
							[
								{
									type: "toolCall",
									id: `t${turn}`,
									name: "echo",
									arguments: { value: "once" },
									source: "text-protocol",
								},
							],
							"toolUse",
						),
					});
					return;
				}
				stream.push({
					type: "done",
					reason: "stop",
					message: assistantMessage([{ type: "text", text: "used the result" }], "stop"),
				});
			});
			return stream;
		};

		const events = await drain(
			agentLoop(
				[{ role: "user", content: "go", timestamp: 1 }],
				context,
				{
					model: createModel(),
					convertToLlm: identityConverter,
					maxStallTurns: 4,
					onRunawayStop: (info) => stalls.push(info),
				},
				undefined,
				streamFn,
			),
		);

		expect(executions).toBe(1);
		expect(stalls).toHaveLength(0);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "tool_execution_end",
				isError: true,
				result: expect.objectContaining({
					content: expect.arrayContaining([
						expect.objectContaining({
							type: "text",
							text: expect.stringContaining('"failure_code":"repeated_successful_call"'),
						}),
					]),
				}),
			}),
		);
		expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
	});

	it("does not route native tool calls through the phone repeat guard", async () => {
		let executions = 0;
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [createEchoTool(() => executions++)],
		};
		let turn = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				turn++;
				if (turn <= 2) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: assistantMessage(
							[{ type: "toolCall", id: `t${turn}`, name: "echo", arguments: { value: "native" } }],
							"toolUse",
						),
					});
					return;
				}
				stream.push({
					type: "done",
					reason: "stop",
					message: assistantMessage([{ type: "text", text: "done" }], "stop"),
				});
			});
			return stream;
		};

		const events = await drain(
			agentLoop(
				[{ role: "user", content: "go", timestamp: 1 }],
				context,
				{ model: createModel(), convertToLlm: identityConverter, maxStallTurns: 4 },
				undefined,
				streamFn,
			),
		);

		expect(executions).toBe(2);
		expect(events.filter((event) => event.type === "tool_execution_end" && event.isError)).toHaveLength(0);
	});

	it("guards a completed phone write by path when the model changes payload representation", async () => {
		let executions = 0;
		const writeLikeTool: AgentTool<typeof writeLikeSchema, { phase: string }> = {
			name: "write",
			label: "Write",
			description: "Write once",
			parameters: writeLikeSchema,
			async execute() {
				executions++;
				return { content: [{ type: "text", text: "write complete" }], details: { phase: "written" } };
			},
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [writeLikeTool] };
		let turn = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				turn++;
				if (turn <= 3) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: assistantMessage(
							[
								{
									type: "toolCall",
									id: `write-${turn}`,
									name: "write",
									arguments:
										turn === 1
											? { path: "same.txt", content: "bytes" }
											: turn === 2
												? { path: "same.txt", contentRef: "file-content:bytes" }
												: { path: "same.txt", content: "different bytes" },
									source: "text-protocol",
								},
							],
							"toolUse",
						),
					});
					return;
				}
				stream.push({
					type: "done",
					reason: "stop",
					message: assistantMessage([{ type: "text", text: "done" }], "stop"),
				});
			});
			return stream;
		};

		const events = await drain(
			agentLoop(
				[{ role: "user", content: "go", timestamp: 1 }],
				context,
				{ model: createModel(), convertToLlm: identityConverter, maxStallTurns: 4 },
				undefined,
				streamFn,
			),
		);
		const guarded = events.filter(
			(event) =>
				event.type === "tool_execution_end" && (event.toolCallId === "write-2" || event.toolCallId === "write-3"),
		);

		expect(executions).toBe(1);
		expect(guarded).toHaveLength(2);
		for (const event of guarded) {
			expect(event).toMatchObject({
				type: "tool_execution_end",
				isError: true,
				result: {
					details: {
						piRepeatedSuccessfulCall: { previousToolCallId: "write-1" },
					},
				},
			});
		}
	});

	it("does not trip on legitimate varied tool use", async () => {
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [echoTool] };
		const stalls: unknown[] = [];
		let turn = 0;

		// Five DISTINCT tool calls, then a normal stop — varied work must complete untouched.
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				turn++;
				if (turn <= 5) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: assistantMessage(
							[{ type: "toolCall", id: `t${turn}`, name: "echo", arguments: { value: `v${turn}` } }],
							"toolUse",
						),
					});
				} else {
					stream.push({
						type: "done",
						reason: "stop",
						message: assistantMessage([{ type: "text", text: "done" }], "stop"),
					});
				}
			});
			return stream;
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			maxStallTurns: 4,
			onRunawayStop: (info) => stalls.push(info),
		};

		const events = await drain(
			agentLoop([{ role: "user", content: "go", timestamp: 1 }], context, config, undefined, streamFn),
		);

		expect(stalls).toHaveLength(0); // varied args never trip the backstop
		expect(events.filter((e) => e.type === "agent_end")).toHaveLength(1);
	});

	it("does not stop progressing work when housekeeping calls recur among distinct operations", async () => {
		const sequence = [
			"goal-status",
			"task-status",
			"edit-1",
			"goal-status",
			"task-status",
			"read-1",
			"goal-status",
			"task-status",
			"test-1",
			"goal-status",
		];
		let providerTurns = 0;
		let executions = 0;
		let toolFreeTurns = 0;
		const stalls: Array<{ signature: string; repeats: number }> = [];
		const streamFn: StreamFn = (_model, providerContext) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				providerTurns++;
				if (providerContext.tools?.length === 0) {
					toolFreeTurns++;
					stream.push({
						type: "done",
						reason: "stop",
						message: assistantMessage([{ type: "text", text: "premature guard close" }], "stop"),
					});
					return;
				}
				const value = sequence[providerTurns - 1];
				if (value) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: assistantMessage(
							[{ type: "toolCall", id: `work-${providerTurns}`, name: "echo", arguments: { value } }],
							"toolUse",
						),
					});
					return;
				}
				stream.push({
					type: "done",
					reason: "stop",
					message: assistantMessage([{ type: "text", text: "all work complete" }], "stop"),
				});
			});
			return stream;
		};

		const events = await drain(
			agentLoop(
				[{ role: "user", content: "complete the workflow", timestamp: 1 }],
				{ systemPrompt: "", messages: [], tools: [createEchoTool(() => executions++)] },
				{
					model: createModel(),
					convertToLlm: identityConverter,
					maxStallTurns: 4,
					onRunawayStop: (info) => stalls.push(info),
				},
				undefined,
				streamFn,
			),
		);

		expect(stalls).toEqual([]);
		expect(toolFreeTurns).toBe(0);
		expect(executions).toBe(sequence.length);
		expect(providerTurns).toBe(sequence.length + 1);
		expect(
			events.some(
				(event) =>
					event.type === "message_end" &&
					event.message.role === "assistant" &&
					event.message.content.some((block) => block.type === "text" && block.text === "all work complete"),
			),
		).toBe(true);
	});

	it("trips when only a volatile arg (timestamp) changes each call (bug #28)", async () => {
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [echoTool] };
		const stalls: Array<{ signature: string; repeats: number }> = [];
		let n = 0;

		// Same logical call, but with a fresh epoch-ms timestamp baked into the args every turn — a naive
		// exact-match detector would never see a repeat. Normalization must collapse these to one signature.
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				n++;
				const ts = 1_700_000_000_000 + n * 1234; // changing 13-digit epoch ms
				stream.push({
					type: "done",
					reason: "toolUse",
					message: assistantMessage(
						[{ type: "toolCall", id: `t${n}`, name: "echo", arguments: { value: `fetch?at=${ts}` } }],
						"toolUse",
					),
				});
			});
			return stream;
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			maxStallTurns: 4,
			onRunawayStop: (info) => stalls.push(info),
		};

		const events = await drain(
			agentLoop([{ role: "user", content: "go", timestamp: 1 }], context, config, undefined, streamFn),
		);

		expect(stalls).toHaveLength(1);
		expect(stalls[0].repeats).toBe(4); // volatile timestamps masked → detected
		expect(events.filter((e) => e.type === "agent_end")).toHaveLength(1);
	});

	it("teaches once then gates semantically identical deterministic failures before re-execution", async () => {
		const orderedSchema = Type.Object({ path: Type.String(), offset: Type.Number() });
		let executions = 0;
		const failingTool: AgentTool<typeof orderedSchema> = {
			name: "read_like",
			label: "Read-like",
			description: "Read a path",
			parameters: orderedSchema,
			async execute() {
				executions++;
				throw new Error("ENOENT: no such file or directory, open 'C:\\missing\\file.txt'");
			},
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [failingTool] };
		const stalls: Array<{ signature: string; repeats: number }> = [];
		let calls = 0;
		let toolFreeProviderTurns = 0;
		const streamFn = (_model: unknown, providerContext: { tools?: readonly unknown[] }) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (completeMandatoryDelivery(stream, providerContext)) {
					toolFreeProviderTurns++;
					return;
				}
				calls++;
				const argumentsValue =
					calls % 2 === 0
						? { offset: 1, path: "C:\\missing\\file.txt" }
						: { path: "C:\\missing\\file.txt", offset: 1 };
				stream.push({
					type: "done",
					reason: "toolUse",
					message: assistantMessage(
						[{ type: "toolCall", id: `failed-${calls}`, name: "read_like", arguments: argumentsValue }],
						"toolUse",
					),
				});
			});
			return stream;
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			maxStallTurns: 4,
			onRunawayStop: (info) => stalls.push(info),
		};

		const events = await drain(
			agentLoop([{ role: "user", content: "go", timestamp: 1 }], context, config, undefined, streamFn),
		);
		const toolEndMessages = events
			.filter((event) => event.type === "tool_execution_end")
			.map(
				(event) =>
					(event as { result: { content: Array<{ type: string; text?: string }> } }).result.content.find(
						(block: { type: string; text?: string }) => block.type === "text",
					)?.text ?? "",
			);

		// Reordered argument keys are the same operation, so only the first call ever executes. Every
		// later replay gets the same refusal — it never escalates into a different, harsher code.
		expect(executions).toBe(1);
		expect(toolEndMessages).toHaveLength(4);
		for (const message of toolEndMessages.slice(1)) {
			expect(message).toContain('"failure_code":"repeated_failed_operation"');
		}
		// The wedged model is stopped by the cost guard, which is the only thing here that ends a run.
		expect(stalls).toHaveLength(1);
		// The stall stop spends exactly one tool-free request so the model closes in its own words.
		expect(toolFreeProviderTurns).toBe(1);
		expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
	});

	it("treats the same command with a different timeout as the same failed operation", async () => {
		const schema = Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) });
		let executions = 0;
		const failingTool: AgentTool<typeof schema> = {
			name: "bash",
			label: "bash",
			description: "bash",
			parameters: schema,
			async execute() {
				executions++;
				throw new Error("Command exited with code 1");
			},
		};
		let calls = 0;
		let deliveryTurns = 0;
		const streamFn = (_model: unknown, providerContext: { tools?: readonly unknown[] }) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (completeMandatoryDelivery(stream, providerContext)) {
					deliveryTurns++;
					return;
				}
				calls++;
				stream.push({
					type: "done",
					reason: "toolUse",
					message: assistantMessage(
						[
							{
								type: "toolCall",
								id: `bash-${calls}`,
								name: "bash",
								arguments: {
									command: "./test.sh packages/coding-agent/test/natural-language-goal.test.ts",
									timeout: calls === 1 ? 240 : 180,
								},
							},
						],
						"toolUse",
					),
				});
			});
			return stream;
		};
		const events = await drain(
			agentLoop(
				[{ role: "user", content: "run the targeted tests", timestamp: 1 }],
				{ systemPrompt: "", messages: [], tools: [failingTool] },
				{ model: createModel(), convertToLlm: identityConverter, maxStallTurns: 4 },
				undefined,
				streamFn,
			),
		);
		const toolEndMessages = events
			.filter((event) => event.type === "tool_execution_end")
			.map(
				(event) =>
					(event as { result: { content: Array<{ type: string; text?: string }> } }).result.content.find(
						(block: { type: string; text?: string }) => block.type === "text",
					)?.text ?? "",
			);

		expect(executions).toBe(1);
		expect(toolEndMessages[1]).toContain('"failure_code":"repeated_failed_operation"');
		expect(deliveryTurns).toBe(1);
	});

	it("closes a stalled run with exactly one tool-free provider request and no further tool work", async () => {
		let executions = 0;
		const stalls: Array<{ reason?: string }> = [];
		const toolCounts: number[] = [];
		const systemPrompts: string[] = [];
		const repeatedThinking = "The operation is still blocked. I will report the unresolved blocker.";
		let turns = 0;
		const events = await drain(
			agentLoop(
				[{ role: "user", content: "go", timestamp: 1 }],
				{ systemPrompt: "", messages: [], tools: [createEchoTool(() => executions++)] },
				{
					model: createModel(),
					convertToLlm: identityConverter,
					maxStallTurns: 3,
					onRunawayStop: (info) => stalls.push(info),
				},
				undefined,
				(_model, providerContext: { systemPrompt?: string; tools?: readonly unknown[] }) => {
					toolCounts.push(providerContext.tools?.length ?? -1);
					systemPrompts.push(providerContext.systemPrompt ?? "");
					const stream = new MockAssistantStream();
					queueMicrotask(() => {
						turns++;
						// The normal closing response follows the request-local instruction and returns text.
						stream.push(
							providerContext.tools?.length === 0
								? {
										type: "done",
										reason: "stop",
										message: assistantMessage(
											[
												{ type: "thinking", thinking: repeatedThinking, thinkingSignature: "reasoning" },
												{ type: "text", text: "Stuck on one call; stopping." },
											],
											"stop",
										),
									}
								: {
										type: "done",
										reason: "toolUse",
										message: assistantMessage(
											[
												{ type: "thinking", thinking: repeatedThinking, thinkingSignature: "reasoning" },
												{
													type: "toolCall",
													id: `echo-${turns}`,
													name: "echo",
													arguments: { value: "stuck" },
												},
											],
											"toolUse",
										),
									},
						);
					});
					return stream;
				},
			),
		);

		expect(stalls).toEqual([expect.objectContaining({ reason: "stagnant_tool_cycle" })]);
		// Three unchanged-result requests carried tools; exactly one closing request carried none.
		expect(toolCounts).toEqual([1, 1, 1, 0]);
		expect(systemPrompts[3]).toContain("RUNAWAY STOP CLOSING TURN");
		expect(systemPrompts[3]).toContain("Do not emit a tool call or tool-call markup");
		// The tool ran for the three admitted calls and never for the closing turn.
		expect(executions).toBe(3);
		expect(
			events.filter((event) => event.type === "message_end" && event.message.role === "toolResult"),
		).toHaveLength(3);
		// The model authored the closing text; the harness added none of its own.
		const assistantTexts = events.flatMap((event) =>
			event.type === "message_end" && event.message.role === "assistant"
				? event.message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
				: [],
		);
		expect(assistantTexts).toContain("Stuck on one call; stopping.");
		const closingAssistant = events.find(
			(event) =>
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.content.some(
					(block) => block.type === "text" && block.text === "Stuck on one call; stopping.",
				),
		);
		expect(closingAssistant).toBeDefined();
		if (closingAssistant?.type === "message_end" && closingAssistant.message.role === "assistant") {
			expect(closingAssistant.message.content.some((block) => block.type === "thinking")).toBe(false);
		}
		expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
		expect(events.at(-1)?.type).toBe("agent_end");
	});

	it.each([
		{
			kind: "native",
			closingMessage: () =>
				assistantMessage(
					[{ type: "toolCall", id: "closing-native", name: "echo", arguments: { value: "stuck" } }],
					"toolUse",
				),
		},
		{
			kind: "rendered",
			closingMessage: () =>
				assistantMessage([{ type: "text", text: 'to=functions.echo code\n{"value":"stuck"}' }], "stop"),
		},
		{
			kind: "rendered unavailable-tool",
			closingMessage: () =>
				assistantMessage([{ type: "text", text: 'to=functions.not_loaded code\n{"value":"stuck"}' }], "stop"),
		},
	])("rejects a $kind tool call from the tool-free closing response", async ({ closingMessage }) => {
		let executions = 0;
		const toolCounts: number[] = [];
		const systemPrompts: string[] = [];
		let turns = 0;
		const events = await drain(
			agentLoop(
				[{ role: "user", content: "go", timestamp: 1 }],
				{ systemPrompt: "base", messages: [], tools: [createEchoTool(() => executions++)] },
				{ model: createModel(), convertToLlm: identityConverter, maxStallTurns: 2 },
				undefined,
				(_model, providerContext: { systemPrompt?: string; tools?: readonly unknown[] }) => {
					toolCounts.push(providerContext.tools?.length ?? -1);
					systemPrompts.push(providerContext.systemPrompt ?? "");
					const stream = new MockAssistantStream();
					queueMicrotask(() => {
						turns++;
						if (providerContext.tools?.length === 0) {
							const closing = closingMessage();
							const reason = closing.stopReason;
							if (reason !== "length" && reason !== "stop" && reason !== "toolUse") {
								throw new Error(`Invalid completed closing response: ${reason}`);
							}
							stream.push({ type: "done", reason, message: closing });
							return;
						}
						stream.push({
							type: "done",
							reason: "toolUse",
							message: assistantMessage(
								[
									{
										type: "toolCall",
										id: `echo-${turns}`,
										name: "echo",
										arguments: { value: "stuck" },
									},
								],
								"toolUse",
							),
						});
					});
					return stream;
				},
			),
		);

		expect(toolCounts).toEqual([1, 1, 0]);
		expect(systemPrompts[2]).toContain("RUNAWAY STOP CLOSING TURN");
		expect(executions).toBe(2);
		expect(
			events.filter((event) => event.type === "message_end" && event.message.role === "toolResult"),
		).toHaveLength(2);
		const finalAssistant = events.findLast(
			(event): event is Extract<AgentEvent, { type: "message_end" }> & { message: AssistantMessage } =>
				event.type === "message_end" && event.message.role === "assistant",
		)?.message;
		expect(finalAssistant).toMatchObject({
			stopReason: "error",
			errorMessage: expect.stringContaining("tool_free_response_tool_call"),
		});
		expect(finalAssistant?.content.some((block) => block.type === "toolCall")).toBe(false);
		expect(finalAssistant?.content.some((block) => block.type === "text" && block.text.length > 0)).toBe(false);
		expect(events.at(-1)?.type).toBe("agent_end");
	});

	it("skips the closing request when the provider-turn limit leaves no budget", async () => {
		const stalls: Array<{ reason?: string }> = [];
		const toolCounts: number[] = [];
		let turns = 0;
		const events = await drain(
			agentLoop(
				[{ role: "user", content: "go", timestamp: 1 }],
				{ systemPrompt: "", messages: [], tools: [createEchoTool()] },
				{
					model: createModel(),
					convertToLlm: identityConverter,
					maxStallTurns: 3,
					maxProviderTurns: 3,
					onRunawayStop: (info) => stalls.push(info),
				},
				undefined,
				(_model, providerContext: { tools?: readonly unknown[] }) => {
					toolCounts.push(providerContext.tools?.length ?? -1);
					const stream = new MockAssistantStream();
					queueMicrotask(() => {
						turns++;
						stream.push({
							type: "done",
							reason: "toolUse",
							message: assistantMessage(
								[{ type: "toolCall", id: `echo-${turns}`, name: "echo", arguments: { value: "stuck" } }],
								"toolUse",
							),
						});
					});
					return stream;
				},
			),
		);

		// The hard provider limit wins: three requests, none of them tool-free, and no fabricated close.
		expect(stalls).toEqual([expect.objectContaining({ reason: "stagnant_tool_cycle" })]);
		expect(toolCounts).toEqual([1, 1, 1]);
		const assistantTexts = events.flatMap((event) =>
			event.type === "message_end" && event.message.role === "assistant"
				? event.message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
				: [],
		);
		expect(assistantTexts.filter((text) => text.length > 0)).toEqual([]);
		expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
	});

	it("does not treat changed volatile-looking arguments as an unchanged operation", async () => {
		const schema = Type.Object({ path: Type.String() });
		const firstPath = "missing-123e4567-e89b-12d3-a456-426614174000.txt";
		const secondPath = "missing-123e4567-e89b-12d3-a456-426614174111.txt";
		let executions = 0;
		const failingTool: AgentTool<typeof schema> = {
			name: "read_like",
			label: "Read-like",
			description: "Read a path",
			parameters: schema,
			async execute(_id, params) {
				executions++;
				throw new Error(`ENOENT: no such file or directory, open '${params.path}'`);
			},
		};
		let turn = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				turn++;
				if (turn <= 3) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: assistantMessage(
							[
								{
									type: "toolCall",
									id: `volatile-${turn}`,
									name: "read_like",
									arguments: { path: turn === 1 ? firstPath : secondPath },
								},
							],
							"toolUse",
						),
					});
					return;
				}
				stream.push({
					type: "done",
					reason: "stop",
					message: assistantMessage([{ type: "text", text: "done" }], "stop"),
				});
			});
			return stream;
		};
		const events = await drain(
			agentLoop(
				[{ role: "user", content: "go", timestamp: 1 }],
				{ systemPrompt: "", messages: [], tools: [failingTool] },
				{ model: createModel(), convertToLlm: identityConverter, maxStallTurns: 0 },
				undefined,
				streamFn,
			),
		);

		expect(executions).toBe(2);
		expect(
			events.some(
				(event) =>
					event.type === "tool_execution_end" &&
					event.toolCallId === "volatile-3" &&
					resultContainsFailureCode(event.result, "repeated_failed_operation"),
			),
		).toBe(true);
	});

	it("keeps the execution gate across replacement contexts and bypasses hooks for blocked calls", async () => {
		const schema = Type.Object({ path: Type.String() });
		let executions = 0;
		let beforeCalls = 0;
		const failingTool: AgentTool<typeof schema> = {
			name: "read_like",
			label: "Read-like",
			description: "Read a path",
			parameters: schema,
			async execute() {
				executions++;
				throw new Error("ENOENT: no such file or directory, open 'missing.txt'");
			},
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [failingTool] };
		let calls = 0;
		let deliveryTurns = 0;
		const streamFn = (_model: unknown, providerContext: { tools?: readonly unknown[] }) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (completeMandatoryDelivery(stream, providerContext)) {
					deliveryTurns++;
					return;
				}
				calls++;
				stream.push({
					type: "done",
					reason: "toolUse",
					message: assistantMessage(
						[
							{
								type: "toolCall",
								id: `refresh-${calls}`,
								name: "read_like",
								arguments: { path: "missing.txt" },
							},
						],
						"toolUse",
					),
				});
			});
			return stream;
		};
		const events = await drain(
			agentLoop(
				[{ role: "user", content: "go", timestamp: 1 }],
				context,
				{
					model: createModel(),
					convertToLlm: identityConverter,
					maxStallTurns: 4,
					beforeToolCall: async () => {
						beforeCalls++;
						return undefined;
					},
					prepareNextTurn: ({ context: currentContext }) => ({
						context: { ...currentContext, messages: currentContext.messages.slice() },
					}),
				},
				undefined,
				streamFn,
			),
		);
		const toolResultIds = events.flatMap((event) =>
			event.type === "message_end" && event.message.role === "toolResult" ? [event.message.toolCallId] : [],
		);
		const blocked = events.filter(
			(event) =>
				event.type === "tool_execution_end" && resultContainsFailureCode(event.result, "repeated_failed_operation"),
		);
		// One execution and one hook call: a refused replay reaches neither the tool nor beforeToolCall,
		// and a replaced context does not lose that state.
		expect(executions).toBe(1);
		expect(beforeCalls).toBe(1);
		expect(deliveryTurns).toBe(1);
		expect(toolResultIds).toEqual(["refresh-1", "refresh-2", "refresh-3", "refresh-4"]);
		expect(blocked).toHaveLength(3);
	});

	it("keeps run-scoped failure authority when a replacement context omits the failure transcript", async () => {
		const schema = Type.Object({ path: Type.String() });
		let executions = 0;
		let beforeCalls = 0;
		const failingTool: AgentTool<typeof schema> = {
			name: "read_like",
			label: "Read-like",
			description: "Read a path",
			parameters: schema,
			async execute() {
				executions++;
				throw new Error("ENOENT: no such file or directory, open 'missing.txt'");
			},
		};
		let calls = 0;
		const events = await drain(
			agentLoop(
				[{ role: "user", content: "go", timestamp: 1 }],
				{ systemPrompt: "", messages: [], tools: [failingTool] },
				{
					model: createModel(),
					convertToLlm: identityConverter,
					maxStallTurns: 2,
					beforeToolCall: async () => {
						beforeCalls++;
						return undefined;
					},
					prepareNextTurn: ({ context: currentContext }) => ({
						context: {
							...currentContext,
							messages: currentContext.messages.filter((message) => message.role === "user"),
						},
					}),
				},
				undefined,
				() => {
					const stream = new MockAssistantStream();
					queueMicrotask(() => {
						calls++;
						stream.push({
							type: "done",
							reason: "toolUse",
							message: assistantMessage(
								[
									{
										type: "toolCall",
										id: `omitted-memory-${calls}`,
										name: "read_like",
										arguments: { path: "missing.txt" },
									},
								],
								"toolUse",
							),
						});
					});
					return stream;
				},
			),
		);

		expect(executions).toBe(1);
		expect(beforeCalls).toBe(1);
		expect(
			events.some(
				(event) =>
					event.type === "tool_execution_end" &&
					event.toolCallId === "omitted-memory-2" &&
					resultContainsFailureCode(event.result, "repeated_failed_operation"),
			),
		).toBe(true);
	});

	it("reopens after recovery and clears the operation budget after exact success", async () => {
		const pathSchema = Type.Object({ path: Type.String() });
		const repairSchema = Type.Object({ target: Type.String() });
		const targetKind = "test.file.exists";
		let repaired = false;
		let targetExecutions = 0;
		let repairExecutions = 0;
		const targetTool: AgentTool<typeof pathSchema> = {
			name: "read_like",
			label: "Read-like",
			description: "Read a path",
			parameters: pathSchema,
			failureRecovery: {
				getFailureTargets: (params, failure) =>
					failure.failureCode === "file_not_found"
						? [{ authority: TEST_RECOVERY_AUTHORITY, kind: targetKind, scope: params.path }]
						: [],
			},
			async execute() {
				targetExecutions++;
				if (!repaired) throw new Error("ENOENT: no such file or directory, open 'missing.txt'");
				return { content: [{ type: "text", text: "recovered" }], details: {} };
			},
		};
		const repairTool: AgentTool<typeof repairSchema, { repaired: boolean }> = {
			name: "repair_like",
			label: "Repair-like",
			description: "Repair a path",
			parameters: repairSchema,
			failureRecovery: {
				actions: [
					{
						kind: "repair",
						authority: TEST_RECOVERY_AUTHORITY,
						targetKind,
						instruction: "Use repair_like on the failed target.",
					},
				],
			},
			async execute() {
				repairExecutions++;
				repaired = true;
				return { content: [{ type: "text", text: "repaired" }], details: { repaired: true } };
			},
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [targetTool, repairTool] };
		let turn = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				turn++;
				if (turn <= 6) {
					const recoveryTurn = turn === 4;
					stream.push({
						type: "done",
						reason: "toolUse",
						message: assistantMessage(
							[
								recoveryTurn
									? {
											type: "toolCall",
											id: "repair",
											name: "repair_like",
											arguments: { target: "missing.txt" },
										}
									: {
											type: "toolCall",
											id: `target-${turn}`,
											name: "read_like",
											arguments: { path: "missing.txt" },
										},
							],
							"toolUse",
						),
					});
					return;
				}
				stream.push({
					type: "done",
					reason: "stop",
					message: assistantMessage([{ type: "text", text: "done" }], "stop"),
				});
			});
			return stream;
		};
		const events = await drain(
			agentLoop(
				[{ role: "user", content: "go", timestamp: 1 }],
				context,
				{ model: createModel(), convertToLlm: identityConverter },
				undefined,
				streamFn,
			),
		);

		// Two refused replays while nothing had changed, then the repair succeeds and the same
		// operation runs again — and keeps running, because success clears its state outright.
		expect(targetExecutions).toBe(3);
		expect(repairExecutions).toBe(1);
		expect(
			events.filter(
				(event) =>
					event.type === "tool_execution_end" &&
					resultContainsFailureCode(event.result, "repeated_failed_operation"),
			),
		).toHaveLength(2);
		expect(
			events.find((event) => event.type === "tool_execution_end" && event.toolCallId === "target-5"),
		).toMatchObject({
			type: "tool_execution_end",
			isError: false,
		});
		expect(
			events.find((event) => event.type === "tool_execution_end" && event.toolCallId === "target-6"),
		).toMatchObject({
			type: "tool_execution_end",
			isError: false,
		});
	});

	it("re-admits a failed operation after any unrelated success, then refuses it again immediately", async () => {
		const targetSchema = Type.Object({ path: Type.String() });
		const unrelatedSchema = Type.Object({ value: Type.String() });
		let targetExecutions = 0;
		let unrelatedExecutions = 0;
		const targetTool: AgentTool<typeof targetSchema> = {
			name: "read_like",
			label: "Read-like",
			description: "Read a path",
			parameters: targetSchema,
			async execute() {
				targetExecutions++;
				throw new Error("ENOENT: no such file or directory, open 'missing.txt'");
			},
		};
		const unrelatedTool: AgentTool<typeof unrelatedSchema> = {
			name: "unrelated",
			label: "Unrelated",
			description: "Perform unrelated work",
			parameters: unrelatedSchema,
			async execute() {
				unrelatedExecutions++;
				return { content: [{ type: "text", text: "unrelated success" }], details: {} };
			},
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [targetTool, unrelatedTool] };
		let turn = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				turn++;
				if (turn <= 3) {
					const unrelatedTurn = turn === 2;
					stream.push({
						type: "done",
						reason: "toolUse",
						message: assistantMessage(
							[
								unrelatedTurn
									? {
											type: "toolCall",
											id: "unrelated-1",
											name: "unrelated",
											arguments: { value: "missing.txt" },
										}
									: {
											type: "toolCall",
											id: `target-${turn}`,
											name: "read_like",
											arguments: { path: "missing.txt" },
										},
							],
							"toolUse",
						),
					});
					return;
				}
				stream.push({
					type: "done",
					reason: "stop",
					message: assistantMessage([{ type: "text", text: "done" }], "stop"),
				});
			});
			return stream;
		};
		const events = await drain(
			agentLoop(
				[{ role: "user", content: "go", timestamp: 1 }],
				context,
				{ model: createModel(), convertToLlm: identityConverter },
				undefined,
				streamFn,
			),
		);

		// Deliberate trade: admission is governed by whether the world moved, not by a declared
		// evidence handshake between two specific tools. An unrelated success re-admits the failed
		// operation, which costs at most one execution — and the operation that fails again is refused
		// again at once. The alternative, requiring exact declared evidence, is what left operations
		// permanently dead when no loaded tool could supply it.
		expect(targetExecutions).toBe(2);
		expect(unrelatedExecutions).toBe(1);
		expect(
			events.find((event) => event.type === "tool_execution_end" && event.toolCallId === "target-3"),
		).toMatchObject({ type: "tool_execution_end", isError: true });
		expect(
			events.some(
				(event) =>
					event.type === "tool_execution_end" &&
					event.toolCallId === "target-3" &&
					resultContainsFailureCode(event.result, "file_not_found"),
			),
		).toBe(true);
	});

	it("does not re-admit a failed operation when the intervening repair also failed", async () => {
		const targetSchema = Type.Object({ path: Type.String() });
		const repairSchema = Type.Object({ target: Type.String() });
		const targetKind = "test.file.exists";
		let targetExecutions = 0;
		const targetTool: AgentTool<typeof targetSchema> = {
			name: "read_like",
			label: "Read-like",
			description: "Read a path",
			parameters: targetSchema,
			failureRecovery: {
				getFailureTargets: (params) => [
					{ authority: TEST_RECOVERY_AUTHORITY, kind: targetKind, scope: params.path },
				],
			},
			async execute() {
				targetExecutions++;
				throw new Error("ENOENT: no such file or directory, open 'missing.txt'");
			},
		};
		const repairTool: AgentTool<typeof repairSchema, { repaired: boolean }> = {
			name: "repair_like",
			label: "Repair-like",
			description: "Inspect a possible repair",
			parameters: repairSchema,
			failureRecovery: {
				actions: [
					{
						kind: "repair",
						authority: TEST_RECOVERY_AUTHORITY,
						targetKind,
						instruction: "Exercise a broken evidence callback.",
					},
					{
						kind: "repair",
						authority: TEST_RECOVERY_AUTHORITY,
						targetKind,
						instruction: "Use repair_like on the failed target.",
					},
				],
			},
			async execute() {
				throw new Error("repair backend refused the request");
			},
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [targetTool, repairTool] };
		let turn = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				turn++;
				if (turn <= 3) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: assistantMessage(
							[
								turn === 2
									? {
											type: "toolCall",
											id: "repair-no-evidence",
											name: "repair_like",
											arguments: { target: "missing.txt" },
										}
									: {
											type: "toolCall",
											id: `target-no-evidence-${turn}`,
											name: "read_like",
											arguments: { path: "missing.txt" },
										},
							],
							"toolUse",
						),
					});
					return;
				}
				stream.push({
					type: "done",
					reason: "stop",
					message: assistantMessage([{ type: "text", text: "done" }], "stop"),
				});
			});
			return stream;
		};
		const events = await drain(
			agentLoop(
				[{ role: "user", content: "go", timestamp: 1 }],
				context,
				{
					model: createModel(),
					convertToLlm: identityConverter,
					afterToolCall: async ({ toolCall }) =>
						toolCall.name === "repair_like" ? { details: { repaired: true } } : undefined,
				},
				undefined,
				streamFn,
			),
		);

		// Nothing succeeded between the two attempts, so the world never moved and the replay is refused.
		expect(targetExecutions).toBe(1);
		expect(
			events.some(
				(event) =>
					event.type === "tool_execution_end" &&
					event.toolCallId === "target-no-evidence-3" &&
					resultContainsFailureCode(event.result, "repeated_failed_operation"),
			),
		).toBe(true);
	});

	it("teaches only declared recovery actions from the loaded tool surface", async () => {
		const targetSchema = Type.Object({ path: Type.String() });
		const repairSchema = Type.Object({ target: Type.String() });
		const targetKind = "test.file.exists";
		const targetTool: AgentTool<typeof targetSchema> = {
			name: "read_like",
			label: "Read-like",
			description: "Read a path",
			parameters: targetSchema,
			failureRecovery: {
				getFailureTargets: (params) => [
					{ authority: TEST_RECOVERY_AUTHORITY, kind: targetKind, scope: params.path },
				],
			},
			async execute() {
				throw new Error("ENOENT: no such file or directory, open 'missing.txt'");
			},
		};
		const loadedRepairTool: AgentTool<typeof repairSchema> = {
			name: "loaded_repair",
			label: "Loaded repair",
			description: "Repair a target",
			parameters: repairSchema,
			failureRecovery: {
				actions: [
					{
						kind: "repair",
						authority: TEST_RECOVERY_AUTHORITY,
						targetKind,
						instruction: "Create the missing target with loaded_repair.",
					},
				],
			},
			async execute() {
				return { content: [{ type: "text", text: "unused" }], details: {} };
			},
		};
		const context: AgentContext = { systemPrompt: "base", messages: [], tools: [targetTool, loadedRepairTool] };
		const providerPrompts: string[] = [];
		let turn = 0;
		await drain(
			agentLoop(
				[{ role: "user", content: "go", timestamp: 1 }],
				context,
				{ model: createModel(), convertToLlm: identityConverter },
				undefined,
				(_model, providerContext) => {
					providerPrompts.push(promptWithLedger(providerContext));
					const stream = new MockAssistantStream();
					queueMicrotask(() => {
						turn++;
						stream.push({
							type: "done",
							reason: turn === 1 ? "toolUse" : "stop",
							message:
								turn === 1
									? assistantMessage(
											[
												{
													type: "toolCall",
													id: "teach-target",
													name: "read_like",
													arguments: { path: "missing.txt" },
												},
											],
											"toolUse",
										)
									: assistantMessage([{ type: "text", text: "done" }], "stop"),
						});
					});
					return stream;
				},
			),
		);

		expect(providerPrompts[1]).toContain("Create the missing target with loaded_repair.");
		expect(providerPrompts[1]).not.toContain("list the parent directory or re-read the path");
		expect(providerPrompts[1]).not.toContain("unloaded_repair");
	});

	it("does not teach an action owned by a different backend authority", async () => {
		const schema = Type.Object({ path: Type.String() });
		const otherAuthority = createAgentToolFailureRecoveryAuthority();
		const targetTool: AgentTool<typeof schema> = {
			name: "read_like",
			label: "Read-like",
			description: "Read a path",
			parameters: schema,
			failureRecovery: {
				getFailureTargets: (params) => [
					{ authority: TEST_RECOVERY_AUTHORITY, kind: "test.file.exists", scope: params.path },
				],
			},
			async execute() {
				throw new Error("ENOENT: no such file or directory, open 'missing.txt'");
			},
		};
		const otherBackendTool: AgentTool<typeof schema> = {
			name: "other_backend",
			label: "Other backend",
			description: "Repairs a different backend",
			parameters: schema,
			failureRecovery: {
				actions: [
					{
						kind: "repair",
						authority: otherAuthority,
						targetKind: "test.file.exists",
						instruction: "Repair with the other backend.",
					},
				],
			},
			async execute() {
				return { content: [{ type: "text", text: "unused" }], details: {} };
			},
		};
		const malformedContractTool: AgentTool<typeof schema> = {
			name: "malformed_contract",
			label: "Malformed contract",
			description: "Exposes a broken recovery contract",
			parameters: schema,
			async execute() {
				return { content: [{ type: "text", text: "unused" }], details: {} };
			},
		};
		Object.defineProperty(malformedContractTool, "failureRecovery", {
			get() {
				throw new Error("broken recovery contract getter");
			},
		});
		const providerPrompts: string[] = [];
		let turn = 0;
		await drain(
			agentLoop(
				[{ role: "user", content: "go", timestamp: 1 }],
				{
					systemPrompt: "base",
					messages: [],
					tools: [targetTool, otherBackendTool, malformedContractTool],
				},
				{ model: createModel(), convertToLlm: identityConverter },
				undefined,
				(_model, providerContext) => {
					providerPrompts.push(promptWithLedger(providerContext));
					const stream = new MockAssistantStream();
					queueMicrotask(() => {
						turn++;
						stream.push({
							type: "done",
							reason: turn === 1 ? "toolUse" : "stop",
							message:
								turn === 1
									? assistantMessage(
											[
												{
													type: "toolCall",
													id: "no-action-target",
													name: "read_like",
													arguments: { path: "missing.txt" },
												},
											],
											"toolUse",
										)
									: assistantMessage([{ type: "text", text: "done" }], "stop"),
						});
					});
					return stream;
				},
			),
		);

		expect(providerPrompts[1]).toContain(
			"The operation is readmitted after another tool succeeds or a new user turn",
		);
		expect(providerPrompts[1]).not.toContain("Repair with the other backend.");
		expect(providerPrompts[1]).not.toContain("list the parent directory or re-read the path");
	});

	it("lets the runaway backstop catch an endless repair/replay alternation", async () => {
		const targetSchema = Type.Object({ path: Type.String() });
		const recoverySchema = Type.Object({ target: Type.String() });
		const targetKind = "test.file.exists";
		let targetExecutions = 0;
		let recoveryExecutions = 0;
		const targetTool: AgentTool<typeof targetSchema> = {
			name: "read_like",
			label: "Read-like",
			description: "Read a path",
			parameters: targetSchema,
			failureRecovery: {
				getFailureTargets: (params) => [
					{ authority: TEST_RECOVERY_AUTHORITY, kind: targetKind, scope: params.path },
				],
			},
			async execute() {
				targetExecutions++;
				throw new Error("ENOENT: no such file or directory, open 'missing.txt'");
			},
		};
		const recoveryTool: AgentTool<typeof recoverySchema, { repaired: boolean }> = {
			name: "repair_like",
			label: "Repair-like",
			description: "Attempt a repair",
			parameters: recoverySchema,
			failureRecovery: {
				actions: [
					{
						kind: "repair",
						authority: TEST_RECOVERY_AUTHORITY,
						targetKind,
						instruction: "Attempt the declared repair.",
					},
				],
			},
			async execute() {
				recoveryExecutions++;
				return { content: [{ type: "text", text: "repair attempted" }], details: { repaired: true } };
			},
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [targetTool, recoveryTool] };
		const stalls: Array<{ reason: string }> = [];
		let turns = 0;
		let deliveryTurns = 0;
		const streamFn = (_model: unknown, providerContext: { tools?: readonly unknown[] }) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (completeMandatoryDelivery(stream, providerContext)) {
					deliveryTurns++;
					return;
				}
				turns++;
				// Unbounded on purpose: nothing in this stream ever stops, so only a backstop can end it.
				if (turns > 0) {
					const recoveryTurn = turns % 2 === 0;
					stream.push({
						type: "done",
						reason: "toolUse",
						message: assistantMessage(
							[
								recoveryTurn
									? {
											type: "toolCall",
											id: `recovery-${turns}`,
											name: "repair_like",
											arguments: { target: "missing.txt" },
										}
									: {
											type: "toolCall",
											id: `target-${turns}`,
											name: "read_like",
											arguments: { path: "missing.txt" },
										},
							],
							"toolUse",
						),
					});
					return;
				}
				stream.push({
					type: "done",
					reason: "stop",
					message: assistantMessage([{ type: "text", text: "should not be reached" }], "stop"),
				});
			});
			return stream;
		};
		const events = await drain(
			agentLoop(
				[{ role: "user", content: "go", timestamp: 1 }],
				context,
				{
					model: createModel(),
					convertToLlm: identityConverter,
					maxStallTurns: 4,
					onRunawayStop: (info) => stalls.push(info),
				},
				undefined,
				streamFn,
			),
		);

		// Each successful repair genuinely moves the world, so each replay is genuinely admitted. That
		// is correct per call and still unproductive in aggregate, which is exactly what the cost guard
		// is for — after four complete two-operation cycles, not merely four sightings of one member.
		expect(turns).toBe(8);
		expect(deliveryTurns).toBe(1);
		expect(targetExecutions).toBe(4);
		expect(recoveryExecutions).toBe(4);
		expect(stalls).toMatchObject([{ reason: "repeated_tool_call" }]);
		expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
	});

	it("refuses repeated replays without ending the run when the stall detector is disabled", async () => {
		const schema = Type.Object({ path: Type.String() });
		let executions = 0;
		const failingTool: AgentTool<typeof schema> = {
			name: "read_like",
			label: "Read-like",
			description: "Read a path",
			parameters: schema,
			async execute() {
				executions++;
				throw new Error("ENOENT: no such file or directory, open 'missing.txt'");
			},
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [failingTool] };
		let turns = 0;
		let deliveryTurns = 0;
		const streamFn = (_model: unknown, providerContext: { tools?: readonly unknown[] }) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (completeMandatoryDelivery(stream, providerContext)) {
					deliveryTurns++;
					return;
				}
				turns++;
				if (turns <= 8) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: assistantMessage(
							[
								{
									type: "toolCall",
									id: `blocked-${turns}`,
									name: "read_like",
									arguments: { path: "missing.txt" },
								},
							],
							"toolUse",
						),
					});
					return;
				}
				stream.push({
					type: "done",
					reason: "stop",
					message: assistantMessage([{ type: "text", text: "should not be reached" }], "stop"),
				});
			});
			return stream;
		};
		const events = await drain(
			agentLoop(
				[{ role: "user", content: "go", timestamp: 1 }],
				context,
				{ model: createModel(), convertToLlm: identityConverter, maxStallTurns: 0 },
				undefined,
				streamFn,
			),
		);

		// With every backstop off, the gate refuses all seven replays and executes none of them, and the
		// run still reaches the model's own closing turn rather than being cut short by the harness.
		expect(turns).toBe(9);
		expect(deliveryTurns).toBe(0);
		expect(executions).toBe(1);
		expect(
			events.filter(
				(event) =>
					event.type === "tool_execution_end" &&
					resultContainsFailureCode(event.result, "repeated_failed_operation"),
			),
		).toHaveLength(7);
		expect(
			events.some(
				(event) =>
					event.type === "message_end" &&
					event.message.role === "assistant" &&
					event.message.content.some((block) => block.type === "text" && block.text === "should not be reached"),
			),
		).toBe(true);
		expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
	});

	it("does not block distinct failed operations because they share a failure family", async () => {
		const schema = Type.Object({ path: Type.String() });
		let executions = 0;
		const failingTool: AgentTool<typeof schema> = {
			name: "read_like",
			label: "Read-like",
			description: "Read a path",
			parameters: schema,
			async execute(_id, params) {
				executions++;
				throw new Error(`ENOENT: no such file or directory, open '${params.path}'`);
			},
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [failingTool] };
		let turns = 0;
		let deliveryTurns = 0;
		const streamFn = (_model: unknown, providerContext: { tools?: readonly unknown[] }) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (completeMandatoryDelivery(stream, providerContext)) {
					deliveryTurns++;
					return;
				}
				turns++;
				if (turns <= 10) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: assistantMessage(
							[
								{
									type: "toolCall",
									id: `varied-${turns}`,
									name: "read_like",
									arguments: { path: `missing-${turns}.txt` },
								},
							],
							"toolUse",
						),
					});
					return;
				}
				stream.push({
					type: "done",
					reason: "stop",
					message: assistantMessage([{ type: "text", text: "should not be reached" }], "stop"),
				});
			});
			return stream;
		};
		const events = await drain(
			agentLoop(
				[{ role: "user", content: "go", timestamp: 1 }],
				context,
				{ model: createModel(), convertToLlm: identityConverter, maxStallTurns: 0 },
				undefined,
				streamFn,
			),
		);

		expect(turns).toBe(11);
		expect(deliveryTurns).toBe(0);
		expect(executions).toBe(10);
		expect(
			events.some(
				(event) =>
					event.type === "tool_execution_end" && resultContainsFailureCode(event.result, "recovery_exhausted"),
			),
		).toBe(false);
		expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
	});

	it("does not accumulate an edit failure family across successful edits", async () => {
		const schema = Type.Object({ path: Type.String(), fail: Type.Boolean() });
		let executions = 0;
		const editLikeTool: AgentTool<typeof schema> = {
			name: "edit",
			label: "Edit-like",
			description: "Apply one focused replacement",
			parameters: schema,
			async execute(_id, params) {
				executions++;
				if (params.fail) throw new Error(`Old text not found in ${params.path}`);
				return { content: [{ type: "text", text: `edited ${params.path}` }], details: { phase: "edited" } };
			},
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [editLikeTool] };
		let turns = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				turns++;
				if (turns <= 8) {
					const fail = turns % 2 === 1;
					stream.push({
						type: "done",
						reason: "toolUse",
						message: assistantMessage(
							[
								{
									type: "toolCall",
									id: `edit-${turns}`,
									name: "edit",
									arguments: { path: `file-${turns}.ts`, fail },
								},
							],
							"toolUse",
						),
					});
					return;
				}
				stream.push({
					type: "done",
					reason: "stop",
					message: assistantMessage([{ type: "text", text: "all edits complete" }], "stop"),
				});
			});
			return stream;
		};

		const events = await drain(
			agentLoop(
				[{ role: "user", content: "apply the edit sequence", timestamp: 1 }],
				context,
				{ model: createModel(), convertToLlm: identityConverter, maxStallTurns: 0 },
				undefined,
				streamFn,
			),
		);

		expect(turns).toBe(9);
		expect(executions).toBe(8);
		expect(
			events.some(
				(event) =>
					event.type === "tool_execution_end" && resultContainsFailureCode(event.result, "recovery_exhausted"),
			),
		).toBe(false);
		expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
	});

	it("does not block distinct policy rejections as a shared failure family", async () => {
		let executions = 0;
		let beforeCalls = 0;
		const guardedTool = createEchoTool(() => executions++);
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [guardedTool] };
		let turns = 0;
		let deliveryTurns = 0;
		const streamFn = (_model: unknown, providerContext: { tools?: readonly unknown[] }) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (completeMandatoryDelivery(stream, providerContext)) {
					deliveryTurns++;
					return;
				}
				turns++;
				if (turns <= 10) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: assistantMessage(
							[
								{
									type: "toolCall",
									id: `policy-${turns}`,
									name: "echo",
									arguments: { value: `forbidden-${turns}` },
								},
							],
							"toolUse",
						),
					});
					return;
				}
				stream.push({
					type: "done",
					reason: "stop",
					message: assistantMessage([{ type: "text", text: "should not be reached" }], "stop"),
				});
			});
			return stream;
		};
		const events = await drain(
			agentLoop(
				[{ role: "user", content: "go", timestamp: 1 }],
				context,
				{
					model: createModel(),
					convertToLlm: identityConverter,
					maxStallTurns: 0,
					beforeToolCall: async () => {
						beforeCalls++;
						return { block: true, reason: "fixture policy rejection" };
					},
				},
				undefined,
				streamFn,
			),
		);

		expect(turns).toBe(11);
		expect(deliveryTurns).toBe(0);
		expect(beforeCalls).toBe(10);
		expect(executions).toBe(0);
		expect(
			events.some(
				(event) =>
					event.type === "tool_execution_end" && resultContainsFailureCode(event.result, "recovery_exhausted"),
			),
		).toBe(false);
		expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
	});

	it("does not impose a run-wide failure count on distinct operations", async () => {
		const schema = Type.Object({ attempt: Type.Number() });
		let executions = 0;
		const failingTool: AgentTool<typeof schema> = {
			name: "variable_failure",
			label: "Variable failure",
			description: "Fail with a different classified code",
			parameters: schema,
			async execute(_id, params) {
				executions++;
				throw new Error(`EFAIL_${params.attempt}: distinct fixture failure`);
			},
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [failingTool] };
		let turns = 0;
		let deliveryTurns = 0;
		const streamFn = (_model: unknown, providerContext: { tools?: readonly unknown[] }) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (completeMandatoryDelivery(stream, providerContext)) {
					deliveryTurns++;
					return;
				}
				turns++;
				if (turns <= 80) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: assistantMessage(
							[
								{
									type: "toolCall",
									id: `diverse-${turns}`,
									name: "variable_failure",
									arguments: { attempt: turns },
								},
							],
							"toolUse",
						),
					});
					return;
				}
				stream.push({
					type: "done",
					reason: "stop",
					message: assistantMessage([{ type: "text", text: "should not be reached" }], "stop"),
				});
			});
			return stream;
		};
		const events = await drain(
			agentLoop(
				[{ role: "user", content: "go", timestamp: 1 }],
				context,
				{ model: createModel(), convertToLlm: identityConverter, maxStallTurns: 0 },
				undefined,
				streamFn,
			),
		);

		expect(turns).toBe(81);
		expect(deliveryTurns).toBe(0);
		expect(executions).toBe(80);
		expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
	});

	it("keeps one policy-authorized identical timeout retry available", async () => {
		let executions = 0;
		const recoveringTool = createEchoTool(() => {
			executions++;
		});
		recoveringTool.execute = async (_id, params) => {
			executions++;
			if (executions < 2) throw new Error("ETIMEDOUT: transient fixture");
			return { content: [{ type: "text", text: `echoed: ${params.value}` }], details: { value: params.value } };
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [recoveringTool] };
		const stalls: Array<{ signature: string; repeats: number }> = [];
		let responses = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				responses++;
				if (responses <= 2) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: assistantMessage(
							[{ type: "toolCall", id: `retry-${responses}`, name: "echo", arguments: { value: "same" } }],
							"toolUse",
						),
					});
					return;
				}
				stream.push({
					type: "done",
					reason: "stop",
					message: assistantMessage([{ type: "text", text: "recovered" }], "stop"),
				});
			});
			return stream;
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			maxStallTurns: 12,
			onRunawayStop: (info) => stalls.push(info),
		};

		const events = await drain(
			agentLoop([{ role: "user", content: "go", timestamp: 1 }], context, config, undefined, streamFn),
		);

		expect(executions).toBe(2);
		expect(stalls).toHaveLength(0);
		expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
	});

	it("teaches when the timeout retry is available and when it is exhausted", async () => {
		const timingOutTool = createEchoTool();
		timingOutTool.execute = async () => {
			throw new Error("ETIMEDOUT: transient fixture");
		};
		const providerPrompts: string[] = [];
		let turn = 0;
		const streamFn = (_model: unknown, providerContext: { systemPrompt?: string }) => {
			providerPrompts.push(promptWithLedger(providerContext));
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				turn++;
				stream.push({
					type: "done",
					reason: turn <= 2 ? "toolUse" : "stop",
					message:
						turn <= 2
							? assistantMessage(
									[
										{
											type: "toolCall",
											id: `timeout-guidance-${turn}`,
											name: "echo",
											arguments: { value: "same" },
										},
									],
									"toolUse",
								)
							: assistantMessage([{ type: "text", text: "done" }], "stop"),
				});
			});
			return stream;
		};
		await drain(
			agentLoop(
				[{ role: "user", content: "go", timestamp: 1 }],
				{ systemPrompt: "", messages: [], tools: [timingOutTool] },
				{ model: createModel(), convertToLlm: identityConverter },
				undefined,
				streamFn,
			),
		);

		expect(providerPrompts[1]).toContain("This failure class allows 1 immediate unchanged retry");
		expect(providerPrompts[2]).toContain("Unchanged retry spent");
	});

	it("reserves one timeout retry across parallel duplicates and blocks the excess call", async () => {
		let executions = 0;
		const timingOutTool = createEchoTool();
		timingOutTool.execute = async () => {
			executions++;
			throw new Error("ETIMEDOUT: transient fixture");
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [timingOutTool] };
		let turn = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				turn++;
				if (turn <= 2) {
					const callCount = turn === 1 ? 1 : 2;
					stream.push({
						type: "done",
						reason: "toolUse",
						message: assistantMessage(
							Array.from({ length: callCount }, (_, index) => ({
								type: "toolCall" as const,
								id: `timeout-${turn}-${index}`,
								name: "echo",
								arguments: { value: "same" },
							})),
							"toolUse",
						),
					});
					return;
				}
				stream.push({
					type: "done",
					reason: "stop",
					message: assistantMessage([{ type: "text", text: "done" }], "stop"),
				});
			});
			return stream;
		};
		const events = await drain(
			agentLoop(
				[{ role: "user", content: "go", timestamp: 1 }],
				context,
				{ model: createModel(), convertToLlm: identityConverter, toolExecution: "parallel" },
				undefined,
				streamFn,
			),
		);

		expect(executions).toBe(2);
		expect(
			events.filter(
				(event) =>
					event.type === "tool_execution_end" &&
					resultContainsFailureCode(event.result, "repeated_failed_operation"),
			),
		).toHaveLength(1);
	});

	it("accounts parallel failures in bounded waves before launching more work", async () => {
		const schema = Type.Object({ path: Type.String() });
		let executions = 0;
		let inFlight = 0;
		let maxInFlight = 0;
		const failingTool: AgentTool<typeof schema> = {
			name: "read_like",
			label: "Read-like",
			description: "Read a path",
			parameters: schema,
			async execute(_id, params) {
				executions++;
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				try {
					await Promise.resolve();
					throw new Error(`ENOENT: no such file or directory, open '${params.path}'`);
				} finally {
					inFlight--;
				}
			},
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [failingTool] };
		let turns = 0;
		let deliveryTurns = 0;
		const streamFn = (_model: unknown, providerContext: { tools?: readonly unknown[] }) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (completeMandatoryDelivery(stream, providerContext)) {
					deliveryTurns++;
					return;
				}
				turns++;
				if (turns > 1) {
					stream.push({
						type: "done",
						reason: "stop",
						message: assistantMessage([{ type: "text", text: "done" }], "stop"),
					});
					return;
				}
				stream.push({
					type: "done",
					reason: "toolUse",
					message: assistantMessage(
						Array.from({ length: 10 }, (_, index) => ({
							type: "toolCall" as const,
							id: `parallel-varied-${index}`,
							name: "read_like",
							arguments: { path: `missing-${index}.txt` },
						})),
						"toolUse",
					),
				});
			});
			return stream;
		};
		const events = await drain(
			agentLoop(
				[{ role: "user", content: "go", timestamp: 1 }],
				context,
				{
					model: createModel(),
					convertToLlm: identityConverter,
					maxStallTurns: 0,
					toolExecution: "parallel",
				},
				undefined,
				streamFn,
			),
		);
		const pairedResultIds = events.flatMap((event) =>
			event.type === "message_end" && event.message.role === "toolResult" ? [event.message.toolCallId] : [],
		);

		expect(turns).toBe(2);
		expect(deliveryTurns).toBe(0);
		expect(executions).toBe(10);
		expect(maxInFlight).toBe(4);
		expect(pairedResultIds).toEqual(Array.from({ length: 10 }, (_, index) => `parallel-varied-${index}`));
		expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
	});

	it("applies parallel gate outcomes in assistant-call order", async () => {
		const schema = Type.Object({ value: Type.String() });
		const targetKind = "test.resource.ready";
		let targetExecutions = 0;
		let releaseFirstFailure: (() => void) | undefined;
		const firstFailureMayFinish = new Promise<void>((resolve) => {
			releaseFirstFailure = resolve;
		});
		const targetTool: AgentTool<typeof schema> = {
			name: "target",
			label: "Target",
			description: "Target operation",
			parameters: schema,
			failureRecovery: {
				getFailureTargets: (params) => [
					{ authority: TEST_RECOVERY_AUTHORITY, kind: targetKind, scope: params.value },
				],
			},
			async execute() {
				targetExecutions++;
				if (targetExecutions === 1) {
					await firstFailureMayFinish;
					throw new Error("ENOENT: no such file or directory, open 'target.txt'");
				}
				return { content: [{ type: "text", text: "target recovered" }], details: {} };
			},
		};
		const recoveryTool: AgentTool<typeof schema, { repaired: boolean }> = {
			name: "recovery",
			label: "Recovery",
			description: "Recovery operation",
			parameters: schema,
			failureRecovery: {
				actions: [
					{
						kind: "repair",
						authority: TEST_RECOVERY_AUTHORITY,
						targetKind,
						instruction: "Repair the matching resource.",
					},
				],
			},
			async execute() {
				setTimeout(() => releaseFirstFailure?.(), 0);
				return { content: [{ type: "text", text: "recovery complete" }], details: { repaired: true } };
			},
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [targetTool, recoveryTool] };
		let turn = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				turn++;
				if (turn === 1) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: assistantMessage(
							[
								{ type: "toolCall", id: "target-1", name: "target", arguments: { value: "same" } },
								{ type: "toolCall", id: "recovery-1", name: "recovery", arguments: { value: "same" } },
							],
							"toolUse",
						),
					});
					return;
				}
				if (turn === 2) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: assistantMessage(
							[{ type: "toolCall", id: "target-2", name: "target", arguments: { value: "same" } }],
							"toolUse",
						),
					});
					return;
				}
				stream.push({
					type: "done",
					reason: "stop",
					message: assistantMessage([{ type: "text", text: "done" }], "stop"),
				});
			});
			return stream;
		};
		const events = await drain(
			agentLoop(
				[{ role: "user", content: "go", timestamp: 1 }],
				context,
				{ model: createModel(), convertToLlm: identityConverter, toolExecution: "parallel" },
				undefined,
				streamFn,
			),
		);

		expect(targetExecutions).toBe(2);
		expect(
			events.find((event) => event.type === "tool_execution_end" && event.toolCallId === "target-2"),
		).toMatchObject({
			type: "tool_execution_end",
			isError: false,
		});
	});

	it("allows a materially changed operation after a deterministic failure", async () => {
		const schema = Type.Object({ path: Type.String() });
		let executions = 0;
		const readLike: AgentTool<typeof schema> = {
			name: "read_like",
			label: "Read-like",
			description: "Read a path",
			parameters: schema,
			async execute(_id, params) {
				executions++;
				if (params.path === "missing.txt") throw new Error("ENOENT: no such file or directory, open 'missing.txt'");
				return { content: [{ type: "text", text: "recovered" }], details: {} };
			},
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [readLike] };
		let responses = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				responses++;
				if (responses <= 2) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: assistantMessage(
							[
								{
									type: "toolCall",
									id: `changed-${responses}`,
									name: "read_like",
									arguments: { path: responses === 1 ? "missing.txt" : "present.txt" },
								},
							],
							"toolUse",
						),
					});
					return;
				}
				stream.push({
					type: "done",
					reason: "stop",
					message: assistantMessage([{ type: "text", text: "done" }], "stop"),
				});
			});
			return stream;
		};

		await drain(
			agentLoop(
				[{ role: "user", content: "go", timestamp: 1 }],
				context,
				{ model: createModel(), convertToLlm: identityConverter },
				undefined,
				streamFn,
			),
		);

		expect(executions).toBe(2);
	});

	it("stops a repeated two-tool cycle after three unchanged result periods", async () => {
		const emptySchema = Type.Object({});
		let executions = 0;
		const goalStatusTool: AgentTool<typeof emptySchema> = {
			name: "goal_status",
			label: "Goal status",
			description: "Read goal status",
			parameters: emptySchema,
			async execute() {
				executions++;
				return { content: [{ type: "text", text: "goal unchanged" }], details: {} };
			},
		};
		const taskStatusTool: AgentTool<typeof emptySchema> = {
			name: "task_status",
			label: "Task status",
			description: "Read task status",
			parameters: emptySchema,
			async execute() {
				executions++;
				return { content: [{ type: "text", text: "tasks unchanged" }], details: {} };
			},
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [goalStatusTool, taskStatusTool] };
		const stops: Array<{ reason: string; signature: string; repeats: number }> = [];
		let providerTurns = 0;
		let deliveryTurns = 0;
		const streamFn = (_model: unknown, providerContext: { tools?: readonly unknown[] }) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (completeMandatoryDelivery(stream, providerContext)) {
					deliveryTurns++;
					return;
				}
				providerTurns++;
				const toolName = providerTurns % 2 === 1 ? "goal_status" : "task_status";
				stream.push({
					type: "done",
					reason: "toolUse",
					message: assistantMessage(
						[{ type: "toolCall", id: `status-${providerTurns}`, name: toolName, arguments: {} }],
						"toolUse",
					),
				});
			});
			return stream;
		};

		const events = await drain(
			agentLoop(
				[{ role: "user", content: "finish the goal", timestamp: 1 }],
				context,
				{
					model: createModel(),
					convertToLlm: identityConverter,
					maxStallTurns: 12,
					onRunawayStop: (info) => stops.push(info),
				},
				undefined,
				streamFn,
			),
		);

		expect(executions).toBe(6);
		expect(providerTurns).toBe(6);
		expect(deliveryTurns).toBe(1);
		expect(stops).toMatchObject([{ reason: "stagnant_tool_cycle", repeats: 3 }]);
		expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
	});

	it("allows a repeated tool-call cycle whose results change before the coarse fuse", async () => {
		const emptySchema = Type.Object({});
		let executions = 0;
		const changingTool = (name: string): AgentTool<typeof emptySchema> => ({
			name,
			label: name,
			description: "Read changing status",
			parameters: emptySchema,
			async execute() {
				executions++;
				return { content: [{ type: "text", text: `status version ${executions}` }], details: {} };
			},
		});
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [changingTool("goal_status"), changingTool("task_status")],
		};
		const stops: Array<{ reason: string; signature: string; repeats: number }> = [];
		let providerTurns = 0;
		let deliveryTurns = 0;
		const streamFn = (_model: unknown, providerContext: { tools?: readonly unknown[] }) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (completeMandatoryDelivery(stream, providerContext)) {
					deliveryTurns++;
					return;
				}
				providerTurns++;
				if (providerTurns > 8) {
					stream.push({
						type: "done",
						reason: "stop",
						message: assistantMessage([{ type: "text", text: "status advanced" }], "stop"),
					});
					return;
				}
				const toolName = providerTurns % 2 === 1 ? "goal_status" : "task_status";
				stream.push({
					type: "done",
					reason: "toolUse",
					message: assistantMessage(
						[{ type: "toolCall", id: `changing-${providerTurns}`, name: toolName, arguments: {} }],
						"toolUse",
					),
				});
			});
			return stream;
		};

		const events = await drain(
			agentLoop(
				[{ role: "user", content: "watch progress", timestamp: 1 }],
				context,
				{
					model: createModel(),
					convertToLlm: identityConverter,
					maxStallTurns: 12,
					onRunawayStop: (info) => stops.push(info),
				},
				undefined,
				streamFn,
			),
		);

		expect(executions).toBe(8);
		expect(deliveryTurns).toBe(0);
		expect(stops).toEqual([]);
		expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
	});

	it("retains the configured coarse fuse for an indefinitely changing result", async () => {
		const emptySchema = Type.Object({});
		let executions = 0;
		const changingTool: AgentTool<typeof emptySchema> = {
			name: "changing_status",
			label: "Changing status",
			description: "Return a new visible status every time",
			parameters: emptySchema,
			async execute() {
				executions++;
				return { content: [{ type: "text", text: `status version ${executions}` }], details: {} };
			},
		};
		const stops: Array<{ reason: string; signature: string; repeats: number }> = [];
		let providerTurns = 0;
		const streamFn = (_model: unknown, providerContext: { tools?: readonly unknown[] }) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (completeMandatoryDelivery(stream, providerContext)) return;
				providerTurns++;
				stream.push({
					type: "done",
					reason: "toolUse",
					message: assistantMessage(
						[
							{
								type: "toolCall",
								id: `changing-status-${providerTurns}`,
								name: "changing_status",
								arguments: {},
							},
						],
						"toolUse",
					),
				});
			});
			return stream;
		};

		await drain(
			agentLoop(
				[{ role: "user", content: "watch forever", timestamp: 1 }],
				{ systemPrompt: "", messages: [], tools: [changingTool] },
				{
					model: createModel(),
					convertToLlm: identityConverter,
					maxStallTurns: 4,
					onRunawayStop: (info) => stops.push(info),
				},
				undefined,
				streamFn,
			),
		);

		expect(executions).toBe(4);
		expect(stops).toMatchObject([{ reason: "repeated_tool_call", repeats: 4 }]);
	});

	it("trips on a period-3 oscillation A→B→C→A→… (bug #28)", async () => {
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [echoTool] };
		const stalls: Array<{ signature: string; repeats: number }> = [];
		let n = 0;
		const cycle = ["A", "B", "C"];

		// A 3-state cycle never repeats back-to-back, so a small window must span enough periods to see
		// state. The L×4 window must still catch it.
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const value = cycle[n % 3];
				n++;
				stream.push({
					type: "done",
					reason: "toolUse",
					message: assistantMessage(
						[{ type: "toolCall", id: `t${n}`, name: "echo", arguments: { value } }],
						"toolUse",
					),
				});
			});
			return stream;
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			maxStallTurns: 4,
			onRunawayStop: (info) => stalls.push(info),
		};

		const events = await drain(
			agentLoop([{ role: "user", content: "go", timestamp: 1 }], context, config, undefined, streamFn),
		);

		expect(stalls).toHaveLength(1); // periodic oscillation is caught, not just back-to-back repeats
		expect(events.filter((e) => e.type === "agent_end")).toHaveLength(1);
	});
});
