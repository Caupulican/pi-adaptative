#!/usr/bin/env node

import path from "node:path";
import {
	assistantRecordIdentity,
	assistantToolCalls,
	DEFAULT_SESSIONS_DIR,
	escapeHtml,
	formatInt,
	formatPartPercent as formatPercent,
	formatReportDay as formatDay,
	getReportTimeZoneParts,
	groupBy,
	median,
	parseSessionStatsArgs,
	REPORT_TIME_ZONE,
	runMain,
	runToolStatsCli,
	scanSessionJsonl,
	sessionScanHeaderLines,
} from "./session-stats-common.mjs";

const DEFAULT_ACTIVE_READ_TOOL_PATH = path.join(process.cwd(), "packages/coding-agent/src/core/tools/read.ts");
const DEFAULT_TOP = 20;
const CHART_WIDTH = 40;

function parseArgs(argv) {
	const options = {
		sessionsDir: DEFAULT_SESSIONS_DIR,
		json: false,
		text: false,
		includeRecords: false,
		modelFilter: undefined,
		top: DEFAULT_TOP,
		help: false,
		allSessions: false,
		since: undefined,
		autoSincePath: DEFAULT_ACTIVE_READ_TOOL_PATH,
		bucket: "week",
	};
	return parseSessionStatsArgs(argv, options, parseReadStatsArg);
}

function parseReadStatsArg(arg, index, argv, options) {
	if (arg === "--include-records") options.includeRecords = true;
	else if (arg === "--model") options.modelFilter = argv[++index];
	else if (arg === "--top") {
		const value = Number.parseInt(argv[++index] ?? "", 10);
		if (!Number.isFinite(value) || value <= 0) throw new Error("--top must be a positive integer");
		options.top = value;
	} else if (arg === "--auto-since-path") options.autoSincePath = argv[++index];
	else if (arg === "--bucket") {
		const value = argv[++index];
		if (value !== "day" && value !== "week") throw new Error("--bucket must be day or week");
		options.bucket = value;
	} else return null;
	return index;
}

function printHelp() {
	console.log(`Usage: node scripts/read-tool-stats.mjs [options]

Options:
  --sessions-dir <path>  Sessions directory (default: ~/.pi/agent/sessions)
  --model <substring>    Filter provider/model by substring
  --top <n>              Number of examples to show (default: ${DEFAULT_TOP})
  --since <iso>          Only scan session files created at or after this ISO time
  --all-sessions         Disable the automatic since filter
  --auto-since-path <p>  Use birth time of this file for the automatic since filter
  --bucket <day|week>    Time bucket for trend chart (default: week)
  --json                 Print JSON summary instead of HTML report
  --text                 Print plain text report instead of HTML
  --include-records      Include raw records in JSON output
  -h, --help             Show this help
`);
}

function formatIso(ms) {
	return new Date(ms).toISOString();
}

function startOfReportTimeZoneWeek(ms) {
	const parts = getReportTimeZoneParts(ms);
	const dayIndex = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday ?? "Mon");
	const localMidnightAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
	return localMidnightAsUtc - Math.max(dayIndex, 0) * 24 * 60 * 60 * 1000;
}

function getTimeBucket(ms, bucket) {
	if (!Number.isFinite(ms)) return "[unknown]";
	if (bucket === "day") return formatDay(ms);
	return formatDay(startOfReportTimeZoneWeek(ms));
}

function getHourOfDayBucket(ms) {
	if (!Number.isFinite(ms)) return "[unknown]";
	return `${getReportTimeZoneParts(ms).hour}:00`;
}

function formatRate(value) {
	return Number.isFinite(value) ? value.toFixed(2) : "n/a";
}

function bar(part, total) {
	const filled = total === 0 ? 0 : Math.round((part / total) * CHART_WIDTH);
	return `${"█".repeat(filled)}${"░".repeat(CHART_WIDTH - filled)}`;
}

