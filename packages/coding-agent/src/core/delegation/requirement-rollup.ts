import type { WorkerClaim } from "../autonomy/contracts.ts";
import { nativeAgentIdForAttempt } from "../orchestration/attempt-agent-identity.ts";
import { latestAgentAttemptsByDurableOrder } from "../orchestration/attempt-ordering.ts";
import { reviewRunVerdict } from "../orchestration/review-verdict.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import type { AttemptRuntimeState } from "../orchestration/task-runtime-state.ts";
import { attemptVerification, isManagedWorkerAttempt, selectedManagedWorkerAttempt } from "./worker-lane-projection.ts";

/** The claim fields that decide whether a worker's result covers a requirement. */
export type RollupClaim = Pick<
	WorkerClaim,
	| "requestId"
	| "terminalAttemptId"
	| "status"
	| "summary"
	| "hostVerdict"
	| "parentReviewRequired"
	| "parentReviewedAt"
>;

/** One dispatched generation of a task, as plain data: what it was dispatched for and what it reported. */
export interface RollupAttempt {
	laneId: string;
	generationOwnerId?: string;
	currentGeneration?: boolean;
	attemptId: string;
	requirementIds: readonly string[];
	/** The latest persisted claim of this generation, absent while it runs or when none was stored. */
	claim?: RollupClaim;
	/** The task's independent verification was reconciled as accepted for this generation. */
	verificationAccepted: boolean;
}

export interface RequirementCoverageRef {
	laneId: string;
	attemptId: string;
	/** What showed the coverage: the host's judgment of the claim, or a reconciled independent verification. */
	source: "host_verdict" | "verification";
	summary: string;
}

export interface RequirementCoverage {
	/** Every lane dispatched for the requirement. */
	laneIds: readonly string[];
	covered: boolean;
	/** The newest generation that covers the requirement; absent while it is uncovered. */
	evidenceRef?: RequirementCoverageRef;
	/** Other independent lanes whose latest generations also cover this requirement. */
	evidenceRefs?: readonly RequirementCoverageRef[];
}

/** Every currently accepted independent lane remains available as a source of proof. */
export function requirementEvidenceRefs(coverage: RequirementCoverage | undefined): readonly RequirementCoverageRef[] {
	return coverage?.evidenceRefs ?? (coverage?.evidenceRef ? [coverage.evidenceRef] : []);
}

export interface RequirementRollup {
	byRequirement: Readonly<Record<string, RequirementCoverage>>;
	/** Requirement ids no accepted, reviewed result covers yet, in first-seen order. */
	uncovered: readonly string[];
}

/** One generation owner for both worker reports and delayed host measurements. */
export function workerGenerationOwnerId(attempt: AttemptRuntimeState): string {
	if (isManagedWorkerAttempt(attempt)) return `managed:${attempt.dispatch.logicalLaneId ?? attempt.taskId}`;
	const agentId = nativeAgentIdForAttempt(attempt);
	return agentId ? `agent:${agentId}` : `task:${attempt.taskId}`;
}

const currentWorkerGenerationsMemo = new WeakMap<TaskRuntimeProjection, ReadonlyMap<string, string>>();

/** Durable attempt order applies across task boundaries, with native active bindings taking precedence. */
export function currentWorkerLaneGenerations(snapshot: TaskRuntimeProjection): ReadonlyMap<string, string> {
	const immutable = Object.isFrozen(snapshot);
	const cached = immutable ? currentWorkerGenerationsMemo.get(snapshot) : undefined;
	if (cached) return cached;
	const current = new Map<string, string>();
	for (const attempt of Object.values(snapshot.attempts)) {
		const laneId = attempt.dispatch.logicalLaneId ?? attempt.taskId;
		const selected = isManagedWorkerAttempt(attempt) ? selectedManagedWorkerAttempt(snapshot, laneId) : attempt;
		if (selected) current.set(workerGenerationOwnerId(selected), selected.attemptId);
	}
	for (const attempt of latestAgentAttemptsByDurableOrder(snapshot).values())
		current.set(workerGenerationOwnerId(attempt), attempt.attemptId);
	if (immutable) currentWorkerGenerationsMemo.set(snapshot, current);
	return current;
}

/** An unreviewed mutation never counts: the parent has not yet looked at what the worker changed. */
function reviewSettled(claim: RollupClaim): boolean {
	return claim.parentReviewRequired === false || claim.parentReviewedAt !== undefined;
}

function coverageSource(
	attempt: RollupAttempt,
	requirementId: string,
): { source: RequirementCoverageRef["source"]; claim: RollupClaim } | undefined {
	const claim = attempt.claim;
	if (claim?.status !== "completed" || !reviewSettled(claim)) return undefined;
	const covered = claim.hostVerdict?.coveredRequirementIds.includes(requirementId) === true;
	// A task-level verdict can identify a single criterion. A multi-criterion task still needs criterion-level coverage.
	if (attempt.verificationAccepted && (attempt.requirementIds.length === 1 || covered))
		return { source: "verification", claim };
	if (covered && claim.hostVerdict?.verdict === "accepted") return { source: "host_verdict", claim };
	return undefined;
}

