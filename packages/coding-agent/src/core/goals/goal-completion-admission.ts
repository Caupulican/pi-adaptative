/** Live admission shared by the goal tools, objective delivery and final goal settlement. */
import { createHash } from "node:crypto";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import type { BackgroundToolTaskRef } from "../background-tool-task-controller.ts";
import { ObjectiveExecutionInterruptedError } from "../objective-execution/current-objective-execution.ts";
import { goalObjectiveId } from "../orchestration/work-state-projection.ts";
import type { GoalState } from "./goal-state.ts";
import {
	type ApplyGoalActionOptions,
	applyGoalAction,
	type GoalActionResult,
	type OpenTaskStepRef,
} from "./goal-tool-core.ts";

export interface GoalCompletionSources {
	getOpenTaskSteps?(): readonly OpenTaskStepRef[];
	getLaneRecords?(): readonly LaneRecord[];
	getBackgroundToolTasks?(): readonly BackgroundToolTaskRef[];
	getActivePipeline?(): ApplyGoalActionOptions["activePipeline"];
	getActiveVerificationIds?(): readonly string[];
	requireVerifiedEvidenceForCompletion?(): boolean;
}

/** Accounting and clarification bookkeeping can advance the snapshot without replacing a reviewed claim. */
export function goalCompletionKey(goal: GoalState): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				goal.goalId,
				goal.createdAt,
				goal.executionEpoch ?? 0,
				goal.userGoal,
				goal.ownerCorrection?.ownerEntryId,
				goal.ownerCorrectionProof,
				goal.requirements.map((r) => [r.id, r.status, r.proofKey, r.evidenceIds]),
				goal.evidence.map((e) => [
					e.id,
					e.kind,
					e.uri,
					e.summary,
					e.verified,
					e.outcome,
					e.requirementKey,
					e.createdAt,
				]),
			]),
		)
		.digest("hex");
}

export function decideGoalCompletion(
	goal: GoalState | undefined,
	sources: GoalCompletionSources,
	now: string,
): GoalActionResult {
	try {
		const bound = new Set(goal?.requirements.map((r) => r.boundLaneId).filter(Boolean));
		const activeGoalLaneIds = sources
			.getLaneRecords?.()
			.filter(
				(record) =>
					(record.status === "queued" || record.status === "running") &&
					(record.goalId === goal?.goalId || bound.has(record.laneId)),
			)
			.map((record) => record.laneId);
		const result = applyGoalAction(goal, { action: "complete" }, now, {
			activeGoalLaneIds,
			openTaskSteps: sources.getOpenTaskSteps?.(),
			backgroundToolTasks: sources.getBackgroundToolTasks?.(),
			activePipeline: sources.getActivePipeline?.(),
			requireVerifiedEvidenceForCompletion: sources.requireVerifiedEvidenceForCompletion?.() ?? true,
		});
		const ids = sources.getActiveVerificationIds?.() ?? [];
		if (!ids.length) return result;
		const verification = `Cannot transition goal to completed: active verification obligation(s) remain (${ids.join(", ")}). The same verification id must report status passed first.`;
		return { ok: false, error: result.ok ? verification : `${result.error}\n${verification}` };
	} catch (error) {
		return {
			ok: false,
			error: `Cannot verify goal completion: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/** Capture the proof a delivery will use, then re-admit each effect against the live session. */
export function prepareGoalCompletion(
	objectiveId: string,
	read: () => GoalState | undefined,
	sources: GoalCompletionSources,
) {
	const goal = read();
	if (!goal || goalObjectiveId(goal.goalId) !== objectiveId) return undefined;
	const key = goalCompletionKey(goal);
	const admitted = decideGoalCompletion(goal, sources, goal.updatedAt);
	return {
		key,
		refusal: admitted.ok ? undefined : admitted.error,
		assertCurrent() {
			const live = read();
			if (!live || goalCompletionKey(live) !== key || !decideGoalCompletion(live, sources, live.updatedAt).ok)
				throw new ObjectiveExecutionInterruptedError("goal_changed");
		},
	};
}
