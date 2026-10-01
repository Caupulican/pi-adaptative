import { describe, expect, it } from "vitest";
import {
	buildGoalContinuationPrompt,
	buildObjectiveRoutePrompt,
	GOAL_CONTINUATION_TRIGGER_CUSTOM_TYPE,
} from "../src/core/goals/goal-continuation-prompt.ts";

describe("goal continuation trigger", () => {
	it("instructs the receiving agent to verify, revise and recheck before affected work continues", () => {
		const route = {
			schema_version: "1.0" as const,
			cycle_id: "cycle",
			objective_id: "goal",
			route: "deterministic_test" as const,
			reason_codes: ["same_lane_verification_required", "hidden_assumption"],
		};
		const prompt = buildObjectiveRoutePrompt(route).text;
		expect(prompt).toContain("Verify the finding against current evidence");
		expect(prompt).toContain("revise confirmed failures");
		expect(prompt).toContain("recheck before continuing");
		expect(prompt).toContain("hidden_assumption");
		expect(buildObjectiveRoutePrompt({ ...route, reason_codes: ["ordinary_test"] }).text).toContain(
			"Run the deterministic checks",
		);
	});
	it("gives repeated same-lane verification a concrete root-owned recovery strategy", () => {
		const prompt = buildObjectiveRoutePrompt({
			schema_version: "1.0",
			cycle_id: "cycle",
			objective_id: "goal",
			route: "replan",
			reason_codes: [
				"same_lane_verification_repeated_without_new_evidence",
				"same_lane_verification_required",
				"required test has no current receipt",
			],
		}).text;

		expect(prompt).toContain("Stay in this receiving root lane");
		expect(prompt).toContain("different hypothesis, diagnostic, or evidence source");
		expect(prompt).toContain("record the concrete outputs and next required checks");
		expect(prompt).toContain("same-lane deterministic verification");
		expect(prompt).toContain("required test has no current receipt");
	});
	it("is constant, compact, and marked as a hidden continuation trigger", () => {
		const first = buildGoalContinuationPrompt();
		const second = buildGoalContinuationPrompt();

		expect(first).toEqual({ text: "Continue active goal.", truncated: false });
		expect(second).toEqual(first);
		expect(first.text.length).toBeLessThan(64);
		expect(GOAL_CONTINUATION_TRIGGER_CUSTOM_TYPE).toBe("goal_continuation_trigger");
	});
});
