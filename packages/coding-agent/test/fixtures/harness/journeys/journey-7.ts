import "../builtin-install.ts";
import { runJourney7BotDelegatePhase } from "./journey-7-bot-delegate.ts";
import { runJourney7BotGoalPhase } from "./journey-7-bot-goal.ts";
import { runJourney7BotHomePhase } from "./journey-7-bot-home.ts";
import { runJourney7BotMailPhase, runJourney7WorkerMailPhase } from "./journey-7-bot-mail.ts";
import { runJourney7BotPlanPhase } from "./journey-7-bot-plan.ts";
import { runJourney7BotSpendPhase } from "./journey-7-bot-spend.ts";
import { runJourney7BotWatchPhase } from "./journey-7-bot-watch.ts";
import { runJourney7DaemonBotPhase, runJourney7ProjectBotSchedules } from "./journey-7-daemon-bot.ts";
import { runJourney7DepthPhase } from "./journey-7-depth.ts";
import { runJourney7LeaderPhase } from "./journey-7-leader.ts";
import { runJourney7LifecyclePhase } from "./journey-7-lifecycle.ts";
import { runJourney7OwnerMessagesPhase } from "./journey-7-owner-messages.ts";
import { runJourney7RootBotPhase } from "./journey-7-root-bot.ts";
import { runJourney7TreeAttemptAdmission } from "./journey-7-tree-attempt-admission.ts";
import { runJourney7WorkerHeadroomPhase } from "./journey-7-worker-headroom.ts";
import { runJourney } from "./shared.ts";

/**
 * Bots and leaders: one world in which the root creates and asks a bot, the owner writes to a bot and to a group, a bot mails another bot and its answer comes back once, a worker's bot_message to a bot reaches that bot's own session and the answer comes back to the worker, the detached daemon answers a bot while no root session is open, a bot's priced answers are charged to the main session once per range, a bot
 * waits on its own work with a watch its own session holds, a bot directs workers of its own, a bot continues a goal of its own after it goes idle and settles it, a standing leader runs a subtree of its own, a bot that is not
 * a leader is refused a bot of its own, the leader depth limit holds, retirement and stopping keep their promises, and a bot's own session lives in its home. Each leg group runs its own root session and leaves nothing running.
 */
export async function runJourney7(): Promise<void> {
	await runJourney(
		{
			name: "journey-7",
			journey: 7,
			warningAllowances: [
				// The owner-messages leg plants an inbox file that neither reads nor can be set aside: told once per file it is.
				/^Bot held-elsewhere: an inbox message could not be read \(.+\) nor set aside \(.+\); it stays in place, is not counted as waiting, and is read again at most \d+ minutes apart until it reads, told only this once\.$/,
			],
		},
		async (world) => {
			await runJourney7RootBotPhase(world);
			await runJourney7OwnerMessagesPhase(world);
			await runJourney7BotMailPhase(world);
			await runJourney7WorkerMailPhase(world);
			await runJourney7DaemonBotPhase(world);
			await runJourney7ProjectBotSchedules(world);
			await runJourney7BotSpendPhase(world);
			await runJourney7BotWatchPhase(world);
			await runJourney7BotDelegatePhase(world);
			await runJourney7BotPlanPhase(world);
			await runJourney7BotGoalPhase(world);
			await runJourney7LeaderPhase(world);
			await runJourney7WorkerHeadroomPhase(world);
			await runJourney7TreeAttemptAdmission(world);
			await runJourney7DepthPhase(world);
			await runJourney7LifecyclePhase(world);
			await runJourney7BotHomePhase(world);
		},
	);
}
