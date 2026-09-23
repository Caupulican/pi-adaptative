/**
 * Cache economics: what continuing on a cached prefix costs against rewriting it. One module prices
 * every such choice: an early (pre-hard-boundary) compaction, a context-GC rewrite of already-sent
 * history, and the cold write a model switch pays. Safety and recovery compaction is not priced here.
 */

/**
 * The comparison behind an early compaction: keep the prefix and resume, or compact now and continue on
 * the shorter one. Every quantity is learned or catalog-priced; nothing here is a tuned constant.
 *
 * Resume: the next request reads the prefix P, a share `retained` of it from cache (R), the rest at the
 * cold price; each further request reads P from cache.
 * Compact: the summarizer reads P (on the session lane at the same R; elsewhere cold), generates the
 * summary at the output price, the next request writes the compacted prefix P' cold, and each further
 * request reads P' from cache.
 */
export interface CompactionEconomicsInput {
	/** Context the next request would carry (P). */
	readonly prefixTokens: number;
	/** Expected context after compacting (P'), from learned compaction outcomes. */
	readonly compactedTokens: number;
	/** Expected tokens the summarizer generates, from learned compaction outcomes. */
	readonly summaryOutputTokens: number;
	/** Requests expected on this history, the next one included (learned lineage lifetime). */
	readonly remainingRequests: number;
	/**
	 * The share of P the next request finds cached, from the lane's survival curve at the real idle gap,
	 * with its standard error. Undefined without evidence: then every share is possible.
	 */
	readonly retained?: { readonly retained: number; readonly standardError: number };
	/** The summarizer runs on the session lane (same model, the sent prefix): it reads P as resume would. */
	readonly summarizerSharesLane: boolean;
	/** The summarizer's cold price, when it runs on another lane and reads P uncached. */
	readonly summarizerColdUsdPerMillion?: number;
	readonly cacheReadUsdPerMillion?: number;
	/** What a prefix the provider has not cached costs: its cache-write price, else its input price. */
	readonly coldUsdPerMillion?: number;
	/** The summarizer's output price. */
	readonly outputUsdPerMillion?: number;
	/** Prices at the compacted size, where a tiered model changes price below a threshold. */
	readonly compactedCacheReadUsdPerMillion?: number;
	readonly compactedColdUsdPerMillion?: number;
}

export type CompactionEconomicsVerdict =
	| {
			readonly proceed: true;
			readonly reason: string;
			/** Saving at the least favorable share the evidence allows. */
			readonly savingUsd: number;
			readonly resumeUsd: number;
			readonly compactUsd: number;
	  }
	| {
			readonly proceed: false;
			readonly reason: "insufficient_evidence" | "insufficient_savings";
			readonly detail: string;
			readonly savingUsd?: number;
	  };

/**
 * Compact only when compacting is cheaper at every cache share the evidence cannot rule out: the saving
 * is taken at the least favorable end of `retained` +/- one standard error (the whole [0, 1] range
 * without evidence), so an uncertain curve never forces a context-losing compaction.
 */
export function priceCompaction(input: CompactionEconomicsInput): CompactionEconomicsVerdict {
	const read = input.cacheReadUsdPerMillion;
	const cold = input.coldUsdPerMillion;
	const output = input.outputUsdPerMillion;
	if (read === undefined || cold === undefined || output === undefined) {
		return { proceed: false, reason: "insufficient_evidence", detail: "prices unknown; no fabricated savings" };
	}
	const compactedRead = input.compactedCacheReadUsdPerMillion ?? read;
	const compactedCold = input.compactedColdUsdPerMillion ?? cold;
	const prefix = Math.max(0, input.prefixTokens);
	const compacted = Math.max(0, input.compactedTokens);
	const further = Math.max(0, input.remainingRequests - 1);
	const firstRead = (share: number) => usd(prefix, share * read + (1 - share) * cold);
	const resume = (share: number) => firstRead(share) + further * usd(prefix, read);
	const compact = (share: number) =>
		(input.summarizerSharesLane ? firstRead(share) : usd(prefix, input.summarizerColdUsdPerMillion ?? cold)) +
		usd(input.summaryOutputTokens, output) +
		usd(compacted, compactedCold) +
		further * usd(compacted, compactedRead);
	const shares = input.retained
		? [
				Math.max(0, input.retained.retained - input.retained.standardError),
				Math.min(1, input.retained.retained + input.retained.standardError),
			]
		: [0, 1];
	const worst = shares
		.map((share) => ({ share, saving: resume(share) - compact(share) }))
		.reduce((a, b) => (b.saving < a.saving ? b : a));
	const resumeUsd = resume(worst.share);
	const compactUsd = compact(worst.share);
	const basis = `${input.remainingRequests} requests, cache share ${worst.share.toFixed(2)}`;
	if (worst.saving <= 0) {
		return {
			proceed: false,
			reason: "insufficient_savings",
			detail: `compacting ${compactUsd.toFixed(6)} USD is not below resuming ${resumeUsd.toFixed(6)} USD (${basis})`,
			savingUsd: worst.saving,
		};
	}
	return {
		proceed: true,
		reason: `compacting saves ${worst.saving.toFixed(6)} USD: ${compactUsd.toFixed(6)} against resuming ${resumeUsd.toFixed(6)} (${basis})`,
		savingUsd: worst.saving,
		resumeUsd,
		compactUsd,
	};
}

/**
 * What moving work onto a model costs in cache: the destination has none of it cached, so every token
 * it must read (the prefix, or the smaller brief it is given instead) is paid at its cold price. Zero for
 * a price-free model; undefined when its prices are unknown.
 */
