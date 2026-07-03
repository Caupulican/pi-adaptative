import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Extension } from "../src/core/extensions/index.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { createHarness } from "./test-harness.ts";

type ExtensionFilterSession = {
	_filterExtensionsForRuntime(extensions: Extension[]): Extension[];
	_inertExtensionWarnings: string[];
	_profileDeniedExtensionCount: number;
	_toolProfileFilter?: { allow: string[]; block: string[] };
	getContextCompositionReport(): { observations: string[] };
};

function makeExtension(path: string, opts: { source: string; tools?: string[]; commands?: string[] }): Extension {
	const tools = new Map<string, unknown>();
	for (const name of opts.tools ?? []) tools.set(name, {});
	const commands = new Map<string, unknown>();
	for (const name of opts.commands ?? []) commands.set(name, {});
	return {
		path,
		resolvedPath: path,
		sourceInfo: createSyntheticSourceInfo(path, { source: opts.source }),
		handlers: new Map(),
		tools,
		messageRenderers: new Map(),
		commands,
		flags: new Map(),
		shortcuts: new Map(),
		eventUnsubscribes: [],
		disposers: [],
	} as unknown as Extension;
}

describe("G13: dead tool grants are surfaced, never silent", () => {
	it("reports an explicit grant that binds to no registered tool", () => {
		const harness = createHarness();
		try {
			const session = harness.session as unknown as {
				settingsManager: SettingsManager;
				_toolProfileFilter: { allow: string[]; block: string[] };
				_refreshToolRegistry: () => void;
			};
			session._toolProfileFilter = { allow: ["read", "no_such_tool"], block: [] };
			session._refreshToolRegistry();
			const report = harness.session.getContextCompositionReport();
			expect(
				report.observations.some((line) => line.includes('tool grant "no_such_tool" binds to no registered tool')),
			).toBe(true);
			expect(report.observations.some((line) => line.includes('"read"'))).toBe(false);
		} finally {
			harness.cleanup();
		}
	});
});

describe("G14: user disable beats profile grant, surfaced", () => {
	it("reports profile-granted entries the user's disable list overrides", () => {
		const settingsManager = SettingsManager.inMemory({
			resourceProfiles: { scout: { skills: { allow: ["my-skill"] }, tools: { allow: ["read"] } } },
			activeResourceProfiles: ["scout"],
			disabledResources: { skills: ["my-skill"] },
		});
		expect(settingsManager.getProfileGrantsOverriddenByUserDisable("skills")).toEqual(["my-skill"]);
		expect(settingsManager.getProfileGrantsOverriddenByUserDisable("tools")).toEqual([]);
		// the merged filter proves the disable actually WINS
		expect(settingsManager.isResourceAllowedByProfile("skills", "my-skill")).toBe(false);
	});
});

describe("T5: runtime extension filter with no active profile keeps only inline/SDK extensions", () => {
	it("drops external extensions and keeps inline ones", () => {
		const harness = createHarness();
		try {
			const session = harness.session as unknown as ExtensionFilterSession;
			const kept = session._filterExtensionsForRuntime([
				makeExtension("/x/inline-ext.ts", { source: "inline" }),
				makeExtension("/x/external-ext.ts", { source: "external" }),
			]);
			expect(kept.map((extension) => extension.path)).toEqual(["/x/inline-ext.ts"]);
			// The inline-only baseline is not a profile denial, so nothing is reported as withheld.
			expect(session._profileDeniedExtensionCount).toBe(0);
		} finally {
			harness.cleanup();
		}
	});
});

describe("T3 (G12): a profile-allowed extension left uninvocable by the tools filter is surfaced as inert", () => {
	it("loads the extension but warns that all its tools/commands are denied", () => {
		const harness = createHarness({
			settings: {
				resourceProfiles: { p: { extensions: { allow: ["*"] }, tools: { allow: ["read"] } } },
				activeResourceProfiles: ["p"],
			},
		});
		try {
			const session = harness.session as unknown as ExtensionFilterSession;
			// The profile allows the extension itself, but its tools filter grants only "read".
			session._toolProfileFilter = { allow: ["read"], block: [] };
			const kept = session._filterExtensionsForRuntime([
				makeExtension("/x/my-ext.ts", { source: "external", tools: ["my-tool"], commands: ["my-cmd"] }),
			]);
			expect(kept).toHaveLength(1);
			expect(kept[0]!.tools.size + kept[0]!.commands.size).toBe(0);
			expect(
				session._inertExtensionWarnings.some(
					(warning) => warning.includes("fully inert") && warning.includes("my-ext"),
				),
			).toBe(true);
		} finally {
			harness.cleanup();
		}
	});
});

