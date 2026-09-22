import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { evaluationInputSchema } from "../../src/core/review/typesafe-contract.ts";
import { getQuestionPack, toTypeSafeEvaluationQuestions } from "../../src/core/system-one/catalog.ts";
import type { ValidationStage } from "../../src/core/system-one/types.ts";

const stages: ValidationStage[] = [
	"intake",
	"preflight",
	"tool_gate",
	"postflight",
	"evidence_check",
	"drift_check",
	"drift_loop",
	"duplicate_logic",
	"patch_review",
	"completion",
	"completion_challenge",
];

describe("system-one catalog wire format", () => {
	it("sends boolean catalog questions as noul evaluations", () => {
		const wire = toTypeSafeEvaluationQuestions(getQuestionPack("preflight"));
		expect(wire.step_relevant).toMatchObject({ type: "noul" });
		expect(wire.route).toMatchObject({ type: "choice" });
		expect(
			Value.Check(evaluationInputSchema, {
				model: "jev-1.13.0",
				state: { current_step: { goal: "read the log" } },
				questions: wire,
			}),
		).toBe(true);
	});

	it("accepts every stage pack as a TypeSafe evaluation", () => {
		for (const stage of stages) {
			expect(
				Value.Check(evaluationInputSchema, {
					state: "fixture",
					questions: toTypeSafeEvaluationQuestions(getQuestionPack(stage)),
				}),
				stage,
			).toBe(true);
		}
	});
});
