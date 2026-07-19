import { SessionManager } from "@caupulican/pi-agent-core/node";
import { describe, expect, it } from "vitest";
import { appendWorkerResultSnapshot } from "../src/core/delegation/session-worker-result.ts";
import { buildGoalRuntimeSnapshot } from "../src/core/goals/goal-runtime-snapshot.ts";
import { createGoalState } from "../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot, getLatestGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { appendLearningDecisionSnapshot } from "../src/core/learning/session-learning-decision.ts";
import { createEvidenceBundle } from "../src/core/research/evidence-bundle.ts";
import { appendEvidenceBundleSnapshot } from "../src/core/research/session-evidence-bundle.ts";
import { appendTaskStepsStateSnapshot, getLatestTaskStepsStateSnapshot } from "../src/core/tasks/session-task-state.ts";
import { addTaskStep, createTaskStepsState } from "../src/core/tasks/task-state.ts";

function userMsg(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

/**
 * Regression coverage for "fork/branch task+goal state resolution": after a fork,
 * `getLatestGoalStateSnapshot` / `getLatestTaskStepsStateSnapshot` / `buildGoalRuntimeSnapshot`
 * must resolve state from the ACTIVE branch's own ancestry, never a sibling branch's history.
 */
describe("branch-scoped goal/task state resolution", () => {
	it("each branch resolves its own latest goal state and task-steps state after a fork", () => {
		const session = SessionManager.inMemory();
		const branchPoint = session.appendMessage(userMsg("start"));

		// Branch A: goal + task-steps state recorded on this branch only.
		appendGoalStateSnapshot(session, createGoalState({ goalId: "goal-a", userGoal: "Branch A goal", now: "T0" }));
		const taskStateA = addTaskStep(createTaskStepsState("T0"), { content: "Branch A step" }, "T1");
		appendTaskStepsStateSnapshot(session, taskStateA);
		const branchALeaf = session.getLeafId();
		if (!branchALeaf) throw new Error("Expected branch A leaf id");

		// Fork back to the branch point and record DIFFERENT state on branch B.
		session.branch(branchPoint);
		appendGoalStateSnapshot(session, createGoalState({ goalId: "goal-b", userGoal: "Branch B goal", now: "T2" }));
		const taskStateB = addTaskStep(createTaskStepsState("T2"), { content: "Branch B step" }, "T3");
		appendTaskStepsStateSnapshot(session, taskStateB);
		const branchBLeaf = session.getLeafId();
		if (!branchBLeaf) throw new Error("Expected branch B leaf id");

		// Leaf is currently on branch B: resolution must see ONLY branch B's state.
		expect(getLatestGoalStateSnapshot(session)?.goalId).toBe("goal-b");
		expect(getLatestTaskStepsStateSnapshot(session)?.steps[0]?.content).toBe("Branch B step");

		// Switch the leaf to branch A: resolution must now see ONLY branch A's state, proving
		// the flat entry list (which contains both branches) is not what's being scanned.
		session.branch(branchALeaf);
		expect(getLatestGoalStateSnapshot(session)?.goalId).toBe("goal-a");
		expect(getLatestTaskStepsStateSnapshot(session)?.steps[0]?.content).toBe("Branch A step");

		// And back to branch B once more, to rule out any stateful/cached resolution.
		session.branch(branchBLeaf);
		expect(getLatestGoalStateSnapshot(session)?.goalId).toBe("goal-b");
		expect(getLatestTaskStepsStateSnapshot(session)?.steps[0]?.content).toBe("Branch B step");
	});

	it("buildGoalRuntimeSnapshot is branch-scoped end to end: goal, evidence, workers, and learning all come from ONE branch", () => {
		const session = SessionManager.inMemory();
		const branchPoint = session.appendMessage(userMsg("start"));

		// Branch A: a full set of runtime snapshot inputs.
		appendGoalStateSnapshot(session, createGoalState({ goalId: "goal-a", userGoal: "Branch A goal", now: "T0" }));
		appendEvidenceBundleSnapshot(
			session,
			createEvidenceBundle({ query: "branch-a-query", sources: [], findings: [], now: "T0" }),
		);
		appendWorkerResultSnapshot(session, {
			requestId: "worker-a",
			status: "completed",
			summary: "Branch A worker",
			changedFiles: [],
		});
		appendLearningDecisionSnapshot(session, {
			kind: "apply",
			reasonCode: "branch-a-learning",
			confidence: 90,
			summary: "Branch A learning",
			requiresApproval: false,
		});
		const branchALeaf = session.getLeafId();
		if (!branchALeaf) throw new Error("Expected branch A leaf id");

		// Branch B: a disjoint set of runtime snapshot inputs.
		session.branch(branchPoint);
		appendGoalStateSnapshot(session, createGoalState({ goalId: "goal-b", userGoal: "Branch B goal", now: "T1" }));
		appendEvidenceBundleSnapshot(
			session,
			createEvidenceBundle({ query: "branch-b-query", sources: [], findings: [], now: "T1" }),
		);
		appendWorkerResultSnapshot(session, {
			requestId: "worker-b",
			status: "completed",
			summary: "Branch B worker",
			changedFiles: [],
		});
		appendLearningDecisionSnapshot(session, {
			kind: "apply",
			reasonCode: "branch-b-learning",
			confidence: 90,
			summary: "Branch B learning",
			requiresApproval: false,
		});

		const snapshotB = buildGoalRuntimeSnapshot({ sessionManager: session, settings: { maxStallTurns: 5 } });
		expect(snapshotB.goalState?.goalId).toBe("goal-b");
		expect(snapshotB.latestEvidenceBundle?.query).toBe("branch-b-query");
		expect(snapshotB.workerResults.map((r) => r.requestId)).toEqual(["worker-b"]);
		expect(snapshotB.learningDecisions.map((d) => d.reasonCode)).toEqual(["branch-b-learning"]);

		session.branch(branchALeaf);
		const snapshotA = buildGoalRuntimeSnapshot({ sessionManager: session, settings: { maxStallTurns: 5 } });
		expect(snapshotA.goalState?.goalId).toBe("goal-a");
		expect(snapshotA.latestEvidenceBundle?.query).toBe("branch-a-query");
		expect(snapshotA.workerResults.map((r) => r.requestId)).toEqual(["worker-a"]);
		expect(snapshotA.learningDecisions.map((d) => d.reasonCode)).toEqual(["branch-a-learning"]);
	});

	it("single-branch (unforked) sessions resolve byte-identically to the pre-branch-scoping behavior", () => {
		const session = SessionManager.inMemory();
		const first = createGoalState({ goalId: "g1", userGoal: "First", now: "T0" });
		appendGoalStateSnapshot(session, first);
		const second = createGoalState({ goalId: "g2", userGoal: "Second", now: "T1" });
		appendGoalStateSnapshot(session, second);

		const firstTaskState = addTaskStep(createTaskStepsState("T0"), { content: "Only step" }, "T1");
		appendTaskStepsStateSnapshot(session, firstTaskState);

		// No fork occurred: getBranch() and getEntries() describe the same linear history, so the
		// branch-scoped resolvers must return exactly what the flat-list resolvers used to return.
		expect(getLatestGoalStateSnapshot(session)).toEqual(second);
		expect(getLatestTaskStepsStateSnapshot(session)).toEqual(firstTaskState);

		const snapshot = buildGoalRuntimeSnapshot({ sessionManager: session, settings: { maxStallTurns: 3 } });
		expect(snapshot.goalState?.goalId).toBe("g2");
	});
});
