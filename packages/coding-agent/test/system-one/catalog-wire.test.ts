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
	"claim_delivery",
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

	it("sends the test-claim question with its true and false criteria", () => {
		const question = getQuestionPack("claim_delivery").states_tests_pass!;
		const wire = toTypeSafeEvaluationQuestions(getQuestionPack("claim_delivery"));
		expect(wire.states_tests_pass).toEqual({
			type: "noul",
			instructions: question.instructions,
			criteria: question.criteria,
		});
		expect(wire.states_tests_pass!.criteria).toMatchObject({
			true: expect.stringContaining("The build completed successfully counts"),
			false: expect.stringContaining("predicts that a future build should succeed"),
		});
		expect(Value.Check(evaluationInputSchema, { state: { final_answer: "Lint is clean." }, questions: wire })).toBe(
			true,
		);
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
