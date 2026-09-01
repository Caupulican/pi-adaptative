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
 * Usage: node scripts/report-long-session-growth.mjs <host-session-profile.txt> [--warn-ratio 2] [--min-n 40]
 *        [--request-budget-ms 25] [--tool-budget-ms 15]
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
let file;
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
	else file = args[i];
}
if (!file) {
	console.error("report-long-session-growth: report path required");
	process.exit(2);
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
	const valid = row.deciles.filter((value) => Number.isFinite(value));
	if (valid.length < 5) continue;
	const warm = valid.slice(1, 5).sort((a, b) => a - b);
	const baseline = Math.max((warm[1] + warm[2]) / 2, 0.5);
	const last = valid[valid.length - 1];
	// Peak catches growth that compaction reset before the last decile.
	const peak = Math.max(...valid.slice(1));
	const growth = last / baseline;
	const peakGrowth = peak / baseline;
	const eligible = row.n >= minN;
	const status = !eligible ? "too few samples" : Math.max(growth, peakGrowth) > warnRatio ? "⚠ growing" : "flat";
	console.log(
		`| ${row.name} | ${row.n} | ${baseline.toFixed(1)} | ${last.toFixed(1)} | ${peak.toFixed(1)} | ${growth.toFixed(2)}x | ${peakGrowth.toFixed(2)}x | ${status} |`,
	);
	const budget = row.name === "host pre-request" ? requestBudgetMs : toolBudgetMs;
	if (eligible && baseline > budget) {
		console.log(`::warning title=Long-session cost::${row.name}: warm baseline ${baseline.toFixed(1)}ms exceeds the ${budget}ms advisory budget`);
	}
	if (eligible && Math.max(growth, peakGrowth) > warnRatio) {
		console.log(`::warning title=Long-session growth::${row.name}: peak decile ${peak.toFixed(1)}ms, last ${last.toFixed(1)}ms vs warm baseline ${baseline.toFixed(1)}ms (${peakGrowth.toFixed(2)}x peak over ${row.n} calls) exceeds ${warnRatio}x`);
	}
}
for (const line of text.split("\n")) {
	if (line.startsWith("tool error:")) console.log(`::warning title=Long-session profile tool error::${line.slice(0, 500)}`);
}
console.log("");
