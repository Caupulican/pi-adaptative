/**
 * EffectivenessTracker — the closed adaptive loop (adaptive-agent design R4, leapfrog #9).
 *
 * Recall (R3) injects a `<memory_context>` page; this tracks whether the agent actually USED it, so the
 * recall gate can adapt — recall more when it's paying off, back off when it isn't. "Used" = the
 * fraction of the recall page's DISTINCTIVE tokens (those not already in the user's query) that reappear
 * in the assistant's response. We isolate distinctive tokens so we measure recall's own contribution,
 * not the baseline overlap every response shares with the query.
 *
 * The score is an exponential moving average ("useful lately") in [0,1], starting at a neutral prior so
 * recall is given a fair chance before the loop adapts.
 */

import { tokenize } from "../tools/skill-audit.ts";

const NEUTRAL_PRIOR = 0.5;
const ALPHA = 0.3; // EMA weight on the newest outcome

export class EffectivenessTracker {
	private ema = NEUTRAL_PRIOR;
	private samples = 0;

	/**
	 * Record the outcome of a turn that received a recall page: how much of the recall's distinctive
	 * content the assistant's response actually drew on.
	 */
	recordRecallOutcome(recallText: string, queryText: string, responseText: string): void {
		const used = distinctiveRecallUsage(recallText, queryText, responseText);
		this.ema = ALPHA * used + (1 - ALPHA) * this.ema;
		this.samples += 1;
	}

	/** Rolling "useful lately" score in [0,1]. Neutral until enough samples accumulate. */
	usefulLately(): number {
		return this.ema;
	}

	/** Number of recorded recall outcomes. */
	get sampleCount(): number {
		return this.samples;
	}
}

/**
 * Fraction of the recall page's distinctive tokens (present in recall but NOT in the query) that appear
 * in the response. 0 when recall added nothing the query didn't already carry.
 */
export function distinctiveRecallUsage(recallText: string, queryText: string, responseText: string): number {
	const queryTokens = new Set(tokenize(queryText));
	const distinctive = tokenize(recallText).filter((t) => !queryTokens.has(t));
	if (distinctive.length === 0) return 0;
	const responseTokens = new Set(tokenize(responseText));
	let hits = 0;
	for (const token of distinctive) {
		if (responseTokens.has(token)) hits++;
	}
	return hits / distinctive.length;
}
