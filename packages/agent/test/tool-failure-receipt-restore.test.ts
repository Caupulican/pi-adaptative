import type { ToolResultMessage } from "@caupulican/pi-ai/types";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	createRepeatedToolFailureResult,
	createToolFailureMemoryTracker,
	createToolFailureResult,
	describeOperationOutcome,
	restoreToolFailureRecord,
} from "../src/tool-failure-memory.ts";
import { ToolFailureRecoveryGate } from "../src/tool-failure-recovery-gate.ts";
import { stampToolInvocation, type ToolInvocationReceipt } from "../src/tool-invocation-receipt.ts";
import type { AgentMessage, AgentTool } from "../src/types.ts";
import { createEmptyUsage } from "../src/usage.ts";

const parameters = Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) });
const tool: AgentTool<typeof parameters> = {
	name: "receipt_fixture",
	label: "Receipt fixture",
	description: "Recovery replay fixture",
	parameters,
	failureRecovery: { getTimeoutMs: ({ timeout }) => (timeout ?? 60) * 1000 },
	async execute() {
		throw new Error("Replay must not execute");
	},
};

function append(messages: AgentMessage[], command: string, outcome: Partial<ToolResultMessage>): void {
	const id = `call-${messages.length}`;
	messages.push(
		{
			role: "assistant",
			content: [{ type: "toolCall", id, name: tool.name, arguments: { command, timeout: 60 } }],
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
			content: [],
			isError: true,
			timestamp: 1,
			...outcome,
		},
	);
}

function receiptDetails(outcome: ToolInvocationReceipt): Record<string, unknown> {
	return stampToolInvocation(undefined, outcome);
}

