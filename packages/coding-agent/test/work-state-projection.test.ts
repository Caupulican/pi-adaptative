import { describe, expect, it } from "vitest";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";
import type { TaskContract } from "../src/core/orchestration/contracts.ts";
import type { TaskRuntimeProjection, TaskRuntimeState } from "../src/core/orchestration/task-runtime.ts";
import { projectSessionWorkState } from "../src/core/orchestration/work-state-projection.ts";
import { addTaskStep, createTaskStepsState } from "../src/core/tasks/task-state.ts";

function task(taskId: string, verificationOfTaskId?: string): TaskRuntimeState {
	const now = "T0";
	const contract: TaskContract = {
		schemaVersion: 1,
		taskId,
		objectiveId: "goal:g1",
		title: taskId,
		description: taskId,
		role: verificationOfTaskId ? "verifier" : "implementer",
		status: "ready",
		dependsOn: [],
		requiredCapabilities: [],
		acceptanceCriterionIds: [],
		...(verificationOfTaskId ? { verificationOfTaskId } : {}),
		riskBudget: {},
		createdAt: now,
		updatedAt: now,
	};
	return { task: contract, attemptIds: [] };
}

function runtime(): TaskRuntimeProjection {
	return {
		lastOrdinal: 0,
		agents: {},
		objectives: {},
		tasks: {
			"worker-1": task("worker-1"),
			"verifier-1": task("verifier-1", "worker-1"),
			"worker-unbound": task("worker-unbound"),
		},
		attempts: {},
		checkpoints: {},
		approvals: {},
		notifications: {},
	};
}

describe("session work-state projection", () => {
	it("joins requirements, foreground steps, and delegated tasks by stable identity", () => {
		let goal = createGoalState({ goalId: "g1", userGoal: "Ship", now: "T0" });
		goal = applyGoalEvent(goal, { type: "add_requirement", id: "req-1", text: "Implement routing", now: "T1" });
		goal = applyGoalEvent(goal, {
			type: "add_requirement",
			id: "req-2",
			text: "Document the recovery contract",
			now: "T2",
		});
		goal = applyGoalEvent(goal, {
			type: "dispatch_worker",
			id: "req-1",
			instructions: "Implement",
			laneId: "worker-1",
			now: "T3",
		});

		let steps = createTaskStepsState("T0");
		steps = addTaskStep(steps, { content: "Unrelated wording", requirementIds: ["req-1"] }, "T1");
		steps = addTaskStep(steps, { content: "Document the recovery contract now" }, "T2");
		steps = addTaskStep(steps, { content: "Invalid link", requirementIds: ["req-missing"] }, "T3");
		steps = addTaskStep(steps, { content: "Standalone maintenance" }, "T4");

		const projection = projectSessionWorkState({ goalState: goal, taskStepsState: steps, taskRuntime: runtime() });
		expect(projection.objectiveId).toBe("goal:g1");
		expect(projection.requirements).toEqual([
			{
				requirementId: "req-1",
				foregroundStepIds: ["step-1"],
				delegatedTaskIds: ["worker-1", "verifier-1"],
			},
			{ requirementId: "req-2", foregroundStepIds: ["step-2"], delegatedTaskIds: [] },
		]);
		expect(projection.unknownRequirementIds).toEqual(["req-missing"]);
		expect(projection.unlinkedOpenTaskStepIds).toEqual(["step-3", "step-4"]);
		expect(projection.unboundDelegatedTaskIds).toEqual(["worker-unbound"]);
		expect(projection.runningToolTaskIds).toEqual([]);
	});

	it("does not let explicit links fall back to conflicting free-text matches", () => {
		let goal = createGoalState({ goalId: "g1", userGoal: "Ship", now: "T0" });
		goal = applyGoalEvent(goal, { type: "add_requirement", id: "req-1", text: "Implement routing", now: "T1" });
		goal = applyGoalEvent(goal, { type: "add_requirement", id: "req-2", text: "Document routing", now: "T2" });
		const steps = addTaskStep(
			createTaskStepsState("T0"),
			{ content: "Implement routing", requirementIds: ["req-2"] },
			"T1",
		);
		const projection = projectSessionWorkState({ goalState: goal, taskStepsState: steps });
		expect(projection.requirements[0].foregroundStepIds).toEqual([]);
		expect(projection.requirements[1].foregroundStepIds).toEqual(["step-1"]);
	});

	it("joins cited running tool_task ids from goal evidence and open step evidence", () => {
		let goal = createGoalState({ goalId: "g1", userGoal: "Ship", now: "T0" });
		goal = applyGoalEvent(goal, { type: "add_requirement", id: "req-1", text: "Implement routing", now: "T1" });
		goal = applyGoalEvent(goal, {
			type: "add_evidence",
			id: "e1",
			kind: "tool",
			summary: "handoff",
			uri: "tool-task-1",
			now: "T2",
		});
		const steps = addTaskStep(
			createTaskStepsState("T0"),
			{ content: "Wait for compile", requirementIds: ["req-1"], evidence: ["call-9"] },
			"T1",
		);
		const projection = projectSessionWorkState({
			goalState: goal,
			taskStepsState: steps,
			backgroundToolTasks: [
				{ taskId: "tool-task-1", toolCallId: "call-1", status: "running" },
				{ taskId: "tool-task-2", toolCallId: "call-9", status: "running" },
				{ taskId: "tool-task-3", toolCallId: "call-3", status: "completed" },
			],
		});
		expect(projection.runningToolTaskIds).toEqual(["tool-task-1", "tool-task-2"]);
	});
});
