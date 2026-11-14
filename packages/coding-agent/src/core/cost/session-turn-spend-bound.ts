/**
 * The dollar bound of one turn of a headless session (a channel away, a persistent bot): the cost of the turn's priced
 * assistant messages is summed from its start, on the turn boundary `observeSessionTurns` draws (an automatic retry's
 * attempts are the same turn), and past the bound the turn is aborted. A bound can only be kept on a model
 * that declares a price.
 */

import type { Api, Model } from "@caupulican/pi-ai";
import type { AgentSession } from "../agent-session.ts";
import { interfaceText } from "../language/interface-text.ts";
import { observeSessionTurns } from "../session-turn-boundary.ts";

/** Why a model cannot run under a dollar bound, in the owner's words; undefined when it declares a price. */
export function unpricedModelRefusal(model: Pick<Model<Api>, "provider" | "id" | "costDefaulted">): string | undefined {
	return model.costDefaulted ? interfaceText().common.modelUnpriced(`${model.provider}/${model.id}`) : undefined;
}

/** A turn's bound: its dollars, with whatever else names it to the owner (the setting it comes from, say). */
export interface SpendLimit {
	readonly usd: number;
}

export interface SessionTurnSpendBound<Limit extends SpendLimit> {
	/** The bound now; undefined when no bound applies. Read at every priced message. */
	limit(): Limit | undefined;
	/** A turn went past `limit`, the bound read for its last priced message: the owner-facing reason its turn is aborted with. */
	onExceeded(spentUsd: number, limit: Limit): string;
}

/** Bounds each turn of `session`; returns the unsubscribe. */
export function boundSessionTurnSpend<Limit extends SpendLimit>(
	session: Pick<AgentSession, "subscribe" | "abort">,
	bound: SessionTurnSpendBound<Limit>,
): () => void {
	let turnUsd = 0;
	const unsubscribeTurns = observeSessionTurns(session, { started: () => (turnUsd = 0), ended: () => {} });
	const unsubscribeSpend = session.subscribe((event) => {
		if (event.type === "message_end" && event.message.role === "assistant") {
			turnUsd += event.message.usage?.cost?.total ?? 0;
			const limit = bound.limit();
			if (limit !== undefined && turnUsd > limit.usd) void session.abort(bound.onExceeded(turnUsd, limit));
		}
	});
	return () => {
		unsubscribeTurns();
		unsubscribeSpend();
	};
}
