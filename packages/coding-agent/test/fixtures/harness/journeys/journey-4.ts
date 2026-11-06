import "../builtin-install.ts";
import { runJourney4ChannelsPhase } from "./journey-4-channels.ts";
import { runJourney4OrchestrationGatePhase } from "./journey-4-orchestration-gate.ts";
import { runJourney4TelegramPhase } from "./journey-4-telegram.ts";
/**
 * The real proper-lockfile runs its exclusion and lease logic; only its filesystem is redirected to the
 * active world's virtual fs through the library's own `fs` option, so no lock directory reaches disk.
 * The library's CJS export object is the one production's default import receives, so its functions
 * are rebound in place rather than through an ESM module mock.
 */
import { LIMITS_PATH, runJourney } from "./shared.ts";

export async function runJourney4(): Promise<void> {
	await runJourney(
		{
			name: "journey-4",
			journey: 4,
			// Orchestration enabled: the root orchestrates and its workers carry out the work (the other journeys run the root directly).
			settings: { orchestrator: { delegationGate: true } },
			warningAllowances: [
				// Each refusal of the delegation gate is disclosed once to the owner: exact prefix, the refused operation after it.
				/^The root delegates task work: .+$/,
			],
			files: { [LIMITS_PATH]: "export const MAX_RETRIES = 3;\n" },
		},
		async (world) => {
			await runJourney4OrchestrationGatePhase(world);
			await runJourney4ChannelsPhase(world);
			await runJourney4TelegramPhase(world);
		},
	);
}
