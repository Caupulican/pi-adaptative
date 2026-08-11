import { describe, expect, it } from "vitest";
import { SUMMARIZATION_SYSTEM_PROMPT } from "../../src/compaction/utils.ts";
import { buildRetryPrompt } from "../../src/compaction/verification.ts";

describe("provider-bound compaction prompt budgets", () => {
	it("keeps the recurring checkpoint contract compact without dropping mandatory semantics", () => {
		expect(SUMMARIZATION_SYSTEM_PROMPT.length).toBeLessThanOrEqual(1_900);
		expect(SUMMARIZATION_SYSTEM_PROMPT).toContain("## Active Task");
		expect(SUMMARIZATION_SYSTEM_PROMPT).toContain("### Mandatory Rules");
		expect(SUMMARIZATION_SYSTEM_PROMPT).toContain("[REDACTED]");
		expect(SUMMARIZATION_SYSTEM_PROMPT).toMatch(/never include secrets/i);
	});

	it("keeps retry correction compact and uses no presentation-only XML", () => {
		const prompt = buildRetryPrompt(
			{ ok: false, failures: [{ check: "mandatory-rules-recall", detail: "missing exact prohibition" }] },
			"prior checkpoint",
		);

		expect(prompt.length).toBeLessThanOrEqual(220);
		expect(prompt).toContain("missing exact prohibition");
		expect(prompt).toContain("prior checkpoint");
		expect(prompt).not.toContain("<previous-attempt>");
	});
});
