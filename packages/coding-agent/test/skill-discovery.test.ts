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

	it("discovers nested bare .md files in agents mode while ignoring root .md (F16)", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-skill-discovery-agents-"));
		roots.push(root);
		mkdirSync(join(root, "vendor", "sub"), { recursive: true });
		mkdirSync(join(root, "standalone-skill"));
		writeFileSync(join(root, "root.md"), "ignored in agents", "utf8");
		writeFileSync(join(root, "vendor", "child.md"), "vendor child", "utf8");
		writeFileSync(join(root, "vendor", "sub", "deep.md"), "deep child", "utf8");
		writeFileSync(join(root, "standalone-skill", "SKILL.md"), "skill root", "utf8");

		const agentsFiles = discoverSkillFiles(root, "agents");
		expect(agentsFiles).toContain(join(root, "vendor", "child.md"));
		expect(agentsFiles).toContain(join(root, "vendor", "sub", "deep.md"));
		expect(agentsFiles).toContain(join(root, "standalone-skill", "SKILL.md"));
		expect(agentsFiles).not.toContain(join(root, "root.md"));

		const piFiles = discoverSkillFiles(root, "pi");
		expect(piFiles).toContain(join(root, "root.md"));
		expect(piFiles).toContain(join(root, "standalone-skill", "SKILL.md"));
		expect(piFiles).not.toContain(join(root, "vendor", "child.md"));
	});
});
