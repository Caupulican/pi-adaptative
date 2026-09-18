import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { rememberToolFailure, type ToolFailureMemoryRecord } from "../src/tool-failure-memory.ts";
import { ToolFailureRecoveryGate } from "../src/tool-failure-recovery-gate.ts";
import type { AgentTool } from "../src/types.ts";

const parameters = Type.Object({ command: Type.String() });
const tool: AgentTool<typeof parameters> = {
	name: "bound_fixture",
	label: "Bound fixture",
	description: "Admission-only timeout identity fixture",
	parameters,
	async execute() {
		throw new Error("Admission tests must not execute tools");
	},
};

function failedGate(bounds: Record<string, number>): ToolFailureRecoveryGate {
	const gate = new ToolFailureRecoveryGate();
	const args = { command: "fixture", ...bounds };
	const record = rememberToolFailure(
		new Map<string, ToolFailureMemoryRecord>(),
		tool.name,
		args,
		"failed",
		"timeout",
		"Narrow the operation or increase its timeout.",
		undefined,
		"timeout",
	);
	gate.apply({ kind: "unproductive", tool, args, record });
	// Spend the independent unchanged retry so only bound escalation is under test.
	expect(gate.admit(tool, args, undefined)).toEqual({ kind: "allowed" });
	return gate;
}

describe("timeout escalation field identity", () => {
	it.each([{ timeout: 60, maxWaitMs: 120 }, { timeoutMs: 120 }, { waitSeconds: 120 }])(
		"does not buy escalation by changing the bound field: %j",
		(bounds) => {
			const gate = failedGate({ timeout: 60 });
			expect(gate.admit(tool, { command: "fixture", ...bounds }, undefined)).toMatchObject({ kind: "blocked" });
			// A refused substitution does not consume a valid same-field repair.
			expect(gate.admit(tool, { command: "fixture", timeout: 120 }, undefined)).toEqual({ kind: "allowed" });
		},
	);

	it("does not select a numeric maximum from an ambiguous baseline", () => {
		const gate = failedGate({ timeout: 60, maxWaitMs: 120 });
		expect(gate.admit(tool, { command: "fixture", timeout: 240 }, undefined)).toMatchObject({ kind: "blocked" });
		gate.noteWorldAdvance();
		expect(gate.admit(tool, { command: "fixture", timeout: 240 }, undefined)).toEqual({ kind: "allowed" });
	});

	it("preserves the two-escalation limit for the same exact field", () => {
		const gate = failedGate({ timeout_ms: 60 });
		for (const timeout_ms of [120, 240]) {
			expect(gate.admit(tool, { command: "fixture", timeout_ms }, undefined)).toEqual({ kind: "allowed" });
		}
		expect(gate.admit(tool, { command: "fixture", timeout_ms: 480 }, undefined)).toMatchObject({ kind: "blocked" });
	});

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 61])("rejects a non-material bound %s", (timeout) => {
		const gate = failedGate({ timeout: 60 });
		expect(gate.admit(tool, { command: "fixture", timeout }, undefined)).toMatchObject({ kind: "blocked" });
	});
});
