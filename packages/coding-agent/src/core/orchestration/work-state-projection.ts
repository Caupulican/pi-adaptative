import { type BackgroundToolTaskRef, collectCitedRunningToolTaskIds } from "../background-tool-task-controller.ts";
import { getTrustedRequirementEvidence } from "../goals/goal-acceptance.ts";
import type { GoalState } from "../goals/goal-state.ts";
import {
	type OpenTaskStepProjection,
	projectOpenTaskSteps,
	resolveTaskStepRequirementIds,
} from "../tasks/task-projection.ts";
import type { TaskStepsState } from "../tasks/task-state.ts";
import type { AcceptanceCriterion, EvidenceContract } from "./contracts.ts";
import type { CreateObjectiveInput, TaskRuntimeProjection } from "./task-runtime.ts";

export interface GoalObjectiveProjection extends CreateObjectiveInput {
	objectiveId: string;
	acceptanceCriteria: readonly AcceptanceCriterion[];
}

export interface RequirementExecutionProjection {
	requirementId: string;
	foregroundStepIds: readonly string[];
	delegatedTaskIds: readonly string[];
}

export interface SessionWorkStateProjection {
	objectiveId?: string;
	openTaskSteps: readonly OpenTaskStepProjection[];
	requirements: readonly RequirementExecutionProjection[];
	unlinkedOpenTaskStepIds: readonly string[];
	unknownRequirementIds: readonly string[];
	unboundDelegatedTaskIds: readonly string[];
	/** Background tool_task ids still running and cited by the goal or an open step. */
	runningToolTaskIds: readonly string[];
}

export function goalObjectiveId(goalId: string): string {
	return `goal:${goalId}`;
}

export function projectGoalObjective(goal: GoalState): GoalObjectiveProjection {
	return {
		objectiveId: goalObjectiveId(goal.goalId),
		title: `Goal ${goal.goalId}`,
		description: goal.userGoal,
		constraints: [],
		acceptanceCriteria: goal.requirements.map((requirement) => ({
			id: requirement.id,
			description: requirement.text,
			required: true,
		})),
		riskBudget: goal.tokenBudget !== undefined ? { maxTokens: goal.tokenBudget } : {},
	};
}

function orchestrationEvidenceKind(kind: GoalState["evidence"][number]["kind"]): EvidenceContract["kind"] {
	switch (kind) {
		case "test":
			return "test";
		case "tool":
			return "command";
		case "worker":
			return "review";
		case "user":
			return "external";
		case "file":
		case "finding":
			return "observation";
	}
}

export function projectGoalAcceptanceEvidence(goal: GoalState): EvidenceContract[] {
	return goal.requirements.flatMap((requirement) =>
		getTrustedRequirementEvidence(goal, requirement).map((evidence) => ({
			evidenceId: `goal-evidence:${goal.goalId}:${requirement.id}:${evidence.id}`,
			criterionId: requirement.id,
			kind: orchestrationEvidenceKind(evidence.kind),
			summary: evidence.summary,
			artifactIds: [],
			trusted: true,
			createdAt: evidence.createdAt,
			metadata: {
				sourceGoalEvidenceId: evidence.id,
				sourceKind: evidence.kind,
				...(evidence.uri ? { uri: evidence.uri } : {}),
			},
		})),
	);
}

function collectRelatedDelegatedTaskIds(
	runtime: TaskRuntimeProjection | undefined,
	objectiveId: string,
	boundLaneId: string | undefined,
): string[] {
	if (!runtime || !boundLaneId) return [];
	const direct = runtime.tasks[boundLaneId];
	if (!direct || direct.task.objectiveId !== objectiveId) return [];
	const related = new Set([boundLaneId]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const task of Object.values(runtime.tasks)) {
			if (task.task.objectiveId !== objectiveId || !task.task.verificationOfTaskId) continue;
			if (!related.has(task.task.verificationOfTaskId) || related.has(task.task.taskId)) continue;
			related.add(task.task.taskId);
			changed = true;
		}
	}
	return [...related];
}

/** One read model joining outcome criteria, foreground planning, and delegated execution by stable ids. */
export function projectSessionWorkState(args: {
	goalState: GoalState | undefined;
	taskStepsState: TaskStepsState | undefined;
	taskRuntime?: TaskRuntimeProjection;
	backgroundToolTasks?: readonly BackgroundToolTaskRef[];
}): SessionWorkStateProjection {
	const openTaskSteps = projectOpenTaskSteps(args.taskStepsState);
	const citedUris = [
		...(args.goalState?.evidence.map((evidence) => evidence.uri).filter((uri): uri is string => Boolean(uri)) ?? []),
		...openTaskSteps.flatMap((step) => step.evidence ?? []),
	];
	const runningToolTaskIds = collectCitedRunningToolTaskIds({
		records: args.backgroundToolTasks ?? [],
		uris: citedUris,
	});
	const goal = args.goalState;
	if (!goal) {
		return {
			openTaskSteps,
			requirements: [],
			unlinkedOpenTaskStepIds: openTaskSteps.map((step) => step.id),
			unknownRequirementIds: [...new Set(openTaskSteps.flatMap((step) => step.requirementIds ?? []))],
			unboundDelegatedTaskIds: [],
			runningToolTaskIds,
		};
	}

	const objectiveId = goalObjectiveId(goal.goalId);
	const foregroundByRequirement = new Map(goal.requirements.map((requirement) => [requirement.id, [] as string[]]));
	const unknownRequirementIds = new Set<string>();
	const unlinkedOpenTaskStepIds: string[] = [];
	for (const step of openTaskSteps) {
		const resolved = resolveTaskStepRequirementIds(step, goal.requirements);
		for (const unknownId of resolved.unknownIds) unknownRequirementIds.add(unknownId);
		if (resolved.matchedIds.length === 0) unlinkedOpenTaskStepIds.push(step.id);
		for (const requirementId of resolved.matchedIds) foregroundByRequirement.get(requirementId)?.push(step.id);
	}

	const requirements = goal.requirements.map((requirement) => ({
		requirementId: requirement.id,
		foregroundStepIds: foregroundByRequirement.get(requirement.id) ?? [],
		delegatedTaskIds: collectRelatedDelegatedTaskIds(args.taskRuntime, objectiveId, requirement.boundLaneId),
	}));
	const linkedDelegatedTaskIds = new Set(requirements.flatMap((requirement) => requirement.delegatedTaskIds));
	const unboundDelegatedTaskIds = Object.values(args.taskRuntime?.tasks ?? {})
		.filter((task) => task.task.objectiveId === objectiveId && !linkedDelegatedTaskIds.has(task.task.taskId))
		.map((task) => task.task.taskId);
	return {
		objectiveId,
		openTaskSteps,
		requirements,
		unlinkedOpenTaskStepIds,
		unknownRequirementIds: [...unknownRequirementIds],
		unboundDelegatedTaskIds,
		runningToolTaskIds,
	};
}
