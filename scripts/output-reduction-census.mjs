#!/usr/bin/env node
/**
 * Output-reduction census: where the tool-result bytes go, which of them a reducer touched, and
 * which command families pass through untouched (the missed savings). Reads session `.jsonl` files
 * and classifies commands with the SAME classifier the runtime uses, so a family that shows up here
 * as passthrough is one the pipeline really left alone.
 *
 * Usage: node scripts/output-reduction-census.mjs <dir|file>... [--top N] [--replay] [--gate <json>]
 *
 *   --top N      families per table (default 20)
 *   --replay     run the bundled reducers over the recorded raw text of every bash/python result and
 *                report the projected savings per family (what a change would have saved on this
 *                session, before it ships)
 *   --gate json  fail (exit 1) when the replayed reduction share of a family is below the given floor,
 *                e.g. '{"rg":0.3,"cargo check":0.6}'; used on the fixture corpus in CI
 *   --corpus m   replay the reducers over a fixture manifest (`corpus.json`: name, command, file,
 *                family) instead of sessions; the gate then applies per manifest family
 *
 * Output is aggregate only: family labels, counts and byte totals. No command text or output text is
 * printed (sessions are private).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createJiti } from "jiti";
import { listSessionFiles, messageText, parseSessionEntries } from "./session-stats-common.mjs";

const jiti = createJiti(import.meta.url);
const { classifyCommandFamily, commandFamilyLabel } = await jiti.import(
	"../packages/coding-agent/src/core/tools/command-family.ts",
);
const { reduceToolOutput } = await jiti.import("../packages/coding-agent/src/core/tools/output-reduction.ts");

function parseArgs(argv) {
	const options = { targets: [], top: 20, replay: false, gate: undefined, corpus: undefined };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--top") options.top = Number.parseInt(argv[++index] ?? "20", 10);
		else if (arg === "--replay") options.replay = true;
		else if (arg === "--corpus") {
			options.corpus = argv[++index];
			options.replay = true;
		} else if (arg === "--gate") {
			options.gate = JSON.parse(argv[++index] ?? "{}");
			options.replay = true;
		} else if (arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`);
		else options.targets.push(arg);
	}
	if (options.targets.length === 0 && !options.corpus) {
		console.error(
			"usage: node scripts/output-reduction-census.mjs <dir|file>... [--top N] [--replay] [--gate json] | --corpus manifest.json [--gate json]",
		);
		process.exit(2);
	}
	return options;
}

/** Replay the reducers over a fixture manifest; returns rows keyed by manifest family. */
export function replayCorpus(manifestPath) {
	const entries = JSON.parse(readFileSync(manifestPath, "utf8"));
	const base = dirname(manifestPath);
	const byFamily = new Map();
	const rows = [];
	for (const entry of entries) {
		const text = readFileSync(join(base, entry.file), "utf8");
		const reduced = reduceToolOutput({ tool: "bash", command: entry.command, text, exitCode: 0, level: "standard" });
		const from = Buffer.byteLength(text, "utf-8");
		const to = reduced ? reduced.details.outputBytes : from;
		rows.push({ name: entry.name, family: entry.family, kind: reduced?.details.kind ?? "-", from, to });
		bump(byFamily, entry.family, from, { replayFrom: from, replayTo: to, ...(reduced ? { reducedN: 1, reducedFrom: from, reducedTo: to } : {}) });
	}
	return { rows, byFamily };
}

function bump(map, key, bytes, extra = {}) {
	const row = map.get(key) ?? { n: 0, bytes: 0, reducedN: 0, reducedFrom: 0, reducedTo: 0, replayFrom: 0, replayTo: 0 };
	row.n += 1;
	row.bytes += bytes;
	for (const [field, value] of Object.entries(extra)) row[field] += value;
	map.set(key, row);
}

/** Pair every tool result with the call that produced it; sessions log both as messages. */
export function censusSession(entries, options = {}) {
	const calls = new Map();
	const byTool = new Map();
	const byFamily = new Map();
	let totalBytes = 0;
	for (const entry of entries) {
		const message = entry?.message;
		if (!message || typeof message !== "object") continue;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block?.type === "toolCall") calls.set(block.id, { name: block.name, args: block.arguments ?? {} });
			}
			continue;
		}
		if (message.role !== "toolResult") continue;
		const text = messageText(message.content);
		const bytes = Buffer.byteLength(text, "utf-8");
		totalBytes += bytes;
		const tool = message.toolName ?? "?";
		const details = message.details ?? {};
		const reduction = details.outputReduction ?? (details.outputProjection ? { ...details.outputProjection, kind: "test" } : undefined);
		const reducedExtra = reduction
			? { reducedN: 1, reducedFrom: reduction.inputBytes ?? bytes, reducedTo: reduction.outputBytes ?? bytes }
			: {};
		bump(byTool, tool, bytes, reducedExtra);
		if (tool !== "bash" && tool !== "python") continue;
		const call = calls.get(message.toolCallId);
		const command = typeof call?.args?.command === "string" ? call.args.command : undefined;
		const family = tool === "python" ? "python" : command ? commandFamilyLabel(classifyCommandFamily(command)) : "(unpaired)";
		let replayExtra = {};
		if (options.replay && command !== undefined) {
			const reduced = reduceToolOutput({ tool, command, text, exitCode: 0, level: "standard" });
			replayExtra = { replayFrom: bytes, replayTo: reduced ? reduced.details.outputBytes : bytes };
		}
		bump(byFamily, family, bytes, { ...reducedExtra, ...replayExtra });
	}
	return { totalBytes, byTool, byFamily };
}

