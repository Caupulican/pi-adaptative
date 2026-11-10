import "../builtin-install.ts";
import { DEFAULT_ACTIVE_TOOL_NAMES } from "../../../../src/core/default-tool-surface.ts";
import { ORIGINAL_TIMEOUTS, TIMEOUTS_PATH } from "./journey-5-plan-verify-rejected.ts";
import { runJourney6LaneEndPhase, runJourney6PlanMergePhase } from "./journey-6-plan-merge.ts";
import { LIMITS_PATH, ORIGINAL_LIMITS, runJourney } from "./shared.ts";

/**
 * Plan lanes: a plan whose steps change files and are combined by a merge join. Each such step's worker works in its own
 * worktree lane, and the join lands the lanes on main in the plan's order. The world is a repository with a clean checkout
 * on main, which is what a lane needs to be the same code its worker would have seen.
 */
export async function runJourney6(): Promise<void> {
	await runJourney(
		{
			name: "journey-6",
			journey: 6,
			// worktree_sync is opt-in for the root: the owner's default-tools setting names it beside the default surface.
			settings: { defaultTools: [...DEFAULT_ACTIVE_TOOL_NAMES, "worktree_sync"] },
			files: { [LIMITS_PATH]: ORIGINAL_LIMITS, [TIMEOUTS_PATH]: ORIGINAL_TIMEOUTS },
			repository: { committed: { "src/limits.ts": ORIGINAL_LIMITS, "src/timeouts.ts": ORIGINAL_TIMEOUTS } },
		},
		async (world) => {
			const { session } = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
			await runJourney6PlanMergePhase(world, session);
			await runJourney6LaneEndPhase(world, session);
		},
	);
}
