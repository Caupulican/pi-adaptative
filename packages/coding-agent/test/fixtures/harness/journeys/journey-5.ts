import "../builtin-install.ts";
import { expect } from "vitest";
import { runJourney5PlanAutoCheckPhase } from "./journey-5-plan-auto-check.ts";
import { runJourney5PlanCollectPhase } from "./journey-5-plan-collect.ts";
import { runJourney5PlanCrashPhase } from "./journey-5-plan-crash.ts";
import { runJourney5PlanGoalWaitPhase } from "./journey-5-plan-goal-wait.ts";
import { runJourney5PlanOrderPhase } from "./journey-5-plan-order.ts";
import { runJourney5PlanOriginPhase } from "./journey-5-plan-origin.ts";
import { runJourney5PlanRacePhase } from "./journey-5-plan-race.ts";
import { runJourney5PlanReducePhase } from "./journey-5-plan-reduce.ts";
import { runJourney5PlanRestartPhase } from "./journey-5-plan-restart.ts";
import { runJourney5PlanResultGatePhase } from "./journey-5-plan-result-gate.ts";
import { runJourney5PlanReviseCancelPhase } from "./journey-5-plan-revise-cancel.ts";
import { runJourney5PlanVerifyAcceptedPhase } from "./journey-5-plan-verify.ts";
import {
	ORIGINAL_TIMEOUTS,
	runJourney5PlanVerifyRejectedPhase,
	TIMEOUTS_PATH,
} from "./journey-5-plan-verify-rejected.ts";
import { runJourney5PlanVotePhase } from "./journey-5-plan-vote.ts";
import { LIMITS_PATH, runJourney } from "./shared.ts";

/**
 * Plans: the root records a plan with one `plan` call and the harness runs it. Each phase drives the real tool, the real
 * executor and real workers on scripted models, and reads the durable plan state the session exposes. The phases share one
 * root session: a root runs plan after plan, and a closed plan never stands in the way of the next.
 */
export async function runJourney5(): Promise<void> {
	await runJourney(
		{
			name: "journey-5",
			journey: 5,
			files: { [LIMITS_PATH]: "export const MAX_RETRIES = 3;\n", [TIMEOUTS_PATH]: ORIGINAL_TIMEOUTS },
		},
		async (world) => {
			const fleet = world.settingsManager.getGlobalSettings().fleet ?? {};
			world.settingsManager.setFleetSettings({ ...fleet, ceiling: { ...fleet.ceiling, running: 4 } });
			const { session } = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
			await runJourney5PlanCollectPhase(world, session);
			await runJourney5PlanRacePhase(world, session);
			await runJourney5PlanReducePhase(world, session);
			await runJourney5PlanOriginPhase(world, session);
			await runJourney5PlanAutoCheckPhase(world, session);
			await runJourney5PlanVerifyRejectedPhase(world, session);
			await runJourney5PlanReviseCancelPhase(world, session);
			await runJourney5PlanResultGatePhase(world, session);
			await runJourney5PlanVotePhase(world, session);
			await runJourney5PlanOrderPhase(world, session);
			expect(await world.disposeSessionInBody(session), "the plans owner disposes cleanly").toBeUndefined();
			// A plan under a goal runs in its own session: the goal is that session's, and ends with it.
			await runJourney5PlanVerifyAcceptedPhase(world);
			// A plan whose owner closes and reopens mid-plan runs in its own session, which the phase closes and opens again.
			await runJourney5PlanRestartPhase(world);
			await runJourney5PlanCrashPhase(world);
			// A plan under a goal holds that goal's wait: the wake, its deadline on the orchestration clock, and the plan's own end.
			await runJourney5PlanGoalWaitPhase(world);
		},
	);
}
