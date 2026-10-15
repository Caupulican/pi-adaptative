/** The operator-facing words for which model answers and who chose it; shared by every view that names a route. */

import type { ForegroundRouteSnapshot } from "./model-router-controller.ts";

/** The short model name an operator recognises: the id without its provider prefix. */
export function shortModelName(ref: string | null | undefined): string {
	if (!ref) return "none";
	const slash = ref.indexOf("/");
	return slash === -1 ? ref : ref.slice(slash + 1);
}

/** The ROUTE value: who chose the active model, in the operator's words, never claiming more. */
export function formatRouteValue(route: ForegroundRouteSnapshot): string {
	switch (route.source) {
		case "direct":
			return "direct";
		case "manual":
			return `manual:${shortModelName(route.activeModel)}`;
		case "model_router_retry":
			return `escalated→${shortModelName(route.activeModel)} via model-router`;
		case "model_router_hmoe":
			return `${route.tier ?? "routed"} via model-router/H-MoE`;
		case "model_router_system_one":
			return `${route.tier ?? "routed"} via model-router/System One`;
		default: {
			const tier = route.tier ?? "routed";
			return route.risk === "read-only" ? `${tier}/read-only via model-router` : `${tier} via model-router`;
		}
	}
}
