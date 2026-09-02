#!/usr/bin/env node
/**
 * Turn the long-session profile report (host-session-profile.txt, written by
 * packages/coding-agent/test/profiling/host-long-session.profile.test.ts) into Markdown plus
 * ADVISORY GitHub warning annotations. Never fails: the profile job is a monitor the owner fires
 * on demand to see where the harness stands, not a merge gate.
 *
 * A row's growth is its last decile over its warm baseline -- the median of deciles two to five --
 * so JIT warm-up in the first tenth of calls does not read as growth. A flat row is ~1.0; a
 * re-walk of history shows as a rising row. Compaction resets the transcript mid-run, which can
 * hide growth in the last decile; the full decile row in the report artifact shows the shape.
 *
 * Usage: node scripts/report-long-session-growth.mjs <host-session-profile.txt> [host-session-pressure.txt]
 *        [--warn-ratio 2] [--min-n 40] [--request-budget-ms 25] [--tool-budget-ms 15]
 *
 * The optional second positional argument is the pressure report written alongside the profile
 * (host-session-pressure.txt, from the same test): when given, an advisory rss/heapUsed growth
 * table and the pressure totals line are appended. Omit it to keep the original single-file output.
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const positional = [];
let warnRatio = 2;
let minN = 40;
// Absolute advisory budgets for the warm baseline, in ms: the level a series sits at even when flat.
let requestBudgetMs = 25;
let toolBudgetMs = 15;
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--warn-ratio") warnRatio = Number(args[++i]);
	else if (args[i] === "--min-n") minN = Number(args[++i]);
	else if (args[i] === "--request-budget-ms") requestBudgetMs = Number(args[++i]);
	else if (args[i] === "--tool-budget-ms") toolBudgetMs = Number(args[++i]);
	else positional.push(args[i]);
}
const [file, pressureFile] = positional;
if (!file) {
	console.error("report-long-session-growth: report path required");
	process.exit(2);
}
// Shared warm-baseline/last/peak growth math, used for both the per-tool timing rows and the
// pressure (rss/heapUsed) rows: warm baseline is the median of deciles two through five (so
// JIT/cache warm-up in the first tenth is never read as growth), compared against the last decile
// and the peak decile (peak catches growth that a mid-run compaction reset before the last decile).
function computeGrowth(deciles, warnRatio) {
	const valid = deciles.filter((value) => Number.isFinite(value));
	if (valid.length < 5) return null;
	const warm = valid.slice(1, 5).sort((a, b) => a - b);
	const baseline = Math.max((warm[1] + warm[2]) / 2, 0.5);
	const last = valid[valid.length - 1];
	const peak = Math.max(...valid.slice(1));
	const growth = last / baseline;
	const peakGrowth = peak / baseline;
	const status = Math.max(growth, peakGrowth) > warnRatio ? "⚠ growing" : "flat";
	return { baseline, last, peak, growth, peakGrowth, status };
}
const text = readFileSync(file, "utf-8");
const rows = [];
for (const line of text.split("\n")) {
	let match = line.match(/^host pre-request ms by decile:\s+(.+?)\s+\(n=(\d+)\)/);
	if (match) {
		rows.push({ name: "host pre-request", n: Number(match[2]), deciles: match[1].trim().split(/\s+/).map(Number) });
		continue;
	}
	match = line.match(/^tool (\S+)\s+n=\s*(\d+) ms by decile:\s+(.+)$/);
	if (match) rows.push({ name: `tool ${match[1]}`, n: Number(match[2]), deciles: match[3].trim().split(/\s+/).map(Number) });
}
const header = text.split("\n").find((line) => line.startsWith("turns=")) ?? "";
console.log(`### Long-session growth\n\n${header}\n`);
console.log("| series | n | warm baseline ms | last decile ms | peak decile ms | last/base | peak/base | status |\n|---|---:|---:|---:|---:|---:|---:|---|");
for (const row of rows) {
	const result = computeGrowth(row.deciles, warnRatio);
	if (!result) continue;
	const { baseline, last, peak, growth, peakGrowth } = result;
	const eligible = row.n >= minN;
	const status = eligible ? result.status : "too few samples";
	console.log(
		`| ${row.name} | ${row.n} | ${baseline.toFixed(1)} | ${last.toFixed(1)} | ${peak.toFixed(1)} | ${growth.toFixed(2)}x | ${peakGrowth.toFixed(2)}x | ${status} |`,
	);
	const budget = row.name === "host pre-request" ? requestBudgetMs : toolBudgetMs;
	if (eligible && baseline > budget) {
		console.log(`::warning title=Long-session cost::${row.name}: warm baseline ${baseline.toFixed(1)}ms exceeds the ${budget}ms advisory budget`);
	}
	if (eligible && result.status === "⚠ growing") {
		console.log(`::warning title=Long-session growth::${row.name}: peak decile ${peak.toFixed(1)}ms, last ${last.toFixed(1)}ms vs warm baseline ${baseline.toFixed(1)}ms (${peakGrowth.toFixed(2)}x peak over ${row.n} calls) exceeds ${warnRatio}x`);
	}
}
for (const line of text.split("\n")) {
	if (line.startsWith("tool error:")) console.log(`::warning title=Long-session profile tool error::${line.slice(0, 500)}`);
}
console.log("");

// Advisory memory growth, from the pressure report's decile table: same warm-baseline/peak method
// as the timing rows above, applied to rss and heapUsed instead of per-call ms. Warnings only --
// this never fails the run, matching the timing table's contract.
if (pressureFile) {
	const pressureText = readFileSync(pressureFile, "utf-8");
	const rssDeciles = [];
	const heapDeciles = [];
	for (const line of pressureText.split("\n")) {
		const match = line.match(/^\s*(\d{1,2})\s+(\S+)\s+(\S+)\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s*$/);
		if (match) {
			rssDeciles.push(Number(match[2]));
			heapDeciles.push(Number(match[3]));
		}
	}
	const totalsLine = pressureText.split("\n").find((line) => line.startsWith("totals:")) ?? "";
	console.log("### Long-session pressure (memory)\n");
	console.log("| metric | warm baseline MB | last decile MB | peak decile MB | last/base | peak/base | status |\n|---|---:|---:|---:|---:|---:|---|");
	for (const [name, deciles] of [
		["rss", rssDeciles],
		["heapUsed", heapDeciles],
	]) {
		const result = computeGrowth(deciles, warnRatio);
		if (!result) continue;
		const { baseline, last, peak, growth, peakGrowth, status } = result;
		console.log(
			`| ${name} | ${baseline.toFixed(1)} | ${last.toFixed(1)} | ${peak.toFixed(1)} | ${growth.toFixed(2)}x | ${peakGrowth.toFixed(2)}x | ${status} |`,
		);
		if (status === "⚠ growing") {
			console.log(
				`::warning title=Long-session memory growth::${name}: peak decile ${peak.toFixed(1)}MB, last ${last.toFixed(1)}MB vs warm baseline ${baseline.toFixed(1)}MB (${peakGrowth.toFixed(2)}x peak) exceeds ${warnRatio}x`,
			);
		}
	}
	if (totalsLine) console.log(`\n${totalsLine}`);
	console.log("");
}
