#!/usr/bin/env node
/**
 * Mistake-class census: the recurring mistakes the harness recorded, counted per class key across the local stores
 * that hold them. Session transcripts give the tool outcomes, harness refusals and shell-contract hits; the agent
 * dir's `failure-corpus.jsonl` gives validation and provider failures; `learning-observations.json` gives the lesson
 * observation counts. The census is code facts only: no model call and no near-duplicate merging.
 *
 *   node scripts/mistake-class-census.mjs <session-dir> [...] [--agent-dir <dir>] [--out <file>]
 *
 * Class keys: `tool:<tool>:<failureCode>` (operation outcomes), `refusal:<tool>:<failureCode>` (harness refusals),
 * `refusal:shell:<rule>` (Windows shell-contract hits), `validation:<tool>:<failureModes>` and `provider:<reason>`
 * (failure corpus), `observation:<key>` (the store's observation key, a hash of layer and summary; the store keeps no
 * layer). A tool result belongs to one class only. `failure-corpus.jsonl` `tool_execution` records describe the same
 * events as the session tool results and are not counted twice.
 *
 * Privacy: the report holds code facts only (keys, counts, timestamps, session file basenames and entry ids). It never
 * holds message text, argument values, diagnostics or directory paths. It is written to
 * `<git-common-dir>/pi-audits/census/` (never tracked), or to `<agent-dir>/state/census/` outside a repository. An
 * explicit `--out` inside the working tree is refused. The default agent dir is `PI_CODING_AGENT_DIR` or `~/.pi/agent`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { classifySessionResults } from "./lib/refusal-keys.mjs";
import { listSessionFiles } from "./session-stats-common.mjs";

const REPORT_VERSION = 1;
const POINTERS_PER_CLASS = 5;
/** Tool names, failure codes, failure modes and provider reasons: charset-checked so no sentence can become a key. */
const SAFE_PART = /^[A-Za-z0-9_.:…-]{1,80}$/;
/** observationKey(): the first 24 hex characters of a sha256. */
const OBSERVATION_KEY = /^[0-9a-f]{24}$/;
const FAILURE_CORPUS_NOTE = "failure-corpus.jsonl is bounded by its writer (at most 1000 records); its counts may be partial";
const OBSERVATION_NOTE =
	"observation counts are cumulative per key (capped at 100 per key, at most 500 keys) and carry no session or first-seen time";

function usage(message) {
	console.error(`mistake-class-census: ${message}`);
	console.error("usage: node scripts/mistake-class-census.mjs <session-dir> [...] [--agent-dir <dir>] [--out <file>]");
	process.exit(2);
}

function parseArgs(argv) {
	const options = { dirs: [], agentDir: undefined, out: undefined };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--agent-dir" || arg === "--out") {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) usage(`${arg} needs a value`);
			if (arg === "--agent-dir") options.agentDir = value;
			else options.out = value;
			index += 1;
		} else if (arg.startsWith("--")) usage(`unknown flag ${arg}`);
		else options.dirs.push(arg);
	}
	if (options.dirs.length === 0) usage("no session directory given");
	return options;
}

function expandHome(value) {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	return value;
}

function agentDirOf(options) {
	if (options.agentDir) return resolve(expandHome(options.agentDir));
	const configured = process.env.PI_CODING_AGENT_DIR;
	return configured ? resolve(expandHome(configured)) : join(homedir(), ".pi", "agent");
}

/** The absolute path git prints for `args` in the current directory; undefined outside a repository. */
function gitPath(args) {
	try {
		const printed = execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		return resolve(process.cwd(), printed);
	} catch {
		return undefined;
	}
}

function isInside(child, parent) {
	const rel = relative(parent, child);
	return rel === "" || (rel.split(sep)[0] !== ".." && !isAbsolute(rel));
}

function resolveOutFile(options, agentDir, stamp) {
	const common = gitPath(["rev-parse", "--git-common-dir"]);
	const top = gitPath(["rev-parse", "--show-toplevel"]);
	const file = options.out
		? resolve(options.out)
		: common
			? join(common, "pi-audits", "census", `mistake-classes-${stamp}.json`)
			: join(agentDir, "state", "census", `mistake-classes-${stamp}.json`);
	if (top && isInside(file, top) && !(common && isInside(file, common))) {
		usage("refusing to write the census inside the working tree; choose a path outside it");
	}
	return file;
}

/** Source of a class key: session transcripts, the failure corpus, or the observation store. */
function sourceOf(key) {
	const kind = key.split(":", 1)[0];
	if (kind === "tool" || kind === "refusal") return "session";
	if (kind === "validation" || kind === "provider") return "failure-corpus";
	return "observations";
}

function classFor(classes, key) {
	let entry = classes.get(key);
	if (!entry) {
		entry = {
			key,
			source: sourceOf(key),
			count: 0,
			sessionFiles: new Set(),
			firstAt: undefined,
			lastAt: undefined,
			pointers: [],
		};
		classes.set(key, entry);
	}
	return entry;
}

function noteTime(entry, at) {
	const time = typeof at === "string" ? Date.parse(at) : Number.NaN;
	if (Number.isNaN(time)) return;
	if (entry.firstAt === undefined || time < Date.parse(entry.firstAt)) entry.firstAt = at;
	if (entry.lastAt === undefined || time > Date.parse(entry.lastAt)) entry.lastAt = at;
}

