import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { type ResourceProfileSettings, SettingsManager } from "../src/core/settings-manager.ts";
import {
	getProfileExtensionDisplayLabel,
	ProfileMenuController,
} from "../src/modes/interactive/profile-menu-controller.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createTestResourceLoader } from "./utilities.ts";

beforeAll(() => {
	initTheme("dark");
});

const prototype = ProfileMenuController.prototype as unknown as {
	getProfileResourceKinds(this: unknown): Promise<Array<{ kind: string; items: unknown[] }>>;
	openLibraryEditorForProfile(
		this: unknown,
		profileName: string,
		initialScope: "session" | "directory" | "project" | "global" | "reusable-file",
	): Promise<void>;
	saveProfileResources(
		this: unknown,
		profile: unknown,
		originalResources: ResourceProfileSettings,
		resources: ResourceProfileSettings,
		scope: "session" | "directory" | "project" | "global" | "reusable-file",
		isActiveProfile: boolean,
		runtimeMetadataChanged?: boolean,
	): Promise<void>;
	openManageProfilesFlow(this: unknown): Promise<void>;
	isProfileSettingsEnabled(this: unknown): boolean;
	selectProfileModel(this: unknown, profileModel?: string): Promise<string | null | undefined>;
	rollbackValidatedProfileMutation(this: unknown, snapshot: unknown, definition?: unknown): Promise<unknown>;
	applyProfile(this: unknown, profileName: string): Promise<void>;
	deleteProfileFromSource(this: unknown, profileName: string): Promise<void>;
	refreshAfterProfileMutation(this: unknown, profileName: string): Promise<void>;
	scopeForProfileSource(
		this: unknown,
		source: string,
	): "session" | "directory" | "project" | "global" | "reusable-file";
};

describe("getProfileResourceKinds", () => {
	it("builds the editor universe without crashing (regression: TDZ ReferenceError killed pi)", async () => {
		const context = {
			session: {
				resourceLoader: createTestResourceLoader(),
				getAllTools: () => [{ name: "ext_tool" }],
			},
		};
		const kinds = await prototype.getProfileResourceKinds.call(context);
		const byKind = new Map(kinds.map((kind) => [kind.kind, kind]));
		expect(byKind.has("tools")).toBe(true);
		expect(byKind.has("skills")).toBe(true);
		expect(byKind.has("prompts")).toBe(true);
		expect(byKind.has("agents")).toBe(true);
		// registered (extension) tools are part of the grantable universe
		expect((byKind.get("tools")!.items as Array<{ id: string }>).some((item) => item.id === "ext_tool")).toBe(true);
	});

	it("uses collision-safe paths while labeling descriptionless index extensions by folder", async () => {
		const loader = createTestResourceLoader();
		loader.getDiscoverableExtensionPaths = async () => [
			"/home/test/.pi/agent/extensions/alpha/index.ts",
			"/home/test/.pi/agent/extensions/beta/index.ts",
		];
		const kinds = await prototype.getProfileResourceKinds.call({
			session: { resourceLoader: loader, getAllTools: () => [] },
		});
		const extensions = kinds.find((kind) => kind.kind === "extensions")?.items ?? [];
		expect(extensions).toEqual([
			{
				id: "/home/test/.pi/agent/extensions/alpha/index.ts",
				label: "alpha",
				path: "/home/test/.pi/agent/extensions/alpha/index.ts",
				description: undefined,
			},
			{
				id: "/home/test/.pi/agent/extensions/beta/index.ts",
				label: "beta",
				path: "/home/test/.pi/agent/extensions/beta/index.ts",
				description: undefined,
			},
		]);
	});

	it("prefers an extension description and falls back portably for index entry points", () => {
		expect(getProfileExtensionDisplayLabel("C:\\Users\\me\\.pi\\extensions\\folder-name\\index.ts")).toBe(
			"folder-name",
		);
		expect(getProfileExtensionDisplayLabel("/extensions/folder-name/index.js", "  Useful extension  ")).toBe(
			"Useful extension",
		);
		expect(getProfileExtensionDisplayLabel("/extensions/direct-tool.ts")).toBe("direct-tool.ts");
	});
});

