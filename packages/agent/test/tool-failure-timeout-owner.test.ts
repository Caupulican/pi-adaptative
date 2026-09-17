import { createAssistantMessageEventStream } from "@caupulican/pi-ai/event-stream";
import type { AssistantMessage, Message } from "@caupulican/pi-ai/types";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../src/agent-loop.ts";
import {
	createRepeatedToolFailureResult,
	createToolFailureResult,
	describeOperationOutcome,
	rememberToolFailure,
	type ToolFailureMemoryRecord,
} from "../src/tool-failure-memory.ts";
import { ToolFailureRecoveryGate } from "../src/tool-failure-recovery-gate.ts";
import { retainedToolInvocation } from "../src/tool-invocation-receipt.ts";
import { type AgentMessage, type AgentTool, AgentToolExecutionError } from "../src/types.ts";
import { createEmptyUsage } from "../src/usage.ts";

const parameters = Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) });
const tool: AgentTool<typeof parameters> = {
	name: "timeout_owner",
	label: "Timeout owner",
	description: "Admission fixture with an executor-owned default and minimum",
	parameters,
	failureRecovery: {
		getTimeoutMs: ({ timeout }) => Math.max(100, (timeout ?? 120) * 1000),
	},
	async execute() {
		throw new Error("This admission fixture must never execute");
	},
};

function timeoutFailure(args: Record<string, unknown>): ToolFailureMemoryRecord {
	return describeOperationOutcome(tool.name, args, "timeout", "Command timed out");
}

function appendFailure(
	messages: AgentMessage[],
	args: Record<string, unknown>,
	record: ToolFailureMemoryRecord,
	refused = false,
): void {
	const id = `call-${messages.length}`;
	const result = refused ? createRepeatedToolFailureResult(record) : createToolFailureResult(record);
	messages.push(
		{
			role: "assistant",
			content: [{ type: "toolCall", id, name: tool.name, arguments: args }],
			api: "openai-responses",
			provider: "openai",
			model: "fixture",
			usage: createEmptyUsage(),
			stopReason: "toolUse",
			timestamp: 1,
		},
		{
			role: "toolResult",
			toolCallId: id,
			toolName: tool.name,
			content: result.content,
			details: result.details,
			isError: true,
			timestamp: 1,
		},
	);
}

