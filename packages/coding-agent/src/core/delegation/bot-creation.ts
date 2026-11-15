/**
 * Who may create a persistent bot. Only the orchestrator (the root session) creates bots on the fly, its own or a leader's
 * (`bot create` with `forLeader`, when the leader asks it); no bot creates one: a leader asks the orchestrator, and every
 * other bot asks its leader, a leader or its parent. Only the owner makes a standing leader; the orchestrator may appoint a
 * goal leader for one goal (`bot lead` without agentId).
 */

import type { LeadRequest, LeadResult } from "./leader-delegation.ts";
import type { PersistentBotRecord } from "./persistent-bot-team-store.ts";

/** The root session's tool for creating and listing bots. */
export const BOT_TOOL_NAME = "bot";

/** How many live bots one leader may keep; the orchestrator's own are bounded by the owner's attention, not a count. */
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
	/** A bot edits files only when asked to; a leader's bot is granted it only when that leader can write itself. */
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
	/** Creates a bot: the orchestrator's own, or with `forLeader` that leader's own bot (the record names it as creator). */
	create(request: BotCreationRequest, forLeader: string | undefined): CreatedBotView;
	/** Hands a goal to a leader; its one Outcome reaches the orchestrator as an event when the goal ends. */
	lead(request: LeadRequest): LeadResult;
	/** The bots the roster holds, each by the id the caller asks it by and the name its record shows. */
	list(): readonly BotToolListEntry[];
}
