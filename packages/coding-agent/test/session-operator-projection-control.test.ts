import { describe, expect, it } from "vitest";
import type { GoalContinuationDecision } from "../src/core/goals/goal-continuation-controller.ts";
import type { GoalState, GoalStatus, Requirement } from "../src/core/goals/goal-state.ts";
import {
	type LiveLaneView,
	type PendingOwnerQuestion,
	SessionOperatorProjection,
	type SessionOperatorProjectionDeps,
} from "../src/core/operator-projection/session-operator-projection.ts";

const NOW = "2026-09-20T10:00:00.000Z";

function requirement(overrides: Partial<Requirement> = {}): Requirement {
	return {
		id: "r1",
		text: "Ship the control projection",
		status: "open",
		evidenceIds: [],
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

function goal(status: GoalStatus, requirements: readonly Requirement[] = []): GoalState {
	return {
		goalId: "goal-1",
		userGoal: "Ship the control projection",
		status,
		requirements,
		evidence: [],
		events: [],
		createdAt: NOW,
		updatedAt: NOW,
		lastProgressAt: NOW,
		stallTurns: 0,
	};
}

function continuation(overrides: Partial<GoalContinuationDecision> = {}): GoalContinuationDecision {
	return {
		action: "continue",
		reasonCode: "goal_active",
		message: "The goal is active and making progress.",
		goalId: "goal-1",
		openRequirementIds: [],
		blockedRequirementIds: [],
		satisfiedRequirementIds: [],
		...overrides,
	};
}

function depsFor(overrides: {
	goal?: GoalState;
	lanes?: readonly LiveLaneView[];
	continuation?: GoalContinuationDecision;
	pending?: PendingOwnerQuestion;
	busy?: boolean;
}): SessionOperatorProjectionDeps {
	return {
		getObjectiveId: () => overrides.goal?.goalId ?? "session-1",
		getTitle: () => "fixture",
		getGoalState: () => overrides.goal,
		getLanes: () => overrides.lanes ?? [],
		getUnresolvedProofIds: () => [],
		getAdaptation: () => undefined,
		getDeliveryState: () => "none",
		getContext: () => undefined,
		isFastIteration: () => false,
		getBlocker: () => undefined,
		getContinuation: () => overrides.continuation,
		getPendingHumanInput: () => overrides.pending,
		isForegroundBusy: () => overrides.busy ?? false,
		getSessionEntryCount: () => 0,
	};
}

function projectionFor(overrides: Parameters<typeof depsFor>[0]) {
	return new SessionOperatorProjection(depsFor(overrides)).getProjection();
}

describe("Operator control projection", () => {
	it("gives control to the root loop when no objective exists, split by foreground activity", () => {
		expect(projectionFor({}).control).toEqual({
			owner: "root",
			state: "deciding",
			reasonCode: "no_objective",
		});
		expect(projectionFor({ busy: true }).control).toEqual({
			owner: "root",
			state: "executing",
			reasonCode: "no_objective",
		});
	});

	it("treats the no-goal `missing_goal_state` verdict as no objective, never an owner question", () => {
		const projection = projectionFor({
			continuation: continuation({
				action: "ask-user",
				reasonCode: "missing_goal_state",
				message: "No goal state is present.",
			}),
		});
		expect(projection.control).toEqual({ owner: "root", state: "deciding", reasonCode: "no_objective" });
		expect(projection.phase).toBe("understand");
	});

	it("returns control to the root loop once the objective is terminal", () => {
		const projection = projectionFor({
			goal: goal("completed"),
			continuation: continuation({ action: "finalize", reasonCode: "goal_completed" }),
		});
		expect(projection.control).toEqual({
			owner: "root",
			state: "deciding",
			reasonCode: "objective_completed",
		});
	});

	it("is System One executing while the continuation waits on dispatched work", () => {
		const projection = projectionFor({
			goal: goal("active", [requirement({ boundLaneId: "lane-1" })]),
			lanes: [{ laneId: "lane-1", type: "worker", status: "running", label: "settings" }],
			continuation: continuation({ action: "waiting", reasonCode: "worker_in_flight" }),
		});
		expect(projection.control).toEqual({
			owner: "system_one",
			state: "executing",
			reasonCode: "worker_in_flight",
		});
	});

	it("is System One observing once a bound worker returned against a still-open requirement", () => {
		const projection = projectionFor({
			goal: goal("active", [requirement({ boundLaneId: "lane-1" })]),
			lanes: [{ laneId: "lane-1", type: "worker", status: "completed", label: "settings lane" }],
			continuation: continuation(),
		});
		expect(projection.control).toEqual({
			owner: "system_one",
			state: "observing",
			reasonCode: "goal_active",
		});
		expect(projection.current_action).toBe("Reviewing worker result: settings lane");
		expect(projection.next_action).toBe("review evidence");
	});

	it("is System One verifying while acceptance evidence is what stands in the way", () => {
		for (const reasonCode of [
			"acceptance_evidence_required",
			"verification_repair_required",
			"goal_completion_required",
		] as const) {
			const projection = projectionFor({
				goal: goal("active", [requirement({ status: "satisfied" })]),
				continuation: continuation({ reasonCode }),
			});
			expect(projection.control).toEqual({ owner: "system_one", state: "verifying", reasonCode });
		}
	});

	it("is System One deciding for the ordinary active reason codes", () => {
		for (const reasonCode of ["goal_active", "stall_limit_reached", "blocked_requirements_present"] as const) {
			const projection = projectionFor({
				goal: goal("active", [requirement()]),
				continuation: continuation({ reasonCode }),
			});
			expect(projection.control).toEqual({ owner: "system_one", state: "deciding", reasonCode });
		}
	});

	it("gives control to the operator while a durable question is unanswered", () => {
		const projection = projectionFor({
			goal: goal("active", [requirement()]),
			continuation: continuation(),
			pending: { requestId: "req-7", question: "choose onboarding behavior" },
		});
		expect(projection.control).toEqual({
			owner: "user",
			state: "awaiting_user",
			reasonCode: "clarification_pending",
			clarificationRequestId: "req-7",
			blocker: "choose onboarding behavior",
		});
		expect(projection.phase).toBe("blocked");
		expect(projection.health).toBe("blocked");
		expect(projection.why).toBe("choose onboarding behavior");
	});

	it("gives control to the operator when the continuation itself asks", () => {
		const projection = projectionFor({
			goal: goal("blocked"),
			continuation: continuation({
				action: "ask-user",
				reasonCode: "goal_blocked",
				message: "The goal is blocked: push is not authorized.",
			}),
		});
		expect(projection.control).toEqual({
			owner: "user",
			state: "awaiting_user",
			reasonCode: "goal_blocked",
			blocker: "The goal is blocked: push is not authorized.",
		});
		expect(projection.phase).toBe("blocked");
	});

	it("reads the branch-walking continuation once per change of its own inputs", () => {
		const lanes: LiveLaneView[] = [{ laneId: "lane-1", type: "worker", status: "running", label: "settings" }];
		let continuationCalls = 0;
		let pendingCalls = 0;
		const deps: SessionOperatorProjectionDeps = {
			...depsFor({ goal: goal("active", [requirement({ boundLaneId: "lane-1" })]) }),
			getLanes: () => lanes,
			getContinuation: () => {
				continuationCalls += 1;
				// The real evaluator waits only while the bound lane is in flight; once it returns,
				// the goal is active again and the returned evidence is what control observes.
				return lanes[0].status === "running"
					? continuation({ action: "waiting", reasonCode: "worker_in_flight" })
					: continuation();
			},
			getPendingHumanInput: () => {
				pendingCalls += 1;
				return undefined;
			},
		};
		const projection = new SessionOperatorProjection(deps);

		for (let render = 0; render < 5; render += 1) projection.getProjection();
		expect(continuationCalls).toBe(1);
		expect(pendingCalls).toBe(1);

		lanes[0] = { ...lanes[0], status: "completed" };
		expect(projection.getProjection().control.state).toBe("observing");
		expect(continuationCalls).toBe(2);
		expect(pendingCalls).toBe(2);

		for (let render = 0; render < 5; render += 1) projection.getProjection();
		expect(continuationCalls).toBe(2);
		expect(pendingCalls).toBe(2);
	});

	it("keeps control and the executing actor independent", () => {
		const projection = projectionFor({
			goal: goal("active", [requirement({ boundLaneId: "lane-1" })]),
			lanes: [{ laneId: "lane-1", type: "worker", status: "running", label: "settings" }],
			continuation: continuation({ action: "waiting", reasonCode: "worker_in_flight" }),
		});
		expect(projection.control.owner).toBe("system_one");
		expect(projection.active_actors[0]).toMatchObject({ kind: "worker", label: "settings" });
	});
});
