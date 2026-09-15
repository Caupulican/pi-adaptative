import { describe, expect, it } from "vitest";
import {
	formatMutatedSourceText,
	isBiomeIncludedRelativePath,
	toFormattingRelativePath,
} from "../src/core/tools/file-mutation-format.ts";

describe("file mutation format", () => {
	it("includes package src and test TypeScript, excludes scripts mjs", () => {
		expect(isBiomeIncludedRelativePath("packages/coding-agent/src/core/tools/edit.ts")).toBe(true);
		expect(isBiomeIncludedRelativePath("packages/coding-agent/test/edit-tool-fuzzy-normalization.test.ts")).toBe(
			true,
		);
		expect(isBiomeIncludedRelativePath("scripts/github-origin.mjs")).toBe(false);
		expect(isBiomeIncludedRelativePath("packages/ai/src/models.generated.ts")).toBe(false);
		expect(isBiomeIncludedRelativePath("node_modules/foo/index.ts")).toBe(false);
	});

	it("returns ignored content unchanged without spawning biome", () => {
		const messy = "const x=1";
		expect(formatMutatedSourceText(messy, "scripts/github-origin.mjs", process.cwd())).toBe(messy);
	});

	it("resolves absolute paths under cwd to included relatives", () => {
		const cwd = process.cwd();
		const absolute = `${cwd}/packages/coding-agent/src/core/tools/edit.ts`;
		expect(toFormattingRelativePath(absolute, cwd)).toBe("packages/coding-agent/src/core/tools/edit.ts");
		expect(toFormattingRelativePath("/tmp/outside.ts", cwd)).toBeUndefined();
	});
});
