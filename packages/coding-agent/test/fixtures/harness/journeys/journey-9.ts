import "../builtin-install.ts";
import { ORIGINAL_TIMEOUTS, TIMEOUTS_PATH } from "./journey-5-plan-verify-rejected.ts";
import { runJourney9BudgetPhase } from "./journey-9-budget.ts";
import { runJourney9FixAndOwnerPhase } from "./journey-9-fix-and-owner.ts";
import { runJourney9HostCheckPhase } from "./journey-9-host-check.ts";
import { runJourney9OwnWordsPhase } from "./journey-9-own-words.ts";
import { runJourney9RerunAndModelMovePhase } from "./journey-9-rerun-and-model-move.ts";
import { runJourney9RouterFitnessPhase } from "./journey-9-router-fitness.ts";
import { runJourney9WorktreeRerunPhase } from "./journey-9-worktree-rerun.ts";
import { LIMITS_PATH, ORIGINAL_LIMITS, runJourney } from "./shared.ts";

/**
 * The escalation ladder: what the host decides when a worker falls short. Each leg runs one decision the table in
 * `decideNextAction` makes, read from the outcome the session records for the worker's task, from the terminal handoff the
 * root is given, and from the owner decision queue. The exits pinned here are E2 (a blocker the parent can fix), E3 (a
 * blocker only the owner answers), E18 (a worker's own blocker words, and nothing left to try), E10 (a spent budget),
 * E12 then E0 (a requirement check the host runs because the worker left the requirement uncovered), E14 -> E15 -> E0 plus
 * wall-clock timeout reruns (multi-rung thinking raise to ordered-fallback model move, and timeout rerun at unchanged thinking), and
 * worktree-lane reruns (X2 in-place attempt reuse vs X1 fresh-lane superseding rerun with full requirement expansion).
 *
 * The task-fitness leg also checks that an inherited route skips inadequate and open candidates before admitting an
 * adequate one. It runs only with System One enabled. The other legs leave task fitness off.
 */
export async function runJourney9(): Promise<void> {
	await runJourney(
		{
			name: "journey-9",
			journey: 9,
			files: { [LIMITS_PATH]: ORIGINAL_LIMITS, [TIMEOUTS_PATH]: ORIGINAL_TIMEOUTS },
			repository: { committed: { "src/limits.ts": ORIGINAL_LIMITS, "src/timeouts.ts": ORIGINAL_TIMEOUTS } },
		},
		async (world) => {
			await runJourney9FixAndOwnerPhase(world);
			await runJourney9OwnWordsPhase(world);
			await runJourney9BudgetPhase(world);
			await runJourney9HostCheckPhase(world);
			await runJourney9RerunAndModelMovePhase(world);
			await runJourney9WorktreeRerunPhase(world);
			await runJourney9RouterFitnessPhase(world);
		},
	);
}
