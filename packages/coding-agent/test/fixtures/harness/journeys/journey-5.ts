import "../builtin-install.ts";
import { runJourney5PlanCollectPhase } from "./journey-5-plan-collect.ts";
import { LIMITS_PATH, runJourney } from "./shared.ts";

/**
 * Plans: the root records a plan with one `plan` call and the harness runs it. Each phase drives the real tool, the real
 * executor and real workers on scripted models, and reads the durable plan state the session exposes.
 */
export async function runJourney5(): Promise<void> {
	await runJourney(
		{
			name: "journey-5",
			journey: 5,
			files: { [LIMITS_PATH]: "export const MAX_RETRIES = 3;\n" },
		},
		async (world) => {
			await runJourney5PlanCollectPhase(world);
		},
	);
}
