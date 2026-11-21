import { expect, it } from "vitest";
import { composeObjectiveRoute } from "../src/core/objective-execution/objective-route-policy.ts";
import { readObjectiveWorkClass } from "../src/core/steering/programs.ts";
import { SystemOneSteeringPlane } from "../src/core/steering/system-one-steering-plane.ts";

const noul = (probability: number) => ({ type: "noul", noul: probability });
const grounded = {
	missing_work_class: { choice: "investigate", probabilities: { investigate: 0.55, implement: 0.45 } },
	work_remaining: noul(0.98),
	evidence_sufficient: noul(0.98),
	independent_worker_required: noul(0.02),
	capability_escalation_required: noul(0.02),
};

it("leaves a grounded, unsettled method to the current agent within the objective's existing controls", () => {
	const missingWorkClass = readObjectiveWorkClass(grounded);
	const input = { cycleId: "cycle", objectiveId: "task", semantic: { missingWorkClass } };
	expect(missingWorkClass).toBe("continue_current_work");
	expect(composeObjectiveRoute(input).reason_codes).toEqual(["work_method_unsettled"]);
	expect(composeObjectiveRoute({ ...input, ownerRequired: true }).route).toBe("owner_required");
	expect(composeObjectiveRoute({ ...input, budgetExhausted: true }).route).toBe("cancel");
});

it.each([
	{ work_remaining: { noul: 0.5 } },
	{ evidence_sufficient: undefined },
	{ evidence_sufficient: { noul: 0.5 } },
	{ independent_worker_required: { noul: 0.98 } },
	{ independent_worker_required: { noul: 0.5 } },
	{ capability_escalation_required: { noul: 0.5 } },
	{ capability_escalation_required: { noul: 0.98 } },
	{ missing_work_class: { choice: "implement" } },
	{ missing_work_class: { choice: "unknown_method", probabilities: { unknown_method: 0.98 } } },
	{ missing_work_class: { choice: "completion_candidate", probabilities: { completion_candidate: 0.55 } } },
	{ missing_work_class: { choice: "resolve_capability", probabilities: { resolve_capability: 0.55 } } },
])("preserves retrieval when the evidence or a consequential decision remains open", (open) => {
	expect(readObjectiveWorkClass({ ...grounded, ...open })).toBe("insufficient_evidence");
});

it.each([0.5, 0.98])(
	"applies all recorded uncertainties on the first route with progress confidence %s",
	async (progress) => {
		const plane = new SystemOneSteeringPlane({
			adapter: {
				evaluate: async () => ({
					model: "fixture",
					latency_ms: 1,
					answers: {
						...grounded,
						// 0.72 clears the reversible Choice floor but the route checkpoint still records a doubt.
						missing_work_class: {
							type: "choice",
							choice: "investigate",
							confidence: 0.72,
							probabilities: { investigate: 0.72, implement: 0.28 },
						},
						semantic_progress: {
							type: "score",
							score: 1 + progress,
							confidence: progress,
							probabilities: { "1": 1 - progress, "2": progress },
						},
						strategy_repetition: noul(0.02),
						context_stale: noul(0.02),
						completion_plausible: noul(0.02),
						capability_gap_suspected: noul(0.02),
					},
				}),
			},
		});
		const state = { objective: "Investigate the retry count" };
		const options = { consequence: "medium" } as const;
		const evaluated = await plane.evaluate("JEV-004", state, options);
		expect(evaluated.directive.action).toBe("continue_current_work");
		const firstRoute = plane.requireCertificate("JEV-004", state, options);
		if (progress === 0.5) {
			expect(evaluated.certificate.unsure_semantic_predicates).toEqual(["missing_work_class", "semantic_progress"]);
			await expect(firstRoute).rejects.toMatchObject({ outcome: "gather_more" });
		} else {
			expect(evaluated.certificate.unsure_semantic_predicates).toEqual(["missing_work_class"]);
			await expect(firstRoute).resolves.toEqual(evaluated.certificate);
			expect(evaluated.certificate.semantic_outcome).toBe("gather_more");
		}
	},
);