describe("executor-owned timeout recovery", () => {
	it("executes bounded native-style timeout repairs through the real loop", async () => {
		const executed: number[] = [];
		const runtimeTool: AgentTool<typeof parameters> = {
			...tool,
			async execute(_id, args) {
				executed.push(args.timeout ?? 120);
				throw new AgentToolExecutionError(
					`Command timed out after ${args.timeout} seconds`,
					"timeout",
					"fixture-output",
					"operation_outcome",
				);
			},
		};
		const requested = [60, 60, 120, 240, 480];
		let turn = 0;
		const messages = await runAgentLoop(
			[{ role: "user", content: "Perform the fixture operation", timestamp: 1 }],
			{ systemPrompt: "", messages: [], tools: [runtimeTool] },
			{
				model: {
					id: "fixture",
					name: "fixture",
					api: "openai-responses",
					provider: "openai",
					baseUrl: "https://example.invalid",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 8192,
					maxTokens: 1024,
				},
				convertToLlm: (history) => history.filter(
					(message): message is Message => ["user", "assistant", "toolResult"].includes(message.role),
				),
				toolExecution: "sequential",
				maxStallTurns: 0,
				maxRepeatedFailures: 0,
			},
			() => {},
			undefined,
			() => {
				const timeout = requested[turn++];
				const message: AssistantMessage = {
					role: "assistant",
					content: timeout === undefined
						? [{ type: "text", text: "Timeout recovery remains unresolved." }]
						: [{ type: "toolCall", id: `fixture-${turn}`, name: tool.name, arguments: { command: "fixture", timeout } }],
					api: "openai-responses",
					provider: "openai",
					model: "fixture",
					usage: createEmptyUsage(),
					stopReason: timeout === undefined ? "stop" : "toolUse",
					timestamp: turn,
				};
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
				return stream;
			},
		);
		expect(executed).toEqual([60, 60, 120, 240]);
		const results = messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(5);
		for (const result of results.slice(0, 4)) {
			expect(retainedToolInvocation(result.details)).toMatchObject({
				execution: "completed", operationStatus: "error", failureCode: "timeout",
			});
		}
		// Replay actual raw operation outcomes, not createToolFailureResult's synthetic memory.
		for (const completed of [1, 4]) {
			const last = messages.indexOf(results[completed - 1]);
			const persisted = JSON.parse(JSON.stringify(messages.slice(0, last + 1))) as AgentMessage[];
			const resumed = new ToolFailureRecoveryGate();
			resumed.restoreFromMessages(persisted, [runtimeTool]);
			expect(resumed.admit(runtimeTool, { command: "fixture", timeout: completed === 1 ? 120 : 480 }, undefined))
				.toMatchObject({ kind: completed === 1 ? "allowed" : "blocked" });
		}
		expect(results.at(-1)?.content).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "text", text: expect.stringContaining('"failure_code":"repeated_failed_operation"') }),
		]));
	});

	it("admits a real increase from the default for a native operation outcome", () => {
		const gate = new ToolFailureRecoveryGate();
		const args = { command: "fixture" };
		const record = timeoutFailure(args);
		expect(record.phase).toBe("execution");
		gate.apply({ kind: "unproductive", tool, args, record });
		expect(gate.admit(tool, args, undefined)).toEqual({ kind: "allowed" });
		expect(gate.admit(tool, { ...args, timeout: 240 }, undefined)).toEqual({ kind: "allowed" });
	});

	it.each([
		[{ command: "fixture", timeout: 0.001 }, { command: "fixture", timeout: 0.002 }],
		[{ command: "fixture", maxWaitMs: 1000 }, { command: "fixture", maxWaitMs: 2000 }],
	])("refuses growth that does not change the executor's timeout", (before, after) => {
		const gate = new ToolFailureRecoveryGate();
		gate.apply({ kind: "unproductive", tool, args: before, record: timeoutFailure(before) });
		expect(gate.admit(tool, before, undefined)).toEqual({ kind: "allowed" });
		expect(gate.admit(tool, after, undefined)).toMatchObject({ kind: "blocked" });
	});

	it.each([
		() => undefined,
		() => Number.NaN,
		() => 0,
		() => Number.POSITIVE_INFINITY,
		() => {
			throw new Error("projection unavailable");
		},
	])("does not infer an argument bound when its declared owner cannot supply one", (getTimeoutMs) => {
		const unavailable = { ...tool, failureRecovery: { getTimeoutMs } };
		const gate = new ToolFailureRecoveryGate();
		const args = { command: "fixture", timeout: 60 };
		gate.apply({ kind: "unproductive", tool: unavailable, args, record: timeoutFailure(args) });
		expect(gate.admit(unavailable, args, undefined)).toEqual({ kind: "allowed" });
		expect(gate.admit(unavailable, { ...args, timeout: 120 }, undefined)).toMatchObject({ kind: "blocked" });
	});

	it("keeps a permanent operation outcome blocked despite a real timeout increase", () => {
		const gate = new ToolFailureRecoveryGate();
		const args = { command: "fixture", timeout: 60 };
		const record = describeOperationOutcome(tool.name, args, "exit_1", "Command exited with code 1");
		gate.apply({ kind: "unproductive", tool, args, record });
		expect(gate.admit(tool, { ...args, timeout: 120 }, undefined)).toMatchObject({ kind: "blocked" });
	});

	it.each([0, 70])("retains spent escalations after restore with %s intervening failures", (count) => {
		const messages: AgentMessage[] = [];
		const gate = new ToolFailureRecoveryGate();
		for (const timeout of [60, 60, 120, 240]) {
			const args = { command: "fixture", timeout };
			expect(gate.admit(tool, args, undefined, messages)).toEqual({ kind: "allowed" });
			const record = timeoutFailure(args);
			gate.apply({ kind: "unproductive", tool, args, record });
			appendFailure(messages, args, record);
		}
		for (let index = 0; index < count; index++) {
			const args = { command: `other-${index}`, timeout: 60 };
			const record = timeoutFailure(args);
			gate.apply({ kind: "unproductive", tool, args, record });
			appendFailure(messages, args, record);
		}
		const resumed = new ToolFailureRecoveryGate();
		resumed.restoreFromMessages(JSON.parse(JSON.stringify(messages)) as AgentMessage[], [tool]);
		for (const candidate of [gate, resumed]) {
			expect(candidate.admit(tool, { command: "fixture", timeout: 480 }, undefined, messages)).toMatchObject({
				kind: "blocked",
			});
			candidate.noteWorldAdvance();
			expect(candidate.admit(tool, { command: "fixture", timeout: 480 }, undefined, messages)).toEqual({ kind: "allowed" });
		}
	});

	it("does not turn a refused larger bound into the last executed baseline", () => {
		const messages: AgentMessage[] = [];
		const args = { command: "fixture", timeout: 60 };
		const record = rememberToolFailure(
			new Map<string, ToolFailureMemoryRecord>(),
			tool.name,
			args,
			"failed",
			"timeout",
			"Increase timeout",
			undefined,
			"timeout",
		);
		appendFailure(messages, args, record);
		appendFailure(messages, args, record);
		appendFailure(messages, { ...args, timeout: 119 }, record, true);
		const gate = new ToolFailureRecoveryGate();
		gate.restoreFromMessages(messages, [tool]);
		expect(gate.admit(tool, { ...args, timeout: 120 }, undefined)).toEqual({ kind: "allowed" });
	});
});
