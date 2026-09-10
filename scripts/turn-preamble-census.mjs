#!/usr/bin/env node
/**
 * Turn preamble census: what the model calls before its first piece of real work, per turn kind.
 *
 * Reads session JSONL files (pass paths or globs expanded by the shell) and, for every assistant
 * turn, classifies the turn by what triggered it — a root prompt from the operator, a short ping,
 * a goal continuation, a reflection turn, a background wake — then counts the bookkeeping tool
 * calls made before the first work tool (read/edit/write/bash/python/grep/find/ls/repo_read) or the
 * turn's answer. The output names the directive each preamble tool answers to, so a prompt change
 * can be measured before and after instead of guessed. Read-only; never edits a prompt.
 *
 *   node scripts/turn-preamble-census.mjs ~/.pi/agent/sessions/*\/2026-09-*.jsonl
 *   node scripts/turn-preamble-census.mjs --json ... > census.json
 */
import fs from "node:fs";

const WORK_TOOLS = new Set(["read", "edit", "write", "bash", "python", "grep", "find", "ls", "repo_read", "webfetch"]);
const PREAMBLE_DIRECTIVES = {
	skill: "PI SKILLS (skill search before specialised work)",
	get_goal: "PI WORK LIFECYCLE / goal contract (read the goal before continuing)",
	create_goal: "PI WORK LIFECYCLE (durable goal for persistent work)",
	goal: "PI WORK LIFECYCLE (legacy goal tool)",
	update_goal: "PI WORK LIFECYCLE (progress record)",
	task_steps: "PI WORK LIFECYCLE (plan before mutation; task_steps owns the plan)",
	task_directory: "task directory admission (status/select before file work)",
	memory: "PI MEMORY (query durable memory)",
	delegate: "PI DELEGATION (status/list before work)",
	tool_task: "background tool collection (wait/list)",
};
const PING_MAX_CHARS = 40;
const TRIGGER_CUSTOM_TYPE_RE = /trigger|wake|continuation|reflection|steer|follow/i;

function turnKind(trigger) {
	if (!trigger) return "unknown";
	if (trigger.role === "user") {
		const text = messageText(trigger);
		return text.trim().length <= PING_MAX_CHARS ? "ping" : "root";
	}
	if (trigger.role === "custom") {
		const type = trigger.customType ?? "";
		if (type.includes("reflection")) return "reflection";
		if (type.includes("goal_continuation")) return "continuation";
		if (type.includes("wake") || type.includes("tool_task") || type.includes("terminal")) return "wake";
		return `custom:${type}`;
	}
	return trigger.role;
}

function messageText(message) {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

function census(files) {
	const kinds = new Map();
	const kind = (name) => {
		let entry = kinds.get(name);
		if (!entry) {
			entry = { turns: 0, withPreamble: 0, preambleCalls: 0, requests: 0, tools: new Map(), sequences: new Map() };
			kinds.set(name, entry);
		}
		return entry;
	};
	let sessions = 0;
	for (const file of files) {
		let lines;
		try {
			lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
		} catch {
			continue;
		}
		sessions++;
		let trigger;
		let preamble = [];
		let working = false;
		let turnOpen = false;
		let requestsInTurn = 0;
		const closeTurn = () => {
			if (!turnOpen) return;
			const entry = kind(turnKind(trigger));
			entry.turns++;
			entry.requests += requestsInTurn;
			if (preamble.length > 0) {
				entry.withPreamble++;
				entry.preambleCalls += preamble.length;
				for (const name of preamble) entry.tools.set(name, (entry.tools.get(name) ?? 0) + 1);
				const sequence = preamble.slice(0, 6).join(" → ");
				entry.sequences.set(sequence, (entry.sequences.get(sequence) ?? 0) + 1);
			}
			turnOpen = false;
			preamble = [];
			working = false;
			requestsInTurn = 0;
		};
		for (const line of lines) {
			let record;
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}
			if (record.type === "request_snapshot") {
				if (turnOpen) requestsInTurn++;
				continue;
			}
			// Continuation, reflection and wake records are `custom_message` entries; context blocks
			// (memory, skills, goal context) ride along a turn and never start one.
			if (record.type === "custom_message") {
				if (TRIGGER_CUSTOM_TYPE_RE.test(String(record.customType ?? ""))) {
					closeTurn();
					trigger = { role: "custom", customType: record.customType, content: record.content };
					turnOpen = true;
				}
				continue;
			}
			if (record.type !== "message") continue;
			const message = record.message;
			if (
				message.role === "user" ||
				(message.role === "custom" && TRIGGER_CUSTOM_TYPE_RE.test(String(message.customType ?? "")))
			) {
				closeTurn();
				trigger = message;
				turnOpen = true;
				continue;
			}
			if (message.role === "assistant" && turnOpen) {
				for (const part of message.content ?? []) {
					if (part.type !== "toolCall" || working) continue;
					const name = String(part.name ?? "");
					if (WORK_TOOLS.has(name)) working = true;
					else preamble.push(name);
				}
			}
		}
		closeTurn();
	}
	const top = (map, count) =>
		[...map.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, count)
			.map(([name, n]) => ({ name, count: n }));
	const report = { sessions, kinds: {} };
	for (const [name, entry] of [...kinds.entries()].sort((a, b) => b[1].turns - a[1].turns)) {
		report.kinds[name] = {
			turns: entry.turns,
			withPreamble: entry.withPreamble,
			preambleShare: entry.turns ? Number((entry.withPreamble / entry.turns).toFixed(2)) : 0,
			preambleCallsPerTurn: entry.turns ? Number((entry.preambleCalls / entry.turns).toFixed(2)) : 0,
			requestsPerTurn: entry.turns ? Number((entry.requests / entry.turns).toFixed(2)) : 0,
			tools: top(entry.tools, 8).map((tool) => ({ ...tool, directive: PREAMBLE_DIRECTIVES[tool.name] ?? "(tool description)" })),
			sequences: top(entry.sequences, 6),
		};
	}
	return report;
}

function main(argv) {
	const json = argv.includes("--json");
	const files = argv.filter((arg) => !arg.startsWith("--"));
	if (files.length === 0) {
		console.error("usage: node scripts/turn-preamble-census.mjs [--json] <session.jsonl ...>");
		return 2;
	}
	const report = census(files);
	if (json) {
		console.log(JSON.stringify(report, null, 1));
		return 0;
	}
	console.log(`sessions: ${report.sessions}`);
	for (const [name, entry] of Object.entries(report.kinds)) {
		console.log(
			`\n${name}: ${entry.turns} turns · ${entry.withPreamble} with preamble (${Math.round(entry.preambleShare * 100)}%) · ${entry.preambleCallsPerTurn} preamble calls/turn · ${entry.requestsPerTurn} requests/turn`,
		);
		for (const tool of entry.tools) console.log(`  ${String(tool.count).padStart(5)}  ${tool.name.padEnd(16)} ${tool.directive}`);
		for (const sequence of entry.sequences) console.log(`  ${String(sequence.count).padStart(5)}  ${sequence.name}`);
	}
	return 0;
}

process.exitCode = main(process.argv.slice(2));
