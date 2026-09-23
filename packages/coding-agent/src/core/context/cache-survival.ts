/**
 * Learned provider-cache survival: how much of a lane's previous prompt the provider still serves
 * from cache after an idle gap, R(gap), and how many more requests a history lineage lives before a
 * compaction or the session's end rewrites it. Pure: observations in, estimates out, no I/O.
 *
 * R(gap) is measured, never assumed. Gaps fall into log-spaced bins (measurement resolution only);
 * each bin holds a decay-weighted mean of the observed retained share and its effective sample
 * count. A sparse lane borrows from the same model on other APIs, then from its provider, then from
 * the provider's documented cache TTL where one exists (Anthropic: 5 minutes, or 1 hour with long
 * retention); the borrowed weight is fixed, so it fades as the lane's own evidence grows. The final
 * curve is made non-increasing by pool-adjacent-violators: an older cache never holds more.
 *
 * Only observations whose prefix was intact measure the provider. A request whose own prefix
 * changed (`prefixIntact: "false"`) lost cache to the harness, not to time, and is excluded; one
 * recorded before prefix tracking existed (`"unknown"`) is kept and counted as lower confidence.
 * Gaps are wall time: a provider's cache keeps aging while the host is suspended.
 */

/** One provider response on a lane, as the decision ledger (or a session-log replay) records it. */
export interface SurvivalObservation {
	/** `cacheLaneKey(api, provider, modelId)`. */
	readonly lane: string;
	readonly observedAt: number;
	/** Wall time from the lane's previous response to this request; absent on a lane's first request. */
	readonly gapMs?: number;
	/** Cache-read tokens over the lane's previous prompt, in [0, 1]; absent on a lane's first request. */
	readonly retained?: number;
	readonly promptTokens: number;
	readonly cacheReadTokens: number;
	readonly prefixIntact: "true" | "false" | "unknown";
}

export interface SurvivalSettings {
	/** Age at which an observation's weight halves; `Infinity` weighs all history equally. */
	readonly halfLifeMs: number;
	/** Effective observations a parent level (model, provider, TTL prior) counts for in a lane's bin. */
	readonly poolingWeight: number;
	/** Gap bins per factor of ten. */
	readonly binsPerDecade: number;
}

export interface SurvivalBin {
	/** Inclusive lower and exclusive upper gap bound of the bin. */
	readonly fromMs: number;
	readonly toMs: number;
	/** Estimated retained share; undefined when no level has evidence for this gap. */
	readonly retained: number | undefined;
	/** The lane's own effective sample count in this bin. */
	readonly laneEffectiveN: number;
	/** The deepest level that had evidence: the lane itself, or what it borrowed from. */
	readonly source: "lane" | "model" | "provider" | "prior" | "none";
	/** Share of the lane's own weight in this bin from observations without prefix tracking. */
	readonly lowConfidenceShare: number;
}

export interface SurvivalCurve {
	readonly lane: string;
	readonly bins: readonly SurvivalBin[];
	/** The smallest prompt this lane ever served a cache read for: below it the provider caches nothing. */
	readonly minCacheableTokens: number | undefined;
	readonly laneObservations: number;
	/** The provider's documented cache lifetime the curve fell back to, where it has one. */
	readonly priorTtlMs: number | undefined;
}

/** Gap resolution floor: the first bin holds every gap under one second. */
const FIRST_BIN_UPPER_MS = 1_000;

export function laneParts(lane: string): { api: string; provider: string; modelId: string } {
	const [api = "", provider = "", modelId = ""] = lane.split("\u0000");
	return { api, provider, modelId };
}

/** The documented cache lifetime of a provider, where the provider publishes one. */
export function providerCacheTtlMs(provider: string, retention?: "short" | "long"): number | undefined {
	if (provider !== "anthropic") return undefined;
	return retention === "long" ? 60 * 60_000 : 5 * 60_000;
}