export function switchCostUsd(
	destination: { cost?: { input?: number; cacheWrite?: number } },
	prefixTokens: number,
	briefTokens?: number,
): number | undefined {
	const input = destination.cost?.input;
	if (input === undefined) return undefined;
	const write = destination.cost?.cacheWrite ?? 0;
	return usd(Math.max(0, briefTokens ?? prefixTokens), write > 0 ? write : input);
}

export interface EffectiveModelPricing {
	readonly input: number;
	/** Undefined when the catalog prices no output. */
	readonly output: number | undefined;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly tierActive: boolean;
}

export function resolveEffectiveModelPricing(
	model: {
		cost?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
			tiers?: readonly { inputTokensAbove: number; input?: number; cacheRead?: number; cacheWrite?: number }[];
		};
		longContextPricing?: { thresholdTokens: number; inputMultiplier: number; outputMultiplier: number };
	},
	tokens: number,
): EffectiveModelPricing | undefined {
	const baseInput = model.cost?.input;
	if (baseInput === undefined) return undefined;
	const baseOutput = model.cost?.output;
	const baseRead = model.cost?.cacheRead ?? 0;
	const baseWrite = model.cost?.cacheWrite ?? 0;

	if (model.cost?.tiers && model.cost.tiers.length > 0) {
		const sorted = [...model.cost.tiers].sort((a, b) => b.inputTokensAbove - a.inputTokensAbove);
		const matchingTier = sorted.find((tier) => tokens > tier.inputTokensAbove);
		if (matchingTier) {
			return {
				input: matchingTier.input ?? baseInput,
				output: baseOutput,
				cacheRead: matchingTier.cacheRead ?? baseRead,
				cacheWrite: matchingTier.cacheWrite ?? baseWrite,
				tierActive: true,
			};
		}
	}

	if (model.longContextPricing && tokens > model.longContextPricing.thresholdTokens) {
		const mult = model.longContextPricing.inputMultiplier;
		return {
			input: baseInput * mult,
			output: baseOutput === undefined ? undefined : baseOutput * model.longContextPricing.outputMultiplier,
			cacheRead: baseRead * mult,
			cacheWrite: baseWrite * mult,
			tierActive: true,
		};
	}

	return {
		input: baseInput,
		output: baseOutput,
		cacheRead: baseRead,
		cacheWrite: baseWrite,
		tierActive: false,
	};
}

export function usd(tokens: number, perMillion: number): number {
	return (tokens / 1_000_000) * perMillion;
}

/**
 * A proposed rewrite of already-sent history: context GC packing messages the provider has already
 * cached. The provider re-prefills everything from the first rewritten message on, so the rewrite is
 * paid once on that suffix; the packed tokens are then saved on every later request that reads the
 * shorter prefix instead of the original.
 */
export interface SentPrefixRewriteEconomicsInput {
	/** Tokens the batch removes from every later request (original minus packed form). */
	readonly savedTokens: number;
	/** Tokens of already-sent history from the first rewritten message to the sent mark, as sent. */
	readonly rewrittenTokens: number;
	/** Later requests expected to read this prefix before it is rewritten anyway (compaction). */
	readonly remainingRequests: number;
	/** Where `remainingRequests` came from, named in the verdict's reason. */
	readonly remainingBasis?: string;
	readonly cacheReadUsdPerMillion?: number;
	/** What a prefix the provider has not cached costs: its cache-write price, else its input price. */
	readonly coldUsdPerMillion?: number;
}

export interface SentPrefixRewriteVerdict {
	readonly admit: boolean;
	readonly reason: string;
	readonly savingUsd?: number;
	readonly costUsd?: number;
}

/**
 * Admit a rewrite of already-sent history only when it pays: the suffix that must be re-prefilled
 * costs its cold price instead of its cache-read price once, and the batch saves its tokens at the
 * cache-read price on every remaining request. Without prices there is no evidence, and the sent
 * prefix stays as sent. A rewrite that costs nothing (a price-free model) is admitted when it saves
 * anything, since a shorter prompt is then free.
 */
export function priceSentPrefixRewrite(input: SentPrefixRewriteEconomicsInput): SentPrefixRewriteVerdict {
	const read = input.cacheReadUsdPerMillion;
	const cold = input.coldUsdPerMillion;
	if (read === undefined || cold === undefined) {
		return { admit: false, reason: "prices unknown; the sent prefix stays as sent" };
	}
	if (input.savedTokens <= 0) return { admit: false, reason: "the batch saves nothing" };
	const reprefilled = Math.max(0, input.rewrittenTokens - input.savedTokens);
	const costUsd = usd(reprefilled, Math.max(0, cold - read));
	const savingUsd = usd(input.savedTokens, read) * Math.max(0, input.remainingRequests);
	const requestsText = `${input.remainingRequests} requests${input.remainingBasis ? ` (${input.remainingBasis})` : ""}`;
	if (costUsd === 0) {
		return { admit: true, reason: "the rewrite costs nothing on this model", savingUsd, costUsd };
	}
	return savingUsd > costUsd
		? {
				admit: true,
				reason: `saves ${savingUsd.toFixed(6)} USD over ${requestsText} against a ${costUsd.toFixed(6)} USD re-prefill`,
				savingUsd,
				costUsd,
			}
		: {
				admit: false,
				reason: `re-prefill ${costUsd.toFixed(6)} USD exceeds ${savingUsd.toFixed(6)} USD saved over ${requestsText}`,
				savingUsd,
				costUsd,
			};
}
