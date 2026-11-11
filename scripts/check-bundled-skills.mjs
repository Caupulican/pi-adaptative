#!/usr/bin/env node
/**
 * Bundled-skill check, run over every packages/coding-agent/src/bundled-resources/skills/*\/SKILL.md:
 *
 *   1. The skill validator (skill-creator/scripts/validate-skill.mjs) passes for each skill directory.
 *      Its rules are not restated here; the validator is run as shipped.
 *   2. Every backticked tool name that a skill tells the agent to call (`call `x``, `invoke `x``, or
 *      `` `x` tool ``) outside fenced code blocks exists in the harness tool registry. The registry is
 *      read statically from the source: every exported *TOOL_NAME / *TOOL_NAMES constant, the default
 *      active tool list, and the core tool-definition name set.
 *   3. Numeric claims that mirror a code constant match it. Today: the fan-out limits for `delegate`
 *      slices and race, read from core/delegation/worker-fanout-header.ts. A claim such as "slices 2-8"
 *      or "race up to 4" fails when the constant says otherwise.
 *
 *   node scripts/check-bundled-skills.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readText, repoRelative, walkTypeScriptFiles } from "./lib/ratchet-files.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const skillsRoot = join(root, "packages/coding-agent/src/bundled-resources/skills");
const validator = join(skillsRoot, "skill-creator/scripts/validate-skill.mjs");
const sourceRoot = join(root, "packages/coding-agent/src");
const fanoutHeader = join(sourceRoot, "core/delegation/worker-fanout-header.ts");
const literal = /"([a-z][a-z0-9_]*)"/g;

/** Tool names the harness registers, from the source's own name constants and lists. */
function toolRegistry() {
	const names = new Set();
	const declaration = /export const [A-Za-z0-9_]*(?:TOOL_NAME|TOOL_NAMES|ToolName|ToolNames)\b[^=]*=\s*([\s\S]*?)(?:;\n|\n\n)/g;
	for (const path of walkTypeScriptFiles(sourceRoot)) {
		const text = readText(path);
		for (const match of text.matchAll(declaration)) {
			for (const name of match[1].matchAll(literal)) names.add(name[1]);
		}
	}
	const defaults = readText(join(sourceRoot, "core/default-tool-surface.ts")).match(/getDefaultActiveToolNames[\s\S]*?return \[([\s\S]*?)\];/);
	if (defaults) for (const name of defaults[1].matchAll(literal)) names.add(name[1]);
	const factory = readText(join(sourceRoot, "core/tools/tool-definition-factory.ts")).match(/allToolNames[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/);
	if (factory) for (const name of factory[1].matchAll(literal)) names.add(name[1]);
	return names;
}

/** An exported numeric constant, read from its declaration. */
function numericConstant(path, name) {
	const match = readText(path).match(new RegExp(`export const ${name}\\s*=\\s*(\\d[\\d_]*)\\s*;`));
	if (!match) throw new Error(`check-bundled-skills: ${name} is not declared in ${repoRelative(root, path)}`);
	return Number(match[1].replace(/_/g, ""));
}

const limits = {
	slices: numericConstant(fanoutHeader, "MAX_FANOUT_PARTITION_SLICES"),
	race: numericConstant(fanoutHeader, "MAX_FANOUT_RACE_CANDIDATES"),
};

/**
 * Claims that mirror a constant: each pattern captures the claimed upper bound in its last group. Action names must be
 * backticked (`\`slices\``, `\`race\``) or anchored to a `delegate` / `fan-out` clause so ordinary English prose ("2 to 4
 * slices", "up to 3 candidates") does not collide with the fan-out constant check.
 */
const claimPatterns = [
	{
		label: "slices",
		limit: limits.slices,
		patterns: [
			/`slices`\s*\(?\s*(\d+)\s*(?:to|-|–|through)\s*(\d+)/gi,
			/`slices`\s+(?:up to|max(?:imum)?(?: of)?)\s+(\d+)/gi,
			/\b(?:`delegate`|delegate|fan[- ]out)\b[^.\n]{0,120}?(?<!`)\bslices(?!`)\s*\(?\s*(\d+)\s*(?:to|-|–|through)\s*(\d+)/gi,
			/\b(?:`delegate`|delegate|fan[- ]out)\b[^.\n]{0,120}?(?<!`)\bslices(?!`)\s+(?:up to|max(?:imum)?(?: of)?)\s+(\d+)/gi,
			/\b(?:`delegate`|delegate|fan[- ]out)\b[^.\n]{0,120}?\bup to\s+(\d+)\s+`?slices`?(?:\b|`)/gi,
		],
	},
	{
		label: "race",
		limit: limits.race,
		patterns: [
			/`race`\s*\(?\s*(\d+)\s*(?:to|-|–|through)\s*(\d+)/gi,
			/`race`\s+(?:up to|max(?:imum)?(?: of)?)\s+(\d+)/gi,
			/\b(?:`delegate`|delegate|fan[- ]out)\b[^.\n]{0,120}?(?<!`)\brace(?!`)\s*\(?\s*(\d+)\s*(?:to|-|–|through)\s*(\d+)/gi,
			/\b(?:`delegate`|delegate|fan[- ]out)\b[^.\n]{0,120}?(?<!`)\brace(?!`)\s+(?:up to|max(?:imum)?(?: of)?)\s+(\d+)/gi,
			/\bup to\s+(\d+)\s+`?race`?\s+candidates\b/gi,
		],
	},
];

const registry = toolRegistry();
const failures = [];
let toolReferences = 0;
let numericClaims = 0;

const skillDirectories = readdirSync(skillsRoot)
	.map((name) => join(skillsRoot, name))
	.filter((path) => statSync(path).isDirectory() && existsSync(join(path, "SKILL.md")))
	.sort();

for (const directory of skillDirectories) {
	const result = spawnSync(process.execPath, [validator, directory], { encoding: "utf8" });
	if (result.status !== 0) {
		const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n").map((line) => `    ${line}`).join("\n");
		failures.push(`${repoRelative(root, directory)}: fails the skill validator\n${detail}`);
	}

	const documents = [join(directory, "SKILL.md")];
	const references = join(directory, "references");
	if (existsSync(references)) {
		for (const name of readdirSync(references).sort()) if (name.endsWith(".md")) documents.push(join(references, name));
	}
	for (const document of documents) {
		const prose = readFileSync(document, "utf8").replace(/```[\s\S]*?```/g, "");
		const where = repoRelative(root, document);

		const toolCall = /\b(?:call|calls|called|calling|invoke|invokes|invoking)\s+(?:the\s+)?`([a-z][a-z0-9_]*)`|`([a-z][a-z0-9_]*)`\s+tool\b/g;
		for (const match of prose.matchAll(toolCall)) {
			const name = match[1] ?? match[2];
			toolReferences++;
			if (!registry.has(name)) failures.push(`${where}: tells the agent to call \`${name}\`, which is not a harness tool name`);
		}

		for (const claim of claimPatterns) {
			for (const pattern of claim.patterns) {
				for (const match of prose.matchAll(pattern)) {
					const claimed = Number(match[match.length - 1]);
					numericClaims++;
					if (claimed !== claim.limit) {
						failures.push(
							`${where}: states ${claim.label} up to ${claimed}; the code constant is ${claim.limit} (worker-fanout-header.ts). Correct the claim.`,
						);
					}
				}
			}
		}
	}
}

if (failures.length > 0) {
	console.error("check-bundled-skills: the bundled skills failed:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
console.log(
	`check-bundled-skills: ${skillDirectories.length} skill(s) pass the validator; ${toolReferences} tool-call reference(s) resolve to the registry; ${numericClaims} numeric claim(s) match the code.`,
);
