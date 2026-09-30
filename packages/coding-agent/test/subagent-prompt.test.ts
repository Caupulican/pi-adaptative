import { describe, expect, it } from "vitest";
import { composeSubagentSystemPrompt, SUBAGENT_CORE_SYSTEM_PROMPT } from "../src/core/autonomy/subagent-prompt.ts";

describe("subagent level-0 prompt composition", () => {
	it("keeps the core under 140 tokens (~4 chars/token)", () => {
		expect(SUBAGENT_CORE_SYSTEM_PROMPT.length / 4).toBeLessThan(140);
	});

	it("keeps the immutable core within the prompt budget and assigns execution rights", () => {
		expect(SUBAGENT_CORE_SYSTEM_PROMPT).not.toContain("Delegate useful independent");
		expect(SUBAGENT_CORE_SYSTEM_PROMPT).toContain("Never invent ceilings");
		expect(SUBAGENT_CORE_SYSTEM_PROMPT).toContain("Leaf worker");
		expect(SUBAGENT_CORE_SYSTEM_PROMPT).toContain("no parent approval");
		expect(SUBAGENT_CORE_SYSTEM_PROMPT).toContain("Parent assigns, integrates and launches workers");
		expect(SUBAGENT_CORE_SYSTEM_PROMPT).toContain("systemone judgments grant no authority");
		expect(SUBAGENT_CORE_SYSTEM_PROMPT).toContain("host enforces grant and deterministic transitions");
		expect(SUBAGENT_CORE_SYSTEM_PROMPT.length).toBeLessThan(560);
		expect(SUBAGENT_CORE_SYSTEM_PROMPT).not.toMatch(/subtree|peer|descendant|spawn/i);
	});

	it("always starts with the immutable core", () => {
		const composed = composeSubagentSystemPrompt({ rolePrompt: "You do research." });
		expect(composed.startsWith(SUBAGENT_CORE_SYSTEM_PROMPT)).toBe(true);
		expect(composed).toContain("You do research.");
	});

	it("retains fixed settings, scoped autonomy and code evidence even under an override", () => {
		const composed = composeSubagentSystemPrompt({ rolePrompt: "Repair the parser.", override: "Just say done." });
		expect(composed).toContain("Model/effort fixed");
		expect(composed).toContain("Stay in requested scope");
		expect(composed).toContain("missing input or authority");
		expect(composed).toContain("Check code");
		expect(composed).toContain("command/result or missing check and why");
		expect(composed).toContain("stop");
		expect(composeSubagentSystemPrompt({ rolePrompt: "Read-only research." })).toContain("Check code");
	});

	it("layers a profile soul above the role prompt", () => {
		const composed = composeSubagentSystemPrompt({ soul: "You are in SCOUT mode.", rolePrompt: "You do research." });
		const soulIndex = composed.indexOf("SCOUT mode");
		const roleIndex = composed.indexOf("You do research.");
		expect(soulIndex).toBeGreaterThan(-1);
		expect(roleIndex).toBeGreaterThan(soulIndex);
		expect(composed.startsWith(SUBAGENT_CORE_SYSTEM_PROMPT)).toBe(true);
	});

	it("lets an override erase everything above level 0 - but never the core", () => {
		const composed = composeSubagentSystemPrompt({
			soul: "You are in SCOUT mode.",
			rolePrompt: "You do research.",
			override: "Answer in one word.",
		});
		expect(composed.startsWith(SUBAGENT_CORE_SYSTEM_PROMPT)).toBe(true);
		expect(composed).toContain("Answer in one word.");
		expect(composed).not.toContain("SCOUT mode");
		expect(composed).not.toContain("You do research.");
	});

	it("ignores a whitespace-only override", () => {
		const composed = composeSubagentSystemPrompt({ rolePrompt: "Role.", override: "   " });
		expect(composed).toContain("Role.");
	});
});
