#!/usr/bin/env node
/**
 * Feature ledger over recorded sessions: what each subsystem costs per request and what it earns,
 * from the session files alone. This is the measurement behind the harness ratchet model's rule
 * that a subsystem without a benefit measurement gains no new surface: every row here is a number
 * a release census can compare, and a row that reads "unmeasured" is the work still owed.
 *
 *   node scripts/feature-ledger.mjs <session-dir> [<session-dir>...]
 *
 * Rows:
 * - cache economy: reuse p50 and the count of cold requests (cacheRead 0 after the first).
 * - host records: per custom record kind, records appended, distinct contents, chars persisted;
 *   a kind with many records and few distinct contents is a reconciliation defect.
 * - path aliasing: legend chars persisted versus chars saved by alias mentions in provider-bound
 *   text (display length minus id length per mention).
 * - failure ledger: refusals, ledger records, protocol prose chars persisted.
 * - context GC: packed tool results.
 * - delegation: delegate calls per worker started, worker claims reviewed without correction.
 * - skills and memory: record chars persisted.
 * - output cap: responses that ended at the cap (stopReason length).
 * - output reduction: tool results a reducer touched, bytes in and out, share saved.
 */
import { listSessionFiles, messageText, parseSessionEntries } from "./session-stats-common.mjs";
import { join } from "node:path";

const dirs = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
if (dirs.length === 0) {
	console.error("usage: node scripts/feature-ledger.mjs <session-dir> [...]");
	process.exit(2);
}

function median(values) {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const totals = {
	turns: 0,
	requestsWithUsage: 0,
	reuse: [],
	coldRequests: 0,
	records: new Map(), // kind -> { count, distinct (summed per session), chars }
	refusals: 0,
	packedToolResults: 0,
	delegateCalls: 0,
	workersStarted: 0,
	workerReviews: 0,
	workerCorrections: 0,
	aliasMentions: 0,
	aliasSavedChars: 0,
	legendChars: 0,
	lengthStops: 0,
	toolResults: 0,
	reducedResults: 0,
	reductionInputBytes: 0,
	reductionOutputBytes: 0,
};

for (const dir of dirs) {
	for (const file of listSessionFiles(dir)) {
		const entries = parseSessionEntries(file);
		const legend = new Map(); // id -> display
		const distinctPerKind = new Map(); // kind -> Set of contents in this session
		let first = true;
		const calls = new Map();
		for (const entry of entries) {
			if (entry.type === "custom_message") {
				const kind = entry.customType ?? "?";
				const text = String(entry.content ?? "");
				const row = totals.records.get(kind) ?? { count: 0, distinct: 0, chars: 0 };
				row.count += 1;
				const seen = distinctPerKind.get(kind) ?? new Set();
				if (!seen.has(text)) {
					seen.add(text);
					row.distinct += 1;
				}
				distinctPerKind.set(kind, seen);
				row.chars += text.length;
				totals.records.set(kind, row);
				if (kind === "path_alias_legend") {
					totals.legendChars += text.length;
					for (const line of text.split("\n")) {
						const eq = line.indexOf("=");
						if (line.startsWith("p/") && eq > 0) legend.set(line.slice(0, eq), line.slice(eq + 1));
					}
				}
				continue;
			}
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role === "assistant") {
				totals.turns += 1;
				if (message.stopReason === "length") totals.lengthStops += 1;
				const usage = message.usage;
				if (usage) {
					const total = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
					if (total > 0) {
						totals.requestsWithUsage += 1;
						totals.reuse.push((usage.cacheRead ?? 0) / total);
						if (!first && (usage.cacheRead ?? 0) === 0) totals.coldRequests += 1;
						first = false;
					}
				}
				for (const part of Array.isArray(message.content) ? message.content : []) {
					if (part?.type === "toolCall") {
						calls.set(part.id, part);
						if (part.name === "delegate") {
							totals.delegateCalls += 1;
							const action = part.arguments?.action;
							if (action === "start" || action === undefined) totals.workersStarted += 1;
							if (action === "review") totals.workerReviews += 1;
							if (action === "follow_up") totals.workerCorrections += 1;
						}
					}
					if (part?.type === "text") countAliases(part.text);
				}
				continue;
			}
			if (message.role === "toolResult") {
				totals.toolResults += 1;
				const reduction = message.details?.outputReduction;
				if (reduction && typeof reduction.inputBytes === "number" && typeof reduction.outputBytes === "number") {
					totals.reducedResults += 1;
					totals.reductionInputBytes += reduction.inputBytes;
					totals.reductionOutputBytes += reduction.outputBytes;
				}
				const text = messageText(message.content, "\n");
				if (message.isError && text.startsWith("[harness]")) totals.refusals += 1;
				if (text.includes("[Context GC packed")) totals.packedToolResults += 1;
				countAliases(text);
			}
		}
		// Aliases are applied at render time, never persisted: the session holds the display paths.
		// Every occurrence of a legend display path in provider-bound text was sent as its alias.
		function countAliases(text) {
			if (legend.size === 0 || typeof text !== "string") return;
			for (const [id, display] of legend) {
				if (!display) continue;
				let from = 0;
				for (;;) {
					const at = text.indexOf(display, from);
					if (at === -1) break;
					totals.aliasMentions += 1;
					totals.aliasSavedChars += Math.max(0, display.length - id.length);
					from = at + display.length;
				}
			}
		}
	}
}

