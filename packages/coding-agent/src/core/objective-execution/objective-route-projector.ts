/**
 * Objective Route Projector.
 * Builds bounded, redacted projection for Jev semantic routing questions.
 */

import type { TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import type { ExecutionState } from "../system-one/types.ts";

export interface SemanticRouteJudgments {
	workRemaining?: boolean;
	missingWorkClass?:
		| "retrieve"
		| "investigate"
		| "implement"
		| "deterministic_test"
		| "verify"
		| "review"
		| "replan"
		| "none"
		| "insufficient_evidence";
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
	const tasks = Object.values(runtime.tasks);
	const openTasks = tasks.filter((t) => t.task.status === "pending" || t.task.status === "running").length;
	const activeAttempts = Object.values(runtime.attempts).filter((a) => a.status === "running");

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
