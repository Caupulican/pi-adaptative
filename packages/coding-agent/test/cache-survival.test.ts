import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CacheKnowledge } from "../src/core/context/cache-knowledge.ts";
import {
	CacheObservationRecorder,
	cacheLaneKey,
	historyLineage,
} from "../src/core/context/cache-observation-recorder.ts";
import {
	lineageEpisodes,
	medianRemainingRequests,
	nonIncreasing,
	predictRetained,
	type SurvivalObservation,
	type SurvivalSettings,
	survivalCurve,
} from "../src/core/context/cache-survival.ts";
import { DecisionLedgerStore } from "../src/core/operator-projection/decision-ledger-store.ts";

const SETTINGS: SurvivalSettings = { halfLifeMs: Number.POSITIVE_INFINITY, poolingWeight: 4, binsPerDecade: 4 };
const MINUTE = 60_000;

function lane(provider: string, modelId: string, api = "api"): string {
	return cacheLaneKey(api, provider, modelId);
}

/** A lane whose provider keeps the cache for exactly `ttlMs`: full reuse before it, none after. */
function ttlLane(key: string, ttlMs: number, gaps: readonly number[]): SurvivalObservation[] {
	return gaps.map((gapMs, index) => ({
		lane: key,
		observedAt: index,
		gapMs,
		retained: gapMs < ttlMs ? 1 : 0,
		promptTokens: 20_000,
		cacheReadTokens: gapMs < ttlMs ? 20_000 : 0,
		prefixIntact: "true",
	}));
}

const GAPS = [2_000, 20_000, 90_000, 4 * MINUTE, 8 * MINUTE, 20 * MINUTE, 90 * MINUTE].flatMap((gap) =>
	Array.from({ length: 12 }, () => gap),
);

describe("cache survival curve", () => {
	it("recovers a lane's cache lifetime from its observations", () => {
		const key = lane("xai", "grok");
		const curve = survivalCurve(ttlLane(key, 5 * MINUTE, GAPS), key, SETTINGS, 100);
		expect(predictRetained(curve, 30_000, SETTINGS.binsPerDecade)).toBeCloseTo(1, 5);
		expect(predictRetained(curve, 4 * MINUTE, SETTINGS.binsPerDecade)).toBeCloseTo(1, 5);
		expect(predictRetained(curve, 20 * MINUTE, SETTINGS.binsPerDecade)).toBeCloseTo(0, 5);
		// Past the evidence there is no estimate for a provider without a documented TTL.
		expect(predictRetained(curve, 3 * 86_400_000, SETTINGS.binsPerDecade)).toBeUndefined();
		expect(curve.minCacheableTokens).toBe(20_000);
	});

	it("repairs a non-monotone sample: an older cache never holds more", () => {
		expect(nonIncreasing([0.9, 0.5, 0.7, 0.2], [1, 1, 1, 1])).toEqual([0.9, 0.6, 0.6, 0.2]);
		const key = lane("xai", "grok");
		const observations: SurvivalObservation[] = [
			...ttlLane(key, 5 * MINUTE, [2_000, 2_000]),
			{
				lane: key,
				observedAt: 3,
				gapMs: 20_000,
				retained: 0.3,
				promptTokens: 1,
				cacheReadTokens: 0,
				prefixIntact: "true",
			},
			{
				lane: key,
				observedAt: 4,
				gapMs: 90_000,
				retained: 0.9,
				promptTokens: 1,
				cacheReadTokens: 0,
				prefixIntact: "true",
			},
		];
		const values = survivalCurve(observations, key, SETTINGS, 10)
			.bins.map((bin) => bin.retained)
			.filter((value) => value !== undefined);
		for (let index = 1; index < values.length; index++) expect(values[index]).toBeLessThanOrEqual(values[index - 1]);
	});

	it("lets a sparse lane borrow from its provider and from the documented TTL", () => {
		const rich = lane("xai", "grok-a");
		const sparse = lane("xai", "grok-b");
		const observations = [...ttlLane(rich, 5 * MINUTE, GAPS), ...ttlLane(sparse, 5 * MINUTE, [2_000])];
		const curve = survivalCurve(observations, sparse, SETTINGS, 100);
		const late = curve.bins.find((bin) => bin.fromMs >= 20 * MINUTE && bin.retained !== undefined);
		expect(late?.source).toBe("provider");
		expect(late?.retained).toBeCloseTo(0, 5);

		// Anthropic with no observations at all falls to its documented five-minute cache.
		const opus = lane("anthropic", "claude-opus-5-5", "anthropic-messages");
		const prior = survivalCurve([], opus, SETTINGS, 0);
		expect(predictRetained(prior, MINUTE, SETTINGS.binsPerDecade)).toBe(1);
		expect(predictRetained(prior, 30 * MINUTE, SETTINGS.binsPerDecade)).toBe(0);
		expect(prior.bins.find((bin) => bin.retained !== undefined)?.source).toBe("prior");
		// With long retention the prior holds for the hour.
		expect(predictRetained(survivalCurve([], opus, SETTINGS, 0, "long"), 30 * MINUTE, SETTINGS.binsPerDecade)).toBe(
			1,
		);
	});

	it("excludes requests whose own prefix changed: their cold read is ours, not the provider's", () => {
		const key = lane("xai", "grok");
		const broken: SurvivalObservation[] = ttlLane(key, 5 * MINUTE, [2_000, 2_000, 2_000]).map((o) => ({
			...o,
			retained: 0,
			prefixIntact: "false",
		}));
		const curve = survivalCurve([...ttlLane(key, 5 * MINUTE, [2_000]), ...broken], key, SETTINGS, 10);
		expect(predictRetained(curve, 2_000, SETTINGS.binsPerDecade)).toBe(1);
	});

	it("weighs recent evidence above old evidence with a finite half-life", () => {
		const key = lane("xai", "grok");
		const old = ttlLane(
			key,
			0,
			Array.from({ length: 10 }, () => 2_000),
		).map((o) => ({ ...o, observedAt: 0 }));
		const recent = ttlLane(
			key,
			MINUTE,
			Array.from({ length: 10 }, () => 2_000),
		).map((o) => ({
			...o,
			observedAt: 10 * 86_400_000,
		}));
		const settings = { ...SETTINGS, halfLifeMs: 86_400_000 };
		const retained = predictRetained(survivalCurve([...old, ...recent], key, settings, 10 * 86_400_000), 2_000, 4);
		expect(retained).toBeGreaterThan(0.99);
	});
});

