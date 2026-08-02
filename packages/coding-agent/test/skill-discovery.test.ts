import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverSkillFiles } from "../src/core/skill-discovery.ts";

describe("skill file discovery", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("owns root markdown, skill-root stopping, agents mode, and ignore traversal", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-skill-discovery-"));
		roots.push(root);
		mkdirSync(join(root, "alpha", "nested"), { recursive: true });
		mkdirSync(join(root, "ignored"));
		writeFileSync(join(root, "root.md"), "root", "utf8");
		writeFileSync(join(root, "alpha", "SKILL.md"), "alpha", "utf8");
		writeFileSync(join(root, "alpha", "nested", "SKILL.md"), "nested", "utf8");
		writeFileSync(join(root, "ignored", "SKILL.md"), "ignored", "utf8");
		writeFileSync(join(root, ".gitignore"), "ignored/\n", "utf8");

		expect(discoverSkillFiles(root, "pi")).toEqual([join(root, "alpha", "SKILL.md"), join(root, "root.md")]);
		expect(discoverSkillFiles(root, "agents")).toEqual([join(root, "alpha", "SKILL.md")]);
	});
});
