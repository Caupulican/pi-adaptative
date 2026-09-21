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
	| {
			readonly proceed: true;
			readonly reason: string;
			readonly projectedSavingsUsd: number;
			readonly preserveTurnCostUsd?: number;
			readonly compactTurnCostUsd?: number;
			readonly compactionOneTimeCostUsd?: number;
			readonly hitRatio?: number;
	  }
	| {
			readonly proceed: false;
			readonly reason: EarlyCompactionDeferReason;
			readonly detail: string;
			readonly projectedSavingsUsd?: number;
	  };

export interface EarlyCompactionEconomicsInput {
	readonly currentTokens: number;
	readonly compactableTokens: number;
	readonly recentCacheReadTokens: number;
	readonly recentCacheWriteTokens: number;
	readonly cacheReadUsdPerMillion?: number;
	readonly cacheWriteUsdPerMillion?: number;
	readonly inputUsdPerMillion?: number;
	readonly postCompactionInputUsdPerMillion?: number;
	readonly postCompactionCacheReadUsdPerMillion?: number;
	readonly postCompactionCacheWriteUsdPerMillion?: number;
	readonly estimatedSummaryTokens: number;
	readonly horizonTurns: number;
	readonly lastEarlyDecisionAtTokens?: number;
	readonly hysteresisTokens: number;
	readonly minSavingsUsd: number;
	/** Prefix was dropped (model switch, TTL, or an explicit cache reset). Hysteresis must not block a reassess. */
	readonly cacheInvalidated?: boolean;
	readonly modelSwitched?: boolean;
	readonly tierChanged?: boolean;
}

export interface EffectiveModelPricing {
	readonly input: number;
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
	const baseRead = model.cost?.cacheRead ?? 0;
	const baseWrite = model.cost?.cacheWrite ?? 0;

	if (model.cost?.tiers && model.cost.tiers.length > 0) {
		const sorted = [...model.cost.tiers].sort((a, b) => b.inputTokensAbove - a.inputTokensAbove);
		const matchingTier = sorted.find((tier) => tokens > tier.inputTokensAbove);
		if (matchingTier) {
			return {
				input: matchingTier.input ?? baseInput,
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
			cacheRead: baseRead * mult,
			cacheWrite: baseWrite * mult,
			tierActive: true,
		};
	}

	return {
		input: baseInput,
		cacheRead: baseRead,
		cacheWrite: baseWrite,
		tierActive: false,
	};
}

export function usd(tokens: number, perMillion: number): number {
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
	const postInputPrice = input.postCompactionInputUsdPerMillion ?? inputPrice;
	const postReadPrice = input.postCompactionCacheReadUsdPerMillion ?? readPrice;
	const postWritePrice = input.postCompactionCacheWriteUsdPerMillion ?? writePrice;

	const cacheInvalidated = Boolean(input.cacheInvalidated || input.modelSwitched || input.tierChanged);
	if (
		!cacheInvalidated &&
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

	const compactable = Math.max(0, input.compactableTokens);
	const postTokens = Math.max(0, input.currentTokens - compactable + input.estimatedSummaryTokens);

	// One-time costs: summary generation + rewriting compacted prefix
	const summaryCost = usd(input.estimatedSummaryTokens, inputPrice);
	const rewriteCost = usd(postTokens, postWritePrice);
	const compactionOneTimeCost = summaryCost + rewriteCost;

	// Per-turn expected costs over horizon:
	// Preserve per turn: uncached input + cached read
	const preserveTurnCost = usd(input.currentTokens, hitRatio * readPrice + (1 - hitRatio) * inputPrice);
	// Compact per turn: shorter post-compaction input / cached read, reflecting tier movement if prices changed
	const compactTurnCost = usd(postTokens, hitRatio * postReadPrice + (1 - hitRatio) * postInputPrice);

	const savedPerTurn = Math.max(0, preserveTurnCost - compactTurnCost);
	const horizonTurns = Math.max(1, input.horizonTurns);
	const totalHorizonSavings = savedPerTurn * horizonTurns;

	const projected = totalHorizonSavings - compactionOneTimeCost;

	// Hot cache: Strong bias, not an absolute veto.
	// When cache is hot (hitRatio >= 0.7), add a bias margin penalty proportional to hit ratio.
	const hotCacheBiasUsd = hitRatio >= 0.7 ? (hitRatio - 0.5) * 0.005 : 0;
	const requiredSavings = input.minSavingsUsd + hotCacheBiasUsd;

	if (hitRatio >= 0.7 && projected < requiredSavings) {
		return {
			proceed: false,
			reason: "hot_cache",
			detail: `hit ratio ${hitRatio.toFixed(2)}; hot cache bias requires net savings >= ${requiredSavings.toFixed(6)}, projected was ${projected.toFixed(6)}`,
			projectedSavingsUsd: projected,
		};
	}
	if (compactionOneTimeCost >= totalHorizonSavings && totalHorizonSavings > 0) {
		return {
			proceed: false,
			reason: "summary_wipes_savings",
			detail: `summary+rewrite ${compactionOneTimeCost.toFixed(6)} >= horizon savings ${totalHorizonSavings.toFixed(6)}`,
			projectedSavingsUsd: projected,
		};
	}
	if (projected < requiredSavings) {
		return {
			proceed: false,
			reason: "insufficient_savings",
			detail: `projected ${projected.toFixed(6)} below margin ${requiredSavings.toFixed(6)}`,
			projectedSavingsUsd: projected,
		};
	}
	return {
		proceed: true,
		reason: `projected savings ${projected.toFixed(6)} USD over ${horizonTurns} turns (hitRatio: ${hitRatio.toFixed(2)}, postPriceShift: ${postInputPrice !== inputPrice})`,
		projectedSavingsUsd: projected,
		preserveTurnCostUsd: preserveTurnCost,
		compactTurnCostUsd: compactTurnCost,
		compactionOneTimeCostUsd: compactionOneTimeCost,
		hitRatio,
	};
}