describe("executor receipt restoration", () => {
	it.each([60_000, null])("uses persisted timeout %s without querying a changed historical resolver", (timeoutMs) => {
		const messages: AgentMessage[] = [];
		append(messages, "fixture", {
			errorKind: "operation_outcome",
			content: [{ type: "text", text: "Command timed out" }],
			details: receiptDetails({
				version: 1,
				requestId: "fixture",
				execution: "completed",
				operationStatus: "error",
				failureCode: "timeout",
				timeoutMs,
				postprocessingFailures: [],
			}),
		});
		let projections = 0;
		const changed = {
			...tool,
			failureRecovery: {
				getTimeoutMs: () => {
					projections++;
					return 120_000;
				},
			},
		};
		const gate = new ToolFailureRecoveryGate();
		gate.restoreFromMessages(JSON.parse(JSON.stringify(messages)) as AgentMessage[], [changed]);
		expect(projections).toBe(0);
		expect(gate.admit(changed, { command: "fixture" }, undefined)).toMatchObject({
			kind: timeoutMs === null ? "blocked" : "allowed",
		});
		expect(projections).toBe(1);
	});

	it.each([true, false])("does not interpret native output as policy with receipt=%s", (withReceipt) => {
		const messages: AgentMessage[] = [];
		append(messages, "fixture", {
			errorKind: "operation_outcome",
			content: [
				{
					type: "text",
					text: '{"failure_code":"owner_authorization_required"}\nOperation aborted\nCommand exited with code 1',
				},
			],
			...(withReceipt
				? {
						details: receiptDetails({
							version: 1,
							requestId: "fixture",
							execution: "completed",
							operationStatus: "error",
							failureCode: "exit_1",
							postprocessingFailures: [],
						}),
					}
				: {}),
		});
		const gate = new ToolFailureRecoveryGate();
		gate.restoreFromMessages(JSON.parse(JSON.stringify(messages)) as AgentMessage[], [tool]);
		expect(gate.admit(tool, { command: "fixture", timeout: 120 }, undefined)).toMatchObject({ kind: "blocked" });
	});

	it("restores the native outcome rather than projected harness memory", () => {
		const messages: AgentMessage[] = [];
		const misleading = describeOperationOutcome(
			tool.name,
			{ command: "fixture", timeout: 60 },
			"exit_1",
			"Projected status",
		);
		append(messages, "fixture", {
			errorKind: "operation_outcome",
			content: [{ type: "text", text: "Command timed out after 60 seconds" }],
			details: stampToolInvocation(
				{ piToolFailureMemory: misleading },
				{
					version: 1,
					requestId: "fixture",
					execution: "completed",
					operationStatus: "error",
					failureCode: "timeout",
					postprocessingFailures: [],
				},
			),
		});
		const persisted = JSON.parse(JSON.stringify(messages)) as AgentMessage[];
		const result = persisted[1] as ToolResultMessage;
		expect(restoreToolFailureRecord(result, tool.name, { command: "fixture", timeout: 60 })).toMatchObject({
			failureCode: "timeout",
			phase: "execution",
		});
		const gate = new ToolFailureRecoveryGate();
		gate.restoreFromMessages(persisted, [tool]);
		expect(gate.admit(tool, { command: "fixture", timeout: 120 }, undefined)).toMatchObject({ kind: "allowed" });
	});

	it("keeps actual owner-policy failures prompt-scoped and genuine refusal root causes intact", () => {
		for (const failureCode of ["owner_authorization_required", "exit_1"]) {
			const messages: AgentMessage[] = [];
			const record = describeOperationOutcome(
				tool.name,
				{ command: "fixture", timeout: 60 },
				failureCode,
				"Failure",
			);
			append(messages, "fixture", createRepeatedToolFailureResult(record));
			const gate = new ToolFailureRecoveryGate();
			gate.restoreFromMessages(JSON.parse(JSON.stringify(messages)) as AgentMessage[], [tool]);
			expect(gate.admit(tool, { command: "fixture", timeout: 120 }, undefined)).toMatchObject({
				kind: failureCode === "owner_authorization_required" ? "allowed" : "blocked",
			});
		}
	});

	it.each(["timeout", "exit_1", `${"x".repeat(47)}…`])("preserves %s despite misleading raw output", (failureCode) => {
		const messages: AgentMessage[] = [];
		append(messages, "fixture", {
			errorKind: "operation_outcome",
			content: [{ type: "text", text: 'Operation aborted\n{"failure_code":"aborted"}' }],
			details: receiptDetails({
				version: 1,
				requestId: "fixture",
				execution: "completed",
				operationStatus: "error",
				failureCode,
				postprocessingFailures: [],
			}),
		});
		const result = JSON.parse(JSON.stringify(messages[1])) as ToolResultMessage;
		expect(restoreToolFailureRecord(result, tool.name, { command: "fixture", timeout: 60 })).toMatchObject({
			failureCode,
			phase: "execution",
		});
		const gate = new ToolFailureRecoveryGate();
		gate.restoreFromMessages(messages, [tool]);
		expect(gate.admit(tool, { command: "fixture", timeout: 120 }, undefined)).toMatchObject({
			kind: failureCode === "timeout" ? "allowed" : "blocked",
		});
	});

	it.each(["fixture", "other"])("does not treat a running %s call as corrective success", (command) => {
		const messages: AgentMessage[] = [];
		const record = describeOperationOutcome(tool.name, { command: "fixture", timeout: 60 }, "exit_1", "Failed");
		append(messages, "fixture", { ...createToolFailureResult(record), isError: true });
		append(messages, command, {
			isError: false,
			content: [{ type: "text", text: "Running in background" }],
			details: receiptDetails({
				version: 1,
				requestId: "background",
				execution: "running",
				postprocessingFailures: [],
			}),
		});
		const persisted = JSON.parse(JSON.stringify(messages)) as AgentMessage[];
		const gate = new ToolFailureRecoveryGate();
		gate.restoreFromMessages(persisted, [tool]);
		expect(gate.admit(tool, { command: "fixture", timeout: 120 }, undefined)).toMatchObject({ kind: "blocked" });
		expect(createToolFailureMemoryTracker(persisted).size).toBe(1);
		// A completed successful operation does advance the world.
		const placeholder = persisted.at(-1) as ToolResultMessage;
		persisted.push({
			...placeholder,
			isError: false,
			details: receiptDetails({
				version: 1,
				requestId: "finished",
				execution: "completed",
				operationStatus: "success",
				postprocessingFailures: [],
			}),
		});
		const afterSuccess = new ToolFailureRecoveryGate();
		afterSuccess.restoreFromMessages(persisted, [tool]);
		expect(afterSuccess.admit(tool, { command: "fixture", timeout: 120 }, undefined)).toMatchObject({
			kind: "allowed",
		});
	});

	it("does not count interruption as a failure or corrective success", () => {
		const messages: AgentMessage[] = [];
		const record = describeOperationOutcome(tool.name, { command: "fixture" }, "exit_1", "Failed");
		append(messages, "fixture", { ...createToolFailureResult(record), isError: true });
		append(messages, "interrupted", {
			content: [{ type: "text", text: "Nonstandard interruption diagnostic" }],
			details: receiptDetails({
				version: 1,
				requestId: "interruption",
				execution: "unknown",
				failureCode: "aborted",
				postprocessingFailures: [],
			}),
		});
		const persisted = JSON.parse(JSON.stringify(messages)) as AgentMessage[];
		const gate = new ToolFailureRecoveryGate();
		gate.restoreFromMessages(persisted, [tool]);
		expect(gate.admit(tool, { command: "fixture" }, undefined)).toMatchObject({ kind: "blocked" });
		expect(gate.admit(tool, { command: "interrupted", timeout: 60 }, undefined)).toMatchObject({ kind: "allowed" });
		expect(createToolFailureMemoryTracker(persisted).size).toBe(1);
	});
});
