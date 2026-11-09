#!/usr/bin/env node
/**
 * Generates docs/architecture.md, the navigation map of the harness. It has three parts: one line per
 * top-level directory outside core (kernel, modes, the AI package and the TUI package), one row per
 * kernel module taken from that file's own header comment, and one paragraph per controller and per
 * extracted session module under packages/coding-agent/src/core, taken from the same header comments,
 * plus whether a test file of the same name exists. Line counts are deliberately not in the map (they
 * would make it stale on every edit; the line ratchets live in check-file-size and check-coordinator-
 * boundaries). The map is the bus-factor artifact of the harness ratchet model: whoever reads it holds
 * the whole design at the level of who owns what. docs/vocabulary.md defines the words it uses.
 *
 *   node scripts/architecture-map.mjs            # writes docs/architecture.md
 *   node scripts/architecture-map.mjs --check    # exits 1 when the file is stale
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const codingAgentSrc = join(root, "packages/coding-agent/src");
const core = join(codingAgentSrc, "core");
const kernel = join(codingAgentSrc, "kernel");
const tests = join(root, "packages/coding-agent/test");
const out = join(root, "docs/architecture.md");

/**
 * One line per directory outside core. Written by hand because these directories have no single entry
 * file with a header; the script fails when a listed directory disappears, so the line cannot outlive
 * its directory.
 */
const DIRECTORIES = [
	{
		path: "packages/coding-agent/src/kernel",
		owns:
			"Provider-neutral harness kernel: the agent loop, message and usage model, request budgeting and planning, compaction, session storage and reliability primitives. It imports nothing else from coding-agent (`scripts/check-kernel-layer.mjs`).",
	},
	{
		path: "packages/coding-agent/src/modes",
		owns:
			"The run modes of the coding agent (interactive terminal, print and RPC), plus the JSON event projection and termination signals they share.",
	},
	{
		path: "packages/ai/src",
		owns:
			"The provider-neutral model layer: the API and model registries and the generated model catalog, provider adapters under `providers/`, shared stream and validation utilities under `utils/`.",
	},
	{
		path: "packages/tui/src",
		owns:
			"The terminal UI toolkit: terminal and input handling, the editor, key bindings and kill ring, the renderer (`tui.ts`), and the component library under `components/`.",
	},
];

function headerSentence(path) {
	const text = readFileSync(path, "utf8");
	// The same opening rule as the header ratchet (scripts/lib/ratchet-files.mjs): a leading /** block, one line or many.
	const match = text.match(/^﻿?\s*\/\*\*([\s\S]*?)\*\//);
	if (!match) return "(no header comment)";
	const body = match[1]
		.split("\n")
		.map((line) => line.replace(/^\s*\*\s?/, "").trim())
		.filter((line) => line && !line.startsWith("@"))
		.join(" ");
	const sentence = body.match(/^(.*?[.!?])(\s|$)/);
	return (sentence ? sentence[1] : body).slice(0, 320);
}

function walkTypeScript(directory, out = []) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) walkTypeScript(path, out);
		else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(path);
	}
	return out.sort();
}

function escapeCell(text) {
	return text.replace(/\|/g, "\\|");
}

/** A listed directory's line: its index file's header when that file has one, otherwise the hand line. */
function directoryOwns(entry) {
	const index = join(root, entry.path, "index.ts");
	if (existsSync(index)) {
		const sentence = headerSentence(index);
		if (sentence !== "(no header comment)") return sentence;
	}
	return entry.owns;
}

/** Immediate subdirectories of each listed directory, with the header of their index file when they have one. */
const subdirectoryRowsOf = () => DIRECTORIES.flatMap((entry) =>
	readdirSync(join(root, entry.path), { withFileTypes: true })
		.filter((item) => item.isDirectory())
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((item) => {
			const index = join(root, entry.path, item.name, "index.ts");
			return {
				path: `${entry.path}/${item.name}`,
				sentence: existsSync(index) ? headerSentence(index) : "(no index.ts)",
			};
		}),
);

const missing = DIRECTORIES.filter((entry) => {
	const path = join(root, entry.path);
	return !existsSync(path) || !statSync(path).isDirectory();
});
if (missing.length > 0) {
	console.error(`architecture-map: listed directories do not exist: ${missing.map((entry) => entry.path).join(", ")}`);
	process.exit(1);
}

const kernelRows = walkTypeScript(kernel).map((path) => ({
	name: relative(kernel, path).split(sep).join("/"),
	sentence: headerSentence(path),
}));

const coreFiles = readdirSync(core)
	.filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))
	.filter((name) => name.endsWith("-controller.ts") || name.startsWith("agent-session") || name === "capability-tier.ts")
	.sort();

const coreRows = coreFiles.map((name) => {
	const path = join(core, name);
	const testName = name.replace(/\.ts$/, ".test.ts");
	const hasTest = existsSync(join(tests, testName)) || existsSync(join(tests, "suite", testName));
	return { name, sentence: headerSentence(path), hasTest };
});

const lines = [
	"# Architecture map",
	"",
	"Generated by `node scripts/architecture-map.mjs` from the header comments of the modules listed",
	"below, plus the directory summaries the script holds. Regenerate after adding, extracting or moving a",
	"module; `--check` fails when this file is stale. The words used here are defined in",
	"[vocabulary.md](vocabulary.md). The invariants these modules enforce are in `docs/doctrine.md`.",
	"",
	"## Directories",
	"",
	"| Directory | What it owns |",
	"|---|---|",
	...DIRECTORIES.map((entry) => `| \`${entry.path}/\` | ${escapeCell(directoryOwns(entry))} |`),
	"",
	"## Subdirectories",
	"",
	"| Directory | Index header |",
	"|---|---|",
	...subdirectoryRowsOf().map((row) => `| \`${row.path}/\` | ${escapeCell(row.sentence)} |`),
	"",
	"## kernel/ modules",
	"",
	"| Module | What it owns |",
	"|---|---|",
	...kernelRows.map((row) => `| \`kernel/${row.name}\` | ${escapeCell(row.sentence)} |`),
	"",
	`${kernelRows.length} kernel modules, ${kernelRows.filter((row) => row.sentence !== "(no header comment)").length} with a header comment.`,
	"",
	"## Controller and session modules (packages/coding-agent/src/core)",
	"",
	"| Module | Own test | What it owns |",
	"|---|---|---|",
	...coreRows.map((row) => `| \`${row.name}\` | ${row.hasTest ? "yes" : "no"} | ${escapeCell(row.sentence)} |`),
	"",
	`${coreRows.length} modules, ${coreRows.filter((row) => row.hasTest).length} with a test file of the same name.`,
	"",
];
const rendered = `${lines.join("\n")}\n`;
if (process.argv.includes("--check")) {
	const current = existsSync(out) ? readFileSync(out, "utf8") : "";
	if (current !== rendered) {
		console.error("architecture-map: docs/architecture.md is stale; run node scripts/architecture-map.mjs");
		process.exit(1);
	}
	console.log("architecture-map: up to date");
} else {
	writeFileSync(out, rendered);
	console.log(`architecture-map: wrote ${out} (${DIRECTORIES.length} directories, ${kernelRows.length} kernel modules, ${coreRows.length} core modules)`);
}
