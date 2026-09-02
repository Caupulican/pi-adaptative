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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const list = args.includes("--list");
const dirs = args.filter((arg) => !arg.startsWith("--"));
if (dirs.length === 0) {
	console.error("usage: node scripts/refusal-census.mjs <session-dir> [...] [--list]");
	process.exit(2);
}

function sessionFiles(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		const stats = statSync(path);
		if (stats.isDirectory()) out.push(...sessionFiles(path));
		else if (name.endsWith(".jsonl")) out.push(path);
	}
	return out;
}

function textOf(message) {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((part) => part && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join(" ");
}

function census(file) {
	const calls = new Map();
	let turns = 0;
	const refusals = [];
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
		if (message.role !== "toolResult" || message.isError !== true) continue;
		const text = textOf(message);
		if (!text.startsWith("[harness]")) continue;
		const known = calls.get(message.toolCallId);
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
	return { file, turns, refusals };
}

const results = dirs.flatMap((dir) => sessionFiles(dir).map(census));
let totalTurns = 0;
let totalRefusals = 0;
const perTool = new Map();
console.log(
	`${"session".padEnd(44)} ${"turns".padStart(6)} ${"refused".padStart(8)} ${"per100".padStart(7)}  by tool`,
);
for (const result of results) {
	totalTurns += result.turns;
	totalRefusals += result.refusals.length;
	const byTool = new Map();
	for (const refusal of result.refusals) {
		byTool.set(refusal.tool, (byTool.get(refusal.tool) ?? 0) + 1);
		perTool.set(refusal.tool, (perTool.get(refusal.tool) ?? 0) + 1);
	}
	const per100 = result.turns > 0 ? ((100 * result.refusals.length) / result.turns).toFixed(1) : "-";
	const name = result.file.split("/").slice(-2).join("/").slice(-44);
	console.log(
		`${name.padEnd(44)} ${String(result.turns).padStart(6)} ${String(result.refusals.length).padStart(8)} ${per100.padStart(7)}  ${[...byTool].map(([tool, count]) => `${tool}:${count}`).join(" ")}`,
	);
}
const totalPer100 = totalTurns > 0 ? ((100 * totalRefusals) / totalTurns).toFixed(1) : "-";
console.log(
	`${"TOTAL".padEnd(44)} ${String(totalTurns).padStart(6)} ${String(totalRefusals).padStart(8)} ${totalPer100.padStart(7)}  ${[...perTool].map(([tool, count]) => `${tool}:${count}`).join(" ")}`,
);
if (list) {
	console.log("\nrefusals (the slip corpus):");
	for (const result of results) {
		for (const refusal of result.refusals) {
			console.log(`  t${refusal.turn} ${refusal.tool} ${refusal.args.slice(0, 160)}`);
			console.log(`      -> ${refusal.diagnostic.slice(0, 220)}`);
		}
	}
}
