import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
	type Message,
} from "@caupulican/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import {
	createRepeatedToolFailureResult,
	createToolFailureResult,
	sanitizeToolFailureContext,
	type ToolFailureMemoryRecord,
} from "../src/tool-failure-memory.ts";
import { MANDATORY_TOOL_FAILURE_RECOVERY_PROTOCOL_PROMPT } from "../src/tool-failure-recovery-protocol.ts";
import type { AgentContext, AgentEvent, AgentMessage, AgentTool } from "../src/types.ts";
import { createAgentToolFailureRecoveryAuthority } from "../src/types.ts";

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

const identityConverter = (messages: AgentMessage[]): Message[] =>
	messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];

function failureRecord(): ToolFailureMemoryRecord {
	return {
		version: 1,
		failureKey: "trello:credential-failure",
		tool: "trello",
		operation: '{"action":"resolve_project_scope","project":"GrimDex"}',
		occurrence: 1,
		state: "failed",
		phase: "execution",
		failureCode: "credentials_missing",
		diagnostic: "Trello credentials not found.",
		correction: "Connect the Trello credential profile or report the blocker.",
	};
}

function textPayload(result: ReturnType<typeof createToolFailureResult>): Record<string, unknown> {
	const text = result.content.find((block) => block.type === "text")?.text;
	if (!text?.startsWith("[harness] ")) throw new Error("Expected a harness failure payload");
	return JSON.parse(text.slice("[harness] ".length)) as Record<string, unknown>;
}

async function drain(stream: ReturnType<typeof agentLoop>): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function failureRecordOf(message: AgentMessage | undefined): ToolFailureMemoryRecord {
	const details = message?.role === "toolResult" ? message.details : undefined;
	const record = (details as { piToolFailureMemory?: ToolFailureMemoryRecord } | undefined)?.piToolFailureMemory;
	if (!record) throw new Error("Expected a retained failure record");
	return record;
}

function singleFailureTurnStream(toolName: string, args: Record<string, unknown>) {
	let providerTurns = 0;
	return () => {
		const stream = new MockAssistantStream();
		queueMicrotask(() => {
			providerTurns++;
			stream.push({
				type: "done",
				reason: providerTurns === 1 ? "toolUse" : "stop",
				message:
					providerTurns === 1
						? assistantMessage(
								[{ type: "toolCall", id: `${toolName}-1`, name: toolName, arguments: args }],
								"toolUse",
							)
						: assistantMessage([{ type: "text", text: "reported" }], "stop"),
			});
		});
		return stream;
	};
}

