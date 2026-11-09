#!/usr/bin/env node
/**
 * Legacy-marker ratchet: an exported symbol under packages/coding-agent/src whose name contains
 * "legacy" or whose JSDoc says "legacy" must carry a `@deprecated` line that names its replacement
 * and its removal condition, or be listed in scripts/legacy-markers-baseline.json. The baseline is
 * shrink-only: a listed symbol that gained `@deprecated`, or that no longer exists, fails until it is
 * removed from the list.
 *
 * Scope is exported declarations only. Inline `comms-legacy-decoder:` comments mark decoding branches
 * inside functions and are not exported entry points, so they are outside this ratchet.
 *
 *   node scripts/check-legacy-markers.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readText, repoRelative, walkTypeScriptFiles } from "./lib/ratchet-files.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = join(root, "packages/coding-agent/src");
const baselinePath = join(root, "scripts/legacy-markers-baseline.json");
const baseline = JSON.parse(readText(baselinePath));
const listed = new Set(baseline.entries);

const declaration =
	/^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;

/** Doc block directly above line `index` (empty when there is none). */
function docAbove(lines, index) {
	let end = index - 1;
	if (end < 0 || !/\*\/\s*$/.test(lines[end])) return [];
	let start = end;
	while (start >= 0 && !/^\s*\/\*\*/.test(lines[start])) start--;
	return start >= 0 ? lines.slice(start, end + 1) : [];
}

/** Every exported declaration in scope, keyed `path#name`, with whether it carries @deprecated. */
const scoped = new Map();
for (const path of walkTypeScriptFiles(sourceRoot)) {
	const lines = readFileSync(path, "utf8").split("\n");
	const key = repoRelative(root, path);
	lines.forEach((line, index) => {
		const match = line.match(declaration);
		if (!match) return;
		const name = match[1];
		const doc = docAbove(lines, index).join("\n");
		if (!/legacy/i.test(name) && !/\blegacy\b/i.test(doc)) return;
		scoped.set(`${key}#${name}`, /@deprecated\b/.test(doc));
	});
}

const failures = [];
for (const [key, deprecated] of scoped) {
	if (!deprecated && !listed.has(key)) {
		failures.push(
			`${key}: is legacy by name or JSDoc and has no @deprecated line. Add "@deprecated <replacement>; remove <condition>." to its JSDoc.`,
		);
	}
}
for (const key of listed) {
	if (!scoped.has(key)) {
		const [file] = key.split("#");
		const gone = !existsSync(join(root, file));
		failures.push(
			`${key}: ${gone ? "its file no longer exists" : "is no longer a legacy export"}. Remove "${key}" from scripts/legacy-markers-baseline.json.`,
		);
	} else if (scoped.get(key)) {
		failures.push(`${key}: now carries @deprecated. Remove "${key}" from scripts/legacy-markers-baseline.json.`);
	}
}

if (failures.length > 0) {
	console.error("check-legacy-markers: the legacy-marker ratchet failed:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
const tagged = [...scoped.values()].filter(Boolean).length;
console.log(
	`check-legacy-markers: ${scoped.size} legacy export(s), ${tagged} with @deprecated, ${listed.size} remaining in the shrink-only baseline.`,
);
