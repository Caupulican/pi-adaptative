/**
 * The dollar bound of one turn of a headless session (a channel away, a persistent bot): on the turn boundary
 * `observeSessionTurns` draws (an automatic retry's attempts and a self-compaction handoff's run are the same turn), a
 * turn's spend is its priced assistant messages and the compactions that ran for it, a compaction before its first run
 * (the threshold check a prompt makes) and one between its runs (self-compaction) included, summed from the end of the
 * turn before. A compaction's spend is what the session recorded between its start and its end (every summary call,
 * a failed attempt's and a retry's included, as the session's own cost counts them). Past the bound the turn is aborted, at a priced message or at the start of a run the turn continues
 * with. A bound can only be kept on a model that declares a price.
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
	session: Pick<
		AgentSession,
		"subscribe" | "abort" | "getSelfCompactionView" | "nativeActivity" | "getCumulativeUsage"
	>,
	bound: SessionTurnSpendBound<Limit>,
): () => void {
	let turnUsd = 0;
	// The session's recorded cost when the running compaction started; undefined while none runs.
	let compactionFromUsd: number | undefined;
	const unsubscribeTurns = observeSessionTurns(session, { started: () => {}, ended: () => (turnUsd = 0) });
	const enforce = () => {
		const limit = bound.limit();
		if (limit !== undefined && turnUsd > limit.usd) void session.abort(bound.onExceeded(turnUsd, limit));
	};
	const unsubscribeSpend = session.subscribe((event) => {
		if (event.type === "message_end" && event.message.role === "assistant") {
			turnUsd += event.message.usage?.cost?.total ?? 0;
			enforce();
		} else if (event.type === "compaction_start") compactionFromUsd = session.getCumulativeUsage().cost.total;
		else if (event.type === "compaction_end" && compactionFromUsd !== undefined) {
			turnUsd += Math.max(0, session.getCumulativeUsage().cost.total - compactionFromUsd);
			compactionFromUsd = undefined;
		} else if (event.type === "agent_start") enforce();
	});
	return () => {
		unsubscribeTurns();
		unsubscribeSpend();
	};
}
