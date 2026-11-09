#!/usr/bin/env node
/**
 * File-size ratchet: no TypeScript source file under packages/*\/src may exceed 1,200 lines unless it
 * is listed in scripts/file-size-ratchet.json with its current line count. A listed file may only
 * shrink. Growing it fails; a new file over the limit fails. A file that shrank (or fell to the limit) does not
 * fail the check, so lanes editing different files never collide on the json: `--update` lowers every entry to
 * the current size and drops the entries of files at or below the limit (it never raises one), so the list only
 * ever goes down.
 *
 * The coordinator line ceiling for packages/coding-agent/src/core/agent-session.ts is enforced by
 * check-coordinator-boundaries.mjs; the entry here records the same file's size and points there.
 * Generated files (`*.generated.ts`) are excluded: a generator owns their size and regenerating them
 * is not a change a person can split, so they can never be lowered and do not belong in the ratchet.
 *
 *   node scripts/check-file-size.mjs            # fails on growth, new oversized files, missing files
 *   node scripts/check-file-size.mjs --update   # lowers the json to the current sizes
 */
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { countLines, readText, repoRelative, walkTypeScriptFiles } from "./lib/ratchet-files.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const ratchetPath = join(root, "scripts/file-size-ratchet.json");
const ratchet = JSON.parse(readText(ratchetPath));
const limit = ratchet.limit;
const listed = ratchet.files;

const sourceRoots = readdirSync(join(root, "packages"))
	.map((name) => join(root, "packages", name, "src"))
	.filter((path) => existsSync(path) && statSync(path).isDirectory());

const sizes = new Map();
for (const sourceRoot of sourceRoots) {
	for (const path of walkTypeScriptFiles(sourceRoot)) {
		if (path.endsWith(".generated.ts")) continue;
		const lines = countLines(readText(path));
		if (lines > limit) sizes.set(repoRelative(root, path), lines);
	}
}

const failures = [];
const shrunk = [];
const dropped = [];
for (const [path, lines] of sizes) {
	if (!(path in listed)) {
		failures.push(
			`${path}: ${lines} lines is over the ${limit}-line limit and is not in scripts/file-size-ratchet.json. Split the file by responsibility; do not add a new entry.`,
		);
	} else if (lines > listed[path]) {
		failures.push(
			`${path}: grew from ${listed[path]} to ${lines} lines. A listed file may only shrink; move the new code into a module that owns it.`,
		);
	} else if (lines < listed[path]) {
		shrunk.push(`${path}: ${listed[path]} -> ${lines}`);
	}
}
for (const path of Object.keys(listed)) {
	if (!sizes.has(path)) {
		if (existsSync(join(root, path))) dropped.push(path);
		else
			failures.push(`${path}: is listed but does not exist. Remove its entry from scripts/file-size-ratchet.json.`);
	}
}

if (process.argv.includes("--update")) {
	const next = {};
	for (const [path, count] of Object.entries(listed)) {
		if (dropped.includes(path) || !existsSync(join(root, path))) continue;
		next[path] = Math.min(count, sizes.get(path) ?? count);
	}
	writeFileSync(ratchetPath, `${JSON.stringify({ ...ratchet, files: next }, null, "\t")}\n`);
	console.log(`check-file-size: lowered ${shrunk.length} entr(ies), dropped ${dropped.length}.`);
	process.exit(failures.length > 0 ? 1 : 0);
}

if (failures.length > 0) {
	console.error("check-file-size: the file-size ratchet failed:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
if (shrunk.length > 0 || dropped.length > 0)
	console.log(
		`check-file-size: ${shrunk.length} file(s) shrank and ${dropped.length} fell to the limit; run \`node scripts/check-file-size.mjs --update\` to lower the json.`,
	);
console.log(`check-file-size: ${sizes.size} file(s) over ${limit} lines, none grown.`);
