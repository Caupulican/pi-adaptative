import { describe, expect, it } from "vitest";
import { composeSubagentSystemPrompt, SUBAGENT_CORE_SYSTEM_PROMPT } from "../src/core/autonomy/subagent-prompt.ts";

describe("subagent level-0 prompt composition", () => {
	it("keeps the core under 300 tokens (~4 chars/token)", () => {
		expect(SUBAGENT_CORE_SYSTEM_PROMPT.length / 4).toBeLessThan(300);
	});

	it("always starts with the immutable core", () => {
		const composed = composeSubagentSystemPrompt({ rolePrompt: "You do research." });
		expect(composed.startsWith(SUBAGENT_CORE_SYSTEM_PROMPT)).toBe(true);
		expect(composed).toContain("You do research.");
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
