import { describe, expect, it } from "vitest";
import { renderDiff } from "../src/modes/interactive/components/diff.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const DIFF = " 11 const a = 1;\n-12 let b = 2;\n+12 let b = 3;\n 13 done";

describe("diff rows", () => {
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
