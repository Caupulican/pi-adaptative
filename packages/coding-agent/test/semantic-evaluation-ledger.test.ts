import { describe, expect, it } from "vitest";
import type { DecisionEvaluation } from "../src/core/decision/evaluation.ts";
import { DEFAULT_STEERING_POLICY } from "../src/core/steering/policy.ts";
import { SystemOneSteeringPlane } from "../src/core/steering/system-one-steering-plane.ts";
import type { SteeringCertificate } from "../src/core/steering/types.ts";
import {
	semanticEvaluationLabel,
	verdictFromCertificate,
	verdictFromEvaluation,
} from "../src/core/system-one/semantic-evaluation-ledger.ts";
import { SemanticPlaneHealthRecorder } from "../src/core/system-one/semantic-plane-health.ts";

const confidence = { value: 0.95, provenance: "native_calibrated" as const, isCalibrated: true };

function evaluation(overrides: Partial<DecisionEvaluation> = {}): DecisionEvaluation {
	return {
		schema_version: "2.0",
		program: { id: "pi:steering:program:JEV-001:1.0", version: "1.0" },
		engine: { id: "jev", model: "jev-1.13.0", confidence_provenance: "native_calibrated" },
		results: {},
		timestamp: "2026-09-20T10:00:00.000Z",
		...overrides,
	};
}

describe("semanticEvaluationLabel", () => {
	it("names every family the source declares and degrades to the id otherwise", () => {
		expect(semanticEvaluationLabel("pi:steering:program:JEV-001:1.0")).toBe("objective intake");
		expect(semanticEvaluationLabel("pi:steering:program:JEV-004:1.0")).toBe("objective route");
		expect(semanticEvaluationLabel("pi:steering:program:JEV-WORKER-SUPERVISION:1.0")).toBe("worker supervision");
		expect(semanticEvaluationLabel("pi:steering:program:JEV-013:1.0")).toBe("JEV-013");
		expect(semanticEvaluationLabel("system-one:tool_gate")).toBe("tool gate");
		expect(semanticEvaluationLabel("system-one:completion_challenge")).toBe("completion challenge");
		expect(semanticEvaluationLabel("rule_program_1758400000")).toBe("project rules");
		expect(semanticEvaluationLabel("retention_eval_1")).toBe("retention");
		expect(semanticEvaluationLabel("supervision_eval_1")).toBe("worker supervision");
		expect(semanticEvaluationLabel("something-else")).toBe("something-else");
	});
});

describe("verdict extraction", () => {
	it("reads a choice or a proposed function call as the verdict and one reason per result", () => {
		const booleans = verdictFromEvaluation(
			evaluation({
				results: {
					objective_clear: {
						kind: "boolean",
						probabilityTrue: 0.91,
						direction: "required_true",
						band: "soft_pass",
						confidence,
					},
				},
			}),
		);
		expect(booleans.verdict).toBeUndefined();
		expect(booleans.reasons).toEqual(["objective_clear: P(yes)=0.91 · soft pass (needs yes)"]);

		const chosen = verdictFromEvaluation(
			evaluation({
				results: {
					route: { kind: "choice", selected: "repair", distribution: { repair: 0.8 }, margin: 0.6, confidence },
					scope: { kind: "set", selected: ["a", "b"], memberships: {}, confidence },
				},
			}),
		);
		expect(chosen.verdict).toBe("repair");
		expect(chosen.reasons).toEqual(["route: repair", "scope: a, b"]);

		const call = verdictFromEvaluation(
			evaluation({
				proposedFunctionCall: {
					kind: "function_call",
					name: "replan",
					arguments: {},
					confidence,
					argumentConfidences: {},
				},
				results: { route: { kind: "choice", selected: "repair", distribution: {}, margin: 0.1, confidence } },
			}),
		);
		expect(call.verdict).toBe("replan");
	});

	it("reads a certificate's semantic outcome and prepends the directive when it is not a pass", () => {
		const base: SteeringCertificate = {
			schema_version: "1.0",
			certificate_id: "SCERT-1",
			objective_id: "obj",
			checkpoint_id: "JEV-024",
			state_digest: "d",
			evidence_revision: 1,
			policy: { id: "p", version: "1", digest: "x" },
			question_pack: { id: "pi:steering:pack:objective_route:1.0", version: "1.0", digest: "y" },
			engine: { provider: "typesafe", model: "jev" },
			answers: {},
			directive: "proceed",
			semantic_outcome: "pass",
			created_at: "2026-09-20T10:00:00.000Z",
		};
		expect(verdictFromCertificate(base)).toEqual({ verdict: "pass", reasons: [] });
		expect(
			verdictFromCertificate({ ...base, semantic_outcome: "repair", failed_semantic_predicates: ["tests_pass"] }),
		).toEqual({ verdict: "repair", reasons: ["directive: proceed", "tests_pass"] });
	});
});

describe("SemanticPlaneHealthRecorder as the one sink", () => {
	it("bounds the ring, notes verdicts after settlement, and forwards to the durable ledger", () => {
		let now = 1000;
		const recorder = new SemanticPlaneHealthRecorder(() => now);
		const durable: string[] = [];
		recorder.bindDurable(() => ({
			start: (record) => durable.push(`start:${record.label}:${record.model ?? "-"}`),
			settle: (record) => durable.push(`settle:${record.outcome}:${record.durationMs}`),
			noteVerdict: (_id, verdict) => durable.push(`verdict:${verdict}`),
		}));
		const seen: string[] = [];
		recorder.subscribe((record) => seen.push(`${record.label}=${record.verdict ?? record.outcome}`));
		const id = recorder.start({ programId: "system-one:preflight", model: "jev-1.13.0" });
		now = 2500;
		recorder.settleOk(id);
		recorder.noteVerdict(id, "allow");
		expect(durable).toEqual(["start:preflight:jev-1.13.0", "settle:ok:1500", "verdict:allow"]);
		expect(seen).toEqual(["preflight=ok", "preflight=allow"]);
		for (let i = 0; i < 40; i++) recorder.settleOk(recorder.start({ programId: "retention_eval_x" }));
		expect(recorder.getRecentEvaluations()).toHaveLength(32);
		expect(recorder.getHealth(true).state).toBe("ok");
	});

	it("records the steering plane's own evaluations, including cancellation, through the observer", async () => {
		const recorder = new SemanticPlaneHealthRecorder();
		const controller = new AbortController();
		const plane = new SystemOneSteeringPlane({
			decisionEngine: {
				id: "stub",
				model: "stub",
				capabilities: () => ({
					boolean: true,
					choice: true,
					score: true,
					set: true,
					fullDistributions: true,
					parallelIndependentDecisions: true,
					confidenceProvenance: "native_calibrated",
				}),
				evaluate: async () => {
					controller.abort();
					const error = new Error("aborted");
					error.name = "AbortError";
					throw error;
				},
			},
			policy: { ...DEFAULT_STEERING_POLICY, mode: "system_one_optional" },
		});
		plane.setEvaluationObserver(recorder);
		await expect(
			plane.requireCertificate("JEV-001", { objective: "x" }, { signal: controller.signal, requirePass: false }),
		).rejects.toThrow();
		expect(recorder.getHealth(true).state).toBe("unknown");
		expect(recorder.getLastEvaluation()).toMatchObject({ label: "objective intake", outcome: "cancelled" });
	});
});
