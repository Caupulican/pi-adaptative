#!/usr/bin/env node

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { assistantToolCalls, DEFAULT_SESSIONS_DIR, escapeHtml, formatReportDay as formatDay, median, parseSessionStatsArgs, REPORT_TIME_ZONE, runMain, scanSessionJsonl } from "./session-stats-common.mjs";

const MODELS_GENERATED_PATH = path.join(process.cwd(), "packages/ai/src/models.generated.ts");
const MODELS_CONFIG_PATH = path.join(homedir(), ".pi/agent/models.json");
const CHART_WIDTH = 40;

function parseArgs(argv) {
	const options = { sessionsDir: DEFAULT_SESSIONS_DIR, json: false, text: false, allSessions: false, since: undefined, modelFilter: undefined, modelPrefixes: [], bashContains: [], cwd: process.cwd(), help: false };
	return parseSessionStatsArgs(argv, options, parseContextStatsArg);
}

function parseContextStatsArg(arg, index, argv, options) {
	if (arg === "--model") options.modelFilter = argv[++index];
	else if (arg === "--model-prefix") options.modelPrefixes.push(argv[++index]);
	else if (arg === "--bash-contains") options.bashContains.push(argv[++index]);
	else if (arg === "--git-commit-or-push") options.bashContains.push("git commit", "git push");
	else if (arg === "--cwd") options.cwd = argv[++index];
	else if (arg === "--all-cwds") options.cwd = undefined;
	else return null;
	return index;
}

function printHelp() {
	console.log(`Usage: node scripts/session-context-stats.mjs [options]

Options:
  --sessions-dir <path>  Sessions directory (default: ~/.pi/agent/sessions)
  --model <substring>    Filter provider/model by substring
  --model-prefix <p>     Include provider/model prefixes, repeatable, e.g. openai-codex/
  --bash-contains <text> Include only sessions with bash tool calls containing text, repeatable
  --git-commit-or-push   Shortcut for --bash-contains "git commit" --bash-contains "git push"
  --cwd <path>           Include only sessions whose cwd is this path (default: current cwd)
  --all-cwds             Include sessions from all cwd values
  --since <iso>          Only scan session files created at or after this ISO time
  --all-sessions         Scan all sessions (default already scans all)
  --json                 Print JSON instead of HTML report
  --text                 Print plain text instead of HTML report
  -h, --help             Show this help
`);
}

function formatInt(value) {
	return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function formatNumber(value) {
	return Number.isFinite(value) ? value.toFixed(2) : "n/a";
}

function formatPercent(value) {
	return Number.isFinite(value) ? `${value.toFixed(1)}%` : "n/a";
}

function bar(percent) {
	const clamped = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
	const filled = Math.round((clamped / 100) * CHART_WIDTH);
	return `${"█".repeat(filled)}${"░".repeat(CHART_WIDTH - filled)}`;
}

async function loadContextWindows() {
	const windows = new Map();
	const sources = [];
	let text = "";
	try {
		text = await fs.readFile(MODELS_GENERATED_PATH, "utf8");
		sources.push(MODELS_GENERATED_PATH);
	} catch {
		// Optional in non-repo usage.
	}
	const providerRegex = /\n\t"([^"]+)": \{([\s\S]*?\n\t)\},/g;
	let providerMatch;
	while ((providerMatch = providerRegex.exec(text)) !== null) {
		const provider = providerMatch[1];
		const body = providerMatch[2];
		const modelRegex = /\n\t\t"([^"]+)": \{[\s\S]*?contextWindow: (\d+),/g;
		let modelMatch;
		while ((modelMatch = modelRegex.exec(body)) !== null) {
			windows.set(`${provider}/${modelMatch[1]}`, Number(modelMatch[2]));
		}
	}

	try {
		const config = JSON.parse(await fs.readFile(MODELS_CONFIG_PATH, "utf8"));
		sources.push(MODELS_CONFIG_PATH);
		const providers = config?.providers && typeof config.providers === "object" ? config.providers : {};
		for (const [providerName, provider] of Object.entries(providers)) {
			const overrides = provider?.modelOverrides && typeof provider.modelOverrides === "object" ? provider.modelOverrides : {};
			for (const [modelId, override] of Object.entries(overrides)) {
				if (typeof override?.contextWindow === "number") windows.set(`${providerName}/${modelId}`, override.contextWindow);
			}
			if (Array.isArray(provider?.models)) {
				for (const model of provider.models) {
					if (typeof model?.id === "string" && typeof model.contextWindow === "number") windows.set(`${providerName}/${model.id}`, model.contextWindow);
				}
			}
		}
	} catch {
		// Optional user config.
	}

	return { windows, sources };
}

