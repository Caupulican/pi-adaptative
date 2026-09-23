import type {
	CacheObservationRow,
	CompactionOutcomeRow,
	DecisionLedgerStore,
} from "../operator-projection/decision-ledger-store.ts";
import {
	decayWeight,
	laneParts,
	lineageRemainingRequests,
	negligibleAgeMs,
	predictRetainedWithError,
	type SurvivalCurve,
	type SurvivalSettings,
	survivalCurve,
} from "./cache-survival.ts";
import { CACHE_SURVIVAL_CALIBRATION } from "./cache-survival-calibration.ts";

/** What a compaction on a lane is expected to leave and to generate, as shares of the context before it. */
export interface CompactionOutcomeEstimate {
	/** Context after the compaction over the context before it. */
	readonly afterRatio: number;
	/** Tokens the summarizer generated over the context before it. */
	readonly outputRatio: number;
	/** Effective count of the lane's own outcomes behind the estimate. */
	readonly laneEffectiveN: number;
}

/**
 * The session's learned view of provider caches, read from the decision ledger: each lane's survival
 * curve (retained cache over the idle gap), the lineage lifetime, and what compactions leave behind.
 * Rows are read once per provider and then extended by the observations this session records, so the
 * curves follow new evidence without re-reading the ledger; a lane's curve is recomputed only after a
 * new observation on its provider. Nothing here decides: the economics module prices with it.
 */
export class CacheKnowledge {
	private readonly getLedger: () => DecisionLedgerStore | undefined;
	private readonly settings: SurvivalSettings;
	private readonly providerRows = new Map<string, CacheObservationRow[]>();
	private readonly curves = new Map<string, SurvivalCurve>();

	constructor(
		getLedger: () => DecisionLedgerStore | undefined,
		settings: SurvivalSettings = CACHE_SURVIVAL_CALIBRATION,
	) {
		this.getLedger = getLedger;
		this.settings = settings;
	}

	/** A cache observation the session just recorded in the ledger. */
	noteObservation(row: CacheObservationRow): void {
		const provider = laneParts(row.lane).provider;
		this.providerRows.get(provider)?.push(row);
		for (const lane of [...this.curves.keys()]) {
			if (laneParts(lane).provider === provider) this.curves.delete(lane);
		}
	}

	/** The retained share, with its standard error, a request on `lane` can expect after `gapMs` idle. */
	retainedAfter(lane: string, gapMs: number, now: number): { retained: number; standardError: number } | undefined {
		const curve = this.curve(lane, now);
		return curve ? predictRetainedWithError(curve, gapMs, this.settings.binsPerDecade) : undefined;
	}

	/** Learned idle gaps that ended with `holder` waking a lane (every lane: the wait is the holder's). */
	returnGaps(holder: "owner" | "tool" | "host", now: number): number[] {
		return this.getLedger()?.returnGaps(holder, now - negligibleAgeMs(this.settings.halfLifeMs)) ?? [];
	}

	/** The curve's measurement resolution for `lane`: the moments a decision over idle time can act at. */
	gapResolution(lane: string, now: number): number[] {
		return this.curve(lane, now)?.bins.map((bin) => bin.fromMs) ?? [];
	}

	/** When `lane` last answered in this session, per the ledger. */
	lastResponseAt(sessionId: string, lane: string): number | undefined {
		return this.getLedger()?.latestCacheObservation(sessionId, lane)?.observedAt;
	}

	/** The live lineage's requests so far and the learned median further requests. */
	lineage(
		sessionId: string,
		lineage: string,
		now: number,
	): { elapsed: number; remaining: number | undefined; lineages: number } | undefined {
		const ledger = this.getLedger();
		if (!ledger) return undefined;
		return lineageRemainingRequests(ledger.lineageEpisodes(), { sessionId, lineage }, now, this.settings.halfLifeMs);
	}

	/**
	 * What a compaction on `lane` is expected to leave and generate: the lane's own recency-weighted
	 * outcomes, pooled toward every recorded outcome with the same weight the survival curve pools with.
	 * Undefined before any compaction was recorded.
	 */
	compactionOutcome(lane: string, now: number): CompactionOutcomeEstimate | undefined {
		const ledger = this.getLedger();
		if (!ledger) return undefined;
		const rows = ledger.compactionOutcomesSince(now - negligibleAgeMs(this.settings.halfLifeMs));
		const all = this.weightedOutcome(rows, now);
		if (!all) return undefined;
		const own = this.weightedOutcome(
			rows.filter((row) => row.lane === lane),
			now,
		);
		if (!own) return { afterRatio: all.afterRatio, outputRatio: all.outputRatio, laneEffectiveN: 0 };
		const k = this.settings.poolingWeight;
		const pool = (mine: number, parent: number) => (own.effectiveN * mine + k * parent) / (own.effectiveN + k);
		return {
			afterRatio: pool(own.afterRatio, all.afterRatio),
			outputRatio: pool(own.outputRatio, all.outputRatio),
			laneEffectiveN: own.effectiveN,
		};
	}

	private weightedOutcome(
		rows: readonly CompactionOutcomeRow[],
		now: number,
	): { afterRatio: number; outputRatio: number; effectiveN: number } | undefined {
		let weight = 0;
		let weightSquared = 0;
		let after = 0;
		let output = 0;
		for (const row of rows) {
			if (row.tokensBefore <= 0) continue;
			const w = decayWeight(now - row.observedAt, this.settings.halfLifeMs);
			weight += w;
			weightSquared += w * w;
			after += w * (row.tokensAfter / row.tokensBefore);
			output += w * (row.outputTokens / row.tokensBefore);
		}
		if (!(weight > 0)) return undefined;
		return {
			afterRatio: after / weight,
			outputRatio: output / weight,
			effectiveN: (weight * weight) / weightSquared,
		};
	}

	private curve(lane: string, now: number): SurvivalCurve | undefined {
		const cached = this.curves.get(lane);
		if (cached) return cached;
		const provider = laneParts(lane).provider;
		let rows = this.providerRows.get(provider);
		if (!rows) {
			const ledger = this.getLedger();
			if (!ledger) return undefined;
			rows = ledger.cacheObservationsForProvider(provider, now - negligibleAgeMs(this.settings.halfLifeMs));
			this.providerRows.set(provider, rows);
		}
		const curve = survivalCurve(rows, lane, this.settings, now);
		this.curves.set(lane, curve);
		return curve;
	}
}
