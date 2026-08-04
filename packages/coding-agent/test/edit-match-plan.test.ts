import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { applyEditMatchPlan, planEditsToNormalizedContent } from "../src/core/tools/edit-diff.ts";

function sourceLines(count: number, targetLine: number, target: string): string {
	return Array.from({ length: count }, (_, index) =>
		index + 1 === targetLine ? target : `const line_${index + 1} = ${index + 1};`,
	).join("\n");
}

describe("edit match plans", () => {
	it("uses an explicit read range without accepting the same anchor elsewhere", () => {
		const content = sourceLines(5_000, 3_500, "const bounded_target = true;");
		const plan = planEditsToNormalizedContent(
			content,
			[
				{
					oldText: "const bounded_target = true;",
					newText: "const bounded_target = false;",
					range: { startLine: 3_300, endLine: 3_700 },
				},
			],
			"large.ts",
		);

		const result = applyEditMatchPlan(content, plan, "large.ts");
		expect(result.newContent.split("\n")[3_499]).toBe("const bounded_target = false;");
	});

	it("rejects stale or incorrect boundaries instead of editing a match outside them", () => {
		const content = sourceLines(5_000, 3_200, "const target = true;");
		expect(() =>
			planEditsToNormalizedContent(
				content,
				[
					{
						oldText: "const target = true;",
						newText: "const target = false;",
						range: { startLine: 3_300, endLine: 3_700 },
					},
				],
				"stale.ts",
			),
		).toThrow("within lines 3300-3700");
	});

	it("still proves global uniqueness outside the bounded search window", () => {
		const lines = sourceLines(5_000, 3_500, "const duplicate = true;").split("\n");
		lines[99] = "const duplicate = true;";
		expect(() =>
			planEditsToNormalizedContent(
				lines.join("\n"),
				[
					{
						oldText: "const duplicate = true;",
						newText: "const duplicate = false;",
						range: { startLine: 3_300, endLine: 3_700 },
					},
				],
				"duplicate.ts",
			),
		).toThrow("Found 2 occurrences");
	});

	it("rejects overlapping anchors as ambiguous locations", () => {
		expect(() => planEditsToNormalizedContent("aaa", [{ oldText: "aa", newText: "b" }], "overlap.txt")).toThrow(
			"Found 2 occurrences",
		);
	});

	it("does not allocate occurrence arrays on the authoritative matcher path", () => {
		const source = readFileSync(new URL("../src/core/tools/edit-diff.ts", import.meta.url), "utf8");
		expect(source).not.toContain("content.split(oldText)");
		expect(source).not.toContain("fuzzyContent.split(fuzzyOldText)");
	});

	it("publishes inclusive line bounds in the single-call edit schema", () => {
		const parameters = createEditToolDefinition(process.cwd()).parameters as {
			anyOf?: Array<{
				properties?: {
					edits?: { items?: { properties?: Record<string, unknown> } };
				};
			}>;
		};
		const edit = parameters.anyOf?.find((variant) => variant.properties?.edits !== undefined);
		expect(edit?.properties?.edits?.items?.properties).toHaveProperty("range");
	});
});
