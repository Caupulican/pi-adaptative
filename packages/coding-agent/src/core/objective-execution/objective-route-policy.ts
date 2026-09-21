/**
 * Objective Route Policy Composition.
 * Implements deterministic route composition precedence per JEV_ROUTING_CONTRACT.md.
 */

import {
	OBJECTIVE_ROUTE_SCHEMA_VERSION,
	type ObjectiveRoute,
	type ObjectiveRouteName,
	validateObjectiveRoute,
} from "./objective-route.ts";
import type { SemanticRouteJudgments } from "./objective-route-projector.ts";

export interface RouteCompositionInput {
	readonly cycleId: string;
	readonly objectiveId: string;
	readonly cancelled?: boolean;
	readonly budgetExhausted?: boolean;
	readonly unrecoverable?: boolean;
	readonly requiredWorkerInFlight?: boolean;
	readonly requiredToolInFlight?: boolean;
	readonly externalBlocker?: boolean;
	readonly ownerRequired?: boolean;
	readonly strategyRepetition?: boolean;
	readonly contextStale?: boolean;
	readonly semantic?: SemanticRouteJudgments;
	readonly taskId?: string | null;
	readonly attemptId?: string | null;
	readonly targetRequirementIds?: readonly string[];
	readonly targetHypothesisIds?: readonly string[];
	/** Executable System One preflight/postflight/tool-gate outcome, translated into a route. */
	readonly systemOneDirective?: {
		readonly objectiveRoute: ObjectiveRouteName;
		readonly reasonCodes: readonly string[];
	};
	/** Root-owned worker-supervision request after the worker is no longer in flight. */
	readonly supervisionRequest?: {
		readonly action: "request_specialist" | "request_capability" | "request_verifier";
		readonly reasonCodes: readonly string[];
	};
}

/**
 * Composes an ObjectiveRoute following the strict precedence defined in JEV_ROUTING_CONTRACT.md:
 * 1. deterministic cancellation/budget/invariant;
 * 2. active required worker/tool waits;
 * 3. external/owner blocker;
 * 4. repeated strategy/stale context;
 * 5. work remaining;
 * 6. missing work class;
 * 7. independence & capability escalation;
 * 8. dispatch / continuation.
 */
