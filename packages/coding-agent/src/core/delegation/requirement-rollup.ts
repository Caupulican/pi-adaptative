import type { WorkerClaim } from "../autonomy/contracts.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { attemptVerification, isManagedWorkerAttempt } from "./worker-lane-projection.ts";

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
}

export interface RequirementRollup {
	byRequirement: Readonly<Record<string, RequirementCoverage>>;
	/** Requirement ids no accepted, reviewed result covers yet, in first-seen order. */
	uncovered: readonly string[];
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
	if (claim.hostVerdict?.verdict === "accepted" && claim.hostVerdict.coveredRequirementIds.includes(requirementId)) {
		return { source: "host_verdict", claim };
	}
	if (attempt.verificationAccepted) return { source: "verification", claim };
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
): RequirementRollup {
	const latestByLane = new Map<string, RollupAttempt>();
	const dispatched = new Map<string, string[]>();
	for (const attempt of attempts) {
		latestByLane.set(attempt.laneId, attempt);
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
		for (const laneId of laneIds) {
			const attempt = latestByLane.get(laneId);
			if (!attempt?.requirementIds.includes(requirementId)) continue;
			const coverage = coverageSource(attempt, requirementId);
			if (coverage) {
				evidenceRef = {
					laneId: attempt.laneId,
					attemptId: attempt.attemptId,
					source: coverage.source,
					summary: coverage.claim.summary,
				};
			}
		}
		byRequirement[requirementId] = {
			laneIds,
			covered: evidenceRef !== undefined,
			...(evidenceRef ? { evidenceRef } : {}),
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
): RollupAttempt[] {
	const rollupAttempts: RollupAttempt[] = [];
	for (const task of Object.values(snapshot.tasks)) {
		const taskAttempts = task.attemptIds.flatMap((attemptId) => {
			const attempt = snapshot.attempts[attemptId];
			return attempt ? [attempt] : [];
		});
		const newestAttemptId = taskAttempts.at(-1)?.attemptId;
		for (const attempt of taskAttempts) {
			const requirementIds = attempt.dispatch.requirementIds ?? [];
			if (requirementIds.length === 0) continue;
			const managed = isManagedWorkerAttempt(attempt);
			const laneId = managed ? (attempt.dispatch.logicalLaneId ?? task.task.taskId) : task.task.taskId;
			let claim: RollupClaim | undefined;
			for (const candidate of claims) {
				if (candidate.requestId !== laneId) continue;
				const named = candidate.terminalAttemptId ?? (managed ? undefined : newestAttemptId);
				if (named === attempt.attemptId) claim = candidate;
			}
			rollupAttempts.push({
				laneId,
				attemptId: attempt.attemptId,
				requirementIds,
				...(claim ? { claim } : {}),
				verificationAccepted: attemptVerification(snapshot, attempt)?.verdict === "accepted",
			});
		}
	}
	return rollupAttempts;
}
