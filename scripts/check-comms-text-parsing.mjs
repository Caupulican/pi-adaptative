#!/usr/bin/env node
/**
 * Static scan: the machine-communication files never decide anything by parsing message text.
 *
 * A comms record is built by the code that owns the fact and carried in `details`; the text a model reads is a
 * rendering of it. A file listed below must therefore not call a parsing method (match, exec, test, search,
 * includes, startsWith, endsWith, indexOf, split) on a value named for message text (text, payload, content, message,
 * prompt, instructions, summary, output, body, reply) and must not hand such a value to a regex `test`/`exec`.
 * A line that must read persisted or foreign text written without a typed field (a legacy decoder) carries the
 * marker `comms-legacy-decoder: <reason>` on the same line or the line before, which names it in review.
 *
 * Deterministic and secret-free: it reads the tree and exits non-zero on a match. It is a static check, not a test.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = process.cwd();
const SOURCE = "packages/coding-agent/src";

/** Directories scanned recursively, and single files, that belong to the machine-communication surface. */
const COMMS_DIRECTORIES = [`${SOURCE}/core/comms`, `${SOURCE}/core/chat`];
const COMMS_FILES = [
	`${SOURCE}/core/foreground-terminal-handoff-controller.ts`,
	`${SOURCE}/core/tools/delegate.ts`,
	`${SOURCE}/core/tools/delegate-rejections.ts`,
	`${SOURCE}/core/tools/delegate-status.ts`,
	`${SOURCE}/core/delegation/worker-terminal-handoff-coordinator.ts`,
	`${SOURCE}/core/delegation/worker-report.ts`,
	`${SOURCE}/core/delegation/worker-claim.ts`,
	`${SOURCE}/core/delegation/worker-agent-control-coordinator.ts`,
	`${SOURCE}/core/delegation/worker-agent-wait.ts`,
	`${SOURCE}/core/delegation/worker-control-transcript.ts`,
	`${SOURCE}/core/delegation/worker-reply-routing.ts`,
	`${SOURCE}/core/delegation/worker-task-reconciliation.ts`,
	`${SOURCE}/core/delegation/worker-terminal-handoff-content.ts`,
	`${SOURCE}/core/delegation/worker-conversation-store.ts`,
	`${SOURCE}/core/delegation/worker-runner.ts`,
	`${SOURCE}/core/delegation/sanitized-context-fork.ts`,
	`${SOURCE}/core/delegation/persistent-bot-team-store.ts`,
	`${SOURCE}/core/delegation/routine-run-state.ts`,
	`${SOURCE}/core/delegation/routine-occurrence-journal.ts`,
	`${SOURCE}/core/delegation/routine-result-writes.ts`,
	`${SOURCE}/core/delegation/routine-claim-admission.ts`,
	`${SOURCE}/core/delegation/routine-intake-state.ts`,
	`${SOURCE}/core/delegation/routine-trigger-writes.ts`,
	`${SOURCE}/core/delegation/worker-disposition.ts`,
	`${SOURCE}/core/autonomy/host-findings.ts`,
	`${SOURCE}/core/rule-hooks/rule-hook-delivery.ts`,
	`${SOURCE}/modes/interactive/components/custom-message.ts`,
	`${SOURCE}/kernel/tool-failure-ledger-record.ts`,
	`${SOURCE}/kernel/tool-result-progress.ts`,
	`${SOURCE}/core/tasks/task-directory-context.ts`,
	`${SOURCE}/core/context/path-alias-session.ts`,
	`${SOURCE}/kernel/tool-failure-recovery-gate.ts`,
	`${SOURCE}/core/provider-request-context-controller.ts`,
	`${SOURCE}/kernel/transient-records.ts`,
	`${SOURCE}/kernel/tool-failure-memory.ts`,
	`${SOURCE}/core/background-tool-task-controller.ts`,
];

const LEGACY_MARKER = "comms-legacy-decoder:";
const TEXT_WORDS = ["text", "payload", "content", "message", "msg", "body", "output", "prompt", "instructions", "summary", "reply"];
const PARSING_METHODS = "match|matchAll|exec|test|search|includes|startsWith|endsWith|indexOf|split";
const CAPITALIZED_TEXT_WORDS = TEXT_WORDS.map((word) => word[0].toUpperCase() + word.slice(1));
/** A value named for message text: the bare lower-case word, or a camelCase name that ends in it (taskText, claimSummary). */
const TEXT_VALUE = `(?:\\b(?:${TEXT_WORDS.join("|")})|[\\w$]*(?:${CAPITALIZED_TEXT_WORDS.join("|")}))`;

// `value.method(` on such a value (the call may continue on the next line), and a regex or string
// `test`/`exec`/`match` handed such a value.
const CALL_ON_TEXT = new RegExp(`(?<![\\w$])${TEXT_VALUE}\\s*\\??\\.\\s*(?:${PARSING_METHODS})\\s*\\(`, "g");
const TEXT_AS_ARGUMENT = new RegExp(`\\.(?:test|exec|match)\\(\\s*(?:[\\w$]+\\??\\.)*${TEXT_VALUE}\\s*[),]`, "g");

function listTypeScript(directory) {
	const found = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) found.push(...listTypeScript(path));
		else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) found.push(path);
	}
	return found;
}

function isCommentLine(line) {
	const trimmed = line.trim();
	return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

function scanSource(source) {
	const lines = source.split("\n");
	const lineStarts = [];
	let offset = 0;
	for (const line of lines) {
		lineStarts.push(offset);
		offset += line.length + 1;
	}
	const lineOf = (index) => {
		let low = 0;
		let high = lineStarts.length - 1;
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			if (lineStarts[middle] <= index) low = middle;
			else high = middle - 1;
		}
		return low;
	};
	const violations = new Map();
	for (const pattern of [CALL_ON_TEXT, TEXT_AS_ARGUMENT]) {
		for (const match of source.matchAll(pattern)) {
			const index = lineOf(match.index);
			if (isCommentLine(lines[index])) continue;
			const marked = lines[index].includes(LEGACY_MARKER) || (index > 0 && lines[index - 1].includes(LEGACY_MARKER));
			if (!marked) violations.set(index, { line: index + 1, text: lines[index].trim() });
		}
	}
	return [...violations.values()].sort((left, right) => left.line - right.line);
}

const files = [
	...COMMS_DIRECTORIES.flatMap((directory) => listTypeScript(join(REPO_ROOT, directory))),
	...COMMS_FILES.map((file) => join(REPO_ROOT, file)),
];

const failures = [];
for (const file of files) {
	for (const violation of scanSource(readFileSync(file, "utf8"))) {
		failures.push(`${relative(REPO_ROOT, file)}:${violation.line}: ${violation.text}`);
	}
}

if (failures.length > 0) {
	console.error("Comms text-parsing check failed: a comms file decides by parsing message text.");
	console.error(
		`Read the record's typed field instead, or mark a legacy decoder with "${LEGACY_MARKER} <reason>" on the line or the line before.`,
	);
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
console.log(`Comms text-parsing check passed (${files.length} files).`);
