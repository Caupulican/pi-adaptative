/**
 * Who may create a persistent bot. The orchestrator (the root session) and the bots the owner made leaders create bots on
 * the fly; every other bot cannot, and asks a leader or its parent. Only the owner makes a standing leader; the
 * orchestrator may appoint a goal leader for one goal (`bot lead` without agentId).
 */

import type { LeadRequest, LeadResult } from "./leader-delegation.ts";
import type { PersistentBotRecord } from "./persistent-bot-team-store.ts";

/** The root session's tool for creating and listing bots. */
export const BOT_TOOL_NAME = "bot";

/** How many live bots one leader may have created; the orchestrator is bounded by the owner's attention, not a count. */
export const MAX_BOTS_PER_LEADER = 12;

export interface BotCreationRequest {
	/** The bot's id; when left out the harness names the bot from its purpose and the answer says which id it chose. */
	readonly agentId?: string;
	/** The bot's standing instructions; it opens the bot's system prompt on every turn. */
	readonly soul?: string;
	readonly description?: string;
	/** `<provider>/<model>`; the session's current model when omitted. */
	readonly model?: string;
	readonly thinkingLevel?: string;
	/** A bot edits files only when asked to; a leader can grant it only when the leader can write itself. */
	readonly canWrite?: boolean;
}

/** The creation fields a tool call carries, with the absent ones left out. */
export function botCreationRequestFrom(input: {
	readonly agentId?: string | undefined;
	readonly soul?: string;
	readonly description?: string;
	readonly model?: string;
	readonly thinkingLevel?: string;
	readonly canWrite?: boolean;
}): BotCreationRequest {
	return {
		...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
		...(input.soul !== undefined ? { soul: input.soul } : {}),
		...(input.description !== undefined ? { description: input.description } : {}),
		...(input.model !== undefined ? { model: input.model } : {}),
		...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
		...(input.canWrite !== undefined ? { canWrite: input.canWrite } : {}),
	};
}

export interface CreatedBotView {
	readonly agentId: string;
	readonly modelRef: string;
	readonly canWrite: boolean;
	readonly createdBy: string;
}

/** The standing instructions of the spawner bot: the one bot whose only work is making the bots and workers others need. */
export const SPAWNER_BOT_ID = "spawner";
export const SPAWNER_SOUL =
	"You make bots for the orchestrator and do nothing else. When asked, create each bot with bot_message action create: a short clear agentId, and a soul that states that bot's single purpose and rules, no more than it needs. Then send each new bot its first task with bot_message send, and answer the orchestrator with the ids you created and what each was asked to do. Never do the task yourself and never write files.";

/** One bot as the `bot` tool's list shows it. */
export type BotToolListEntry = {
	agentId: string;
	displayName?: string;
	modelRef: string;
	leader: boolean;
	retired: boolean;
	createdBy?: string;
};

export function botToolListEntry(bot: PersistentBotRecord): BotToolListEntry {
	return {
		agentId: bot.agentId,
		...(bot.displayName ? { displayName: bot.displayName } : {}),
		modelRef: `${bot.provider}/${bot.modelId}`,
		leader: bot.leader === true,
		retired: bot.retired === true,
		...(bot.createdBy ? { createdBy: bot.createdBy } : {}),
	};
}

export interface BotToolPort {
	/** Sends a message to a bot and returns at once; the bot's answer reaches the orchestrator as an event. */
	ask(agentId: string, message: string): Promise<void>;
	create(request: BotCreationRequest): CreatedBotView;
	/** Hands a goal to a leader; its one Outcome reaches the orchestrator as an event when the goal ends. */
	lead(request: LeadRequest): LeadResult;
	/** The bots the roster holds, each by the id the caller asks it by and the name its record shows. */
	list(): readonly BotToolListEntry[];
}

/**
 * The text a bot that cannot create bots gets when it tries: where to ask instead. A bot a leader made asks that leader
 * first; any other bot asks one of the leaders, or its parent.
 */
export function mayNotCreateBotsText(leaderIds: readonly string[], ownLeader?: string): string {
	if (ownLeader)
		return `Only the orchestrator and leaders create bots. Ask your leader (${ownLeader}) with bot_message for the bot you need.`;
	return leaderIds.length > 0
		? `Only the orchestrator and leaders create bots. Ask a leader (${leaderIds.join(", ")}) with bot_message, or ask your parent in your report.`
		: "Only the orchestrator and leaders create bots, and no leader is set. Ask your parent in your report for the bot you need.";
}
