/**
 * The foreground route as the operator's view reads it: who owns the model the foreground turn runs on (`ForegroundRouteSource`)
 * and the bounded snapshot of the root and active models (`ForegroundRouteSnapshot`), with the mapping from a route
 * decision's selection provenance to its source. Pure types and one pure function; `ModelRouterController` builds the
 * snapshot.
 */

import type { RouteDecision } from "../autonomy/contracts.ts";

/** Who owns the model that is executing the foreground turn right now. */
export type ForegroundRouteSource =
	| "direct"
	| "manual"
	| "model_router"
	| "model_router_hmoe"
	| "model_router_system_one"
	| "model_router_retry";

/**
 * Bounded live view of foreground routing for the operator POV. `rootModel` is the persistent
 * session model; `activeModel` is what is actually executing. They differ only while a routed turn
 * has swapped the model, and `switched` says so explicitly so a display never has to compare ids.
 */
export interface ForegroundRouteSnapshot {
	readonly rootModel: string | null;
	readonly activeModel: string | null;
	readonly source: ForegroundRouteSource;
	readonly tier: "cheap" | "medium" | "expensive" | null;
	readonly risk: string | null;
	readonly reasonCode: string | null;
	readonly switched: boolean;
}

/** Route source for a decision, from the persisted selection provenance and retry flag. */
export function foregroundRouteSourceFor(decision: RouteDecision, retry: boolean): ForegroundRouteSource {
	if (retry) return "model_router_retry";
	if (decision.selection === "hmoe") return "model_router_hmoe";
	if (decision.selection === "system_one") return "model_router_system_one";
	if (decision.selection === "auto") return "model_router";
	return "manual";
}
