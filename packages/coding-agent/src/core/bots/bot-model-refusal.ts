/**
 * Why a bot's own model may not run now (the worker admission's rules for it, or a dollar bound on a metered model with no
 * price), in the owner's words, with when the refusal ends when that is known: the host refuses a run or an open with it,
 * and the opening of owed sessions keys a refusal by it and takes the work up again once it no longer holds.
 */
import type { OrchestrationModelUnusableCause } from "../orchestration/model-binding.ts";
import { type BotFailureWords, BotOwnerError } from "./bot-owner-error.ts";

/**
 * Which rule refuses the bot's model: the host reports it unusable (its own cause), the subscription rule holds it to a
 * metered model, the session's model policy does not allow it, a dollar bound applies to a metered model with no price,
 * or the day's away bound has no room for a metered turn of a bot hosted while no session is open.
 */
export type BotModelRefusalCause =
	| OrchestrationModelUnusableCause
	| "model_metered"
	| "model_not_allowed"
	| "model_unpriced"
	| "away_spend_exhausted";

/** Why a bot's model may not run now: the rule as a code, the owner's words for it, and when that ends when it is known. */
export interface BotModelRefusal {
	/** What a recorded refusal is compared by: the words change with the owner's language, the cause does not. */
	readonly cause: BotModelRefusalCause;
	/** The rule in the words of the catalogue passed in, shown only: the owner's, or English for a model. */
	readonly words: BotFailureWords;
	/** When the refusal ends (a quota exhaustion's recorded reset), on the provider admission clock. */
	readonly clearsAt?: number;
}

/** A run or an open refused because the bot's model may not run now. */
export class BotModelRefusedError extends BotOwnerError {
	override readonly name = "BotModelRefusedError";
	readonly refusal: BotModelRefusal;

	constructor(agentId: string, refusal: BotModelRefusal) {
		super((text) => text.botTeam.botModelRefused(agentId, refusal.words(text)));
		this.refusal = refusal;
	}
}
