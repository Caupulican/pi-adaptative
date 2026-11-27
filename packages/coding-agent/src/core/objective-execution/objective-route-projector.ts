/**
 * Objective Route Projector.
 * Builds bounded, redacted projection for Jev semantic routing questions.
 */

import { objectiveNeedsCorrectedOutcome, provenObjectiveCriterionIds } from "../orchestration/objective-criteria.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import type { ObjectiveWorkClass } from "../steering/programs.ts";
import type { ExecutionState } from "../system-one/types.ts";
import { OBJECTIVE_WAIT_ROUTES } from "./objective-route.ts";
import { evidenceMarkerOf } from "./objective-stall-fingerprint.ts";

/**
 * Every work class the route policy composes: the route checkpoint's own options, plus the classes
 * the other route sources name (an unsettled judgment reads as `insufficient_evidence`).
 */
export type RouteWorkClass =
	| ObjectiveWorkClass
	| "retrieve"
	| "deterministic_test"
	| "verify"
	| "review"
	| "none"
	| "insufficient_evidence"
	| "continue_current_work";

export interface SemanticRouteJudgments {
	workRemaining?: boolean;
	missingWorkClass?: RouteWorkClass;
	currentWorkerCanContinue?: boolean;
	independentWorkerRequired?: boolean;
	capabilityEscalationRequired?: boolean;
	externalBlockerPresent?: boolean;
	semanticProgress?: number;
	contextStale?: boolean;
	strategyRepetition?: boolean;
}

export interface ObjectiveRouteProjection {
	readonly objectiveId: string;
	readonly taskKind?: string;
	readonly totalTasks: number;
	readonly openTasks: number;
	readonly inFlightWorkers: number;
	readonly inFlightTools: number;
	readonly unresolvedObligations: number;
	readonly openHypotheses: number;
	readonly recentMutations: number;
	readonly evidenceFresh: boolean;
	readonly stallTurns: number;
	readonly repeatedStrategy: boolean;
}

function objectiveWork(runtime: TaskRuntimeProjection, objectiveId: string) {
	const tasks = Object.values(runtime.tasks).filter((item) => item.task.objectiveId === objectiveId);
	const attempts = Object.values(runtime.attempts).filter(
		(item) => runtime.tasks[item.taskId]?.task.objectiveId === objectiveId,
	);
	return { tasks, attempts };
}

/**
 * Builds a bounded, redacted projection summarizing runtime state without leaking raw prose or secrets.
 */
export function projectObjectiveForRouting(
	runtime: TaskRuntimeProjection,
	systemOneState: ExecutionState,
	options?: {
		stallTurns?: number;
		repeatedStrategy?: boolean;
		inFlightTools?: number;
	},
): ObjectiveRouteProjection {
	const activeObjectiveId = Object.keys(runtime.objectives)[0] ?? "unknown_objective";
	const { tasks, attempts } = objectiveWork(runtime, activeObjectiveId);
	const openTasks = tasks.filter(
		(t) => t.task.status === "pending" || t.task.status === "ready" || t.task.status === "running",
	).length;
	const activeAttempts = attempts.filter((a) => a.status === "running");

	const verifications = systemOneState.verification ?? [];
	const unresolvedObligations = verifications.filter(
		(v) => v.status === "failed" || v.status === "inconclusive",
	).length;

	const hypotheses = systemOneState.hypotheses ?? [];
	const openHypotheses = hypotheses.filter((h) => h.status === "candidate" || h.status === "investigating").length;

	const changes = systemOneState.changes ?? [];
	const recentMutations = changes.length;

	return {
		objectiveId: activeObjectiveId,
		taskKind: systemOneState.phase,
		totalTasks: tasks.length,
		openTasks,
		inFlightWorkers: activeAttempts.length,
		inFlightTools: options?.inFlightTools ?? 0,
		unresolvedObligations,
		openHypotheses,
		recentMutations,
		evidenceFresh: unresolvedObligations === 0,
		stallTurns: options?.stallTurns ?? 0,
		repeatedStrategy: options?.repeatedStrategy ?? false,
	};
}

export interface BoundedCombinedStateProjection {
	readonly objective: {
		readonly id: string;
		readonly goal: string;
		readonly required_criteria: readonly string[];
		readonly corrected_outcome_pending?: boolean;
	};
	readonly runtime: {
		readonly ready_tasks: readonly string[];
		readonly incomplete_task_count: number;
		readonly running_attempts: readonly string[];
		readonly failed_retryable_tasks: readonly string[];
	};
	readonly integrity: {
		readonly state: "available" | "unavailable";
		readonly fresh_evidence: readonly string[];
		readonly stale_evidence_count: number;
		readonly open_hypotheses: readonly string[];
		readonly failed_verifications: readonly string[];
		readonly recent_changes: readonly string[];
	};
	readonly progress: {
		readonly before_digest: string;
		readonly after_digest: string;
		readonly stall_turns: number;
		readonly strategy_fingerprint: string;
	};
	/** What System One already decided for this objective, oldest first, from the decision ledger. */
	readonly history: {
		readonly recent_routes: readonly {
			readonly route: string;
			readonly reason_codes: readonly string[];
			readonly executor?: string;
		}[];
		readonly repeated_route_count: number;
	};
}

