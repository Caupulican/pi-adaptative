import { createHash } from "node:crypto";
import type { SessionManager } from "../../kernel/node.ts";
import type { WorkerClaim } from "../autonomy/contracts.ts";
import {
	currentWorkerLaneGenerations,
	type RequirementCoverageRef,
	requirementEvidenceRefs,
	workerGenerationOwnerId,
} from "../delegation/requirement-rollup.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { goalObjectiveId } from "../orchestration/work-state-projection.ts";
import { requirementKey } from "./goal-acceptance.ts";
import { goalEvidenceHasRoom, MAX_GOAL_EVIDENCE } from "./goal-evidence-ledger.ts";
import { getGoalStateRevision } from "./goal-lifecycle.ts";
import { applyGoalEvent, type GoalState, isGoalUnfinishedStatus } from "./goal-state.ts";
import { projectGoalRequirementRollup } from "./requirement-dependencies.ts";
import { attachCurrentWorkerEvidence } from "./requirement-proof.ts";
import { getLatestGoalStateSnapshot } from "./session-goal-state.ts";

/** Mirrors the goal tool's bounds on one evidence entry and on the ledger. */
const MAX_EVIDENCE_ID_LENGTH = 128;
const MAX_EVIDENCE_SUMMARY_LENGTH = 600;

export interface AcceptedWorkerEvidenceDeps {
	getGoalState(): GoalState | undefined;
	saveGoalState(state: GoalState, expected?: ReturnType<typeof getGoalStateRevision>): string;
	getTaskRuntimeSnapshot(): TaskRuntimeProjection | undefined;
	/** Persisted claims in persistence order, with the parent-review marker already stamped. */
	getWorkerClaimSnapshots(): readonly WorkerClaim[];
	warn?(message: string): void;
	now?: () => string;
}

interface WorkerProofSource {
	getSessionManager(): SessionManager;
	currentWorkerEvidenceIds?(state: GoalState): ReadonlySet<string>;
}

/** The live proof projection leaves persisted status, events, and revisions untouched. */
export function refreshGoalWorkerProof(
	state: GoalState,
	source: Pick<WorkerProofSource, "currentWorkerEvidenceIds">,
): GoalState {
	return source.currentWorkerEvidenceIds &&
		state.evidence.some((item) => item.kind === "worker" || item.sourceAttemptId !== undefined)
		? attachCurrentWorkerEvidence(state, source.currentWorkerEvidenceIds(state))
		: state;
}

export function readGoalProofState(source: WorkerProofSource): GoalState | undefined {
	const state = getLatestGoalStateSnapshot(source.getSessionManager());
	return state ? refreshGoalWorkerProof(state, source) : state;
}

/** One goal evidence id per (generation, requirement), so recording is idempotent. */
export function acceptedWorkerEvidenceId(attemptId: string, requirementId: string): string {
	const identity = JSON.stringify([attemptId, requirementId]);
	return `worker:v2:${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

/** Older tuple concatenation is accepted only with the exact retained definition and lane. */
function legacyWorkerEvidenceId(attemptId: string, requirementId: string): string {
	const id = `worker:${attemptId}:${requirementId}`;
	return id.length <= MAX_EVIDENCE_ID_LENGTH
		? id
		: `worker:${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
}

/** A host measurement belongs to the latest attempt of its own task and its admitted definition. */
export function currentWorkerRequirementAttempt(
	snapshot: TaskRuntimeProjection,
	goal: GoalState,
	requirementId: string,
	attemptId: string,
): boolean {
	const requirement = goal.requirements.find((item) => item.id === requirementId);
	const attempt = snapshot.attempts[attemptId];
	const task = attempt && snapshot.tasks[attempt.taskId];
	return (
		!!requirement &&
		!!attempt &&
		task?.task.objectiveId === goalObjectiveId(goal.goalId) &&
		currentWorkerLaneGenerations(snapshot).get(workerGenerationOwnerId(attempt)) === attemptId &&
		attempt.dispatch.goalRequirementKeys?.includes(requirementKey(requirement)) === true
	);
}

/** All still-current accepted lane generations may support a criterion independently. */
export function currentWorkerEvidenceIds(
	goal: GoalState,
	snapshot: TaskRuntimeProjection | undefined,
	claims: readonly WorkerClaim[],
): ReadonlySet<string> {
	const accepted = new Set<string>();
	if (!goal.evidence.some((item) => item.kind === "worker" || item.sourceAttemptId !== undefined)) return accepted;
	if (!snapshot) return accepted;
	for (const evidence of goal.evidence) {
		if (evidence.kind !== "check" || evidence.sourceAttemptId === undefined) continue;
		const requirement = goal.requirements.find((item) => requirementKey(item) === evidence.requirementKey);
		if (requirement && currentWorkerRequirementAttempt(snapshot, goal, requirement.id, evidence.sourceAttemptId))
			accepted.add(evidence.id);
	}
	const rollup = projectGoalRequirementRollup(snapshot, claims, goal);
	for (const requirement of goal.requirements) {
		const coverage = rollup.byRequirement[requirement.id];
		const refs = requirementEvidenceRefs(coverage);
		const key = requirementKey(requirement);
		for (const ref of refs) {
			const ids = new Set([
				acceptedWorkerEvidenceId(ref.attemptId, requirement.id),
				legacyWorkerEvidenceId(ref.attemptId, requirement.id),
			]);
			for (const evidence of goal.evidence) {
				if (
					ids.has(evidence.id) &&
					evidence.kind === "worker" &&
					evidence.uri === ref.laneId &&
					evidence.requirementKey === key
				)
					accepted.add(evidence.id);
			}
		}
	}
	return accepted;
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
	const rollup = projectGoalRequirementRollup(snapshot, deps.getWorkerClaimSnapshots(), goal);
	const now = (deps.now ?? (() => new Date().toISOString()))();
	let state = goal;
	const added: string[] = [];
	requirements: for (const requirement of goal.requirements) {
		for (const ref of requirementEvidenceRefs(rollup.byRequirement[requirement.id])) {
			const id = acceptedWorkerEvidenceId(ref.attemptId, requirement.id);
			const key = requirementKey(requirement);
			const legacyId = legacyWorkerEvidenceId(ref.attemptId, requirement.id);
			if (
				state.evidence.some(
					(evidence) =>
						(evidence.id === id || evidence.id === legacyId) &&
						evidence.requirementKey === key &&
						evidence.kind === "worker" &&
						evidence.uri === ref.laneId &&
						evidence.verified === true &&
						evidence.outcome === "succeeded",
				)
			)
				continue;
			if (!goalEvidenceHasRoom(state)) {
				deps.warn?.(
					`Worker evidence was not recorded because the goal already retains ${MAX_GOAL_EVIDENCE} ordinary evidence entries.`,
				);
				break requirements;
			}
			state = applyGoalEvent(state, {
				type: "add_evidence",
				id,
				kind: "worker",
				summary: evidenceSummary(requirement.id, ref),
				uri: ref.laneId,
				verified: true,
				outcome: "succeeded",
				requirementKey: key,
				now,
			});
			added.push(id);
		}
	}
	if (added.length > 0) deps.saveGoalState(state, getGoalStateRevision(goal));
	return added;
}
