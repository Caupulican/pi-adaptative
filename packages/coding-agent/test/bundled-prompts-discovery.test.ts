import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";

describe("bundled prompts discovery", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `bundled-prompts-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("should discover bundled prompts", async () => {
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const { prompts } = loader.getPrompts();

		// Verify bundled prompts are discovered
		const skillify = prompts.find((p) => p.name === "skillify");
		const extensionify = prompts.find((p) => p.name === "extensionify");
		const learn = prompts.find((p) => p.name === "learn");

		expect(skillify).toBeDefined();
		expect(extensionify).toBeDefined();
		expect(learn).toBeDefined();

		// Verify bundled prompts have correct source info
		if (skillify) {
			expect(skillify.sourceInfo?.source).toBe("local");
			expect(skillify.sourceInfo?.scope).toBe("temporary");
			expect(skillify.description).toBeTruthy();
		}

		if (extensionify) {
			expect(extensionify.sourceInfo?.source).toBe("local");
			expect(extensionify.sourceInfo?.scope).toBe("temporary");
			expect(extensionify.description).toBeTruthy();
		}

		if (learn) {
			expect(learn.sourceInfo?.source).toBe("local");
			expect(learn.sourceInfo?.scope).toBe("temporary");
			expect(learn.description).toBeTruthy();
		}
	});

	it("should allow user prompts to override bundled prompts", async () => {
		// Create a user prompt with the same name as a bundled prompt
		const userPromptsDir = join(agentDir, "prompts");
		mkdirSync(userPromptsDir, { recursive: true });
		writeFileSync(
			join(userPromptsDir, "skillify.md"),
			`---
description: User override of bundled skillify prompt
argument-hint: "[custom process]"
---
# User Skillify

This is a user prompt that overrides the bundled skillify prompt.`,
		);

		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const { prompts } = loader.getPrompts();
		const skillify = prompts.find((p) => p.name === "skillify");

		expect(skillify).toBeDefined();
		if (skillify) {
			expect(skillify.sourceInfo?.scope).toBe("user");
			expect(skillify.filePath).toContain("agent/prompts");
			expect(skillify.description).toBe("User override of bundled skillify prompt");
		}
	});

	it("should allow project prompts to override bundled prompts", async () => {
		// Create a project prompt with the same name as a bundled prompt
		const projectPromptsDir = join(cwd, ".pi", "prompts");
		mkdirSync(projectPromptsDir, { recursive: true });
		writeFileSync(
			join(projectPromptsDir, "learn.md"),
			`---
description: Project override of bundled learn prompt
argument-hint: "[custom lesson]"
---
# Project Learn

This is a project prompt that overrides the bundled learn prompt.`,
		);

		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const { prompts } = loader.getPrompts();
		const learn = prompts.find((p) => p.name === "learn");

		expect(learn).toBeDefined();
		if (learn) {
			expect(learn.sourceInfo?.scope).toBe("project");
			expect(learn.filePath).toContain(".pi/prompts");
			expect(learn.description).toBe("Project override of bundled learn prompt");
		}
	});
});