/** A prior route as the projection shows it to the judge. */
export interface RouteHistoryEntry {
	readonly route: string;
	readonly reasonCodes: readonly string[];
	readonly evidenceMarker: number;
	readonly workKey?: string;
	readonly executor?: string;
}

/** Consecutive identical routes at the tail of the history, on unchanged evidence. */
export function repeatedRouteCount(history: readonly RouteHistoryEntry[], currentEvidenceMarker: number): number {
	const last = history.findLast((entry) => !OBJECTIVE_WAIT_ROUTES.includes(entry.route));
	if (!last || last.evidenceMarker !== currentEvidenceMarker) return 0;
	let count = 0;
	for (let index = history.length - 1; index >= 0; index--) {
		const entry = history[index]!;
		if (OBJECTIVE_WAIT_ROUTES.includes(entry.route)) continue;
		if (
			entry.evidenceMarker !== last.evidenceMarker ||
			(last.workKey !== undefined
				? entry.workKey !== last.workKey
				: entry.route !== last.route ||
					entry.workKey !== undefined ||
					entry.reasonCodes.join(",") !== last.reasonCodes.join(","))
		)
			break;
		count++;
	}
	return count;
}

/**
 * FIN-034: Builds the bounded combined state projection for objective routing questions.
 */
export function projectBoundedCombinedState(
	objectiveId: string,
	runtime: TaskRuntimeProjection,
	options?: {
		stallTurns?: number;
		strategyFingerprint?: string;
		beforeDigest?: string;
		afterDigest?: string;
		systemOneState?: ExecutionState;
		candidateDigest?: string;
		integrityState?: "available" | "unavailable";
		history?: readonly RouteHistoryEntry[];
	},
): BoundedCombinedStateProjection {
	const obj = runtime.objectives[objectiveId];
	const { tasks, attempts } = objectiveWork(runtime, objectiveId);
	const readyTasks = tasks.filter((item) => item.task.status === "ready").map((item) => item.task.taskId);
	const runningAttempts = attempts
		.filter((attempt) => attempt.status === "running")
		.map((attempt) => attempt.attemptId);
	const failedRetryableTasks = [
		...new Set(
			attempts.filter((attempt) => attempt.status === "suspended" && attempt.retry).map((attempt) => attempt.taskId),
		),
	];

	const sys = options?.systemOneState;
	const integrityAvailable = options?.integrityState === "available" || sys !== undefined;
	const verifications = sys?.verification ?? [];
	const hypotheses = sys?.hypotheses ?? [];
	const changes = sys?.changes ?? [];

	const freshEvidence = obj ? [...provenObjectiveCriterionIds(obj)] : [];
	const openHypotheses = hypotheses
		.filter((h) => h.status === "candidate" || h.status === "investigating")
		.map((h) => h.id);
	const failedVerifications = verifications
		.filter((v) => v.status === "failed")
		.map((v) => (v as { gate_id?: string; id: string }).gate_id ?? v.id);
	const recentChanges = changes.map((c) => c.path);

	const requiredCriteria = (obj?.objective.acceptanceCriteria ?? [])
		.filter((criterion) => criterion.required)
		.map((criterion) => criterion.id);

	return {
		objective: {
			id: objectiveId,
			goal: obj?.objective.description ?? "",
			required_criteria: requiredCriteria,
			...(objectiveNeedsCorrectedOutcome(obj) ? { corrected_outcome_pending: true } : {}),
		},
		runtime: {
			ready_tasks: readyTasks,
			incomplete_task_count: tasks.filter(
				(item) => item.task.status !== "completed" && item.task.status !== "cancelled",
			).length,
			running_attempts: runningAttempts,
			failed_retryable_tasks: failedRetryableTasks,
		},
		integrity: {
			state: integrityAvailable ? "available" : "unavailable",
			fresh_evidence: freshEvidence,
			stale_evidence_count: integrityAvailable ? failedVerifications.length : 0,
			open_hypotheses: integrityAvailable ? openHypotheses : ["unknown"],
			failed_verifications: integrityAvailable ? failedVerifications : ["integrity_state_unavailable"],
			recent_changes: integrityAvailable ? recentChanges : ["unknown"],
		},
		progress: {
			before_digest: options?.beforeDigest ?? "unknown",
			after_digest: options?.afterDigest ?? options?.candidateDigest ?? "unknown",
			stall_turns: options?.stallTurns ?? 0,
			strategy_fingerprint: options?.strategyFingerprint ?? "init",
		},
		history: {
			recent_routes: (options?.history ?? []).map((entry) => ({
				route: entry.route,
				reason_codes: entry.reasonCodes,
				...(entry.executor ? { executor: entry.executor } : {}),
			})),
			repeated_route_count: options?.history?.length
				? repeatedRouteCount(options.history, evidenceMarkerOf(runtime, objectiveId))
				: 0,
		},
	};
}
