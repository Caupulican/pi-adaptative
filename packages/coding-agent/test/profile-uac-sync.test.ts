import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("profile UAC persistence and registry synchronization", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-profile-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	const fullDefinition = () => ({
		description: "Scoped orchestration",
		model: "openai-codex/gpt-5.6-terra",
		thinking: "max" as const,
		soul: "Use the scoped situation.",
		modelRouter: {
			enabled: true,
			judgeEnabled: false,
			cheapModel: "openai-codex/gpt-5.6-luna",
			cheapThinking: "low" as const,
		},
		resources: {
			tools: { allow: ["read", "delegate"] },
			skills: { allow: ["review-skill"] },
		},
	});

	it("round-trips full situation metadata through session, directory, project, and global scopes", async () => {
		const sessionManager = SettingsManager.inMemory();
		sessionManager.setProfileDefinition("session-situation", fullDefinition(), "session");
		sessionManager.setActiveProfile("session-situation", "session");
		expect(sessionManager.getProfileRegistry().getProfile("session-situation")).toMatchObject({
			model: "openai-codex/gpt-5.6-terra",
			thinking: "max",
			soul: "Use the scoped situation.",
			modelRouter: { enabled: true, judgeEnabled: false, cheapThinking: "low" },
		});
		expect(sessionManager.getActiveProfileSoul()).toBe("Use the scoped situation.");
		expect(sessionManager.getResourceProfileFilter("tools")).toEqual({
			allow: ["read", "delegate"],
			block: [],
		});
		expect(sessionManager.getModelRouterSettings()).toMatchObject({
			enabled: true,
			judgeEnabled: false,
			cheapThinking: "low",
		});

		for (const scope of ["directory", "project", "global"] as const) {
			const scopeRoot = join(tempDir, scope);
			const scopedAgentDir = join(scopeRoot, "agent");
			const scopedProjectDir = join(scopeRoot, "project");
			mkdirSync(scopedAgentDir, { recursive: true });
			mkdirSync(scopedProjectDir, { recursive: true });
			const profileName = `${scope}-situation`;
			const manager = SettingsManager.create(scopedProjectDir, scopedAgentDir);
			manager.setProfileDefinition(profileName, fullDefinition(), scope);
			manager.setActiveProfile(profileName, scope);
			await manager.flush();

			const fresh = SettingsManager.create(scopedProjectDir, scopedAgentDir);
			expect(fresh.getProfileRegistry().getProfile(profileName)).toMatchObject({
				model: "openai-codex/gpt-5.6-terra",
				thinking: "max",
				soul: "Use the scoped situation.",
				modelRouter: { enabled: true, judgeEnabled: false, cheapThinking: "low" },
			});
			expect(fresh.getActiveResourceProfileNames()).toEqual([profileName]);
			expect(fresh.getResourceProfileFilter("tools")).toEqual({
				allow: ["read", "delegate"],
				block: [],
			});
			expect(fresh.getModelRouterSettings()).toMatchObject({
				enabled: true,
				judgeEnabled: false,
				cheapModel: "openai-codex/gpt-5.6-luna",
				cheapThinking: "low",
			});
		}
	});

	it("round-trips the complete reusable situation and applies every router field immediately", () => {
		const settingsManager = SettingsManager.create(projectDir, agentDir);
		// Prime the active selection before the file exists. The subsequent profile write must refresh
		// the registry on demand rather than leaving model-router settings on this stale generation.
		settingsManager.setRuntimeResourceProfiles(["orchestrated"]);
		settingsManager.setProfileDefinition(
			"orchestrated",
			{
				description: "Full orchestration profile",
				model: "openai-codex/gpt-5.6-sol",
				thinking: "ultra",
				soul: "Coordinate the full harness.",
				modelRouter: {
					enabled: true,
					judgeEnabled: false,
					fitnessGate: true,
					cheapModel: "openai-codex/gpt-5.6-luna",
					mediumModel: "openai-codex/gpt-5.6-terra",
					expensiveModel: "openai-codex/gpt-5.6-sol",
					learningModel: "openai-codex/gpt-5.6-luna",
					judgeModel: "openai-codex/gpt-5.6-terra",
					executorModel: "openai-codex/gpt-5.6-luna",
					cheapThinking: "low",
					mediumThinking: "high",
					expensiveThinking: "ultra",
					executorThinking: "minimal",
					judgeThinking: "max",
				},
				resources: {
					extensions: { allow: ["review-extension"] },
					skills: { allow: ["review-skill"] },
					prompts: { allow: ["review-prompt"] },
					agents: { allow: ["AGENTS.md"] },
					tools: { allow: ["read", "delegate"] },
				},
			},
			"reusable-file",
		);

		const router = settingsManager.getModelRouterSettings();
		expect(router).toMatchObject({
			enabled: true,
			judgeEnabled: false,
			fitnessGate: true,
			cheapModel: "openai-codex/gpt-5.6-luna",
			mediumModel: "openai-codex/gpt-5.6-terra",
			expensiveModel: "openai-codex/gpt-5.6-sol",
			learningModel: "openai-codex/gpt-5.6-luna",
			judgeModel: "openai-codex/gpt-5.6-terra",
			executorModel: "openai-codex/gpt-5.6-luna",
			cheapThinking: "low",
			mediumThinking: "high",
			expensiveThinking: "ultra",
			executorThinking: "minimal",
			judgeThinking: "max",
		});
		expect(settingsManager.getActiveProfileSoul()).toBe("Coordinate the full harness.");
		expect(settingsManager.getResourceProfileFilter("tools")).toEqual({
			allow: ["read", "delegate"],
			block: [],
		});

		const saved = JSON.parse(readFileSync(join(agentDir, "profiles", "orchestrated.json"), "utf-8"));
		expect(saved.soul).toBe("Coordinate the full harness.");
		expect(saved.modelRouter.judgeThinking).toBe("max");
	});

	it("updates a basename-named reusable profile without dropping its metadata", () => {
		mkdirSync(join(agentDir, "profiles"), { recursive: true });
		writeFileSync(
			join(agentDir, "profiles", "nameless.json"),
			JSON.stringify({ soul: "Preserve me.", thinking: "high", resources: { tools: { allow: ["read"] } } }),
			"utf-8",
		);
		const settingsManager = SettingsManager.create(projectDir, agentDir);

		settingsManager.setProfileDefinition(
			"nameless",
			{ resources: { tools: { allow: ["read", "delegate"] } } },
			"reusable-file",
		);

		const saved = JSON.parse(readFileSync(join(agentDir, "profiles", "nameless.json"), "utf-8"));
		expect(saved).toMatchObject({
			name: "nameless",
			soul: "Preserve me.",
			thinking: "high",
			resources: { tools: { allow: ["read", "delegate"] } },
		});
	});

	it("lets an explicit empty runtime selection disable a persisted profile", () => {
		const settingsManager = SettingsManager.inMemory({
			activeResourceProfiles: ["locked"],
			resourceProfiles: {
				locked: { tools: { allow: ["read"] } },
			},
		});

		settingsManager.setRuntimeResourceProfiles([]);

		expect(settingsManager.getActiveResourceProfileNames()).toEqual([]);
		expect(settingsManager.hasExplicitActiveResourceProfileSelection()).toBe(false);
		expect(settingsManager.getResourceProfileFilter("tools")).toEqual({ allow: [], block: [] });
	});

	it("keeps persisted and runtime selections synchronized across reusable rename and delete", async () => {
		const settingsManager = SettingsManager.create(projectDir, agentDir);
		settingsManager.setProfileDefinition("before", { resources: { tools: { allow: ["read"] } } }, "reusable-file");
		settingsManager.setActiveProfile("before", "global");
		settingsManager.setRuntimeResourceProfiles(["before"]);

		settingsManager.renameProfile("before", "after", "reusable-file");
		await settingsManager.flush();

		expect(settingsManager.getActiveResourceProfileNames()).toEqual(["after"]);
		expect(settingsManager.getGlobalSettings().activeResourceProfiles).toEqual(["after"]);
		expect(settingsManager.getProfileRegistry().getProfile("after")).toBeDefined();
		expect(settingsManager.getProfileRegistry().getProfile("before")).toBeUndefined();
		expect(
			settingsManager.drainErrors().some((entry) => entry.error.message.includes("Active profile not found")),
		).toBe(false);

		settingsManager.deleteProfile("after", "reusable-file");
		await settingsManager.flush();

		expect(settingsManager.getActiveResourceProfileNames()).toEqual([]);
		expect(settingsManager.getGlobalSettings().activeResourceProfiles).toBeUndefined();
		expect(settingsManager.getProfileRegistry().getProfile("after")).toBeUndefined();
	});

	it("applies a relative profile reference consistently to resources, soul, and router settings", () => {
		mkdirSync(join(projectDir, "profiles"), { recursive: true });
		writeFileSync(
			join(projectDir, "profiles", "review.json"),
			JSON.stringify({
				name: "relative-review",
				soul: "Review without editing.",
				modelRouter: { enabled: true, cheapModel: "openai-codex/gpt-5.6-luna", cheapThinking: "low" },
				resources: {
					tools: { allow: ["read", "grep"] },
					extensions: { block: ["*"] },
				},
			}),
			"utf-8",
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ activeResourceProfile: "./profiles/review.json" }),
			"utf-8",
		);

		const settingsManager = SettingsManager.create(projectDir, agentDir);

		expect(settingsManager.getResourceProfileFilter("tools")).toEqual({
			allow: ["read", "grep"],
			block: [],
		});
		expect(settingsManager.getResourceProfileFilter("extensions")).toEqual({ allow: [], block: ["*"] });
		expect(settingsManager.getActiveProfileSoul()).toBe("Review without editing.");
		expect(settingsManager.getModelRouterSettings()).toMatchObject({
			enabled: true,
			cheapModel: "openai-codex/gpt-5.6-luna",
			cheapThinking: "low",
		});
		expect(
			settingsManager.drainErrors().some((entry) => entry.error.message.includes("Active profile not found")),
		).toBe(false);
	});
});
