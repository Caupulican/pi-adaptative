import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Message } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { agentLoop } from "../src/agent-loop.ts";
import {
	createRepeatedToolFailureResult,
	createToolFailureMemoryTracker,
	createToolFailureOperationExhaustedResult,
	createToolFailureRecoveryExhaustedResult,
	createToolFailureResult,
	getUnresolvedToolFailure,
	rememberToolFailure,
	transcriptHasClosedToolOperation,
} from "../src/tool-failure-memory.ts";
import { ToolFailureRecoveryGate } from "../src/tool-failure-recovery-gate.ts";
import {
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
	AgentToolExecutionError,
	type AgentToolResult,
} from "../src/types.ts";

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

const emptyUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]) {
	return {
		role: "assistant" as const,
		content,
		api: "openai-responses" as const,
		provider: "openai",
		model: "mock",
		usage: emptyUsage,
		stopReason,
		timestamp: 1,
	} satisfies AssistantMessage;
}

function assistantCall(id: string, name: string, args: Record<string, unknown>): AssistantMessage {
	return assistantMessage([{ type: "toolCall", id, name, arguments: args }], "toolUse");
}

function toolResultMessage(id: string, name: string, result: AgentToolResult<unknown>, isError: boolean): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: result.content,
		details: result.details,
		isError,
		timestamp: 1,
	};
}

const listListsArgs = { action: "list_lists", envFile: "/tmp/trello.env" };
const trelloSchema = Type.Object({
	action: Type.String(),
	envFile: Type.Optional(Type.String()),
	boardId: Type.Optional(Type.String()),
});

function createTrelloTool(onExecute: () => void): AgentTool<typeof trelloSchema> {
	return {
		name: "trello",
		label: "Trello",
		description: "Trello",
		parameters: trelloSchema,
		async execute() {
			onExecute();
			throw new Error("boardId is required unless TRELLO_BOARD_ID");
		},
	};
}

function createExhaustedListListsTranscript(): AgentMessage[] {
	const tracker = new Map();
	const failed = rememberToolFailure(
		tracker,
		"trello",
		listListsArgs,
		"failed",
		"error",
		"Pass boardId from resolve_project_scope.",
		"boardId is required unless TRELLO_BOARD_ID",
	);
	const executed = createToolFailureResult(failed);
	const blocked = createRepeatedToolFailureResult(failed);
	const operationExhausted = createToolFailureOperationExhaustedResult(
		blocked.details.piToolFailureMemory,
		"Operation recovery circuit opened after 2 blocked replays of error.",
	);
	const runExhausted = createToolFailureRecoveryExhaustedResult(
		operationExhausted.details.piToolFailureMemory,
		"Run recovery circuit opened after replay of an operation whose local circuit was already open for error.",
	);
	return [
		{ role: "user", content: "review the QA card", timestamp: 1 },
		assistantCall("trello-1", "trello", listListsArgs),
		toolResultMessage("trello-1", "trello", executed, true),
		assistantCall("trello-2", "trello", listListsArgs),
		toolResultMessage("trello-2", "trello", blocked, true),
		assistantCall("trello-3", "trello", listListsArgs),
		toolResultMessage("trello-3", "trello", operationExhausted, true),
		assistantCall("trello-4", "trello", listListsArgs),
		toolResultMessage("trello-4", "trello", runExhausted, true),
	];
}

async function drain(stream: ReturnType<typeof agentLoop>) {
	const events: AgentEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

const identityConverter = (messages: AgentMessage[]): Message[] =>
	messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];

