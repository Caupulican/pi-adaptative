import { createReadStream, readFileSync, readdirSync, statSync } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

export const DEFAULT_SESSIONS_DIR = path.join(homedir(), ".pi/agent/sessions");
export const REPORT_TIME_ZONE = "Europe/Berlin";

export function parseSessionStatsArgs(argv, options, parseSpecific) {
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") options.help = true;
		else if (arg === "--json") options.json = true;
		else if (arg === "--text") options.text = true;
		else if (arg === "--sessions-dir") options.sessionsDir = argv[++index];
		else if (arg === "--all-sessions") options.allSessions = true;
		else if (arg === "--since") options.since = argv[++index];
		else {
			const nextIndex = parseSpecific(arg, index, argv, options);
			if (nextIndex === null) throw new Error(`Unknown argument: ${arg}`);
			index = nextIndex;
		}
	}
	return options;
}

export function parseSessionFileTimestamp(sessionFile) {
	const rawTimestamp = path.basename(sessionFile).split("_")[0];
	if (!rawTimestamp) return null;
	const ms = Date.parse(rawTimestamp.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "T$1:$2:$3.$4Z"));
	return Number.isFinite(ms) ? ms : null;
}

export async function resolveAutoSinceMs(options) {
	if (options.allSessions) return null;
	if (options.since) {
		const ms = Date.parse(options.since);
		if (!Number.isFinite(ms)) throw new Error(`Invalid --since value: ${options.since}`);
		return { ms, source: `--since ${options.since}` };
	}
	if (!options.autoSincePath) return null;
	try {
		const stats = await fs.stat(options.autoSincePath);
		const ms = Number.isFinite(stats.birthtimeMs) && stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.mtimeMs;
		return Number.isFinite(ms) && ms > 0 ? { ms, source: `birth time of ${options.autoSincePath}` } : null;
	} catch {
		return null;
	}
}

async function* walkJsonlFiles(directory) {
	const entries = await fs.readdir(directory, { withFileTypes: true });
	entries.sort((left, right) => left.name.localeCompare(right.name));
	for (const entry of entries) {
		const fullPath = path.join(directory, entry.name);
		if (entry.isDirectory()) yield* walkJsonlFiles(fullPath);
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield fullPath;
	}
}

export async function scanSessionJsonl({ sessionsDir, sinceMs = null, createSession = () => undefined, onEntry, onSessionEnd = () => {} }) {
	const meta = {
		sessionsDir,
		sessionFilesScanned: 0,
		sessionFilesIncluded: 0,
		sessionFilesSkippedOlderThanSince: 0,
		malformedLines: 0,
	};
	for await (const sessionFile of walkJsonlFiles(sessionsDir)) {
		meta.sessionFilesScanned++;
		const sessionTimestampMs = parseSessionFileTimestamp(sessionFile);
		if (sinceMs !== null && sessionTimestampMs !== null && sessionTimestampMs < sinceMs) {
			meta.sessionFilesSkippedOlderThanSince++;
			continue;
		}
		meta.sessionFilesIncluded++;
		const session = createSession(sessionFile, sessionTimestampMs);
		const input = createReadStream(sessionFile, { encoding: "utf8" });
		const lines = createInterface({ input, crlfDelay: Infinity });
		for await (const line of lines) {
			if (!line.trim()) continue;
			let entry;
			try {
				entry = JSON.parse(line);
			} catch {
				meta.malformedLines++;
				continue;
			}
			onEntry(entry, session, sessionFile, sessionTimestampMs);
		}
		onSessionEnd(session, sessionFile, sessionTimestampMs);
	}
	return { meta };
}

export function getReportTimeZoneParts(ms) {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: REPORT_TIME_ZONE,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		hourCycle: "h23",
		weekday: "short",
	}).formatToParts(new Date(ms));
	return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

export function formatReportDay(ms) {
	const parts = getReportTimeZoneParts(ms);
	return `${parts.year}-${parts.month}-${parts.day}`;
}

export function formatInt(value) {
	return new Intl.NumberFormat("en-US").format(value);
}

export function formatPartPercent(part, total) {
	return total === 0 ? "n/a" : `${((part / total) * 100).toFixed(1)}%`;
}

export function groupBy(values, keyForValue) {
	const groups = new Map();
	for (const value of values) {
		const key = keyForValue(value);
		const group = groups.get(key);
		if (group) group.push(value);
		else groups.set(key, [value]);
	}
	return groups;
}

export function assistantRecordIdentity(entry, message) {
	const provider = typeof message.provider === "string" ? message.provider : "[unknown]";
	const model = typeof message.model === "string" ? message.model : "[unknown]";
	return {
		assistantEntryId: entry.id,
		timestamp: entry.timestamp,
		api: typeof message.api === "string" ? message.api : null,
		provider,
		model,
		providerModel: `${provider}/${model}`,
	};
}

const EMPTY_TOOL_CALLS = Object.freeze([]);

export function assistantToolCalls(message) {
	return message?.role === "assistant" && Array.isArray(message.content) ? message.content : EMPTY_TOOL_CALLS;
}

export function sessionScanHeaderLines(scan) {
	const lines = [`Scanned ${formatInt(scan.sessionFilesIncluded)} session files in ${scan.sessionsDir}`];
	if (scan.since) {
		lines.push(`Session filter: files created at or after ${scan.since.iso} (${scan.since.source})`);
		lines.push(`Skipped older session files: ${formatInt(scan.sessionFilesSkippedOlderThanSince)} of ${formatInt(scan.sessionFilesScanned)}`);
	}
	return lines;
}

export function median(values) {
	const finite = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
	if (finite.length === 0) return null;
	const middle = Math.floor(finite.length / 2);
	return finite.length % 2 === 0 ? (finite[middle - 1] + finite[middle]) / 2 : finite[middle];
}

export function escapeHtml(text) {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export async function loadToolStatsRun({ argv, parseArgs, printHelp, scanSessions, applyFilters, buildSummary }) {
	const options = parseArgs(argv);
	if (options.help) {
		printHelp();
		return null;
	}
	const sessionsDir = path.resolve(options.sessionsDir);
	await fs.access(sessionsDir);
	const since = await resolveAutoSinceMs(options);
	const { records, meta } = await scanSessions(sessionsDir, since);
	const filteredRecords = applyFilters(records, options);
	return { options, records: filteredRecords, summary: buildSummary(filteredRecords, meta, options) };
}

export async function runToolStatsCli(argv, handlers, printRun) {
	const run = await loadToolStatsRun({ argv, ...handlers });
	if (run) printRun(run);
}

export function runMain(main) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}

/** Text of a message `content` value: a string as-is, text parts joined by `separator`. */
export function messageText(content, separator = "") {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join(separator);
}

/** Every `.jsonl` under `target` (a file is returned as-is), sorted by name, recursively. */
export function listSessionFiles(target) {
	if (statSync(target).isFile()) return [target];
	const out = [];
	for (const name of readdirSync(target).sort()) {
		const full = path.join(target, name);
		if (statSync(full).isDirectory()) out.push(...listSessionFiles(full));
		else if (name.endsWith(".jsonl")) out.push(full);
	}
	return out;
}

/** Parsed entries of one session file; malformed lines are skipped (the scripts are diagnostics). */
export function parseSessionEntries(file) {
	const entries = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// skip malformed line
		}
	}
	return entries;
}
