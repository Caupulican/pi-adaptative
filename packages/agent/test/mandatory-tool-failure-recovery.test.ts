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
	createToolFailureRecoveryExhaustedResult,
	createToolFailureResult,
	sanitizeToolFailureContext,
	type ToolFailureMemoryRecord,
} from "../src/tool-failure-memory.ts";
import {
	appendMandatoryToolFailureDeliveryPrompt,
	MANDATORY_TOOL_FAILURE_RECOVERY_PROTOCOL_PROMPT,
} from "../src/tool-failure-recovery-protocol.ts";
import type { AgentContext, AgentEvent, AgentMessage, AgentTool } from "../src/types.ts";

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

describe("mandatory tool failure recovery protocol", () => {
	it("keeps the mandatory standing and delivery templates compact", () => {
		expect(MANDATORY_TOOL_FAILURE_RECOVERY_PROTOCOL_PROMPT.length).toBeLessThan(650);
		expect(
			appendMandatoryToolFailureDeliveryPrompt("", {
				tool: "read",
				failureCode: "file_not_found",
				diagnostic: "missing",
				requiredAction: "create the exact file",
			}).length,
		).toBeLessThan(500);
	});
	it("uses one explicit mandatory template for repair, execution, blocked, and exhausted failures", () => {
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
			textPayload(createToolFailureRecoveryExhaustedResult(record, "Recovery circuit opened.")),
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
		expect(sanitized.systemPrompt).toContain("Irrelevant argument changes never recover it");
		expect(sanitized.systemPrompt).toContain("blocked call preserves tool-result pairing but runs no hook/tool code");
		expect(sanitized.systemPrompt).toContain('"MUST":true');
		expect(sanitized.systemPrompt).not.toContain("<mandatory_tool_failure");
	});

	it("uses one tool-free provider turn to deliver after the recovery circuit opens", async () => {
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
					reason: providerTurns <= 3 ? "toolUse" : "stop",
					message:
						providerTurns <= 3
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

		expect(executions).toBe(1);
		expect(providerTurns).toBe(4);
		expect(providerContexts[3]?.tools).toEqual([]);
		expect(providerContexts[3]?.systemPrompt).toContain("MANDATORY TOOL FAILURE DELIVERY v1");
		expect(providerContexts[3]?.systemPrompt).toContain('"diagnostic":"Trello credentials not found."');
		expect(providerContexts[3]?.systemPrompt).toContain('"required_action":');
		expect(
			events.some(
				(event) =>
					event.type === "message_end" &&
					event.message.role === "assistant" &&
					event.message.content.some(
						(block) =>
							block.type === "text" && block.text.includes("blocked until its credentials are connected"),
					),
			),
		).toBe(true);
	});

	it("pairs but never executes a tool call hallucinated during mandatory delivery", async () => {
		const schema = Type.Object({ value: Type.String() });
		let executions = 0;
		let beforeCalls = 0;
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
								id: providerTurns === 4 ? "delivery-violation" : `probe-${providerTurns}`,
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
					maxStallTurns: 0,
					beforeToolCall: async () => {
						beforeCalls++;
						return undefined;
					},
				},
				undefined,
				streamFn,
			),
		);

		expect(providerTurns).toBe(4);
		expect(executions).toBe(1);
		expect(beforeCalls).toBe(1);
		expect(
			events.some(
				(event) =>
					event.type === "message_end" &&
					event.message.role === "toolResult" &&
					event.message.toolCallId === "delivery-violation",
			),
		).toBe(true);
		expect(
			events.some(
				(event) =>
					event.type === "message_end" &&
					event.message.role === "assistant" &&
					event.message.content.some(
						(block) => block.type === "text" && block.text.includes("Tool recovery stopped for probe"),
					),
			),
		).toBe(true);
	});
});
