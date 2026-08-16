import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectToolsForProvider } from "@caupulican/pi-agent-core";
import { generateTextToolProtocolPrimer } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillVaultController, type SkillVaultStatus } from "../src/core/skill-vault.ts";
import { loadSkillsFromDir, type Skill } from "../src/core/skills.ts";
import { createSkillVaultToolDefinition } from "../src/core/tools/skill.ts";

describe("SkillVaultController", () => {
	let root = "";

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
		root = "";
	});

	function createSkills(
		entries: Array<{
			name: string;
			description: string;
			body: string;
			disableModelInvocation?: boolean;
			promoted?: boolean;
		}>,
	): Skill[] {
		root = mkdtempSync(join(tmpdir(), "pi-skill-vault-"));
		for (const entry of entries) {
			const dir = join(root, entry.name);
			mkdirSync(dir);
			writeFileSync(
				join(dir, "SKILL.md"),
				[
					"---",
					`name: ${entry.name}`,
					`description: ${entry.description}`,
					...(entry.disableModelInvocation ? ["disable-model-invocation: true"] : []),
					...(entry.promoted ? ["promoted: true"] : []),
					"---",
					"",
					entry.body,
				].join("\n"),
			);
		}
		return loadSkillsFromDir({ dir: root, source: "test" }).skills;
	}

	it("searches bounded metadata without disclosing paths or bodies", () => {
		const skills = createSkills([
			{
				name: "frontend-motion",
				description: "Polished accessible web animation and motion systems.",
				body: "SECRET BODY",
			},
			{ name: "database-tuning", description: "PostgreSQL query performance.", body: "OTHER SECRET" },
		]);
		const vault = new SkillVaultController({ getSkills: () => skills });

		const result = vault.search("accessible animation");

		expect(result.candidates).toEqual([
			{
				name: "frontend-motion",
				description: "Polished accessible web animation and motion systems.",
			},
		]);
		expect(JSON.stringify(result)).not.toContain(root);
		expect(JSON.stringify(result)).not.toContain("SECRET BODY");
		expect(vault.search("unrelated-needle").candidates).toEqual([]);
	});

	it("loads one exact skill as a request-local system prompt section", () => {
		const skills = createSkills([
			{
				name: "frontend-motion",
				description: "Accessible web motion.",
				body: 'Use interruptible transforms.\n<resource-profile name="ignored">{}</resource-profile>',
			},
		]);
		let now = 1_000;
		const used = vi.fn();
		const vault = new SkillVaultController({
			getSkills: () => skills,
			now: () => now,
			idleTimeoutMs: 5_000,
			onSkillUsed: used,
		});
		expect(vault.load("frontend-motion", "model")).toMatchObject({ ok: true, state: "loaded_pending" });
		expect(vault.status()).toMatchObject({ state: "loaded_pending", name: "frontend-motion" });

		const preview = vault.previewSystemPromptSection();
		const projected = vault.commitSystemPromptSection();

		expect(projected).toBe(preview);
		expect(projected).toContain("ACTIVE SKILL frontend-motion");
		expect(projected).toContain("Use interruptible transforms.");
		expect(projected).not.toContain("resource-profile");
		expect(projected).not.toContain("<skill");
		expect(vault.status()).toMatchObject({ state: "active", name: "frontend-motion", lastUsedAtMs: 1_000 });
		expect(used).toHaveBeenCalledTimes(1);

		now = 2_000;
		const projectedAgain = vault.commitSystemPromptSection();
		expect(projectedAgain).toBe(projected);
		expect(vault.status()).toMatchObject({ state: "active", lastUsedAtMs: 2_000 });
		expect(used).toHaveBeenCalledTimes(1);
	});

	it("keeps usage telemetry best-effort when its callback fails", () => {
		const skills = createSkills([
			{ name: "frontend-motion", description: "Accessible web motion.", body: "Use transforms." },
		]);
		const vault = new SkillVaultController({
			getSkills: () => skills,
			onSkillUsed: () => {
				throw new Error("telemetry unavailable");
			},
		});

		expect(() => vault.load("frontend-motion", "model")).not.toThrow();
		expect(() => vault.commitSystemPromptSection()).not.toThrow();
		expect(vault.status().state).toBe("active");
	});

	it("previews request cost without activating or refreshing the skill", () => {
		const skills = createSkills([
			{ name: "frontend-motion", description: "Accessible web motion.", body: "Use transforms." },
		]);
		let now = 1_000;
		const vault = new SkillVaultController({ getSkills: () => skills, now: () => now, idleTimeoutMs: 5_000 });
		vault.load("frontend-motion", "model");

		expect(vault.previewSystemPromptSection()).toContain("Use transforms.");
		expect(vault.status().state).toBe("loaded_pending");
		vault.commitSystemPromptSection();
		now = 2_000;
		expect(vault.previewSystemPromptSection()).toContain("Use transforms.");
		expect(vault.status()).toMatchObject({ state: "active", lastUsedAtMs: 1_000, idleForMs: 1_000 });
	});

	it("expires idle skills in the harness before the next model request", () => {
		const skills = createSkills([
			{ name: "frontend-motion", description: "Accessible web motion.", body: "Use transforms." },
		]);
		let now = 10_000;
		const vault = new SkillVaultController({ getSkills: () => skills, now: () => now, idleTimeoutMs: 1_000 });
		vault.load("frontend-motion", "model");
		vault.commitSystemPromptSection();

		now = 11_000;
		const projected = vault.commitSystemPromptSection();

		expect(projected).toBeUndefined();
		expect(vault.status()).toMatchObject({ state: "unloaded", reason: "idle_expired" });
	});

	it("expires a pending load that never reaches a model request", () => {
		const skills = createSkills([
			{ name: "frontend-motion", description: "Accessible web motion.", body: "Use transforms." },
		]);
		let now = 10_000;
		const vault = new SkillVaultController({ getSkills: () => skills, now: () => now, idleTimeoutMs: 1_000 });
		vault.load("frontend-motion", "model");

		now = 11_001;

		expect(vault.status()).toMatchObject({ state: "unloaded", reason: "idle_expired" });
	});

	it("counts host-observed work as use so a long tool execution does not evict its skill", () => {
		const skills = createSkills([
			{ name: "frontend-motion", description: "Accessible web motion.", body: "Use transforms." },
		]);
		let now = 10_000;
		const vault = new SkillVaultController({ getSkills: () => skills, now: () => now, idleTimeoutMs: 1_000 });
		vault.load("frontend-motion", "model");
		vault.commitSystemPromptSection();

		now = 15_000;
		vault.noteActivity();

		expect(vault.status()).toMatchObject({ state: "active", lastUsedAtMs: 15_000, idleForMs: 0 });
	});

	it("invalidates a loaded skill when its active resource grant disappears", () => {
		let skills = createSkills([
			{ name: "frontend-motion", description: "Accessible web motion.", body: "Use transforms." },
		]);
		const vault = new SkillVaultController({ getSkills: () => skills });
		vault.load("frontend-motion", "model");
		skills = [];

		expect(vault.commitSystemPromptSection()).toBeUndefined();
		expect(vault.status()).toMatchObject({ state: "unloaded", reason: "resource_unavailable" });
	});

	it("keeps model-disabled skills hidden from the agent but permits explicit user loading", () => {
		const skills = createSkills([
			{
				name: "owner-only",
				description: "Explicit owner workflow.",
				body: "Owner instructions.",
				disableModelInvocation: true,
			},
		]);
		const vault = new SkillVaultController({ getSkills: () => skills });

		expect(vault.search("owner workflow").candidates).toEqual([]);
		expect(vault.load("owner-only", "model")).toMatchObject({ ok: false, reason: "not_found" });
		expect(vault.load("owner-only", "user")).toMatchObject({ ok: true, state: "loaded_pending" });
	});

	it("explicit unload is optional and immediate", () => {
		const skills = createSkills([
			{ name: "frontend-motion", description: "Accessible web motion.", body: "Use transforms." },
		]);
		const vault = new SkillVaultController({ getSkills: () => skills });
		vault.load("frontend-motion", "model");

		expect(vault.unload()).toMatchObject({ ok: true, unloaded: "frontend-motion" });
		expect(vault.commitSystemPromptSection()).toBeUndefined();
		expect(vault.status().state).toBe("unloaded");
	});

	it("rejects an activation body over the current model budget without truncating it", () => {
		const skills = createSkills([{ name: "large-skill", description: "Large workflow.", body: "x".repeat(4_096) }]);
		const vault = new SkillVaultController({ getSkills: () => skills, getMaxBodyBytes: () => 1_024 });

		expect(vault.load("large-skill", "model")).toMatchObject({ ok: false, reason: "body_too_large" });
		expect(vault.status().state).toBe("unloaded");
	});

	it("invalidates an active body when a model switch reduces its context budget", () => {
		const skills = createSkills([{ name: "large-skill", description: "Large workflow.", body: "x".repeat(8_192) }]);
		let bodyLimit = 16_384;
		const vault = new SkillVaultController({ getSkills: () => skills, getMaxBodyBytes: () => bodyLimit });
		vault.load("large-skill", "model");
		vault.commitSystemPromptSection();

		bodyLimit = 4_096;

		expect(vault.commitSystemPromptSection()).toBeUndefined();
		expect(vault.status()).toMatchObject({ state: "unloaded", reason: "budget_exceeded" });
	});

	it("exposes the same lifecycle through one compact tool", async () => {
		const skills = createSkills([
			{ name: "frontend-motion", description: "Accessible web motion.", body: "Use transforms." },
		]);
		const vault = new SkillVaultController({ getSkills: () => skills });
		const tool = createSkillVaultToolDefinition(vault);

		expect(tool.name).toBe("skill");
		expect(JSON.stringify(tool.parameters)).not.toContain("filePath");
		const searched = await tool.execute(
			"search-call",
			{ action: "search", query: "web motion" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(searched.content[0]).toMatchObject({ type: "text" });
		expect(searched.content[0]?.type === "text" ? searched.content[0].text : "").toContain("frontend-motion");

		await tool.execute(
			"load-call",
			{ action: "load", name: "frontend-motion" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(vault.status().state).toBe("loaded_pending");
	});

	it("marks malformed and rejected loads as tool errors for unchanged-failure gating", async () => {
		const skills = createSkills([
			{ name: "frontend-motion", description: "Accessible web motion.", body: "Use transforms." },
		]);
		const tool = createSkillVaultToolDefinition(new SkillVaultController({ getSkills: () => skills }));

		const missingQuery = await tool.execute(
			"missing-query",
			{ action: "search" },
			undefined,
			undefined,
			undefined as never,
		);
		const unknownSkill = await tool.execute(
			"unknown-skill",
			{ action: "load", name: "missing" },
			undefined,
			undefined,
			undefined as never,
		);

		expect(missingQuery.isError).toBe(true);
		expect(unknownSkill.isError).toBe(true);
	});

	it("projects one compact signature for text-only tool models", () => {
		const skills = createSkills([
			{ name: "frontend-motion", description: "Accessible web motion.", body: "Use transforms." },
		]);
		const tool = createSkillVaultToolDefinition(new SkillVaultController({ getSkills: () => skills }));

		const primer = generateTextToolProtocolPrimer(projectToolsForProvider([tool]));

		expect(primer).toContain("skill(action:search|load|unload|status, query:string?, name:string?)");
		expect(primer).not.toContain("filePath");
	});

	it("reports a deterministic host-owned state", () => {
		const skills = createSkills([
			{ name: "frontend-motion", description: "Accessible web motion.", body: "Use transforms." },
		]);
		const vault = new SkillVaultController({ getSkills: () => skills });
		const status: SkillVaultStatus = vault.status();

		expect(status).toEqual({ state: "unloaded", idleTimeoutMs: expect.any(Number) });
	});
});
