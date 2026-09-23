#!/usr/bin/env node
/**
 * Prompt-cache reuse census over recorded sessions: per session (and per provider/model with
 * `--by-model`) the median prefix reuse, the share of requests reusing at least 90%, the cache
 * wipes, time to first token, cost and prompt size; per trigger kind (tool loop, user turn,
 * reflection turn, goal continuation, after compaction) the same; with `--wipes` every wipe and
 * what rode between it and the previous request; with `--records` the persisted host-record
 * census by kind against tool-result and assistant bytes. `--gate <json>` fails on thresholds.
 *
 *   node scripts/session-reuse-census.mjs <dir|file>... [--by-model] [--wipes] [--records] [--gate '{...}']
 *
 * Reuse is `cacheRead / (input + cacheRead + cacheWrite)` from the assistant `usage` record. A wipe
 * is a request whose cacheRead is below 30% of the previous prompt (same model, previous prompt
 * over 10,000 tokens). Wall-clock spans (idle between requests, time to first token) exclude any
 * `clock_jump` the process-matrix heartbeat recorded: a suspended host is not time anything spent.
 *
 * `--survival` instead learns provider-cache survival (`src/core/context/cache-survival.ts`) from
 * the same logs: per-lane curves of retained cache over the idle gap (wall time, clock jumps
 * included, since the provider's cache ages while the host sleeps), the settings that best predict
 * held-out requests, lineage lifetimes between compactions, return gaps by who held the lane, and
 * what a compact-before-a-cold-resume policy would have saved. `--write-calibration <file>` writes
 * the chosen settings as a TypeScript module. Otherwise reads session files only; never writes.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cacheLaneKey } from "../packages/coding-agent/src/core/context/cache-observation-recorder.ts";
import { priceCompaction } from "../packages/coding-agent/src/core/compaction/early-compaction-economics.ts";
import {
	laneParts,
	lineageEpisodes,
	medianRemainingRequests,
	predictRetained,
	predictRetainedWithError,
	survivalCurve,
} from "../packages/coding-agent/src/core/context/cache-survival.ts";
import { listSessionFiles, messageText, parseSessionEntries } from "./session-stats-common.mjs";

export const HOST_RECORD_KINDS = [
	"path_alias_legend",
	"pi_tool_failure_ledger",
	"active_goal_context",
	"active_skill_context",
	"task_steps_context",
];

export const DEFAULT_GATE = {
	toolLoopP50Reuse: 0.95,
	userTurnP50Reuse: 0.9,
	hostRecordCharsShare: 0.1,
	legendBytesRatio: 1.5,
	compactionFallbacks: 0,
};

/** Session custom entry the process-matrix heartbeat writes when the wall clock jumped. */
const CLOCK_JUMP_CUSTOM_TYPE = "clock_jump";
const WIPE_RATIO = 0.3;
const WIPE_MIN_PREVIOUS_PROMPT = 10_000;
const MISS_MAX_CACHE_READ = 1_000;

