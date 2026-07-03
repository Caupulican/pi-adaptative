import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decodeResourceSelection, encodeResourceSelectionWithFraming } from "../src/core/profile-resource-selection.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ProfileResourceEditorComponent } from "../src/modes/interactive/components/profile-resource-editor.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => {
	initTheme("dark");
});

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

		// All enabled, but the original grant was enumerated — a no-change save must preserve the exact
		// closed grant, not widen it to allow:["*"] (which would auto-grant every future skill).
		const encoded = encodeResourceSelectionWithFraming(enabled, widened, "allow", { originalFilter: filter });
		expect(encoded).toEqual({ allow: ["skill-alpha", "skill-beta"] });

		// Partial toggle: disabling only the visible skill must keep the invisible grant.
		enabled.delete("skill-alpha");
		const encodedPartial = encodeResourceSelectionWithFraming(enabled, widened, "allow", { originalFilter: filter });
		expect(encodedPartial).toEqual({ allow: ["skill-beta"] });
	});
});

/**
 * The literal "*" is a framing marker inside a filter's allow/block arrays, never a real resource
 * id. The constructor's missing-item scan must not confuse the two: an unguarded allow-loop lets
 * "*" leak into mentionedIds/missingSet as if it were a selectable item, which then rides along
 * through decode (as a fake "enabled" member) and, on a partial save, back out into the encoded
 * allow-list — where minimatch("*") matches every basename, silently un-revoking whatever the user
 * just unchecked.
 */
describe("editor working set must not treat the wildcard framing marker as a resource id", () => {
	const kinds = [
		{
			kind: "skills" as const,
			label: "Skills",
			items: [
				{ id: "skill-a", path: "/catalog/skill-a" },
				{ id: "skill-b", path: "/catalog/skill-b" },
				{ id: "skill-c", path: "/catalog/skill-c" },
			],
		},
	];

	it("decoding an { allow: ['*'] } grant enables only real items, never the literal '*'", () => {
		const editor = new ProfileResourceEditorComponent({
			profileName: "p",
			profileScope: "session",
			initialResources: { skills: { allow: ["*"] } },
			kinds,
			onSave: () => {},
			onCancel: () => {},
		});

		const enabledSet = (editor as unknown as { enabledByKind: Map<string, Set<string>> }).enabledByKind.get(
			"skills",
		)!;
		expect(enabledSet.has("*")).toBe(false);
		expect([...enabledSet].sort()).toEqual(["skill-a", "skill-b", "skill-c"]);
	});

	it("unchecking one item under a wildcard grant saves an enumerated remainder without '*', genuinely denying the unchecked item", () => {
		let saved: { skills?: { allow?: string[]; block?: string[] } } | undefined;
		const editor = new ProfileResourceEditorComponent({
			profileName: "p",
			profileScope: "session",
			initialResources: { skills: { allow: ["*"] } },
			kinds,
			onSave: (resources) => {
				saved = resources;
			},
			onCancel: () => {},
		});

		const enabledSet = (editor as unknown as { enabledByKind: Map<string, Set<string>> }).enabledByKind.get(
			"skills",
		)!;
		enabledSet.delete("skill-a");
		(editor as unknown as { persistChanges(): void }).persistChanges();

		expect(saved?.skills).toEqual({ allow: ["skill-b", "skill-c"] });

		const settingsManager = SettingsManager.inMemory({
			resourceProfiles: { p: { skills: saved!.skills! } },
			activeResourceProfiles: ["p"],
		});
		expect(settingsManager.isResourceAllowedByProfile("skills", "skill-a")).toBe(false);
		expect(settingsManager.isResourceAllowedByProfile("skills", "skill-b")).toBe(true);
		expect(settingsManager.isResourceAllowedByProfile("skills", "skill-c")).toBe(true);
	});

	it("an unchanged wildcard grant still saves as { allow: ['*'] } (grant-all preserved)", () => {
		let saved: { skills?: { allow?: string[]; block?: string[] } } | undefined;
		const editor = new ProfileResourceEditorComponent({
			profileName: "p",
			profileScope: "session",
			initialResources: { skills: { allow: ["*"] } },
			kinds,
			onSave: (resources) => {
				saved = resources;
			},
			onCancel: () => {},
		});

		(editor as unknown as { persistChanges(): void }).persistChanges();
		expect(saved?.skills).toEqual({ allow: ["*"] });
	});
});

/**
 * BUG H (block-framing all-enabled branch must consult the same grant-all gate as allow-framing)
 * and BUG I (the "*" framing marker must never enter the working set as a resource id) fixed
 * together: a wildcard grant round-trips unchanged, a wildcard grant with one item unchecked
 * collapses to the enumerated remainder, and a kind the profile never mentions (block framing by
 * default) never gets widened to a wildcard just because every discovered item is enabled.
 */
describe("combined round-trip: BUG H + BUG I together", () => {
	const kinds = [
		{
			kind: "skills" as const,
			label: "Skills",
			items: [
				{ id: "skill-a", path: "/catalog/skill-a" },
				{ id: "skill-b", path: "/catalog/skill-b" },
				{ id: "skill-c", path: "/catalog/skill-c" },
			],
		},
	];

	const persist = (editor: ProfileResourceEditorComponent) =>
		(editor as unknown as { persistChanges(): void }).persistChanges();
	const enabledOf = (editor: ProfileResourceEditorComponent) =>
		(editor as unknown as { enabledByKind: Map<string, Set<string>> }).enabledByKind.get("skills")!;

	it("unchanged wildcard profile -> stays { allow: ['*'] }", () => {
		let saved: { skills?: { allow?: string[]; block?: string[] } } | undefined;
		const editor = new ProfileResourceEditorComponent({
			profileName: "p",
			profileScope: "session",
			initialResources: { skills: { allow: ["*"] } },
			kinds,
			onSave: (resources) => {
				saved = resources;
			},
			onCancel: () => {},
		});

		persist(editor);
		expect(saved?.skills).toEqual({ allow: ["*"] });
	});

	it("wildcard profile with one item unchecked -> enumerated remainder", () => {
		let saved: { skills?: { allow?: string[]; block?: string[] } } | undefined;
		const editor = new ProfileResourceEditorComponent({
			profileName: "p",
			profileScope: "session",
			initialResources: { skills: { allow: ["*"] } },
			kinds,
			onSave: (resources) => {
				saved = resources;
			},
			onCancel: () => {},
		});

		enabledOf(editor).delete("skill-a");
		persist(editor);
		expect(saved?.skills).toEqual({ allow: ["skill-b", "skill-c"] });
	});

	it("omitted kind, all discovered items enabled -> enumerated grant, never a wildcard", () => {
		let saved: { skills?: { allow?: string[]; block?: string[] } } | undefined;
		const editor = new ProfileResourceEditorComponent({
			profileName: "p",
			profileScope: "session",
			initialResources: {}, // kind never mentioned -> strict UAC: denied, block framing by default
			kinds,
			onSave: (resources) => {
				saved = resources;
			},
			onCancel: () => {},
		});

		const enabledSet = enabledOf(editor);
		expect(enabledSet.size).toBe(0); // starts fully denied, not fully enabled

		for (const item of kinds[0]!.items) {
			enabledSet.add(item.id);
		}
		persist(editor);
		expect(saved?.skills).toEqual({ allow: ["skill-a", "skill-b", "skill-c"] });
	});
});
