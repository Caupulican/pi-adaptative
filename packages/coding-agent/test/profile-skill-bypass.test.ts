import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * Profile correctness: a skill blocked by the ACTIVE resource profile must not be selectable or
 * invocable — including after a RUNTIME profile switch with no reload. `getActiveSkills()` is the
 * single chokepoint every selection/invocation/agent-visibility surface reads, while the full
 * `getSkills()` set is preserved for the profile editor (which must show blockable skills).
 */
describe("resource profile blocks skills at the active-skills chokepoint", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;
	let settingsPath: string;

	const writeSkill = (name: string) => {
		const dir = join(agentDir, "skills", name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\nBody of ${name}.`);
	};

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-skill-bypass-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "cwd");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		settingsPath = join(agentDir, "settings.json");
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("hides a runtime-blocked skill from getActiveSkills but keeps it in getSkills (for the editor)", async () => {
		writeSkill("alpha-skill");
		writeSkill("beta-skill");
		// A 'locked' profile that blocks alpha-skill exists but is NOT active initially (so nothing is
		// filtered at load — both skills load normally).
		writeFileSync(
			settingsPath,
			JSON.stringify({ resourceProfiles: { locked: { skills: { block: ["alpha-skill"] } } } }),
			"utf-8",
		);

		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await loader.reload();

		// No active profile → both user skills are active.
		let active = loader.getActiveSkills().map((s) => s.name);
		expect(active).toContain("alpha-skill");
		expect(active).toContain("beta-skill");

		// Activate the blocking profile at RUNTIME (the router-managed / `/profile` path) — no reload.
		settingsManager.setRuntimeResourceProfiles(["locked"]);

		// The chokepoint now hides the blocked skill from every selection/invocation surface...
		active = loader.getActiveSkills().map((s) => s.name);
		expect(active).not.toContain("alpha-skill");
		expect(active).toContain("beta-skill");
		// ...but the full loaded set (profile editor / resource listing) still has it so it stays blockable.
		expect(loader.getSkills().skills.map((s) => s.name)).toContain("alpha-skill");

		// Deactivating restores it (no reload).
		settingsManager.setRuntimeResourceProfiles([]);
		expect(loader.getActiveSkills().map((s) => s.name)).toContain("alpha-skill");
	});

	it("honors a runtime allow-list (only allowed skills are active; full set preserved)", async () => {
		writeSkill("alpha-skill");
		writeSkill("beta-skill");
		writeFileSync(
			settingsPath,
			JSON.stringify({ resourceProfiles: { focused: { skills: { allow: ["beta-skill"] } } } }),
			"utf-8",
		);

		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await loader.reload();

		// Activate the allow-list at RUNTIME → only beta-skill is active (alpha and every other skill are
		// excluded), while the full loaded set still contains alpha for the editor.
		settingsManager.setRuntimeResourceProfiles(["focused"]);
		expect(loader.getActiveSkills().map((s) => s.name)).toEqual(["beta-skill"]);
		expect(loader.getSkills().skills.map((s) => s.name)).toContain("alpha-skill");
	});
});