function classifyRead(args) {
	const normalizedArgs = args && typeof args === "object" ? args : {};
	const hasOffset = Object.hasOwn(normalizedArgs, "offset") && normalizedArgs.offset !== undefined && normalizedArgs.offset !== null;
	const hasLimit = Object.hasOwn(normalizedArgs, "limit") && normalizedArgs.limit !== undefined && normalizedArgs.limit !== null;
	return {
		path: typeof normalizedArgs.path === "string" ? normalizedArgs.path : "",
		offset: hasOffset ? normalizedArgs.offset : null,
		limit: hasLimit ? normalizedArgs.limit : null,
		mode: hasOffset || hasLimit ? "partial" : "full",
	};
}

function summarizeTimeBuckets(records, bucket) {
	return summarizeGroups(records, (record) => getTimeBucket(record.timestampMs, bucket)).sort((a, b) => a.key.localeCompare(b.key));
}

function summarizeNormalizedTimeBuckets(records, bucket) {
	return summarizeNormalizedTimeBucketsByKey(records, (record) => getTimeBucket(record.timestampMs, bucket));
}

function summarizeNormalizedTimeBucketsByKey(records, keyFn) {
	return [...groupBy(records, keyFn).entries()]
		.map(([key, bucketRecords]) => {
			const sessionGroups = groupBy(bucketRecords, (record) => record.sessionFile);
			const sessions = [...sessionGroups.values()].map((sessionRecords) => {
				const full = sessionRecords.filter((record) => record.mode === "full").length;
				const partial = sessionRecords.length - full;
				return { reads: sessionRecords.length, full, partial, partialRate: sessionRecords.length === 0 ? null : partial / sessionRecords.length };
			});
			const reads = bucketRecords.length;
			const full = bucketRecords.filter((record) => record.mode === "full").length;
			const partial = reads - full;
			const sessionCount = sessions.length;
			const medianSessionPartialRate = median(sessions.map((session) => session.partialRate));
			return {
				key,
				sessions: sessionCount,
				reads,
				full,
				partial,
				readsPerSession: sessionCount === 0 ? null : reads / sessionCount,
				fullPerSession: sessionCount === 0 ? null : full / sessionCount,
				partialPerSession: sessionCount === 0 ? null : partial / sessionCount,
				medianSessionPartialRate,
			};
		})
		.sort((a, b) => a.key.localeCompare(b.key));
}

function summarizeGroups(records, keyFn) {
	return [...groupBy(records, keyFn).entries()]
		.map(([key, group]) => {
			const full = group.filter((record) => record.mode === "full").length;
			const partial = group.length - full;
			const assistantMessages = new Set(group.map((record) => `${record.sessionFile}::${record.assistantEntryId}`)).size;
			return { key, reads: group.length, assistantMessages, full, partial, fullRate: group.length === 0 ? null : full / group.length, partialRate: group.length === 0 ? null : partial / group.length };
		})
		.sort((a, b) => b.reads - a.reads || a.key.localeCompare(b.key));
}