/**
 * Joins what each task was dispatched for with what its generations reported. A requirement is
 * covered only when a generation's claim is completed, the host accepted it for that requirement id
 * (or an independent verification was reconciled accepted), and its mutations were reviewed. Only the
 * newest claim-bearing generation of a task speaks for that task, so a retry that regressed cannot be
 * masked by the earlier generation it replaced. `requirementIds` adds requirements nothing was
 * dispatched for, so the caller's own list is never silently narrowed to what workers touched.
 */
export function projectRequirementRollup(
	attempts: readonly RollupAttempt[],
	requirementIds: readonly string[] = [],
	isCurrentScope?: (attempt: RollupAttempt, requirementId: string) => boolean,
): RequirementRollup {
	const latestByLane = new Map<string, RollupAttempt>();
	const latestByOwner = new Map<string, RollupAttempt>();
	const dispatched = new Map<string, string[]>();
	for (const attempt of attempts) {
		if (attempt.currentGeneration === true || latestByLane.get(attempt.laneId)?.currentGeneration !== true)
			latestByLane.set(attempt.laneId, attempt);
		const ownerId = attempt.generationOwnerId ?? attempt.laneId;
		if (attempt.currentGeneration === true || latestByOwner.get(ownerId)?.currentGeneration !== true)
			latestByOwner.set(ownerId, attempt);
		for (const requirementId of attempt.requirementIds) {
			const laneIds = dispatched.get(requirementId) ?? [];
			if (!laneIds.includes(attempt.laneId)) laneIds.push(attempt.laneId);
			dispatched.set(requirementId, laneIds);
		}
	}
	const universe = [...new Set([...requirementIds, ...dispatched.keys()])];
	const byRequirement: Record<string, RequirementCoverage> = {};
	const uncovered: string[] = [];
	for (const requirementId of universe) {
		const laneIds = dispatched.get(requirementId) ?? [];
		let evidenceRef: RequirementCoverageRef | undefined;
		const evidenceRefs: RequirementCoverageRef[] = [];
		for (const laneId of laneIds) {
			const attempt = latestByLane.get(laneId);
			if (
				!attempt?.requirementIds.includes(requirementId) ||
				attempt.currentGeneration === false ||
				latestByOwner.get(attempt.generationOwnerId ?? attempt.laneId) !== attempt
			)
				continue;
			const coverage = coverageSource(attempt, requirementId);
			if (coverage && isCurrentScope?.(attempt, requirementId) !== false) {
				evidenceRef = {
					laneId: attempt.laneId,
					attemptId: attempt.attemptId,
					source: coverage.source,
					summary: coverage.claim.summary,
				};
				evidenceRefs.push(evidenceRef);
			}
		}
		byRequirement[requirementId] = {
			laneIds,
			covered: evidenceRef !== undefined,
			...(evidenceRef ? { evidenceRef } : {}),
			...(evidenceRefs.length > 1 ? { evidenceRefs } : {}),
		};
		if (!evidenceRef) uncovered.push(requirementId);
	}
	return { byRequirement, uncovered };
}

/**
 * The plain-data attempts of every dispatch that declared requirement ids. A claim names its
 * generation through `terminalAttemptId`; an in-process claim that names none belongs to its task's
 * newest generation, while an unnamed managed-lane claim is ambiguous across the lane's turns and
 * belongs to none. `claims` are in persistence order, so the later of two claims for one generation wins.
 */
export function rollupAttemptsFromSnapshot(
	snapshot: TaskRuntimeProjection,
	claims: readonly RollupClaim[],
	objectiveId?: string,
): RollupAttempt[] {
	const rollupAttempts: RollupAttempt[] = [];
	const current = currentWorkerLaneGenerations(snapshot);
	for (const attempt of Object.values(snapshot.attempts)) {
		const task = snapshot.tasks[attempt.taskId];
		if (!task || (objectiveId !== undefined && task.task.objectiveId !== objectiveId)) continue;
		const requirementIds = attempt.dispatch.requirementIds ?? [];
		const managed = isManagedWorkerAttempt(attempt);
		const laneId = managed ? (attempt.dispatch.logicalLaneId ?? task.task.taskId) : task.task.taskId;
		const generationOwnerId = workerGenerationOwnerId(attempt);
		let claim: RollupClaim | undefined;
		for (const candidate of claims) {
			if (candidate.requestId !== laneId) continue;
			const named = candidate.terminalAttemptId ?? (managed ? undefined : task.attemptIds.at(-1));
			if (named === attempt.attemptId) claim = candidate;
		}
		rollupAttempts.push({
			laneId,
			generationOwnerId,
			currentGeneration: current.get(generationOwnerId) === attempt.attemptId,
			attemptId: attempt.attemptId,
			requirementIds,
			...(claim ? { claim } : {}),
			verificationAccepted:
				attemptVerification(snapshot, attempt)?.verdict === "accepted" ||
				reviewRunVerdict(snapshot, attempt)?.kind === "accepted",
		});
	}
	return rollupAttempts;
}
