/**
 * A send that reaches no bot. Only the owner's own word to a bot (`bot-operator-dispatch.ts` `isOwnerDirect`) makes a
 * bot it names or brings a retired one back, so the orchestrator's, a leader's, a group's or a routine's send to an id no
 * bot has, or to a retired bot, is refused before anything is written or started. Each sender words its own next step
 * from `agentId` and `state`.
 */
export class BotUnreachableError extends Error {
	readonly agentId: string;
	readonly state: "missing" | "retired";

	constructor(agentId: string, state: "missing" | "retired") {
		super(
			state === "missing"
				? `There is no bot named ${agentId}.`
				: `Bot ${agentId} is retired; only the owner's own message to it brings it back.`,
		);
		this.name = "BotUnreachableError";
		this.agentId = agentId;
		this.state = state;
	}
}

/** Refuses a send from anyone but the owner to `record`, the bot `agentId` names: one that does not exist or is retired. */
export function assertBotReachable(agentId: string, record: { readonly retired?: boolean } | undefined): void {
	if (record === undefined) throw new BotUnreachableError(agentId, "missing");
	if (record.retired === true) throw new BotUnreachableError(agentId, "retired");
}
