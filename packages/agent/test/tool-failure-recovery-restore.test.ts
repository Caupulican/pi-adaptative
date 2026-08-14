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
import type { AgentEvent, AgentMessage, AgentTool, AgentToolResult } from "../src/types.ts";

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
		let deliveryTurns = 0;
		const streamFn = (_model: unknown, providerContext: { tools?: readonly unknown[] }) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (providerContext.tools?.length === 0) {
					deliveryTurns++;
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
		expect(deliveryTurns).toBe(1);

		await agent.prompt("looks like you are stuck in a loop there");
		expect(executions).toBe(1);
		expect(deliveryTurns).toBe(2);
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
