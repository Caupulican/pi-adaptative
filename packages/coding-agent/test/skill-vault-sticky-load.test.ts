import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SkillVaultController } from "../src/core/skill-vault.ts";
import { loadSkillsFromDir } from "../src/core/skills.ts";

function writeSkill(root: string, name: string, body: string): string {
	const directory = join(root, name);
	mkdirSync(directory, { recursive: true });
	const path = join(directory, "SKILL.md");
	writeFileSync(path, `---\nname: ${name}\ndescription: Guidance for ${name}\n---\n\n${body}\n`);
	return path;
}

it("keeps the accepted skill body, pin and usage across repeated loads", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-sticky-skill-"));
	try {
		writeSkill(root, "fixture", "Original guidance.");
		const { skills } = loadSkillsFromDir({ dir: root, source: "user" });
		const onSkillUsed = vi.fn();
		let now = 0;
		const vault = new SkillVaultController({ getSkills: () => skills, now: () => now, onSkillUsed });

		expect(vault.load("fixture", "user", true)).toMatchObject({ state: "loaded_pending", pinned: true });
		const sections = vault.commitSkillSections();
		const revision = vault.getContextRevision();
		now = 100;
		expect(vault.load("fixture", "model")).toMatchObject({ state: "active", pinned: true });
		expect(vault.getContextRevision()).toBe(revision);
		expect(vault.commitSkillSections()).toEqual(sections);
		expect(vault.status().slots[0]).toMatchObject({ loadedAtMs: 0, useCount: 2, pinned: true });
		expect(onSkillUsed).toHaveBeenCalledTimes(1);

		writeSkill(root, "fixture", "The file now contains different guidance.");
		expect(vault.previewSkillSections()).toEqual([]);
		expect(vault.load("fixture", "model")).toMatchObject({ state: "loaded_pending" });
		expect(vault.previewSkillSections()[0]?.section).toContain("different guidance");
		expect(vault.getContextRevision()).toBeGreaterThan(revision);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("reauthorizes model loads after a batch lookup refreshes the catalog", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-admission-"));
	try {
		writeSkill(root, "owner-skill", "Owner guidance.");
		const discover = () => loadSkillsFromDir({ dir: root, source: "user" }).skills;
		let skills = discover();
		const vault = new SkillVaultController({
			getSkills: () => skills,
			refreshSkills: () => {
				skills = discover().map((skill) =>
					skill.name === "owner-skill" ? { ...skill, disableModelInvocation: true } : skill,
				);
			},
		});
		expect(vault.load("owner-skill", "user")).toMatchObject({ ok: true });
		writeSkill(root, "new-skill", "New guidance.");
		expect(vault.loadMany(["owner-skill", "new-skill"], "model")).toMatchObject({ ok: false });
		expect(vault.previewSkillSections().map((section) => section.name)).toEqual(["owner-skill"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("allocates pins released by the same batch's evictions", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-pins-"));
	try {
		for (const name of ["old-first", "old-second", "retained", "new-first", "new-second"]) {
			writeSkill(root, name, "Skill guidance.");
		}
		const { skills } = loadSkillsFromDir({ dir: root, source: "user" });
		const vault = new SkillVaultController({ getSkills: () => skills });
		expect(vault.loadMany(["old-first", "old-second"], "model", true)).toMatchObject({ ok: true });
		expect(vault.load("retained", "model")).toMatchObject({ ok: true });

		expect(vault.loadMany(["retained", "new-first", "new-second"], "model", true)).toMatchObject({
			ok: true,
			results: [
				{ name: "retained", pinned: true },
				{ name: "new-first", pinned: true },
				{ name: "new-second", pinned: false, pinCapReached: true },
			],
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
