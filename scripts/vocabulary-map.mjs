#!/usr/bin/env node
/**
 * Keeps the "Defined in" column of docs/vocabulary.md generated from the code. The table between the
 * vocabulary-map markers has one row per concept; its Type cell names the exported TypeScript symbol
 * that defines the concept, and this script writes the repository path of the one source file that
 * exports that symbol into the Defined in cell. Definitions, preferred terms and forbidden terms are
 * hand-written and never touched. A row whose type is not exported, or is exported from more than one
 * file, fails the check, so the column cannot point at a file that no longer defines the concept.
 *
 *   node scripts/vocabulary-map.mjs            # rewrites the generated column
 *   node scripts/vocabulary-map.mjs --check    # exits 1 when the column is stale or a row is broken
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRelative, walkTypeScriptFiles } from "./lib/ratchet-files.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const doc = join(root, "docs/vocabulary.md");
const START = "<!-- vocabulary-map:start -->";
const END = "<!-- vocabulary-map:end -->";
const SOURCE_ROOTS = ["packages/coding-agent/src", "packages/ai/src", "packages/tui/src"];
const HEADER = ["Concept", "Preferred term", "Meaning", "Type", "Defined in", "Do not use"];
/** A concept that has no single defining type (for example a state the code spreads over several types). */
const NO_TYPE = "—";

const declaration = (name) =>
	new RegExp(
		`^export\\s+(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?(?:abstract\\s+)?(?:type|interface|class|enum|const|let|var|function)\\s+${name}\\b`,
	);

/** Repository paths of every source file that exports `name` as a type, class, enum, const or function. */
function exportingFiles(name, index) {
	if (!index.has(name)) {
		const found = [];
		const pattern = declaration(name);
		for (const sourceRoot of SOURCE_ROOTS) {
			for (const path of walkTypeScriptFiles(join(root, sourceRoot))) {
				if (readFileSync(path, "utf8").split("\n").some((line) => pattern.test(line))) {
					found.push(repoRelative(root, path));
				}
			}
		}
		index.set(name, found);
	}
	return index.get(name);
}

const text = readFileSync(doc, "utf8");
const lines = text.split("\n");
const start = lines.indexOf(START);
const end = lines.indexOf(END);
if (start < 0 || end < 0 || end < start) {
	console.error(`vocabulary-map: ${doc} needs the ${START} and ${END} markers around the table`);
	process.exit(1);
}

const failures = [];
const index = new Map();
const out = [];
let concepts = 0;
const body = lines.slice(start + 1, end);
body.forEach((line, offset) => {
	const cells = line.trim().startsWith("|") ? line.split("|").slice(1, -1).map((cell) => cell.trim()) : undefined;
	if (!cells || cells.every((cell) => /^-+$/.test(cell))) {
		out.push(line);
		return;
	}
	if (cells.join("|") === HEADER.join("|")) {
		out.push(line);
		return;
	}
	const where = `${doc}:${start + 2 + offset}`;
	if (cells.length !== HEADER.length) {
		failures.push(`${where}: a vocabulary row needs ${HEADER.length} cells, found ${cells.length}`);
		out.push(line);
		return;
	}
	const [concept, preferred, meaning, typeName, , forbidden] = cells;
	if (typeName === NO_TYPE) {
		concepts++;
		out.push(`| ${concept} | ${preferred} | ${meaning} | ${NO_TYPE} | ${NO_TYPE} | ${forbidden} |`);
		return;
	}
	if (!/^[A-Za-z_$][\w$]*$/.test(typeName)) {
		failures.push(`${where}: the Type cell of "${concept}" must be one exported symbol name, found "${typeName}"`);
		out.push(line);
		return;
	}
	const files = exportingFiles(typeName, index);
	if (files.length === 0) {
		failures.push(`${where}: "${typeName}" is not exported from any source file; update the Type cell to the symbol that defines "${concept}"`);
		out.push(line);
		return;
	}
	if (files.length > 1) {
		failures.push(`${where}: "${typeName}" is exported from ${files.length} files (${files.join(", ")}); name one defining symbol`);
		out.push(line);
		return;
	}
	concepts++;
	out.push(`| ${concept} | ${preferred} | ${meaning} | ${typeName} | \`${files[0]}\` | ${forbidden} |`);
});

if (failures.length > 0) {
	console.error("vocabulary-map: the vocabulary table is broken:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}

const rendered = [...lines.slice(0, start + 1), ...out, ...lines.slice(end)].join("\n");
if (process.argv.includes("--check")) {
	if (rendered !== text) {
		console.error("vocabulary-map: docs/vocabulary.md is stale; run node scripts/vocabulary-map.mjs");
		process.exit(1);
	}
	console.log(`vocabulary-map: up to date (${concepts} concepts)`);
} else {
	writeFileSync(doc, rendered);
	console.log(`vocabulary-map: wrote ${doc}`);
}
