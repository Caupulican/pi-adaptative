/**
 * The owner's notice of a plan an older build lost: that build read the plan as one from a newer build and, compacting
 * the session, kept only its identity (`isPlanLostToOlderBuild`). What the plan said is gone and no build will run it, so
 * the owner is told, once per plan and session: each plan is its own episode (`scope`, and its id in `reason`, which
 * names the notice's delivery), and the harness notices find a notice already saved for it when the session opens again.
 */

import { type HarnessNoticeObservation, wordedNotice } from "../harness-notice.ts";
import { isPlanLostToOlderBuild, type PlanRuntimeState } from "./plan-graph.ts";

/** One notice per plan of `plans` lost to an older build's compaction. */
export function lostPlanNotices(plans: Readonly<Record<string, PlanRuntimeState>>): HarnessNoticeObservation[] {
	return Object.entries(plans).flatMap(([planId, plan]) =>
		isPlanLostToOlderBuild(plan.record)
			? [
					{
						scope: planId,
						state: wordedNotice(`older-build-compaction:${planId}`, (words) =>
							words.autonomyCommands.plan.lostHeading(planId),
						),
					},
				]
			: [],
	);
}
