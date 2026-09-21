/**
 * Early (pre-hard-boundary) compaction must prove expected savings beat rewrite + summary cost.
 * Safety/recovery compaction is not this planner's job.
 */

export type EarlyCompactionDeferReason =
	| "insufficient_evidence"
	| "hot_cache"
	| "insufficient_savings"
	| "hysteresis"
	| "summary_wipes_savings";

export type EarlyCompactionEconomicsVerdict =
	| { readonly proceed: true; readonly reason: string; readonly projectedSavingsUsd: number }
	| { readonly proceed: false; readonly reason: EarlyCompactionDeferReason; readonly detail: string };

export interface EarlyCompactionEconomicsInput {
	readonly currentTokens: number;
	readonly compactableTokens: number;
	readonly recentCacheReadTokens: number;
	readonly recentCacheWriteTokens: number;
	readonly cacheReadUsdPerMillion?: number;
	readonly cacheWriteUsdPerMillion?: number;
	readonly inputUsdPerMillion?: number;
	readonly estimatedSummaryTokens: number;
	readonly horizonTurns: number;
	readonly lastEarlyDecisionAtTokens?: number;
	readonly hysteresisTokens: number;
	readonly minSavingsUsd: number;
}

function usd(tokens: number, perMillion: number): number {
	return (tokens / 1_000_000) * perMillion;
}

export function projectEarlyCompactionEconomics(input: EarlyCompactionEconomicsInput): EarlyCompactionEconomicsVerdict {
	const readPrice = input.cacheReadUsdPerMillion;
	const writePrice = input.cacheWriteUsdPerMillion;
	const inputPrice = input.inputUsdPerMillion;
	if (readPrice === undefined || writePrice === undefined || inputPrice === undefined) {
		return {
			proceed: false,
			reason: "insufficient_evidence",
			detail: "cache/input prices missing; no fabricated savings",
		};
	}
	if (
		input.lastEarlyDecisionAtTokens !== undefined &&
		Math.abs(input.currentTokens - input.lastEarlyDecisionAtTokens) < input.hysteresisTokens
	) {
		return {
			proceed: false,
			reason: "hysteresis",
			detail: `tokens moved less than ${input.hysteresisTokens} since last early decision`,
		};
	}

	const cacheTotal = input.recentCacheReadTokens + input.recentCacheWriteTokens;
	const hitRatio = cacheTotal > 0 ? input.recentCacheReadTokens / cacheTotal : 0;
	if (hitRatio >= 0.7 && input.recentCacheReadTokens > 0) {
		return {
			proceed: false,
			reason: "hot_cache",
			detail: `hit ratio ${hitRatio.toFixed(2)}; preserve prefix`,
		};
	}

	const summaryCost = usd(input.estimatedSummaryTokens, inputPrice);
	const rewriteCost = usd(Math.max(0, input.compactableTokens), writePrice);
	const shorterPrefixRead = usd(Math.max(0, input.compactableTokens) * hitRatio, readPrice);
	const savedReads = shorterPrefixRead * Math.max(1, input.horizonTurns);
	const projected = savedReads - summaryCost - rewriteCost;
	if (summaryCost + rewriteCost >= savedReads && savedReads > 0) {
		return {
			proceed: false,
			reason: "summary_wipes_savings",
			detail: `summary+rewrite ${summaryCost + rewriteCost} >= saved reads ${savedReads}`,
		};
	}
	if (projected < input.minSavingsUsd) {
		return {
			proceed: false,
			reason: "insufficient_savings",
			detail: `projected ${projected} below margin ${input.minSavingsUsd}`,
		};
	}
	return {
		proceed: true,
		reason: `projected savings ${projected.toFixed(6)} USD over ${input.horizonTurns} turns`,
		projectedSavingsUsd: projected,
	};
}
