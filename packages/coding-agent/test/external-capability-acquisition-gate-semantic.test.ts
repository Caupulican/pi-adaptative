import { describe, expect, it } from "vitest";
import {
	ACQUISITION_DECISION_PROGRAM,
	ExternalCapabilityAcquisitionGate,
} from "../src/core/acquisition/external-capability-acquisition-gate.ts";
import { compileExecutionCharter } from "../src/core/autonomy/execution-charter.ts";

const request = { objectiveId: "obj-1", source: "left-pad@1.3.0", command: "npm install left-pad@1.3.0" };
const grantingCharter = () =>
	compileExecutionCharter({ objectiveId: "obj-1", prompt: "install the dependencies and run the build" });

describe("external acquisition gate: the semantic questions are a real program", () => {
	it("hands the engine a program with decisions, and a preferred safer route rewrites the install", async () => {
		const programs: unknown[] = [];
		const gate = new ExternalCapabilityAcquisitionGate({
			charter: grantingCharter(),
			decisionEngine: {
				evaluate: async (program) => {
					programs.push(program);
					return {
						answers: {
							acquisition_required_for_objective: { type: "noul", noul: 0.9 },
							side_effects_proportionate: { type: "noul", noul: 0.9 },
							safer_existing_route_preferred: { type: "noul", noul: 0.95 },
							source_matches_requested_capability: { type: "noul", noul: 0.9 },
						},
					};
				},
			},
		});
		const decision = await gate.evaluateAcquisition(request);
		expect(programs).toEqual([ACQUISITION_DECISION_PROGRAM]);
		const program = programs[0] as { program_id: string; decisions: readonly { id: string; instruction: string }[] };
		expect(program.program_id).toBe("external_capability_acquisition");
		expect(program.decisions.map((decision) => decision.id)).toEqual([
			"acquisition_required_for_objective",
			"side_effects_proportionate",
			"safer_existing_route_preferred",
			"source_matches_requested_capability",
		]);
		for (const item of program.decisions) expect(item.instruction.length).toBeGreaterThan(20);
		expect(decision.disposition).toBe("rewrite_safe_route");
		expect(decision.allowed).toBe(false);
	});

	it("reports an engine failure instead of swallowing it, and keeps the conservative stance", async () => {
		const failures: unknown[] = [];
		const gate = new ExternalCapabilityAcquisitionGate({
			charter: grantingCharter(),
			decisionEngine: {
				evaluate: async () => {
					throw new Error("engine offline");
				},
			},
			onSemanticFailure: (error) => failures.push(error),
		});
		const decision = await gate.evaluateAcquisition(request);
		expect(failures).toHaveLength(1);
		expect((failures[0] as Error).message).toBe("engine offline");
		// No mandatory plane: the deterministic screening's allow stands, nothing pretended a verdict.
		expect(decision.disposition).toBe("allow");
	});

	it("under a mandatory plane a failed evaluation cannot become a direct allow", async () => {
		const gate = new ExternalCapabilityAcquisitionGate({
			charter: grantingCharter(),
			systemOneRequired: true,
			decisionEngine: {
				evaluate: async () => {
					throw new Error("engine offline");
				},
			},
		});
		const decision = await gate.evaluateAcquisition(request);
		expect(decision.allowed).toBe(false);
		expect(["rewrite_safe_route", "deny"]).toContain(decision.disposition);
	});
});