function contextTokens(usage) {
	if (!usage || typeof usage !== "object") return null;
	const totalTokens = Number(usage.totalTokens ?? 0);
	if (Number.isFinite(totalTokens) && totalTokens > 0) return totalTokens;
	const input = Number(usage.input ?? 0);
	const output = Number(usage.output ?? 0);
	const cacheRead = Number(usage.cacheRead ?? 0);
	const cacheWrite = Number(usage.cacheWrite ?? 0);
	const value = input + output + cacheRead + cacheWrite;
	return Number.isFinite(value) && value > 0 ? value : null;
}

async function scanSessions(sessionsDir, sinceMs, contextWindows, cwdFilter) {
	const windows = contextWindows.windows;
	const sessions = [];
	const { meta } = await scanSessionJsonl({
		sessionsDir,
		sinceMs,
		createSession: (sessionFile, fileTimestampMs) => ({
			sessionFile,
			cwd: null,
			startMs: fileTimestampMs ?? 0,
			endMs: fileTimestampMs ?? 0,
			providerModel: "[unknown]/[unknown]",
			assistantMessages: 0,
			userMessages: 0,
			compactions: 0,
			seenCompaction: false,
			maxPromptTokens: null,
			preFirstCompactionTokens: null,
			maxContextUsagePercent: null,
			preFirstCompactionUsagePercent: null,
			contextWindow: null,
			bashCommands: [],
			over80: false,
			over90: false,
			over100: false,
		}),
		onEntry: (entry, session) => {
			if (entry.type === "session" && typeof entry.cwd === "string") session.cwd = entry.cwd;
			const entryMs = Date.parse(entry.timestamp ?? "");
			if (Number.isFinite(entryMs)) {
				if (!session.startMs || entryMs < session.startMs) session.startMs = entryMs;
				if (!session.endMs || entryMs > session.endMs) session.endMs = entryMs;
			}
			if (entry.type === "compaction") {
				session.compactions++;
				if (typeof entry.tokensBefore === "number") {
					session.maxPromptTokens = Math.max(session.maxPromptTokens ?? 0, entry.tokensBefore);
					if (!session.seenCompaction) session.preFirstCompactionTokens = entry.tokensBefore;
				}
				session.seenCompaction = true;
				return;
			}
			if (entry.type !== "message" || !entry.message) return;
			const message = entry.message;
			for (const block of assistantToolCalls(message)) {
				if (block?.type !== "toolCall" || block.name !== "bash") continue;
				const command = typeof block.arguments?.command === "string" ? block.arguments.command : "";
				if (command) session.bashCommands.push(command);
			}
			if (message.role === "user") session.userMessages++;
			if (message.role !== "assistant") return;
			session.assistantMessages++;
			const provider = typeof message.provider === "string" ? message.provider : "[unknown]";
			const model = typeof message.model === "string" ? message.model : "[unknown]";
			session.providerModel = `${provider}/${model}`;
			const contextWindow = windows.get(session.providerModel) ?? null;
			if (contextWindow !== null) session.contextWindow = contextWindow;
			const tokens = contextTokens(message.usage);
			if (tokens !== null) {
				session.maxPromptTokens = Math.max(session.maxPromptTokens ?? 0, tokens);
				if (!session.seenCompaction) session.preFirstCompactionTokens = tokens;
			}
		},
		onSessionEnd: (session) => {
			if (session.maxPromptTokens !== null && session.contextWindow !== null) {
				session.maxContextUsagePercent = (session.maxPromptTokens / session.contextWindow) * 100;
				session.over80 = session.maxContextUsagePercent >= 80;
				session.over90 = session.maxContextUsagePercent >= 90;
				session.over100 = session.maxContextUsagePercent >= 100;
			}
			if (session.preFirstCompactionTokens !== null && session.contextWindow !== null) {
				session.preFirstCompactionUsagePercent = (session.preFirstCompactionTokens / session.contextWindow) * 100;
			}
			if (!cwdFilter || path.resolve(session.cwd ?? "") === cwdFilter) sessions.push(session);
		},
	});
	return { sessions, meta };
}