describe("lineage lifetime", () => {
	it("splits a session's requests at each compaction and leaves the live lineage open", () => {
		expect(lineageEpisodes(["root", "root", "c1", "c1", "c1"], true)).toEqual([
			{ requests: 2, ended: true },
			{ requests: 3, ended: false },
		]);
	});

	it("reads the median further requests given the requests already made", () => {
		const episodes = [10, 20, 30, 40, 50].map((requests) => ({ requests, ended: true }));
		expect(medianRemainingRequests(episodes, 0)).toBe(30);
		// Surviving past 25 leaves 30, 40, 50: half are over by 40.
		expect(medianRemainingRequests(episodes, 25)).toBe(15);
		// Nothing that long has been seen: no estimate.
		expect(medianRemainingRequests(episodes, 50)).toBeUndefined();
		// Lineages still open count as survivors, never as ends.
		const open = [...episodes, ...[60, 60, 60].map((requests) => ({ requests, ended: false }))];
		expect(medianRemainingRequests(open, 25)).toBe(25);
	});

	it("names a history's lineage by the compaction it follows", () => {
		expect(historyLineage([{ role: "user", timestamp: 1 }])).toBe("root");
		expect(historyLineage([{ role: "compactionSummary", timestamp: 7 }, { role: "user" }])).toBe("compaction@7");
		// Session-replacement retention keeps the original user message ahead of the summary.
		expect(historyLineage([{ role: "user" }, { role: "compactionSummary", timestamp: 9 }])).toBe("compaction@9");
	});
});

