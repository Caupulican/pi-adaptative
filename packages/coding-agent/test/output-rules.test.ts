/**
 * Data-driven rules: schema defects are named, operations are pure and ordered (strip, keep,
 * replace, maxLines, tailLines, onEmpty), inline tests run, later sources override by name, and the
 * rule reducer matches on the program and its arguments with prefixes folded away.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyCommandFamily } from "../src/core/tools/command-family.ts";
import { BUNDLED_OUTPUT_RULES } from "../src/core/tools/output-rules.bundled.ts";
import {
	applyOutputRule,
	compileOutputRule,
	compileOutputRulesDocument,
	createRuleOutputReducer,
	loadOutputRules,
	runOutputRuleTests,
} from "../src/core/tools/output-rules.ts";

const request = { tool: "bash", command: "", text: "", exitCode: 0, level: "standard" as const };

describe("compileOutputRule", () => {
	it("names the rule and the field on every defect", () => {
		expect(() => compileOutputRule({ match: "^x" }, "f.json")).toThrow(
			/f.json: every rule needs a non-empty "name"/u,
		);
		expect(() => compileOutputRule({ name: "r", match: "(", stripLinesMatching: ["^a"] }, "f")).toThrow(
			/output rule "r": match pattern "\(" is not a valid regular expression/u,
		);
		expect(() => compileOutputRule({ name: "r", match: "^x" }, "f")).toThrow(/needs at least one operation/u);
		expect(() => compileOutputRule({ name: "r", match: "^x", maxLines: 0 }, "f")).toThrow(
			/"maxLines" must be a positive integer/u,
		);
		expect(() => compileOutputRule({ name: "r", match: "^x", replace: [{ pattern: "a" }] }, "f")).toThrow(
			/"replace" must be/u,
		);
		expect(() => compileOutputRulesDocument({ nope: [] }, "f")).toThrow(/expected \{ "rules": \[...\] \}/u);
	});
});

describe("applyOutputRule", () => {
	it("applies strip, keep, replace, maxLines and tailLines in order", () => {
		const rule = compileOutputRule(
			{
				name: "r",
				match: "^x",
				stripLinesMatching: ["^noise"],
				keepLinesMatching: ["^keep", "^also"],
				replace: [{ pattern: "\\d+", with: "N" }],
				maxLines: 3,
				tailLines: 2,
			},
			"f",
		);
		const text = "noise 1\nkeep 1\nskip\nkeep 2\nalso 3\nkeep 4\n";
		expect(applyOutputRule(rule, text)).toEqual({
			text: "[2 earlier lines]\nalso N\n[1 more lines]\n",
			omittedLines: 3,
		});
	});

	it("emits onEmpty when everything was stripped and keeps the newline convention", () => {
		const rule = compileOutputRule({ name: "r", match: "^x", stripLinesMatching: ["."], onEmpty: "(quiet)" }, "f");
		expect(applyOutputRule(rule, "a\nb\n")).toEqual({ text: "(quiet)", omittedLines: 2 });
		const keep = compileOutputRule({ name: "k", match: "^x", stripLinesMatching: ["^a"] }, "f");
		expect(applyOutputRule(keep, "a\nb").text).toBe("b");
	});
});

describe("runOutputRuleTests / bundled rules", () => {
	it("every bundled rule has inline tests and they pass", () => {
		expect(BUNDLED_OUTPUT_RULES.length).toBeGreaterThanOrEqual(3);
		for (const rule of BUNDLED_OUTPUT_RULES) {
			expect(rule.definition.tests?.length ?? 0, rule.definition.name).toBeGreaterThan(0);
		}
		expect(runOutputRuleTests(BUNDLED_OUTPUT_RULES)).toEqual([]);
	});

	it("reports a failing sample with expected and actual text", () => {
		const rule = compileOutputRule(
			{ name: "r", match: "^x", stripLinesMatching: ["^a"], tests: [{ input: "a\nb\n", expected: "a\n" }] },
			"f",
		);
		expect(runOutputRuleTests([rule])).toEqual([
			{ rule: "r", source: "f", index: 0, expected: "a\n", actual: "b\n" },
		]);
	});
});

describe("loadOutputRules", () => {
	it("merges bundled, user, project and extra files with later names winning", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-rules-agent-"));
		const cwd = mkdtempSync(join(tmpdir(), "pi-rules-cwd-"));
		mkdirSync(join(cwd, ".pi"));
		const extra = join(cwd, "extra.json");
		writeFileSync(
			join(agentDir, "output-filters.json"),
			JSON.stringify({ rules: [{ name: "user-rule", match: "^u", stripLinesMatching: ["^a"] }] }),
		);
		writeFileSync(
			join(cwd, ".pi", "output-filters.json"),
			JSON.stringify({ rules: [{ name: "user-rule", match: "^u", stripLinesMatching: ["^project"] }] }),
		);
		writeFileSync(
			extra,
			JSON.stringify({ rules: [{ name: "npm-install", match: "^npm", stripLinesMatching: ["^override"] }] }),
		);
		const rules = loadOutputRules({ cwd, agentDir, extraFiles: [extra], bundled: BUNDLED_OUTPUT_RULES });
		const byName = new Map(rules.map((rule) => [rule.definition.name, rule]));
		expect(byName.get("user-rule")?.source).toBe(join(cwd, ".pi", "output-filters.json"));
		expect(rules.filter((rule) => rule.definition.name === "npm-install")).toHaveLength(1);
		expect(byName.get("npm-install")?.source).toBe(extra);
		expect(byName.get("pip-install")?.source).toBe("bundled output rules");
	});

	it("fails with the file named when a file is malformed", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-rules-bad-"));
		const file = join(cwd, "bad.json");
		writeFileSync(file, "{ not json");
		expect(() => loadOutputRules({ cwd, extraFiles: [file], bundled: [] })).toThrow(
			`${file}: cannot read output rules`,
		);
	});
});

describe("createRuleOutputReducer", () => {
	const reducer = createRuleOutputReducer(BUNDLED_OUTPUT_RULES);
	it("matches on the program and arguments through cd prefixes and env assignments", () => {
		for (const command of [
			"npm install",
			"cd /repo && npm ci",
			"CI=1 pnpm install --frozen-lockfile",
			"docker pull alpine",
		]) {
			expect(reducer.applies(classifyCommandFamily(command), request), command).toBe(true);
		}
		for (const command of ["npm test", "ls -la", "docker ps"]) {
			expect(reducer.applies(classifyCommandFamily(command), request), command).toBe(false);
		}
	});

	it("names the rule in the kind and returns undefined when nothing changed", () => {
		const classification = classifyCommandFamily("npm install");
		const text = "npm warn deprecated x@1: gone\nadded 3 packages in 1s\n";
		expect(reducer.reduce(classification, { ...request, command: "npm install", text })).toEqual({
			text: "added 3 packages in 1s\n",
			omittedLines: 1,
			kind: "rule:npm-install",
		});
		expect(
			reducer.reduce(classification, { ...request, command: "npm install", text: "added 3 packages in 1s\n" }),
		).toBeUndefined();
	});

	it("does not apply bash rules to the python tool", () => {
		expect(reducer.applies(classifyCommandFamily("python"), { ...request, tool: "python", command: "python" })).toBe(
			false,
		);
	});
});
