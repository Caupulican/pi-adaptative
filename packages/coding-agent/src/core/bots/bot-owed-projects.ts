/** Which project may resume a bot with outstanding work and project-bound inbox deliveries. */
import type { BotInboxItem } from "./bot-inbox.ts";
import type { SavedBotSession } from "./bot-remote-view.ts";
/** A bot's saved session that ran in a directory. */
export type WorkedSession = SavedBotSession & { readonly cwd: string };

/**
 * What a bot no process hosts is owed ({@link BotOwedWork.owedTerms}): live watch work, its workers' execution or an item
 * they hold to deliver it was not offered, and the next time they come due, a usage wait that ended, an unfinished goal
 * its load takes up (`goal`, continued only where the settings it opens with continue a goal on their own), the wakes its
 * file holds unrun, and the messages waiting in its inbox; `unread`: one of those reads failed (its watch ledger, its
 * workers' bundle, its file's wakes), so what it is owed may be more than this says.
 */
export interface OwedTerms {
	readonly watching: boolean;
	readonly workers: boolean;
	readonly workersDueAt: number | undefined;
	readonly usage: boolean;
	readonly goal: boolean;
	readonly unrun: string;
	readonly unread: boolean;
	readonly waiting: readonly BotInboxItem[];
}

/** A bot finishes its saved project's outstanding work before opening for a different project's scheduled prompt. */
export function owedProjects(
	owed: OwedTerms,
	worked: WorkedSession | undefined,
	usageAt: number | undefined,
): string[] {
	const pinned = owed.waiting.find((item) => item.message.projectBound)?.message.from.cwd;
	if (pinned) {
		const stays =
			owed.unread ||
			owed.watching ||
			owed.workers ||
			owed.workersDueAt !== undefined ||
			owed.usage ||
			usageAt !== undefined ||
			owed.goal ||
			!!owed.unrun;
		return [worked && stays ? worked.cwd : pinned];
	}
	return [...(worked ? [worked.cwd] : []), ...owed.waiting.map((item) => item.message.from.cwd)];
}

/** Whether what the bot is owed opens its session now (an unfinished goal alone, where its settings continue goals). */
export function owesNow(owed: OwedTerms): boolean {
	return owed.watching || owed.workers || owed.usage || owed.goal || owed.unrun !== "" || owed.waiting.length > 0;
}

/** Whether an unfinished goal is all the bot is owed: it opens only where the settings it opens with continue goals. */
export function owesOnlyGoal(owed: OwedTerms): boolean {
	return owed.goal && !owed.watching && !owed.workers && !owed.usage && owed.unrun === "" && owed.waiting.length === 0;
}