describe("Bug D: profile-denial observation must not misattribute user disables", () => {
	// `createHarness`'s `settings:` override merges into the computed `SettingsManager.settings`
	// snapshot only — the legacy `disabledResources` filter reads the global/project scope settings
	// directly (see `collectLegacyDisabledFilterFromSettings`), so a real `disabledResources` block
	// needs a SettingsManager seeded via `SettingsManager.inMemory` (which loads it as the "global"
	// scope), the same construction the existing G14 test uses.
	let tempDir: string;
	let agentDir: string;

	const writeSkill = (name: string) => {
		const dir = join(agentDir, "skills", name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: x\n---\nBody.\n`, "utf-8");
	};

	const newSession = async (settingsManager: SettingsManager) => {
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		await session.bindExtensions({});
		return session;
	};

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-profile-denial-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("no active profile + user-disabled skill: no profile-withheld observation", async () => {
		writeSkill("user-disabled-skill");
		const settingsManager = SettingsManager.inMemory({ disabledResources: { skills: ["user-disabled-skill"] } });
		const session = await newSession(settingsManager);

		const observations = session.getContextCompositionReport().observations;
		// The skill IS absent, but purely because the USER disabled it — no profile is even active,
		// so nothing here is attributable to "the active resource profile".
		expect(observations.some((line) => line.includes("skill(s) withheld by the active resource profile"))).toBe(
			false,
		);

		session.dispose();
	});

	it("active profile denies one skill, user disables a different (profile-allowed) skill: count reflects only the profile denial", async () => {
		writeSkill("profile-only-denied-skill");
		writeSkill("user-disabled-skill");

		const countWithheld = async (settingsManager: SettingsManager): Promise<number> => {
			const session = await newSession(settingsManager);
			const line = session
				.getContextCompositionReport()
				.observations.find((entry) => entry.includes("skill(s) withheld by the active resource profile"));
			session.dispose();
			return Number(line?.match(/^(\d+) skill/)?.[1] ?? 0);
		};

		// Baseline: the profile allows "user-disabled-skill" (only "profile-only-denied-skill" plus
		// whatever bundled skills the profile also excludes are profile-denied — the exact bundled
		// count doesn't matter here, only the DELTA the legacy disable adds below).
		const baseline = await countWithheld(
			SettingsManager.inMemory({
				resourceProfiles: { locked: { skills: { allow: ["user-disabled-skill"] } } },
				activeResourceProfiles: ["locked"],
			}),
		);

		// Now the user ALSO disables "user-disabled-skill" — a resource the PROFILE already allows.
		// That is the user's own doing (surfaced separately by the G14 disable-wins warning); it must
		// not inflate the profile-attributed count above the baseline.
		const withUserDisable = await countWithheld(
			SettingsManager.inMemory({
				resourceProfiles: { locked: { skills: { allow: ["user-disabled-skill"] } } },
				activeResourceProfiles: ["locked"],
				disabledResources: { skills: ["user-disabled-skill"] },
			}),
		);

		expect(withUserDisable).toBe(baseline);
	});
});

describe("extensions withheld by an active profile surface in /context", () => {
	it("counts profile-denied extensions and reports them", () => {
		const harness = createHarness({
			settings: {
				resourceProfiles: { locked: { tools: { allow: ["read"] } } },
				activeResourceProfiles: ["locked"],
			},
		});
		try {
			const session = harness.session as unknown as ExtensionFilterSession;
			// "locked" never grants the extensions kind -> strict deny-all for extensions.
			session._filterExtensionsForRuntime([makeExtension("/x/denied-ext.ts", { source: "external", tools: ["t"] })]);
			expect(session._profileDeniedExtensionCount).toBe(1);
			const observations = session.getContextCompositionReport().observations;
			expect(observations.some((line) => /extension\(s\) withheld by the active resource profile/.test(line))).toBe(
				true,
			);
		} finally {
			harness.cleanup();
		}
	});
});
