import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import {
	type ContextScoutToolDetails,
	createContextScoutToolDefinition,
	formatScoutResult,
} from "../src/core/tools/context-scout.ts";

const successfulResult = {
	summary: "Found auth router.",
	citations: [
		{ path: "src/auth.ts", start: 10, end: 20, valid: true },
		{ path: "missing.ts", start: 1, end: 2, valid: false },
	],
	droppedCitations: 1,
	unreliable: false,
	truncated: true,
	turnsUsed: 8,
};

describe("context_scout tool", () => {
	it("formats successful scout output with validated citations and notes", () => {
		const text = formatScoutResult(successfulResult);

		expect(text).toContain("Found auth router.");
		expect(text).toContain("src/auth.ts:10-20");
		expect(text).not.toContain("missing.ts");
		expect(text).toContain("Dropped invalid citations: 1");
		expect(text).toContain("truncated after 8 turn");
	});

	it("surfaces unavailable scout failures as a normal tool result", async () => {
		const definition = createContextScoutToolDefinition({
			runScout: async () => ({
				summary: "",
				citations: [],
				droppedCitations: 0,
				unreliable: false,
				truncated: false,
				turnsUsed: 0,
				failure: "no scout model matched auto",
			}),
		});

		const result = await definition.execute(
			"tool-call",
			{ query: "Find auth routing" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		const firstContent = result.content[0];
		expect(firstContent?.type === "text" ? firstContent.text : undefined).toBe(
			"scout unavailable: no scout model matched auto",
		);
		expect((result.details as ContextScoutToolDetails).result.failure).toBe("no scout model matched auto");
	});

	it("declares the expected schema and guidance", () => {
		const definition = createContextScoutToolDefinition({ runScout: async () => successfulResult });

		expect(definition.name).toBe("context_scout");
		expect(definition.promptGuidelines?.[0]).toContain("delegate repository exploration");
		expect(JSON.stringify(definition.parameters)).toContain("minLength");
	});
});
