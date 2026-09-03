/**
 * Code outline contract: every entry is a real line of the file with its 1-indexed number, the
 * outline is a small fraction of the file, unknown types fall back to the head with a note, and the
 * result is byte-stable.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCodeOutline, renderCodeOutline } from "../src/core/tools/code-outline.ts";

const sourceFile = join(import.meta.dirname, "..", "src", "core", "tools", "bash.ts");

describe("buildCodeOutline", () => {
	it("lists declarations with line numbers that match the file, well under a tenth of its size", () => {
		const text = readFileSync(sourceFile, "utf-8");
		const outline = buildCodeOutline("bash.ts", text);
		const lines = text.split("\n");
		expect(outline.language).toBe("typescript");
		expect(outline.headFallback).toBe(false);
		expect(outline.entries.length).toBeGreaterThan(20);
		for (const entry of outline.entries)
			expect(lines[entry.line - 1].trimEnd().startsWith(entry.text.replace(/…$/u, ""))).toBe(true);
		expect(outline.entries.some((entry) => entry.text.startsWith("export function createBashTool("))).toBe(true);
		const rendered = renderCodeOutline("bash.ts", outline);
		expect(rendered.length).toBeLessThan(text.length * 0.1);
		expect(rendered.startsWith("[outline of bash.ts: ")).toBe(true);
		expect(rendered).toContain("read offset=<line> limit=<n> for a range]");
	});

	it("outlines python, rust and markdown by their own declaration shapes", () => {
		const python =
			"import os\n\nclass Loader:\n    def __init__(self):\n        pass\n\n    def load(self, path):\n        return path\n\n@dataclass\nclass Row:\n    pass\n\ndef main():\n    pass\n";
		expect(buildCodeOutline("a.py", python).entries.map((entry) => `${entry.line}: ${entry.text}`)).toEqual([
			"3: class Loader:",
			"4:     def __init__(self):",
			"7:     def load(self, path):",
			"10: @dataclass",
			"11: class Row:",
			"14: def main():",
		]);
		const rust =
			"use std::io;\n\npub struct Store {\n    path: String,\n}\n\nimpl Store {\n    pub fn open(path: &str) -> Self {\n        Self { path: path.into() }\n    }\n}\n\n#[test]\nfn opens() {}\n";
		expect(buildCodeOutline("s.rs", rust).entries.map((entry) => entry.line)).toEqual([3, 7, 8, 13, 14]);
		const markdown = "# Title\n\ntext\n\n## Section\n\n### Sub\n";
		expect(buildCodeOutline("README.md", markdown).entries.map((entry) => entry.text)).toEqual([
			"# Title",
			"## Section",
			"### Sub",
		]);
	});

	it("skips comments and deep nesting", () => {
		const text =
			"// function notReal() {\n/*\nexport function alsoNot() {\n*/\nexport function real() {\n\t\tfunction deep() {}\n}\n";
		expect(buildCodeOutline("x.ts", text).entries).toEqual([{ line: 5, text: "export function real() {" }]);
	});

	it("falls back to the head of the file for unknown types", () => {
		const text = Array.from({ length: 100 }, (_, index) => `row ${index}`).join("\n");
		const outline = buildCodeOutline("data.csv", text);
		expect(outline.headFallback).toBe(true);
		expect(outline.entries).toHaveLength(40);
		expect(renderCodeOutline("data.csv", outline)).toContain(
			"[outline unavailable for this file type; first 40 of 100 lines]",
		);
	});

	it("is deterministic", () => {
		const text = readFileSync(sourceFile, "utf-8");
		expect(buildCodeOutline("bash.ts", text)).toEqual(buildCodeOutline("bash.ts", text));
	});
});
