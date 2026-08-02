import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../src/core/export-html/template.css", import.meta.url), "utf8");
const baseCss = css.slice(0, css.indexOf("@media (max-width: 900px)"));

function declarationsFor(selector: string): Record<string, string> {
	const declarations: Record<string, string> = {};
	const withoutComments = baseCss.replace(/\/\*[\s\S]*?\*\//g, "");
	for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		const selectors = match[1]?.split(",").map((candidate) => candidate.trim());
		if (!selectors?.includes(selector)) continue;
		for (const declaration of match[2]?.split(";") ?? []) {
			const colon = declaration.indexOf(":");
			if (colon === -1) continue;
			declarations[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
		}
	}
	return declarations;
}

describe("export HTML rendered style contract", () => {
	it("keeps sidebar controls visually identical while sharing their chrome", () => {
		expect(declarationsFor(".filter-btn")).toEqual({
			padding: "3px 8px",
			"font-size": "10px",
			"font-family": "inherit",
			background: "transparent",
			color: "var(--muted)",
			border: "1px solid var(--dim)",
			"border-radius": "3px",
			cursor: "pointer",
		});
		expect(declarationsFor(".sidebar-close")).toEqual({
			display: "none",
			padding: "3px 8px",
			"font-size": "12px",
			"font-family": "inherit",
			background: "transparent",
			color: "var(--muted)",
			border: "1px solid var(--dim)",
			"border-radius": "3px",
			cursor: "pointer",
			"margin-left": "auto",
		});
		expect(declarationsFor("#hamburger")).toEqual({
			display: "none",
			position: "fixed",
			top: "10px",
			left: "10px",
			"z-index": "100",
			padding: "3px 8px",
			"font-size": "12px",
			"font-family": "inherit",
			background: "transparent",
			color: "var(--muted)",
			border: "1px solid var(--dim)",
			"border-radius": "3px",
			cursor: "pointer",
		});
		for (const selector of [".filter-btn:hover", ".sidebar-close:hover", "#hamburger:hover"]) {
			expect(declarationsFor(selector)).toEqual({ color: "var(--text)", "border-color": "var(--text)" });
		}
	});

	it("keeps export cards and expandable prompt text visually identical", () => {
		const card = {
			background: "var(--customMessageBg)",
			padding: "var(--line-height)",
			"border-radius": "4px",
			"margin-bottom": "var(--line-height)",
		};
		expect(declarationsFor(".system-prompt")).toEqual(card);
		expect(declarationsFor(".tools-list")).toEqual(card);

		const promptText = {
			color: "var(--customMessageText)",
			"white-space": "pre-wrap",
			"word-wrap": "break-word",
			"font-size": "11px",
			"margin-top": "var(--line-height)",
		};
		expect(declarationsFor(".system-prompt-preview")).toEqual(promptText);
		expect(declarationsFor(".system-prompt-full")).toEqual({ display: "none", ...promptText });
	});
});
