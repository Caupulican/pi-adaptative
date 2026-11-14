/**
 * Why a bot's own model may not run now (the worker admission's rules for it, or a dollar bound on a model with no
 * price), in the owner's words, with when the refusal ends when that is known: the host refuses a run or an open with it,
 * and the opening of owed sessions keys a refusal by it and takes the work up again once it no longer holds.
 */
import { interfaceText } from "../language/interface-text.ts";

/** Why a bot's model may not run now, in the owner's words, and when that ends when it is known. */
export interface BotModelRefusal {
	readonly reason: string;
	/** When the refusal ends (a quota exhaustion's recorded reset), on the provider admission clock. */
	readonly clearsAt?: number;
}

/** A run or an open refused because the bot's model may not run now. */
export class BotModelRefusedError extends Error {
	override readonly name = "BotModelRefusedError";
	readonly refusal: BotModelRefusal;

	constructor(agentId: string, refusal: BotModelRefusal) {
		super(interfaceText().botTeam.botModelRefused(agentId, refusal.reason));
		this.refusal = refusal;
	}
}
