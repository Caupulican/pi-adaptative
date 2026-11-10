/** The operator-facing words for which model answers and who chose it; shared by every view that names a route. */

import { interfaceText } from "./language/interface-text.ts";
import type { ForegroundRouteSnapshot } from "./model-router-controller.ts";

/** The short model name an operator recognises: the id without its provider prefix. */
export function shortModelName(ref: string | null | undefined): string {
	if (!ref) return interfaceText().conversation.noModelName;
	const slash = ref.indexOf("/");
	return slash === -1 ? ref : ref.slice(slash + 1);
}

/** The ROUTE value: who chose the active model, in the operator's words, never claiming more. */
export function formatRouteValue(route: ForegroundRouteSnapshot): string {
	const text = interfaceText().conversation;
	const tier = route.tier ?? text.tierRouted;
	switch (route.source) {
		case "direct":
			return text.routeDirect;
		case "manual":
			return text.routeChosenByYou(shortModelName(route.activeModel));
		case "model_router_retry":
			return text.routeEscalated(shortModelName(route.activeModel));
		case "model_router_hmoe":
			return text.routeHmoe(tier);
		case "model_router_system_one":
			return text.routeSystemOne(tier);
		default:
			return route.risk === "read-only" ? text.routeReadOnly(tier) : text.routeRouted(tier);
	}
}
