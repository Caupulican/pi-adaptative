import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	computeCurationProposals,
	isPromotedFrontmatter,
	type PromotedSkillInfo,
	SkillCurator,
} from "../src/core/learning/skill-curator.ts";

/**
 * Skill curator (#32): propose-only archival of stale reflection-promoted skills + consolidation of
 * overlapping ones; usage tracking; restorable archive. Hand-authored skills are never touched.
 */
const DAY = 86_400_000;

describe("isPromotedFrontmatter", () => {
	it("detects the reflection marker, ignores hand-authored skills", () => {
		expect(isPromotedFrontmatter("---\nname: x\npromoted: true\n---\nbody")).toBe(true);
		expect(isPromotedFrontmatter("---\nname: x\ndescription: y\n---\nbody")).toBe(false);
		expect(isPromotedFrontmatter("no frontmatter here")).toBe(false);
	});
});

describe("computeCurationProposals", () => {
	const now = 100 * DAY;
	const mk = (over: Partial<PromotedSkillInfo>): PromotedSkillInfo => ({
		name: "s",
		createdMs: now,
		lastUsedMs: 0,
		useCount: 0,
		keywords: [],
		...over,
	});

	it("proposes archiving a stale, unused skill but not a fresh one", () => {
		const skills = [
			mk({ name: "old", createdMs: now - 40 * DAY, lastUsedMs: now - 40 * DAY }),
			mk({ name: "fresh", createdMs: now - 2 * DAY }),
			mk({ name: "recently-used", createdMs: now - 60 * DAY, lastUsedMs: now - 3 * DAY, useCount: 5 }),
		];
		const { archive } = computeCurationProposals(skills, { now, staleDays: 30, overlapThreshold: 0.5 });
		const names = archive.map((a) => a.name);
		expect(names).toContain("old");
		expect(names).not.toContain("fresh"); // grace: too new to archive
		expect(names).not.toContain("recently-used"); // used recently
	});

	it("flags overlapping promoted skills for consolidation (not the archived ones)", () => {
		const kw = ["deploy", "release", "patch", "tag", "push", "npm"];
		const skills = [
			mk({ name: "release-a", createdMs: now - 2 * DAY, keywords: kw }),
			mk({ name: "release-b", createdMs: now - 2 * DAY, keywords: [...kw, "extra"] }),
			mk({ name: "unrelated", createdMs: now - 2 * DAY, keywords: ["coffee", "tea", "water"] }),
		];
		const { consolidate } = computeCurationProposals(skills, { now, staleDays: 30, overlapThreshold: 0.5 });
		expect(consolidate).toHaveLength(1);
		expect(consolidate[0].names.sort()).toEqual(["release-a", "release-b"]);
		expect(consolidate[0].overlap).toBeGreaterThanOrEqual(0.5);
	});
});

describe("SkillCurator (filesystem)", () => {
	let dir: string;
	const writeSkill = (name: string, promoted: boolean) => {
		mkdirSync(join(dir, name), { recursive: true });
		const fm = promoted ? "\npromoted: true" : "";
		writeFileSync(
			join(dir, name, "SKILL.md"),
			`---\nname: ${name}\ndescription: ${name} skill${fm}\n---\n\nbody for ${name}`,
			"utf-8",
		);
	};

	beforeEach(() => {
		dir = join(tmpdir(), `pi-curator-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
	});
	afterEach(() => {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	});

	it("loads only promoted skills and tracks their usage", () => {
		writeSkill("promoted-one", true);
		writeSkill("hand-authored", false);
		const curator = new SkillCurator(dir);

		let promoted = curator.loadPromotedSkills();
		expect(promoted.map((s) => s.name)).toEqual(["promoted-one"]); // hand-authored excluded

		const now = 10 * DAY;
		curator.recordUse("promoted-one", now);
		curator.recordUse("promoted-one", now + 1000);
		promoted = curator.loadPromotedSkills();
		expect(promoted[0].useCount).toBe(2);
		expect(promoted[0].lastUsedMs).toBe(now + 1000);
	});

	it("archives and restores a promoted skill non-destructively", () => {
		writeSkill("promoted-one", true);
		writeSkill("hand-authored", false);
		const curator = new SkillCurator(dir);

		expect(curator.archiveSkill("hand-authored")).toBe(false); // never touches hand-authored
		expect(curator.archiveSkill("promoted-one")).toBe(true);
		expect(existsSync(join(dir, "promoted-one", "SKILL.md"))).toBe(false);
		expect(existsSync(join(dir, ".archive", "promoted-one", "SKILL.md"))).toBe(true);

		expect(curator.restoreSkill("promoted-one")).toBe(true);
		expect(existsSync(join(dir, "promoted-one", "SKILL.md"))).toBe(true);
	});

	it("proposeCuration archives a stale promoted skill end-to-end", () => {
		writeSkill("stale", true);
		const curator = new SkillCurator(dir);
		// Anchor "now" to the file's real creation time so the 40d age is measured against it (unused).
		const created = curator.loadPromotedSkills()[0].createdMs;
		const proposals = curator.proposeCuration(created + 40 * DAY, { staleDays: 30 });
		expect(proposals.archive.map((a) => a.name)).toContain("stale");
	});
});
