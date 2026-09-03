/**
 * Data-driven output rules: the long tail of commands whose output has a repetitive shape but no
 * reducer of its own (package managers, container tools, the owner's build scripts). A rule names
 * the commands it matches and a small set of line operations; every rule ships with inline tests so
 * `npm run check` proves each one on its own sample. Rules never invent a format: they only remove
 * lines, replace text within lines and bound the line count.
 *
 * Three sources, later ones override earlier ones by rule name: the bundled rules
 * (`output-rules.bundled.ts`), the user file (`<agent dir>/output-filters.json`) and the project
 * file (`.pi/output-filters.json` under the working directory).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandFamilyClassification } from "./command-family.ts";
import type { OutputReducer, OutputReductionRequest } from "./output-reduction.ts";

export interface OutputRuleTest {
	input: string;
	expected: string;
}

export interface OutputRuleDefinition {
	/** Unique name; `details.outputReduction.kind` becomes `rule:<name>`. */
	name: string;
	/** Regular expression tested against the command with cd prefixes and env assignments removed. */
	match: string;
	/** Tools the rule applies to; default `["bash"]`. `python` rules match the tool label. */
	tools?: string[];
	/** Lines matching any of these patterns are removed. */
	stripLinesMatching?: string[];
	/** When present, only lines matching one of these patterns survive (after strip). */
	keepLinesMatching?: string[];
	/** Text replacements applied to every surviving line, in order (`pattern` is a global regex). */
	replace?: Array<{ pattern: string; with: string }>;
	/** Keep at most this many lines from the start. */
	maxLines?: number;
	/** Keep at most this many lines from the end (applied after `maxLines`). */
	tailLines?: number;
	/** Text to emit when every line was stripped (default: an empty output). */
	onEmpty?: string;
	tests?: OutputRuleTest[];
}

export interface CompiledOutputRule {
	definition: OutputRuleDefinition;
	source: string;
	match: RegExp;
	tools: Set<string>;
	strip: RegExp[];
	keep: RegExp[] | undefined;
	replace: Array<{ pattern: RegExp; with: string }>;
}

export interface OutputRuleTestFailure {
	rule: string;
	source: string;
	index: number;
	expected: string;
	actual: string;
}

function compileRegExp(rule: string, field: string, pattern: string, flags = "u"): RegExp {
	try {
		return new RegExp(pattern, flags);
	} catch (error) {
		throw new Error(
			`output rule "${rule}": ${field} pattern ${JSON.stringify(pattern)} is not a valid regular expression (${error instanceof Error ? error.message : String(error)})`,
		);
	}
}

function assertStringArray(rule: string, field: string, value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		throw new Error(`output rule "${rule}": ${field} must be an array of strings`);
	}
	return value as string[];
}

export function compileOutputRule(definition: unknown, source: string): CompiledOutputRule {
	if (typeof definition !== "object" || definition === null) {
		throw new Error(`${source}: every rule must be an object`);
	}
	const rule = definition as Record<string, unknown>;
	if (typeof rule.name !== "string" || rule.name.trim().length === 0) {
		throw new Error(`${source}: every rule needs a non-empty "name"`);
	}
	const name = rule.name;
	if (typeof rule.match !== "string") throw new Error(`output rule "${name}": "match" must be a string`);
	const tools = assertStringArray(name, "tools", rule.tools) ?? ["bash"];
	const strip = assertStringArray(name, "stripLinesMatching", rule.stripLinesMatching) ?? [];
	const keep = assertStringArray(name, "keepLinesMatching", rule.keepLinesMatching);
	const replaceRaw = rule.replace;
	if (
		replaceRaw !== undefined &&
		(!Array.isArray(replaceRaw) ||
			replaceRaw.some(
				(entry) =>
					typeof entry !== "object" ||
					entry === null ||
					typeof (entry as Record<string, unknown>).pattern !== "string" ||
					typeof (entry as Record<string, unknown>).with !== "string",
			))
	) {
		throw new Error(`output rule "${name}": "replace" must be an array of { pattern, with } strings`);
	}
	for (const field of ["maxLines", "tailLines"] as const) {
		const value = rule[field];
		if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 1)) {
			throw new Error(`output rule "${name}": "${field}" must be a positive integer`);
		}
	}
	if (rule.onEmpty !== undefined && typeof rule.onEmpty !== "string") {
		throw new Error(`output rule "${name}": "onEmpty" must be a string`);
	}
	const tests = rule.tests;
	if (
		tests !== undefined &&
		(!Array.isArray(tests) ||
			tests.some(
				(entry) =>
					typeof entry !== "object" ||
					entry === null ||
					typeof (entry as Record<string, unknown>).input !== "string" ||
					typeof (entry as Record<string, unknown>).expected !== "string",
			))
	) {
		throw new Error(`output rule "${name}": "tests" must be an array of { input, expected } strings`);
	}
	if (strip.length === 0 && !keep && !replaceRaw && rule.maxLines === undefined && rule.tailLines === undefined) {
		throw new Error(`output rule "${name}": a rule needs at least one operation`);
	}
	return {
		definition: rule as unknown as OutputRuleDefinition,
		source,
		match: compileRegExp(name, "match", rule.match),
		tools: new Set(tools),
		strip: strip.map((pattern) => compileRegExp(name, "stripLinesMatching", pattern)),
		keep: keep?.map((pattern) => compileRegExp(name, "keepLinesMatching", pattern)),
		replace: ((replaceRaw as Array<{ pattern: string; with: string }> | undefined) ?? []).map((entry) => ({
			pattern: compileRegExp(name, "replace", entry.pattern, "gu"),
			with: entry.with,
		})),
	};
}