export function gapBinIndex(gapMs: number, binsPerDecade: number): number {
	if (!(gapMs >= FIRST_BIN_UPPER_MS)) return 0;
	return 1 + Math.floor(Math.log10(gapMs / FIRST_BIN_UPPER_MS) * binsPerDecade);
}

function binBounds(index: number, binsPerDecade: number): { fromMs: number; toMs: number } {
	if (index === 0) return { fromMs: 0, toMs: FIRST_BIN_UPPER_MS };
	return {
		fromMs: FIRST_BIN_UPPER_MS * 10 ** ((index - 1) / binsPerDecade),
		toMs: FIRST_BIN_UPPER_MS * 10 ** (index / binsPerDecade),
	};
}

/** Share of a bin that lies below a TTL, measured on the log scale the bins are spaced on. */
function priorRetained(ttlMs: number, fromMs: number, toMs: number): number {
	if (toMs <= ttlMs) return 1;
	if (fromMs >= ttlMs) return 0;
	if (fromMs <= 0) return ttlMs / toMs;
	return Math.log(ttlMs / fromMs) / Math.log(toMs / fromMs);
}

export function decayWeight(ageMs: number, halfLifeMs: number): number {
	if (!Number.isFinite(halfLifeMs)) return 1;
	return 0.5 ** (Math.max(0, ageMs) / halfLifeMs);
}

interface BinAccumulator {
	weight: number;
	weightSquared: number;
	weightedRetained: number;
	lowConfidenceWeight: number;
}

interface LevelBins {
	readonly bins: Map<number, BinAccumulator>;
}

function measuring(observation: SurvivalObservation): observation is SurvivalObservation & {
	gapMs: number;
	retained: number;
} {
	return (
		observation.prefixIntact !== "false" &&
		typeof observation.gapMs === "number" &&
		Number.isFinite(observation.gapMs) &&
		typeof observation.retained === "number" &&
		Number.isFinite(observation.retained)
	);
}

function accumulate(observations: readonly SurvivalObservation[], settings: SurvivalSettings, now: number): LevelBins {
	const bins = new Map<number, BinAccumulator>();
	for (const observation of observations) {
		if (!measuring(observation)) continue;
		const weight = decayWeight(now - observation.observedAt, settings.halfLifeMs);
		if (!(weight > 0)) continue;
		const index = gapBinIndex(observation.gapMs, settings.binsPerDecade);
		const bin = bins.get(index) ?? { weight: 0, weightSquared: 0, weightedRetained: 0, lowConfidenceWeight: 0 };
		bin.weight += weight;
		bin.weightSquared += weight * weight;
		bin.weightedRetained += weight * Math.min(1, Math.max(0, observation.retained));
		if (observation.prefixIntact === "unknown") bin.lowConfidenceWeight += weight;
		bins.set(index, bin);
	}
	return { bins };
}

/** Kish effective sample size: equal weights give the count, skewed weights give fewer. */
function effectiveN(bin: BinAccumulator | undefined): number {
	return bin && bin.weightSquared > 0 ? (bin.weight * bin.weight) / bin.weightSquared : 0;
}

function shrink(
	own: BinAccumulator | undefined,
	parent: number | undefined,
	poolingWeight: number,
): number | undefined {
	const n = effectiveN(own);
	const mean = own && own.weight > 0 ? own.weightedRetained / own.weight : undefined;
	if (mean === undefined) return parent;
	if (parent === undefined) return mean;
	return (n * mean + poolingWeight * parent) / (n + poolingWeight);
}