describe("mandatory tool failure recovery protocol", () => {
	it("keeps the mandatory standing template compact", () => {
		expect(MANDATORY_TOOL_FAILURE_RECOVERY_PROTOCOL_PROMPT.length).toBeLessThan(500);
	});
	it("uses one explicit mandatory template for repair, execution, and blocked failures", () => {
		const record = failureRecord();
		const repairRecord: ToolFailureMemoryRecord = {
			...record,
			state: "rejected",
			phase: "validation",
			failureCode: "invalid_arguments",
			correction: "Match the current tool schema.",
		};
		const payloads = [
			textPayload(createToolFailureResult(repairRecord)),
			textPayload(createToolFailureResult(record)),
			textPayload(createRepeatedToolFailureResult(record)),
		];

		for (const payload of payloads) {
			expect(payload.MUST).toBe(true);
		}
		expect(payloads[0]?.repair).toBe("Match the current tool schema.");
		expect(payloads[1]?.next_action).toBe("Connect the Trello credential profile or report the blocker.");
	});

	it("teaches how the harness enforces the mandatory template on every provider retry", () => {
		const record = failureRecord();
		const messages: AgentMessage[] = [
			assistantMessage(
				[
					{
						type: "toolCall",
						id: "trello-1",
						name: "trello",
						arguments: { action: "resolve_project_scope", project: "GrimDex" },
					},
				],
				"toolUse",
			),
			{
				role: "toolResult",
				toolCallId: "trello-1",
				toolName: "trello",
				content: createToolFailureResult(record).content,
				details: { piToolFailureMemory: record },
				isError: true,
				timestamp: 2,
			},
		];

		const sanitized = sanitizeToolFailureContext(messages, "base");

		expect(sanitized.systemPrompt).toContain("MANDATORY TOOL FAILURE RECOVERY v1");
		expect(sanitized.systemPrompt).toContain("MANDATORY AND NON-NEGOTIABLE");
		expect(sanitized.systemPrompt).toContain("MANDATORY: blocked/rejected means not executed");
		expect(sanitized.systemPrompt).toContain("Irrelevant argument changes do not recover it");
		expect(sanitized.systemPrompt).toContain("refusal keeps tool-result pairing and runs no hooks/tools");
		expect(sanitized.systemPrompt).toContain('"MUST":true');
		expect(sanitized.systemPrompt).not.toContain("<mandatory_tool_failure");

		// The standing prompt must teach the world-cursor rule and nothing that outlived it.
		expect(sanitized.systemPrompt).toContain(
			"Retry unchanged only after any other tool succeeds or a new user turn.",
		);
		expect(sanitized.systemPrompt).toContain("Only that operation is refused; tools and run continue");
		for (const removed of [
			"never repeat the same call",
			"before another tool call",
			"permission",
			"one probe",
			"probe",
			"exhaustion",
			"exhausted",
			"ends the run",
			"exact scope",
			"backend authority",
		]) {
			expect(MANDATORY_TOOL_FAILURE_RECOVERY_PROTOCOL_PROMPT).not.toContain(removed);
		}
	});

	it("keeps refusing one unchanged operation while the model keeps its own turn to report", async () => {
		const schema = Type.Object({ action: Type.String(), project: Type.String() });
		let executions = 0;
		const failingTool: AgentTool<typeof schema> = {
			name: "trello",
			label: "Trello",
			description: "Resolve project scope",
			parameters: schema,
			async execute() {
				executions++;
				throw new Error("Trello credentials not found.");
			},
		};
		const providerContexts: Context[] = [];
		let providerTurns = 0;
		const streamFn = (_model: unknown, context: Context) => {
			providerContexts.push(context);
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				providerTurns++;
				stream.push({
					type: "done",
					reason: providerTurns <= 4 ? "toolUse" : "stop",
					message:
						providerTurns <= 4
							? assistantMessage(
									[
										{
											type: "toolCall",
											id: `trello-${providerTurns}`,
											name: "trello",
											arguments: { action: "resolve_project_scope", project: "GrimDex" },
										},
									],
									"toolUse",
								)
							: assistantMessage(
									[{ type: "text", text: "Trello is blocked until its credentials are connected." }],
									"stop",
								),
				});
			});
			return stream;
		};
		const context: AgentContext = { systemPrompt: "base", messages: [], tools: [failingTool] };

		const events = await drain(
			agentLoop(
				[{ role: "user", content: "Resume GrimDex", timestamp: 1 }],
				context,
				{
					model: createModel(),
					convertToLlm: identityConverter,
					maxStallTurns: 0,
					prepareNextTurn: ({ context: currentContext }) => ({
						context: {
							...currentContext,
							messages: currentContext.messages.filter((message) => message.role === "user"),
						},
					}),
				},
				undefined,
				streamFn,
			),
		);

		// The operation ran once; every identical replay was refused without executing anything. The
		// harness never took the turn away, so the model reached its own closing message.
		expect(executions).toBe(1);
		expect(providerTurns).toBe(5);
		expect(providerContexts).toHaveLength(5);
		expect(
			events.some(
				(event) =>
					event.type === "message_end" &&
					event.message.role === "assistant" &&
					event.message.content.some(
						(block) =>
							block.type === "text" && block.text === "Trello is blocked until its credentials are connected.",
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
	});

	it("keeps unrelated tools available while one exact operation stays refused", async () => {
		const trelloSchema = Type.Object({ action: Type.String(), project: Type.String() });
		const readSchema = Type.Object({ path: Type.String() });
		let trelloExecutions = 0;
		let readExecutions = 0;
		const trelloTool: AgentTool<typeof trelloSchema> = {
			name: "trello",
			label: "Trello",
			description: "Resolve project scope",
			parameters: trelloSchema,
			async execute() {
				trelloExecutions++;
				throw new Error("Trello credentials not found.");
			},
		};
		const readTool: AgentTool<typeof readSchema> = {
			name: "read_repo",
			label: "Read repository",
			description: "Read repository evidence",
			parameters: readSchema,
			async execute() {
				readExecutions++;
				return { content: [{ type: "text", text: "repository evidence" }], details: {} };
			},
		};
		const providerContexts: Context[] = [];
		let providerTurns = 0;
		const streamFn = (_model: unknown, context: Context) => {
			providerContexts.push(context);
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				providerTurns++;
				if (providerTurns <= 3) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: assistantMessage(
							[
								{
									type: "toolCall",
									id: `trello-${providerTurns}`,
									name: "trello",
									arguments: { action: "resolve_project_scope", project: "GrimDex" },
								},
							],
							"toolUse",
						),
					});
					return;
				}
				if (providerTurns === 4) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: assistantMessage(
							[
								{
									type: "toolCall",
									id: "repo-read",
									name: "read_repo",
									arguments: { path: "AGENTS.md" },
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
					message: assistantMessage([{ type: "text", text: "continued with repository evidence" }], "stop"),
				});
			});
			return stream;
		};

		const events = await drain(
			agentLoop(
				[{ role: "user", content: "Audit GrimDex without requiring Trello", timestamp: 1 }],
				{ systemPrompt: "base", messages: [], tools: [trelloTool, readTool] },
				{ model: createModel(), convertToLlm: identityConverter, maxStallTurns: 0 },
				undefined,
				streamFn,
			),
		);

		expect(trelloExecutions).toBe(1);
		expect(readExecutions).toBe(1);
		expect(providerTurns).toBe(5);
		expect(providerContexts[3]?.tools?.map((tool) => tool.name)).toEqual(["trello", "read_repo"]);
		expect(providerContexts[3]?.systemPrompt).not.toContain("MANDATORY TOOL FAILURE DELIVERY");
		expect(providerContexts[3]?.systemPrompt).toContain("Trello credentials not found.");
		expect(providerContexts[3]?.systemPrompt).not.toContain("Stop retrying tools in this run");
		expect(providerContexts[3]?.systemPrompt).not.toContain("will not run again this session");
		expect(
			events.some(
				(event) =>
					event.type === "message_end" &&
					event.message.role === "toolResult" &&
					event.message.toolCallId === "trello-3" &&
					event.message.content.some(
						(block) => block.type === "text" && block.text.includes('"failure_code":"repeated_failed_operation"'),
					),
			),
		).toBe(true);
	});

	it("runs a refused replay through neither the tool nor its hooks, and leaves stopping to the runaway backstop", async () => {
		const schema = Type.Object({ value: Type.String() });
		let executions = 0;
		let beforeCalls = 0;
		const runawayStops: string[] = [];
		const failingTool: AgentTool<typeof schema> = {
			name: "probe",
			label: "Probe",
			description: "Always fails",
			parameters: schema,
			async execute() {
				executions++;
				throw new Error("Credential profile is unavailable.");
			},
		};
		let providerTurns = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				providerTurns++;
				stream.push({
					type: "done",
					reason: "toolUse",
					message: assistantMessage(
						[
							{
								type: "toolCall",
								id: providerTurns === 5 ? "delivery-violation" : `probe-${providerTurns}`,
								name: "probe",
								arguments: { value: "same" },
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
				{ systemPrompt: "base", messages: [], tools: [failingTool] },
				{
					model: createModel(),
					convertToLlm: identityConverter,
					maxStallTurns: 3,
					beforeToolCall: async () => {
						beforeCalls++;
						return undefined;
					},
					onRunawayStop: ({ reason }) => {
						runawayStops.push(reason);
					},
				},
				undefined,
				streamFn,
			),
		);

		// One execution, one hook call: every later replay is refused before any tool or hook code runs.
		// The fourth request is the tool-free closing turn the stall stop spends.
		expect(providerTurns).toBe(4);
		expect(executions).toBe(1);
		expect(beforeCalls).toBe(1);
		// The recovery gate never ends a run. A model wedged on one action is the cost guard's job.
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

	it("does not treat internal custom steering as a new owner turn", async () => {
		const schema = Type.Object({ command: Type.String() });
		let executions = 0;
		const tool: AgentTool<typeof schema> = {
			name: "bash",
			label: "Bash",
			description: "Run a shell command",
			parameters: schema,
			async execute() {
				executions++;
				throw new Error("search rejected\nCommand exited with code 2");
			},
		};
		let providerTurns = 0;
		let steeringPolls = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				providerTurns++;
				stream.push({
					type: "done",
					reason: providerTurns <= 2 ? "toolUse" : "stop",
					message:
						providerTurns <= 2
							? assistantMessage(
									[
										{
											type: "toolCall",
											id: `bash-${providerTurns}`,
											name: "bash",
											arguments: { command: "find /workspace -name '*.ts'" },
										},
									],
									"toolUse",
								)
							: assistantMessage([{ type: "text", text: "reported" }], "stop"),
				});
			});
			return stream;
		};

		const events = await drain(
			agentLoop(
				[{ role: "user", content: "find the source file", timestamp: 1 }],
				{ systemPrompt: "base", messages: [], tools: [tool] },
				{
					model: createModel(),
					convertToLlm: identityConverter,
					maxStallTurns: 0,
					getSteeringMessages: async () => {
						steeringPolls++;
						if (steeringPolls !== 2) return [];
						return [
							{
								role: "custom",
								customType: "internal_recovery_notice",
								content: "internal notice",
								display: false,
								timestamp: 2,
							},
						];
					},
				},
				undefined,
				streamFn,
			),
		);

		expect(providerTurns).toBe(3);
		expect(executions).toBe(1);
		const bashResults = events.filter((event) => event.type === "message_end" && event.message.role === "toolResult");
		expect(bashResults).toHaveLength(2);
		expect(
			bashResults.some(
				(event) =>
					event.type === "message_end" &&
					event.message.role === "toolResult" &&
					event.message.content.some(
						(block) => block.type === "text" && block.text.includes('"failure_code":"repeated_failed_operation"'),
					),
			),
		).toBe(true);
	});

	it("counts every queued owner message so live and restored recovery cursors stay aligned", async () => {
		const schema = Type.Object({ command: Type.String() });
		const executions = new Map<string, number>();
		const tool: AgentTool<typeof schema> = {
			name: "bash",
			label: "Bash",
			description: "Run a shell command",
			parameters: schema,
			async execute(_toolCallId, args) {
				executions.set(args.command, (executions.get(args.command) ?? 0) + 1);
				throw new Error("probe failed\nCommand exited with code 2");
			},
		};
		let providerTurns = 0;
		let steeringPolls = 0;
		const originalCommand = "original failing probe";
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				providerTurns++;
				const content =
					providerTurns === 3
						? Array.from({ length: 64 }, (_, index) => ({
								type: "toolCall" as const,
								id: `evict-${index}`,
								name: "bash",
								arguments: { command: `distinct failing probe ${index}` },
							}))
						: providerTurns <= 4
							? [
									{
										type: "toolCall" as const,
										id: `original-${providerTurns}`,
										name: "bash",
										arguments: { command: originalCommand },
									},
								]
							: [{ type: "text" as const, text: "reported" }];
				stream.push({
					type: "done",
					reason: providerTurns <= 4 ? "toolUse" : "stop",
					message: assistantMessage(content, providerTurns <= 4 ? "toolUse" : "stop"),
				});
			});
			return stream;
		};

		await drain(
			agentLoop(
				[{ role: "user", content: "investigate", timestamp: 1 }],
				{ systemPrompt: "base", messages: [], tools: [tool] },
				{
					model: createModel(),
					convertToLlm: identityConverter,
					maxStallTurns: 0,
					getSteeringMessages: async () => {
						steeringPolls++;
						if (steeringPolls === 2) {
							return [
								{ role: "user", content: "first owner correction", timestamp: 2 },
								{ role: "user", content: "second owner correction", timestamp: 3 },
							];
						}
						return steeringPolls === 4 ? [{ role: "user", content: "third owner correction", timestamp: 4 }] : [];
					},
				},
				undefined,
				streamFn,
			),
		);

		expect(providerTurns).toBe(5);
		expect(executions.get(originalCommand)).toBe(3);
	});

	it("leads with catalogued policy guidance before the gate's loaded actions", async () => {
		const schema = Type.Object({ path: Type.String() });
		const targetKind = "test.file.exists";
		const authority = createAgentToolFailureRecoveryAuthority();
		const tool: AgentTool<typeof schema> = {
			name: "read_like",
			label: "Read-like",
			description: "Read a path",
			parameters: schema,
			failureRecovery: {
				getFailureTargets: (params) => [{ authority, kind: targetKind, scope: params.path }],
				actions: [
					{ kind: "correct", authority, targetKind, instruction: "Probe the parent listing with the stat tool." },
				],
			},
			async execute() {
				throw new Error("ENOENT: no such file or directory, open '/repo/missing.txt'");
			},
		};

		const stream = agentLoop(
			[{ role: "user", content: "read it", timestamp: 1 }],
			{ systemPrompt: "base", messages: [], tools: [tool] },
			{ model: createModel(), convertToLlm: identityConverter, maxStallTurns: 0 },
			undefined,
			singleFailureTurnStream("read_like", { path: "/repo/missing.txt" }),
		);
		await drain(stream);
		const messages = await stream.result();

		const record = failureRecordOf(messages.find((message) => message.role === "toolResult"));
		expect(record.failureCode).toBe("file_not_found");
		expect(record.diagnostic).toContain("/repo/missing.txt");
		expect(record.correction.startsWith("Path not found. List parent directory or re-read path before retry. ")).toBe(
			true,
		);
		expect(record.correction).toContain(
			"Loaded actions: read_like correct: Probe the parent listing with the stat tool.",
		);
	});

	it("keeps the gate guidance as the whole correction when no catalogued policy matches", async () => {
		const schema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof schema> = {
			name: "probe",
			label: "Probe",
			description: "Probe the backend",
			parameters: schema,
			async execute() {
				throw new Error("backend handshake rejected the session token\nCommand exited with code 7");
			},
		};

		const stream = agentLoop(
			[{ role: "user", content: "probe", timestamp: 1 }],
			{ systemPrompt: "base", messages: [], tools: [tool] },
			{ model: createModel(), convertToLlm: identityConverter, maxStallTurns: 0 },
			undefined,
			singleFailureTurnStream("probe", { value: "same" }),
		);
		await drain(stream);
		const messages = await stream.result();

		const record = failureRecordOf(messages.find((message) => message.role === "toolResult"));
		expect(record.failureCode).toBe("exit_7");
		expect(record.correction).toBe(
			"The operation is readmitted after another tool succeeds or a new user turn. Do the corrective work first, or use a materially different operation justified by the diagnostic.",
		);
		expect(record.evidence).toBe("backend handshake rejected the session token");
	});

	it("keeps gate-derived repair evidence ahead of the raw output tail", async () => {
		const schema = Type.Object({ path: Type.String() });
		const authority = createAgentToolFailureRecoveryAuthority();
		const tool: AgentTool<typeof schema> = {
			name: "read_like",
			label: "Read-like",
			description: "Read a path",
			parameters: schema,
			failureRecovery: {
				getFailureTargets: (params) => [{ authority, kind: "test.file.exists", scope: params.path }],
				getFailureEvidence: () => "CONTRACT_EVIDENCE: current backend snapshot",
			},
			async execute() {
				throw new Error("probe output line\nCommand exited with code 3");
			},
		};

		const stream = agentLoop(
			[{ role: "user", content: "read it", timestamp: 1 }],
			{ systemPrompt: "base", messages: [], tools: [tool] },
			{ model: createModel(), convertToLlm: identityConverter, maxStallTurns: 0 },
			undefined,
			singleFailureTurnStream("read_like", { path: "/repo/present.txt" }),
		);
		await drain(stream);
		const messages = await stream.result();

		const record = failureRecordOf(messages.find((message) => message.role === "toolResult"));
		expect(record.evidence).toBe("CONTRACT_EVIDENCE: current backend snapshot");
		expect(record.evidence).not.toContain("probe output line");
	});

	it("does not grant fresh evidence to a blocked unchanged replay", async () => {
		const schema = Type.Object({ value: Type.String() });
		let executions = 0;
		const tool: AgentTool<typeof schema> = {
			name: "probe",
			label: "Probe",
			description: "Probe the backend",
			parameters: schema,
			async execute() {
				executions++;
				throw new Error("probe tail alpha\nprobe tail beta\nCommand exited with code 2");
			},
		};
		let providerTurns = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				providerTurns++;
				stream.push({
					type: "done",
					reason: providerTurns <= 2 ? "toolUse" : "stop",
					message:
						providerTurns <= 2
							? assistantMessage(
									[
										{
											type: "toolCall",
											id: `probe-${providerTurns}`,
											name: "probe",
											arguments: { value: "same" },
										},
									],
									"toolUse",
								)
							: assistantMessage([{ type: "text", text: "reported" }], "stop"),
				});
			});
			return stream;
		};

		const stream = agentLoop(
			[{ role: "user", content: "probe", timestamp: 1 }],
			{ systemPrompt: "base", messages: [], tools: [tool] },
			{ model: createModel(), convertToLlm: identityConverter, maxStallTurns: 0 },
			undefined,
			streamFn,
		);
		await drain(stream);
		const messages = await stream.result();

		const failedResults = messages.filter((message) => message.role === "toolResult" && message.isError === true);
		expect(executions).toBe(1);
		expect(failedResults).toHaveLength(2);
		const first = failureRecordOf(failedResults[0]);
		const second = failureRecordOf(failedResults[1]);
		expect(first.evidence).toBe("probe tail alpha\nprobe tail beta");
		expect(second.evidence).toBe(first.evidence);
		const secondText =
			failedResults[1]?.role === "toolResult"
				? (failedResults[1].content.find((block) => block.type === "text")?.text ?? "")
				: "";
		expect(secondText).toContain('"failure_code":"repeated_failed_operation"');
	});
});
