/** Session adapters supplying the facts all goal completion paths must join. */

import { resolveCurrentProjectPipelineRun } from "../pipelines/run-state.ts";
import { isPipelineRunActive } from "../pipelines/types.ts";
import type { RuntimeBuilderDeps } from "../runtime-builder.ts";
import { COMPLETION_FINDING_SOURCE } from "../system-one/verification-coordinator.ts";
import { deriveOpenTaskStepRefs } from "../tasks/task-projection.ts";
import type { GoalCompletionSources } from "./goal-completion-admission.ts";

export function sessionGoalCompletionSources(
	host: Pick<
		RuntimeBuilderDeps,
		| "getWorkerLaneRecords"
		| "getActiveVerificationIds"
		| "getSystemOneController"
		| "getTaskStepsStateSnapshot"
		| "getToolTaskDependencies"
		| "getPipelineRunSnapshot"
	>,
	cwd: () => string,
): GoalCompletionSources {
	return {
		getLaneRecords: () => host.getWorkerLaneRecords(),
		getActiveVerificationIds: () => [
			...(host.getActiveVerificationIds?.() ?? []),
			...(host
				.getSystemOneController?.()
				?.verification.status()
				.obligations.filter((item) => item.source !== COMPLETION_FINDING_SOURCE)
				.map((item) => item.id) ?? []),
		],
		getOpenTaskSteps: () => deriveOpenTaskStepRefs(host.getTaskStepsStateSnapshot()),
		getBackgroundToolTasks: () => host.getToolTaskDependencies?.().list() ?? [],
		getActivePipeline: () => {
			const run = resolveCurrentProjectPipelineRun(cwd(), host.getPipelineRunSnapshot());
			if (!run || !isPipelineRunActive(run)) return undefined;
			return {
				runId: run.runId,
				pipelineName: run.pipelineName,
				goalId: run.goalId,
				status: run.status,
			};
		},
	};
}
