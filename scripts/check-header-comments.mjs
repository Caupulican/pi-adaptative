#!/usr/bin/env node
/**
 * Header-comment ratchet: every TypeScript module under packages/coding-agent/src/core, kernel and
 * modes opens with a `/** ... *\/` header that says what the module owns, so the navigation map
 * (docs/architecture.md) has a sentence for it. Modules that have no header yet are listed in
 * scripts/header-comments-baseline.json. A new module without a header fails; a listed module that
 * has gained a header fails until it is removed from the list, so the list only shrinks.
 *
 *   node scripts/check-header-comments.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hasLeadingDocHeader, repoRelative, walkTypeScriptFiles } from "./lib/ratchet-files.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const scope = ["packages/coding-agent/src/core", "packages/coding-agent/src/kernel", "packages/coding-agent/src/modes"];
const baselinePath = join(root, "scripts/header-comments-baseline.json");

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const listed = new Set(baseline.files);

const headerless = new Set();
const present = new Set();
for (const directory of scope) {
	for (const path of walkTypeScriptFiles(join(root, directory))) {
		const key = repoRelative(root, path);
		if (hasLeadingDocHeader(readFileSync(path, "utf8"))) present.add(key);
		else headerless.add(key);
	}
}

const failures = [];
for (const key of headerless) {
	if (!listed.has(key)) {
		failures.push(
			`${key}: has no leading /** */ header comment. Open the file with a one-sentence header that states what the module owns.`,
		);
	}
}
for (const key of listed) {
	if (present.has(key)) {
		failures.push(`${key}: has a header now. Remove "${key}" from scripts/header-comments-baseline.json.`);
	} else if (!existsSync(join(root, key))) {
		failures.push(`${key}: is listed but does not exist. Remove "${key}" from scripts/header-comments-baseline.json.`);
	}
}

if (failures.length > 0) {
	console.error("check-header-comments: the header ratchet failed:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
console.log(
	`check-header-comments: ${present.size} module(s) with a header; ${listed.size} headerless module(s) remain in the shrink-only baseline.`,
);