function summarizeGroups(sessions, keyFn) {
	const groups = new Map();
	for (const session of sessions) {
		const key = keyFn(session);
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(session);
	}
	return [...groups.entries()].map(([key, group]) => summarizeSessionGroup(key, group)).sort((a, b) => a.key.localeCompare(b.key));
}

function summarizeSessionGroup(key, group) {
	const withUsage = group.filter((session) => session.maxContextUsagePercent !== null);
	const withTokens = group.filter((session) => session.maxPromptTokens !== null);
	const withPreCompactionUsage = group.filter((session) => session.preFirstCompactionUsagePercent !== null);
	const compactions = group.filter((session) => session.compactions > 0).length;
	const totalCompactions = group.reduce((sum, session) => sum + session.compactions, 0);
	const contextWindows = [...new Set(group.map((session) => session.contextWindow).filter((value) => value !== null))].sort((a, b) => a - b);
	return {
		key,
		sessions: group.length,
		contextWindows,
		assistantMessages: group.reduce((sum, session) => sum + session.assistantMessages, 0),
		avgTurns: group.reduce((sum, session) => sum + session.userMessages, 0) / group.length,
		avgDurationMinutes: group.reduce((sum, session) => sum + Math.max(0, session.endMs - session.startMs) / 60000, 0) / group.length,
		avgMaxPromptTokens: withTokens.length === 0 ? null : withTokens.reduce((sum, session) => sum + (session.maxPromptTokens ?? 0), 0) / withTokens.length,
		medianMaxPromptTokens: median(withTokens.map((session) => session.maxPromptTokens)),
		avgMaxContextUsagePercent: withUsage.length === 0 ? null : withUsage.reduce((sum, session) => sum + (session.maxContextUsagePercent ?? 0), 0) / withUsage.length,
		medianMaxContextUsagePercent: median(withUsage.map((session) => session.maxContextUsagePercent)),
		medianPreFirstCompactionUsagePercent: median(withPreCompactionUsage.map((session) => session.preFirstCompactionUsagePercent)),
		contextKnownSessions: withUsage.length,
		sessionsWithCompaction: compactions,
		totalCompactions,
		compactionRate: (compactions / group.length) * 100,
		over80: group.filter((session) => session.over80).length,
		over90: group.filter((session) => session.over90).length,
		over100: group.filter((session) => session.over100).length,
	};
}

function buildSummary(sessions, meta, options) {
	const lowerPrefixes = options.modelPrefixes.map((prefix) => prefix.toLowerCase());
	const bashContains = options.bashContains.map((text) => text.toLowerCase());
	const filtered = sessions.filter((session) => {
		const providerModel = session.providerModel.toLowerCase();
		if (options.modelFilter && !providerModel.includes(options.modelFilter.toLowerCase())) return false;
		if (lowerPrefixes.length > 0 && !lowerPrefixes.some((prefix) => providerModel.startsWith(prefix))) return false;
		if (bashContains.length > 0) {
			const commands = session.bashCommands.map((command) => command.toLowerCase());
			if (!bashContains.some((text) => commands.some((command) => command.includes(text)))) return false;
		}
		return true;
	});
	return {
		filters: { model: options.modelFilter ?? null, modelPrefixes: options.modelPrefixes, bashContains: options.bashContains, cwd: options.cwd ? path.resolve(options.cwd) : null },
		scan: { ...meta, timezone: REPORT_TIME_ZONE },
		totals: summarizeSessionGroup("total", filtered),
		byDay: summarizeGroups(filtered, (session) => formatDay(session.startMs)),
		byModel: summarizeGroups(filtered, (session) => session.providerModel).sort((a, b) => b.sessions - a.sessions || a.key.localeCompare(b.key)),
		byModelDay: summarizeGroups(filtered, (session) => session.providerModel).sort((a, b) => b.sessions - a.sessions || a.key.localeCompare(b.key)).map((model) => ({
			...model,
			byDay: summarizeGroups(
				filtered.filter((session) => session.providerModel === model.key),
				(session) => formatDay(session.startMs)
			),
		})),
	};
}

