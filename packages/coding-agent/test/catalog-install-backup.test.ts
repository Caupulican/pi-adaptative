import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

let mockSelectorChoice: string | null = null;

// Mock SelectSubmenu in the local components file where it is imported from
vi.mock("../src/modes/interactive/components/settings-selector.ts", () => {
	return {
		SelectSubmenu: class MockSelectSubmenu {
			getSelectList() {
				return {};
			}
			constructor(
				_title: string,
				_description: string,
				_options: any[],
				_initialValue: string,
				onSelect: (val: string) => void,
				onCancel: () => void,
			) {
				process.nextTick(() => {
					if (mockSelectorChoice !== null) {
						onSelect(mockSelectorChoice);
					} else {
						onCancel();
					}
				});
			}
		},
		SettingsSelectorComponent: class MockSettingsSelectorComponent {},
	};
});

describe("Catalog, Install Resources, Config Backup & Restore", () => {
	const testDir = join(process.cwd(), "test-catalog-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	// Source directories for resources
	const sourceDir = join(testDir, "my-catalog");
	const trustedSourceDir = join(testDir, "trusted-catalog");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });

		mkdirSync(sourceDir, { recursive: true });
		mkdirSync(trustedSourceDir, { recursive: true });

		// Redirect getAgentDir() to the sandbox via the canonical (shell-valid) env-var name.
		process.env[ENV_AGENT_DIR] = agentDir;

		// Initialize theme for the test environment
		initTheme("dark");

		mockSelectorChoice = null;
	});

	afterEach(() => {
		delete process.env[ENV_AGENT_DIR];
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe("getExternalResourceRoots and getEffectiveExternalResourceRoots", () => {
		it("returns only trusted, existing external resource roots canonicalized", () => {
			const manager = SettingsManager.create(projectDir, agentDir);

			const root1 = join(testDir, "root1");
			const root2 = join(testDir, "root2");
			const rootMissing = join(testDir, "root-missing");

			mkdirSync(root1, { recursive: true });
			mkdirSync(root2, { recursive: true });

			// Set external resource roots
			manager.setExternalResourceRoots([root1, root2, rootMissing], "global");

			// Only root1 is trusted
			manager.setTrustedResourceRoots([root1], "global");

			const effective = manager.getEffectiveExternalResourceRoots();

			// root1 should be returned, root2 is not trusted, rootMissing is missing
			expect(effective).toContain(resolve(root1));
			expect(effective).not.toContain(resolve(root2));
			expect(effective).not.toContain(resolve(rootMissing));
		});
	});

	describe("/install-resources command", () => {
		const copyResourcesRecursively = (InteractiveMode.prototype as any).copyResourcesRecursively;
		const handleInstallResourcesCommand = (InteractiveMode.prototype as any).handleInstallResourcesCommand;

		it("requires source to be trusted or prompts for trust and adds it", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);

			// Setup some files in source directory
			const skillDir = join(sourceDir, "skills");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(join(skillDir, "test.md"), "test skill content", "utf-8");

			const context = {
				settingsManager: manager,
				showError: vi.fn((msg) => console.error("TEST SHOW_ERROR:", msg)),
				showStatus: vi.fn((msg) => console.log("TEST SHOW_STATUS:", msg)),
				showSelector: vi.fn((fn: any) => {
					fn(() => {});
				}),
				handleReloadCommand: vi.fn(async () => {}),
				copyResourcesRecursively,
			};

			// 1. Run without trust and simulating rejection
			mockSelectorChoice = "no";
			await handleInstallResourcesCommand.call(context, sourceDir);

			expect(context.showStatus).toHaveBeenCalledWith(
				expect.stringContaining("Installation aborted. Source directory was not trusted."),
			);
			expect(manager.getTrustedResourceRoots()).not.toContain(resolve(sourceDir));

			// 2. Run without trust and simulating approval
			mockSelectorChoice = "yes";
			await handleInstallResourcesCommand.call(context, sourceDir);

			expect(manager.getTrustedResourceRoots()).toContain(resolve(sourceDir));
			expect(existsSync(join(agentDir, "skills", "test.md"))).toBe(true);
			expect(readFileSync(join(agentDir, "skills", "test.md"), "utf-8")).toBe("test skill content");
		});

		it("installs user-level agents to the agent dir where subagent discovery reads them", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.addTrustedResourceRoot(trustedSourceDir, "global");

			// Catalog ships flat agent .md files under <root>/agents
			const agentsSrc = join(trustedSourceDir, "agents");
			mkdirSync(agentsSrc, { recursive: true });
			writeFileSync(join(agentsSrc, "scout.md"), "---\nname: scout\nprofile: recon\n---\nbody", "utf-8");

			const context = {
				settingsManager: manager,
				showError: vi.fn((msg) => console.error("TEST SHOW_ERROR:", msg)),
				showStatus: vi.fn((msg) => console.log("TEST SHOW_STATUS:", msg)),
				showSelector: vi.fn(),
				handleReloadCommand: vi.fn(async () => {}),
				copyResourcesRecursively,
			};

			await handleInstallResourcesCommand.call(context, trustedSourceDir);

			// getAgentDir()/agents is the user-scope dir discoverAgents() scans
			const installed = join(agentDir, "agents", "scout.md");
			expect(existsSync(installed)).toBe(true);
			expect(readFileSync(installed, "utf-8")).toContain("name: scout");
		});

		it("skips existing files unless --force is specified", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.addTrustedResourceRoot(trustedSourceDir, "global");

			const skillDir = join(trustedSourceDir, "skills");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(join(skillDir, "test.md"), "new content", "utf-8");

			// Write pre-existing file in agentDir
			const destSkillDir = join(agentDir, "skills");
			mkdirSync(destSkillDir, { recursive: true });
			writeFileSync(join(destSkillDir, "test.md"), "old content", "utf-8");

			const context = {
				settingsManager: manager,
				showError: vi.fn((msg) => console.error("TEST SHOW_ERROR:", msg)),
				showStatus: vi.fn((msg) => console.log("TEST SHOW_STATUS:", msg)),
				showSelector: vi.fn(),
				handleReloadCommand: vi.fn(async () => {}),
				copyResourcesRecursively,
			};

			// Run without --force (should skip)
			await handleInstallResourcesCommand.call(context, trustedSourceDir);
			expect(readFileSync(join(destSkillDir, "test.md"), "utf-8")).toBe("old content");

			// Run with --force (should overwrite)
			await handleInstallResourcesCommand.call(context, `${trustedSourceDir} --force`);
			expect(readFileSync(join(destSkillDir, "test.md"), "utf-8")).toBe("new content");
		});
	});

	describe("Backup and Restore", () => {
		const handleConfigBackupCommand = (InteractiveMode.prototype as any).handleConfigBackupCommand;
		const handleConfigRestoreCommand = (InteractiveMode.prototype as any).handleConfigRestoreCommand;

		it("round-trips profiles and resource-relevant settings while keeping roots untrusted", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);

			// Setup profiles
			const profilesDir = join(agentDir, "profiles");
			mkdirSync(profilesDir, { recursive: true });
			writeFileSync(join(profilesDir, "p1.json"), JSON.stringify({ name: "p1", skills: ["s1"] }, null, 2));

			// Setup settings
			manager.setExternalResourceRoots(["/some/root"], "global");
			manager.setTrustedResourceRoots(["/some/root"], "global");
			manager.setProfileDefinition(
				"global-rich",
				{
					model: "openai-codex/gpt-5.6-terra",
					thinking: "max",
					soul: "Restore this situation.",
					modelRouter: { enabled: true, cheapThinking: "low" },
					resources: { tools: { allow: ["read", "delegate"] } },
				},
				"global",
			);
			const configured = manager.getGlobalSettings();
			manager.replaceGlobalResourceProfileConfiguration({
				resourceProfiles: configured.resourceProfiles,
				activeResourceProfiles: ["p1", "global-rich"],
				externalResourceRoots: configured.externalResourceRoots,
				trustedResourceRoots: configured.trustedResourceRoots,
			});

			const backupFile = join(testDir, "backup.json");

			const context = {
				settingsManager: manager,
				showError: vi.fn((msg) => console.error("TEST SHOW_ERROR:", msg)),
				showStatus: vi.fn((msg) => console.log("TEST SHOW_STATUS:", msg)),
				showSelector: vi.fn((fn: any) => {
					fn(() => {});
				}),
				handleReloadCommand: vi.fn(async () => true),
				handleReloadCommandWithResult: vi.fn(async () => true),
			};

			// Backup
			await handleConfigBackupCommand.call(context, backupFile);
			expect(existsSync(backupFile)).toBe(true);
			expect(JSON.parse(readFileSync(backupFile, "utf-8")).settings.activeResourceProfiles).toEqual([
				"p1",
				"global-rich",
			]);

			// Let's modify/clear current settings and profiles
			rmSync(join(profilesDir, "p1.json"), { force: true });
			manager.setExternalResourceRoots([], "global");
			manager.setTrustedResourceRoots([], "global");
			manager.deleteProfile("global-rich", "global");
			manager.setActiveProfile("default", "global");

			// Restore, first simulate cancellation
			mockSelectorChoice = "no";
			await handleConfigRestoreCommand.call(context, backupFile);
			expect(existsSync(join(profilesDir, "p1.json"))).toBe(false);

			// Restore, simulate confirmation
			mockSelectorChoice = "yes";
			await handleConfigRestoreCommand.call(context, backupFile);

			// Profiles should be restored
			expect(existsSync(join(profilesDir, "p1.json"))).toBe(true);
			const restoredProfile = JSON.parse(readFileSync(join(profilesDir, "p1.json"), "utf-8"));
			expect(restoredProfile.name).toBe("p1");

			// Settings restored, but externalResourceRoots brought back UNTRUSTED
			expect(manager.getExternalResourceRoots()).toContain("/some/root");
			expect(manager.getTrustedResourceRoots()).not.toContain("/some/root");
			expect(manager.getActiveResourceProfileNames()).toEqual(["p1", "global-rich"]);
			expect(manager.getProfileRegistry().getProfile("global-rich")).toMatchObject({
				model: "openai-codex/gpt-5.6-terra",
				thinking: "max",
				soul: "Restore this situation.",
				modelRouter: { enabled: true, cheapThinking: "low" },
				resources: { tools: { allow: ["read", "delegate"] } },
			});
		});

		it("round-trips an explicit no-profile selection", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setProfileDefinition("p1", { resources: { tools: { allow: ["read"] } } }, "global");
			manager.setActiveProfile(undefined, "global");
			await manager.flush();
			const backupFile = join(testDir, "none-backup.json");
			const context = {
				settingsManager: manager,
				showError: vi.fn(),
				showStatus: vi.fn(),
				showSelector: vi.fn((fn: (done: () => void) => unknown) => fn(() => {})),
				handleReloadCommand: vi.fn(async () => true),
				handleReloadCommandWithResult: vi.fn(async () => true),
			};

			await handleConfigBackupCommand.call(context, backupFile);
			manager.setActiveProfile("p1", "global");
			await manager.flush();
			mockSelectorChoice = "yes";
			await handleConfigRestoreCommand.call(context, backupFile);

			expect(manager.getGlobalSettings().activeResourceProfiles).toEqual([]);
			expect(manager.getActiveResourceProfileNames()).toEqual([]);
		});

		it("restores profile files and global authority settings when reload validation fails", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			const profilesDir = join(agentDir, "profiles");
			mkdirSync(profilesDir, { recursive: true });
			writeFileSync(join(profilesDir, "stable.json"), JSON.stringify({ name: "stable", resources: {} }));
			manager.setProfileDefinition("stable-global", { resources: { tools: { allow: ["read"] } } }, "global");
			manager.setActiveProfile("stable-global", "global");
			await manager.flush();

			const backupFile = join(testDir, "failing-restore.json");
			writeFileSync(
				backupFile,
				JSON.stringify({
					version: 2,
					profiles: { "replacement.json": { name: "replacement", resources: {} } },
					settings: {
						resourceProfiles: { replacement: { tools: { allow: ["bash"] } } },
						activeResourceProfiles: ["replacement"],
						externalResourceRoots: [],
					},
				}),
			);
			const context = {
				settingsManager: manager,
				showError: vi.fn(),
				showStatus: vi.fn(),
				showSelector: vi.fn((fn: (done: () => void) => unknown) => fn(() => {})),
				handleReloadCommand: vi.fn(async () => false),
				handleReloadCommandWithResult: vi.fn(async () => false),
			};
			mockSelectorChoice = "yes";

			await handleConfigRestoreCommand.call(context, backupFile);

			expect(existsSync(join(profilesDir, "stable.json"))).toBe(true);
			expect(existsSync(join(profilesDir, "replacement.json"))).toBe(false);
			expect(manager.getActiveResourceProfileNames()).toEqual(["stable-global"]);
			expect(manager.getProfileRegistry().getProfile("stable-global")).toBeDefined();
			expect(manager.getProfileRegistry().getProfile("replacement")).toBeUndefined();
			expect(context.showStatus).not.toHaveBeenCalledWith("Configuration restored successfully.");
			expect(context.showError).toHaveBeenCalledWith(expect.stringContaining("previous configuration restored"));
		});
	});
});
