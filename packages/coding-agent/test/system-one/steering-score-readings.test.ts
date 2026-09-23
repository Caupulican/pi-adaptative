import { describe, expect, it } from "vitest";
import { SystemOneSteeringPlane } from "../../src/core/steering/system-one-steering-plane.ts";

const directive = { action: "continue_current_work" as const, reasonCodes: [] };
const coherent = { noul: 0.97 };
const noMissing = { noul: 0.05 };
/** A Score answer as the engine returns it: the distribution and its mean as `value`/`score`. */
const score = (distribution: Record<string, number>) => {
	const mean = Object.entries(distribution).reduce((sum, [level, p]) => sum + Number(level) * p, 0);
	return { type: "score", score: mean, value: mean, distribution, probabilities: distribution };
};

describe("steering plane Score readings", () => {
	const plane = new SystemOneSteeringPlane();
	const admission = (answers: Record<string, unknown>) => plane.evaluateSemanticOutcome("JEV-001", answers, directive);

	it("admits a clear goal whose ambiguity System One reads as minor, whatever the tail mass does to the mean", () => {
		// Measured live on a clear /goal: mean 1.08, most of the belief on "minor, defaults resolve it".
		const outcome = admission({
			objective_coherent: coherent,
			ambiguity_severity: score({ 0: 0.11, 1: 0.72, 2: 0.15, 3: 0.02 }),
			missing_information: noMissing,
		});
		expect(outcome.semantic_outcome).toBe("pass");
		expect(outcome.failed_semantic_predicates).toEqual([]);
	});

	it("gathers more on significant ambiguity or missing information, and fails only an incoherent objective", () => {
		const ambiguous = admission({
			objective_coherent: coherent,
			ambiguity_severity: score({ 1: 0.3, 2: 0.6, 3: 0.1 }),
			missing_information: noMissing,
		});
		expect(ambiguous).toMatchObject({
			semantic_outcome: "gather_more",
			failed_semantic_predicates: ["ambiguity_severity_acceptable"],
		});
		expect(
			admission({
				objective_coherent: coherent,
				ambiguity_severity: score({ 0: 1 }),
				missing_information: { noul: 0.95 },
			}).semantic_outcome,
		).toBe("gather_more");
		expect(
			admission({
				objective_coherent: { noul: 0.03 },
				ambiguity_severity: score({ 2: 1 }),
				missing_information: noMissing,
			}).semantic_outcome,
		).toBe("fail");
	});

	it("replans only when most of the belief says the work made no progress", () => {
		const progress = (distribution: Record<string, number>) =>
			plane.evaluateSemanticOutcome("JEV-005", { semantic_progress: score(distribution) }, directive)
				.semantic_outcome;
		expect(progress({ 0: 0.7, 1: 0.3 })).toBe("replan");
		expect(progress({ 0: 0.2, 1: 0.5, 2: 0.3 })).not.toBe("replan");
		// A score without a distribution is certain at its value.
		expect(
			plane.evaluateSemanticOutcome("JEV-005", { semantic_progress: { value: 0 } }, directive).semantic_outcome,
		).toBe("replan");
	});
});
