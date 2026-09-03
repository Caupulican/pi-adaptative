#!/usr/bin/env node
/**
 * Refusal census over recorded sessions: how often the harness refused a tool call the model made,
 * per 100 assistant turns and per tool, and the diagnostic of every refusal. A refusal is a
 * `[harness]` failure result (a validation rejection, a policy rejection, or a tool that returned
 * `isError` through the failure ledger); an ordinary operation outcome (a non-zero exit, a failing
 * test) is not a refusal and is not counted.
 *
 * This is the measure behind the surface-area gate of the harness ratchet model: a slip the
 * harness can absorb (a second spelling of the same intent) should normalize, and only a real
 * ambiguity should refuse, with the rule named. Run it on any directory of session `.jsonl` files:
 *
 *   node scripts/refusal-census.mjs <session-dir> [<session-dir>...] [--list]
 *
 * Prints one summary row per session and a total. `--list` also prints every refusal with its
 * tool, arguments, and diagnostic, which is the slip corpus.
 */
import { readFileSync } from "node:fs";

import { listSessionFiles, messageText } from "./session-stats-common.mjs";

const args = process.argv.slice(2);
const list = args.includes("--list");
const dirs = args.filter((arg) => !arg.startsWith("--"));
if (dirs.length === 0) {
	console.error("usage: node scripts/refusal-census.mjs <session-dir> [...] [--list]");
	process.exit(2);
}

const SHELL_CONTRACT_RE =
	/[a-z]+: unsupported flag|not supported by the Windows shell contract|Heredocs \('<<'\) are not supported|Nesting another shell/;

function census(file) {
	const calls = new Map();
	let turns = 0;
	const refusals = [];
	let outcomes = 0;
	const shellContract = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			turns += 1;
			for (const part of Array.isArray(message.content) ? message.content : []) {
				if (part && part.type === "toolCall") calls.set(part.id, { turn: turns, call: part });
			}
			continue;
		}
		if (message.role !== "toolResult") continue;
		const text = messageText(message.content, " ");
		const known = calls.get(message.toolCallId);
		if ((known?.call.name ?? message.toolName) === "bash" && SHELL_CONTRACT_RE.test(text)) {
			shellContract.push({
				turn: known?.turn ?? turns,
				command: String(known?.call.arguments?.command ?? "").replace(/\s+/g, " "),
				message: (text.match(SHELL_CONTRACT_RE) ?? [""])[0],
			});
		}
		if (message.isError !== true) continue;
		if (!text.startsWith("[harness]")) continue;
		// A tool reporting that its own operation ended badly (a timeout, a non-zero exit) is an
		// outcome the model must act on, not a harness refusal; it is counted apart.
		if (message.errorKind === "operation_outcome") {
			outcomes += 1;
			continue;
		}
		let diagnostic = text.slice(0, 200);
		try {
			const record = JSON.parse(text.slice("[harness] ".length));
			diagnostic = record.diagnostic ?? record.next_action ?? diagnostic;
		} catch {}
		refusals.push({
			turn: known?.turn ?? turns,
			tool: known?.call.name ?? message.toolName ?? "?",
			args: JSON.stringify(known?.call.arguments ?? {}),
			diagnostic: String(diagnostic).replace(/\s+/g, " "),
		});
	}
	return { file, turns, refusals, outcomes, shellContract };
}

const results = dirs.flatMap((dir) => listSessionFiles(dir).map(census));
let totalTurns = 0;
let totalRefusals = 0;
let totalOutcomes = 0;
let totalShellContract = 0;
const perTool = new Map();
console.log(
	`${"session".padEnd(44)} ${"turns".padStart(6)} ${"refused".padStart(8)} ${"per100".padStart(7)} ${"outcomes".padStart(8)} ${"shell".padStart(5)}  by tool`,
);
for (const result of results) {
	totalTurns += result.turns;
	totalRefusals += result.refusals.length;
	totalOutcomes += result.outcomes;
	totalShellContract += result.shellContract.length;
	const byTool = new Map();
	for (const refusal of result.refusals) {
		byTool.set(refusal.tool, (byTool.get(refusal.tool) ?? 0) + 1);
		perTool.set(refusal.tool, (perTool.get(refusal.tool) ?? 0) + 1);
	}
	const per100 = result.turns > 0 ? ((100 * result.refusals.length) / result.turns).toFixed(1) : "-";
	const name = result.file.split("/").slice(-2).join("/").slice(-44);
	console.log(
		`${name.padEnd(44)} ${String(result.turns).padStart(6)} ${String(result.refusals.length).padStart(8)} ${per100.padStart(7)} ${String(result.outcomes).padStart(8)} ${String(result.shellContract.length).padStart(5)}  ${[...byTool].map(([tool, count]) => `${tool}:${count}`).join(" ")}`,
	);
}
const totalPer100 = totalTurns > 0 ? ((100 * totalRefusals) / totalTurns).toFixed(1) : "-";
console.log(
	`${"TOTAL".padEnd(44)} ${String(totalTurns).padStart(6)} ${String(totalRefusals).padStart(8)} ${totalPer100.padStart(7)} ${String(totalOutcomes).padStart(8)} ${String(totalShellContract).padStart(5)}  ${[...perTool].map(([tool, count]) => `${tool}:${count}`).join(" ")}`,
);
if (list) {
	console.log("\nrefusals (the slip corpus):");
	for (const result of results) {
		for (const refusal of result.refusals) {
			console.log(`  t${refusal.turn} ${refusal.tool} ${refusal.args.slice(0, 160)}`);
			console.log(`      -> ${refusal.diagnostic.slice(0, 220)}`);
		}
	}
	console.log("\nshell-contract refusals (Windows shell contract corpus):");
	for (const result of results) {
		for (const item of result.shellContract) {
			console.log(`  t${item.turn} ${item.message} :: ${item.command.slice(0, 200)}`);
		}
	}
}
