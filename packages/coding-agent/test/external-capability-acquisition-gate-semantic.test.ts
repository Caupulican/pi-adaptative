import { describe, expect, it } from "vitest";
import {
	ACQUISITION_DECISION_PROGRAM,
	ExternalCapabilityAcquisitionGate,
} from "../src/core/acquisition/external-capability-acquisition-gate.ts";
import { compileExecutionCharter } from "../src/core/autonomy/execution-charter.ts";

const request = {
	objectiveId: "obj-1",
	request: "Add left-pad and use it to format the report.",
	source: "left-pad@1.3.0",
	command: "npm install left-pad@1.3.0",
};

/** A decision engine answering each question with a fixed probability, recording the state it saw. */
function engine(answers: Record<string, number>) {
	const states: unknown[] = [];
	return {
		states,
		evaluate: async (_program: unknown, state?: Record<string, unknown>) => {
			states.push(state);
			return {
				answers: Object.fromEntries(Object.entries(answers).map(([id, noul]) => [id, { type: "noul", noul }])),
			};
		},
	};
}

const LEGITIMATE = {
	acquisition_required_for_objective: 0.91,
	exceeds_request: 0.13,
	runs_unverified_download: 0.08,
	source_mismatch: 0.27,
};
const grantingCharter = () =>
	compileExecutionCharter({ objectiveId: "obj-1", prompt: "install the dependencies and run the build" });

describe("external acquisition gate: the semantic questions are a real program", () => {
	it("hands the engine a program with decisions, and an unverified download rewrites the install", async () => {
		const programs: unknown[] = [];
		const gate = new ExternalCapabilityAcquisitionGate({
			charter: grantingCharter(),
			decisionEngine: {
				evaluate: async (program) => {
					programs.push(program);
					return {
						answers: {
							acquisition_required_for_objective: { type: "noul", noul: 0.9 },
							exceeds_request: { type: "noul", noul: 0.1 },
							runs_unverified_download: { type: "noul", noul: 0.98 },
							source_mismatch: { type: "noul", noul: 0.1 },
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
			"exceeds_request",
			"runs_unverified_download",
			"source_mismatch",
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

	it("asks over the owner's request and the exact command, and sends no undefined field", async () => {
		const fake = engine(LEGITIMATE);
		const gate = new ExternalCapabilityAcquisitionGate({ charter: grantingCharter(), decisionEngine: fake });
		const { request: _omitted, ...withoutRequest } = request;
		await gate.evaluateAcquisition(withoutRequest);
		await gate.evaluateAcquisition(request);
		expect(fake.states[0]).toEqual({
			request: "(no request recorded)",
			command: "npm install left-pad@1.3.0",
			source: "left-pad@1.3.0",
		});
		expect(fake.states[1]).toMatchObject({ request: "Add left-pad and use it to format the report." });
	});

	it("allows an install the request needs, and denies one it clearly does not need or that mismatches", async () => {
		const decide = (answers: Record<string, number>) =>
			new ExternalCapabilityAcquisitionGate({
				charter: grantingCharter(),
				decisionEngine: engine(answers),
			}).evaluateAcquisition(request);
		expect((await decide(LEGITIMATE)).disposition).toBe("allow");
		expect((await decide({ ...LEGITIMATE, acquisition_required_for_objective: 0.03 })).disposition).toBe("deny");
		expect((await decide({ ...LEGITIMATE, source_mismatch: 0.94 })).disposition).toBe("deny");
		expect((await decide({ ...LEGITIMATE, exceeds_request: 0.96 })).disposition).toBe("rewrite_safe_route");
		// Unsettled answers change nothing: the request's need at 0.37 is not a clear no.
		expect(
			(await decide({ ...LEGITIMATE, acquisition_required_for_objective: 0.37, source_mismatch: 0.67 })).disposition,
		).toBe("allow");
	});
});
