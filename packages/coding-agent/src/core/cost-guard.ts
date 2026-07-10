/**
 * Proactive per-turn token cost guard (Hermes-parity superiority item #34).
 *
 * Hermes (and pi today) only react to context growth by compressing AFTER it's expensive. This estimates
 * the dollar cost of the NEXT LLM call BEFORE it is submitted, so the agent can warn the user or
 * automatically reduce reasoning effort before a runaway billing spike — a proactive ceiling, not a
 * reactive cleanup. Pure functions: no I/O, fully testable.
 */

/** Per-million-token USD prices, as carried on `Model.cost`. */
export interface ModelTokenCost {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
}

/**
 * Estimate the USD cost of one turn: the whole current context is billed as input, plus up to
 * `maxOutputTokens` of output. `cachedInputTokens` (prefix-cache hits) are billed at the cheaper
 * cache-read rate. Fresh input is billed once at the higher of the uncached-input and cache-write
 * rates because a provider may select that prefix for a new cache write. This is an UPPER bound on
 * the turn (it also assumes the model emits its full output budget), which is what a spending ceiling
 * should bound against.
 */
export function estimateTurnCostUsd(args: {
	inputTokens: number;
	maxOutputTokens: number;
	cost: ModelTokenCost;
	cachedInputTokens?: number;
	longContextPricing?: { thresholdTokens: number; inputMultiplier: number; outputMultiplier: number };
}): number {
	const { inputTokens, maxOutputTokens, cost } = args;
	const cached = Math.max(0, Math.min(args.cachedInputTokens ?? 0, inputTokens));
	const freshInput = inputTokens - cached;
	const cacheReadRate = cost.cacheRead ?? cost.input;
	const freshInputRate = Math.max(cost.input, cost.cacheWrite ?? cost.input);
	const longContextPricing = args.longContextPricing;
	const useLongContextTier = longContextPricing && inputTokens > longContextPricing.thresholdTokens;
	const inputMultiplier = useLongContextTier ? longContextPricing.inputMultiplier : 1;
	const outputMultiplier = useLongContextTier ? longContextPricing.outputMultiplier : 1;
	const inputUsd = ((freshInput * freshInputRate + cached * cacheReadRate) * inputMultiplier) / 1_000_000;
	const outputUsd = (Math.max(0, maxOutputTokens) * cost.output * outputMultiplier) / 1_000_000;
	return inputUsd + outputUsd;
}

/** What to do when a turn's projected cost exceeds the threshold. */
export type CostGuardAction = "warn" | "downgrade";

export interface CostGuardSettings {
	/** Per-turn projected USD threshold. `0` disables the guard entirely. */
	maxTurnUsd: number;
	/** Over the ceiling: `warn` (surface a notice) or `downgrade` (also reduce reasoning effort). */
	action: CostGuardAction;
}

export const DEFAULT_COST_GUARD_SETTINGS: CostGuardSettings = {
	maxTurnUsd: 2.5,
	action: "warn",
};

export interface CostGuardDecision {
	/** True when the guard is enabled AND the projected cost exceeds the ceiling. */
	over: boolean;
	estUsd: number;
	thresholdUsd: number;
	action: CostGuardAction;
}

/** Decide whether the projected turn cost trips the guard. Disabled (`maxTurnUsd<=0`) is never `over`. */
export function evaluateCostGuard(estUsd: number, settings: CostGuardSettings): CostGuardDecision {
	const enabled = settings.maxTurnUsd > 0;
	return {
		over: enabled && estUsd > settings.maxTurnUsd,
		estUsd,
		thresholdUsd: settings.maxTurnUsd,
		action: settings.action,
	};
}

/** Reasoning levels in descending cost order, used to pick the next-cheaper level on a downgrade. */
const REASONING_LADDER = ["ultra", "max", "xhigh", "high", "medium", "low", "minimal", "off"] as const;
export type ReasoningLevel = (typeof REASONING_LADDER)[number];
export type ReasoningEffortMap = Readonly<Partial<Record<ReasoningLevel, string | null>>>;

function effectiveReasoningEffort(level: ReasoningLevel, effortMap: ReasoningEffortMap | undefined): string | null {
	const mapped = effortMap?.[level];
	return mapped === undefined ? level : mapped;
}

/**
 * One supported step down the reasoning ladder (cost reduction) from `current`. When
 * `supportedLevels` is provided, unsupported intermediate levels are skipped instead of relying on a
 * provider clamp that may move back upward. Returns `current` unchanged when already at the model's
 * floor or unrecognized — the guard never raises effort, only lowers it.
 */
export function downgradeReasoning(
	current: string,
	supportedLevels?: readonly ReasoningLevel[],
	effortMap?: ReasoningEffortMap,
): ReasoningLevel | string {
	const i = REASONING_LADDER.indexOf(current as ReasoningLevel);
	if (i < 0) return current;
	if (!supportedLevels) {
		return REASONING_LADDER[Math.min(i + 1, REASONING_LADDER.length - 1)];
	}
	const supported = new Set<ReasoningLevel>(supportedLevels);
	const currentEffort = effectiveReasoningEffort(current as ReasoningLevel, effortMap);
	for (let nextIndex = i + 1; nextIndex < REASONING_LADDER.length; nextIndex++) {
		const candidate = REASONING_LADDER[nextIndex];
		if (supported.has(candidate) && effectiveReasoningEffort(candidate, effortMap) !== currentEffort)
			return candidate;
	}
	return current;
}