function lineForGroup(group, indent = "  ") {
	return `${indent}${group.key} sessions=${formatInt(group.sessions).padStart(4)} avgTurns=${formatNumber(group.avgTurns).padStart(5)} avgMin=${formatNumber(group.avgDurationMinutes).padStart(6)} avgMaxTok=${group.avgMaxPromptTokens === null ? "n/a" : formatInt(group.avgMaxPromptTokens).padStart(7)} medMaxCtx=${group.medianMaxContextUsagePercent === null ? "n/a" : formatPercent(group.medianMaxContextUsagePercent).padStart(6)} medPreCompactCtx=${group.medianPreFirstCompactionUsagePercent === null ? "n/a" : formatPercent(group.medianPreFirstCompactionUsagePercent).padStart(6)} avgCtx=${group.avgMaxContextUsagePercent === null ? "n/a" : formatPercent(group.avgMaxContextUsagePercent).padStart(6)} compact=${formatPercent(group.compactionRate).padStart(6)} over90=${formatInt(group.over90).padStart(3)} ${bar(group.medianMaxContextUsagePercent ?? 0)}`;
}

function buildTextReport(summary) {
	const lines = [];
	lines.push(`Scanned ${formatInt(summary.scan.sessionFilesIncluded)} session files in ${summary.scan.sessionsDir}`);
	lines.push(`Report timezone: ${summary.scan.timezone} (CET/CEST)`);
	lines.push(`Context window sources: ${summary.scan.contextWindowSources.join(", ") || "none"}`);
	if (summary.filters.model) lines.push(`Filters: model contains "${summary.filters.model}"`);
	if (summary.filters.modelPrefixes.length > 0) lines.push(`Filters: model prefixes = ${summary.filters.modelPrefixes.join(", ")}`);
	if (summary.filters.bashContains.length > 0) lines.push(`Filters: bash contains any of = ${summary.filters.bashContains.join(", ")}`);
	if (summary.filters.cwd) lines.push(`Filters: cwd = ${summary.filters.cwd}`);
	lines.push("Context usage parses full session JSONL files. max context uses max assistant usage.totalTokens per session, falling back to input + output + cacheRead + cacheWrite, plus compaction tokensBefore. medPreCompactCtx uses the last assistant usage before the first compaction, or the first compaction tokensBefore when present, divided by model contextWindow from packages/ai/src/models.generated.ts when known.");
	lines.push("");
	lines.push("Totals");
	lines.push(lineForGroup(summary.totals));
	lines.push("");
	lines.push("By day");
	for (const group of summary.byDay) lines.push(lineForGroup(group));
	lines.push("");
	lines.push("By model");
	for (const group of summary.byModel) lines.push(lineForGroup(group));
	lines.push("");
	lines.push("By model, then by day");
	for (const model of summary.byModelDay) {
		lines.push("");
		const contextWindowLabel = model.contextWindows.length === 0 ? "unknown" : model.contextWindows.map((value) => formatInt(value)).join(", ");
		lines.push(`${model.key} contextWindow=${contextWindowLabel}`);
		lines.push(lineForGroup(model, "  total "));
		for (const group of model.byDay) lines.push(lineForGroup(group, "  "));
	}
	if (summary.scan.malformedLines > 0) {
		lines.push("");
		lines.push(`Malformed lines skipped: ${formatInt(summary.scan.malformedLines)}`);
	}
	return `${lines.join("\n")}\n`;
}

function printHtmlReport(summary) {
	console.log(`<!doctype html>
<meta charset="utf-8">
<title>Session context stats</title>
<style>
body { margin: 24px; background: #fff; color: #111; }
pre { font: 13px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; }
</style>
<pre>${escapeHtml(buildTextReport(summary))}</pre>`);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		printHelp();
		return;
	}
	const sinceMs = options.since ? Date.parse(options.since) : null;
	if (options.since && !Number.isFinite(sinceMs)) throw new Error(`Invalid --since value: ${options.since}`);
	const contextWindows = await loadContextWindows();
	const cwdFilter = options.cwd ? path.resolve(options.cwd) : undefined;
	const { sessions, meta } = await scanSessions(path.resolve(options.sessionsDir), sinceMs, contextWindows, cwdFilter);
	const summary = buildSummary(sessions, { ...meta, contextWindowSources: contextWindows.sources }, options);
	if (options.json) console.log(JSON.stringify(summary, null, 2));
	else if (options.text) console.log(buildTextReport(summary));
	else printHtmlReport(summary);
}

runMain(main);