describe("tool-failure recovery restore", () => {
	it("halts only when an exact operation repeats the same tool code and output", () => {
		const schema = Type.Object({ command: Type.String() });
		const args = { command: "run focused tests" };
		const tool: AgentTool<typeof schema> = {
			name: "bash",
			label: "bash",
			description: "bash",
			parameters: schema,
			async execute() {
				throw new Error("must not execute during recovery-state testing");
			},
		};
		const applyPair = (secondCode: string, secondOutput: string) => {
			const tracker = new Map();
			const gate = new ToolFailureRecoveryGate();
			const first = rememberToolFailure(
				tracker,
				"bash",
				args,
				"failed",
				"exit_1",
				"Repair the workspace before retrying.",
				undefined,
				"execution",
				undefined,
				{ output: "FAILED tests.test_head_aim import error" },
			);
			expect(gate.apply({ kind: "failure", tool, record: first, args })).toBeUndefined();
			const second = rememberToolFailure(
				tracker,
				"bash",
				args,
				"failed",
				secondCode,
				"Repair the workspace before retrying.",
				undefined,
				"execution",
				undefined,
				{ output: secondOutput },
			);
			return gate.apply({ kind: "failure", tool, record: second, args });
		};

		expect(applyPair("exit_2", "FAILED tests.test_head_aim import error")).toBeUndefined();
		expect(applyPair("exit_1", "FAILED test_latest_is_uncalibrated_never_webcam")).toBeUndefined();
		expect(applyPair("exit_1", "FAILED tests.test_head_aim import error")).toMatchObject({
			diagnostic: "Recovery circuit opened after 2 failed outcomes for one operation.",
		});
	});

	it("restores changed outputs as separate recovery episodes", () => {
		const args = { command: "run focused tests" };
		const tracker = new Map();
		const outputs = [
			"FAILED tests.test_head_aim import error",
			"FAILED test_latest_is_uncalibrated_never_webcam",
			"FAILED test_right_turn_moves_aim_right",
		];
		const records = outputs.map((output) =>
			rememberToolFailure(
				tracker,
				"bash",
				args,
				"failed",
				"exit_1",
				"Repair the workspace before retrying.",
				undefined,
				"execution",
				undefined,
				{ output },
			),
		);
		const messages: AgentMessage[] = [
			assistantCall("bash-1", "bash", args),
			toolResultMessage("bash-1", "bash", createToolFailureResult(records[0]), true),
			assistantCall("bash-2", "bash", args),
			toolResultMessage("bash-2", "bash", createToolFailureResult(records[1]), true),
		];
		const gate = new ToolFailureRecoveryGate();
		gate.restoreFromMessages(JSON.parse(JSON.stringify(messages)) as AgentMessage[]);
		const tool: AgentTool = {
			name: "bash",
			label: "bash",
			description: "bash",
			parameters: Type.Object({ command: Type.String() }),
			async execute() {
				throw new Error("must not execute during recovery-state testing");
			},
		};

		expect(gate.apply({ kind: "failure", tool, record: records[2], args })).toBeUndefined();
		expect(gate.isHalted()).toBe(false);
	});

	it("returns a changed tool-owned output signature from an exact parallel replay to the agent", async () => {
		const schema = Type.Object({ command: Type.String() });
		let executions = 0;
		const tool: AgentTool<typeof schema> = {
			name: "bash",
			label: "bash",
			description: "bash",
			parameters: schema,
			async execute() {
				executions++;
				const outputSignature = executions === 1 ? "a".repeat(64) : "b".repeat(64);
				throw new AgentToolExecutionError(
					"same bounded shell preview\nCommand exited with code 1",
					"exit_1",
					outputSignature,
				);
			},
		};
		let providerTurns = 0;
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					providerTurns++;
					stream.push({
						type: "done",
						reason: providerTurns === 1 ? "toolUse" : "stop",
						message:
							providerTurns === 1
								? assistantMessage(
										[
											{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "test" } },
											{ type: "toolCall", id: "bash-2", name: "bash", arguments: { command: "test" } },
										],
										"toolUse",
									)
								: assistantMessage([{ type: "text", text: "continued with the new failure evidence" }], "stop"),
					});
				});
				return stream;
			},
			initialState: { model: createModel(), systemPrompt: "", tools: [tool] },
		});
		agent.maxStallTurns = 0;

		await agent.prompt("run the focused test");

		expect(executions).toBe(2);
		expect(providerTurns).toBe(2);
		expect(
			agent.state.messages.some(
				(message) =>
					message.role === "assistant" &&
					message.content.some(
						(block) => block.type === "text" && block.text === "continued with the new failure evidence",
					),
			),
		).toBe(true);
	});

	it("keeps corrective operations available after an edit-local recovery circuit opens", () => {
		const schema = Type.Object({ path: Type.String(), edits: Type.Array(Type.Object({ oldText: Type.String() })) });
		const args = { path: "subject.ts", edits: [{ oldText: "stale anchor" }] };
		const editTool: AgentTool<typeof schema> = {
			name: "edit",
			label: "edit",
			description: "edit",
			parameters: schema,
			failureRecovery: { exhaustionScope: "operation" },
			async execute() {
				throw new Error("must not execute during admission");
			},
		};
		const readTool: AgentTool = {
			name: "read",
			label: "read",
			description: "read",
			parameters: Type.Object({ path: Type.String() }),
			async execute() {
				return { content: [{ type: "text", text: "current text" }], details: {} };
			},
		};
		const tracker = new Map();
		const record = rememberToolFailure(
			tracker,
			"edit",
			args,
			"failed",
			"edit_old_text_not_found",
			"Read current text and submit changed exact anchors.",
		);
		const gate = new ToolFailureRecoveryGate();
		gate.apply({ kind: "failure", tool: editTool, record, args });

		expect(gate.admit(editTool, args, record)).toMatchObject({ kind: "blocked", exhausted: false });
		expect(gate.admit(editTool, args, record)).toMatchObject({
			kind: "blocked",
			exhausted: true,
			scope: "operation",
		});
		expect(gate.admit(editTool, args, record)).toMatchObject({
			kind: "blocked",
			exhausted: true,
			scope: "operation",
		});
		expect(gate.isHalted()).toBe(false);
		expect(gate.admit(readTool, { path: "subject.ts" }, undefined).kind).toBe("allowed");
	});

	it("keeps repeated edit validation failures local so a corrective read can still run", async () => {
		const editSchema = Type.Object({
			path: Type.String(),
			edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
		});
		const editTool: AgentTool<typeof editSchema> = {
			name: "edit",
			label: "edit",
			description: "edit",
			parameters: editSchema,
			failureRecovery: { exhaustionScope: "operation" },
			async execute() {
				throw new Error("invalid arguments must not execute");
			},
		};
		let reads = 0;
		const readTool: AgentTool = {
			name: "read",
			label: "read",
			description: "read",
			parameters: Type.Object({ path: Type.String() }),
			async execute() {
				reads++;
				return { content: [{ type: "text", text: "current source" }], details: {} };
			},
		};
		let turns = 0;
		await drain(
			agentLoop(
				[{ role: "user", content: "repair the stale edit", timestamp: 1 }],
				{ systemPrompt: "", messages: [], tools: [editTool, readTool] },
				{ model: createModel(), convertToLlm: identityConverter, maxStallTurns: 0 },
				undefined,
				() => {
					const stream = new MockAssistantStream();
					queueMicrotask(() => {
						turns++;
						const message =
							turns <= 4
								? assistantCall(`invalid-edit-${turns}`, "edit", {
										path: "subject.ts",
										edits: "not-an-array",
									})
								: turns === 5
									? assistantCall("corrective-read", "read", { path: "subject.ts" })
									: assistantMessage([{ type: "text", text: "current source recovered" }], "stop");
						stream.push({
							type: "done",
							reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
							message,
						});
					});
					return stream;
				},
			),
		);

		expect(turns).toBe(6);
		expect(reads).toBe(1);
	});

	it("delivers bounded tool-owned evidence from the failed execution", async () => {
		const schema = Type.Object({ path: Type.String() });
		const evidence = `Could not find oldText.\nCurrent source sha256 abcdef123456, lines 8-9:\n8 | current anchor`;
		const failingTool: AgentTool<typeof schema> = {
			name: "edit_like",
			label: "edit-like",
			description: "edit-like",
			parameters: schema,
			failureRecovery: {
				getFailureEvidence: (_params, failure) => failure.message,
			},
			async execute() {
				throw new Error(evidence);
			},
		};
		let providerTurns = 0;
		const providerPrompts: string[] = [];
		const events = await drain(
			agentLoop(
				[{ role: "user", content: "edit the file", timestamp: 1 }],
				{ systemPrompt: "", messages: [], tools: [failingTool] },
				{ model: createModel(), convertToLlm: identityConverter },
				undefined,
				(_model, providerContext) => {
					providerPrompts.push(providerContext.systemPrompt ?? "");
					const stream = new MockAssistantStream();
					queueMicrotask(() => {
						providerTurns++;
						stream.push({
							type: "done",
							reason: providerTurns === 1 ? "toolUse" : "stop",
							message:
								providerTurns === 1
									? assistantCall("edit-1", "edit_like", { path: "subject.ts" })
									: assistantMessage([{ type: "text", text: "I will use the current anchor." }], "stop"),
						});
					});
					return stream;
				},
			),
		);
		const failure = events.find((event) => event.type === "message_end" && event.message.role === "toolResult");
		if (!failure || failure.type !== "message_end" || failure.message.role !== "toolResult") {
			throw new Error("Expected failed tool result");
		}
		const text = failure.message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		expect(text).toContain('"evidence"');
		expect(text).toContain("Current source sha256 abcdef123456");
		expect(text).toContain("8 | current anchor");
		expect(providerPrompts[1]).toContain("Current source sha256 abcdef123456");
		expect(providerPrompts[1]).toContain("8 | current anchor");
	});

	it("blocks the exhausted identical operation after a JSON-roundtripped transcript", () => {
		const messages = JSON.parse(JSON.stringify(createExhaustedListListsTranscript())) as AgentMessage[];
		const gate = new ToolFailureRecoveryGate();
		gate.restoreFromMessages(messages);
		expect(gate.isEmpty()).toBe(false);
		expect(gate.isHalted()).toBe(false);
		expect(transcriptHasClosedToolOperation(messages)).toBe(true);

		const tool = createTrelloTool(() => {
			throw new Error("execute must not run");
		});
		const memory = createToolFailureMemoryTracker(messages);
		const admission = gate.admit(tool, listListsArgs, getUnresolvedToolFailure(memory, "trello", listListsArgs));
		expect(admission.kind).toBe("blocked");
		if (admission.kind !== "blocked") return;
		expect(admission.exhausted).toBe(true);
	});

	it("restores an edit-local closed circuit without turning it into a run halt", () => {
		const schema = Type.Object({ path: Type.String(), edits: Type.Array(Type.Object({ oldText: Type.String() })) });
		const args = { path: "subject.ts", edits: [{ oldText: "stale anchor" }] };
		const tracker = new Map();
		const record = rememberToolFailure(
			tracker,
			"edit",
			args,
			"failed",
			"edit_old_text_not_found",
			"Use current source to submit changed exact anchors.",
			undefined,
			"execution",
			"Current source sha256 abcdef123456, lines 8-9:\n8 | current anchor",
		);
		const closed = createToolFailureOperationExhaustedResult(record, "edit operation closed");
		const messages = JSON.parse(
			JSON.stringify([
				assistantCall("edit-closed", "edit", args),
				toolResultMessage("edit-closed", "edit", closed, true),
			]),
		) as AgentMessage[];
		const editTool: AgentTool<typeof schema> = {
			name: "edit",
			label: "edit",
			description: "edit",
			parameters: schema,
			failureRecovery: { exhaustionScope: "operation" },
			async execute() {
				throw new Error("must not execute during admission");
			},
		};
		const readTool: AgentTool = {
			name: "read",
			label: "read",
			description: "read",
			parameters: Type.Object({ path: Type.String() }),
			async execute() {
				return { content: [{ type: "text", text: "current text" }], details: {} };
			},
		};
		const gate = new ToolFailureRecoveryGate();
		gate.restoreFromMessages(messages);

		expect(gate.admit(editTool, args, undefined, messages)).toMatchObject({
			kind: "blocked",
			exhausted: true,
			scope: "operation",
		});
		expect(gate.isHalted()).toBe(false);
		expect(gate.admit(readTool, { path: "subject.ts" }, undefined, messages).kind).toBe("allowed");
	});

	it("reconstructs an evicted exact operation without blocking cache-miss work", () => {
		const tracker = new Map();
		const messages: AgentMessage[] = [{ role: "user", content: "inspect every board", timestamp: 1 }];
		const firstArgs = { ...listListsArgs, boardId: "board-0" };
		for (let index = 0; index < 80; index++) {
			const args = { ...listListsArgs, boardId: `board-${index}` };
			const failed = rememberToolFailure(
				tracker,
				"trello",
				args,
				"failed",
				"error",
				"Use a corrected board identifier.",
				"Board lookup failed",
			);
			const callId = `bounded-${index}`;
			messages.push(assistantCall(callId, "trello", args));
			messages.push(toolResultMessage(callId, "trello", createToolFailureResult(failed), true));
		}

		const gate = new ToolFailureRecoveryGate();
		gate.restoreFromMessages(messages);
		const memory = createToolFailureMemoryTracker(messages);
		expect(getUnresolvedToolFailure(memory, "trello", firstArgs)).toBeUndefined();

		const tool = createTrelloTool(() => {
			throw new Error("execute must not run during admission");
		});
		const replay = gate.admit(tool, firstArgs, undefined, messages);
		expect(replay.kind).toBe("blocked");
		if (replay.kind !== "blocked") return;
		expect(replay.exhausted).toBe(false);

		const newOperation = gate.admit(tool, { ...listListsArgs, boardId: "brand-new-board" }, undefined, messages);
		expect(newOperation.kind).toBe("allowed");
	});

	it("does not resurrect a successful operation from the pre-result transcript snapshot", () => {
		const tracker = new Map();
		const otherArgs = { ...listListsArgs, boardId: "still-failed" };
		const messages: AgentMessage[] = [{ role: "user", content: "retry after repair", timestamp: 1 }];
		for (const [index, args] of [listListsArgs, otherArgs].entries()) {
			const failed = rememberToolFailure(
				tracker,
				"trello",
				args,
				"failed",
				"error",
				"Use a corrected board identifier.",
				"Board lookup failed",
			);
			const callId = `initial-${index}`;
			messages.push(assistantCall(callId, "trello", args));
			messages.push(toolResultMessage(callId, "trello", createToolFailureResult(failed), true));
		}

		const gate = new ToolFailureRecoveryGate();
		gate.restoreFromMessages(messages);
		const tool = createTrelloTool(() => {
			throw new Error("execute must not run during admission");
		});
		const success = { content: [{ type: "text" as const, text: "board resolved" }], details: {} };
		gate.apply({ kind: "success", tool, args: listListsArgs, evidenceResult: success });

		expect(gate.admit(tool, listListsArgs, undefined, messages).kind).toBe("allowed");
		expect(gate.admit(tool, otherArgs, undefined, messages).kind).toBe("blocked");

		messages.push(assistantCall("successful-retry", "trello", listListsArgs));
		messages.push(toolResultMessage("successful-retry", "trello", success, false));
		expect(gate.admit(tool, listListsArgs, undefined, messages).kind).toBe("allowed");
	});

	it("does not restore a prompt-scoped owner-authorization circuit across a new user turn", () => {
		const args = { action: "start", userGoal: "evaluate the harness" };
		const tracker = new Map();
		const failed = rememberToolFailure(
			tracker,
			"goal",
			args,
			"failed",
			"owner_authorization_required",
			"Owner authorization is missing from the current prompt.",
			"goal start requires explicit owner authorization in the current prompt.",
			"policy",
		);
		const executed = createToolFailureResult(failed);
		const messages: AgentMessage[] = [
			{ role: "user", content: "this is a goal, use it", timestamp: 1 },
			assistantCall("goal-1", "goal", args),
			toolResultMessage("goal-1", "goal", executed, true),
		];
		const gate = new ToolFailureRecoveryGate();
		gate.restoreFromMessages(messages);
		expect(gate.isEmpty()).toBe(true);

		const tool: AgentTool = {
			name: "goal",
			label: "goal",
			description: "goal",
			parameters: Type.Object({ action: Type.String(), userGoal: Type.Optional(Type.String()) }),
			async execute() {
				throw new Error("execute must not run during admission");
			},
		};
		const admission = gate.admit(
			tool,
			args,
			getUnresolvedToolFailure(createToolFailureMemoryTracker(messages), "goal", args),
		);
		expect(admission.kind).toBe("allowed");
	});

	it("does not re-execute an exhausted list_lists after a new user turn", async () => {
		let executions = 0;
		const failingTool = createTrelloTool(() => {
			executions++;
		});
		let calls = 0;
		let toolFreeProviderTurns = 0;
		const streamFn = (_model: unknown, providerContext: { tools?: readonly unknown[] }) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (providerContext.tools?.length === 0) {
					toolFreeProviderTurns++;
					stream.push({
						type: "done",
						reason: "stop",
						message: assistantMessage(
							[{ type: "text", text: "Listing board lists, then sweeping cards." }],
							"stop",
						),
					});
					return;
				}
				calls++;
				stream.push({
					type: "done",
					reason: "toolUse",
					message: assistantMessage(
						[{ type: "toolCall", id: `trello-${calls}`, name: "trello", arguments: listListsArgs }],
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
		agent.maxStallTurns = 0;
		await agent.prompt("review the QA card");
		expect(executions).toBe(1);
		expect(toolFreeProviderTurns).toBe(0);

		await agent.prompt("looks like you are stuck in a loop there");
		expect(executions).toBe(1);
		expect(toolFreeProviderTurns).toBe(0);
		expect(
			agent.state.messages.some(
				(message) =>
					message.role === "assistant" &&
					message.content.some(
						(block) => block.type === "text" && block.text.includes("Tool recovery stopped for trello"),
					),
			),
		).toBe(true);
	});

	it("does not re-execute after session resume from serialized messages", async () => {
		let executions = 0;
		const failingTool = createTrelloTool(() => {
			executions++;
		});
		let calls = 0;
		const streamFn = (_model: unknown, providerContext: { tools?: readonly unknown[] }) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (providerContext.tools?.length === 0) {
					stream.push({
						type: "done",
						reason: "stop",
						message: assistantMessage([{ type: "text", text: "reported mandatory recovery blocker" }], "stop"),
					});
					return;
				}
				calls++;
				stream.push({
					type: "done",
					reason: "toolUse",
					message: assistantMessage(
						[{ type: "toolCall", id: `resume-${calls}`, name: "trello", arguments: listListsArgs }],
						"toolUse",
					),
				});
			});
			return stream;
		};
		const first = new Agent({
			streamFn,
			initialState: { model: createModel(), systemPrompt: "", tools: [failingTool] },
		});
		first.maxStallTurns = 0;
		await first.prompt("review the QA card");
		expect(executions).toBe(1);

		const resumed = new Agent({
			streamFn,
			initialState: {
				model: createModel(),
				systemPrompt: "",
				tools: [failingTool],
				messages: JSON.parse(JSON.stringify(first.state.messages)) as AgentMessage[],
			},
		});
		resumed.maxStallTurns = 0;
		await resumed.prompt("stuck in a loop");
		expect(executions).toBe(1);
	});

	it("still executes a changed operation after the previous identity is closed", async () => {
		let executions = 0;
		const seen: string[] = [];
		const failingTool: AgentTool<typeof trelloSchema> = {
			name: "trello",
			label: "Trello",
			description: "Trello",
			parameters: trelloSchema,
			async execute(_id, params) {
				executions++;
				seen.push(typeof params.boardId === "string" ? params.boardId : "missing");
				throw new Error("boardId is required unless TRELLO_BOARD_ID");
			},
		};
		let calls = 0;
		const streamFn = (_model: unknown, providerContext: { tools?: readonly unknown[] }) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (providerContext.tools?.length === 0) {
					stream.push({
						type: "done",
						reason: "stop",
						message: assistantMessage([{ type: "text", text: "reported mandatory recovery blocker" }], "stop"),
					});
					return;
				}
				calls++;
				const args =
					calls <= 4 ? listListsArgs : { action: "list_lists", envFile: "/tmp/trello.env", boardId: "grimdex" };
				stream.push({
					type: "done",
					reason: "toolUse",
					message: assistantMessage(
						[{ type: "toolCall", id: `changed-${calls}`, name: "trello", arguments: args }],
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
		agent.maxStallTurns = 0;
		await agent.prompt("review the QA card");
		expect(executions).toBe(1);
		await agent.prompt("pass boardId this time");
		expect(seen).toEqual(["missing", "grimdex"]);
		expect(executions).toBe(2);
	});

	it("does not grant a free execution after a single unresolved failure on a new prompt", async () => {
		let executions = 0;
		const failingTool = createTrelloTool(() => {
			executions++;
		});
		let promptIndex = 0;
		let turnsThisPrompt = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				turnsThisPrompt++;
				if (turnsThisPrompt === 1) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: assistantMessage(
							[
								{
									type: "toolCall",
									id: `once-${promptIndex}-${turnsThisPrompt}`,
									name: "trello",
									arguments: listListsArgs,
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
					message: assistantMessage([{ type: "text", text: "stopped after one failure" }], "stop"),
				});
			});
			return stream;
		};
		const first = new Agent({
			streamFn,
			initialState: { model: createModel(), systemPrompt: "", tools: [failingTool] },
		});
		first.maxStallTurns = 0;
		await first.prompt("try trello");
		expect(executions).toBe(1);

		promptIndex = 1;
		turnsThisPrompt = 0;
		const second = new Agent({
			streamFn,
			initialState: {
				model: createModel(),
				systemPrompt: "",
				tools: [failingTool],
				messages: JSON.parse(JSON.stringify(first.state.messages)) as AgentMessage[],
			},
		});
		second.maxStallTurns = 0;
		await second.prompt("try again");
		expect(executions).toBe(1);
	});

	it("emits the mandatory diagnostic when delivery text ignores the halt", async () => {
		let executions = 0;
		const failingTool = createTrelloTool(() => {
			executions++;
		});
		let calls = 0;
		const events = await drain(
			agentLoop(
				[{ role: "user", content: "go", timestamp: 1 }],
				{ systemPrompt: "", messages: [], tools: [failingTool] },
				{ model: createModel(), convertToLlm: identityConverter, maxStallTurns: 0 },
				undefined,
				(_model, providerContext) => {
					const stream = new MockAssistantStream();
					queueMicrotask(() => {
						if (providerContext.tools?.length === 0) {
							stream.push({
								type: "done",
								reason: "stop",
								message: assistantMessage(
									[{ type: "text", text: "Listing board lists, then sweeping cards." }],
									"stop",
								),
							});
							return;
						}
						calls++;
						stream.push({
							type: "done",
							reason: "toolUse",
							message: assistantMessage(
								[{ type: "toolCall", id: `fluff-${calls}`, name: "trello", arguments: listListsArgs }],
								"toolUse",
							),
						});
					});
					return stream;
				},
			),
		);

		expect(executions).toBe(1);
		expect(
			events.some(
				(event) =>
					event.type === "message_end" &&
					event.message.role === "assistant" &&
					event.message.content.some(
						(block) => block.type === "text" && block.text.includes("Tool recovery stopped for trello"),
					),
			),
		).toBe(true);
	});
});
