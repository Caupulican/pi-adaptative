import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

		expect(skillArchitect).toBeDefined();
		expect(piHarnessLearning).toBeDefined();

		// Verify bundled skills have correct source info
		if (skillArchitect) {
			expect(skillArchitect.sourceInfo?.source).toBe("local");
			expect(skillArchitect.sourceInfo?.scope).toBe("temporary");
		}

		if (piHarnessLearning) {
			expect(piHarnessLearning.sourceInfo?.source).toBe("local");
			expect(piHarnessLearning.sourceInfo?.scope).toBe("temporary");
		}
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
			expect(skillArchitect.filePath).toContain("agent/skills");
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
			expect(piHarnessLearning.filePath).toContain(".pi/skills");
		}
	});
});
