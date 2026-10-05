import { createHash } from "node:crypto";
import type { WorkerClaim } from "../autonomy/contracts.ts";
import {
	projectRequirementRollup,
	type RequirementCoverageRef,
	rollupAttemptsFromSnapshot,
} from "../delegation/requirement-rollup.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { getGoalStateRevision } from "./goal-lifecycle.ts";
import { applyGoalEvent, type GoalState, isGoalUnfinishedStatus } from "./goal-state.ts";

/** Mirrors the goal tool's bounds on one evidence entry and on the ledger. */
const MAX_EVIDENCE_ID_LENGTH = 128;
const MAX_EVIDENCE_SUMMARY_LENGTH = 600;
const MAX_GOAL_EVIDENCE = 512;

export interface AcceptedWorkerEvidenceDeps {
	getGoalState(): GoalState | undefined;
	saveGoalState(state: GoalState, expected?: ReturnType<typeof getGoalStateRevision>): string;
	getTaskRuntimeSnapshot(): TaskRuntimeProjection | undefined;
	/** Persisted claims in persistence order, with the parent-review marker already stamped. */
	getWorkerClaimSnapshots(): readonly WorkerClaim[];
	now?: () => string;
}

/** One goal evidence id per (generation, requirement), so recording is idempotent. */
export function acceptedWorkerEvidenceId(attemptId: string, requirementId: string): string {
	const id = `worker:${attemptId}:${requirementId}`;
	return id.length <= MAX_EVIDENCE_ID_LENGTH
		? id
		: `worker:${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
}

function evidenceSummary(requirementId: string, ref: RequirementCoverageRef): string {
	const basis =
		ref.source === "verification" ? "independent verification accepted it" : "the host accepted its report";
	const head = `Worker ${ref.laneId} covers requirement ${requirementId}: ${basis}.`;
	const summary = ref.summary.trim();
	return `${head}${summary ? ` ${summary}` : ""}`.slice(0, MAX_EVIDENCE_SUMMARY_LENGTH);
}

/**
 * Makes accepted worker proof citable by the goal's completion account, and nothing more. For every
 * goal requirement a worker's accepted, reviewed result covers, it adds one verified `worker` evidence
 * entry that the account can cite by id. It never satisfies a requirement: the model still has to call
 * `satisfy_requirement` with the evidence, which is what later projects it to the objective as trusted
 * evidence for that criterion. Idempotent per (generation, requirement). Returns the evidence ids added.
 */
export function recordAcceptedWorkerRequirementEvidence(deps: AcceptedWorkerEvidenceDeps): string[] {
	const goal = deps.getGoalState();
	const snapshot = deps.getTaskRuntimeSnapshot();
	if (!goal || !snapshot || !isGoalUnfinishedStatus(goal.status)) return [];
	const rollup = projectRequirementRollup(
		rollupAttemptsFromSnapshot(snapshot, deps.getWorkerClaimSnapshots()),
		goal.requirements.map((requirement) => requirement.id),
	);
	const now = (deps.now ?? (() => new Date().toISOString()))();
	let state = goal;
	const added: string[] = [];
	for (const requirement of goal.requirements) {
		const ref = rollup.byRequirement[requirement.id]?.evidenceRef;
		if (!ref || requirement.status === "satisfied") continue;
		const id = acceptedWorkerEvidenceId(ref.attemptId, requirement.id);
		if (state.evidence.some((evidence) => evidence.id === id)) continue;
		if (state.evidence.length >= MAX_GOAL_EVIDENCE) break;
		state = applyGoalEvent(state, {
			type: "add_evidence",
			id,
			kind: "worker",
			summary: evidenceSummary(requirement.id, ref),
			uri: ref.laneId,
			verified: true,
			outcome: "succeeded",
			now,
		});
		added.push(id);
	}
	if (added.length > 0) deps.saveGoalState(state, getGoalStateRevision(goal));
	return added;
}
