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

/** An executor with preflight owns its submission callback. A single-stage executor accepts on invocation. */
export interface ObjectiveRouteExecutor {
	readonly reportsAdmission?: boolean;
	execute(route: ObjectiveRoute, signal?: AbortSignal, submitted?: () => void): Promise<void>;
}

export const OBJECTIVE_WAIT_ROUTES: readonly string[] = ["wait_for_worker", "wait_for_tool"];
export const SCOPE_REPLAN_EXECUTOR = "root:scope-replan";
export const PENDING_WORKER_EXECUTOR = "worker:pending";
export type RetrievalDisposition = "root" | "worker" | typeof PENDING_WORKER_EXECUTOR;
export type WorkerRouteAdmission =
	| { readonly started: true }
	| { readonly started: false; readonly pending?: true; readonly reason: string };

/** Scheduling and running a worker are separate durable transitions. A queued task retains ownership. */
export function workerRouteAdmission(run: {
	started?: boolean;
	record?: unknown;
	skipReason?: string;
}): WorkerRouteAdmission {
	const record = run.record && typeof run.record === "object" ? run.record : undefined;
	const status = record && "status" in record ? record.status : undefined;
	if (record && "firstStartedAt" in record && typeof record.firstStartedAt === "string" && record.firstStartedAt)
		return { started: true };
	if (status === "queued" || status === "running" || (!record && run.started))
		return { started: false, pending: true, reason: "worker_admission_pending" };
	return { started: false, reason: run.skipReason ?? "worker_not_started" };
}

export interface ObjectiveTerminalResult {
	readonly goalCompletionKey?: string;
	readonly status:
		| "complete"
		| "incomplete"
		| "cancelled"
		| "budget_exhausted"
		| "blocked"
		| "unrecoverable"
		| "semantic_gate_unavailable"
		| "executor_unavailable";
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