function mergeInto(target, source) {
	for (const [key, row] of source) {
		const existing = target.get(key) ?? { n: 0, bytes: 0, reducedN: 0, reducedFrom: 0, reducedTo: 0, replayFrom: 0, replayTo: 0 };
		for (const field of Object.keys(row)) existing[field] += row[field];
		target.set(key, existing);
	}
}

const fmtInt = (value) => String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
const pct = (part, total) => (total > 0 ? `${((100 * part) / total).toFixed(1)}%` : "-");

function printTable(title, map, total, top, replay) {
	console.log(`\n## ${title}`);
	const header = `${"family".padEnd(30)} ${"n".padStart(6)} ${"bytes".padStart(13)} ${"share".padStart(7)} ${"avg".padStart(8)} ${"reduced".padStart(8)} ${"saved".padStart(7)}${replay ? ` ${"replay saved".padStart(13)}` : ""}`;
	console.log(header);
	const rows = [...map.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, top);
	for (const [key, row] of rows) {
		const saved = row.reducedFrom > 0 ? pct(row.reducedFrom - row.reducedTo, row.reducedFrom) : "-";
		const replaySaved = row.replayFrom > 0 ? pct(row.replayFrom - row.replayTo, row.replayFrom) : "-";
		console.log(
			`${key.slice(0, 30).padEnd(30)} ${fmtInt(row.n).padStart(6)} ${fmtInt(row.bytes).padStart(13)} ${pct(row.bytes, total).padStart(7)} ${fmtInt(Math.round(row.bytes / Math.max(1, row.n))).padStart(8)} ${`${row.reducedN}/${row.n}`.padStart(8)} ${saved.padStart(7)}${replay ? ` ${replaySaved.padStart(13)}` : ""}`,
		);
	}
}

function gateReport(gate, byFamily) {
	let failed = false;
	for (const [family, floor] of Object.entries(gate)) {
		const row = byFamily.get(family);
		const share = row && row.replayFrom > 0 ? (row.replayFrom - row.replayTo) / row.replayFrom : 0;
		const ok = share >= floor;
		if (!ok) failed = true;
		console.log(`gate ${family}: replay saved ${(100 * share).toFixed(1)}% (floor ${(100 * floor).toFixed(0)}%) ${ok ? "OK" : "FAIL"}`);
	}
	return failed;
}

function main(argv) {
	const options = parseArgs(argv);
	if (options.corpus) {
		const { rows, byFamily } = replayCorpus(options.corpus);
		console.log(`corpus=${options.corpus} fixtures=${rows.length}`);
		console.log(`${"fixture".padEnd(20)} ${"family".padEnd(16)} ${"reducer".padEnd(12)} ${"bytes".padStart(8)} ${"reduced".padStart(8)} ${"saved".padStart(7)}`);
		for (const row of rows) {
			console.log(`${row.name.padEnd(20)} ${row.family.padEnd(16)} ${row.kind.padEnd(12)} ${fmtInt(row.from).padStart(8)} ${fmtInt(row.to).padStart(8)} ${pct(row.from - row.to, row.from).padStart(7)}`);
		}
		if (options.gate && gateReport(options.gate, byFamily)) process.exit(1);
		return;
	}
	const byTool = new Map();
	const byFamily = new Map();
	let totalBytes = 0;
	let sessions = 0;
	for (const target of options.targets) {
		for (const file of listSessionFiles(target)) {
			const result = censusSession(parseSessionEntries(file), { replay: options.replay });
			sessions += 1;
			totalBytes += result.totalBytes;
			mergeInto(byTool, result.byTool);
			mergeInto(byFamily, result.byFamily);
		}
	}
	console.log(`sessions=${sessions} tool result bytes=${fmtInt(totalBytes)}`);
	printTable("by tool", byTool, totalBytes, options.top, false);
	const bashBytes = [...byFamily.values()].reduce((sum, row) => sum + row.bytes, 0);
	printTable("bash and python by command family", byFamily, bashBytes, options.top, options.replay);
	const passthrough = [...byFamily.entries()]
		.filter(([, row]) => row.reducedN === 0 && (!options.replay || row.replayTo === row.replayFrom))
		.sort((a, b) => b[1].bytes - a[1].bytes)
		.slice(0, options.top);
	console.log("\n## passthrough families (no reducer touched them; the missed savings, largest first)");
	for (const [key, row] of passthrough) {
		console.log(`  ${key.slice(0, 30).padEnd(30)} ${fmtInt(row.bytes).padStart(13)} ${pct(row.bytes, bashBytes).padStart(7)} n=${row.n}`);
	}
	if (options.gate && gateReport(options.gate, byFamily)) process.exit(1);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
	main(process.argv.slice(2));
}
