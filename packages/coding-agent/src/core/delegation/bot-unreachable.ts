/**
 * A send that reaches no bot. Only the owner's own word to a bot (`bot-operator-dispatch.ts` `isOwnerDirect`) makes a
 * bot it names, so the orchestrator's, a leader's, a group's or a routine's send to an id no bot has is refused before
 * anything is written or started. Each sender words its own next step from `agentId`.
 */
export class BotUnreachableError extends Error {
	readonly agentId: string;

	constructor(agentId: string) {
		super(`There is no bot named ${agentId}.`);
		this.name = "BotUnreachableError";
		this.agentId = agentId;
	}
}
