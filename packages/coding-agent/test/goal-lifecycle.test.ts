import { describe, expect, it } from "vitest";
import {
	cancelGoal,
	editGoal,
	pauseGoal,
	replaceGoal,
	resumeGoal,
	stopGoalFromSystem,
} from "../src/core/goals/goal-lifecycle.ts";
import { applyGoalEvent, createGoalState, isGoalEvent, isGoalState } from "../src/core/goals/goal-state.ts";

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

	it("maintains durable systemFailureStreak in reducer and resists unverified claims and requirement churn", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "Ship", now: "T0" });
		expect(state.systemFailureStreak).toBe(0);

		// 1. First system failure increments streak
		state = applyGoalEvent(state, {
			type: "system_stop_goal",
			status: "blocked",
			reason: "rate_limit: 429 Too Many Requests at 14:00:00",
			now: "T1",
		});
		expect(state.systemFailureStreak).toBe(1);

		// 2. Adding / reopening requirements must not replenish retries
		state = applyGoalEvent(state, {
			type: "add_requirement",
			id: "req-1",
			text: "Requirement 1",
			now: "T2",
		});
		expect(state.systemFailureStreak).toBe(1);

		state = applyGoalEvent(state, {
			type: "reopen_requirement",
			id: "req-1",
			now: "T3",
		});
		expect(state.systemFailureStreak).toBe(1);

		// 3. Unverified progress claims must not replenish retries
		state = applyGoalEvent(state, {
			type: "progress",
			now: "T4",
		});
		expect(state.systemFailureStreak).toBe(1);

		// 4. Alternating timestamped error strings increment streak
		state = applyGoalEvent(state, {
			type: "system_stop_goal",
			status: "blocked",
			reason: "rate_limit: 429 Too Many Requests at 14:00:05",
			now: "T5",
		});
		expect(state.systemFailureStreak).toBe(2);

		// 5. System auto-resume does not reset streak
		state = applyGoalEvent(state, {
			type: "resume_goal",
			source: "system",
			now: "T6",
		});
		expect(state.systemFailureStreak).toBe(2);

		// 6. Unverified evidence does not reset streak
		state = applyGoalEvent(state, {
			type: "add_evidence",
			id: "ev-1",
			kind: "finding",
			summary: "some observation",
			verified: false,
			now: "T7",
		});
		expect(state.systemFailureStreak).toBe(2);

		// 7. Trusted actual progress resets streak
		state = applyGoalEvent(state, {
			type: "add_evidence",
			id: "ev-2",
			kind: "test",
			summary: "unit tests pass",
			verified: true,
			outcome: "succeeded",
			now: "T8",
		});
		expect(state.systemFailureStreak).toBe(0);

		// 8. New failure increments streak again
		state = applyGoalEvent(state, {
			type: "system_stop_goal",
			status: "blocked",
			reason: "server_error: 500",
			now: "T9",
		});
		expect(state.systemFailureStreak).toBe(1);

		// 9. Explicit owner resume resets streak
		state = applyGoalEvent(state, {
			type: "resume_goal",
			source: "owner",
			now: "T10",
		});
		expect(state.systemFailureStreak).toBe(0);
	});

	it("replaying previously trusted evidence receipt does not replenish recovery streak or advance progress revision", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "Ship", now: "T0" });
		state = applyGoalEvent(state, {
			type: "add_evidence",
			id: "ev-test",
			kind: "test",
			summary: "10 tests pass",
			uri: "file:///test.ts",
			verified: true,
			outcome: "succeeded",
			now: "T1",
		});
		expect(state.systemFailureStreak).toBe(0);
		const initialRev = state.progressRevision ?? 0;
		expect(initialRev).toBeGreaterThan(0);

		// Record a system failure
		state = applyGoalEvent(state, {
			type: "system_stop_goal",
			status: "blocked",
			reason: "transient 503",
			now: "T2",
		});
		expect(state.systemFailureStreak).toBe(1);

		// Replay attempt 1: identical evidence with same ID and identical content
		state = applyGoalEvent(state, {
			type: "add_evidence",
			id: "ev-test",
			kind: "test",
			summary: "10 tests pass",
			uri: "file:///test.ts",
			verified: true,
			outcome: "succeeded",
			now: "T3",
		});
		expect(state.systemFailureStreak).toBe(1);
		expect(state.progressRevision).toBe(initialRev);

		// Replay attempt 2: reworded summary for the same receipt URI
		state = applyGoalEvent(state, {
			type: "add_evidence",
			id: "ev-test",
			kind: "test",
			summary: "all 10 unit tests completely pass with zero failures",
			uri: "file:///test.ts",
			verified: true,
			outcome: "succeeded",
			now: "T4",
		});
		expect(state.systemFailureStreak).toBe(1);
		expect(state.progressRevision).toBe(initialRev);

		// Replay attempt 3: fresh evidence ID for the same previously trusted receipt URI
		state = applyGoalEvent(state, {
			type: "add_evidence",
			id: "ev-brand-new-id",
			kind: "test",
			summary: "different summary brand new id",
			uri: "file:///test.ts",
			verified: true,
			outcome: "succeeded",
			now: "T5",
		});
		expect(state.systemFailureStreak).toBe(1);
		expect(state.progressRevision).toBe(initialRev);

		// Genuinely new receipt URI: authoritative recovery
		state = applyGoalEvent(state, {
			type: "add_evidence",
			id: "ev-test-2",
			kind: "test",
			summary: "integration tests pass",
			uri: "file:///integration.test.ts",
			verified: true,
			outcome: "succeeded",
			now: "T6",
		});
		expect(state.systemFailureStreak).toBe(0);
		expect(state.progressRevision).toBe(initialRev + 1);
	});

	it("host continuation success resets provider failure streak while preserving runaway fence and resisting stale passes", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "Ship", now: "T0" });

		// Record a transient provider failure
		state = applyGoalEvent(state, {
			type: "system_stop_goal",
			status: "blocked",
			reason: "timeout: network timeout",
			now: "T1",
		});
		expect(state.systemFailureStreak).toBe(1);

		// Stale host pass on a blocked goal CANNOT replenish failure streak
		state = applyGoalEvent(state, {
			type: "record_continuation_budget",
			turns: 1,
			wallClockMs: 100,
			tokens: 50,
			spendUsd: 0.01,
			outcome: "completed",
			now: "T2",
		});
		expect(state.systemFailureStreak).toBe(1);

		// Goal is resumed to active by system
		state = applyGoalEvent(state, {
			type: "resume_goal",
			source: "system",
			now: "T3",
		});
		expect(state.systemFailureStreak).toBe(1);

		// Record a runaway stop fence
		state = applyGoalEvent(state, {
			type: "system_stop_goal",
			status: "blocked",
			reason: "runaway_tool_loop: signature sig1 3 times without progress",
			now: "T4",
		});
		// Runaway stop does NOT increment provider failure streak
		expect(state.systemFailureStreak).toBe(1);

		// Resume again by system: records runawayRecoverySignature
		state = applyGoalEvent(state, {
			type: "resume_goal",
			source: "system",
			now: "T5",
		});
		expect(state.runawayRecoverySignature).toBe("runaway_tool_loop: signature sig1 3 times without progress");

		// Stale / missing completionTurn on active goal CANNOT reset systemFailureStreak
		const staleActivePass = applyGoalEvent(state, {
			type: "record_continuation_budget",
			turns: 1,
			wallClockMs: 50,
			tokens: 25,
			spendUsd: 0.005,
			outcome: "completed",
			completionTurn: 0,
			now: "T5.1",
		});
		expect(staleActivePass.systemFailureStreak).toBe(1);

		// Authoritative healthy continuation turn with expected ordinal (1) resets systemFailureStreak but NOT runawayRecoverySignature
		state = applyGoalEvent(state, {
			type: "record_continuation_budget",
			turns: 1,
			wallClockMs: 50,
			tokens: 25,
			spendUsd: 0.005,
			outcome: "completed",
			completionTurn: (state.continuationTurnsUsed ?? 0) + 1,
			now: "T6",
		});
		expect(state.systemFailureStreak).toBe(0);
		expect(state.runawayRecoverySignature).toBe("runaway_tool_loop: signature sig1 3 times without progress");

		// Replaying the old ordinal (1) CANNOT reset streak after another error occurs
		state = applyGoalEvent(state, {
			type: "system_stop_goal",
			status: "blocked",
			reason: "timeout: network timeout 2",
			now: "T7",
		});
		expect(state.systemFailureStreak).toBe(1);
		state = applyGoalEvent(state, {
			type: "resume_goal",
			source: "system",
			now: "T8",
		});
		const replayedDuplicate = applyGoalEvent(state, {
			type: "record_continuation_budget",
			turns: 1,
			wallClockMs: 50,
			tokens: 25,
			spendUsd: 0.005,
			outcome: "completed",
			completionTurn: 1,
			now: "T8.1",
		});
		expect(replayedDuplicate.systemFailureStreak).toBe(1);
	});

	it("provider-turn-limit and goal-tool-unavailable states do not consume transient provider retry allowance", () => {
		let state = createGoalState({ goalId: "g1", userGoal: "Ship", now: "T0" });
		expect(state.systemFailureStreak).toBe(0);

		// Temporarily unavailable goal tool
		state = applyGoalEvent(state, {
			type: "system_stop_goal",
			status: "blocked",
			reason: "goal_tool_unavailable: capability surface cannot update goal",
			now: "T1",
		});
		expect(state.systemFailureStreak).toBe(0);

		// Provider turn limit
		state = applyGoalEvent(state, {
			type: "system_stop_goal",
			status: "blocked",
			reason: "provider_turn_limit: reached 20 turns",
			now: "T2",
		});
		expect(state.systemFailureStreak).toBe(0);

		// Transient provider error DOES increment
		state = applyGoalEvent(state, {
			type: "system_stop_goal",
			status: "blocked",
			reason: "server_error: 500",
			now: "T3",
		});
		expect(state.systemFailureStreak).toBe(1);
	});

	it("strictly validates systemFailureStreak and resume_goal source", () => {
		const validState = createGoalState({ goalId: "g1", userGoal: "Ship", now: "T0" });
		expect(isGoalState(validState)).toBe(true);

		// Legacy absent systemFailureStreak is accepted
		const legacyState = { ...validState, systemFailureStreak: undefined };
		expect(isGoalState(legacyState)).toBe(true);

		// Valid non-negative safe integers are accepted
		expect(isGoalState({ ...validState, systemFailureStreak: 0 })).toBe(true);
		expect(isGoalState({ ...validState, systemFailureStreak: 5 })).toBe(true);

		// Negative and fractional values are rejected
		expect(isGoalState({ ...validState, systemFailureStreak: -1 })).toBe(false);
		expect(isGoalState({ ...validState, systemFailureStreak: 1.5 })).toBe(false);
		expect(isGoalState({ ...validState, systemFailureStreak: NaN })).toBe(false);
		expect(isGoalState({ ...validState, systemFailureStreak: Infinity })).toBe(false);
		expect(isGoalState({ ...validState, systemFailureStreak: "1" as never })).toBe(false);

		// resume_goal source validation
		expect(isGoalEvent({ type: "resume_goal", now: "T1" })).toBe(true);
		expect(isGoalEvent({ type: "resume_goal", source: "owner", now: "T1" })).toBe(true);
		expect(isGoalEvent({ type: "resume_goal", source: "system", now: "T1" })).toBe(true);

		// Malformed / garbage source is rejected
		expect(isGoalEvent({ type: "resume_goal", source: "garbage" as never, now: "T1" })).toBe(false);
		expect(isGoalEvent({ type: "resume_goal", source: 123 as never, now: "T1" })).toBe(false);
		expect(isGoalEvent({ type: "resume_goal", source: true as never, now: "T1" })).toBe(false);
		expect(isGoalEvent({ type: "resume_goal", source: null as never, now: "T1" })).toBe(false);
	});
});
