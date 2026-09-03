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
 * over 10,000 tokens). Reads session files only; never writes.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

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
	entries.forEach((entry, index) => {
		if (entry.type === "compaction") compactions += 1;
		if (entry.type === "compaction_end" && entry.outcome === "fallback") compactionFallbacks += 1;
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
				? (message.firstTokenAt - message.timestamp) / 1000
				: undefined;
		const idleSeconds =
			previous && typeof message.timestamp === "number" && typeof previous.endedAt === "number"
				? Math.max(0, (message.timestamp - previous.endedAt) / 1000)
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

function main(argv) {
	const options = { byModel: false, wipes: false, records: false, gate: undefined, targets: [] };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--by-model") options.byModel = true;
		else if (arg === "--wipes") options.wipes = true;
		else if (arg === "--records") options.records = true;
		else if (arg === "--gate") options.gate = { ...DEFAULT_GATE, ...JSON.parse(argv[++index] ?? "{}") };
		else if (arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`);
		else options.targets.push(arg);
	}
	if (options.targets.length === 0) {
		console.error("usage: node scripts/session-reuse-census.mjs <dir|file>... [--by-model] [--wipes] [--records] [--gate json]");
		process.exit(2);
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
