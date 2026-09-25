import type { ObjectiveRoute } from "../objective-execution/objective-route.ts";

/** Hidden turn trigger. The current goal record is injected ephemerally during context assembly. */
export const GOAL_CONTINUATION_TRIGGER_CUSTOM_TYPE = "goal_continuation_trigger";

export interface GoalContinuationPrompt {
	text: string;
	truncated: false;
}

/**
 * Keep the persisted trigger constant and tiny. Dynamic objective and usage fields belong to the
 * ephemeral compact projection, never to the append-only transcript.
 */
export function buildGoalContinuationPrompt(): GoalContinuationPrompt {
	return {
		text: "Continue active goal.",
		truncated: false,
	};
}

const ROUTE_BRIEFS: Readonly<Record<ObjectiveRoute["route"], string>> = {
	retrieve:
		"Gather the missing evidence: read the code, outputs, or machine and service state that decide the open requirements. Change nothing this turn.",
	investigate: "Investigate the open requirements: find the cause and the exact change needed, then state it.",
	implement:
		"Do the next concrete step toward the open requirements (code, configuration, the machine or a service), then record what it proved.",
	deterministic_test:
		"Run the deterministic checks (tests, builds, commands) for the open requirements and record their receipts.",
	verify: "Verify the open requirements against real receipts: re-run the checks and record what passed or failed.",
	review: "Review the changes against the requirements and name every gap.",
	replan:
		"The current strategy repeated without new evidence. State a different strategy for the open requirements and take its first step.",
	continue_current_worker: "Continue the current worker's scope.",
	wait_for_worker: "Wait for the running worker.",
	wait_for_tool: "Wait for the running tool.",
	escalate_capability: "The task needs a capability this runtime lacks; escalate it.",
	completion_candidate: "The objective looks complete; the completion check runs next.",
	blocked_external: "An external dependency blocks the objective.",
	owner_required: "The owner's authority is required.",
	cancel: "The objective is cancelled.",
	unrecoverable: "The objective is unrecoverable.",
};

/**
 * The prompt for a root turn System One routed: the route, why it was chosen and what it targets.
 * Persisted like the plain trigger; the objective's own state stays in the ephemeral projection.
 */
export function buildObjectiveRoutePrompt(route: ObjectiveRoute): GoalContinuationPrompt {
	const targets = route.target_requirement_ids?.length
		? ` Target requirements: ${route.target_requirement_ids.join(", ")}.`
		: "";
	const why = route.reason_codes.length ? ` (${route.reason_codes.join(", ")})` : "";
	return {
		text: `System One route: ${route.route}${why}.${targets} ${ROUTE_BRIEFS[route.route]}`,
		truncated: false,
	};
}
