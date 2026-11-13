/**
 * The dollar bound of one turn of a headless session (a channel away, a persistent bot): the cost of the turn's priced
 * assistant messages is summed from its start, and past the bound the turn is aborted. A bound can only be kept on a model
 * that declares a price.
 */

import type { Api, Model } from "@caupulican/pi-ai";
import type { AgentSession } from "../agent-session.ts";

/** Why a model cannot run under a dollar bound; undefined when it declares a price. */
export function unpricedModelRefusal(model: Pick<Model<Api>, "provider" | "id" | "costDefaulted">): string | undefined {
	return model.costDefaulted
		? `the model ${model.provider}/${model.id} has no price, so its spend cannot be bounded`
		: undefined;
}

export interface SessionTurnSpendBound {
	/** The bound now, in dollars per turn; undefined when no bound applies. Read at every priced message. */
	limitUsd(): number | undefined;
	/** A turn went past its bound: the owner-facing reason its turn is aborted with. */
	onExceeded(spentUsd: number, limitUsd: number): string;
}

/** Bounds each turn of `session`; returns the unsubscribe. */
export function boundSessionTurnSpend(
	session: Pick<AgentSession, "subscribe" | "abort">,
	bound: SessionTurnSpendBound,
) {
	let turnUsd = 0;
	return session.subscribe((event) => {
		if (event.type === "agent_start") turnUsd = 0;
		else if (event.type === "message_end" && event.message.role === "assistant") {
			turnUsd += event.message.usage?.cost?.total ?? 0;
			const limitUsd = bound.limitUsd();
			if (limitUsd !== undefined && turnUsd > limitUsd) void session.abort(bound.onExceeded(turnUsd, limitUsd));
		}
	});
}
