import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Message } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { agentLoop } from "../src/agent-loop.ts";
import {
	createRepeatedToolFailureResult,
	createToolFailureMemoryTracker,
	createToolFailureResult,
	getUnresolvedToolFailure,
	rememberToolFailure,
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

function createBlockedListListsTranscript(): AgentMessage[] {
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
	const blockedAgain = createRepeatedToolFailureResult(blocked.details.piToolFailureMemory);
	return [
		{ role: "user", content: "review the QA card", timestamp: 1 },
		assistantCall("trello-1", "trello", listListsArgs),
		toolResultMessage("trello-1", "trello", executed, true),
		assistantCall("trello-2", "trello", listListsArgs),
		toolResultMessage("trello-2", "trello", blocked, true),
		assistantCall("trello-3", "trello", listListsArgs),
		toolResultMessage("trello-3", "trello", blockedAgain, true),
	];
}

async function drain(stream: ReturnType<typeof agentLoop>) {
	const events: AgentEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

const identityConverter = (messages: AgentMessage[]): Message[] =>
	messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];

function resultContainsFailureCode(result: AgentToolResult<unknown>, failureCode: string): boolean {
	return result.content.some(
		(block) => block.type === "text" && block.text.includes(`"failure_code":"${failureCode}"`),
	);
}

describe("tool-failure recovery restore", () => {
	// Session 01a019b7 (GazeIntent, 2026-08-19): an agent reproducing a red test baseline ran
	// `python -m unittest`, which exited 1 because the tests failed — the observation it wanted. It
	// then re-sent the identical command three times. The harness answered the fourth with
	// `recovery_exhausted` and ended the run, and the user saw only "Tool recovery stopped for bash".
	it("keeps the run alive when a red test baseline is replayed to death", async () => {
		const schema = Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) });
		const command = "cd /repo && PYTHONPATH=src python3 -m unittest tests.test_head_aim -v";
		const testOutput = "FAILED (errors=2)\nValueError: head-aim freshness/stability windows are invalid";
		let executions = 0;
		let reads = 0;
		const bash: AgentTool<typeof schema> = {
			name: "bash",
			label: "bash",
			description: "Run a shell command",
			parameters: schema,
			async execute() {
				executions++;
				// A completed process reporting a non-zero exit, exactly as the real bash tool reports it.
				throw new AgentToolExecutionError(
					`${testOutput}\n\nCommand exited with code 1\ncwd: /repo`,
					"exit_1",
					"a".repeat(43),
					"operation_outcome",
				);
			},
		};
		const read: AgentTool = {
			name: "read",
			label: "read",
			description: "Read a file",
			parameters: Type.Object({ path: Type.String() }),
			async execute() {
				reads++;
				return { content: [{ type: "text", text: "def head_aim(): ..." }], details: {} };
			},
		};
		let turn = 0;
		const providerMessages: string[] = [];
		const events = await drain(
			agentLoop(
				[{ role: "user", content: "fix the failing head-aim tests", timestamp: 1 }],
				{ systemPrompt: "", messages: [], tools: [bash, read] },
				{ model: createModel(), convertToLlm: identityConverter, maxStallTurns: 0 },
				undefined,
				(_model, providerContext) => {
					providerMessages.push(JSON.stringify(providerContext.messages));
					const stream = new MockAssistantStream();
					queueMicrotask(() => {
						turn++;
						// Four identical replays, exactly as the reported session did, then a corrective read.
						const message =
							turn <= 4
								? assistantCall(`bash-${turn}`, "bash", { command, timeout: 60 })
								: turn === 5
									? assistantCall("read-1", "read", { path: "src/head_aim.py" })
									: assistantMessage([{ type: "text", text: "Windows are inverted; fixing now." }], "stop");
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

		// The run reaches the model's own closing turn instead of being cut short by the harness.
		expect(turn).toBe(6);
		expect(
			events.some(
				(event) =>
					event.type === "message_end" &&
					event.message.role === "assistant" &&
					event.message.content.some(
						(block) => block.type === "text" && block.text === "Windows are inverted; fixing now.",
					),
			),
		).toBe(true);
		expect(
			events.some(
				(event) =>
					event.type === "message_end" &&
					event.message.role === "assistant" &&
					event.message.content.some(
						(block) => block.type === "text" && block.text.includes("Tool recovery stopped"),
					),
			),
		).toBe(false);

		// The command ran once; the replays were refused, and the unrelated read stayed available.
		expect(executions).toBe(1);
		expect(reads).toBe(1);
		expect(
			events.filter(
				(event) =>
					event.type === "tool_execution_end" &&
					resultContainsFailureCode(event.result, "repeated_failed_operation"),
			),
		).toHaveLength(3);

		// The failing run is data, not a harness failure record: its own output reaches the model
		// verbatim, and the agent can still see the exact command it sent.
		const firstResult = events.find((event) => event.type === "message_end" && event.message.role === "toolResult");
		if (!firstResult || firstResult.type !== "message_end" || firstResult.message.role !== "toolResult") {
			throw new Error("Expected a tool result");
		}
		expect(firstResult.message.errorKind).toBe("operation_outcome");
		const firstText = firstResult.message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		expect(firstText).toContain("ValueError: head-aim freshness/stability windows are invalid");
		expect(firstText).not.toContain("[harness]");
		expect(providerMessages[1]).toContain("ValueError: head-aim freshness/stability windows are invalid");
		expect(providerMessages[1]).toContain(command);
	});

	it("re-admits a failed operation once anything else succeeds, however often it has failed", () => {
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
		const otherTool: AgentTool = {
			name: "edit",
			label: "edit",
			description: "edit",
			parameters: Type.Object({ path: Type.String() }),
			async execute() {
				throw new Error("must not execute during recovery-state testing");
			},
		};
		const tracker = new Map();
		const gate = new ToolFailureRecoveryGate();
		const fail = (output: string) =>
			gate.apply({
				kind: "unproductive",
				tool,
				args,
				record: rememberToolFailure(
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
			});

		// Ten identical failures with byte-identical output. The old design killed the run on the
		// second; the operation is simply refused while nothing has changed, and never more than that.
		for (let attempt = 0; attempt < 10; attempt++) {
			fail("FAILED tests.test_head_aim import error");
			expect(gate.admit(tool, args, undefined, [])).toMatchObject({ kind: "blocked" });
			// The refusal is local: an unrelated operation is admitted throughout.
			expect(gate.admit(otherTool, { path: "subject.ts" }, undefined, [])).toEqual({ kind: "allowed" });
			// One success anywhere makes the failed operation worth attempting again.
			gate.apply({ kind: "success", tool: otherTool, args: { path: "subject.ts" } });
			expect(gate.admit(tool, args, undefined, [])).toEqual({ kind: "allowed" });
		}
	});

	it("restores a refused operation from the transcript and re-admits it after a later success", () => {
		const args = { command: "run focused tests" };
		const tracker = new Map();
		const record = rememberToolFailure(
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
		const tool: AgentTool = {
			name: "bash",
			label: "bash",
			description: "bash",
			parameters: Type.Object({ command: Type.String() }),
			async execute() {
				throw new Error("must not execute during recovery-state testing");
			},
		};
		const failedOnly: AgentMessage[] = [
			assistantCall("bash-1", "bash", args),
			toolResultMessage("bash-1", "bash", createToolFailureResult(record), true),
		];
		const blockedGate = new ToolFailureRecoveryGate();
		blockedGate.restoreFromMessages(JSON.parse(JSON.stringify(failedOnly)) as AgentMessage[]);
		expect(blockedGate.admit(tool, args, undefined, failedOnly)).toMatchObject({ kind: "blocked" });

		// The same transcript plus one later success: the world moved, so the replay is worth running.
		const afterSuccess: AgentMessage[] = [
			...failedOnly,
			assistantCall("edit-1", "edit", { path: "subject.ts" }),
			toolResultMessage("edit-1", "edit", { content: [{ type: "text", text: "edited" }], details: {} }, false),
		];
		const resumedGate = new ToolFailureRecoveryGate();
		resumedGate.restoreFromMessages(JSON.parse(JSON.stringify(afterSuccess)) as AgentMessage[]);
		expect(resumedGate.admit(tool, args, undefined, afterSuccess)).toEqual({ kind: "allowed" });
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

	it("keeps corrective operations available while a failed edit stays refused", () => {
		const schema = Type.Object({ path: Type.String(), edits: Type.Array(Type.Object({ oldText: Type.String() })) });
		const args = { path: "subject.ts", edits: [{ oldText: "stale anchor" }] };
		const editTool: AgentTool<typeof schema> = {
			name: "edit",
			label: "edit",
			description: "edit",
			parameters: schema,
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
		gate.apply({ kind: "unproductive", tool: editTool, record, args });

		// However many times the agent re-sends it, the answer stays the same shape: refused, never
		// escalating into anything that could deny the corrective read alongside it.
		for (let attempt = 0; attempt < 3; attempt++) {
			expect(gate.admit(editTool, args, record)).toMatchObject({ kind: "blocked" });
			expect(gate.admit(readTool, { path: "subject.ts" }, undefined).kind).toBe("allowed");
		}

		// The corrective read succeeding is what makes the edit worth attempting again.
		gate.apply({ kind: "success", tool: readTool, args: { path: "subject.ts" } });
		expect(gate.admit(editTool, args, record).kind).toBe("allowed");
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
		const providerMessages: string[] = [];
		const events = await drain(
			agentLoop(
				[{ role: "user", content: "edit the file", timestamp: 1 }],
				{ systemPrompt: "", messages: [], tools: [failingTool] },
				{ model: createModel(), convertToLlm: identityConverter },
				undefined,
				(_model, providerContext) => {
					providerPrompts.push(providerContext.systemPrompt ?? "");
					providerMessages.push(JSON.stringify(providerContext.messages));
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
		// Evidence reaches the next request through the retained result itself, not by being copied
		// into the ledger, so the agent reads it once beside the call that produced it.
		expect(providerPrompts[1]).not.toContain("Current source sha256 abcdef123456");
		expect(providerMessages[1]).toContain("Current source sha256 abcdef123456");
		expect(providerMessages[1]).toContain("8 | current anchor");
	});

	it("keeps refusing the identical operation after a JSON-roundtripped transcript", () => {
		const messages = JSON.parse(JSON.stringify(createBlockedListListsTranscript())) as AgentMessage[];
		const gate = new ToolFailureRecoveryGate();
		gate.restoreFromMessages(messages);
		expect(gate.isEmpty()).toBe(false);

		const tool = createTrelloTool(() => {
			throw new Error("execute must not run");
		});
		const memory = createToolFailureMemoryTracker(messages);
		const admission = gate.admit(tool, listListsArgs, getUnresolvedToolFailure(memory, "trello", listListsArgs));
		expect(admission.kind).toBe("blocked");
	});

	it("restores a refused edit from the transcript without denying anything else", () => {
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
		const closed = createRepeatedToolFailureResult(record);
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

		expect(gate.admit(editTool, args, undefined, messages)).toMatchObject({ kind: "blocked" });
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
		// Without that success, the transcript alone still refuses both operations.
		const staleGate = new ToolFailureRecoveryGate();
		staleGate.restoreFromMessages(JSON.parse(JSON.stringify(messages)) as AgentMessage[]);
		expect(staleGate.admit(tool, listListsArgs, undefined, messages).kind).toBe("blocked");
		expect(staleGate.admit(tool, otherArgs, undefined, messages).kind).toBe("blocked");

		gate.apply({ kind: "success", tool, args: listListsArgs });

		// The success is not yet in the transcript snapshot below, so only the live overlay can know
		// this exact operation now succeeds rather than matching its stale recorded failure.
		expect(gate.admit(tool, listListsArgs, undefined, messages).kind).toBe("allowed");

		messages.push(assistantCall("successful-retry", "trello", listListsArgs));
		messages.push(
			toolResultMessage(
				"successful-retry",
				"trello",
				{ content: [{ type: "text", text: "board resolved" }], details: {} },
				false,
			),
		);
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

	it("runs a failing list_lists once per prompt, and gives it one fresh attempt on a new user turn", async () => {
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
		agent.maxStallTurns = 3;
		await agent.prompt("review the QA card");
		// One execution for the whole prompt; the identical replays never reached the tool. The stall
		// stop then spends one tool-free request so the model closes the prompt itself.
		expect(executions).toBe(1);
		expect(toolFreeProviderTurns).toBe(1);

		// A new user turn can have changed authority, files, or environment, so the operation is worth
		// exactly one more attempt — and again only one, however many times the model re-sends it.
		await agent.prompt("looks like you are stuck in a loop there");
		expect(executions).toBe(2);
		expect(toolFreeProviderTurns).toBe(2);
		expect(
			agent.state.messages.some(
				(message) =>
					message.role === "assistant" &&
					message.content.some((block) => block.type === "text" && block.text.includes("Tool recovery stopped")),
			),
		).toBe(false);
	});

	it("carries refusal state across a session resume from serialized messages", async () => {
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
		first.maxStallTurns = 3;
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
		resumed.maxStallTurns = 3;
		await resumed.prompt("stuck in a loop");
		// The resumed session reconstructs the same accounting from the transcript: the new user turn
		// buys exactly one attempt, not one per replay.
		expect(executions).toBe(2);
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
					calls <= 3 ? listListsArgs : { action: "list_lists", envFile: "/tmp/trello.env", boardId: "grimdex" };
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
		agent.maxStallTurns = 3;
		await agent.prompt("review the QA card");
		expect(executions).toBe(1);
		// A materially changed operation is a different identity and was never refused in the first place.
		await agent.prompt("pass boardId this time");
		expect(seen).toEqual(["missing", "grimdex"]);
		expect(executions).toBe(2);
	});

	it("grants a new user turn exactly one attempt at a previously failed operation", async () => {
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
		// The user may have fixed the environment between turns, and the harness cannot know either
		// way; what it can guarantee is that the turn buys one attempt, never an open-ended retry loop.
		expect(executions).toBe(2);
	});

	it("executes a wedged operation once and leaves the stop to the runaway backstop", async () => {
		let executions = 0;
		const failingTool = createTrelloTool(() => {
			executions++;
		});
		let calls = 0;
		const runawayStops: string[] = [];
		const events = await drain(
			agentLoop(
				[{ role: "user", content: "go", timestamp: 1 }],
				{ systemPrompt: "", messages: [], tools: [failingTool] },
				{
					model: createModel(),
					convertToLlm: identityConverter,
					maxStallTurns: 3,
					onRunawayStop: ({ reason }) => {
						runawayStops.push(reason);
					},
				},
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

		// The operation ran once; every replay was refused without executing it again. Nothing the
		// recovery gate does ends the run, so the cost guard is what finally stops the wedged model.
		expect(executions).toBe(1);
		expect(runawayStops).toEqual(["repeated_tool_call"]);
		expect(
			events.some(
				(event) =>
					event.type === "message_end" &&
					event.message.role === "assistant" &&
					event.message.content.some(
						(block) => block.type === "text" && block.text.includes("Tool recovery stopped"),
					),
			),
		).toBe(false);
	});
});
