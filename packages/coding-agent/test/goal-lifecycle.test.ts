import { describe, expect, it } from "vitest";
import {
	cancelGoal,
	editGoal,
	pauseGoal,
	replaceGoal,
	resumeGoal,
	stopGoalFromSystem,
} from "../src/core/goals/goal-lifecycle.ts";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";

function expectState(result: ReturnType<typeof pauseGoal>) {
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error);
	return result.state;
}

describe("goal lifecycle authority", () => {
	it("keeps owner pause/resume separate from semantic blocking", () => {
		const active = createGoalState({ goalId: "g1", userGoal: "Ship", now: "T0" });
		const paused = expectState(pauseGoal(active, "T1"));
		expect(paused.status).toBe("paused");
		expect(paused.blockedReason).toBeUndefined();
		const resumed = expectState(resumeGoal(paused, "T2"));
		expect(resumed.status).toBe("active");
	});

	it("resumes usage limits but not exhausted budgets", () => {
		const active = createGoalState({ goalId: "g1", userGoal: "Ship", now: "T0" });
		const limited = expectState(stopGoalFromSystem(active, { status: "usage_limited", reason: "quota" }, "T1"));
		expect(expectState(resumeGoal(limited, "T2")).status).toBe("active");

		const budgetLimited = expectState(
			stopGoalFromSystem(active, { status: "budget_limited", reason: "tokens" }, "T3"),
		);
		const rejected = resumeGoal(budgetLimited, "T4");
		expect(rejected.ok).toBe(false);
	});

	it("edits in place and preserves usage, identity, and evidence", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "Ship", tokenBudget: 1_000, now: "T0" });
		state = applyGoalEvent(state, {
			type: "record_continuation_budget",
			turns: 1,
			wallClockMs: 10,
			tokens: 250,
			spendUsd: 0.1,
			now: "T1",
		});
		const edited = expectState(editGoal(state, { userGoal: "Ship safely", tokenBudget: 2_000 }, "T2"));
		expect(edited.goalId).toBe("g1");
		expect(edited.tokensUsed).toBe(250);
		expect(edited.tokenBudget).toBe(2_000);
		expect(edited.userGoal).toBe("Ship safely");
	});

	it("replaces an unfinished goal only through explicit owner authority", () => {
		const replaced = expectState(replaceGoal({ goalId: "new", userGoal: "New" }, "T1"));
		expect(replaced.goalId).toBe("new");
		expect(replaced.userGoal).toBe("New");
	});

	it("cancels unfinished work without claiming completion", () => {
		const current = createGoalState({ goalId: "g1", userGoal: "Ship", now: "T0" });
		const cancelled = expectState(cancelGoal(current, "T1"));
		expect(cancelled.status).toBe("cancelled");
	});
});
