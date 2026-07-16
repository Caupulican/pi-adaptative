import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";

describe("bundled skills discovery", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `bundled-skills-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("should discover bundled skills", async () => {
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const { skills } = loader.getSkills();

		// Verify bundled skills are discovered
		const skillArchitect = skills.find((s) => s.name === "skill-architect");
		const piHarnessLearning = skills.find((s) => s.name === "pi-harness-learning");
		const harnessSelfAdaptation = skills.find((s) => s.name === "harness-self-adaptation");

		expect(skillArchitect).toBeDefined();
		expect(piHarnessLearning).toBeDefined();
		expect(harnessSelfAdaptation).toBeDefined();

		// Verify bundled skills have correct source info
		if (skillArchitect) {
			expect(skillArchitect.sourceInfo?.source).toBe("local");
			expect(skillArchitect.sourceInfo?.scope).toBe("temporary");
		}

		if (piHarnessLearning) {
			expect(piHarnessLearning.sourceInfo?.source).toBe("local");
			expect(piHarnessLearning.sourceInfo?.scope).toBe("temporary");
		}

		if (harnessSelfAdaptation) {
			expect(harnessSelfAdaptation.sourceInfo?.source).toBe("local");
			expect(harnessSelfAdaptation.sourceInfo?.scope).toBe("temporary");
		}
	});

	it("should ship the harness self-adaptation contract and layer reference", async () => {
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const skill = loader.getSkills().skills.find((candidate) => candidate.name === "harness-self-adaptation");
		expect(skill).toBeDefined();
		if (!skill) return;

		const content = readFileSync(skill.filePath, "utf8");
		const referencePath = join(dirname(skill.filePath), "references", "adaptation-layers.md");
		expect(existsSync(referencePath)).toBe(true);
		expect(content.split("\n").length).toBeLessThan(500);
		expect(skill.description).toContain("ALWAYS use for work on the Pi/pi-adaptative harness");
		expect(content).toContain("baseline unavailable");
		expect(content).toContain("### 7. Apply the retention gate");
		expect(content).toMatch(/five failed\s+attempts/);
		expect(content).toContain("Human on the edge");

		const requiredHeaders = [
			"## How to use the skill",
			"## North Star",
			"## Core Sections",
			"## Anti-Patterns",
			"## Examples",
			"## Self-Check",
			"## Known Gaps",
		];
		let previousIndex = -1;
		for (const header of requiredHeaders) {
			const index = content.indexOf(header);
			expect(index).toBeGreaterThan(previousIndex);
			previousIndex = index;
		}

		const reference = readFileSync(referencePath, "utf8");
		expect(reference).toContain("## Layer matrix");
		expect(reference).toContain("| Core source |");
		expect(reference).toContain("measure the whole system boundary");
	});

	it("treats direct harness-improvement requests as scoped source authority", async () => {
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const skill = loader.getSkills().skills.find((candidate) => candidate.name === "pi-harness-learning");
		expect(skill).toBeDefined();
		if (!skill) return;

		const content = readFileSync(skill.filePath, "utf8");
		expect(content).toMatch(/do\s+not ask for duplicate approval/);
		expect(content).toContain("A direct request to");
		expect(content).toMatch(/still require\s+specific approval/);
	});

	it("should allow user skills to override bundled skills", async () => {
		// Create a user skill with the same name as a bundled skill
		const userSkillDir = join(agentDir, "skills", "skill-architect");
		mkdirSync(userSkillDir, { recursive: true });
		writeFileSync(
			join(userSkillDir, "SKILL.md"),
			`---
name: skill-architect
description: User override of bundled skill
---
# User Skill Architect
This is a user skill that overrides the bundled one.`,
		);

		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const { skills } = loader.getSkills();
		const skillArchitect = skills.find((s) => s.name === "skill-architect");

		expect(skillArchitect).toBeDefined();
		if (skillArchitect) {
			expect(skillArchitect.sourceInfo?.scope).toBe("user");
			expect(skillArchitect.filePath).toContain(join(agentDir, "skills"));
		}
	});

	it("should allow project skills to override bundled skills", async () => {
		// Create a project skill with the same name as a bundled skill
		const projectSkillDir = join(cwd, ".pi", "skills", "pi-harness-learning");
		mkdirSync(projectSkillDir, { recursive: true });
		writeFileSync(
			join(projectSkillDir, "SKILL.md"),
			`---
name: pi-harness-learning
description: Project override of bundled skill
---
# Project Harness Learning
This is a project skill that overrides the bundled one.`,
		);

		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const { skills } = loader.getSkills();
		const piHarnessLearning = skills.find((s) => s.name === "pi-harness-learning");

		expect(piHarnessLearning).toBeDefined();
		if (piHarnessLearning) {
			expect(piHarnessLearning.sourceInfo?.scope).toBe("project");
			expect(piHarnessLearning.filePath).toContain(join(cwd, ".pi", "skills"));
		}
	});
});
