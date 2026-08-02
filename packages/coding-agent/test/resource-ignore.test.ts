import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addResourceIgnoreRules, createResourceIgnoreMatcher } from "../src/core/resource-ignore.ts";

describe("resource ignore rules", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("owns root, nested, comment, escaped marker, and negation semantics", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-resource-ignore-"));
		roots.push(root);
		const nested = join(root, "nested");
		mkdirSync(nested);
		writeFileSync(join(root, ".gitignore"), "# comment\n*.tmp\n!important.tmp\n\\!literal.md\n", "utf8");
		writeFileSync(join(nested, ".ignore"), "/private.md\n", "utf8");

		const matcher = createResourceIgnoreMatcher();
		addResourceIgnoreRules(matcher, root, root);
		addResourceIgnoreRules(matcher, nested, root);

		expect(matcher.ignores("discard.tmp")).toBe(true);
		expect(matcher.ignores("important.tmp")).toBe(false);
		expect(matcher.ignores("!literal.md")).toBe(true);
		expect(matcher.ignores("nested/private.md")).toBe(true);
		expect(matcher.ignores("private.md")).toBe(false);
	});
});
