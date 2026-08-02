import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const skillRoot = fileURLToPath(new URL("../src/bundled-resources/skills/skill-creator/", import.meta.url));
const initializer = join(skillRoot, "scripts", "init-skill.mjs");
const validator = join(skillRoot, "scripts", "validate-skill.mjs");

describe("bundled skill creator", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-skill-creator-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("scaffolds and validates a provider-neutral Pi skill", () => {
		const result = spawnSync(
			process.execPath,
			[initializer, "secure-data-review", "--path", tempDir, "--resources", "references,scripts"],
			{ encoding: "utf8" },
		);
		expect(result.status, result.stderr).toBe(0);

		const created = join(tempDir, "secure-data-review");
		const skillPath = join(created, "SKILL.md");
		expect(existsSync(skillPath)).toBe(true);
		expect(existsSync(join(created, "references"))).toBe(true);
		expect(existsSync(join(created, "scripts"))).toBe(true);
		expect(existsSync(join(created, "agents", "openai.yaml"))).toBe(false);

		const content = readFileSync(skillPath, "utf8");
		expect(content).toContain("name: secure-data-review");
		expect(content).toMatch(/description: "[^"]+"/);
		expect(content).toContain("## Known Gaps");

		const validation = spawnSync(process.execPath, [validator, created], { encoding: "utf8" });
		expect(validation.status, validation.stderr).toBe(0);
		expect(validation.stdout).toContain("Skill is valid");
	});

	it("rejects traversal and never overwrites an existing skill", () => {
		const traversal = spawnSync(process.execPath, [initializer, "../escape", "--path", tempDir], {
			encoding: "utf8",
		});
		expect(traversal.status).not.toBe(0);
		expect(traversal.stderr).toContain("skill name");
		expect(existsSync(join(dirname(tempDir), "escape"))).toBe(false);

		const existing = join(tempDir, "existing-skill");
		mkdirSync(existing, { recursive: true });
		const sentinel = join(existing, "SKILL.md");
		writeFileSync(sentinel, "owned\n", "utf8");
		const overwrite = spawnSync(process.execPath, [initializer, "existing-skill", "--path", tempDir], {
			encoding: "utf8",
		});
		expect(overwrite.status).not.toBe(0);
		expect(overwrite.stderr).toContain("already exists");
		expect(readFileSync(sentinel, "utf8")).toBe("owned\n");
	});

	it("fails validation for provider metadata and malformed frontmatter", () => {
		const invalid = join(tempDir, "invalid-skill");
		mkdirSync(join(invalid, "agents"), { recursive: true });
		writeFileSync(
			join(invalid, "SKILL.md"),
			"---\nname: invalid-skill\ndescription: not quoted\n---\n\n# Invalid\n",
			"utf8",
		);
		writeFileSync(join(invalid, "agents", "openai.yaml"), "interface: {}\n", "utf8");

		const result = spawnSync(process.execPath, [validator, invalid], { encoding: "utf8" });
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("description must be a quoted YAML string");
		expect(result.stderr).toContain("provider-specific agents/openai.yaml is not allowed");
	});
});