function median(values) {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function quantile(values, q) {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

function recordKind(entry) {
	if (entry.type === "message") {
		const role = entry.message?.role;
		if (role === "user") return "user";
		if (role === "toolResult") return "toolResult";
		return role ?? "message";
	}
	if (entry.type === "custom_message" || entry.type === "custom") return `${entry.type}:${entry.customType ?? "?"}`;
	return entry.type ?? "?";
}

/**
 * Milliseconds of the window [startMs, endMs] that fell inside a recorded clock jump. Wall clock
 * the host was suspended for belongs to no request, so it is removed from every wall-clock span.
 */
function suspendedMs(jumps, startMs, endMs) {
	if (!(endMs > startMs)) return 0;
	return jumps.reduce(
		(sum, jump) => sum + Math.max(0, Math.min(endMs, jump.endMs) - Math.max(startMs, jump.startMs)),
		0,
	);
}

function triggerGroup(between) {
	if (between.includes("custom_message:reflection_turn_trigger")) return "reflection_turn";
	if (between.includes("custom_message:goal_continuation_trigger")) return "goal_continuation";
	if (between.includes("compaction")) return "after_compaction";
	if (between.includes("user")) return "user_turn";
	return "tool_loop";
}

/** Analyze one session's parsed entries. Pure: same entries, same result. */
export function censusEntries(entries) {
	const requests = [];
	const records = new Map();
	let toolResultChars = 0;
	let assistantChars = 0;
	let compactions = 0;
	let compactionFallbacks = 0;
	let runtimeVersion;
	let previous;
	let between = [];
	const clockJumps = [];
	entries.forEach((entry, index) => {
		if (entry.type === "compaction") compactions += 1;
		if (entry.type === "compaction_end" && entry.outcome === "fallback") compactionFallbacks += 1;
		if (entry.type === "custom" && entry.customType === CLOCK_JUMP_CUSTOM_TYPE) {
			const startMs = Date.parse(entry.data?.previousTickAt ?? "");
			const endMs = Date.parse(entry.data?.tickAt ?? "");
			if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) clockJumps.push({ startMs, endMs });
		}
		if (entry.type === "custom" && entry.customType === "reflection_cue_state") {
			const version = entry.data?.versionChange?.metadata?.runtimeVersion;
			if (typeof version === "string") runtimeVersion = version;
		}
		if (entry.type === "custom_message") {
			const text = messageText(entry.content);
			const kind = entry.customType ?? "?";
			const record = records.get(kind) ?? { count: 0, chars: 0, maxChars: 0, distinct: new Set() };
			record.count += 1;
			record.chars += text.length;
			record.maxChars = Math.max(record.maxChars, text.length);
			record.distinct.add(text);
			records.set(kind, record);
		}
		if (entry.type !== "message") {
			between.push(recordKind(entry));
			return;
		}
		const message = entry.message ?? {};
		if (message.role === "toolResult") {
			toolResultChars += messageText(message.content).length;
			between.push("toolResult");
			return;
		}
		if (message.role === "user") {
			between.push("user");
			return;
		}
		if (message.role !== "assistant") {
			between.push(recordKind(entry));
			return;
		}
		for (const part of Array.isArray(message.content) ? message.content : []) {
			if (part?.type === "text") assistantChars += String(part.text ?? "").length;
			else if (part?.type === "toolCall") assistantChars += JSON.stringify(part.arguments ?? {}).length;
		}
		const usage = message.usage ?? {};
		const prompt = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
		if (prompt <= 0) {
			between = [];
			return;
		}
		const model = `${message.provider ?? "?"}/${message.model ?? "?"}`;
		const cacheRead = usage.cacheRead ?? 0;
		const wipe =
			previous !== undefined &&
			previous.model === model &&
			previous.prompt > WIPE_MIN_PREVIOUS_PROMPT &&
			cacheRead < WIPE_RATIO * previous.prompt;
		const ttft =
			typeof message.firstTokenAt === "number" && typeof message.timestamp === "number"
				? Math.max(
						0,
						(message.firstTokenAt -
							message.timestamp -
							suspendedMs(clockJumps, message.timestamp, message.firstTokenAt)) /
							1000,
					)
				: undefined;
		const idleSeconds =
			previous && typeof message.timestamp === "number" && typeof previous.endedAt === "number"
				? Math.max(
						0,
						(message.timestamp -
							previous.endedAt -
							suspendedMs(clockJumps, previous.endedAt, message.timestamp)) /
							1000,
					)
				: undefined;
		const request = {
			index,
			model,
			prompt,
			cacheRead,
			reuse: cacheRead / prompt,
			wipe,
			miss: cacheRead < MISS_MAX_CACHE_READ,
			ttft,
			idleSeconds,
			cost: usage.cost?.total ?? 0,
			group: triggerGroup(between),
			between: [...between],
			promptRatio: previous ? prompt / previous.prompt : 1,
		};
		requests.push(request);
		previous = { model, prompt, endedAt: message.streamEndAt ?? message.timestamp };
		between = [];
	});
	const legendRecord = records.get("path_alias_legend");
	const hostRecordChars = HOST_RECORD_KINDS.reduce((sum, kind) => sum + (records.get(kind)?.chars ?? 0), 0);
	return {
		runtimeVersion,
		requests,
		records: [...records].map(([kind, record]) => ({
			kind,
			count: record.count,
			chars: record.chars,
			maxChars: record.maxChars,
			distinct: record.distinct.size,
		})),
		toolResultChars,
		assistantChars,
		hostRecordChars,
		hostRecordCharsShare: toolResultChars > 0 ? hostRecordChars / toolResultChars : 0,
		legendCopies: legendRecord?.count ?? 0,
		/** Total legend bytes over the largest single legend: 1 means the table was sent once. */
		legendBytesRatio: legendRecord && legendRecord.maxChars > 0 ? legendRecord.chars / legendRecord.maxChars : 0,
		compactions,
		compactionFallbacks,
	};
}

export function summarize(requests) {
	const ttfts = requests.map((r) => r.ttft).filter((v) => typeof v === "number");
	return {
		n: requests.length,
		p50Reuse: median(requests.map((r) => r.reuse)),
		shareHigh: requests.length ? requests.filter((r) => r.reuse >= 0.9).length / requests.length : Number.NaN,
		wipes: requests.filter((r) => r.wipe).length,
		misses: requests.filter((r) => r.miss).length,
		ttftP50: quantile(ttfts, 0.5),
		ttftP90: quantile(ttfts, 0.9),
		cost: requests.reduce((sum, r) => sum + r.cost, 0),
		maxPrompt: requests.reduce((max, r) => Math.max(max, r.prompt), 0),
		p50PromptRatio: median(requests.map((r) => r.promptRatio)),
	};
}

export function groupSummaries(requests) {
	const groups = new Map();
	for (const request of requests) {
		const list = groups.get(request.group) ?? [];
		list.push(request);
		groups.set(request.group, list);
	}
	return [...groups].map(([group, list]) => ({ group, ...summarize(list) }));
}

/** Evaluate gate thresholds against one census. Returns the failing checks (empty = pass). */
export function evaluateGate(census, thresholds) {
	const failures = [];
	const groups = new Map(groupSummaries(census.requests).map((g) => [g.group, g]));
	const toolLoop = groups.get("tool_loop");
	if (thresholds.toolLoopP50Reuse !== undefined && toolLoop && toolLoop.p50Reuse < thresholds.toolLoopP50Reuse) {
		failures.push(`tool_loop p50 reuse ${toolLoop.p50Reuse.toFixed(2)} < ${thresholds.toolLoopP50Reuse}`);
	}
	const userTurn = groups.get("user_turn");
	if (thresholds.userTurnP50Reuse !== undefined && userTurn && userTurn.p50Reuse < thresholds.userTurnP50Reuse) {
		failures.push(`user_turn p50 reuse ${userTurn.p50Reuse.toFixed(2)} < ${thresholds.userTurnP50Reuse}`);
	}
	if (thresholds.hostRecordCharsShare !== undefined && census.hostRecordCharsShare > thresholds.hostRecordCharsShare) {
		failures.push(`host record chars share ${census.hostRecordCharsShare.toFixed(2)} > ${thresholds.hostRecordCharsShare}`);
	}
	if (thresholds.legendBytesRatio !== undefined && census.legendBytesRatio > thresholds.legendBytesRatio) {
		failures.push(`legend bytes ratio ${census.legendBytesRatio.toFixed(2)} > ${thresholds.legendBytesRatio}`);
	}
	if (thresholds.compactionFallbacks !== undefined && census.compactionFallbacks > thresholds.compactionFallbacks) {
		failures.push(`compaction fallbacks ${census.compactionFallbacks} > ${thresholds.compactionFallbacks}`);
	}
	return failures;
}

const fmt = (value, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : "-");

function printSummaryRow(label, summary) {
	console.log(
		`${label.padEnd(44)} ${String(summary.n).padStart(5)} ${fmt(summary.p50Reuse).padStart(6)} ${fmt(summary.shareHigh).padStart(6)} ${String(summary.wipes).padStart(5)} ${String(summary.misses).padStart(6)} ${fmt(summary.ttftP50, 1).padStart(7)} ${fmt(summary.ttftP90, 1).padStart(7)} ${fmt(summary.cost).padStart(8)} ${String(summary.maxPrompt).padStart(9)}`,
	);
}

// --- Cache survival (`--survival`) -------------------------------------------------------------

/**
 * Replay one session's entries into cache observations (the rows the decision ledger records live)
 * plus the facts the survival census learns from: each request's lineage (the compaction it follows),
 * the wall-clock gap and who held the lane during it, and the measured per-token prices. Gaps are wall
 * time, clock jumps included: the provider's cache ages while the host sleeps. A request's prefix is
 * intact or not per the request snapshot recorded just before it on the same lane; sessions recorded
 * before snapshots carried it replay as `unknown` (lower confidence).
 */
export function survivalEntries(entries) {
	const observations = [];
	const requests = [];
	const lanes = new Map();
	let snapshot;
	let lineage = "root";
	let between = [];
	let lastPrompt;
	let pendingCompaction;
	const compactionRatios = [];
	for (const entry of entries) {
		if (entry.type === "request_snapshot") {
			snapshot = entry;
			continue;
		}
		if (entry.type === "compaction") {
			lineage = entry.id ?? `compaction@${entry.timestamp}`;
			pendingCompaction = lastPrompt !== undefined ? { output: entry.usage?.output } : undefined;
			between.push("compaction");
			continue;
		}
		if (entry.type !== "message") {
			between.push(recordKind(entry));
			continue;
		}
		const message = entry.message ?? {};
		if (message.role !== "assistant") {
			between.push(message.role === "user" ? "user" : message.role === "toolResult" ? "toolResult" : recordKind(entry));
			continue;
		}
		const usage = message.usage ?? {};
		const cacheRead = usage.cacheRead ?? 0;
		const prompt = (usage.input ?? 0) + cacheRead + (usage.cacheWrite ?? 0);
		if (prompt <= 0 || typeof message.timestamp !== "number") {
			between = [];
			continue;
		}
		const lane = cacheLaneKey(message.api ?? "?", message.provider ?? "?", message.model ?? "?");
		const previous = lanes.get(lane);
		const matched =
			snapshot && cacheLaneKey(snapshot.api, snapshot.provider, snapshot.modelId) === lane ? snapshot : undefined;
		const prefixIntact =
			matched?.prefixIntact === true ? "true" : matched?.prefixIntact === false ? "false" : "unknown";
		const gapMs = previous ? Math.max(0, message.timestamp - previous.endedAt) : undefined;
		const retained = previous && previous.prompt > 0 ? Math.min(1, Math.max(0, cacheRead / previous.prompt)) : undefined;
		const observation = {
			lane,
			observedAt: message.timestamp,
			promptTokens: prompt,
			cacheReadTokens: cacheRead,
			prefixIntact,
			...(gapMs !== undefined ? { gapMs } : {}),
			...(retained !== undefined ? { retained } : {}),
		};
		observations.push(observation);
		if (pendingCompaction && lastPrompt > 0) {
			compactionRatios.push({
				lane,
				ratio: prompt / lastPrompt,
				...(typeof pendingCompaction.output === "number" ? { outputRatio: pendingCompaction.output / lastPrompt } : {}),
			});
		}
		pendingCompaction = undefined;
		requests.push({
			observation,
			lineage,
			holder: between.includes("user") ? "owner" : between.includes("toolResult") ? "tool" : "host",
			previousPrompt: previous?.prompt,
			cost: usage.cost ?? {},
			usage,
		});
		lanes.set(lane, { prompt, endedAt: message.streamEndAt ?? message.timestamp });
		lastPrompt = prompt;
		snapshot = undefined;
		between = [];
	}
	return { observations, requests, compactionRatios };
}

/** Per-token USD a lane was actually billed, from the usage records' own cost split. */
function measuredPrices(requests) {
	const totals = new Map();
	for (const { observation, usage, cost } of requests) {
		const t = totals.get(observation.lane) ?? { input: [0, 0], cacheRead: [0, 0], cacheWrite: [0, 0], output: [0, 0] };
		for (const key of ["input", "cacheRead", "cacheWrite", "output"]) {
			if ((usage[key] ?? 0) > 0 && typeof cost[key] === "number") {
				t[key][0] += cost[key];
				t[key][1] += usage[key];
			}
		}
		totals.set(observation.lane, t);
	}
	const prices = new Map();
	for (const [lane, t] of totals) {
		const per = (key) => (t[key][1] > 0 ? t[key][0] / t[key][1] : undefined);
		prices.set(lane, { input: per("input"), cacheRead: per("cacheRead"), cacheWrite: per("cacheWrite"), output: per("output") });
	}
	return prices;
}

export const SURVIVAL_GRID = {
	halfLifeMs: [Number.POSITIVE_INFINITY, 30 * 86_400_000, 7 * 86_400_000, 86_400_000],
	poolingWeight: [1, 4, 16],
	binsPerDecade: [2, 4, 8],
};

/**
 * Choose the survival settings that best predict held-out requests: fit on every observation before
 * the time cutoff (the 80th percentile of measuring observations), score the squared error of the
 * predicted retained share on the ones after it. A gap the curve has no evidence for is predicted at
 * the training mean, so a setting cannot win by declining to predict.
 */
export function calibrateSurvival(observations, grid = SURVIVAL_GRID) {
	const measuring = observations
		.filter((o) => o.prefixIntact !== "false" && typeof o.gapMs === "number" && typeof o.retained === "number")
		.sort((a, b) => a.observedAt - b.observedAt);
	if (measuring.length < 2) return undefined;
	const cutoff = measuring[Math.floor(measuring.length * 0.8)].observedAt;
	const train = observations.filter((o) => o.observedAt < cutoff);
	const test = measuring.filter((o) => o.observedAt >= cutoff);
	const trainMeasuring = measuring.filter((o) => o.observedAt < cutoff);
	if (trainMeasuring.length === 0 || test.length === 0) return undefined;
	const trainMean = trainMeasuring.reduce((sum, o) => sum + o.retained, 0) / trainMeasuring.length;
	const testLanes = [...new Set(test.map((o) => o.lane))];
	const results = [];
	for (const halfLifeMs of grid.halfLifeMs) {
		for (const poolingWeight of grid.poolingWeight) {
			for (const binsPerDecade of grid.binsPerDecade) {
				const settings = { halfLifeMs, poolingWeight, binsPerDecade };
				const curves = new Map(testLanes.map((lane) => [lane, survivalCurve(train, lane, settings, cutoff)]));
				let squared = 0;
				let covered = 0;
				for (const o of test) {
					const predicted = predictRetained(curves.get(o.lane), o.gapMs, binsPerDecade);
					if (predicted !== undefined) covered++;
					squared += ((predicted ?? trainMean) - o.retained) ** 2;
				}
				results.push({ settings, mse: squared / test.length, coverage: covered / test.length });
			}
		}
	}
	results.sort((a, b) => a.mse - b.mse);
	return { best: results[0], results, train: train.length, test: test.length, baselineMse: test.reduce((s, o) => s + (trainMean - o.retained) ** 2, 0) / test.length };
}

export function survivalCensus(files) {
	const observations = [];
	const requests = [];
	const compactionRatios = [];
	const episodes = [];
	for (const file of files) {
		const replay = survivalEntries(parseSessionEntries(file));
		observations.push(...replay.observations);
		// Lineage ids are only unique within their session.
		requests.push(...replay.requests.map((request) => ({ ...request, lineage: `${file}\u0000${request.lineage}` })));
		compactionRatios.push(...replay.compactionRatios);
		// A replayed session's history is finished: its last lineage ended with the session.
		episodes.push(...lineageEpisodes(replay.requests.map((request) => request.lineage), false));
	}
	return { observations, requests, compactionRatios, episodes };
}

/**
 * What pricing each owner-held resume with `priceCompaction` (the early-compaction policy, on the
 * session lane) would have saved on the recorded history, in the lanes' own billed prices: where the
 * price, taken with the learned lineage lifetime and the curve's share at the real gap, says compacting
 * pays, the realized saving is the same price with the lineage's actual length and the share the
 * provider actually served. Only a lineage's first compaction is priced: after it, the recorded history
 * is no longer the one the policy would have continued on.
 */
export function coldResumeCounterfactual(census, curves, settings, outcome) {
	const prices = measuredPrices(census.requests);
	let coldPaidUsd = 0;
	let resumes = 0;
	let compacted = 0;
	let policyNetUsd = 0;
	const compactedLineages = new Set();
	const byLineage = new Map();
	census.requests.forEach((request, index) => {
		const list = byLineage.get(request.lineage) ?? [];
		list.push(index);
		byLineage.set(request.lineage, list);
	});
	census.requests.forEach((request, index) => {
		const o = request.observation;
		if (o.gapMs === undefined || request.previousPrompt === undefined || request.holder !== "owner") return;
		const price = prices.get(o.lane);
		const cold = price?.cacheWrite ?? price?.input;
		if (!price || cold === undefined || price.cacheRead === undefined || price.output === undefined) return;
		resumes++;
		if ((o.retained ?? 0) < 0.5) coldPaidUsd += (o.promptTokens - o.cacheReadTokens) * cold;
		if (compactedLineages.has(request.lineage)) return;
		const lineage = byLineage.get(request.lineage) ?? [];
		const position = lineage.indexOf(index);
		const base = {
			prefixTokens: request.previousPrompt,
			compactedTokens: request.previousPrompt * outcome.afterRatio,
			summaryOutputTokens: request.previousPrompt * outcome.outputRatio,
			summarizerSharesLane: true,
			cacheReadUsdPerMillion: price.cacheRead * 1e6,
			coldUsdPerMillion: cold * 1e6,
			outputUsdPerMillion: price.output * 1e6,
		};
		const retained = predictRetainedWithError(curves.get(o.lane), o.gapMs, settings.binsPerDecade);
		const expected = priceCompaction({
			...base,
			remainingRequests: Math.max(1, medianRemainingRequests(census.episodes, position) ?? position),
			...(retained ? { retained } : {}),
		});
		if (!expected.proceed) return;
		compacted++;
		compactedLineages.add(request.lineage);
		const actual = priceCompaction({
			...base,
			remainingRequests: lineage.length - position,
			retained: { retained: o.retained ?? 0, standardError: 0 },
		});
		policyNetUsd += actual.savingUsd ?? 0;
	});
	return { resumes, compacted, coldPaidUsd, policyNetUsd };
}

function runSurvival(targets, writeCalibration) {
	const files = targets.flatMap(listSessionFiles);
	const census = survivalCensus(files);
	const calibration = calibrateSurvival(census.observations);
	if (!calibration) {
		console.log("survival: not enough measuring observations to calibrate");
		return;
	}
	const { settings } = calibration.best;
	const now = Math.max(...census.observations.map((o) => o.observedAt));
	const lanes = [...new Set(census.observations.map((o) => o.lane))];
	const curves = new Map(lanes.map((lane) => [lane, survivalCurve(census.observations, lane, settings, now)]));
	const unknownShare =
		census.observations.filter((o) => o.prefixIntact === "unknown").length / Math.max(1, census.observations.length);
	console.log(
		`survival: ${files.length} sessions, ${census.observations.length} observations (${fmt(unknownShare)} without prefix tracking: lower confidence), ${lanes.length} lanes`,
	);
	console.log(
		`calibration: halfLife=${Number.isFinite(settings.halfLifeMs) ? `${settings.halfLifeMs / 86_400_000}d` : "inf"} pooling=${settings.poolingWeight} binsPerDecade=${settings.binsPerDecade} held-out mse=${calibration.best.mse.toFixed(4)} (training-mean baseline ${calibration.baselineMse.toFixed(4)}) coverage=${fmt(calibration.best.coverage)} train=${calibration.train} test=${calibration.test}`,
	);
	for (const [lane, curve] of [...curves].sort((a, b) => b[1].laneObservations - a[1].laneObservations)) {
		const { api, provider, modelId } = laneParts(lane);
		const points = curve.bins
			.filter((bin) => bin.retained !== undefined && bin.source !== "none")
			.map((bin) => `${formatGap(bin.toMs)}:${fmt(bin.retained)}${bin.source === "lane" ? "" : `(${bin.source[0]})`}`)
			.join(" ");
		console.log(`  ${`${provider}/${modelId} [${api}]`.padEnd(58)} n=${String(curve.laneObservations).padStart(5)} minCache=${curve.minCacheableTokens ?? "-"}  ${points}`);
	}
	const ratios = census.compactionRatios.map((r) => r.ratio);
	const summaryRatio = median(ratios);
	const outputRatio = median(census.compactionRatios.map((r) => r.outputRatio).filter((v) => typeof v === "number"));
	const ended = census.episodes.filter((e) => e.ended).map((e) => e.requests);
	console.log(
		`lineages: ${census.episodes.length} (median ${fmt(median(ended), 0)} requests, p90 ${fmt(quantile(ended, 0.9), 0)}); prompt after compaction over before: median ${fmt(summaryRatio)} over ${ratios.length}`,
	);
	console.log(
		`  median remaining requests given elapsed: ${[1, 5, 20, 50, 100, 200].map((e) => `${e}:${medianRemainingRequests(census.episodes, e) ?? "-"}`).join(" ")}`,
	);
	for (const holder of ["owner", "tool", "host"]) {
		const gaps = census.requests.filter((r) => r.holder === holder && r.observation.gapMs !== undefined).map((r) => r.observation.gapMs);
		console.log(`  return gap held by ${holder.padEnd(5)} n=${String(gaps.length).padStart(5)} p50=${formatGap(quantile(gaps, 0.5))} p90=${formatGap(quantile(gaps, 0.9))}`);
	}
	if (Number.isFinite(summaryRatio) && Number.isFinite(outputRatio)) {
		const counterfactual = coldResumeCounterfactual(census, curves, settings, { afterRatio: summaryRatio, outputRatio });
		console.log(
			`owner resumes: ${counterfactual.resumes}, cold prefill paid on them ${fmt(counterfactual.coldPaidUsd)} USD; the priced policy compacts ${counterfactual.compacted} and nets ${fmt(counterfactual.policyNetUsd)} USD (in-sample curve; summary output ${fmt(outputRatio, 3)} of the prompt)`,
		);
	}
	if (writeCalibration) {
		const evidence = `${files.length} sessions, ${census.observations.length} observations, held-out mse ${calibration.best.mse.toFixed(4)} vs ${calibration.baselineMse.toFixed(4)} baseline, coverage ${fmt(calibration.best.coverage)}`;
		writeFileSync(writeCalibration, renderCalibrationModule(settings, evidence));
		console.log(`wrote ${writeCalibration}`);
	}
}

function renderCalibrationModule(settings, evidence) {
	const halfLife = Number.isFinite(settings.halfLifeMs) ? String(settings.halfLifeMs) : "Number.POSITIVE_INFINITY";
	return `import type { SurvivalSettings } from "./cache-survival.ts";

/**
 * Survival estimator settings chosen by \`node scripts/session-reuse-census.mjs --survival
 * --write-calibration <this file> <sessions>\`: the grid point that best predicted held-out requests.
 * Generated; rerun the census to recalibrate.
 *
 * Evidence: ${evidence}.
 */
export const CACHE_SURVIVAL_CALIBRATION: SurvivalSettings = {
	halfLifeMs: ${halfLife},
	poolingWeight: ${settings.poolingWeight},
	binsPerDecade: ${settings.binsPerDecade},
};
`;
}

function formatGap(ms) {
	if (!Number.isFinite(ms)) return "-";
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
	if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
	return `${(ms / 86_400_000).toFixed(1)}d`;
}

function main(argv) {
	const options = { byModel: false, wipes: false, records: false, survival: false, writeCalibration: undefined, gate: undefined, targets: [] };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--by-model") options.byModel = true;
		else if (arg === "--wipes") options.wipes = true;
		else if (arg === "--records") options.records = true;
		else if (arg === "--survival") options.survival = true;
		else if (arg === "--write-calibration") options.writeCalibration = argv[++index];
		else if (arg === "--gate") options.gate = { ...DEFAULT_GATE, ...JSON.parse(argv[++index] ?? "{}") };
		else if (arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`);
		else options.targets.push(arg);
	}
	if (options.targets.length === 0) {
		console.error("usage: node scripts/session-reuse-census.mjs <dir|file>... [--by-model] [--wipes] [--records] [--gate json] [--survival [--write-calibration file]]");
		process.exit(2);
	}
	if (options.survival) {
		runSurvival(options.targets, options.writeCalibration);
		return;
	}
	const header = `${"session".padEnd(44)} ${"n".padStart(5)} ${"p50".padStart(6)} ${">=.9".padStart(6)} ${"wipes".padStart(5)} ${"misses".padStart(6)} ${"ttft50".padStart(7)} ${"ttft90".padStart(7)} ${"cost$".padStart(8)} ${"maxPrompt".padStart(9)}`;
	console.log(header);
	let gateFailed = false;
	for (const file of options.targets.flatMap(listSessionFiles)) {
		const census = censusEntries(parseSessionEntries(file));
		if (census.requests.length === 0) continue;
		const name = `${path.basename(file).slice(0, 16)} ${census.runtimeVersion ?? "?"}`;
		printSummaryRow(name, summarize(census.requests));
		if (options.byModel) {
			const byModel = new Map();
			for (const request of census.requests) {
				const list = byModel.get(request.model) ?? [];
				list.push(request);
				byModel.set(request.model, list);
			}
			for (const [model, list] of byModel) printSummaryRow(`  ${model}`, summarize(list));
		}
		for (const group of groupSummaries(census.requests)) {
			printSummaryRow(`  ${group.group} (ratio ${fmt(group.p50PromptRatio)})`, group);
		}
		if (options.wipes) {
			for (const request of census.requests.filter((r) => r.wipe)) {
				console.log(
					`    wipe@${request.index} prompt=${request.prompt} cacheRead=${request.cacheRead} idle=${fmt(request.idleSeconds, 0)}s ttft=${fmt(request.ttft, 1)}s between=${request.between.join(" ")}`,
				);
			}
		}
		if (options.records) {
			console.log(
				`    toolResult chars=${census.toolResultChars} assistant chars=${census.assistantChars} host records=${census.hostRecordChars} (${fmt(census.hostRecordCharsShare)} of tool output) legend bytes ratio=${fmt(census.legendBytesRatio)} compaction fallbacks=${census.compactionFallbacks}`,
			);
			for (const record of census.records.sort((a, b) => b.chars - a.chars)) {
				console.log(
					`    ${record.kind.padEnd(30)} n=${String(record.count).padStart(4)} chars=${String(record.chars).padStart(9)} distinct=${String(record.distinct).padStart(4)} max=${record.maxChars}`,
				);
			}
		}
		if (options.gate) {
			const failures = evaluateGate(census, options.gate);
			for (const failure of failures) console.log(`    GATE FAIL ${failure}`);
			if (failures.length > 0) gateFailed = true;
		}
	}
	if (gateFailed) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2));
}
