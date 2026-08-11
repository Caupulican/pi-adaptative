import { describe, expect, it } from "vitest";
import {
	buildGoalContinuationPrompt,
	GOAL_CONTINUATION_TRIGGER_CUSTOM_TYPE,
} from "../src/core/goals/goal-continuation-prompt.ts";

describe("goal continuation trigger", () => {
	it("is constant, compact, and marked as a hidden continuation trigger", () => {
		const first = buildGoalContinuationPrompt();
		const second = buildGoalContinuationPrompt();

		expect(first).toEqual({ text: "Continue active goal.", truncated: false });
		expect(second).toEqual(first);
		expect(first.text.length).toBeLessThan(64);
		expect(GOAL_CONTINUATION_TRIGGER_CUSTOM_TYPE).toBe("goal_continuation_trigger");
	});
});
