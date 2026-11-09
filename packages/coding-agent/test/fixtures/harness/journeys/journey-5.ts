import "../builtin-install.ts";
import { expect } from "vitest";
import { runJourney5PlanCollectPhase } from "./journey-5-plan-collect.ts";
import { runJourney5PlanRacePhase } from "./journey-5-plan-race.ts";
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
			files: { [LIMITS_PATH]: "export const MAX_RETRIES = 3;\n" },
		},
		async (world) => {
			const fleet = world.settingsManager.getGlobalSettings().fleet ?? {};
			world.settingsManager.setFleetSettings({ ...fleet, ceiling: { ...fleet.ceiling, running: 4 } });
			const { session } = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
			await runJourney5PlanCollectPhase(world, session);
			await runJourney5PlanRacePhase(world, session);
			expect(await world.disposeSessionInBody(session), "the plans owner disposes cleanly").toBeUndefined();
		},
	);
}