const reuseP50 = median(totals.reuse);
const rows = [];
rows.push(["cache economy", `reuse p50 ${reuseP50 === undefined ? "-" : reuseP50.toFixed(2)}; cold requests ${totals.coldRequests}/${totals.requestsWithUsage}`, "floor 0.95 p50; cold requests explained by the transport telemetry"]);
const TRAILING_KINDS = new Set(["pi_tool_failure_ledger", "pi_verification_obligation"]);
for (const [kind, row] of [...totals.records].sort((a, b) => b[1].chars - a[1].chars)) {
	const verdict = TRAILING_KINDS.has(kind)
		? "trailing kind: re-appended while active, resolved after two later calls"
		: row.count > row.distinct * 2
			? "RECONCILIATION DEFECT (many records, few contents)"
			: "once per change";
	rows.push([`record ${kind}`, `${row.count} records, ${row.distinct} distinct, ${row.chars} chars`, verdict]);
}
const aliasNet = totals.aliasSavedChars - totals.legendChars;
rows.push(["path aliasing", `${totals.aliasMentions} mentions saved ${totals.aliasSavedChars} chars; legend cost ${totals.legendChars} chars; net ${aliasNet >= 0 ? "+" : ""}${aliasNet}`, aliasNet >= 0 ? "pays" : "COSTS MORE THAN IT SAVES"]);
rows.push(["failure ledger", `${totals.refusals} refusals in ${totals.turns} turns (${totals.turns ? ((100 * totals.refusals) / totals.turns).toFixed(1) : "-"} per 100)`, "ceiling 1 per 100 on the frontier tier"]);
rows.push(["context GC", `${totals.packedToolResults} packed tool results`, "measured"]);
rows.push(["delegation", `${totals.delegateCalls} delegate calls, ${totals.workersStarted} workers started, ${totals.workerReviews} reviews, ${totals.workerCorrections} follow-ups`, totals.workersStarted ? `${(totals.delegateCalls / totals.workersStarted).toFixed(1)} calls per worker` : "no workers"]);
rows.push(["output cap", `${totals.lengthStops} responses ended at the cap`, totals.lengthStops ? "inspect: a capped response is either a runaway or a cap set too low" : "none"]);
const reductionSaved = totals.reductionInputBytes - totals.reductionOutputBytes;
rows.push([
	"output reduction",
	`${totals.reducedResults}/${totals.toolResults} results reduced; ${totals.reductionInputBytes} bytes in, ${totals.reductionOutputBytes} out (saved ${totals.reductionInputBytes ? ((100 * reductionSaved) / totals.reductionInputBytes).toFixed(1) : "-"}%)`,
	totals.reducedResults ? "measured; passthrough families in scripts/output-reduction-census.mjs" : "no reduced results (session predates the pipeline or reduction is off)",
]);
for (const kind of ["reflection_turn_trigger", "reflection_cue"]) {
	if (!totals.records.has(kind)) rows.push([`record ${kind}`, "no records", "unmeasured benefit: needs skills promoted that are later loaded"]);
}
console.log(`sessions over ${totals.turns} assistant turns`);
for (const [feature, measure, verdict] of rows) {
	console.log(`${feature.padEnd(30)} ${measure.padEnd(80)} ${verdict}`);
}
