import type { BackgroundToolTaskRef } from "../background-tool-task-controller.ts";
import type { GoalState } from "../goals/goal-state.ts";
import type { OpenTaskStepRef } from "../goals/goal-tool-core.ts";
import { taskStepReferencesRequirement } from "../tasks/task-projection.ts";
import { type TaskStep, type TaskStepsState, updateTaskStep } from "../tasks/task-state.ts";
import { currentPipelineStage } from "./context.ts";
import { persistPipelineRun, scanStageOutput, stageOutputDir } from "./run-state.ts";
import {
	type IncrementResult,
	isPipelineRunActive,
	type PipelineDefinition,
	type PipelineRun,
	type PipelineStage,
} from "./types.ts";

export interface PipelineIncrementJoin {
	goal?: GoalState;
	openTaskSteps?: readonly OpenTaskStepRef[];
	backgroundToolTasks?: readonly BackgroundToolTaskRef[];
}

export class PipelineIncrementError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PipelineIncrementError";
	}
}

function inFlightToolTasks(tasks: readonly BackgroundToolTaskRef[] | undefined): string[] {
	if (!tasks) return [];
	return tasks.filter((task) => task.status === "running").map((task) => task.taskId);
}

function linkedOpenStepIds(
	_definition: PipelineDefinition,
	join: PipelineIncrementJoin,
	run: PipelineRun,
	stage?: PipelineStage,
): string[] {
	if (!stage) return [];
	if (!join.openTaskSteps || join.openTaskSteps.length === 0) return [];

	return join.openTaskSteps
		.filter((step) => {
			if (step.pipelineRunId && step.pipelineRunId === run.runId) {
				return step.pipelineStageId === stage.id;
			}
			if (step.pipelineStageId) {
				return step.pipelineStageId === stage.id;
			}
			if (!run.goalId || !join.goal || join.goal.goalId !== run.goalId) return false;
			return join.goal.requirements.some((requirement) => taskStepReferencesRequirement(step, requirement));
		})
		.map((step) => step.id);
}

export function incrementPipelineRun(
	definition: PipelineDefinition,
	run: PipelineRun,
	now: string,
	join: PipelineIncrementJoin = {},
): { run: PipelineRun; result: IncrementResult } {
	if (!isPipelineRunActive(run)) {
		throw new PipelineIncrementError(`Pipeline run '${run.runId}' is ${run.status}.`);
	}
	const stage = currentPipelineStage(definition, run);
	if (!stage) {
		throw new PipelineIncrementError(`Current stage '${run.currentStageId}' is missing from the definition.`);
	}
	const linked = linkedOpenStepIds(definition, join, run, stage);
	if (linked.length > 0) {
		throw new PipelineIncrementError(
			`Cannot increment pipeline: open task_steps still reference current stage '${stage.id}' (${linked.join(", ")}).`,
		);
	}
	const running = inFlightToolTasks(join.backgroundToolTasks);
	if (running.length > 0) {
		throw new PipelineIncrementError(
			`Cannot increment pipeline: tool_task(s) still running (${running.join(", ")}). Wait once via tool_task.`,
		);
	}
	const scanned = scanStageOutput(stageOutputDir(run.runRoot, stage));
	if (scanned.status !== "complete") {
		throw new PipelineIncrementError(
			`Cannot increment pipeline: stage '${stage.id}' output/ has no files yet. Write the stage outputs first.`,
		);
	}
	const currentIndex = definition.stages.findIndex((candidate) => candidate.id === stage.id);
	const next = definition.stages[currentIndex + 1];
	if (!next) {
		const completed = persistPipelineRun({ ...run, status: "completed" }, now);
		return {
			run: completed,
			result: {
				surface: "pipeline",
				from: stage.id,
				completed: true,
				detail: `Completed final stage '${stage.id}'. Pipeline run '${run.runId}' is done.`,
			},
		};
	}
	const advanced = persistPipelineRun({ ...run, currentStageId: next.id }, now);
	return {
		run: advanced,
		result: {
			surface: "pipeline",
			from: stage.id,
			to: next.id,
			completed: false,
			detail: `Completed '${stage.id}', started '${next.id}'. ${next.contract.oneJob || next.contract.title}`,
		},
	};
}

export function abandonPipelineRun(run: PipelineRun, now: string): PipelineRun {
	if (!isPipelineRunActive(run)) return run;
	return persistPipelineRun({ ...run, status: "abandoned" }, now);
}

export function advanceTaskSteps(
	state: TaskStepsState,
	now: string,
): {
	state: TaskStepsState;
	result: IncrementResult;
} {
	const current =
		state.steps.find((step) => step.status === "in_progress") ??
		state.steps.find((step) => step.status === "pending");
	if (!current) {
		const blocked = state.steps.filter((step) => step.status === "blocked");
		if (blocked.length > 0) {
			return {
				state,
				result: {
					surface: "task_steps",
					completed: false,
					detail: `Cannot advance: all remaining steps are blocked (${blocked.map((step) => step.id).join(", ")}).`,
				},
			};
		}
		return {
			state,
			result: {
				surface: "task_steps",
				completed: true,
				detail: "No open task steps remain.",
			},
		};
	}
	let nextState = state;
	if (current.status !== "completed") {
		nextState = updateTaskStep(nextState, current.id, { status: "completed" }, now);
	}
	const following = nextState.steps.find((step) => step.id !== current.id && step.status === "pending");
	if (following) {
		nextState = updateTaskStep(nextState, following.id, { status: "in_progress" }, now);
		return {
			state: nextState,
			result: {
				surface: "task_steps",
				from: current.id,
				to: following.id,
				completed: false,
				detail: `Completed ${current.id}, started ${following.id}.`,
			},
		};
	}
	const blocked = nextState.steps.filter((step) => step.status === "blocked");
	if (blocked.length > 0) {
		return {
			state: nextState,
			result: {
				surface: "task_steps",
				from: current.id,
				completed: false,
				detail: `Completed ${current.id}. Remaining steps are blocked: ${blocked.map((step) => step.id).join(", ")}.`,
			},
		};
	}
	return {
		state: nextState,
		result: {
			surface: "task_steps",
			from: current.id,
			completed: true,
			detail: `Completed ${current.id}. No further pending steps.`,
		},
	};
}

export function currentOpenTaskStep(steps: readonly TaskStep[]): TaskStep | undefined {
	return steps.find((step) => step.status === "in_progress") ?? steps.find((step) => step.status === "pending");
}
