import "../builtin-install.ts";
import { runJourney7DepthPhase } from "./journey-7-depth.ts";
import { runJourney7LeaderPhase } from "./journey-7-leader.ts";
import { runJourney7LifecyclePhase } from "./journey-7-lifecycle.ts";
import { runJourney7OwnerMessagesPhase } from "./journey-7-owner-messages.ts";
import { runJourney7RootBotPhase } from "./journey-7-root-bot.ts";
import { runJourney7TreeAttemptAdmission } from "./journey-7-tree-attempt-admission.ts";
import { runJourney7WorkerHeadroomPhase } from "./journey-7-worker-headroom.ts";
import { runJourney } from "./shared.ts";

/**
 * Bots and leaders: one world in which the root creates and asks a bot, the owner writes to a bot and to a group, a standing
 * leader runs a subtree of its own, a bot that is not a leader is refused a bot of its own, the leader depth limit holds,
 * and retirement and stopping keep their promises. Each leg group runs its own root session and leaves nothing running.
 */
export async function runJourney7(): Promise<void> {
	await runJourney(
		{
			name: "journey-7",
			journey: 7,
			warningAllowances: [
				// The prompt-prefix monitor's report of an intended rewrite: a stopped worker's closing turn adds its HALT CLOSING
				// TURN section to the system prompt, and the worker's next request drops it. The stop leg halts two workers.
				/^Prompt cache prefix changed between requests: system prompt changed \(\d+ to \d+ chars\) from char \d+ of \d+: .*HALT CLOSING TURN.*\. Cache reuse may be reduced from that point\.$/,
			],
		},
		async (world) => {
			await runJourney7RootBotPhase(world);
			await runJourney7OwnerMessagesPhase(world);
			await runJourney7LeaderPhase(world);
			await runJourney7WorkerHeadroomPhase(world);
			await runJourney7TreeAttemptAdmission(world);
			await runJourney7DepthPhase(world);
			await runJourney7LifecyclePhase(world);
		},
	);
}
