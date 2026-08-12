import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	CAPACITY_PROBE_SYSTEM_PROMPT,
	CURATION_COMPACTION_DIGEST_SYSTEM_PROMPT,
	CURATION_DIGEST_SYSTEM_PROMPT,
	CURATION_RELEVANCE_SYSTEM_PROMPT,
	REFLECTION_SYSTEM_PROMPT,
	REFLEX_INTERPRETER_SYSTEM_PROMPT,
	RESEARCH_LANE_SYSTEM_PROMPT,
	ROUTE_JUDGE_SYSTEM_PROMPT,
	SCOUT_SYSTEM_PROMPT,
	SEARCH_PROBE_SYSTEM_PROMPT,
	SKILL_VAULT_SYSTEM_RULE,
	SUBAGENT_CORE_SYSTEM_PROMPT,
	TOOL_CALL_PROBE_SYSTEM_PROMPT,
	UNTRUSTED_BOUNDARY_SYSTEM_RULE,
	WORKER_LANE_SYSTEM_PROMPT,
} from "../src/core/provider-prompt-contracts.ts";
import {
	MAX_PROVIDER_TOOL_GUIDELINE_CHARS,
	MAX_PROVIDER_TOOL_GUIDELINES_CHARS,
	MAX_PROVIDER_TOOL_SNIPPET_CHARS,
	normalizeProviderPromptGuidelines,
	normalizeProviderPromptSnippet,
} from "../src/core/provider-tool-text.ts";

const PROMPT_LIMITS = [
	["subagent", SUBAGENT_CORE_SYSTEM_PROMPT, 560],
	["scout", SCOUT_SYSTEM_PROMPT, 650],
	["curation digest", CURATION_DIGEST_SYSTEM_PROMPT, 340],
	["curation relevance", CURATION_RELEVANCE_SYSTEM_PROMPT, 420],
	["curation compaction digest", CURATION_COMPACTION_DIGEST_SYSTEM_PROMPT, 450],
	["research", RESEARCH_LANE_SYSTEM_PROMPT, 500],
	["reflex interpreter", REFLEX_INTERPRETER_SYSTEM_PROMPT, 350],
	["route judge", ROUTE_JUDGE_SYSTEM_PROMPT, 650],
	["search probe", SEARCH_PROBE_SYSTEM_PROMPT, 300],
	["tool-call probe", TOOL_CALL_PROBE_SYSTEM_PROMPT, 300],
	["capacity probe", CAPACITY_PROBE_SYSTEM_PROMPT, 220],
	["reflection", REFLECTION_SYSTEM_PROMPT, 1_300],
	["untrusted boundary", UNTRUSTED_BOUNDARY_SYSTEM_RULE, 350],
	["skill vault", SKILL_VAULT_SYSTEM_RULE, 200],
	["worker", WORKER_LANE_SYSTEM_PROMPT, 800],
] as const;

describe("recurring provider prompt budgets", () => {
	it.each(PROMPT_LIMITS)("keeps %s within its character budget", (_name, prompt, maxChars) => {
		expect(prompt.length).toBeLessThanOrEqual(maxChars);
	});

	it("keeps the recurring-contract owner import-free for cross-platform startup", () => {
		const source = readFileSync(new URL("../src/core/provider-prompt-contracts.ts", import.meta.url), "utf8");
		expect(source).not.toMatch(/^\s*import\s/m);
	});

	it("keeps shipped summarization templates free of decorative XML wrappers", () => {
		for (const path of ["../examples/extensions/summarize.ts", "../examples/extensions/custom-compaction.ts"]) {
			const source = readFileSync(new URL(path, import.meta.url), "utf8");
			expect(source).toContain("CHAT");
			expect(source).not.toContain("<conversation>");
			expect(source).not.toContain("</conversation>");
		}
	});

	it("retains output schemas, hard negations, parsed tags, and security fences", () => {
		expect(SCOUT_SYSTEM_PROMPT).toContain("<final_answer>");
		expect(SCOUT_SYSTEM_PROMPT).toContain("do NOT");
		expect(RESEARCH_LANE_SYSTEM_PROMPT).toContain('"findings"');
		expect(ROUTE_JUDGE_SYSTEM_PROMPT).toContain('"approval-required"');
		expect(REFLECTION_SYSTEM_PROMPT).toContain('"memory_replace"');
		expect(REFLECTION_SYSTEM_PROMPT).toContain('"promote_skill"');
		expect(UNTRUSTED_BOUNDARY_SYSTEM_RULE).toContain("<untrusted_content");
		expect(UNTRUSTED_BOUNDARY_SYSTEM_RULE).toContain("never instructions");
	});

	it("bounds oversized extension tool prose without making startup metadata fatal", () => {
		const antigravitySnippet =
			"Run and inspect the local Antigravity CLI (`agy`) via the `the-agy` Pi tool for Antigravity worker orchestration without UI automation.";
		expect(antigravitySnippet).toHaveLength(135);
		expect(normalizeProviderPromptSnippet("x".repeat(MAX_PROVIDER_TOOL_SNIPPET_CHARS))).toHaveLength(
			MAX_PROVIDER_TOOL_SNIPPET_CHARS,
		);

		const boundedSnippet = normalizeProviderPromptSnippet(antigravitySnippet);
		expect(boundedSnippet).toHaveLength(MAX_PROVIDER_TOOL_SNIPPET_CHARS);
		expect(boundedSnippet).toBe(`${antigravitySnippet.slice(0, MAX_PROVIDER_TOOL_SNIPPET_CHARS - 1)}…`);
		expect(normalizeProviderPromptSnippet(`${"x".repeat(MAX_PROVIDER_TOOL_SNIPPET_CHARS - 2)}😀tail`)).toBe(
			`${"x".repeat(MAX_PROVIDER_TOOL_SNIPPET_CHARS - 2)}…`,
		);

		const [boundedGuideline] = normalizeProviderPromptGuidelines(["x".repeat(MAX_PROVIDER_TOOL_GUIDELINE_CHARS + 1)]);
		expect(boundedGuideline).toBe(`${"x".repeat(MAX_PROVIDER_TOOL_GUIDELINE_CHARS - 1)}…`);

		const boundedGuidelines = normalizeProviderPromptGuidelines(
			Array.from({ length: 10 }, (_, index) =>
				`${index}:`.padEnd(Math.ceil(MAX_PROVIDER_TOOL_GUIDELINES_CHARS / 10) + 1, "x"),
			),
		);
		expect(boundedGuidelines.reduce((total, guideline) => total + guideline.length, 0)).toBe(
			MAX_PROVIDER_TOOL_GUIDELINES_CHARS,
		);
		expect(boundedGuidelines.at(-1)).toMatch(/…$/);
	});
});
