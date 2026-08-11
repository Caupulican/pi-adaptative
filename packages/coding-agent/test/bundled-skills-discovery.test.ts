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
		const skillCreator = skills.find((s) => s.name === "skill-creator");
		const piHarnessLearning = skills.find((s) => s.name === "pi-harness-learning");
		const harnessSelfAdaptation = skills.find((s) => s.name === "harness-self-adaptation");
		const deduplicateByEvidence = skills.find((s) => s.name === "deduplicate-by-evidence");
		const evidenceGatedTdd = skills.find((s) => s.name === "evidence-gated-tdd");
		const authorizedWebSecurityAudit = skills.find((s) => s.name === "authorized-web-security-audit");
		const secureAgentToolSurfaces = skills.find((s) => s.name === "secure-agent-tool-surfaces");
		const workerProfileWriter = skills.find((s) => s.name === "worker-profile-writer");

		expect(skillArchitect).toBeDefined();
		expect(skillCreator).toBeDefined();
		expect(piHarnessLearning).toBeDefined();
		expect(harnessSelfAdaptation).toBeDefined();
		expect(deduplicateByEvidence).toBeDefined();
		expect(evidenceGatedTdd).toBeDefined();
		expect(authorizedWebSecurityAudit).toBeDefined();
		expect(secureAgentToolSurfaces).toBeDefined();
		expect(workerProfileWriter).toBeDefined();

		// Verify bundled skills have correct source info
		if (skillArchitect) {
			expect(skillArchitect.sourceInfo?.source).toBe("local");
			expect(skillArchitect.sourceInfo?.scope).toBe("temporary");
		}

		if (skillCreator) {
			expect(skillCreator.sourceInfo?.source).toBe("local");
			expect(skillCreator.sourceInfo?.scope).toBe("temporary");
		}

		if (piHarnessLearning) {
			expect(piHarnessLearning.sourceInfo?.source).toBe("local");
			expect(piHarnessLearning.sourceInfo?.scope).toBe("temporary");
		}

		if (harnessSelfAdaptation) {
			expect(harnessSelfAdaptation.sourceInfo?.source).toBe("local");
			expect(harnessSelfAdaptation.sourceInfo?.scope).toBe("temporary");
		}

		if (deduplicateByEvidence) {
			expect(deduplicateByEvidence.sourceInfo?.source).toBe("local");
			expect(deduplicateByEvidence.sourceInfo?.scope).toBe("temporary");
		}

		if (evidenceGatedTdd) {
			expect(evidenceGatedTdd.sourceInfo?.source).toBe("local");
			expect(evidenceGatedTdd.sourceInfo?.scope).toBe("temporary");
		}

		if (authorizedWebSecurityAudit) {
			expect(authorizedWebSecurityAudit.sourceInfo?.source).toBe("local");
			expect(authorizedWebSecurityAudit.sourceInfo?.scope).toBe("temporary");
		}

		if (secureAgentToolSurfaces) {
			expect(secureAgentToolSurfaces.sourceInfo?.source).toBe("local");
			expect(secureAgentToolSurfaces.sourceInfo?.scope).toBe("temporary");
		}

		if (workerProfileWriter) {
			expect(workerProfileWriter.sourceInfo?.source).toBe("local");
			expect(workerProfileWriter.sourceInfo?.scope).toBe("temporary");
		}
	});

	it("ships session-scoped worker profile composition without provider metadata", async () => {
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const skill = loader.getSkills().skills.find((candidate) => candidate.name === "worker-profile-writer");
		expect(skill).toBeDefined();
		if (!skill) return;

		const content = readFileSync(skill.filePath, "utf8");
		expect(existsSync(join(dirname(skill.filePath), "agents", "openai.yaml"))).toBe(false);
		expect(content).toContain('action: "profile_create"');
		expect(content).toContain("exact harness-issued profile ID");
		expect(content).toContain("Human edge");
		expect(content.split("\n").length).toBeLessThan(500);
	});

	it("ships a provider-neutral Pi skill creator with deterministic local tooling", async () => {
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const skill = loader.getSkills().skills.find((candidate) => candidate.name === "skill-creator");
		expect(skill).toBeDefined();
		if (!skill) return;

		const content = readFileSync(skill.filePath, "utf8");
		expect(existsSync(join(dirname(skill.filePath), "agents", "openai.yaml"))).toBe(false);
		expect(content.split("\n").length).toBeLessThan(500);
		expect(content).toContain("scripts/init-skill.mjs");
		expect(content).toContain("scripts/validate-skill.mjs");
		expect(content).toContain("provider-neutral");
		expect(existsSync(join(dirname(skill.filePath), "scripts", "init-skill.mjs"))).toBe(true);
		expect(existsSync(join(dirname(skill.filePath), "scripts", "validate-skill.mjs"))).toBe(true);
	});

	it("ships provider-neutral security workflows with fail-closed authority boundaries", async () => {
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const skills = loader.getSkills().skills;
		const webAudit = skills.find((candidate) => candidate.name === "authorized-web-security-audit");
		const toolSurfaces = skills.find((candidate) => candidate.name === "secure-agent-tool-surfaces");
		expect(webAudit).toBeDefined();
		expect(toolSurfaces).toBeDefined();
		if (!webAudit || !toolSurfaces) return;

		const webAuditContent = readFileSync(webAudit.filePath, "utf8");
		expect(existsSync(join(dirname(webAudit.filePath), "agents", "openai.yaml"))).toBe(false);
		expect(webAuditContent.split("\n").length).toBeLessThan(500);
		expect(webAuditContent).toContain("written authorization");
		expect(webAuditContent).toContain("scope manifest");
		expect(webAuditContent).toContain("negative control");
		expect(webAuditContent).toContain("Do not infer authorization");
		expect(existsSync(join(dirname(webAudit.filePath), "references", "assessment-contract.md"))).toBe(true);

		const toolSurfaceContent = readFileSync(toolSurfaces.filePath, "utf8");
		expect(existsSync(join(dirname(toolSurfaces.filePath), "agents", "openai.yaml"))).toBe(false);
		expect(toolSurfaceContent.split("\n").length).toBeLessThan(500);
		expect(toolSurfaceContent).toContain("session tenant");
		expect(toolSurfaceContent).toContain("untrusted result");
		expect(toolSurfaceContent).toContain("loopback");
		expect(toolSurfaceContent).toContain("SSRF");
		expect(toolSurfaceContent).toContain("event-driven");
		expect(existsSync(join(dirname(toolSurfaces.filePath), "references", "tool-boundary-checklist.md"))).toBe(true);
		const exploitCataloguePath = join(dirname(toolSurfaces.filePath), "references", "defensive-exploit-catalogue.md");
		expect(existsSync(exploitCataloguePath)).toBe(true);
		const exploitCatalogue = readFileSync(exploitCataloguePath, "utf8");
		expect(exploitCatalogue).toContain("Prompt and tool injection");
		expect(exploitCatalogue).toContain("DNS rebinding");
		expect(exploitCatalogue).toContain("Tenant crossover");
		expect(exploitCatalogue).toContain("Regression oracle");
	});

	it("ships deduplication and evidence-gated TDD as complete first-party workflows", async () => {
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const skills = loader.getSkills().skills;
		const deduplicateByEvidence = skills.find((candidate) => candidate.name === "deduplicate-by-evidence");
		const evidenceGatedTdd = skills.find((candidate) => candidate.name === "evidence-gated-tdd");
		expect(deduplicateByEvidence).toBeDefined();
		expect(evidenceGatedTdd).toBeDefined();
		if (!deduplicateByEvidence || !evidenceGatedTdd) return;

		const deduplicationContent = readFileSync(deduplicateByEvidence.filePath, "utf8");
		expect(existsSync(join(dirname(deduplicateByEvidence.filePath), "agents", "openai.yaml"))).toBe(false);
		expect(deduplicationContent.split("\n").length).toBeLessThan(500);
		expect(deduplicationContent).toContain("Detect → Verify → Score → Gate");
		expect(deduplicationContent).toContain("For jscpd");
		expect(deduplicationContent).toContain("candidate-file count");
		expect(deduplicationContent).toContain("zero textual clones");

		const tddContent = readFileSync(evidenceGatedTdd.filePath, "utf8");
		expect(existsSync(join(dirname(evidenceGatedTdd.filePath), "agents", "openai.yaml"))).toBe(false);
		expect(tddContent.split("\n").length).toBeLessThan(500);
		expect(tddContent).toContain("Detect → Verify → Score → Gate");
		expect(tddContent).toContain("negative control");
		expect(tddContent).toContain("Review the report body");
		expect(existsSync(join(dirname(evidenceGatedTdd.filePath), "references", "evidence-model.md"))).toBe(true);
		expect(existsSync(join(dirname(evidenceGatedTdd.filePath), "references", "security-scanners.md"))).toBe(true);
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
