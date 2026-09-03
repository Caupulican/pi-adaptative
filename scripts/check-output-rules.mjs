#!/usr/bin/env node
/**
 * Runs the inline tests of every output rule the runtime would load: the bundled rules, the project
 * file (`.pi/output-filters.json`) when present, and any file passed as an argument. Exits 1 on the
 * first defective file or failing sample, naming the rule and the diff.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = fileURLToPath(new URL(".", import.meta.url));
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { BUNDLED_OUTPUT_RULES } = await jiti.import(
	resolve(here, "../packages/coding-agent/src/core/tools/output-rules.bundled.ts"),
);
const { readOutputRulesFile, runOutputRuleTests } = await jiti.import(
	resolve(here, "../packages/coding-agent/src/core/tools/output-rules.ts"),
);

export function collectRuleSets(argv, cwd) {
	const sets = [{ source: "bundled", rules: BUNDLED_OUTPUT_RULES }];
	const projectFile = resolve(cwd, ".pi", "output-filters.json");
	const files = [...(existsSync(projectFile) ? [projectFile] : []), ...argv.map((path) => resolve(cwd, path))];
	for (const file of files) sets.push({ source: file, rules: readOutputRulesFile(file) });
	return sets;
}

export function checkRuleSets(sets) {
	const failures = [];
	let tested = 0;
	for (const set of sets) {
		for (const rule of set.rules) {
			if (!rule.definition.tests || rule.definition.tests.length === 0) {
				failures.push({ rule: rule.definition.name, source: set.source, index: -1, expected: "", actual: "" });
			}
			tested += rule.definition.tests?.length ?? 0;
		}
		failures.push(...runOutputRuleTests(set.rules));
	}
	return { failures, tested, rules: sets.reduce((count, set) => count + set.rules.length, 0) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	let result;
	try {
		result = checkRuleSets(collectRuleSets(process.argv.slice(2), process.cwd()));
	} catch (error) {
		console.error(`check-output-rules: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
	for (const failure of result.failures) {
		if (failure.index === -1) {
			console.error(`check-output-rules: rule "${failure.rule}" (${failure.source}) has no inline tests`);
			continue;
		}
		console.error(`check-output-rules: rule "${failure.rule}" (${failure.source}) test #${failure.index + 1} failed`);
		console.error(`  expected: ${JSON.stringify(failure.expected)}`);
		console.error(`  actual:   ${JSON.stringify(failure.actual)}`);
	}
	if (result.failures.length > 0) process.exit(1);
	console.log(`check-output-rules: ${result.rules} rules, ${result.tested} inline tests passed`);
}
