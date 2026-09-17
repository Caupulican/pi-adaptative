import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { rememberToolFailure, type ToolFailureMemoryRecord } from "../src/tool-failure-memory.ts";
import { ToolFailureRecoveryGate } from "../src/tool-failure-recovery-gate.ts";
import {
	MANDATORY_TOOL_FAILURE_RECOVERY_PROTOCOL_PROMPT,
	TOOL_FAILURE_RETRY_MODEL_RULE,
} from "../src/tool-failure-recovery-protocol.ts";
import type { AgentTool } from "../src/types.ts";

const parameters = Type.Object({ command: Type.String() });
const tool: AgentTool<typeof parameters> = {
	name: "retry_fixture",
	label: "Retry fixture",
	description: "Admission and guidance fixture",
	parameters,
	async execute() {
		throw new Error("Admission tests must not execute tools");
	},
};

describe("shared retry instructions and host admission", () => {
	it("teaches the unspent allowance alongside the world-advance rule", () => {
		expect(TOOL_FAILURE_RETRY_MODEL_RULE).toContain("only with an unspent harness allowance");
		expect(TOOL_FAILURE_RETRY_MODEL_RULE).toContain("any later tool success, or a new user turn");
		expect(MANDATORY_TOOL_FAILURE_RECOVERY_PROTOCOL_PROMPT).toContain(TOOL_FAILURE_RETRY_MODEL_RULE);
		expect(MANDATORY_TOOL_FAILURE_RECOVERY_PROTOCOL_PROMPT).not.toContain(
			"Retry unchanged only after any other tool succeeds or a new user turn.",
		);
		expect(MANDATORY_TOOL_FAILURE_RECOVERY_PROTOCOL_PROMPT.length).toBeLessThan(500);
	});

	it.each(["timeout", "exit_1"] as const)("keeps the %s allowance bounded by admission", (failureCode) => {
		const gate = new ToolFailureRecoveryGate();
		const tracker = new Map<string, ToolFailureMemoryRecord>();
		const args = { command: "fixture" };
		const phase = failureCode === "timeout" ? "timeout" : "execution";
		const failure = rememberToolFailure(
			tracker,
			tool.name,
			args,
			"failed",
			failureCode,
			"Use the current recovery guidance.",
			undefined,
			phase,
		);
		gate.apply({ kind: "unproductive", tool, args, record: failure });
		const evidence = { failureCode, message: "Fixture failure" };
		if (failureCode === "timeout") {
			expect(gate.planFailure(tool, args, evidence, [tool]).guidance).toContain("1 immediate unchanged retry");
			expect(gate.admit(tool, args, failure)).toEqual({ kind: "allowed" });
			gate.apply({ kind: "unproductive", tool, args, record: failure });
			expect(gate.planFailure(tool, args, evidence, [tool]).guidance).toContain("Unchanged retry spent");
		} else {
			expect(gate.planFailure(tool, args, evidence, [tool]).guidance).not.toContain("immediate unchanged retry");
		}
		// Neither a spent transient allowance nor a permanent error permits an unchanged replay.
		expect(gate.admit(tool, args, failure)).toMatchObject({ kind: "blocked" });
		gate.noteWorldAdvance();
		expect(gate.admit(tool, args, failure)).toEqual({ kind: "allowed" });
	});
});