/** Records one occurrence. Session occurrences carry the session file (for distinct counts) and a bounded pointer list. */
function addOccurrence(classes, key, occurrence) {
	const entry = classFor(classes, key);
	entry.count += 1;
	noteTime(entry, occurrence.at);
	if (entry.source !== "session") return;
	entry.sessionFiles.add(occurrence.sessionPath);
	if (entry.pointers.length < POINTERS_PER_CLASS) {
		entry.pointers.push({ sessionFile: occurrence.sessionFile, entryId: occurrence.entryId ?? null });
	}
}

function sessionClassKey(result, safe) {
	if (result.shellRule) return `refusal:shell:${result.shellRule}`;
	if (result.kind === undefined) return undefined;
	const tool = safe(result.tool);
	const code = result.failureCode === undefined ? "unrecorded" : safe(result.failureCode);
	return result.kind === "refusal" ? `refusal:${tool}:${code}` : `tool:${tool}:${code}`;
}

function readSessionFile(file, classes, totals, safe) {
	const { turns, results } = classifySessionResults(file);
	totals.sessionFiles += 1;
	totals.sessionTurns += turns;
	totals.toolResults += results.length;
	for (const result of results) {
		const key = sessionClassKey(result, safe);
		if (key === undefined) continue;
		addOccurrence(classes, key, {
			at: result.at,
			sessionPath: file,
			sessionFile: basename(file),
			entryId: result.entryId,
		});
	}
}

function readFailureCorpus(file, classes, safe) {
	const corpus = {
		present: existsSync(file),
		records: 0,
		malformedLines: 0,
		toolExecutionSkipped: 0,
		unrecognized: 0,
		note: FAILURE_CORPUS_NOTE,
	};
	if (!corpus.present) return corpus;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			corpus.malformedLines += 1;
			continue;
		}
		corpus.records += 1;
		if (record?.kind === "tool_validation" && Array.isArray(record.failureModes)) {
			const modes = record.failureModes.map(safe).sort().join("+") || "none";
			addOccurrence(classes, `validation:${safe(record.tool)}:${modes}`, { at: record.ts });
		} else if (record?.kind === "tool_execution") {
			corpus.toolExecutionSkipped += 1;
		} else if (record?.kind === undefined && typeof record?.reason === "string") {
			addOccurrence(classes, `provider:${safe(record.reason)}`, { at: record.ts });
		} else {
			corpus.unrecognized += 1;
		}
	}
	return corpus;
}

function readObservations(file, classes) {
	const observations = { present: existsSync(file), keys: 0, invalid: 0, note: OBSERVATION_NOTE };
	if (!observations.present) return observations;
	const table = JSON.parse(readFileSync(file, "utf8"))?.observations;
	if (!table || typeof table !== "object" || Array.isArray(table)) {
		throw new Error("learning-observations.json has no observations table");
	}
	for (const [hash, entry] of Object.entries(table)) {
		if (!OBSERVATION_KEY.test(hash) || typeof entry?.count !== "number") {
			observations.invalid += 1;
			continue;
		}
		observations.keys += 1;
		const observed = classFor(classes, `observation:${hash}`);
		observed.count = entry.count;
		// The store keeps only the last increment time; the first one is not recorded, so `firstAt` stays null.
		if (typeof entry.lastAt === "string" && !Number.isNaN(Date.parse(entry.lastAt))) observed.lastAt = entry.lastAt;
	}
	return observations;
}

function writeReport(file, report) {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(report, null, "\t")}\n`, { mode: 0o600 });
	renameSync(temporary, file);
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const agentDir = agentDirOf(options);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const outFile = resolveOutFile(options, agentDir, stamp);
	const classes = new Map();
	const totals = { sessionFiles: 0, sessionTurns: 0, toolResults: 0, unsafeParts: 0 };
	const safe = (value) => {
		if (typeof value === "string" && SAFE_PART.test(value)) return value;
		totals.unsafeParts += 1;
		return "[unsafe]";
	};
	for (const dir of options.dirs) {
		for (const file of listSessionFiles(dir)) readSessionFile(file, classes, totals, safe);
	}
	const failureCorpus = readFailureCorpus(join(agentDir, "state", "failure-corpus.jsonl"), classes, safe);
	const observations = readObservations(join(agentDir, "state", "learning-observations.json"), classes);
	const ordered = [...classes.values()].sort((left, right) => right.count - left.count || (left.key < right.key ? -1 : 1));
	const report = {
		version: REPORT_VERSION,
		generatedAt: new Date().toISOString(),
		sources: {
			sessionFiles: totals.sessionFiles,
			sessionTurns: totals.sessionTurns,
			toolResults: totals.toolResults,
			failureCorpus,
			observations,
		},
		unsafeParts: totals.unsafeParts,
		classes: ordered.map((entry) => ({
			key: entry.key,
			source: entry.source,
			count: entry.count,
			sessions: entry.source === "session" ? entry.sessionFiles.size : null,
			firstAt: entry.firstAt ?? null,
			lastAt: entry.lastAt ?? null,
			pointers: entry.pointers,
		})),
	};
	writeReport(outFile, report);
	console.log(
		`mistake-class-census: ${totals.sessionFiles} session file(s), ${ordered.length} class(es), ${totals.unsafeParts} part(s) outside the key charset; wrote ${outFile}`,
	);
	for (const entry of ordered.slice(0, 10)) console.log(`  ${String(entry.count).padStart(6)}  ${entry.key}`);
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
