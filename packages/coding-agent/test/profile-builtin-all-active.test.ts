import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { getModel } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_ACTIVE_PROFILE_NAME, ProfileRegistry } from "../src/core/profile-registry.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import type { ResourceProfileKind } from "../src/core/settings-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const RESOURCE_KINDS: ResourceProfileKind[] = ["extensions", "skills", "prompts", "themes", "agents", "tools"];

function emptyRegistry(): ProfileRegistry {
	return new ProfileRegistry({
		globalSettings: {},
		projectSettings: {},
		directoryProfileSettings: {},
		inlineResourceProfileDefinitions: {},
		discoveredResourceProfileDefinitions: {},
	});
}

describe("built-in all-active profile", () => {
	it("is always present with every resource kind wide open and no model/thinking/soul", () => {
		const registry = emptyRegistry();
		const profile = registry.listProfiles().find((candidate) => candidate.name === ALL_ACTIVE_PROFILE_NAME);
		expect(profile).toBeDefined();
		expect(profile?.source).toBe("embedded");
		for (const kind of RESOURCE_KINDS) {
			expect(profile?.resources[kind]).toEqual({ allow: ["*"] });
		}
		expect(profile?.model).toBeUndefined();
		expect(profile?.thinking).toBeUndefined();
		expect(profile?.soul).toBeUndefined();
		expect(profile?.modelRouter).toBeUndefined();
	});

	it("getProfile resolves the built-in by name", () => {
		const registry = emptyRegistry();
		const profile = registry.getProfile(ALL_ACTIVE_PROFILE_NAME);
		expect(profile).toBeDefined();
		expect(profile?.source).toBe("embedded");
	});

	it("a user-defined all-active profile in global settings wins over the built-in", () => {
		const settingsManager = SettingsManager.inMemory({
			resourceProfiles: {
				[ALL_ACTIVE_PROFILE_NAME]: {
					description: "user override",
					resources: { tools: { allow: ["custom-tool"] } },
				},
			},
		});
		const profile = settingsManager.getProfileRegistry().getProfile(ALL_ACTIVE_PROFILE_NAME);
		expect(profile).toBeDefined();
		expect(profile?.source).toBe("global-settings");
		expect(profile?.description).toBe("user override");
		expect(profile?.resources.tools).toEqual({ allow: ["custom-tool"], block: undefined });
		// the built-in's blanket grant for other kinds must not leak through the override
		expect(profile?.resources.extensions).toBeUndefined();
	});
});

describe("built-in all-active profile activation", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-profile-all-active-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	async function sessionActiveTools(runtimeProfiles?: string[]) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		if (runtimeProfiles) settingsManager.setRuntimeResourceProfiles(runtimeProfiles);
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
		const names = session.getActiveToolNames().sort();
		session.dispose();
		return names;
	}

	it("imposes no restriction: a strict superset of the no-active-profile baseline", async () => {
		// No active profile still excludes externally-sourced extensions (see T5 in
		// profile-diagnostics.test.ts), so the built-in profile must unlock strictly more, never less.
		const baseline = await sessionActiveTools();
		const withAllActive = await sessionActiveTools([ALL_ACTIVE_PROFILE_NAME]);
		expect(withAllActive).toEqual(expect.arrayContaining(baseline));
		expect(withAllActive.length).toBeGreaterThan(baseline.length);
	});
});
