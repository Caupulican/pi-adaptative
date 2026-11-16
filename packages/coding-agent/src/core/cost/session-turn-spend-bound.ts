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
 * charge. A summary prepared while the session idled is paid then, outside any compaction and any turn. The host says
 * what spend its bounds hold (`exceeded`): the turn's own, or a wider spend the turn's adds to (a bot's request with its
 * workers, each of its ceilings on the spend it counts). It is told each addition once, where the transcript already holds
 * the turn's own entries: at a priced message's end, at the start of a run the turn continues with, and at the turn's
 * end. The turn's first run starts before the input that opened it is written, so that start is checked on the spend
 * the host holds for that input (`openingExceeded`, given the messages the run opens with): a new outside input's own
 * request holds only the turn's spend, a worker's handoff the request it serves, so a handoff into a request already
 * past its bound is stopped before it spends anything.
 * Past the bound the turn is stopped (`stopSessionTurn`), at a priced message or at the start of a run. A bound can only
 * be kept on a model that declares a price.
 */

import type { Api, Model } from "@caupulican/pi-ai";
import type { AgentMessage } from "../../kernel/types.ts";
import type { AgentSession } from "../agent-session.ts";
import { type InterfaceText, interfaceText } from "../language/interface-text.ts";
import { observeSessionTurns, stopSessionTurn } from "../session-turn-boundary.ts";

/** Why a model cannot run under a dollar bound, in the owner's words; undefined when it declares a price. */
export function unpricedModelRefusal(model: Pick<Model<Api>, "provider" | "id" | "costDefaulted">): string | undefined {
	return unpricedModelWords(model)?.(interfaceText());
}

/** Why a model cannot run under a dollar bound, in the words of the catalogue passed in; undefined when it declares a price. */
export function unpricedModelWords(
	model: Pick<Model<Api>, "provider" | "id" | "costDefaulted">,
): ((text: InterfaceText) => string) | undefined {
	const ref = `${model.provider}/${model.id}`;
	return model.costDefaulted ? (text) => text.common.modelUnpriced(ref) : undefined;
}

/** A turn's bound: its dollars, with whatever else names it to the owner (the setting it comes from, say). */
export interface SpendLimit {
	readonly usd: number;
}

/** A spend past its bound, with that bound. */
export interface SpendExcess<Limit extends SpendLimit> {
	readonly spentUsd: number;
	readonly limit: Limit;
}

export interface SessionTurnSpendBound<Limit extends SpendLimit> {
	/**
	 * At the start of a turn's first run: the spend the host holds past one of its bounds for the input the run opens with,
	 * given the messages it opens with that the transcript may not hold yet (`opening`: none for a continuation, which
	 * runs from the transcript's tail) and the turn's own spend so far (`turnUsd`: a compaction its submission ran first,
	 * not yet told). Nothing is counted here: the turn's spend is told at its first priced message. Undefined within every
	 * bound.
	 */
	openingExceeded(opening: readonly AgentMessage[], turnUsd: number): SpendExcess<Limit> | undefined;
	/**
	 * The spend the host holds past one of its bounds, with that bound, given the turn's spend so far (`turnUsd`) and what
	 * was just added to it (`addedUsd`, told once each, zero when the bounds are only checked again); undefined while it is
	 * within every bound.
	 */
	exceeded(turnUsd: number, addedUsd: number): SpendExcess<Limit> | undefined;
	/** The spend went past `limit`: the reason its turn is aborted with. */
	onExceeded(spentUsd: number, limit: Limit): string;
}

/** The turn's own spend past `limit`; undefined within it, or when no bound applies. */
export function turnSpendExcess<Limit extends SpendLimit>(
	turnUsd: number,
	limit: Limit | undefined,
): SpendExcess<Limit> | undefined {
	return limit !== undefined && turnUsd > limit.usd ? { spentUsd: turnUsd, limit } : undefined;
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
	// Spend added to the turn and not yet told to the host.
	let untoldUsd = 0;
	let open = false;
	// The turn has just started: its first run's start is checked on the spend held for the input it opens with.
	let opening = false;
	// The running compaction: the session's recorded compaction spend when it started, and its submission.
	let compaction: SubmissionSpend | undefined;
	// Compaction spend that ended between turns, for the next turn when it starts in the same submission.
	let between: SubmissionSpend | undefined;
	const unsubscribeTurns = observeSessionTurns(session, {
		started: () => {
			const submission = foreground.getCurrentSubmissionEpoch();
			turnUsd = between?.submission !== undefined && between.submission === submission ? between.usd : 0;
			untoldUsd = turnUsd;
			between = undefined;
			open = true;
			opening = true;
		},
		ended: () => {
			if (untoldUsd > 0) tell();
			open = false;
		},
	});
	const add = (usd: number) => {
		turnUsd += usd;
		untoldUsd += usd;
	};
	// Tells the host the spend not yet told and returns the spend past one of its bounds.
	const tell = (): SpendExcess<Limit> | undefined => {
		const addedUsd = untoldUsd;
		untoldUsd = 0;
		return bound.exceeded(turnUsd, addedUsd);
	};
	const enforce = (excess: SpendExcess<Limit> | undefined) => {
		if (excess) void stopSessionTurn(session, bound.onExceeded(excess.spentUsd, excess.limit));
	};
	const unsubscribeSpend = session.subscribe((event) => {
		if (event.type === "message_end" && event.message.role === "assistant") {
			add(event.message.usage?.cost?.total ?? 0);
			enforce(tell());
		} else if (event.type === "compaction_start") {
			compaction = {
				usd: session.getRecordedCompactionUsd(),
				submission: foreground.getCurrentSubmissionEpoch(),
			};
		} else if (event.type === "compaction_end" && compaction !== undefined) {
			const usd = session.getRecordedCompactionUsd() - compaction.usd;
			if (open) add(usd);
			else {
				const carried = between !== undefined && between.submission === compaction.submission ? between.usd : 0;
				between = { usd: carried + usd, submission: compaction.submission };
			}
			compaction = undefined;
		} else if (event.type === "agent_start") {
			// The turn's started() runs first, on the same event (its boundary subscribed first).
			if (opening) enforce(bound.openingExceeded(foreground.turnOrigin.opening(), turnUsd));
			else enforce(tell());
			opening = false;
		}
	});
	return () => {
		unsubscribeTurns();
		unsubscribeSpend();
	};
}