describe("cache observations across processes", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("measures a resumed session's gap from the ledger and counts its lineages", () => {
		const dir = mkdtempSync(join(tmpdir(), "cache-survival-"));
		dirs.push(dir);
		const ledger = new DecisionLedgerStore({ databasePath: join(dir, "decision-ledger.sqlite") });
		const key = lane("openrouter", "ling");
		const seed = (sessionId: string, laneKey: string) => {
			const last = ledger.latestCacheObservation(sessionId, laneKey);
			return last ? { respondedAt: last.observedAt, promptTokens: last.promptTokens } : undefined;
		};
		const record = (recorder: CacheObservationRecorder, at: number, cacheRead: number, lineage: string) => {
			const row = recorder.observe({
				sessionId: "s",
				lane: key,
				requestOpenedAt: at,
				respondedAt: at + 1_000,
				usage: { input: 1_000 - cacheRead, cacheRead },
				lineage,
			});
			if (row) ledger.recordCacheObservation({ ...row, sessionId: "s", cwd: "/repo" });
			return row;
		};
		record(new CacheObservationRecorder(seed), 0, 0, "root");
		// A new process resuming the same session measures the gap since the last recorded response.
		const resumed = record(new CacheObservationRecorder(seed), 61_000, 900, "root");
		expect(resumed).toMatchObject({ gapMs: 60_000, retained: 0.9, lineage: "root" });
		// Another session's history is never the previous request.
		expect(
			new CacheObservationRecorder(seed).observe({ sessionId: "t", lane: key, respondedAt: 1, usage: { input: 5 } })
				?.gapMs,
		).toBeUndefined();
		record(new CacheObservationRecorder(seed), 70_000, 0, "compaction@1");
		expect(ledger.lineageEpisodes()).toEqual([
			{ sessionId: "s", lineage: "compaction@1", requests: 1, lastObservedAt: 71_000 },
			{ sessionId: "s", lineage: "root", requests: 2, lastObservedAt: 62_000 },
		]);
	});
});

describe("cache knowledge", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	const ledgerIn = () => {
		const dir = mkdtempSync(join(tmpdir(), "cache-knowledge-"));
		dirs.push(dir);
		return new DecisionLedgerStore({ databasePath: join(dir, "decision-ledger.sqlite") });
	};

	it("learns what a compaction leaves and generates, pooling a sparse lane toward every lane", () => {
		const ledger = ledgerIn();
		const knowledge = new CacheKnowledge(() => ledger, SETTINGS);
		const own = lane("openrouter", "deepseek");
		expect(knowledge.compactionOutcome(own, 0)).toBeUndefined();
		for (let index = 0; index < 4; index++) {
			ledger.recordCompactionOutcome({
				sessionId: "s",
				lane: lane("xai", "grok"),
				observedAt: index,
				tokensBefore: 100_000,
				tokensAfter: 20_000,
				outputTokens: 2_000,
			});
		}
		// No outcome on this lane yet: every lane's outcome stands in.
		expect(knowledge.compactionOutcome(own, 10)).toEqual({ afterRatio: 0.2, outputRatio: 0.02, laneEffectiveN: 0 });
		ledger.recordCompactionOutcome({
			sessionId: "s",
			lane: own,
			observedAt: 5,
			tokensBefore: 30_000,
			tokensAfter: 3_000,
			outputTokens: 1_500,
		});
		// One own outcome against a pooling weight of 4: a fifth of the way from every lane's 0.2 (which
		// now includes it) toward its own 0.1.
		const all = (4 * 0.2 + 0.1) / 5;
		const pooled = knowledge.compactionOutcome(own, 10);
		expect(pooled?.laneEffectiveN).toBe(1);
		expect(pooled?.afterRatio).toBeCloseTo((1 * 0.1 + 4 * all) / 5, 12);
	});

	it("reads a lane's curve from the ledger once and follows the observations the session records", () => {
		const ledger = ledgerIn();
		const knowledge = new CacheKnowledge(() => ledger, SETTINGS);
		const key = lane("xai", "grok");
		const record = (observedAt: number, retained: number) => {
			const row = {
				sessionId: "s",
				cwd: "/repo",
				lane: key,
				observedAt,
				gapMs: 2_000,
				promptTokens: 20_000,
				cacheReadTokens: Math.round(20_000 * retained),
				retained,
				prefixIntact: "true" as const,
			};
			ledger.recordCacheObservation(row);
			return row;
		};
		record(1, 1);
		expect(knowledge.retainedAfter(key, 2_000, 10)?.retained).toBe(1);
		knowledge.noteObservation(record(2, 0));
		expect(knowledge.retainedAfter(key, 2_000, 10)?.retained).toBeCloseTo(0.5, 12);
		expect(knowledge.lastResponseAt("s", key)).toBe(2);
	});
});
