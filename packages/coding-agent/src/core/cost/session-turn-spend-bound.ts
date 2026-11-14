/**
 * The dollar bound of one turn of a headless session (a channel away, a persistent bot): on the turn boundary
 * `observeSessionTurns` draws (an automatic retry's attempts and a self-compaction handoff's run are the same turn), a
 * turn's spend is its priced assistant messages and the compactions that serve it. A compaction's spend is what its own
 * summary calls recorded while it ran (`getRecordedCompactionUsd`: a failed attempt's and a retry's calls included, never
 * another plane's spend recorded meanwhile). One that ends while a turn is open (an overflow recovery while the turn
 * retries, a self-compaction between its runs) counts toward that turn. One that ends between turns counts toward the
 * next turn only when that turn's run starts in the submission the compaction ran in (the threshold check before a
 * prompt's run, a recovery before the run that continues it), and otherwise toward no turn's bound (a threshold check
 * after a turn's last run, before the next third party's turn): it is still in the session's usage, and in a bot's
 * charge. A summary prepared while the session idled is paid then, outside any compaction and any turn. Past the bound
 * the turn is stopped (`stopSessionTurn`), at a priced message or at the start of a run the turn continues with. A bound
 * can only be kept on a model that declares a price.
 */

import type { Api, Model } from "@caupulican/pi-ai";
import type { AgentSession } from "../agent-session.ts";
import { interfaceText } from "../language/interface-text.ts";
import { observeSessionTurns, stopSessionTurn } from "../session-turn-boundary.ts";

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

/** Compaction spend and the foreground submission it ran in (undefined when it ran outside one). */
interface SubmissionSpend {
	readonly usd: number;
	readonly submission: number | undefined;
}

/** Bounds each turn of `session`; returns the unsubscribe. */
export function boundSessionTurnSpend<Limit extends SpendLimit>(
	session: Pick<
		AgentSession,
		"subscribe" | "abort" | "selfCompactionHandoff" | "nativeActivity" | "getRecordedCompactionUsd"
	>,
	bound: SessionTurnSpendBound<Limit>,
): () => void {
	const { foreground } = session.nativeActivity;
	let turnUsd = 0;
	let open = false;
	// The running compaction: the session's recorded compaction spend when it started, and its submission.
	let compaction: SubmissionSpend | undefined;
	// Compaction spend that ended between turns, for the next turn when it starts in the same submission.
	let between: SubmissionSpend | undefined;
	const unsubscribeTurns = observeSessionTurns(session, {
		started: () => {
			const submission = foreground.getCurrentSubmissionEpoch();
			turnUsd = between?.submission !== undefined && between.submission === submission ? between.usd : 0;
			between = undefined;
			open = true;
		},
		ended: () => {
			open = false;
		},
	});
	const enforce = () => {
		const limit = bound.limit();
		if (limit !== undefined && turnUsd > limit.usd) void stopSessionTurn(session, bound.onExceeded(turnUsd, limit));
	};
	const unsubscribeSpend = session.subscribe((event) => {
		if (event.type === "message_end" && event.message.role === "assistant") {
			turnUsd += event.message.usage?.cost?.total ?? 0;
			enforce();
		} else if (event.type === "compaction_start") {
			compaction = {
				usd: session.getRecordedCompactionUsd(),
				submission: foreground.getCurrentSubmissionEpoch(),
			};
		} else if (event.type === "compaction_end" && compaction !== undefined) {
			const usd = session.getRecordedCompactionUsd() - compaction.usd;
			if (open) turnUsd += usd;
			else {
				const carried = between !== undefined && between.submission === compaction.submission ? between.usd : 0;
				between = { usd: carried + usd, submission: compaction.submission };
			}
			compaction = undefined;
		} else if (event.type === "agent_start") enforce();
	});
	return () => {
		unsubscribeTurns();
		unsubscribeSpend();
	};
}
