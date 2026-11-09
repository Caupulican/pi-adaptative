#!/usr/bin/env node
/**
 * Doctrine enforcement table: every rule in docs/doctrine.md (a paragraph that opens with a bold
 * sentence) carries an `Enforced by:` line naming the mechanism that checks it, or `prose only` when
 * none does. A repository path named in such a line must exist, so an enforcement claim cannot outlive
 * the script it names. The number of `prose only` rules may not exceed scripts/doctrine-prose-only-
 * baseline.json: that count only goes down, and a rule that gains a mechanism lowers it.
 *
 *   node scripts/check-doctrine-enforcement.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const doctrinePath = join(root, "docs/doctrine.md");
const baselinePath = join(root, "scripts/doctrine-prose-only-baseline.json");
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));

const lines = readFileSync(doctrinePath, "utf8").split("\n");
// A rule runs from its bold line to the line before the next bold rule line or "## " heading.
const rules = [];
for (let index = 0; index < lines.length; index++) {
	if (!lines[index].startsWith("**")) continue;
	let end = index + 1;
	while (end < lines.length && !lines[end].startsWith("**") && !lines[end].startsWith("## ")) end++;
	let last = end - 1;
	while (last > index && lines[last].trim() === "") last--;
	rules.push({ line: index + 1, span: lines.slice(index, last + 1) });
	index = last;
}

const failures = [];
let proseOnly = 0;
for (const rule of rules) {
	const label = `docs/doctrine.md:${rule.line} (${rule.span[0].slice(0, 60)}...)`;
	const enforcedLines = rule.span.filter((line) => line.startsWith("Enforced by: "));
	if (enforcedLines.length !== 1) {
		failures.push(`${label}: needs exactly one "Enforced by:" line, found ${enforcedLines.length}`);
		continue;
	}
	if (rule.span[rule.span.length - 1] !== enforcedLines[0]) {
		failures.push(`${label}: the "Enforced by:" line must be the last line of the rule`);
		continue;
	}
	const value = enforcedLines[0].slice("Enforced by: ".length).trim();
	if (value === "prose only") {
		proseOnly++;
		continue;
	}
	for (const [path] of value.matchAll(/((?:scripts|packages|\.github|\.husky)\/[^\s;()'"`]+)/g)) {
		const cleaned = path.replace(/[.,]+$/, "");
		if (!existsSync(join(root, cleaned))) {
			failures.push(`${label}: "Enforced by" names ${cleaned}, which does not exist`);
		}
	}
}

if (proseOnly > baseline.proseOnly) {
	failures.push(
		`${proseOnly} rules are "prose only"; the baseline allows ${baseline.proseOnly}. A rule may not lose its mechanism; add one or name the existing one.`,
	);
} else if (proseOnly < baseline.proseOnly) {
	failures.push(
		`${proseOnly} rules are "prose only" but scripts/doctrine-prose-only-baseline.json allows ${baseline.proseOnly}. Set "proseOnly" to ${proseOnly}.`,
	);
}

if (failures.length > 0) {
	console.error("check-doctrine-enforcement: the doctrine enforcement table failed:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
console.log(
	`check-doctrine-enforcement: ${rules.length} rules, ${rules.length - proseOnly} with a named mechanism, ${proseOnly} prose only (baseline ${baseline.proseOnly}).`,
);
