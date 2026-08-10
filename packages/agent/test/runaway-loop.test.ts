import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Message } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

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

function assistantMessage(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]) {
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

async function drain(stream: ReturnType<typeof agentLoop>) {
	const events: AgentEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("runaway-loop backstop", () => {
	it("stops a loop that repeats the identical tool call, firing onRunawayStop", async () => {
		let executions = 0;
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [createEchoTool(() => executions++)],
		};
		let toolCalls = 0;
		const stalls: Array<{ signature: string; repeats: number }> = [];

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

		// Backstop tripped exactly at the limit and ended the run.
		expect(stalls).toHaveLength(1);
		expect(stalls[0].repeats).toBe(4);
		expect(toolCalls).toBe(4); // did not run beyond the limit
		expect(executions).toBe(1); // repeated phone calls teach without replaying the successful operation
		const rejectedRepeats = events.filter((event) => event.type === "tool_execution_end" && event.isError);
		expect(rejectedRepeats).toHaveLength(3);
		for (const event of rejectedRepeats) {
			if (event.type !== "tool_execution_end") throw new Error("Expected tool_execution_end");
			const text =
				event.result.content.find((block: { type: string; text?: string }) => block.type === "text")?.text ?? "";
			expect(text).toContain('"failure_code":"repeated_successful_call"');
			expect(text).toContain('"next_action":"Use the previous successful result and continue');
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
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
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
			maxStallTurns: 3,
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

		expect(executions).toBe(1);
		expect(toolEndMessages).toHaveLength(3);
		expect(toolEndMessages[1]).toContain('"failure_code":"repeated_failed_operation"');
		expect(stalls).toHaveLength(1);
		expect(stalls[0].repeats).toBe(3);
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

	it("trips on a period-3 oscillation A→B→C→A→… (bug #28)", async () => {
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [echoTool] };
		const stalls: Array<{ signature: string; repeats: number }> = [];
		let n = 0;
		const cycle = ["A", "B", "C"];

		// A 3-state cycle never repeats back-to-back, so a small 2×L window can't see L repeats of any one
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
