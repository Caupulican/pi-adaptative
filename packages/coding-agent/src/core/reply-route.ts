import type { ForegroundRouteSnapshot } from "./model-router-controller.ts";

/**
 * Session custom entry recording the route of a reply that a routed model wrote, keyed by the reply's
 * timestamp, so a reloaded conversation names the same author and route the live one showed.
 */
export const REPLY_ROUTE_CUSTOM_TYPE = "reply_route";

export interface ReplyRouteRecord {
	readonly timestamp: number;
	readonly route: ForegroundRouteSnapshot;
}
