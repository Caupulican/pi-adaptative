import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	createRepeatedToolFailureResult,
	createToolFailureMemoryTracker,
	createToolFailureResult,
	rememberToolFailure,
} from "../src/tool-failure-memory.ts";
import { ToolFailureRecoveryGate } from "../src/tool-failure-recovery-gate.ts";

describe("tool failure replay correction", () => {
	it.each(["empty", "missing", "throwing"])("keeps host guidance when the adapter correction is %s", (mode) => {
		const tool = {
			name: "scope_probe",
			label: "Scope probe",
			description: "Probe a scoped operation",
			parameters: Type.Object({}),
			failureRecovery: {
				getFailureCorrection: () => {
					if (mode === "throwing") throw new Error("adapter unavailable");
					return mode === "empty" ? "  " : undefined;
				},
			},
			async execute() {
				return { content: [], details: {} };
			},
		};
		const plan = new ToolFailureRecoveryGate().planFailure(
			tool,
			{},
			{ failureCode: "scope_rejected", message: "scope 42" },
			[tool],
		);
		expect(plan.correction).toBeUndefined();
		expect(plan.guidance).toContain("Do the corrective work first");
	});

	it("uses a tool-owned repair independently of rendered diagnostic text", () => {
		const tool = {
			name: "scope_probe",
			label: "Scope probe",
			description: "Probe a scoped operation",
			parameters: Type.Object({}),
			failureRecovery: {
				getFailureCorrection: () => "Select an explicit project path before retrying.",
			},
			async execute() {
				return { content: [], details: {} };
			},
		};
		const gate = new ToolFailureRecoveryGate();
		for (const message of ["scope 42", "different diagnostic wording"]) {
			expect(gate.planFailure(tool, {}, { failureCode: "scope_rejected", message }, [tool])).toMatchObject({
				correction: "Select an explicit project path before retrying.",
			});
		}
	});

	it.each([undefined, "The requested search scope is unavailable."])(
		"retains actionable correction through repeated refusals with diagnostic %s",
		(diagnostic) => {
			const correction = "Use an explicit repository path and exclude the private credential file.";
			const record = rememberToolFailure(
				createToolFailureMemoryTracker([]),
				"search",
				{ path: "~" },
				"failed",
				"scope_rejected",
				correction,
				diagnostic,
				"policy",
			);
			const first = createToolFailureResult(record);
			expect(first.content).toEqual([expect.objectContaining({ text: expect.stringContaining(correction) })]);
			const replay = createRepeatedToolFailureResult(record);
			const repeated = createRepeatedToolFailureResult(replay.details.piToolFailureMemory);
			for (const result of [replay, repeated]) {
				expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining(correction) })]);
				expect(result.content).toEqual([
					expect.objectContaining({ text: expect.stringContaining("Not executed: unchanged") }),
				]);
				expect(result.details.piToolFailureMemory.correction).toBe(correction);
				expect(result.details.piToolFailureMemory.failureCode).toBe("scope_rejected");
			}
		},
	);
});
