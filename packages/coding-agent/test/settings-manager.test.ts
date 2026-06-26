import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS } from "../src/core/http-dispatcher.ts";
import { getDirectoryResourceProfileInfo, SettingsManager } from "../src/core/settings-manager.ts";
import { validateSkillName } from "../src/core/skills.ts";

describe("SettingsManager", () => {
	const testDir = join(process.cwd(), "test-settings-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		// Clean up and create fresh directories
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	describe("preserves externally added settings", () => {
		it("should preserve enabledModels when changing thinking level", async () => {
			// Create initial settings file
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
					defaultModel: "claude-sonnet",
				}),
			);

			// Create SettingsManager (simulates pi starting up)
			const manager = SettingsManager.create(projectDir, agentDir);

			// Simulate user editing settings.json externally to add enabledModels
			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.enabledModels = ["claude-opus-4-5", "gpt-5.2-codex"];
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			// User changes thinking level via Shift+Tab
			manager.setDefaultThinkingLevel("high");
			await manager.flush();

			// Verify enabledModels is preserved
			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.enabledModels).toEqual(["claude-opus-4-5", "gpt-5.2-codex"]);
			expect(savedSettings.defaultThinkingLevel).toBe("high");
			expect(savedSettings.theme).toBe("dark");
			expect(savedSettings.defaultModel).toBe("claude-sonnet");
		});

		it("should preserve custom settings when changing theme", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					defaultModel: "claude-sonnet",
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			// User adds custom settings externally
			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.shellPath = "/bin/zsh";
			currentSettings.extensions = ["/path/to/extension.ts"];
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			// User changes theme
			manager.setTheme("light");
			await manager.flush();

			// Verify all settings preserved
			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.shellPath).toBe("/bin/zsh");
			expect(savedSettings.extensions).toEqual(["/path/to/extension.ts"]);
			expect(savedSettings.theme).toBe("light");
		});

		it("should let in-memory changes override file changes for same key", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			// User externally sets thinking level to "low"
			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.defaultThinkingLevel = "low";
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			// But then changes it via UI to "high"
			manager.setDefaultThinkingLevel("high");
			await manager.flush();

			// In-memory change should win
			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.defaultThinkingLevel).toBe("high");
		});
	});

	describe("packages migration", () => {
		it("should keep local-only extensions in extensions array", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					extensions: ["/local/ext.ts", "./relative/ext.ts"],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getPackages()).toEqual([]);
			expect(manager.getExtensionPaths()).toEqual(["/local/ext.ts", "./relative/ext.ts"]);
		});

		it("should handle packages with filtering objects", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					packages: [
						"npm:simple-pkg",
						{
							source: "npm:shitty-extensions",
							extensions: ["extensions/oracle.ts"],
							skills: [],
						},
					],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			const packages = manager.getPackages();
			expect(packages).toHaveLength(2);
			expect(packages[0]).toBe("npm:simple-pkg");
			expect(packages[1]).toEqual({
				source: "npm:shitty-extensions",
				extensions: ["extensions/oracle.ts"],
				skills: [],
			});
		});
	});

	describe("reload", () => {
		it("should reload global settings from disk", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
					extensions: ["/before.ts"],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "light",
					extensions: ["/after.ts"],
					defaultModel: "claude-sonnet",
				}),
			);

			await manager.reload();

			expect(manager.getTheme()).toBe("light");
			expect(manager.getExtensionPaths()).toEqual(["/after.ts"]);
			expect(manager.getDefaultModel()).toBe("claude-sonnet");
		});

		it("should keep previous settings when file is invalid", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			writeFileSync(settingsPath, "{ invalid json");
			await manager.reload();

			expect(manager.getTheme()).toBe("dark");
		});
	});

	describe("error tracking", () => {
		it("should collect and clear load errors via drainErrors", () => {
			const globalSettingsPath = join(agentDir, "settings.json");
			const projectSettingsPath = join(projectDir, ".pi", "settings.json");
			writeFileSync(globalSettingsPath, "{ invalid global json");
			writeFileSync(projectSettingsPath, "{ invalid project json");

			const manager = SettingsManager.create(projectDir, agentDir);
			const errors = manager.drainErrors();

			expect(errors).toHaveLength(2);
			expect(errors.map((e) => e.scope).sort()).toEqual(["global", "project"]);
			expect(manager.drainErrors()).toEqual([]);
		});
	});

	describe("autonomy settings", () => {
		it("should default to off and persist full mode", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getAutonomySettings()).toEqual({ mode: "off" });

			manager.setAutonomySettings({ mode: "full" });
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			expect(savedSettings.autonomy).toEqual({ mode: "full" });
		});
	});

	describe("auto learn settings", () => {
		it("should persist reflection review settings", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);

			manager.setAutoLearnSettings({
				enabled: true,
				model: "openai/gpt-5.5",
				thinkingLevel: "high",
				reflectionReview: true,
				reflectionMinToolCalls: 8,
				reflectionCooldownMinutes: 30,
			});
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			expect(savedSettings.autoLearn).toMatchObject({
				enabled: true,
				model: "openai/gpt-5.5",
				thinkingLevel: "high",
				reflectionReview: true,
				reflectionMinToolCalls: 8,
				reflectionCooldownMinutes: 30,
			});
		});
	});

	describe("project settings directory creation", () => {
		it("should not create .pi folder when only reading project settings", () => {
			// Create agent dir with global settings, but NO .pi folder in project
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			// Delete the .pi folder that beforeEach created
			rmSync(join(projectDir, ".pi"), { recursive: true });

			// Create SettingsManager (reads both global and project settings)
			const manager = SettingsManager.create(projectDir, agentDir);

			// .pi folder should NOT have been created just from reading
			expect(existsSync(join(projectDir, ".pi"))).toBe(false);

			// Settings should still be loaded from global
			expect(manager.getTheme()).toBe("dark");
		});

		it("should create .pi folder when writing project settings", async () => {
			// Create agent dir with global settings, but NO .pi folder in project
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			// Delete the .pi folder that beforeEach created
			rmSync(join(projectDir, ".pi"), { recursive: true });

			const manager = SettingsManager.create(projectDir, agentDir);

			// .pi folder should NOT exist yet
			expect(existsSync(join(projectDir, ".pi"))).toBe(false);

			// Write a project-specific setting
			manager.setProjectPackages([{ source: "npm:test-pkg" }]);
			await manager.flush();

			// Now .pi folder should exist
			expect(existsSync(join(projectDir, ".pi"))).toBe(true);

			// And settings file should be created
			expect(existsSync(join(projectDir, ".pi", "settings.json"))).toBe(true);
		});
	});

	describe("autoLearn", () => {
		it("should merge global and project autoLearn settings", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ autoLearn: { enabled: true, model: "active", longSessionMessages: 40 } }),
			);
			writeFileSync(
				join(projectDir, ".pi", "settings.json"),
				JSON.stringify({ autoLearn: { model: "openai/gpt-5.4", cooldownMinutes: 30 } }),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getAutoLearnSettings()).toEqual({
				enabled: true,
				model: "openai/gpt-5.4",
				thinkingLevel: "low",
				longSessionMessages: 40,
				cooldownMinutes: 30,
				complexTaskToolCalls: 12,
			});
		});

		it("should save global autoLearn settings", async () => {
			const settingsPath = join(agentDir, "settings.json");
			const manager = SettingsManager.create(projectDir, agentDir);

			manager.setAutoLearnSettings({ enabled: true, model: "active", maxConcurrentLearners: 3 });
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.autoLearn).toEqual({
				enabled: true,
				model: "active",
				maxConcurrentLearners: 3,
			});
		});

		it("should save project scoped autoLearn settings", async () => {
			const settingsPath = join(projectDir, ".pi", "settings.json");
			const manager = SettingsManager.create(projectDir, agentDir);

			manager.setAutoLearnSettings({ enabled: true, model: "openai/gpt-5.4" }, "project");
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.autoLearn).toEqual({
				enabled: true,
				model: "openai/gpt-5.4",
			});
		});
	});

	describe("selfModification", () => {
		it("should save project scoped selfModification settings", async () => {
			const settingsPath = join(projectDir, ".pi", "settings.json");
			const sourcePath = join(testDir, "src", "pi-adaptative");
			const manager = SettingsManager.create(projectDir, agentDir);

			manager.setSelfModificationSettings({ enabled: true, sourcePath }, "project");
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.selfModification).toEqual({
				enabled: true,
				sourcePath,
			});
		});

		it("should preserve sourcePaths when saving single sourcePath settings", async () => {
			const settingsPath = join(agentDir, "settings.json");
			const oldSourcePath = join(testDir, "src", "old");
			const nextSourcePath = join(testDir, "src", "pi-adaptative");
			const sourcePaths = [join(testDir, "src", "one"), join(testDir, "src", "two")];
			writeFileSync(
				settingsPath,
				JSON.stringify({
					selfModification: {
						enabled: true,
						sourcePath: oldSourcePath,
						sourcePaths,
					},
				}),
			);
			const manager = SettingsManager.create(projectDir, agentDir);

			manager.setSelfModificationSettings({ enabled: false, sourcePath: nextSourcePath });
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.selfModification).toEqual({
				enabled: false,
				sourcePath: nextSourcePath,
				sourcePaths,
			});
		});
	});

	describe("httpIdleTimeoutMs", () => {
		it("should default to 5 minutes", () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getHttpIdleTimeoutMs()).toBe(DEFAULT_HTTP_IDLE_TIMEOUT_MS);
		});

		it("should use merged global and project settings", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ httpIdleTimeoutMs: 300000 }));
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ httpIdleTimeoutMs: 0 }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getHttpIdleTimeoutMs()).toBe(0);
		});

		it("should reject invalid timeout values", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ httpIdleTimeoutMs: -1 }));
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(() => manager.getHttpIdleTimeoutMs()).toThrow("Invalid httpIdleTimeoutMs setting");
		});
	});

	describe("shellCommandPrefix", () => {
		it("should load shellCommandPrefix from settings", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ shellCommandPrefix: "shopt -s expand_aliases" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getShellCommandPrefix()).toBe("shopt -s expand_aliases");
		});

		it("should return undefined when shellCommandPrefix is not set", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getShellCommandPrefix()).toBeUndefined();
		});

		it("should preserve shellCommandPrefix when saving unrelated settings", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ shellCommandPrefix: "shopt -s expand_aliases" }));

			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setTheme("light");
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.shellCommandPrefix).toBe("shopt -s expand_aliases");
			expect(savedSettings.theme).toBe("light");
		});
	});

	describe("project trust", () => {
		it("ignores project settings and refuses project writes when untrusted", async () => {
			const projectSettingsPath = join(projectDir, ".pi", "settings.json");
			writeFileSync(projectSettingsPath, JSON.stringify({ packages: ["npm:project-package"], theme: "light" }));

			const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });

			expect(manager.isProjectTrusted()).toBe(false);
			expect(manager.getProjectSettings()).toEqual({});
			expect(manager.getPackages()).toEqual([]);
			expect(() => manager.setProjectPackages(["npm:another-package"])).toThrow(/Project is not trusted/);
			await expect(manager.flush()).resolves.toBeUndefined();
			expect(JSON.parse(readFileSync(projectSettingsPath, "utf-8"))).toEqual({
				packages: ["npm:project-package"],
				theme: "light",
			});
		});

		it("loads project settings after trust is enabled", () => {
			const projectSettingsPath = join(projectDir, ".pi", "settings.json");
			writeFileSync(projectSettingsPath, JSON.stringify({ packages: ["npm:project-package"] }));
			const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });

			manager.setProjectTrusted(true);

			expect(manager.isProjectTrusted()).toBe(true);
			expect(manager.getPackages()).toEqual(["npm:project-package"]);
		});
	});

	describe("getSessionDir", () => {
		it("should return undefined when not set", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBeUndefined();
		});

		it("should return global sessionDir", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "/tmp/sessions" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe("/tmp/sessions");
		});

		it("should return project sessionDir, overriding global", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "/global/sessions" }));
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ sessionDir: "./sessions" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe("./sessions");
		});

		it("should expand ~ in sessionDir", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "~/sessions" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe(join(homedir(), "sessions"));
		});
	});

	describe("resource profiles", () => {
		it("loads zero-footprint directory resource profile settings from the user agent dir", () => {
			const info = getDirectoryResourceProfileInfo(projectDir, agentDir);
			mkdirSync(join(agentDir, "resource-profiles", info.hash), { recursive: true });
			writeFileSync(
				info.path,
				JSON.stringify({
					activeResourceProfile: "lean",
					resourceProfiles: {
						lean: {
							extensions: { block: ["noisy-ext"] },
							tools: { allow: ["read", "rg"] },
						},
					},
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getDirectoryResourceProfileInfo()?.path).toBe(info.path);
			expect(manager.getResourceProfileFilter("extensions").block).toEqual(["noisy-ext"]);
			expect(manager.getResourceProfileFilter("tools").allow).toEqual(["read", "rg"]);
		});

		it("combines legacy disabledResources with active resource profile filters", () => {
			const manager = SettingsManager.inMemory({
				disabledResources: { skills: ["legacy-skill"] },
				activeResourceProfile: "project",
				resourceProfiles: {
					project: { skills: { allow: ["active-skill"], block: ["blocked-skill"] } },
				},
			});

			expect(manager.getResourceProfileFilter("skills")).toEqual({
				allow: ["active-skill"],
				block: ["legacy-skill", "blocked-skill"],
			});
		});

		it("lets runtime resource profiles override active profile selection", () => {
			const manager = SettingsManager.inMemory({
				activeResourceProfile: "default",
				resourceProfiles: {
					default: { tools: { block: ["bash"] } },
					worker: { tools: { allow: ["read", "rg"] } },
				},
			});

			manager.setRuntimeResourceProfiles(["worker"]);

			expect(manager.getResourceProfileFilter("tools")).toEqual({
				allow: ["read", "rg"],
				block: [],
			});
		});

		it("merges one-shot inline resource profile definitions without writing settings", () => {
			const manager = SettingsManager.inMemory({ activeResourceProfile: "one-shot" });

			manager.addInlineResourceProfileDefinitions({
				"one-shot": { tools: { allow: ["read"], block: ["bash"] } },
			});

			expect(manager.getResourceProfileFilter("tools")).toEqual({
				allow: ["read"],
				block: ["bash"],
			});
		});

		it("blocks broad skills and restricts tools for router-managed profile", () => {
			const manager = SettingsManager.inMemory({
				activeResourceProfiles: ["router-managed"],
				resourceProfiles: {
					"router-managed": {
						skills: { block: ["*"] },
						agents: { block: ["*"] },
						prompts: { block: ["*"] },
						tools: {
							allow: [
								"read",
								"bash",
								"skill_search",
								"skill_open",
								"skill_router_profile_status",
								"skill_router_profile_switch",
							],
						},
					},
				},
			});

			expect(manager.isResourceAllowedByProfile("skills", "/tmp/some/SKILL.md")).toBe(false);
			expect(manager.isResourceAllowedByProfile("agents", "some-agent")).toBe(false);
			expect(manager.isResourceAllowedByProfile("prompts", "some-prompt")).toBe(false);
			expect(manager.isResourceAllowedByProfile("tools", "read")).toBe(true);
			expect(manager.isResourceAllowedByProfile("tools", "skill_search")).toBe(true);
			expect(manager.isResourceAllowedByProfile("tools", "automata_graph_pointer_pack")).toBe(false);
			expect(manager.isResourceAllowedByProfile("tools", "skill_router_profile_status")).toBe(true);
			expect(manager.isResourceAllowedByProfile("tools", "skill_router_profile_switch")).toBe(true);
			expect(manager.isResourceAllowedByProfile("tools", "write")).toBe(false);
		});

		it("merges router-managed task profiles deterministically", () => {
			const manager = SettingsManager.inMemory({
				activeResourceProfiles: ["router-managed", "router-managed-harness"],
				resourceProfiles: {
					"router-managed": {
						skills: { block: ["*"] },
						tools: { allow: ["read", "bash", "skill_search", "skill_open"] },
					},
					"router-managed-harness": {
						skills: { block: ["*"] },
						tools: {
							allow: [
								"read",
								"bash",
								"adaptative_agent_status",
								"automata_graph_pointer_pack",
								"learning_run_auto",
								"learning_query_memory",
								"task_steps",
								"task_background",
								"task_goal",
								"run_ledger",
							],
						},
					},
				},
			});

			expect(manager.getResourceProfileFilter("skills")).toEqual({ allow: [], block: ["*"] });
			expect(manager.getResourceProfileFilter("tools")).toEqual({
				allow: [
					"read",
					"bash",
					"skill_search",
					"skill_open",
					"adaptative_agent_status",
					"automata_graph_pointer_pack",
					"learning_run_auto",
					"learning_query_memory",
					"task_steps",
					"task_background",
					"task_goal",
					"run_ledger",
				],
				block: [],
			});
			expect(manager.isResourceAllowedByProfile("tools", "adaptative_agent_status")).toBe(true);
			expect(manager.isResourceAllowedByProfile("tools", "task_steps")).toBe(true);
			expect(manager.isResourceAllowedByProfile("tools", "run_ledger")).toBe(true);
			expect(manager.isResourceAllowedByProfile("tools", "write")).toBe(false);
			expect(manager.isResourceAllowedByProfile("tools", "learning_status")).toBe(false);
		});

		it("loads reusable profile files from the user profiles directory", () => {
			mkdirSync(join(agentDir, "profiles"), { recursive: true });
			writeFileSync(
				join(agentDir, "profiles", "reviewer.json"),
				JSON.stringify({
					name: "reviewer",
					description: "Review safely",
					model: "anthropic/claude-sonnet-4",
					thinking: "low",
					resources: {
						tools: { allow: ["read", "grep"] },
					},
				}),
			);
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ activeResourceProfile: "reviewer" }));

			const manager = SettingsManager.create(projectDir, agentDir);
			const profile = manager.getProfileRegistry().getProfile("reviewer");

			expect(profile?.source).toBe("profile-file");
			expect(profile?.description).toBe("Review safely");
			expect(profile?.model).toBe("anthropic/claude-sonnet-4");
			expect(profile?.thinking).toBe("low");
			expect(manager.getResourceProfileFilter("tools")).toEqual({ allow: ["read", "grep"], block: [] });
		});

		it("shadows same-name profiles by precedence instead of unioning filters", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					activeResourceProfile: "reviewer",
					resourceProfiles: {
						reviewer: { tools: { allow: ["read"], block: ["bash"] } },
					},
				}),
			);
			writeFileSync(
				join(projectDir, ".pi", "settings.json"),
				JSON.stringify({
					resourceProfiles: {
						reviewer: { tools: { allow: ["grep"] } },
					},
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getProfileRegistry().getProfile("reviewer")?.source).toBe("project-settings");
			expect(manager.getResourceProfileFilter("tools")).toEqual({ allow: ["grep"], block: [] });
		});

		it("merges filters across distinct active profile names", () => {
			const manager = SettingsManager.inMemory({
				activeResourceProfiles: ["reviewer", "core-setup"],
				resourceProfiles: {
					reviewer: { tools: { allow: ["read"], block: ["bash"] } },
					"core-setup": { tools: { allow: ["grep"], block: ["write"] } },
				},
			});

			expect(manager.getResourceProfileFilter("tools")).toEqual({
				allow: ["read", "grep"],
				block: ["bash", "write"],
			});
		});

		it("resolves relative resource patterns in reusable profile files against the profile directory", () => {
			const profilesDir = join(agentDir, "profiles");
			mkdirSync(join(profilesDir, "skills"), { recursive: true });
			writeFileSync(
				join(profilesDir, "relative.json"),
				JSON.stringify({
					name: "relative",
					resources: {
						skills: { allow: ["./skills/review"] },
					},
				}),
			);
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ activeResourceProfile: "relative" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getResourceProfileFilter("skills")).toEqual({
				allow: [join(profilesDir, "skills", "review")],
				block: [],
			});
		});

		it("resolves profile refs for relative file paths", () => {
			const profilesDir = join(agentDir, "profiles");
			mkdirSync(join(profilesDir, "nested"), { recursive: true });
			writeFileSync(
				join(profilesDir, "nested", "reviewer.json"),
				JSON.stringify({
					name: "nested-reviewer",
					resources: {
						skills: { allow: ["read"] },
					},
				}),
			);
			const manager = SettingsManager.create(projectDir, agentDir);
			const registry = manager.getProfileRegistry();

			expect(registry.resolveProfileRef("./nested/reviewer.json", profilesDir)?.name).toBe("nested-reviewer");
			expect(registry.resolveProfileRef("../profiles/nested/reviewer.json", join(agentDir, "subdir"))?.name).toBe(
				"nested-reviewer",
			);
		});

		it("reports malformed profile files as settings errors", () => {
			const profilesDir = join(agentDir, "profiles");
			mkdirSync(profilesDir, { recursive: true });
			writeFileSync(join(profilesDir, "bad.json"), '{"name": "bad--name", "resources": "oops"}');

			const manager = SettingsManager.create(projectDir, agentDir);
			const errors = manager.drainErrors();
			expect(errors.some((entry) => /Profile diagnostic/.test(entry.error.message))).toBe(true);
		});

		it("refreshes profile diagnostics after profile files are fixed", async () => {
			const profilesDir = join(agentDir, "profiles");
			mkdirSync(profilesDir, { recursive: true });
			const profilePath = join(profilesDir, "bad.json");
			writeFileSync(profilePath, '{"name": "bad--name", "resources": "oops"}');

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.drainErrors().some((entry) => /Profile diagnostic/.test(entry.error.message))).toBe(true);

			writeFileSync(profilePath, JSON.stringify({ name: "bad", resources: { tools: { allow: ["read"] } } }));
			await manager.reload();

			expect(manager.drainErrors().some((entry) => /Profile diagnostic/.test(entry.error.message))).toBe(false);
		});

		it("reports active profile names that do not resolve", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ activeResourceProfile: "ghost" }));

			const manager = SettingsManager.create(projectDir, agentDir);
			const errors = manager.drainErrors();
			expect(errors.some((entry) => /Active profile not found: ghost/.test(entry.error.message))).toBe(true);
		});

		it("persists and renames reusable profile definitions", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setProfileDefinition(
				"reviewer",
				{
					description: "Review safely",
					resources: {
						tools: {
							allow: ["read"],
						},
					},
				},
				"reusable-file",
			);
			await manager.flush();
			const profilesPath = join(agentDir, "profiles");
			const original = JSON.parse(readFileSync(join(profilesPath, "reviewer.json"), "utf-8"));
			expect(original.name).toBe("reviewer");
			expect(original.description).toBe("Review safely");
			expect(original.resources).toEqual({ tools: { allow: ["read"] } });

			manager.renameProfile("reviewer", "reviewer-2", "reusable-file");
			await manager.flush();
			expect(existsSync(join(profilesPath, "reviewer.json"))).toBe(false);
			const renamed = JSON.parse(readFileSync(join(profilesPath, "reviewer-2.json"), "utf-8"));
			expect(renamed.name).toBe("reviewer-2");
			expect(renamed.resources).toEqual({ tools: { allow: ["read"] } });
		});

		it("allows a fresh settings manager to load newly created reusable-file profiles", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setProfileDefinition(
				"created-profile",
				{
					resources: {
						tools: {
							allow: ["read"],
						},
					},
				},
				"reusable-file",
			);
			await manager.flush();

			// Load fresh SettingsManager
			const freshManager = SettingsManager.create(projectDir, agentDir);
			const profile = freshManager.getProfileRegistry().getProfile("created-profile");
			expect(profile).toBeDefined();
			expect(profile?.name).toBe("created-profile");
			expect(profile?.resources.tools?.allow).toEqual(["read"]);
			expect(profile?.source).toBe("profile-file");
		});

		it("validates profile names correctly using validateSkillName rules", () => {
			expect(validateSkillName("valid-profile-name").length).toBe(0);
			expect(validateSkillName("Bad Name!").length).toBeGreaterThan(0);
			expect(validateSkillName("profile_name").length).toBeGreaterThan(0);
		});

		it("deletes profile definitions from directory overlay", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setProfileDefinition(
				"reviewer",
				{
					resources: {
						skills: { allow: ["read"] },
						tools: { allow: ["write"] },
					},
				},
				"directory",
			);
			await manager.flush();
			expect(manager.getProfileRegistry().getProfile("reviewer")?.source).toBe("directory-overlay");

			manager.deleteProfile("reviewer", "directory");
			await manager.flush();

			expect(manager.getProfileRegistry().getProfile("reviewer")?.source).toBeUndefined();
			expect(manager.getActiveResourceProfileNames().includes("reviewer")).toBe(false);
		});

		it("persists the active profile selection to directory scope", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setActiveProfile("reviewer", "directory");
			await manager.flush();

			const freshManager = SettingsManager.create(projectDir, agentDir);
			expect(freshManager.getActiveResourceProfileNames()).toContain("reviewer");
		});

		it("persists the active profile selection to project scope", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setActiveProfile("reviewer", "project");
			await manager.flush();

			const freshManager = SettingsManager.create(projectDir, agentDir);
			expect(freshManager.getActiveResourceProfileNames()).toContain("reviewer");
		});

		it("persists the active profile selection to global scope", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setActiveProfile("reviewer", "global");
			await manager.flush();

			const freshManager = SettingsManager.create(projectDir, agentDir);
			expect(freshManager.getActiveResourceProfileNames()).toContain("reviewer");
		});

		it("clears the active profile selection when set to undefined", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setActiveProfile("reviewer", "directory");
			await manager.flush();

			manager.setActiveProfile(undefined, "directory");
			await manager.flush();

			const freshManager = SettingsManager.create(projectDir, agentDir);
			expect(freshManager.getActiveResourceProfileNames()).not.toContain("reviewer");
		});

		it("writes profile resources to a reusable profile file", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setProfileDefinition(
				"reviewer",
				{
					resources: {
						tools: { allow: ["read", "grep"] },
					},
				},
				"reusable-file",
			);
			manager.setActiveProfile("reviewer", "global");
			await manager.flush();

			const freshManager = SettingsManager.create(projectDir, agentDir);
			const profile = freshManager.getProfileRegistry().getProfile("reviewer");
			expect(profile?.resources.tools?.allow).toEqual(["read", "grep"]);
			expect(freshManager.getResourceProfileFilter("tools").allow).toContain("read");
			expect(freshManager.getResourceProfileFilter("tools").allow).toContain("grep");
		});

		describe("external resource roots settings", () => {
			it("round-trip: gets effective external roots matching trusted and existing", async () => {
				const manager = SettingsManager.create(projectDir, agentDir);
				const tempRoot1 = join(agentDir, "temp-root-1");
				const tempRoot2 = join(agentDir, "temp-root-2");
				mkdirSync(tempRoot1, { recursive: true });

				manager.setExternalResourceRoots([tempRoot1, tempRoot2], "global");
				manager.setTrustedResourceRoots([tempRoot1, tempRoot2], "global");
				await manager.flush();

				const freshManager = SettingsManager.create(projectDir, agentDir);
				const effective = freshManager.getEffectiveExternalResourceRoots();
				expect(effective).toContain(realpathSync(tempRoot1));
				expect(effective).not.toContain(tempRoot2);
			});

			it("skips untrusted roots", async () => {
				const manager = SettingsManager.create(projectDir, agentDir);
				const tempRoot1 = join(agentDir, "temp-root-1");
				mkdirSync(tempRoot1, { recursive: true });

				manager.setExternalResourceRoots([tempRoot1], "global");
				manager.setTrustedResourceRoots([], "global");
				await manager.flush();

				const freshManager = SettingsManager.create(projectDir, agentDir);
				expect(freshManager.getEffectiveExternalResourceRoots()).not.toContain(realpathSync(tempRoot1));
			});
		});
	});
});