/** Pool-adjacent-violators for a non-increasing sequence; entries without a value are skipped. */
export function nonIncreasing(
	values: readonly (number | undefined)[],
	weights: readonly number[],
): (number | undefined)[] {
	const blocks: { value: number; weight: number; indices: number[] }[] = [];
	values.forEach((value, index) => {
		if (value === undefined) return;
		blocks.push({ value, weight: Math.max(weights[index] ?? 0, Number.EPSILON), indices: [index] });
		while (blocks.length > 1) {
			const last = blocks[blocks.length - 1];
			const previous = blocks[blocks.length - 2];
			if (previous.value >= last.value) break;
			const weight = previous.weight + last.weight;
			blocks.splice(blocks.length - 2, 2, {
				value: (previous.value * previous.weight + last.value * last.weight) / weight,
				weight,
				indices: [...previous.indices, ...last.indices],
			});
		}
	});
	const out: (number | undefined)[] = values.map(() => undefined);
	for (const block of blocks) for (const index of block.indices) out[index] = block.value;
	return out;
}

/**
 * The survival curve of one lane from every observation available (all lanes: the lane's model and
 * provider peers are its pooling parents). `retention` selects the documented TTL prior where the
 * provider has one.
 */
export function survivalCurve(
	observations: readonly SurvivalObservation[],
	lane: string,
	settings: SurvivalSettings,
	now: number,
	retention?: "short" | "long",
): SurvivalCurve {
	const { provider, modelId } = laneParts(lane);
	const laneObservations = observations.filter((o) => o.lane === lane);
	const modelObservations = observations.filter((o) => {
		const parts = laneParts(o.lane);
		return parts.provider === provider && parts.modelId === modelId;
	});
	const providerObservations = observations.filter((o) => laneParts(o.lane).provider === provider);
	const laneBins = accumulate(laneObservations, settings, now).bins;
	const modelBins = accumulate(modelObservations, settings, now).bins;
	const providerBins = accumulate(providerObservations, settings, now).bins;
	const ttlMs = providerCacheTtlMs(provider, retention);

	let lastIndex = Math.max(-1, ...laneBins.keys(), ...modelBins.keys(), ...providerBins.keys());
	if (ttlMs !== undefined) lastIndex = Math.max(lastIndex, gapBinIndex(ttlMs, settings.binsPerDecade) + 1);

	const raw: (number | undefined)[] = [];
	const weights: number[] = [];
	const sources: SurvivalBin["source"][] = [];
	for (let index = 0; index <= lastIndex; index++) {
		const { fromMs, toMs } = binBounds(index, settings.binsPerDecade);
		const prior = ttlMs !== undefined ? priorRetained(ttlMs, fromMs, toMs) : undefined;
		const fromProvider = shrink(providerBins.get(index), prior, settings.poolingWeight);
		const fromModel = shrink(modelBins.get(index), fromProvider, settings.poolingWeight);
		const value = shrink(laneBins.get(index), fromModel, settings.poolingWeight);
		raw.push(value);
		weights.push(effectiveN(laneBins.get(index)) + (value === undefined ? 0 : settings.poolingWeight));
		sources.push(
			laneBins.has(index)
				? "lane"
				: modelBins.has(index)
					? "model"
					: providerBins.has(index)
						? "provider"
						: prior !== undefined
							? "prior"
							: "none",
		);
	}
	const monotone = nonIncreasing(raw, weights);

	let minCacheableTokens: number | undefined;
	for (const observation of laneObservations) {
		if (observation.cacheReadTokens > 0) {
			minCacheableTokens = Math.min(minCacheableTokens ?? observation.promptTokens, observation.promptTokens);
		}
	}
	return {
		lane,
		bins: monotone.map((retained, index) => {
			const own = laneBins.get(index);
			return {
				...binBounds(index, settings.binsPerDecade),
				retained,
				laneEffectiveN: effectiveN(own),
				source: sources[index] ?? "none",
				lowConfidenceShare: own && own.weight > 0 ? own.lowConfidenceWeight / own.weight : 0,
			};
		}),
		minCacheableTokens,
		laneObservations: laneObservations.length,
		priorTtlMs: ttlMs,
	};
}

