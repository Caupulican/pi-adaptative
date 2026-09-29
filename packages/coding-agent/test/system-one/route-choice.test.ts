import { describe, expect, it, vi } from "vitest";
import {
	MAX_ROUTE_CHOICE_REQUEST_CHARACTERS,
	ROUTE_CHOICE_QUESTION_ID,
} from "../../src/core/expert-routing/system-one-choice.ts";
import type { JevEvaluationRequest } from "../../src/core/system-one/adapter.ts";
import { SystemOneController } from "../../src/core/system-one/controller.ts";
import { ExecutionStore } from "../../src/core/system-one/execution-state.ts";

const options = [
	{ id: "light", description: "Light model; medium effort" },
	{ id: "strong", description: "Strong model; high effort" },
];

function fixture(answers: Record<string, unknown>) {
	const evaluate = vi.fn(async (_input: JevEvaluationRequest) => ({ model: "fixture", answers, latency_ms: 1 }));
	const store = new ExecutionStore({
		run_id: "route-choice",
		objective: {
			request: "Select an approved route",
			normalized_goal: "Select an approved route",
			acceptance_criteria: [],
		},
		repo: { root: "/repo", baseline_revision: "base" },
	});
	return { controller: new SystemOneController({ store, adapter: { evaluate } }), evaluate };
}

describe("host route choice question", () => {
	it("lets the caller's strongest-peer criterion govern without an unconditional lightest preference", async () => {
		const { controller, evaluate } = fixture({ [ROUTE_CHOICE_QUESTION_ID]: { choice: "strong", confidence: 0.98 } });
		const request = "Select the strongest capable peer for an independent review.";
		await controller.evaluateRouteChoice({ request, options });
		const input = evaluate.mock.calls[0][0];
		expect(input.state).toEqual({ request });
		const question = input.questions[ROUTE_CHOICE_QUESTION_ID] as { instructions: string; criteria: unknown };
		expect(question.instructions).toMatch(/criteria.*request|request.*criteria/i);
		expect(question.instructions).not.toMatch(/pick the lightest/i);
		expect(question.instructions).toMatch(/only.*supplied|only.*host-approved/i);
		expect(question.instructions).toMatch(/uncertainty|uncertain/i);
		expect(question.criteria).toEqual({ light: options[0].description, strong: options[1].description });
		expect(evaluate).toHaveBeenCalledTimes(1);
	});

	it("preserves a caller's lightest-adequate preference and the evaluator's uncertainty", async () => {
		const answers = { [ROUTE_CHOICE_QUESTION_ID]: { choice: "light", confidence: 0.51 } };
		const { controller, evaluate } = fixture(answers);
		const request = "Pick the lightest option that fully meets this clear coding task.";
		expect(await controller.evaluateRouteChoice({ request, options })).toBe(answers);
		expect(evaluate.mock.calls[0][0].state).toEqual({ request });
	});

	it("bounds the request using the same limit as the routing caller", async () => {
		const { controller, evaluate } = fixture({ [ROUTE_CHOICE_QUESTION_ID]: { choice: "light", confidence: 0.98 } });
		await controller.evaluateRouteChoice({ request: "x".repeat(MAX_ROUTE_CHOICE_REQUEST_CHARACTERS + 1), options });
		expect(evaluate.mock.calls[0][0].state).toEqual({ request: "x".repeat(MAX_ROUTE_CHOICE_REQUEST_CHARACTERS) });
	});
});
