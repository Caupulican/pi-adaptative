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
	route?: { objectiveId: string; route: string; reasonCodes: readonly string[] };
	blocker?: string;
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
		getBlocker: () => overrides.blocker,
		getContinuation: () => overrides.continuation,
		getRoute: () => overrides.route,
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

	it("reads an idle session as readiness and a turn without a goal as the root building", () => {
		const idle = projectionFor({});
		expect(idle.phase).toBe("understand");
		expect(idle.current_action).toBe("Ready for operator instructions");
		const turn = projectionFor({ busy: true });
		expect(turn.phase).toBe("build");
		expect(turn.current_action).toBe("Working the operator's turn");
		expect(turn.control).toEqual({ owner: "root", state: "executing", reasonCode: "no_objective" });
	});

	it("projects a paused, limited or cancelled objective as idle, never a running phase", () => {
		for (const status of ["paused", "usage_limited", "budget_limited", "cancelled"] as const) {
			const projection = new SessionOperatorProjection(depsFor({ goal: goal(status, [requirement()]) }));
			const published = projection.getProjection();
			expect(published.phase).toBe("understand");
			expect(published.current_action).toBe(`Objective ${status.replace("_", " ")}`);
			expect(published.control).toEqual({ owner: "root", state: "deciding", reasonCode: `objective_${status}` });
			expect(projection.getStageLog(1_000).open).toBeUndefined();
		}
	});

	it("opens no stage while idle and records the turn without a goal as one build pass", () => {
		const deps = depsFor({});
		let busy = false;
		const projection = new SessionOperatorProjection({ ...deps, isForegroundBusy: () => busy });
		projection.getProjection();
		expect(projection.getStageLog(1_000).entries).toEqual([]);
		expect(projection.getStageLog(1_000).open).toBeUndefined();
		busy = true;
		projection.getProjection();
		expect(projection.getStageLog(2_000).open?.stage).toBe("build");
		busy = false;
		projection.getProjection();
		const view = projection.getStageLog(3_000);
		expect(view.open).toBeUndefined();
		expect(view.entries.map((entry) => [entry.stage, entry.endedAt !== undefined])).toEqual([["build", true]]);
		expect(view.totals.build.passes).toBe(1);
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

	it("speaks the route's vocabulary while System One drives the loop, and ignores a route from another objective", () => {
		const active = goal("active", [requirement()]);
		const route = (name: string, reasonCodes: string[] = [`${name}_required`]) => ({
			objectiveId: "goal:goal-1",
			route: name,
			reasonCodes,
		});
		expect(projectionFor({ goal: active, route: route("implement"), busy: true }).control).toEqual({
			owner: "system_one",
			state: "executing",
			reasonCode: "implement_required",
		});
		expect(projectionFor({ goal: active, route: route("implement") }).control.state).toBe("deciding");
		expect(projectionFor({ goal: active, route: route("verify") }).control.state).toBe("verifying");
		expect(projectionFor({ goal: active, route: route("wait_for_worker") }).control.state).toBe("executing");
		expect(
			projectionFor({
				goal: active,
				route: route("owner_required", ["owner_authorization_required"]),
				blocker: "git.publish needs you",
			}).control,
		).toEqual({
			owner: "user",
			state: "awaiting_user",
			reasonCode: "owner_authorization_required",
			blocker: "git.publish needs you",
		});
		expect(
			projectionFor({
				goal: active,
				route: { ...route("verify"), objectiveId: "goal:other" },
				continuation: continuation({ reasonCode: "goal_active" }),
			}).control,
		).toEqual({ owner: "system_one", state: "deciding", reasonCode: "goal_active" });
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

	it("renders a labelled research lane as a named specialist", () => {
		const projection = projectionFor({
			goal: goal("active", [requirement({})]),
			lanes: [{ laneId: "research-1", type: "research", status: "running", label: "retry/backoff sources" }],
		});
		expect(projection.active_actors[0]).toMatchObject({ kind: "specialist", label: "retry/backoff sources" });
	});
});
