/**
 * Who may create a persistent bot. The orchestrator (the root session) and the bots the owner made leaders create bots on
 * the fly; every other bot cannot, and asks a leader or its parent. Only the owner makes a leader.
 */

/** The root session's tool for creating and listing bots. */
export const BOT_TOOL_NAME = "bot";

/** How many live bots one leader may have created; the orchestrator is bounded by the owner's attention, not a count. */
export const MAX_BOTS_PER_LEADER = 12;

export interface BotCreationRequest {
	readonly agentId: string;
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
	readonly agentId: string;
	readonly soul?: string;
	readonly description?: string;
	readonly model?: string;
	readonly thinkingLevel?: string;
	readonly canWrite?: boolean;
}): BotCreationRequest {
	return {
		agentId: input.agentId,
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

export interface BotToolPort {
	create(request: BotCreationRequest): CreatedBotView;
	list(): readonly { agentId: string; modelRef: string; leader: boolean; retired: boolean; createdBy?: string }[];
}

/** The text a bot that cannot create bots gets when it tries: where to ask instead. */
export function mayNotCreateBotsText(leaderIds: readonly string[]): string {
	return leaderIds.length > 0
		? `Only the orchestrator and leaders create bots. Ask a leader (${leaderIds.join(", ")}) with bot_message, or ask your parent in your report.`
		: "Only the orchestrator and leaders create bots, and no leader is set. Ask your parent in your report for the bot you need.";
}