function buildSummary(records, meta, options) {
	const full = records.filter((record) => record.mode === "full").length;
	const partial = records.length - full;
	const providerStats = summarizeGroups(records, (record) => record.providerModel);
	const timeStats = summarizeTimeBuckets(records, options.bucket);
	const normalizedTimeStats = summarizeNormalizedTimeBuckets(records, options.bucket);
	const timeOfDayStats = summarizeGroups(records, (record) => getHourOfDayBucket(record.timestampMs)).sort((a, b) => a.key.localeCompare(b.key));
	const normalizedTimeOfDayStats = summarizeNormalizedTimeBucketsByKey(records, (record) => getHourOfDayBucket(record.timestampMs));
	const timeStatsByProvider = providerStats.map((provider) => ({
		providerModel: provider.key,
		...provider,
		timeStats: summarizeTimeBuckets(
			records.filter((record) => record.providerModel === provider.key),
			options.bucket
		),
		normalizedTimeStats: summarizeNormalizedTimeBuckets(
			records.filter((record) => record.providerModel === provider.key),
			options.bucket
		),
		timeOfDayStats: summarizeGroups(
			records.filter((record) => record.providerModel === provider.key),
			(record) => getHourOfDayBucket(record.timestampMs)
		).sort((a, b) => a.key.localeCompare(b.key)),
		normalizedTimeOfDayStats: summarizeNormalizedTimeBucketsByKey(
			records.filter((record) => record.providerModel === provider.key),
			(record) => getHourOfDayBucket(record.timestampMs)
		),
	}));
	return {
		filters: { model: options.modelFilter ?? null, bucket: options.bucket },
		scan: {
			sessionsDir: meta.sessionsDir,
			sessionFilesScanned: meta.sessionFilesScanned,
			sessionFilesIncluded: meta.sessionFilesIncluded,
			sessionFilesSkippedOlderThanSince: meta.sessionFilesSkippedOlderThanSince,
			sessionFilesWithReadCalls: meta.sessionFilesWithReadCalls,
			since: meta.since ? { ms: meta.since.ms, iso: formatIso(meta.since.ms), source: meta.since.source } : null,
			malformedLines: meta.malformedLines,
		},
		counts: {
			assistantMessagesWithReadCalls: new Set(records.map((record) => `${record.sessionFile}::${record.assistantEntryId}`)).size,
			totalReadCalls: records.length,
			full,
			partial,
			fullRate: records.length === 0 ? null : full / records.length,
			partialRate: records.length === 0 ? null : partial / records.length,
		},
		providerStats,
		timeStats,
		normalizedTimeStats,
		timeOfDayStats,
		normalizedTimeOfDayStats,
		timeStatsByProvider,
		examples: records.slice(0, options.top),
	};
}

function buildHumanReport(summary) {
	const lines = [];
	const originalLog = console.log;
	console.log = (line = "") => lines.push(String(line));
	try {
		printHumanReport(summary);
	} finally {
		console.log = originalLog;
	}
	return lines.join("\n") + "\n";
}

function printHtmlReport(summary) {
	const text = buildHumanReport(summary);
	console.log(`<!doctype html>
<meta charset="utf-8">
<title>Read tool stats</title>
<style>
body { margin: 24px; background: #fff; color: #111; }
pre { font: 13px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; }
</style>
<pre>${escapeHtml(text)}</pre>`);
}

function printReadGroups(groups, indent) {
	for (const group of groups) {
		console.log(
			`${indent}${group.key} reads=${formatInt(group.reads).padStart(5)} full=${formatPercent(group.full, group.reads).padStart(6)} partial=${formatPercent(group.partial, group.reads).padStart(6)} ${bar(group.partial, group.reads)}`,
		);
	}
}

function printNormalizedReadGroups(groups, indent) {
	for (const group of groups) {
		console.log(
			`${indent}${group.key} sessions=${formatInt(group.sessions).padStart(4)} reads/session=${formatRate(group.readsPerSession).padStart(5)} full/session=${formatRate(group.fullPerSession).padStart(5)} partial/session=${formatRate(group.partialPerSession).padStart(5)} medianSessionPartial=${group.medianSessionPartialRate === null ? "n/a" : formatPercent(group.medianSessionPartialRate, 1).padStart(6)} ${bar(group.medianSessionPartialRate ?? 0, 1)}`,
		);
	}
}

