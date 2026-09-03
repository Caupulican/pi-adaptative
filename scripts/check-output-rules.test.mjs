import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkRuleSets, collectRuleSets } from "./check-output-rules.mjs";

test("bundled rules all carry passing inline tests", () => {
	const result = checkRuleSets(collectRuleSets([], mkdtempSync(join(tmpdir(), "pi-rules-none-"))));
	assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
	assert.ok(result.rules >= 3);
	assert.ok(result.tested >= result.rules);
});

test("a project file with a failing sample or a missing test is reported by rule name", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-rules-"));
	const file = join(dir, "rules.json");
	writeFileSync(
		file,
		JSON.stringify({
			rules: [
				{ name: "no-tests", match: "^foo", stripLinesMatching: ["^x"] },
				{ name: "wrong", match: "^bar", stripLinesMatching: ["^x"], tests: [{ input: "x\ny\n", expected: "x\n" }] },
			],
		}),
	);
	const result = checkRuleSets(collectRuleSets([file], dir));
	assert.deepEqual(
		result.failures.map((failure) => [failure.rule, failure.index]),
		[
			["no-tests", -1],
			["wrong", 0],
		],
	);
	assert.equal(result.failures[1].actual, "y\n");
});

test("a malformed project file fails with the file and rule named", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-rules-bad-"));
	const file = join(dir, "rules.json");
	writeFileSync(file, JSON.stringify({ rules: [{ name: "broken", match: "(" , stripLinesMatching: ["^x"] }] }));
	assert.throws(() => collectRuleSets([file], dir), /output rule "broken": match pattern/u);
});
