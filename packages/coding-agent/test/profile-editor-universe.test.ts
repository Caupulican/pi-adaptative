import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeResourceSelection, encodeResourceSelectionWithFraming } from "../src/core/profile-resource-selection.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * Profile-editor universe under strict UAC: the LOADED getters are profile-narrowed by design
 * (denied resources are never read), so the editor must build its grantable universe from the
 * profile-INDEPENDENT discovery getters — otherwise currently-blocked skills/prompts/context
 * files are ungrantable from within any restrictive profile (the tools "(none)" bug, one layer
 * up), and a save from that collapsed view corrupts the edited profile.
 */
describe("profile editor universe (discovery is profile-independent)", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-editor-universe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		const skillDir = join(agentDir, "skills", "hidden-skill");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "---\nname: hidden-skill\ndescription: x\n---\nBody.\n", "utf-8");
		const promptsDir = join(agentDir, "prompts");
		mkdirSync(promptsDir, { recursive: true });
		writeFileSync(join(promptsDir, "hidden-prompt.md"), "---\ndescription: y\n---\nPrompt body.\n", "utf-8");
		writeFileSync(join(tempDir, "AGENTS.md"), "Project instructions.\n", "utf-8");
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("discovery getters keep the full universe while a restrictive profile narrows the loaded sets", async () => {
		const settingsManager = SettingsManager.inMemory({
			resourceProfiles: { lean: { tools: { allow: ["read"] } } },
			activeResourceProfiles: ["lean"],
		});
		const loader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await loader.reload();

		// Loaded sets are narrowed (never read from disk) — ratified strict behavior.
		expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual([]);
		expect(loader.getPrompts().prompts.map((prompt) => prompt.name)).not.toContain("hidden-prompt");
		expect(loader.getAgentsFiles().agentsFiles).toEqual([]);

		// Discovery must still SEE everything so the editor can grant it.
		expect(loader.getDiscoverableSkillPaths().some((path) => path.includes("hidden-skill"))).toBe(true);
		expect(loader.getDiscoverablePromptPaths().some((path) => path.includes("hidden-prompt"))).toBe(true);
		expect(loader.getDiscoverableAgentsFilePaths().some((path) => path.endsWith("AGENTS.md"))).toBe(true);

		// The silent AGENTS.md drop is surfaced, not silent.
		const diagnostics = loader.getAgentsDiagnostics();
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]!.message).toContain("withheld by the active resource profile");
	});

	it("no active profile: nothing withheld, no diagnostic", async () => {
		const settingsManager = SettingsManager.inMemory({ activeResourceProfiles: [] });
		const loader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await loader.reload();
		expect(loader.getAgentsDiagnostics()).toEqual([]);
	});
});

describe("editor save preservation (no corruption from a collapsed universe)", () => {
	it("grants referenced outside the visible universe survive a decode/encode round-trip", () => {
		// The hunter's corruption repro, inverted: profile grants alpha+beta, universe only sees
		// alpha. Decoding against universe ∪ mentioned and re-encoding with the same widened set
		// must preserve beta.
		const filter = { allow: ["skill-alpha", "skill-beta"] };
		const visibleIds = ["skill-alpha"];
		const mentioned = filter.allow;
		const widened = [...new Set([...visibleIds, ...mentioned])];

		const enabled = decodeResourceSelection(filter, widened);
		expect(enabled).toEqual(new Set(["skill-alpha", "skill-beta"]));

		const encoded = encodeResourceSelectionWithFraming(enabled, widened, "allow");
		expect(encoded).toEqual({ allow: ["*"] });

		// Partial toggle: disabling only the visible skill must keep the invisible grant.
		enabled.delete("skill-alpha");
		const encodedPartial = encodeResourceSelectionWithFraming(enabled, widened, "allow");
		expect(encodedPartial).toEqual({ allow: ["skill-beta"] });
	});
});