/**
 * The curve's estimate for a gap. Past the last bin only a documented TTL still speaks (the cache is
 * gone after it); otherwise, past the evidence, there is no estimate.
 */
export function predictRetained(curve: SurvivalCurve, gapMs: number, binsPerDecade: number): number | undefined {
	const bin = curve.bins[gapBinIndex(gapMs, binsPerDecade)];
	if (bin) return bin.retained;
	return curve.priorTtlMs !== undefined && gapMs >= curve.priorTtlMs ? 0 : undefined;
}

/**
 * One history lineage: the requests made on one session's history between compactions. A lineage
 * ends at the next compaction or at the session's last request; the lineage still being written is
 * open (censored), since its end is not known yet.
 */
export interface LineageEpisode {
	readonly requests: number;
	readonly ended: boolean;
	/** Weight of the episode's evidence (recency decay); 1 when unweighted. */
	readonly weight?: number;
}

/**
 * Median number of further requests a lineage makes, given it has already made `elapsed`: the
 * weighted Kaplan-Meier survival of lineage lengths, conditioned on surviving past `elapsed`, read at
 * one half. Open lineages count as survivors up to their length and are then censored. Undefined when
 * the evidence never falls to one half past `elapsed` (too few lineages that long have ended).
 */
export function medianRemainingRequests(episodes: readonly LineageEpisode[], elapsed: number): number | undefined {
	const atRisk = episodes.filter((episode) => episode.requests > elapsed);
	if (atRisk.length === 0) return undefined;
	const lengths = [...new Set(atRisk.filter((episode) => episode.ended).map((episode) => episode.requests))].sort(
		(a, b) => a - b,
	);
	let survival = 1;
	for (const length of lengths) {
		let exposed = 0;
		let ended = 0;
		for (const episode of atRisk) {
			const weight = episode.weight ?? 1;
			if (episode.requests >= length) exposed += weight;
			if (episode.ended && episode.requests === length) ended += weight;
		}
		if (exposed <= 0) continue;
		survival *= 1 - ended / exposed;
		if (survival <= 0.5) return length - elapsed;
	}
	return undefined;
}

/** Split a session's ordered request lineage keys into episodes; the last one is open when `open`. */
export function lineageEpisodes(lineageKeys: readonly string[], open: boolean, weight?: number): LineageEpisode[] {
	const episodes: LineageEpisode[] = [];
	let current: string | undefined;
	let count = 0;
	for (const key of lineageKeys) {
		if (current !== undefined && key !== current) {
			episodes.push({ requests: count, ended: true, ...(weight !== undefined ? { weight } : {}) });
			count = 0;
		}
		current = key;
		count++;
	}
	if (count > 0) episodes.push({ requests: count, ended: !open, ...(weight !== undefined ? { weight } : {}) });
	return episodes;
}

/** One recorded lineage, as the decision ledger aggregates it. */
export interface RecordedLineage {
	readonly sessionId: string;
	readonly lineage: string;
	readonly requests: number;
	readonly lastObservedAt: number;
}

/**
 * The live lineage's requests so far and the median further requests learned from every recorded
 * lineage (recency-weighted by `halfLifeMs`). The live lineage is open; every other one ended when
 * its session compacted or stopped. `remaining` is undefined when no lineage that long has ended.
 */
export function lineageRemainingRequests(
	recorded: readonly RecordedLineage[],
	current: { readonly sessionId: string; readonly lineage: string },
	now: number,
	halfLifeMs: number,
): { elapsed: number; remaining: number | undefined; lineages: number } {
	let elapsed = 0;
	const episodes = recorded.map((row) => {
		const open = row.sessionId === current.sessionId && row.lineage === current.lineage;
		if (open) elapsed = row.requests;
		return { requests: row.requests, ended: !open, weight: decayWeight(now - row.lastObservedAt, halfLifeMs) };
	});
	return { elapsed, remaining: medianRemainingRequests(episodes, elapsed), lineages: episodes.length };
}