export function composeObjectiveRoute(input: RouteCompositionInput): ObjectiveRoute {
	const cycleId = input.cycleId;
	const objectiveId = input.objectiveId;
	const sem = input.semantic ?? {};

	// 1. Deterministic cancellation / budget / invariant
	if (input.cancelled) {
		return buildRoute(cycleId, objectiveId, "cancel", ["deterministic_cancellation"], input);
	}
	if (input.budgetExhausted) {
		return buildRoute(cycleId, objectiveId, "cancel", ["budget_exhausted"], input);
	}
	if (input.unrecoverable) {
		return buildRoute(cycleId, objectiveId, "unrecoverable", ["deterministic_unrecoverable_state"], input);
	}

	// 2. Active required worker / tool waits
	if (input.requiredWorkerInFlight) {
		return buildRoute(cycleId, objectiveId, "wait_for_worker", ["active_worker_in_flight"], input);
	}
	if (input.requiredToolInFlight) {
		return buildRoute(cycleId, objectiveId, "wait_for_tool", ["active_tool_in_flight"], input);
	}

	// 3. External / owner blocker
	if (input.externalBlocker || sem.externalBlockerPresent) {
		return buildRoute(cycleId, objectiveId, "blocked_external", ["external_dependency_unavailable"], input);
	}
	if (input.ownerRequired) {
		return buildRoute(cycleId, objectiveId, "owner_required", ["owner_authorization_required"], input);
	}

	if (input.supervisionRequest?.action === "request_specialist") {
		return buildRoute(
			cycleId,
			objectiveId,
			"escalate_capability",
			["specialist_gap_detected", ...input.supervisionRequest.reasonCodes],
			input,
		);
	}
	if (input.supervisionRequest?.action === "request_capability") {
		return buildRoute(
			cycleId,
			objectiveId,
			"escalate_capability",
			["capability_gap_detected", ...input.supervisionRequest.reasonCodes],
			input,
		);
	}
	if (input.supervisionRequest?.action === "request_verifier") {
		return buildRoute(
			cycleId,
			objectiveId,
			"verify",
			["independent_verification_needed", ...input.supervisionRequest.reasonCodes],
			input,
		);
	}

	if (input.systemOneDirective) {
		return buildRoute(
			cycleId,
			objectiveId,
			input.systemOneDirective.objectiveRoute,
			[...input.systemOneDirective.reasonCodes],
			input,
		);
	}

	// 4. Repeated strategy / stale context
	if (input.strategyRepetition || sem.strategyRepetition) {
		return buildRoute(cycleId, objectiveId, "replan", ["strategy_repetition_detected"], input);
	}
	if (input.contextStale || sem.contextStale) {
		return buildRoute(cycleId, objectiveId, "replan", ["worker_context_stale"], input);
	}

	// 5. Work remaining
	if (
		sem.workRemaining === false &&
		(!sem.missingWorkClass || sem.missingWorkClass === "none" || sem.missingWorkClass === "completion_candidate")
	) {
		return buildRoute(cycleId, objectiveId, "completion_candidate", ["no_work_remaining_criteria_proven"], input);
	}

	// 6. Missing work class
	const workClass = sem.missingWorkClass ?? "implement";
	switch (workClass) {
		case "none":
		case "completion_candidate":
			return buildRoute(cycleId, objectiveId, "completion_candidate", ["missing_work_none"], input);

		case "retrieve":
		case "insufficient_evidence":
			return buildRoute(cycleId, objectiveId, "retrieve", ["evidence_retrieval_required"], input);

		case "deterministic_test":
			return buildRoute(cycleId, objectiveId, "deterministic_test", ["verification_tests_required"], input);

		case "verify":
			if (sem.independentWorkerRequired) {
				return buildRoute(cycleId, objectiveId, "verify", ["independent_verification_required"], input);
			}
			return buildRoute(cycleId, objectiveId, "verify", ["verification_required"], input);

		case "review":
			return buildRoute(cycleId, objectiveId, "review", ["peer_review_required"], input);

		case "replan":
			return buildRoute(cycleId, objectiveId, "replan", ["replan_required"], input);

		case "investigate":
			return buildRoute(cycleId, objectiveId, "investigate", ["investigation_required"], input);

		default:
			// 7. Capability escalation / continuation
			if (sem.capabilityEscalationRequired) {
				return buildRoute(cycleId, objectiveId, "escalate_capability", ["capability_escalation_required"], input);
			}
			if (sem.currentWorkerCanContinue && !sem.independentWorkerRequired) {
				return buildRoute(
					cycleId,
					objectiveId,
					"continue_current_worker",
					["same_worker_scope_continuation"],
					input,
				);
			}
			return buildRoute(cycleId, objectiveId, "implement", ["implementation_required"], input);
	}
}

function buildRoute(
	cycleId: string,
	objectiveId: string,
	route: ObjectiveRouteName,
	reasonCodes: string[],
	input: RouteCompositionInput,
): ObjectiveRoute {
	const out: ObjectiveRoute = {
		schema_version: OBJECTIVE_ROUTE_SCHEMA_VERSION,
		cycle_id: cycleId,
		objective_id: objectiveId,
		route,
		reason_codes: reasonCodes,
		...(input.taskId ? { task_id: input.taskId } : {}),
		...(input.attemptId ? { attempt_id: input.attemptId } : {}),
		...(input.targetRequirementIds ? { target_requirement_ids: input.targetRequirementIds } : {}),
		...(input.targetHypothesisIds ? { target_hypothesis_ids: input.targetHypothesisIds } : {}),
	};
	validateObjectiveRoute(out);
	return out;
}
