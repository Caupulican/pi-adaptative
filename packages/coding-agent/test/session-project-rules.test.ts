import { describe, expect, it } from "vitest";
import { SessionProjectRules, type TrustedRuleSource } from "../src/core/project-rules/session-project-rules.ts";

describe("SessionProjectRules source fencing", () => {
	it("recompiles admitted rules when source content changes without changing length", () => {
		let sources: readonly TrustedRuleSource[] = [{ path: "/repo/AGENTS.md", content: "- Never alpha" }];
		const rules = new SessionProjectRules({
			cwd: "/repo",
			getTrustedRuleSources: () => sources,
			getOwnerRulePolicies: () => [],
			getDecisionEngine: () => undefined,
			recordRepairWork: () => undefined,
		});

		expect(rules.getRules().map((rule) => rule.text)).toEqual(["Never alpha"]);

		sources = [{ path: "/repo/AGENTS.md", content: "- Never bravo" }];

		expect(rules.getRules().map((rule) => rule.text)).toEqual(["Never bravo"]);
	});
});