/** Parse a rules file (`{ "rules": [...] }` or a bare array); throws with the file named on any defect. */
export function compileOutputRulesDocument(document: unknown, source: string): CompiledOutputRule[] {
	const list = Array.isArray(document)
		? document
		: typeof document === "object" && document !== null && Array.isArray((document as { rules?: unknown }).rules)
			? ((document as { rules: unknown[] }).rules as unknown[])
			: undefined;
	if (!list) throw new Error(`${source}: expected { "rules": [...] } or an array of rules`);
	return list.map((entry) => compileOutputRule(entry, source));
}

export interface RuleApplication {
	text: string;
	omittedLines: number;
}

/** Apply one rule to a text; pure. */
export function applyOutputRule(rule: CompiledOutputRule, text: string): RuleApplication {
	const hadTrailingNewline = text.endsWith("\n");
	const lines = text.split("\n");
	if (hadTrailingNewline) lines.pop();
	let kept = lines.filter((line) => !rule.strip.some((pattern) => pattern.test(line)));
	if (rule.keep) kept = kept.filter((line) => (rule.keep as RegExp[]).some((pattern) => pattern.test(line)));
	if (rule.replace.length > 0) {
		kept = kept.map((line) => {
			let result = line;
			for (const entry of rule.replace) result = result.replace(entry.pattern, entry.with);
			return result;
		});
	}
	const max = rule.definition.maxLines;
	if (max !== undefined && kept.length > max) {
		const dropped = kept.length - max;
		kept = [...kept.slice(0, max), `[${dropped} more lines]`];
	}
	const tail = rule.definition.tailLines;
	if (tail !== undefined && kept.length > tail) {
		const dropped = kept.length - tail;
		kept = [`[${dropped} earlier lines]`, ...kept.slice(-tail)];
	}
	let result = kept.join("\n");
	if (kept.length === 0) result = rule.definition.onEmpty ?? "";
	else if (hadTrailingNewline) result += "\n";
	return { text: result, omittedLines: Math.max(0, lines.length - kept.length) };
}

/** Run every rule's inline tests; returns the failures (empty when all pass). */
export function runOutputRuleTests(rules: readonly CompiledOutputRule[]): OutputRuleTestFailure[] {
	const failures: OutputRuleTestFailure[] = [];
	for (const rule of rules) {
		(rule.definition.tests ?? []).forEach((test, index) => {
			const actual = applyOutputRule(rule, test.input).text;
			if (actual !== test.expected) {
				failures.push({ rule: rule.definition.name, source: rule.source, index, expected: test.expected, actual });
			}
		});
	}
	return failures;
}

/** Merge rule lists; a later rule with the same name replaces the earlier one in place. */
export function mergeOutputRules(...lists: ReadonlyArray<readonly CompiledOutputRule[]>): CompiledOutputRule[] {
	const byName = new Map<string, CompiledOutputRule>();
	for (const list of lists) for (const rule of list) byName.set(rule.definition.name, rule);
	return [...byName.values()];
}

export const OUTPUT_RULES_FILE_NAME = "output-filters.json";

export function readOutputRulesFile(path: string): CompiledOutputRule[] {
	let document: unknown;
	try {
		document = JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		throw new Error(`${path}: cannot read output rules (${error instanceof Error ? error.message : String(error)})`);
	}
	return compileOutputRulesDocument(document, path);
}

export interface LoadOutputRulesOptions {
	/** Working directory; `.pi/output-filters.json` under it is the project file. */
	cwd?: string;
	/** Agent directory; `output-filters.json` in it is the user file. */
	agentDir?: string;
	/** Extra files (settings `toolOutput.rulesFile`), highest precedence. */
	extraFiles?: readonly string[];
	/** Bundled rules to start from. */
	bundled: readonly CompiledOutputRule[];
}

/** Load bundled + user + project (+ extra) rules; every file that exists must be valid. */
export function loadOutputRules(options: LoadOutputRulesOptions): CompiledOutputRule[] {
	const lists: Array<readonly CompiledOutputRule[]> = [options.bundled];
	const candidates: string[] = [];
	if (options.agentDir) candidates.push(join(options.agentDir, OUTPUT_RULES_FILE_NAME));
	if (options.cwd) candidates.push(join(options.cwd, ".pi", OUTPUT_RULES_FILE_NAME));
	for (const path of candidates) if (existsSync(path)) lists.push(readOutputRulesFile(path));
	for (const path of options.extraFiles ?? []) lists.push(readOutputRulesFile(path));
	return mergeOutputRules(...lists);
}

/** The command text a rule's `match` sees: the program and its arguments, prefixes folded away. */
export function ruleMatchTarget(classification: CommandFamilyClassification, request: OutputReductionRequest): string {
	if (request.tool !== "bash") return request.tool;
	return classification.argv.length > 0 ? classification.argv.join(" ") : request.command;
}

/** The registered reducer over a rule set; first matching rule wins. */
export function createRuleOutputReducer(rules: readonly CompiledOutputRule[]): OutputReducer {
	const select = (classification: CommandFamilyClassification, request: OutputReductionRequest) => {
		const target = ruleMatchTarget(classification, request);
		return rules.find((rule) => rule.tools.has(request.tool) && rule.match.test(target));
	};
	return {
		name: "rule",
		applies: (classification, request) => select(classification, request) !== undefined,
		reduce(classification, request) {
			const rule = select(classification, request);
			if (!rule) return undefined;
			const applied = applyOutputRule(rule, request.text);
			if (applied.text === request.text) return undefined;
			return { ...applied, kind: `rule:${rule.definition.name}` };
		},
	};
}
