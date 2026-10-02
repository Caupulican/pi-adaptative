// @isolated: Mutates Chalk's process-wide color level to verify inverse emphasis.
import chalk from "chalk";
import { describe, expect, it } from "vitest";
import { renderDiff } from "../src/modes/interactive/components/diff.ts";
import { highlightCode, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const DIFF = " 11 const a = 1;\n-12 let b = 2;\n+12 let b = 3;\n 13 done";

describe("diff rows", () => {
	it("preserves exact whitespace and expanded tabs without emphasizing unchanged words", () => {
		initTheme("dark");
		const previousLevel = chalk.level;
		chalk.level = 3;
		try {
			const diff = "-1 \tconst  value = 1;\n+1     const value = 1;";
			for (const options of [
				{},
				{
					highlightContent: (content: string) =>
						highlightCode(content, "typescript", { plainColor: "text" }).join("\n"),
				},
			]) {
				const rendered = renderDiff(diff, options);
				expect(stripAnsi(rendered)).toBe("-1    const  value = 1;\n+1     const value = 1;");
				expect(rendered).not.toContain(theme.inverse("const"));
				expect(rendered).not.toContain(theme.inverse("value"));
			}
		} finally {
			chalk.level = previousLevel;
		}
	});
	it("carry the theme's surface tone under added and removed rows when it defines one", () => {
		initTheme("matrix-machine");
		const [context, removed, added] = renderDiff(DIFF).split("\n");
		expect(theme.hasBg("toolDiffAddedBg")).toBe(true);
		expect(added).toContain(theme.getBgAnsi("toolDiffAddedBg"));
		expect(added).toContain(theme.getFgAnsi("toolDiffAdded"));
		expect(removed).toContain(theme.getBgAnsi("toolDiffRemovedBg"));
		expect(removed).toContain(theme.getFgAnsi("toolDiffRemoved"));
		expect(added?.endsWith("\x1b[49m")).toBe(true);
		expect(context).not.toContain("\x1b[48;");
	});

	it("stay foreground-only on a theme without diff surfaces", () => {
		initTheme("dark");
		const rendered = renderDiff(DIFF);
		expect(theme.hasBg("toolDiffAddedBg")).toBe(false);
		expect(rendered).not.toContain("\x1b[48;");
		expect(rendered).toContain(theme.getFgAnsi("toolDiffAdded"));
		initTheme("matrix-machine");
	});
});
