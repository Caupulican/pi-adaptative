import "../builtin-install.ts";
import { runJourney9BudgetPhase } from "./journey-9-budget.ts";
import { runJourney9FixAndOwnerPhase } from "./journey-9-fix-and-owner.ts";
import { runJourney9HostCheckPhase } from "./journey-9-host-check.ts";
import { runJourney9OwnWordsPhase } from "./journey-9-own-words.ts";
import { LIMITS_PATH, ORIGINAL_LIMITS, runJourney } from "./shared.ts";

/**
 * The escalation ladder: what the host decides when a worker falls short. Each leg runs one decision the table in
 * `decideNextAction` makes, read from the outcome the session records for the worker's task, from the terminal handoff the
 * root is given, and from the owner decision queue. The exits pinned here are E2 (a blocker the parent can fix), E3 (a
 * blocker only the owner answers), E13 skipped and E18 (a worker's own blocker words, and nothing left to try), E10 (a
 * spent budget), and E12 then E0 (a requirement check the host runs because the worker left the requirement uncovered).
 *
 * System One answers one root turn per leg: the owner request's intake questions. A start that names a read-only profile
 * passes no tool screen, a worker's own turn asks nothing, and no outcome projection asks, so no other judgment is scripted.
 */
export async function runJourney9(): Promise<void> {
	await runJourney(
		{
			name: "journey-9",
			journey: 9,
			files: { [LIMITS_PATH]: ORIGINAL_LIMITS },
		},
		async (world) => {
			await runJourney9FixAndOwnerPhase(world);
			await runJourney9OwnWordsPhase(world);
			await runJourney9BudgetPhase(world);
			await runJourney9HostCheckPhase(world);
		},
	);
}
