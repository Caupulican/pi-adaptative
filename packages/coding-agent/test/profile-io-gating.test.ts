import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPromptTemplates } from "../src/core/prompt-templates.ts";
import { loadSkills } from "../src/core/skills.ts";

/**
 * Profile UAC IO gating: resources a profile denies are never READ from disk, not just filtered
 * after loading. Proof technique: the denied file is deliberately malformed — if the loader ever
 * read/parsed it, a diagnostic (or a loaded entry) would appear for its path.
 */
describe("profile-gated disk reads", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-io-gating-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("never reads a denied SKILL.md from disk", () => {
		const skillsDir = join(tempDir, "skills");
		mkdirSync(join(skillsDir, "allowed-skill"), { recursive: true });
		mkdirSync(join(skillsDir, "denied-skill"), { recursive: true });
		writeFileSync(
			join(skillsDir, "allowed-skill", "SKILL.md"),
			"---\nname: allowed-skill\ndescription: fine\n---\nBody\n",
		);
		// Malformed on purpose: unparseable frontmatter would emit a diagnostic if ever read.
		writeFileSync(join(skillsDir, "denied-skill", "SKILL.md"), "---\nname: [unclosed\ndescription\n--\nbroken");

		const result = loadSkills({
			cwd: tempDir,
			agentDir: tempDir,
			skillPaths: [skillsDir],
			includeDefaults: false,
			isPathAllowed: (path) => !path.includes("denied-skill"),
		});

		expect(result.skills.map((skill) => skill.name)).toEqual(["allowed-skill"]);
		expect(result.diagnostics.filter((diagnostic) => diagnostic.path?.includes("denied-skill"))).toEqual([]);
	});

	it("never reads a denied prompt template from disk", () => {
		const promptsDir = join(tempDir, "prompts");
		mkdirSync(promptsDir, { recursive: true });
		writeFileSync(join(promptsDir, "allowed.md"), "---\ndescription: fine\n---\nAllowed template\n");
		writeFileSync(join(promptsDir, "denied.md"), "---\ndescription: should never load\n---\nDenied template\n");

		const templates = loadPromptTemplates({
			cwd: tempDir,
			agentDir: tempDir,
			promptPaths: [promptsDir],
			includeDefaults: false,
			isPathAllowed: (path) => !path.endsWith("denied.md"),
		});

		expect(templates.map((template) => template.name)).toEqual(["allowed"]);
	});

	it("loads everything when no predicate is provided (unchanged default)", () => {
		const skillsDir = join(tempDir, "skills");
		mkdirSync(join(skillsDir, "one-skill"), { recursive: true });
		writeFileSync(join(skillsDir, "one-skill", "SKILL.md"), "---\nname: one-skill\ndescription: d\n---\nBody\n");

		const result = loadSkills({
			cwd: tempDir,
			agentDir: tempDir,
			skillPaths: [skillsDir],
			includeDefaults: false,
		});
		expect(result.skills).toHaveLength(1);
	});
});
