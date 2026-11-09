/**
 * What a land attempt leaves to do: landed, nothing to land, or an ordered worklist the lane's worker or the parent can act
 * on, read from the land gate's refusal. The gate refuses in its own order, so the worklist names the first item still open.
 */

import type { LandResult } from "./codes.ts";

/** One step the lane's worker or the parent takes before the land can go through. */
export type LandingItem =
	| { readonly kind: "commit_lane_paths"; readonly paths: readonly string[] }
	| { readonly kind: "sync_lane" }
	| { readonly kind: "clear_hub_paths"; readonly paths: readonly string[] }
	| { readonly kind: "finish_rebase" }
	| { readonly kind: "retry_land"; readonly holder?: string }
	| { readonly kind: "fix_gate"; readonly detail: string };

export type LaneLanding =
	| { readonly kind: "landed"; readonly laneKey: string; readonly mainSha: string }
	| { readonly kind: "nothing_to_land"; readonly laneKey: string }
	| { readonly kind: "worklist"; readonly laneKey: string; readonly item: LandingItem }
	| { readonly kind: "failed"; readonly laneKey: string; readonly code: string; readonly detail: string };

/** The landing outcome of one land gate result for the lane `laneKey`. */
export function landingOutcome(laneKey: string, result: LandResult): LaneLanding {
	switch (result.code) {
		case "ok":
			return { kind: "landed", laneKey, mainSha: result.mainSha };
		case "nothing_to_land":
			return { kind: "nothing_to_land", laneKey };
		case "lane_dirty":
			return { kind: "worklist", laneKey, item: { kind: "commit_lane_paths", paths: result.paths ?? [] } };
		case "stale_lane":
			return { kind: "worklist", laneKey, item: { kind: "sync_lane" } };
		case "hub_dirty":
			return { kind: "worklist", laneKey, item: { kind: "clear_hub_paths", paths: result.paths ?? [] } };
		case "rebase_in_progress":
			return { kind: "worklist", laneKey, item: { kind: "finish_rebase" } };
		case "lock_busy":
			return {
				kind: "worklist",
				laneKey,
				item: { kind: "retry_land", ...(result.holder?.sessionId ? { holder: result.holder.sessionId } : {}) },
			};
		case "lane_changed_during_gate":
			return { kind: "worklist", laneKey, item: { kind: "retry_land" } };
		case "gate_failed":
			return { kind: "worklist", laneKey, item: { kind: "fix_gate", detail: result.message } };
		default:
			return { kind: "failed", laneKey, code: result.code, detail: result.message };
	}
}