function printHumanReport(summary) {
	const { scan, counts, timeStats, normalizedTimeStats, timeOfDayStats, normalizedTimeOfDayStats, timeStatsByProvider, filters } = summary;
	for (const line of sessionScanHeaderLines(scan)) console.log(line);
	console.log(`Report timezone: ${REPORT_TIME_ZONE} (CET/CEST)`);
	console.log(`Found ${formatInt(counts.totalReadCalls)} read tool calls in ${formatInt(counts.assistantMessagesWithReadCalls)} assistant messages`);
	if (filters.model) console.log(`Filters: model contains "${filters.model}"`);

	console.log("\nFull vs partial reads");
	console.log(`  full:    ${formatInt(counts.full).padStart(8)}  ${formatPercent(counts.full, counts.totalReadCalls).padStart(6)}  ${bar(counts.full, counts.totalReadCalls)}`);
	console.log(`  partial: ${formatInt(counts.partial).padStart(8)}  ${formatPercent(counts.partial, counts.totalReadCalls).padStart(6)}  ${bar(counts.partial, counts.totalReadCalls)}`);

	console.log(`\nBy ${filters.bucket}`);
	printReadGroups(timeStats, "  ");

	console.log("\nBy time of day");
	printReadGroups(timeOfDayStats, "  ");

	console.log("\nBy time of day, session-normalized");
	printNormalizedReadGroups(normalizedTimeOfDayStats, "  ");

	console.log(`\nBy ${filters.bucket}, session-normalized`);
	printNormalizedReadGroups(normalizedTimeStats, "  ");

	console.log(`\nBy provider/model, then by ${filters.bucket}`);
	for (const group of timeStatsByProvider) {
		console.log(`\n${group.providerModel}`);
		console.log(`  total reads=${formatInt(group.reads)} assistantMessages=${formatInt(group.assistantMessages)}`);
		console.log(`  total full    ${formatInt(group.full).padStart(8)} ${formatPercent(group.full, group.reads).padStart(6)} ${bar(group.full, group.reads)}`);
		console.log(`  total partial ${formatInt(group.partial).padStart(8)} ${formatPercent(group.partial, group.reads).padStart(6)} ${bar(group.partial, group.reads)}`);
		console.log(`  By ${filters.bucket}`);
		printReadGroups(group.timeStats, "    ");
		console.log(`  By ${filters.bucket}, session-normalized`);
		printNormalizedReadGroups(group.normalizedTimeStats, "    ");
		console.log("  By time of day");
		printReadGroups(group.timeOfDayStats, "    ");
		console.log("  By time of day, session-normalized");
		printNormalizedReadGroups(group.normalizedTimeOfDayStats, "    ");
	}

	if (scan.malformedLines > 0) {
		console.log("\nParser notes");
		console.log(`  malformed lines skipped: ${formatInt(scan.malformedLines)}`);
	}
}

async function scanSessions(sessionsDir, since) {
	const records = [];
	let sessionFilesWithReadCalls = 0;
	const { meta } = await scanSessionJsonl({
		sessionsDir,
		sinceMs: since?.ms ?? null,
		createSession: () => ({ fileHadReadCall: false }),
		onEntry: (entry, session, sessionFile, sessionTimestampMs) => {
			if (entry?.type !== "message" || !entry.message) return;
			const message = entry.message;
			for (const block of assistantToolCalls(message)) {
				if (block?.type !== "toolCall" || block.name !== "read") continue;
				session.fileHadReadCall = true;
				records.push({
					sessionFile,
					toolCallId: typeof block.id === "string" ? block.id : "",
					timestampMs: Date.parse(entry.timestamp) || sessionTimestampMs || 0,
					...assistantRecordIdentity(entry, message),
					...classifyRead(block.arguments),
				});
			}
		},
		onSessionEnd: (session) => {
			if (session.fileHadReadCall) sessionFilesWithReadCalls++;
		},
	});
	return { records, meta: { ...meta, sessionFilesWithReadCalls, since } };
}

function applyFilters(records, options) {
	return records.filter((record) => !options.modelFilter || record.providerModel.toLowerCase().includes(options.modelFilter.toLowerCase()));
}

function printRun({ options, records, summary }) {
	if (options.json) {
		console.log(JSON.stringify(options.includeRecords ? { summary, records } : { summary }, null, 2));
		return;
	}
	if (options.text) {
		printHumanReport(summary);
		return;
	}
	printHtmlReport(summary);
}

runMain(() => runToolStatsCli(process.argv.slice(2), { parseArgs, printHelp, scanSessions, applyFilters, buildSummary }, printRun));
