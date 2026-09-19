import type { DeliveryBundle } from "./delivery-bundle.ts";

/**
 * Objective Route Types, Validation, and Codecs.
 * Conforms to schemas/objective-route.schema.json.
 */

export const OBJECTIVE_ROUTE_SCHEMA_VERSION = "1.0" as const;

export type ObjectiveRouteName =
	| "retrieve"
	| "investigate"
	| "implement"
	| "deterministic_test"
	| "verify"
	| "review"
	| "replan"
	| "continue_current_worker"
	| "wait_for_worker"
	| "wait_for_tool"
	| "escalate_capability"
	| "completion_candidate"
	| "blocked_external"
	| "owner_required"
	| "cancel"
	| "unrecoverable";

export const VALID_OBJECTIVE_ROUTES: ReadonlySet<ObjectiveRouteName> = new Set([
	"retrieve",
	"investigate",
	"implement",
	"deterministic_test",
	"verify",
	"review",
	"replan",
	"continue_current_worker",
	"wait_for_worker",
	"wait_for_tool",
	"escalate_capability",
	"completion_candidate",
	"blocked_external",
	"owner_required",
	"cancel",
	"unrecoverable",
]);

export interface ObjectiveRoute {
	readonly schema_version: typeof OBJECTIVE_ROUTE_SCHEMA_VERSION;
	readonly cycle_id: string;
	readonly objective_id: string;
	readonly route: ObjectiveRouteName;
	readonly reason_codes: readonly string[];
	readonly task_id?: string | null;
	readonly attempt_id?: string | null;
	readonly target_requirement_ids?: readonly string[];
	readonly target_hypothesis_ids?: readonly string[];
	readonly validation_decision_ids?: readonly string[];
}

export interface ObjectiveTerminalResult {
	readonly status:
		| "complete"
		| "cancelled"
		| "budget_exhausted"
		| "blocked"
		| "unrecoverable"
		| "semantic_gate_unavailable";
	readonly reasonCodes: readonly string[];
	readonly completionDecisionId?: string;
	readonly cycleCount?: number;
	readonly deliveryBundle?: DeliveryBundle;
}

export class ObjectiveRouteValidationError extends Error {
	constructor(message: string) {
		super(`ObjectiveRouteValidationError: ${message}`);
		this.name = "ObjectiveRouteValidationError";
	}
}

/**
 * Validates an ObjectiveRoute object against the schema requirements.
 */
export function validateObjectiveRoute(value: unknown): asserts value is ObjectiveRoute {
	if (!value || typeof value !== "object") {
		throw new ObjectiveRouteValidationError("Route must be a non-null object.");
	}

	const route = value as Record<string, unknown>;

	if (route.schema_version !== OBJECTIVE_ROUTE_SCHEMA_VERSION) {
		throw new ObjectiveRouteValidationError(
			`Invalid schema_version '${String(route.schema_version)}', expected '${OBJECTIVE_ROUTE_SCHEMA_VERSION}'.`,
		);
	}

	if (typeof route.cycle_id !== "string" || !route.cycle_id.trim()) {
		throw new ObjectiveRouteValidationError("cycle_id must be a non-empty string.");
	}

	if (typeof route.objective_id !== "string" || !route.objective_id.trim()) {
		throw new ObjectiveRouteValidationError("objective_id must be a non-empty string.");
	}

	if (typeof route.route !== "string" || !VALID_OBJECTIVE_ROUTES.has(route.route as ObjectiveRouteName)) {
		throw new ObjectiveRouteValidationError(`Invalid route '${String(route.route)}'.`);
	}

	if (!Array.isArray(route.reason_codes) || route.reason_codes.length === 0) {
		throw new ObjectiveRouteValidationError("reason_codes must be a non-empty array of strings.");
	}

	for (const code of route.reason_codes) {
		if (typeof code !== "string" || !code.trim()) {
			throw new ObjectiveRouteValidationError("Each reason_code must be a non-empty string.");
		}
	}

	if (route.task_id !== undefined && route.task_id !== null && typeof route.task_id !== "string") {
		throw new ObjectiveRouteValidationError("task_id must be string or null.");
	}

	if (route.attempt_id !== undefined && route.attempt_id !== null && typeof route.attempt_id !== "string") {
		throw new ObjectiveRouteValidationError("attempt_id must be string or null.");
	}
}

/**
 * Maps terminal routes onto explicit ObjectiveTerminalResult shapes.
 */
export function routeToTerminal(route: ObjectiveRoute): ObjectiveTerminalResult {
	switch (route.route) {
		case "cancel":
			return { status: "cancelled", reasonCodes: route.reason_codes };
		case "blocked_external":
		case "owner_required":
			return { status: "blocked", reasonCodes: route.reason_codes };
		case "unrecoverable":
			return { status: "unrecoverable", reasonCodes: route.reason_codes };
		default:
			throw new Error(`Route '${route.route}' is not a terminal route.`);
	}
}
