/** Invalidates definition-scoped work and proof when a goal or requirement changes. */
import { clearExecutorRefusal } from "./goal-executor-refusal.ts";
import type { GoalEvent, GoalState, Requirement } from "./goal-state.ts";

/** A replacement definition releases the proof, dispatch and refusal tied to the previous one. */
export function reviseRequirement(requirement: Requirement, at: string, revision?: number): Requirement {
	const { boundLaneId: _lane, boundAt: _bound, ...current } = clearExecutorRefusal(requirement);
	return {
		...current,
		status: current.status === "blocked" ? "blocked" : "open",
		evidenceIds: [],
		proofKey: undefined,
		updatedAt: at,
		definitionAt: at,
		definitionRevision: revision,
	};
}

export function applyOwnerCorrection(
	before: GoalState,
	next: GoalState,
	event: Extract<GoalEvent, { type: "correct_completed_goal" }>,
): void {
	const correction = event.correction;
	if (
		before.status !== "completed" ||
		correction.targetCompletionRevision !== (before.revision ?? 0) ||
		correction.revision !== next.revision ||
		before.ownerCorrection?.ownerEntryId === correction.ownerEntryId
	)
		throw new Error("Owner correction no longer targets this completed goal.");
	next.ownerCorrection = { ...correction };
	next.ownerCorrectionProof = undefined;
	next.ownerCorrectionEvidenceIds = undefined;
	next.userGoal = correction.objective;
	next.amendmentOwnerEntryId = correction.ownerEntryId;
	next.status = "active";
	next.acceptanceOverride = false;
	next.blockedReason = undefined;
	next.lastProgressAt = event.now;
	next.stallTurns = 0;
	next.lastCompletionRejection = undefined;
	next.progressRevision = (before.progressRevision ?? 0) + 1;
	if (event.tokenBudget !== undefined) next.tokenBudget = event.tokenBudget;
	next.requirements = next.requirements.map((requirement) => ({
		...reviseRequirement(requirement, event.now, next.revision),
		status: "open",
		blockedReason: undefined,
	}));
}