describe("profile selection persistence", () => {
	function context(settingsManager: SettingsManager, reloadSucceeded = true) {
		return {
			settingsManager,
			rollbackValidatedProfileMutation: prototype.rollbackValidatedProfileMutation,
			scopeForProfileSource: prototype.scopeForProfileSource,
			session: {
				sessionManager: { appendCustomEntry: vi.fn() },
				modelRegistry: {
					refresh: vi.fn(),
					getAll: vi.fn(() => []),
					createReloadSnapshot: vi.fn(() => ({})),
					restoreReloadSnapshot: vi.fn(),
				},
				setModel: vi.fn(async () => {}),
				setThinkingLevel: vi.fn(),
			},
			ui: {
				handleReloadCommand: vi.fn(async () => reloadSucceeded),
				footerDataProvider: { setExtensionStatus: vi.fn() },
				invalidateFooter: vi.fn(),
				updateEditorBorderColor: vi.fn(),
				showStatus: vi.fn(),
				showError: vi.fn(),
				showWarning: vi.fn(),
			},
		};
	}

	it("a selected profile survives a fresh session (persisted to global settings)", async () => {
		const settingsManager = SettingsManager.inMemory({
			resourceProfiles: { scout: { tools: { allow: ["read"] } } },
		});
		await prototype.applyProfile.call(context(settingsManager), "scout");
		// Regression: selection was runtime-only, so every new pi session started profileless.
		expect(settingsManager.getGlobalSettings().activeResourceProfiles).toEqual(["scout"]);
		expect(settingsManager.getActiveResourceProfileNames()).toEqual(["scout"]);
	});

	it("clearing the profile also persists (the old selection must not resurrect on restart)", async () => {
		const settingsManager = SettingsManager.inMemory({
			resourceProfiles: { scout: { tools: { allow: ["read"] } } },
			activeResourceProfiles: ["scout"],
		});
		await prototype.applyProfile.call(context(settingsManager), "none");
		expect(settingsManager.getGlobalSettings().activeResourceProfiles).toEqual([]);
	});

	it("persists /profiles none across restart instead of falling back to default or external-root profiles", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-profile-none-"));
		try {
			const agentDir = join(root, "agent");
			const projectDir = join(root, "project");
			const externalRoot = join(root, "external");
			mkdirSync(agentDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			mkdirSync(externalRoot, { recursive: true });
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					activeResourceProfiles: ["default"],
					resourceProfiles: { default: { tools: { allow: ["read"] } } },
					externalResourceRoots: [externalRoot],
					trustedResourceRoots: [externalRoot],
				}),
			);
			writeFileSync(
				join(externalRoot, "settings.json"),
				JSON.stringify({
					activeResourceProfiles: ["external-default"],
					resourceProfiles: { "external-default": { tools: { allow: ["grep"] } } },
				}),
			);
			const settingsManager = SettingsManager.create(projectDir, agentDir);
			settingsManager.setProfileDefinition(
				"project-active",
				{ resources: { tools: { allow: ["write"] } } },
				"project",
			);
			settingsManager.setActiveProfile("project-active", "project");
			settingsManager.setProfileDefinition(
				"directory-active",
				{ resources: { tools: { allow: ["bash"] } } },
				"directory",
			);
			settingsManager.setActiveProfile("directory-active", "directory");
			await settingsManager.flush();

			await prototype.applyProfile.call(context(settingsManager), "none");
			await settingsManager.flush();

			const restarted = SettingsManager.create(projectDir, agentDir);
			expect(restarted.getGlobalSettings().activeResourceProfiles).toEqual([]);
			expect(restarted.getActiveResourceProfileNames()).toEqual([]);
			expect(restarted.getResourceProfileFilter("tools")).toEqual({ allow: [], block: [] });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not persist or expose a staged profile when runtime reload fails", async () => {
		const settingsManager = SettingsManager.inMemory({
			resourceProfiles: {
				stable: { tools: { allow: ["read"] } },
				broken: { tools: { allow: ["bash"] } },
			},
			activeResourceProfiles: ["stable"],
		});
		const failedContext = context(settingsManager, false);

		await prototype.applyProfile.call(failedContext, "broken");

		expect(settingsManager.getGlobalSettings().activeResourceProfiles).toEqual(["stable"]);
		expect(settingsManager.getActiveResourceProfileNames()).toEqual(["stable"]);
		expect(failedContext.session.sessionManager.appendCustomEntry).not.toHaveBeenCalled();
		expect(failedContext.ui.showStatus).not.toHaveBeenCalled();
	});

	it("reverses the validated profile runtime when selection persistence throws", async () => {
		const settingsManager = SettingsManager.inMemory({
			resourceProfiles: {
				stable: { tools: { allow: ["read"] } },
				next: { tools: { allow: ["bash"] } },
			},
			activeResourceProfiles: ["stable"],
		});
		const failedContext = context(settingsManager, true);
		vi.spyOn(settingsManager, "setActiveProfile").mockImplementationOnce(() => {
			throw new Error("selection write failed");
		});

		await prototype.applyProfile.call(failedContext, "next");

		expect(failedContext.ui.handleReloadCommand).toHaveBeenCalledTimes(2);
		expect(settingsManager.getActiveResourceProfileNames()).toEqual(["stable"]);
		expect(settingsManager.getGlobalSettings().activeResourceProfiles).toEqual(["stable"]);
		expect(failedContext.ui.showStatus).not.toHaveBeenCalled();
		expect(failedContext.ui.showError).toHaveBeenCalledWith("selection write failed");
	});

	it("reverses the profileless runtime when clearing-selection persistence throws", async () => {
		const settingsManager = SettingsManager.inMemory({
			resourceProfiles: { stable: { tools: { allow: ["read"] } } },
			activeResourceProfiles: ["stable"],
		});
		const failedContext = context(settingsManager, true);
		vi.spyOn(settingsManager, "setActiveProfile").mockImplementationOnce(() => {
			throw new Error("clear write failed");
		});

		await prototype.applyProfile.call(failedContext, "none");

		expect(failedContext.ui.handleReloadCommand).toHaveBeenCalledTimes(2);
		expect(settingsManager.getActiveResourceProfileNames()).toEqual(["stable"]);
		expect(settingsManager.getGlobalSettings().activeResourceProfiles).toEqual(["stable"]);
		expect(failedContext.ui.showStatus).not.toHaveBeenCalled();
		expect(failedContext.ui.showError).toHaveBeenCalledWith("clear write failed");
	});

	it("keeps an active profile definition and selection when deletion reload fails", async () => {
		const settingsManager = SettingsManager.inMemory({
			resourceProfiles: {
				stable: {
					model: "anthropic/claude-sonnet-4-5",
					resources: { extensions: { allow: ["stable.ts"] }, tools: { allow: ["stable_tool"] } },
				},
			},
			activeResourceProfiles: ["stable"],
		});
		const failedContext = context(settingsManager, false);

		await prototype.deleteProfileFromSource.call(failedContext, "stable");

		expect(settingsManager.getProfileRegistry().getProfile("stable")).toBeDefined();
		expect(settingsManager.getActiveResourceProfileNames()).toEqual(["stable"]);
		expect(settingsManager.getGlobalSettings().activeResourceProfiles).toEqual(["stable"]);
		expect(failedContext.ui.showStatus).not.toHaveBeenCalled();
	});

	it("restores the prior runtime when deletion throws after the none generation reloaded", async () => {
		const settingsManager = SettingsManager.inMemory({
			resourceProfiles: { stable: { tools: { allow: ["read"] } } },
			activeResourceProfiles: ["stable"],
		});
		const rollbackContext = context(settingsManager, true);
		vi.spyOn(settingsManager, "deleteProfile").mockImplementation(() => {
			throw new Error("delete failed");
		});

		await prototype.deleteProfileFromSource.call(rollbackContext, "stable");

		expect(rollbackContext.ui.handleReloadCommand).toHaveBeenCalledTimes(2);
		expect(settingsManager.getActiveResourceProfileNames()).toEqual(["stable"]);
		expect(settingsManager.getProfileRegistry().getProfile("stable")).toBeDefined();
		expect(rollbackContext.ui.showError).toHaveBeenCalledWith("delete failed");
	});

	it("restores a deleted definition before reversing a later selection-write failure", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-profile-delete-rollback-"));
		try {
			const agentDir = join(root, "agent");
			const projectDir = join(root, "project");
			mkdirSync(agentDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			const settingsManager = SettingsManager.create(projectDir, agentDir);
			settingsManager.setProfileDefinition("stable", { resources: { tools: { allow: ["read"] } } }, "global");
			settingsManager.setActiveProfile("stable", "global");
			await settingsManager.flush();
			const rollbackContext = context(settingsManager, true);
			vi.spyOn(settingsManager, "setActiveProfile").mockImplementationOnce(() => {
				throw new Error("clear selection failed");
			});

			await prototype.deleteProfileFromSource.call(rollbackContext, "stable");
			await settingsManager.flush();

			const restarted = SettingsManager.create(projectDir, agentDir);
			expect(rollbackContext.ui.handleReloadCommand).toHaveBeenCalledTimes(2);
			expect(restarted.getProfileRegistry().getProfile("stable")).toBeDefined();
			expect(restarted.getActiveResourceProfileNames()).toEqual(["stable"]);
			expect(rollbackContext.ui.showStatus).not.toHaveBeenCalled();
			expect(rollbackContext.ui.showError).toHaveBeenCalledWith("clear selection failed");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("deleting an active directory profile persists none over lower-scope defaults", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-profile-delete-none-"));
		try {
			const agentDir = join(root, "agent");
			const projectDir = join(root, "project");
			mkdirSync(agentDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					activeResourceProfiles: ["default"],
					resourceProfiles: { default: { tools: { allow: ["read"] } } },
				}),
			);
			const settingsManager = SettingsManager.create(projectDir, agentDir);
			settingsManager.setProfileDefinition(
				"directory-active",
				{ resources: { tools: { allow: ["bash"] } } },
				"directory",
			);
			settingsManager.setActiveProfile("directory-active", "directory");
			await settingsManager.flush();

			await prototype.deleteProfileFromSource.call(context(settingsManager), "directory-active");
			await settingsManager.flush();

			const restarted = SettingsManager.create(projectDir, agentDir);
			expect(restarted.getProfileRegistry().getProfile("directory-active")).toBeUndefined();
			expect(restarted.getGlobalSettings().activeResourceProfiles).toEqual([]);
			expect(restarted.getActiveResourceProfileNames()).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("deletes a project-settings profile from the project definition that owns it", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-profile-project-delete-"));
		try {
			const agentDir = join(root, "agent");
			const projectDir = join(root, "project");
			mkdirSync(agentDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			const settingsManager = SettingsManager.create(projectDir, agentDir);
			settingsManager.setProfileDefinition("project-only", { resources: { tools: { allow: ["read"] } } }, "project");
			await settingsManager.flush();
			expect(settingsManager.getProfileRegistry().getProfile("project-only")?.source).toBe("project-settings");

			await prototype.deleteProfileFromSource.call(context(settingsManager), "project-only");
			await settingsManager.flush();

			expect(settingsManager.getProjectSettings().resourceProfiles?.["project-only"]).toBeUndefined();
			expect(settingsManager.getProfileRegistry().getProfile("project-only")).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses deletion when the winning definition belongs to an external settings source", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-profile-external-delete-"));
		try {
			const agentDir = join(root, "agent");
			const projectDir = join(root, "project");
			const externalRoot = join(root, "external");
			mkdirSync(agentDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			mkdirSync(externalRoot, { recursive: true });
			writeFileSync(
				join(externalRoot, "settings.json"),
				JSON.stringify({ resourceProfiles: { shared: { tools: { allow: ["read"] } } } }),
			);
			const settingsManager = SettingsManager.create(projectDir, agentDir);
			settingsManager.setExternalResourceRoots([externalRoot], "global");
			settingsManager.setTrustedResourceRoots([externalRoot], "global");
			await settingsManager.flush();
			expect(settingsManager.getProfileRegistry().getProfile("shared")?.source).toBe("external-settings");
			const deletionContext = context(settingsManager);

			await prototype.deleteProfileFromSource.call(deletionContext, "shared");

			expect(settingsManager.getProfileRegistry().getProfile("shared")?.source).toBe("external-settings");
			expect(deletionContext.ui.handleReloadCommand).not.toHaveBeenCalled();
			expect(deletionContext.ui.showStatus).not.toHaveBeenCalled();
			expect(deletionContext.ui.showError).toHaveBeenCalledWith(expect.stringContaining("read-only source"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("lets reload resolve a model contributed by the profile's newly granted extension", async () => {
		const settingsManager = SettingsManager.inMemory({
			resourceProfiles: {
				stable: { tools: { allow: ["read"] } },
				"extension-model": {
					model: "extension-provider/sol",
					resources: {
						extensions: { allow: ["<inline:1>"] },
						tools: { allow: ["*"] },
					},
				},
			},
			activeResourceProfiles: ["stable"],
		});
		const failedContext = context(settingsManager, false);

		await prototype.applyProfile.call(failedContext, "extension-model");

		expect(failedContext.ui.handleReloadCommand).toHaveBeenCalledTimes(1);
		expect(failedContext.session.modelRegistry.restoreReloadSnapshot).toHaveBeenCalledTimes(1);
		expect(settingsManager.getActiveResourceProfileNames()).toEqual(["stable"]);
		expect(failedContext.ui.showError).not.toHaveBeenCalledWith(expect.stringContaining("Model not found"));
	});
});

describe("active profile library edits", () => {
	it("routes an extensions-only provider grant through the full runtime reload", async () => {
		const settingsManager = SettingsManager.inMemory({
			resourceProfiles: {
				provider: {
					resources: {
						extensions: { allow: ["<inline:old>"] },
						tools: { allow: ["*"] },
					},
				},
			},
			activeResourceProfiles: ["provider"],
		});
		let editor: { onSave: (resources: ResourceProfileSettings) => void } | undefined;
		const handleReloadCommand = vi.fn(async () => true);
		const context = {
			settingsManager,
			saveProfileResources: prototype.saveProfileResources,
			rollbackValidatedProfileMutation: prototype.rollbackValidatedProfileMutation,
			sessionManager: { getCwd: () => "/workspace" },
			getProfileResourceKinds: vi.fn(async () => [
				{
					kind: "extensions",
					label: "Extensions",
					items: [{ id: "<inline:1>", path: "<inline:1>" }],
				},
			]),
			refreshAfterProfileMutation: prototype.refreshAfterProfileMutation,
			ui: {
				handleReloadCommand,
				footerDataProvider: { setExtensionStatus: vi.fn() },
				invalidateFooter: vi.fn(),
				updateEditorBorderColor: vi.fn(),
				requestRender: vi.fn(),
				showError: vi.fn(),
				showStatus: vi.fn(),
				showSelector: (create: (done: () => void) => { component: unknown; focus: unknown }) => {
					const selection = create(vi.fn());
					editor = selection.component as { onSave: (resources: ResourceProfileSettings) => void };
				},
			},
		};

		await prototype.openLibraryEditorForProfile.call(context, "provider", "session");
		expect(editor).toBeDefined();
		editor!.onSave({
			extensions: { allow: ["<inline:1>"] },
			tools: { allow: ["*"] },
		});

		await vi.waitFor(() => expect(handleReloadCommand).toHaveBeenCalledTimes(1));
		expect(settingsManager.getProfileRegistry().getProfile("provider")?.resources.extensions).toEqual({
			allow: ["<inline:1>"],
		});
	});

	it("restores the active definition and withholds saved status when reload validation fails", async () => {
		const settingsManager = SettingsManager.inMemory({
			resourceProfiles: {
				provider: {
					resources: {
						extensions: { allow: ["<inline:old>"] },
						tools: { allow: ["*"] },
					},
				},
			},
			activeResourceProfiles: ["provider"],
		});
		let editor: { onSave: (resources: ResourceProfileSettings) => void } | undefined;
		const handleReloadCommand = vi.fn(async () => false);
		const showStatus = vi.fn();
		const context = {
			settingsManager,
			saveProfileResources: prototype.saveProfileResources,
			rollbackValidatedProfileMutation: prototype.rollbackValidatedProfileMutation,
			sessionManager: { getCwd: () => "/workspace" },
			getProfileResourceKinds: vi.fn(async () => [{ kind: "tools", label: "Tools", items: [] }]),
			ui: {
				handleReloadCommand,
				footerDataProvider: { setExtensionStatus: vi.fn() },
				invalidateFooter: vi.fn(),
				updateEditorBorderColor: vi.fn(),
				requestRender: vi.fn(),
				showError: vi.fn(),
				showStatus,
				showSelector: (create: (done: () => void) => { component: unknown; focus: unknown }) => {
					const selection = create(vi.fn());
					editor = selection.component as { onSave: (resources: ResourceProfileSettings) => void };
				},
			},
		};

		await prototype.openLibraryEditorForProfile.call(context, "provider", "session");
		editor!.onSave({ extensions: { allow: ["<inline:broken>"] }, tools: { allow: ["*"] } });
		await vi.waitFor(() => expect(handleReloadCommand).toHaveBeenCalledTimes(1));

		expect(settingsManager.getProfileRegistry().getProfile("provider")?.resources.extensions).toEqual({
			allow: ["<inline:old>"],
		});
		expect(showStatus).not.toHaveBeenCalled();
	});

	it("restores the persistent definition before reversing a post-doctor commit failure", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-profile-edit-rollback-"));
		try {
			const agentDir = join(root, "agent");
			const projectDir = join(root, "project");
			mkdirSync(agentDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			const settingsManager = SettingsManager.create(projectDir, agentDir);
			settingsManager.setProfileDefinition(
				"provider",
				{
					resources: {
						extensions: { allow: ["old.js"] },
						tools: { allow: ["*"] },
					},
				},
				"global",
			);
			settingsManager.setActiveProfile("provider", "global");
			await settingsManager.flush();
			let editor: { onSave: (resources: ResourceProfileSettings) => void } | undefined;
			const handleReloadCommand = vi.fn(async () => true);
			const showStatus = vi.fn();
			const showError = vi.fn();
			vi.spyOn(settingsManager, "reload").mockRejectedValueOnce(new Error("post-commit reload failed"));
			const context = {
				settingsManager,
				saveProfileResources: prototype.saveProfileResources,
				rollbackValidatedProfileMutation: prototype.rollbackValidatedProfileMutation,
				sessionManager: { getCwd: () => projectDir },
				getProfileResourceKinds: vi.fn(async () => [{ kind: "tools", label: "Tools", items: [] }]),
				ui: {
					handleReloadCommand,
					footerDataProvider: { setExtensionStatus: vi.fn() },
					invalidateFooter: vi.fn(),
					updateEditorBorderColor: vi.fn(),
					requestRender: vi.fn(),
					showError,
					showStatus,
					showSelector: (create: (done: () => void) => { component: unknown; focus: unknown }) => {
						const selection = create(vi.fn());
						editor = selection.component as { onSave: (resources: ResourceProfileSettings) => void };
					},
				},
			};

			await prototype.openLibraryEditorForProfile.call(context, "provider", "global");
			editor!.onSave({ extensions: { allow: ["new.js"] }, tools: { allow: ["*"] } });
			await vi.waitFor(() => expect(showError).toHaveBeenCalledWith("post-commit reload failed"));
			await settingsManager.flush();

			const restarted = SettingsManager.create(projectDir, agentDir);
			expect(restarted.getProfileRegistry().getProfile("provider")?.resources.extensions).toEqual({
				allow: ["old.js"],
			});
			expect(handleReloadCommand).toHaveBeenCalledTimes(2);
			expect(showStatus).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("profile model editing", () => {
	it("exposes profile model editing from Manage Profiles", async () => {
		const settingsManager = SettingsManager.inMemory({
			resourceProfiles: {
				"pi-fortes": {
					model: "openai-codex/gpt-5.5",
					resources: { tools: { allow: ["*"] } },
				},
			},
		});
		let renderedMenu: string[] | undefined;
		const context = {
			settingsManager,
			isProfileSettingsEnabled: prototype.isProfileSettingsEnabled,
			ui: {
				showSelector: (
					create: (done: () => void) => {
						component: { render(width: number): string[] };
						focus: unknown;
					},
				) => {
					renderedMenu = create(vi.fn()).component.render(100);
				},
			},
		};

		await prototype.openManageProfilesFlow.call(context);

		expect(renderedMenu?.join("\n")).toContain("Edit profile model");
	});

	it("offers inherited model behavior while showing an unavailable current pin", async () => {
		let selector:
			| {
					render(width: number): string[];
					getSelectList(): { handleInput(data: string): void };
			  }
			| undefined;
		const selection = prototype.selectProfileModel.call(
			{
				ui: {
					getAutoLearnModelOptions: () => [
						{
							value: "openai-codex/gpt-5.6-sol",
							label: "openai-codex/gpt-5.6-sol",
							description: "current",
						},
					],
					showSelector: (
						create: (done: () => void) => {
							component: {
								render(width: number): string[];
								getSelectList(): { handleInput(data: string): void };
							};
							focus: unknown;
						},
					) => {
						selector = create(vi.fn()).component;
					},
				},
			},
			"openai-codex/gpt-5.5",
		);

		expect(selector?.render(120).join("\n")).toContain("Inherit session/default model");
		expect(selector?.render(120).join("\n")).toContain("openai-codex/gpt-5.5");
		selector?.getSelectList().handleInput("\x1b[A");
		selector?.getSelectList().handleInput("\r");
		expect(await selection).toBeNull();
	});

	it("clears an active profile model and reloads immediately without losing metadata", async () => {
		const settingsManager = SettingsManager.inMemory({
			resourceProfiles: {
				"pi-fortes": {
					description: "Fortes development",
					model: "openai-codex/gpt-5.5",
					thinking: "high",
					modelRouter: { enabled: false, mediumModel: "openai-codex/gpt-5.5" },
					soul: "Work surgically.",
					resources: { tools: { allow: ["*"] }, skills: { allow: ["forteslib-patterns"] } },
				},
			},
			activeResourceProfiles: ["pi-fortes"],
		});
		const profile = settingsManager.getProfileRegistry().getProfile("pi-fortes");
		expect(profile).toBeDefined();
		const handleReloadCommand = vi.fn(async () => true);
		const context = {
			settingsManager,
			refreshAfterProfileMutation: prototype.refreshAfterProfileMutation,
			rollbackValidatedProfileMutation: prototype.rollbackValidatedProfileMutation,
			ui: {
				handleReloadCommand,
				footerDataProvider: { setExtensionStatus: vi.fn() },
				invalidateFooter: vi.fn(),
				updateEditorBorderColor: vi.fn(),
				showError: vi.fn(),
				showStatus: vi.fn(),
			},
		};

		await prototype.saveProfileResources.call(
			context,
			{ ...profile!, model: undefined },
			profile!.resources,
			profile!.resources,
			"global",
			true,
			true,
		);

		const saved = settingsManager.getGlobalSettings().resourceProfiles?.["pi-fortes"];
		expect(saved).not.toHaveProperty("model");
		expect(saved).toMatchObject({
			description: "Fortes development",
			thinking: "high",
			modelRouter: { enabled: false, mediumModel: "openai-codex/gpt-5.5" },
			soul: "Work surgically.",
			resources: { tools: { allow: ["*"] }, skills: { allow: ["forteslib-patterns"] } },
		});
		expect(handleReloadCommand).toHaveBeenCalledTimes(1);
	});

	it("updates an inactive profile model without reloading the current runtime", async () => {
		const settingsManager = SettingsManager.inMemory({
			resourceProfiles: {
				"pi-fortes": {
					model: "openai-codex/gpt-5.5",
					resources: { tools: { allow: ["*"] } },
				},
			},
		});
		const profile = settingsManager.getProfileRegistry().getProfile("pi-fortes");
		expect(profile).toBeDefined();
		const handleReloadCommand = vi.fn(async () => true);
		const context = {
			settingsManager,
			refreshAfterProfileMutation: prototype.refreshAfterProfileMutation,
			rollbackValidatedProfileMutation: prototype.rollbackValidatedProfileMutation,
			ui: {
				handleReloadCommand,
				footerDataProvider: { setExtensionStatus: vi.fn() },
				invalidateFooter: vi.fn(),
				updateEditorBorderColor: vi.fn(),
				showError: vi.fn(),
				showStatus: vi.fn(),
			},
		};

		await prototype.saveProfileResources.call(
			context,
			{ ...profile!, model: "openai-codex/gpt-5.6-sol" },
			profile!.resources,
			profile!.resources,
			"global",
			false,
			true,
		);

		expect(settingsManager.getGlobalSettings().resourceProfiles?.["pi-fortes"]).toMatchObject({
			model: "openai-codex/gpt-5.6-sol",
			resources: { tools: { allow: ["*"] } },
		});
		expect(handleReloadCommand).not.toHaveBeenCalled();
	});
});
