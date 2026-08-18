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
		expect(vault.load("frontend-motion", "model")).toMatchObject({
			ok: true,
			state: "loaded_pending",
			baseDir: join(root, "frontend-motion"),
		});
		expect(vault.status()).toMatchObject({ slots: [{ state: "loaded_pending", name: "frontend-motion" }] });

		const preview = vault.previewSystemPromptSection();
		const projected = vault.commitSystemPromptSection();

		expect(projected).toBe(preview);
		expect(projected).toContain("ACTIVE SKILL frontend-motion");
		expect(projected).toContain("Use interruptible transforms.");
		expect(projected).not.toContain("resource-profile");
		expect(projected).not.toContain("<skill");
		expect(vault.status()).toMatchObject({
			slots: [{ state: "active", name: "frontend-motion", lastUsedAtMs: 1_000 }],
		});
		expect(used).toHaveBeenCalledTimes(1);

		now = 2_000;
		const projectedAgain = vault.commitSystemPromptSection();
		expect(projectedAgain).toBe(projected);
		expect(vault.status()).toMatchObject({ slots: [{ state: "active", lastUsedAtMs: 2_000 }] });
		expect(used).toHaveBeenCalledTimes(1);
	});

	it("composes every loaded slot in load order for the next request", () => {
		const skills = createSkills([
			{ name: "alpha", description: "Alpha guidance.", body: "ALPHA-BODY" },
			{ name: "bravo", description: "Bravo guidance.", body: "BRAVO-BODY" },
		]);
		let now = 1_000;
		const used = vi.fn();
		const vault = new SkillVaultController({ getSkills: () => skills, now: () => now, onSkillUsed: used });

		expect(vault.load("alpha", "model")).toMatchObject({ ok: true, state: "loaded_pending" });
		now = 2_000;
		expect(vault.load("bravo", "model")).not.toHaveProperty("evicted");
		expect(vault.status().slots.map((slot) => slot.name)).toEqual(["alpha", "bravo"]);

		const preview = vault.previewSystemPromptSection();
		const projected = vault.commitSystemPromptSection();

		expect(projected).toBe(preview);
		expect(projected).toContain("ALPHA-BODY");
		expect(projected).toContain("BRAVO-BODY");
		expect(projected?.indexOf("ALPHA-BODY")).toBeLessThan(projected?.indexOf("BRAVO-BODY") ?? -1);
		expect(projected).toContain("\n\n");
		expect(used).toHaveBeenCalledTimes(2);
		expect(vault.status().slots.map((slot) => slot.state)).toEqual(["active", "active"]);
	});

	it("evicts the least-recently-used slot beyond the slot cap and reports it", () => {
		const skills = createSkills([
			{ name: "alpha", description: "Alpha guidance.", body: "ALPHA-BODY" },
			{ name: "bravo", description: "Bravo guidance.", body: "BRAVO-BODY" },
			{ name: "charlie", description: "Charlie guidance.", body: "CHARLIE-BODY" },
			{ name: "delta", description: "Delta guidance.", body: "DELTA-BODY" },
		]);
		let now = 1_000;
		const vault = new SkillVaultController({ getSkills: () => skills, now: () => now });
		vault.load("alpha", "model");
		now = 2_000;
		vault.load("bravo", "model");
		now = 3_000;
		vault.load("charlie", "model");
		now = 4_000;

		const result = vault.load("delta", "model");

		expect(result).toMatchObject({ ok: true, state: "loaded_pending", evicted: ["alpha"] });
		expect(vault.status().slots.map((slot) => slot.name)).toEqual(["bravo", "charlie", "delta"]);
		const projected = vault.commitSystemPromptSection();
		expect(projected).not.toContain("ALPHA-BODY");
		expect(projected).toContain("BRAVO-BODY");
		expect(projected).toContain("CHARLIE-BODY");
		expect(projected).toContain("DELTA-BODY");
	});

	it("evicts by byte budget before loading and rejects single over-budget bodies without eviction", () => {
		const skills = createSkills([
			{ name: "alpha", description: "Alpha guidance.", body: "a".repeat(600) },
			{ name: "bravo", description: "Bravo guidance.", body: "b".repeat(600) },
			{ name: "huge", description: "Huge guidance.", body: "h".repeat(2_000) },
		]);
		let now = 1_000;
		const vault = new SkillVaultController({ getSkills: () => skills, now: () => now, getMaxBodyBytes: () => 1_024 });

		expect(vault.load("alpha", "model")).not.toHaveProperty("evicted");
		now = 2_000;
		expect(vault.load("bravo", "model")).toMatchObject({ ok: true, evicted: ["alpha"] });
		expect(vault.status().slots.map((slot) => slot.name)).toEqual(["bravo"]);

		const revision = vault.getContextRevision();
		expect(vault.load("huge", "model")).toMatchObject({ ok: false, reason: "body_too_large" });
		expect(vault.status().slots.map((slot) => slot.name)).toEqual(["bravo"]);
		expect(vault.getContextRevision()).toBe(revision);
	});

	it("reports pending state, base dir, and evictions truthfully in the load tool text", async () => {
		const skills = createSkills([
			{ name: "alpha", description: "Alpha guidance.", body: "a".repeat(600) },
			{ name: "bravo", description: "Bravo guidance.", body: "b".repeat(600) },
		]);
		let now = 1_000;
		const vault = new SkillVaultController({ getSkills: () => skills, now: () => now, getMaxBodyBytes: () => 1_024 });
		const tool = createSkillVaultToolDefinition(vault);

		const first = await tool.execute(
			"load-alpha",
			{ action: "load", name: "alpha" },
			undefined,
			undefined,
			undefined as never,
		);
		const firstText = first.content[0]?.type === "text" ? first.content[0].text : "";
		expect(firstText).toContain("loaded_pending");
		expect(firstText).toContain(join(root, "alpha"));
		expect(firstText).toContain("activates next request");
		expect(firstText).not.toMatch(/\bactive\b/);
		expect(firstText).not.toContain("EVICTED");

		now = 2_000;
		const second = await tool.execute(
			"load-bravo",
			{ action: "load", name: "bravo" },
			undefined,
			undefined,
			undefined as never,
		);
		const secondText = second.content[0]?.type === "text" ? second.content[0].text : "";
		expect(secondText).toContain("loaded_pending");
		expect(secondText).toContain("EVICTED: alpha");
		expect(secondText).not.toMatch(/\bactive\b/);
	});

	it("expires only the stale slot on idle timeout", () => {
		const skills = createSkills([
			{ name: "alpha", description: "Alpha guidance.", body: "ALPHA-BODY" },
			{ name: "bravo", description: "Bravo guidance.", body: "BRAVO-BODY" },
		]);
		let now = 1_000;
		const vault = new SkillVaultController({ getSkills: () => skills, now: () => now, idleTimeoutMs: 5_000 });
		vault.load("alpha", "model");
		vault.commitSystemPromptSection();
		now = 4_000;
		vault.load("bravo", "model");

		expect(vault.status().slots).toMatchObject([
			{ state: "active", name: "alpha", lastUsedAtMs: 1_000 },
			{ state: "loaded_pending", name: "bravo" },
		]);

		now = 6_500;
		expect(vault.status().slots).toMatchObject([{ state: "loaded_pending", name: "bravo" }]);
		const projected = vault.commitSystemPromptSection();
		expect(projected).toContain("BRAVO-BODY");
		expect(projected).not.toContain("ALPHA-BODY");
	});

	it("unloads one named slot or every slot and lists the names", () => {
		const skills = createSkills([
			{ name: "alpha", description: "Alpha guidance.", body: "ALPHA-BODY" },
			{ name: "bravo", description: "Bravo guidance.", body: "BRAVO-BODY" },
		]);
		const vault = new SkillVaultController({ getSkills: () => skills });
		vault.load("alpha", "model");
		vault.load("bravo", "model");

		expect(vault.unload("alpha")).toEqual({ ok: true, unloaded: ["alpha"] });
		expect(vault.status().slots.map((slot) => slot.name)).toEqual(["bravo"]);

		vault.load("alpha", "model");
		expect(vault.unload()).toEqual({ ok: true, unloaded: ["bravo", "alpha"] });
		expect(vault.status()).toMatchObject({ slots: [], reason: "explicit" });
		expect(vault.unload("missing")).toEqual({ ok: true, unloaded: [] });
	});

	it("bumps the context revision on every slot change and composes byte-identical strings", () => {
		const skills = createSkills([
			{ name: "alpha", description: "Alpha guidance.", body: "ALPHA-BODY" },
			{ name: "bravo", description: "Bravo guidance.", body: "BRAVO-BODY" },
		]);
		let now = 1_000;
		const vault = new SkillVaultController({ getSkills: () => skills, now: () => now, idleTimeoutMs: 5_000 });

		const initial = vault.getContextRevision();
		vault.load("alpha", "model");
		const afterAlpha = vault.getContextRevision();
		expect(afterAlpha).toBeGreaterThan(initial);
		vault.load("bravo", "model");
		const afterBravo = vault.getContextRevision();
		expect(afterBravo).toBeGreaterThan(afterAlpha);

		const preview = vault.previewSystemPromptSection();
		const committed = vault.commitSystemPromptSection();
		expect(committed).toBe(preview);
		expect(vault.previewSystemPromptSection()).toBe(committed);
		expect(vault.getContextRevision()).toBe(afterBravo);

		vault.unload("alpha");
		const afterUnload = vault.getContextRevision();
		expect(afterUnload).toBeGreaterThan(afterBravo);

		now = 7_000;
		expect(vault.getContextRevision()).toBeGreaterThan(afterUnload);
		expect(vault.status()).toMatchObject({ slots: [], reason: "idle_expired" });
	});

	it("keeps the motivating trace's two skills co-resident without eviction", () => {
		const skills = createSkills([
			{ name: "harness-self-adaptation", description: "Harness adaptation.", body: "HARNESS-ADAPTATION-BODY" },
			{ name: "autonomous-execution", description: "Autonomous execution.", body: "AUTONOMOUS-EXECUTION-BODY" },
		]);
		const vault = new SkillVaultController({ getSkills: () => skills });

		expect(vault.load("harness-self-adaptation", "model")).toMatchObject({ ok: true });
		const second = vault.load("autonomous-execution", "model");

		expect(second).toMatchObject({ ok: true, state: "loaded_pending" });
		expect(second).not.toHaveProperty("evicted");
		const projected = vault.commitSystemPromptSection();
		expect(projected).toContain("HARNESS-ADAPTATION-BODY");
		expect(projected).toContain("AUTONOMOUS-EXECUTION-BODY");
	});

	it("refreshes a reloaded skill in place without evicting it", () => {
		const skills = createSkills([
			{ name: "alpha", description: "Alpha guidance.", body: "ALPHA-BODY" },
			{ name: "bravo", description: "Bravo guidance.", body: "BRAVO-BODY" },
		]);
		const vault = new SkillVaultController({ getSkills: () => skills });
		vault.load("alpha", "model");
		vault.load("bravo", "model");

		const reloaded = vault.load("alpha", "model");

		expect(reloaded).toMatchObject({ ok: true, state: "loaded_pending" });
		expect(reloaded).not.toHaveProperty("evicted");
		expect(vault.status().slots.map((slot) => slot.name)).toEqual(["alpha", "bravo"]);
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
		expect(vault.status().slots[0]?.state).toBe("active");
	});

	it("previews request cost without activating or refreshing the skill", () => {
		const skills = createSkills([
			{ name: "frontend-motion", description: "Accessible web motion.", body: "Use transforms." },
		]);
		let now = 1_000;
		const vault = new SkillVaultController({ getSkills: () => skills, now: () => now, idleTimeoutMs: 5_000 });
		vault.load("frontend-motion", "model");

		expect(vault.previewSystemPromptSection()).toContain("Use transforms.");
		expect(vault.status().slots[0]?.state).toBe("loaded_pending");
		vault.commitSystemPromptSection();
		now = 2_000;
		expect(vault.previewSystemPromptSection()).toContain("Use transforms.");
		expect(vault.status()).toMatchObject({ slots: [{ state: "active", lastUsedAtMs: 1_000, idleForMs: 1_000 }] });
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
		expect(vault.status()).toMatchObject({ slots: [], reason: "idle_expired" });
	});

	it("expires a pending load that never reaches a model request", () => {
		const skills = createSkills([
			{ name: "frontend-motion", description: "Accessible web motion.", body: "Use transforms." },
		]);
		let now = 10_000;
		const vault = new SkillVaultController({ getSkills: () => skills, now: () => now, idleTimeoutMs: 1_000 });
		vault.load("frontend-motion", "model");

		now = 11_001;

		expect(vault.status()).toMatchObject({ slots: [], reason: "idle_expired" });
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

		expect(vault.status()).toMatchObject({ slots: [{ state: "active", lastUsedAtMs: 15_000, idleForMs: 0 }] });
	});

	it("invalidates a loaded skill when its active resource grant disappears", () => {
		let skills = createSkills([
			{ name: "frontend-motion", description: "Accessible web motion.", body: "Use transforms." },
		]);
		const vault = new SkillVaultController({ getSkills: () => skills });
		vault.load("frontend-motion", "model");
		skills = [];

		expect(vault.commitSystemPromptSection()).toBeUndefined();
		expect(vault.status()).toMatchObject({ slots: [], reason: "resource_unavailable" });
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

		expect(vault.unload()).toEqual({ ok: true, unloaded: ["frontend-motion"] });
		expect(vault.commitSystemPromptSection()).toBeUndefined();
		expect(vault.status().slots).toEqual([]);
	});

	it("rejects an activation body over the current model budget without truncating it", () => {
		const skills = createSkills([{ name: "large-skill", description: "Large workflow.", body: "x".repeat(4_096) }]);
		const vault = new SkillVaultController({ getSkills: () => skills, getMaxBodyBytes: () => 1_024 });

		expect(vault.load("large-skill", "model")).toMatchObject({ ok: false, reason: "body_too_large" });
		expect(vault.status().slots).toEqual([]);
	});

	it("invalidates an active body when a model switch reduces its context budget", () => {
		const skills = createSkills([{ name: "large-skill", description: "Large workflow.", body: "x".repeat(8_192) }]);
		let bodyLimit = 16_384;
		const vault = new SkillVaultController({ getSkills: () => skills, getMaxBodyBytes: () => bodyLimit });
		vault.load("large-skill", "model");
		vault.commitSystemPromptSection();

		bodyLimit = 4_096;

		expect(vault.commitSystemPromptSection()).toBeUndefined();
		expect(vault.status()).toMatchObject({ slots: [], reason: "budget_exceeded" });
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
		expect(vault.status().slots[0]?.state).toBe("loaded_pending");

		const unloaded = await tool.execute(
			"unload-call",
			{ action: "unload" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(unloaded.content[0]?.type === "text" ? unloaded.content[0].text : "").toContain("frontend-motion");
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

		expect(status).toEqual({ idleTimeoutMs: expect.any(Number), slots: [] });
	});
});
