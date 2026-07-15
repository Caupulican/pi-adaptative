/**
 * Resource-profile & external-source menu controller.
 *
 * Extracted verbatim from interactive-mode.ts (god-file decomposition). Owns the /profiles command
 * and the resource-hub menu tree: active-profile selection, profile create/delete/persist, the
 * library (per-profile resource grants) editor, and external-source root management. It holds NO
 * state of its own — every profile/source fact lives in settingsManager / the profile registry /
 * the session resourceLoader — so it takes narrow deps (a live session accessor plus a UI callback
 * surface, including the editor-overlay-backed showSelector) rather than the whole InteractiveMode
 * instance.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Api, Model } from "@caupulican/pi-ai";
import type { Component, SelectItem, TUI } from "@caupulican/pi-tui";
import { getAgentDir } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { resolveCliModel } from "../../core/model-resolver.ts";
import type { NormalizedProfile } from "../../core/profile-registry.ts";
import { resourceProfileSettingsChangedKinds } from "../../core/resource-profile-equality.ts";
import type { SettingsReloadSnapshot } from "../../core/settings-manager.ts";
import { validateSkillName } from "../../core/skills.ts";
import { allToolNames } from "../../core/tools/index.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { ExtensionInputComponent } from "./components/extension-input.ts";
import {
	ProfileResourceEditorComponent,
	type ProfileResourceEditorKind,
	resolveResourceEditPath,
} from "./components/profile-resource-editor.ts";
import { ProfileSelectorComponent } from "./components/profile-selector.ts";
import { SelectSubmenu } from "./components/settings-selector.ts";
import { captureProfileFiles, restoreProfileFiles } from "./config-backup.ts";
import { getAvailableThemesWithPaths } from "./theme/theme.ts";

type WritableProfileScope = "session" | "directory" | "project" | "global" | "reusable-file";

export const NO_ACTIVE_PROFILE_DESCRIPTION =
	"Baseline resources; inline SDK extensions load, discovered extensions stay withheld";

function deletionScopeForProfile(profile: NormalizedProfile): WritableProfileScope | undefined {
	switch (profile.source) {
		case "inline":
			return "session";
		case "directory-overlay":
			return "directory";
		case "project-settings":
			return "project";
		case "global-settings":
			return "global";
		case "profile-file": {
			const localProfilePath = path.resolve(getAgentDir(), "profiles", `${profile.name}.json`);
			return profile.sourcePath && path.resolve(profile.sourcePath) === localProfilePath
				? "reusable-file"
				: undefined;
		}
		case "embedded":
		case "external-settings":
			return undefined;
	}
}

interface ProfileDefinitionRollbackTarget {
	profileName: string;
	scope: WritableProfileScope;
	profileFilesSnapshot?: ReturnType<typeof captureProfileFiles>;
}

export interface ProfileMenuControllerUi {
	showSelector(
		create: (done: () => void) => {
			component: Component;
			focus: Component;
			onSuperseded?: () => void;
		},
	): void;
	showStatus(message: string): void;
	showError(message: string): void;
	showWarning(message: string): void;
	requestRender(): void;
	readonly tui: TUI;
	readonly footerDataProvider: { setExtensionStatus(key: string, text: string | undefined): void };
	invalidateFooter(): void;
	updateEditorBorderColor(): void;
	openEditorForPath(filePath: string): Promise<boolean>;
	handleReloadCommand(): Promise<boolean>;
	maybeWarnAboutAnthropicSubscriptionAuth(model?: Model<Api>): void;
	checkDaxnutsEasterEgg(model: { provider: string; id: string }): void;
	showSettingsSelector(): void;
	getAutoLearnModelOptions(): SelectItem[];
}

export interface ProfileMenuControllerDeps {
	getSession(): AgentSession;
	ui: ProfileMenuControllerUi;
}

function portableBasename(filePath: string): string {
	return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

export function getProfileExtensionDisplayLabel(filePath: string, description?: string): string {
	const normalizedDescription = description?.trim();
	if (normalizedDescription) return normalizedDescription;
	const fileName = portableBasename(filePath);
	if (!/^index\.(?:ts|js)$/i.test(fileName)) return fileName;
	const parentPath = filePath.slice(0, Math.max(0, filePath.length - fileName.length)).replace(/[\\/]$/, "");
	return portableBasename(parentPath) || fileName;
}

export class ProfileMenuController {
	private readonly deps: ProfileMenuControllerDeps;

	constructor(deps: ProfileMenuControllerDeps) {
		this.deps = deps;
	}

	private get session(): AgentSession {
		return this.deps.getSession();
	}
	private get sessionManager() {
		return this.deps.getSession().sessionManager;
	}
	private get settingsManager() {
		return this.deps.getSession().settingsManager;
	}
	private get ui(): ProfileMenuControllerUi {
		return this.deps.ui;
	}

	async handleResourcesHubAction(action: string): Promise<void> {
		switch (action) {
			case "nudge-add-source":
				void this.addExternalResourceRootFlow().then(() => {
					void this.ui.showSettingsSelector();
				});
				break;
			case "active-profile":
				void this.openActiveProfileSelector();
				break;
			case "manage-library":
				void this.openLibraryManagerFlow();
				break;
			case "manage-profiles":
				void this.openManageProfilesFlow();
				break;
			case "sources":
				void this.openSourcesManagerFlow();
				break;
		}
	}

	private async openActiveProfileSelector(): Promise<void> {
		const registry = this.settingsManager.getProfileRegistry();
		const profiles = registry.listProfiles();
		const activeNames = this.settingsManager.getActiveResourceProfileNames();

		const options = [
			{ value: "(none)", label: "(none)", description: NO_ACTIVE_PROFILE_DESCRIPTION },
			...profiles.map((p) => ({
				value: p.name,
				label: p.name,
				description: p.description || p.source,
			})),
		];

		this.ui.showSelector((done) => {
			const selector = new SelectSubmenu(
				"Profile / Situation",
				"Select the active runtime profile/situation for this session. This is session-only unless saved elsewhere.",
				options,
				activeNames[0] || "(none)",
				(value) => {
					done();
					void this.applyProfile(value === "(none)" ? "" : value).then(() => {
						void this.ui.showSettingsSelector();
					});
				},
				() => {
					done();
					void this.ui.showSettingsSelector();
				},
			);
			return { component: selector, focus: selector.getSelectList() };
		});
	}

	private async openManageProfilesFlow(): Promise<void> {
		const registry = this.settingsManager.getProfileRegistry();
		const profiles = registry.listProfiles();
		const editableProfiles = profiles.map((p) => ({
			value: p.name,
			label: p.name,
			description: p.description || p.source,
		}));

		const options = [
			{
				value: "create",
				label: "+ Create profile / situation...",
				description: "Create a new resource profile/situation definition.",
			},
		];

		if (editableProfiles.length > 0) {
			options.push({
				value: "edit-model",
				label: "Edit profile model...",
				description: "Pin a model or inherit the session/default model.",
			});
		}

		if (this.settingsManager.getActiveResourceProfileNames().length > 0) {
			options.push({
				value: "persist",
				label: "Persist active profile / situation to...",
				description: "Save the current active profile/situation selection so it survives restart.",
			});
		}

		if (editableProfiles.length > 0) {
			options.push({
				value: "delete",
				label: "Delete profile / situation...",
				description: "Remove a profile/situation definition from where it is stored.",
			});
		}

		this.ui.showSelector((done) => {
			const selector = new SelectSubmenu(
				"Manage Profiles / Situations",
				"Create, edit, delete, or persist profile/situation definitions.",
				options,
				"",
				(value) => {
					done();
					if (value === "create") {
						void this.createProfileFlow().then(() => {
							void this.ui.showSettingsSelector();
						});
					} else if (value === "edit-model") {
						this.openEditProfileModelSelector();
					} else if (value === "persist") {
						void this.openPersistProfileSelector();
					} else if (value === "delete") {
						void this.openDeleteProfileSelector();
					}
				},
				() => {
					done();
					void this.ui.showSettingsSelector();
				},
			);
			return { component: selector, focus: selector.getSelectList() };
		});
	}

	private openEditProfileModelSelector(): void {
		const profiles = this.settingsManager
			.getProfileRegistry()
			.listProfiles()
			.filter((profile) => deletionScopeForProfile(profile) !== undefined);
		if (profiles.length === 0) {
			this.ui.showStatus("No writable profiles available. External and embedded profiles are read-only.");
			return;
		}
		const activeNames = this.settingsManager.getActiveResourceProfileNames();
		const initialValue = profiles.find((profile) => activeNames.includes(profile.name))?.name ?? profiles[0].name;
		const items = profiles.map((profile) => ({
			value: profile.name,
			label: profile.name,
			description: `${profile.model ? `Pinned: ${profile.model}` : "Inherits session/default model"} · ${profile.description || profile.source}`,
		}));

		this.ui.showSelector((done) => {
			const selector = new SelectSubmenu(
				"Edit Profile Model",
				"Choose a writable profile, then pin or inherit its foreground model.",
				items,
				initialValue,
				(profileName) => {
					done();
					void this.editProfileModel(profileName);
				},
				() => {
					done();
					void this.openManageProfilesFlow();
				},
			);
			return { component: selector, focus: selector.getSelectList() };
		});
	}

	private async editProfileModel(profileName: string): Promise<void> {
		const profile = this.settingsManager.getProfileRegistry().getProfile(profileName);
		if (!profile) {
			this.ui.showError(`Profile "${profileName}" is no longer available.`);
			return;
		}
		const scope = deletionScopeForProfile(profile);
		if (!scope) {
			this.ui.showError(`Profile "${profileName}" is read-only (${profile.source}).`);
			return;
		}
		const selectedModel = await this.selectProfileModel(profile.model);
		if (selectedModel === undefined) {
			void this.openManageProfilesFlow();
			return;
		}
		const model = selectedModel ?? undefined;
		if (model === profile.model) {
			this.ui.showStatus(`Profile "${profileName}" model unchanged.`);
			return;
		}
		await this.saveProfileResources(
			{ ...profile, model },
			profile.resources,
			profile.resources,
			scope,
			this.settingsManager.getActiveResourceProfileNames().includes(profile.name),
			true,
		);
	}

	private async openPersistProfileSelector(): Promise<void> {
		const scopeOptions = [
			{ value: "session", label: "session", description: "Runtime only (not written to disk)" },
			{
				value: "directory",
				label: "directory",
				description: "~/.pi/agent/resource-profiles/<hash>/settings.json",
			},
			{ value: "project", label: "project", description: ".pi/settings.json" },
			{ value: "global", label: "global", description: "~/.pi/agent/settings.json" },
		];

		this.ui.showSelector((done) => {
			const selector = new SelectSubmenu(
				"Persist Active Profile / Situation",
				"Choose where to write the active profile/situation selection.",
				scopeOptions,
				"directory",
				(value) => {
					done();
					this.persistActiveProfile(value as "session" | "directory" | "project" | "global");
					void this.ui.showSettingsSelector();
				},
				() => {
					done();
					void this.openManageProfilesFlow();
				},
			);
			return { component: selector, focus: selector.getSelectList() };
		});
	}

	private async openDeleteProfileSelector(): Promise<void> {
		const registry = this.settingsManager.getProfileRegistry();
		const editableProfiles = registry.listProfiles().map((p) => ({
			value: p.name,
			label: p.name,
			description: p.description || p.source,
		}));

		this.ui.showSelector((done) => {
			const selector = new SelectSubmenu(
				"Delete Profile / Situation",
				"Pick a profile/situation to delete.",
				editableProfiles,
				"",
				(value) => {
					done();
					void this.deleteProfileFromSource(value).then(() => {
						void this.ui.showSettingsSelector();
					});
				},
				() => {
					done();
					void this.openManageProfilesFlow();
				},
			);
			return { component: selector, focus: selector.getSelectList() };
		});
	}

	private async openSourcesManagerFlow(): Promise<void> {
		const externalRoots = this.settingsManager.getExternalResourceRoots();
		const trustedRoots = this.settingsManager.getTrustedResourceRoots();

		const options = [
			{
				value: "add",
				label: "+ Add external root...",
				description: "Register a new external directory root (requires trust)",
			},
		];

		for (const r of externalRoots) {
			const isTrusted = trustedRoots.includes(r);
			options.push({
				value: `remove:${r}`,
				label: `Remove: ${r}`,
				description: isTrusted ? "Trusted external root" : "Untrusted external root",
			});
		}

		this.ui.showSelector((done) => {
			const selector = new SelectSubmenu(
				"Sources",
				"Manage external resource roots. Adding a root requires trust confirmation.",
				options,
				"",
				(value) => {
					done();
					if (value === "add") {
						void this.addExternalResourceRootFlow().then(() => {
							void this.ui.showSettingsSelector();
						});
					} else if (value.startsWith("remove:")) {
						const root = value.slice("remove:".length);
						void this.removeExternalResourceRootFlow(root).then(() => {
							void this.ui.showSettingsSelector();
						});
					}
				},
				() => {
					done();
					void this.ui.showSettingsSelector();
				},
			);
			return { component: selector, focus: selector.getSelectList() };
		});
	}

	private async openLibraryManagerFlow(): Promise<void> {
		const activeNames = this.settingsManager.getActiveResourceProfileNames();
		const activeName = activeNames[0];

		if (!activeName || activeName === "(none)") {
			this.ui.showSelector((done) => {
				const selector = new SelectSubmenu(
					"No Active Profile / Situation",
					"Select or create a profile/situation to manage the library.",
					[
						{
							value: "select",
							label: "Select existing profile / situation...",
							description: "Choose an existing profile/situation to activate.",
						},
						{
							value: "create",
							label: "Create new profile / situation...",
							description: "Create a new profile/situation definition.",
						},
					],
					"select",
					(value) => {
						done();
						if (value === "create") {
							void this.createProfileAndOpenLibraryFlow();
						} else {
							void this.selectProfileAndOpenLibraryFlow();
						}
					},
					() => {
						done();
						void this.ui.showSettingsSelector();
					},
				);
				return { component: selector, focus: selector.getSelectList() };
			});
			return;
		}

		const registry = this.settingsManager.getProfileRegistry();
		const profile = registry.getProfile(activeName);
		if (!profile) {
			this.ui.showError(`Active profile/situation "${activeName}" not found in registry.`);
			return;
		}
		const scope = this.scopeForProfileSource(profile.source);
		void this.openLibraryEditorForProfile(profile.name, scope);
	}

	private async createProfileAndOpenLibraryFlow(): Promise<void> {
		const name = await new Promise<string | undefined>((resolve) => {
			this.ui.showSelector((done) => {
				const input = new ExtensionInputComponent(
					"Create Profile / Situation",
					"Enter profile/situation name",
					(value) => {
						done();
						resolve(value);
					},
					() => {
						done();
						resolve(undefined);
					},
					{ tui: this.ui.tui },
				);
				return { component: input, focus: input, onSuperseded: () => resolve(undefined) };
			});
		});

		if (name === undefined) {
			void this.openLibraryManagerFlow();
			return;
		}

		const trimmed = name.trim();
		if (!trimmed) {
			this.ui.showWarning("Profile/situation name cannot be empty.");
			void this.openLibraryManagerFlow();
			return;
		}

		try {
			const profileModel = await this.selectProfileModel();
			if (profileModel === undefined) {
				void this.openLibraryManagerFlow();
				return;
			}
			this.settingsManager.setProfileDefinition(
				trimmed,
				{
					name: trimmed,
					model: profileModel ?? undefined,
					resources: {},
				},
				"reusable-file",
			);
			await this.applyProfile(trimmed);
			void this.openLibraryEditorForProfile(trimmed, "reusable-file");
		} catch (error) {
			this.ui.showError(error instanceof Error ? error.message : String(error));
			void this.openLibraryManagerFlow();
		}
	}

	private async selectProfileAndOpenLibraryFlow(): Promise<void> {
		const registry = this.settingsManager.getProfileRegistry();
		const profiles = registry.listProfiles();
		const editableProfiles = profiles.map((p) => ({
			value: p.name,
			label: p.name,
			description: p.description || p.source,
		}));

		if (editableProfiles.length === 0) {
			this.ui.showWarning("No existing profiles/situations to select. Please create one.");
			void this.createProfileAndOpenLibraryFlow();
			return;
		}

		this.ui.showSelector((done) => {
			const selector = new SelectSubmenu(
				"Select Profile / Situation",
				"Pick a profile/situation to activate and edit.",
				editableProfiles,
				"",
				(value) => {
					done();
					void this.applyProfile(value).then(() => {
						const profile = registry.getProfile(value)!;
						const scope = this.scopeForProfileSource(profile.source);
						void this.openLibraryEditorForProfile(value, scope);
					});
				},
				() => {
					done();
					void this.openLibraryManagerFlow();
				},
			);
			return { component: selector, focus: selector.getSelectList() };
		});
	}

	private async getProfileResourceKinds(): Promise<ProfileResourceEditorKind[]> {
		const loader = this.session.resourceLoader;
		const base = portableBasename;
		const allDiscoverableExtensions = await loader.getDiscoverableExtensionPaths();
		// Defined BEFORE the skills/prompts arrays below that call it (const = TDZ: defining it
		// later crashes the whole app with a ReferenceError when the library editor opens).
		const getFrontmatterDescription = (filePath: string): string | undefined => {
			try {
				const content = fs.readFileSync(filePath, "utf-8");
				const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
				if (typeof frontmatter.description === "string") return frontmatter.description;
			} catch {}
			return undefined;
		};
		// The editor's universe must be profile-INDEPENDENT (discovery, not loading): the loaded
		// getters are narrowed by the active profile, so building the lists from them makes
		// currently-blocked skills/prompts/context files ungrantable — including expanding the
		// very profile you are running under. Union the loaded (rich metadata) sets with the
		// full pre-filter discovery paths.
		const loadedSkills = loader.getSkills().skills;
		const loadedSkillPaths = new Set(loadedSkills.map((skill) => skill.filePath));
		const skillIdFromPath = (skillPath: string): string => {
			const parts = skillPath.split(/[\\/]/);
			const last = parts.pop() ?? skillPath;
			if (/^skill\.md$/i.test(last)) return parts.pop() ?? last;
			return last.replace(/\.md$/i, "");
		};
		const skills = [
			...loadedSkills.map((skill) => ({ id: skill.name, path: skill.filePath, description: skill.description })),
			...loader
				.getDiscoverableSkillPaths()
				.filter((skillPath) => !loadedSkillPaths.has(skillPath))
				.map((skillPath) => ({
					id: skillIdFromPath(skillPath),
					path: skillPath,
					description: getFrontmatterDescription(skillPath),
				})),
		];
		const loadedPrompts = loader.getPrompts().prompts;
		const loadedPromptPaths = new Set(loadedPrompts.map((prompt) => prompt.filePath));
		const prompts = [
			...loadedPrompts.map((prompt) => ({
				id: prompt.name,
				path: prompt.filePath,
				description: prompt.description,
			})),
			...loader
				.getDiscoverablePromptPaths()
				.filter((promptPath) => !loadedPromptPaths.has(promptPath))
				.map((promptPath) => ({
					id: (promptPath.split(/[\\/]/).pop() ?? promptPath).replace(/\.md$/i, ""),
					path: promptPath,
					description: getFrontmatterDescription(promptPath),
				})),
		];
		const themes = getAvailableThemesWithPaths();
		const loadedAgentPaths = new Set(loader.getAgentsFiles().agentsFiles.map((file) => file.path));
		const agents = [
			...loader.getAgentsFiles().agentsFiles.map((file) => ({ path: file.path })),
			...loader
				.getDiscoverableAgentsFilePaths()
				.filter((agentPath) => !loadedAgentPaths.has(agentPath))
				.map((agentPath) => ({ path: agentPath })),
		];

		const getAgentDescription = (filePath: string): string | undefined => {
			try {
				const content = fs.readFileSync(filePath, "utf-8");
				const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
				if (typeof frontmatter.description === "string") {
					return frontmatter.description;
				}
			} catch {}
			return undefined;
		};

		const getExtensionDescription = (filePath: string): string | undefined => {
			try {
				let dir = filePath;
				if (fs.existsSync(filePath) && !fs.statSync(filePath).isDirectory()) {
					dir = path.dirname(filePath);
				}
				const pkgPath = path.join(dir, "package.json");
				if (fs.existsSync(pkgPath)) {
					const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
					if (typeof pkg.description === "string") {
						return pkg.description;
					}
				}
			} catch {}
			return undefined;
		};

		return [
			{
				kind: "tools",
				label: "Tools",
				// Built-ins plus every currently registered tool (extension tools included), so
				// an extension tool can be granted by name without hand-editing settings JSON.
				items: [...new Set([...allToolNames, ...this.session.getAllTools().map((tool) => tool.name)])].map(
					(name: string) => ({ id: name }),
				),
			},
			{
				kind: "skills",
				label: "Skills",
				items: skills,
			},
			{
				kind: "extensions",
				label: "Extensions",
				items: allDiscoverableExtensions.map((extensionPath) => {
					const description = getExtensionDescription(extensionPath);
					return {
						id: path.resolve(extensionPath),
						label: getProfileExtensionDisplayLabel(extensionPath, description),
						path: extensionPath,
						description,
					};
				}),
			},
			{
				kind: "agents",
				label: "Agents",
				items: agents.map((f) => ({
					id: base(f.path),
					path: f.path,
					description: getAgentDescription(f.path),
				})),
			},
			{
				kind: "prompts",
				label: "Prompts",
				items: prompts,
			},
			{
				kind: "themes",
				label: "Themes",
				items: themes.map((t) => ({
					id: t.name,
					path: t.path,
				})),
			},
		];
	}

	private async openLibraryEditorForProfile(
		profileName: string,
		initialScope: "session" | "directory" | "project" | "global" | "reusable-file",
	): Promise<void> {
		const currentScope = initialScope;
		const registry = this.settingsManager.getProfileRegistry();
		const profile = registry.getProfile(profileName);
		if (!profile) {
			this.ui.showError(`Profile not found: ${profileName}`);
			return;
		}

		const kinds = await this.getProfileResourceKinds();
		const originalResources = profile.resources;
		const isActiveProfile = this.settingsManager.getActiveResourceProfileNames().includes(profile.name);

		this.ui.showSelector((done) => {
			const editor = new ProfileResourceEditorComponent({
				profileName: profile!.name,
				profileScope: currentScope,
				initialResources: profile!.resources,
				kinds,
				cwd: this.sessionManager.getCwd(),
				agentDir: getAgentDir(),
				externalResourceRoots: this.settingsManager.getExternalResourceRoots(),
				onSave: (resources) => {
					done();
					void this.saveProfileResources(profile, originalResources, resources, currentScope, isActiveProfile);
				},
				onCancel: () => {
					done();
					void this.openLibraryManagerFlow();
				},
				onScopeChange: () => {
					done();
					void this.promptScopeChangeForProfile(profileName, currentScope);
				},
				onEdit: async (id, pathValue, kind) => {
					done();
					const resolvedEditPath = resolveResourceEditPath(id, pathValue, kind);
					if (!resolvedEditPath) {
						this.ui.showWarning(`Resource "${id}" of kind "${kind}" has no editable file path.`);
						void this.openLibraryEditorForProfile(profileName, currentScope);
						return;
					}
					if (!fs.existsSync(resolvedEditPath)) {
						this.ui.showError(`Resolved path for "${id}" does not exist: ${resolvedEditPath}`);
						void this.openLibraryEditorForProfile(profileName, currentScope);
						return;
					}
					await this.ui.openEditorForPath(resolvedEditPath);
					await this.ui.handleReloadCommand();
					void this.openLibraryEditorForProfile(profileName, currentScope);
				},
			});

			return { component: editor, focus: editor };
		});
	}

	private async saveProfileResources(
		profile: NormalizedProfile,
		originalResources: NormalizedProfile["resources"],
		resources: NormalizedProfile["resources"],
		scope: WritableProfileScope,
		isActiveProfile: boolean,
		runtimeMetadataChanged = false,
	): Promise<void> {
		const definition = {
			name: profile.name,
			description: profile.description,
			model: profile.model,
			thinking: profile.thinking,
			modelRouter: profile.modelRouter,
			soul: profile.soul,
			resources,
		};
		const changedKinds = resourceProfileSettingsChangedKinds(originalResources, resources);
		if (!isActiveProfile || (changedKinds.size === 0 && !runtimeMetadataChanged)) {
			try {
				this.settingsManager.setProfileDefinition(profile.name, definition, scope);
				this.ui.showStatus(`Saved profile "${profile.name}" to ${scope}.`);
				this.ui.requestRender();
			} catch (error) {
				this.ui.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		const settingsSnapshot = this.settingsManager.createReloadSnapshot();
		const profilesDir = path.join(getAgentDir(), "profiles");
		const profileFilesSnapshot = scope === "reusable-file" ? captureProfileFiles(profilesDir) : undefined;
		let stagedRuntimeApplied = false;
		try {
			// Validate the edited authority surface as a session overlay first. Persistent scopes are
			// written only after the complete runtime generation passes its reload doctor.
			this.settingsManager.setProfileDefinition(profile.name, definition, "session");
			if (!(await this.ui.handleReloadCommand())) {
				this.settingsManager.restoreReloadSnapshot(settingsSnapshot);
				return;
			}
			stagedRuntimeApplied = true;

			if (scope !== "session") {
				this.settingsManager.setProfileDefinition(profile.name, definition, scope);
				await this.settingsManager.flush();
				// Drop the validation-only inline winner, then refresh the registry from the now-validated
				// persistent definition. The live runtime already represents the same profile definition.
				this.settingsManager.restoreReloadSnapshot(settingsSnapshot);
				await this.settingsManager.reload();
			}

			const active = this.settingsManager.getActiveResourceProfileNames()[0] ?? "(none)";
			this.ui.footerDataProvider.setExtensionStatus("profile", active);
			this.ui.invalidateFooter();
			this.ui.updateEditorBorderColor();
			this.ui.showStatus(`Saved profile "${profile.name}" to ${scope}.`);
		} catch (error) {
			const rollbackError = stagedRuntimeApplied
				? await this.rollbackValidatedProfileMutation(settingsSnapshot, {
						profileName: profile.name,
						scope,
						profileFilesSnapshot,
					})
				: undefined;
			if (!stagedRuntimeApplied) this.settingsManager.restoreReloadSnapshot(settingsSnapshot);
			const message = error instanceof Error ? error.message : String(error);
			this.ui.showError(
				rollbackError
					? `${message}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
					: message,
			);
		}
	}

	private async rollbackValidatedProfileMutation(
		settingsSnapshot: SettingsReloadSnapshot,
		definition?: ProfileDefinitionRollbackTarget,
	): Promise<unknown> {
		const errors: string[] = [];
		try {
			if (definition?.scope === "reusable-file") {
				restoreProfileFiles(path.join(getAgentDir(), "profiles"), definition.profileFilesSnapshot!);
			} else if (definition && definition.scope !== "session") {
				this.settingsManager.restoreProfileDefinitionFromReloadSnapshot(
					definition.profileName,
					definition.scope,
					settingsSnapshot,
				);
			}
			const global = settingsSnapshot.globalSettings;
			this.settingsManager.replaceGlobalResourceProfileConfiguration({
				resourceProfiles: global.resourceProfiles,
				activeResourceProfile: global.activeResourceProfile,
				activeResourceProfiles: global.activeResourceProfiles,
				externalResourceRoots: global.externalResourceRoots,
				trustedResourceRoots: global.trustedResourceRoots,
			});
			await this.settingsManager.flush();
		} catch (error) {
			errors.push(`persistence: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.settingsManager.restoreReloadSnapshot(settingsSnapshot);
		try {
			if (!(await this.ui.handleReloadCommand())) {
				errors.push("runtime: the previous profile runtime could not be restored");
			}
		} catch (error) {
			errors.push(`runtime: ${error instanceof Error ? error.message : String(error)}`);
		}
		return errors.length > 0 ? new Error(errors.join("; ")) : undefined;
	}

	private async promptScopeChangeForProfile(
		profileName: string,
		currentScope: "session" | "directory" | "project" | "global" | "reusable-file",
	): Promise<void> {
		const scopeOptions = [
			{ value: "session", label: "session", description: "Runtime only (not written to disk)" },
			{
				value: "directory",
				label: "directory",
				description: "~/.pi/agent/resource-profiles/<hash>/settings.json",
			},
			{ value: "project", label: "project", description: ".pi/settings.json" },
			{ value: "global", label: "global", description: "~/.pi/agent/settings.json" },
		];

		this.ui.showSelector((done) => {
			const selector = new SelectSubmenu(
				"Change Profile / Situation Scope",
				`Select new scope for profile/situation "${profileName}".`,
				scopeOptions,
				currentScope,
				(value) => {
					done();
					void this.openLibraryEditorForProfile(profileName, value as any);
				},
				() => {
					done();
					void this.openLibraryEditorForProfile(profileName, currentScope);
				},
			);
			return { component: selector, focus: selector.getSelectList() };
		});
	}

	async handleProfilesCommand(profileName?: string): Promise<void> {
		if (profileName) {
			await this.applyProfile(profileName);
			return;
		}

		const registry = this.settingsManager.getProfileRegistry();
		const profiles = registry.listProfiles();
		if (profiles.length === 0) {
			this.ui.showWarning(
				"No profiles found. Add resourceProfiles to settings or JSON files under ~/.pi/agent/profiles/.",
			);
			return;
		}

		this.ui.showSelector((done) => {
			const selector = new ProfileSelectorComponent(
				profiles,
				this.settingsManager.getActiveResourceProfileNames(),
				(profile) => {
					done();
					void this.applyProfile(profile);
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector.getSelectList() };
		});
	}

	private async applyProfile(profileName: string): Promise<void> {
		const normalizedName = profileName.trim();
		const normalizedLower = normalizedName.toLowerCase();
		if (normalizedName.length === 0 || normalizedLower === "none" || normalizedLower === "(none)") {
			const settingsSnapshot = this.settingsManager.createReloadSnapshot();
			let stagedRuntimeApplied = false;
			try {
				this.settingsManager.setRuntimeResourceProfiles([]);
				if (!(await this.ui.handleReloadCommand())) {
					this.settingsManager.restoreReloadSnapshot(settingsSnapshot);
					return;
				}
				stagedRuntimeApplied = true;
				// Persist only after the new runtime generation passes its reload doctor.
				this.settingsManager.setActiveProfile(undefined, "global");
				await this.settingsManager.flush();
				this.session.sessionManager.appendCustomEntry("pi.activeResourceProfiles", {
					profiles: [],
				});
				const activeProfileName = this.settingsManager.getActiveResourceProfileNames()[0] ?? "(none)";
				this.ui.footerDataProvider.setExtensionStatus("profile", activeProfileName);
				this.ui.invalidateFooter();
				this.ui.updateEditorBorderColor();
				this.ui.showStatus(`Profile: ${activeProfileName}`);
			} catch (error) {
				const rollbackError = stagedRuntimeApplied
					? await this.rollbackValidatedProfileMutation(settingsSnapshot)
					: undefined;
				if (!stagedRuntimeApplied) this.settingsManager.restoreReloadSnapshot(settingsSnapshot);
				const message = error instanceof Error ? error.message : String(error);
				this.ui.showError(
					rollbackError
						? `${message}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
						: message,
				);
			}
			return;
		}

		const registry = this.settingsManager.getProfileRegistry();
		const profile =
			normalizedName.startsWith("./") || normalizedName.startsWith("../")
				? registry.resolveProfileRef(normalizedName, this.sessionManager.getCwd())
				: registry.getProfile(normalizedName);
		if (!profile) {
			this.ui.showError(`Profile not found: ${profileName}`);
			return;
		}

		const settingsSnapshot = this.settingsManager.createReloadSnapshot();
		const modelRegistrySnapshot = profile.model ? this.session.modelRegistry.createReloadSnapshot() : undefined;
		let stagedRuntimeApplied = false;
		try {
			const activeProfileRef =
				normalizedName.startsWith("./") || normalizedName.startsWith("../") ? normalizedName : profile.name;
			let requestedModel: Model<Api> | undefined;
			if (profile.model) {
				this.session.modelRegistry.refresh();
				const resolved = resolveCliModel({ cliModel: profile.model, modelRegistry: this.session.modelRegistry });
				// The profile may grant an extension that contributes this model. The current generation
				// cannot validate that case; the atomic reload binds new providers before authoritative
				// profile resolution and rolls back if the model is still unresolved.
				if (!resolved.error && resolved.warning) {
					this.ui.showWarning(resolved.warning);
				}
				if (!resolved.error) requestedModel = resolved.model;
			}

			// Stage the complete situation in memory. Runtime reload applies model/thinking, resource
			// grants, extensions, skills, prompts, and soul together; explicit launch overrides still win.
			this.settingsManager.setRuntimeResourceProfiles([activeProfileRef]);
			if (!(await this.ui.handleReloadCommand())) {
				this.settingsManager.restoreReloadSnapshot(settingsSnapshot);
				if (modelRegistrySnapshot) this.session.modelRegistry.restoreReloadSnapshot(modelRegistrySnapshot);
				return;
			}
			stagedRuntimeApplied = true;

			// Selection survives restarts only after the new runtime generation passes its reload doctor.
			this.settingsManager.setActiveProfile(activeProfileRef, "global");
			await this.settingsManager.flush();
			this.session.sessionManager.appendCustomEntry("pi.activeResourceProfiles", {
				profiles: [activeProfileRef],
			});
			this.ui.footerDataProvider.setExtensionStatus("profile", profile.name);
			this.ui.invalidateFooter();
			this.ui.updateEditorBorderColor();
			this.ui.showStatus(`Profile: ${profile.name}`);
			if (
				requestedModel &&
				this.session.model?.provider === requestedModel.provider &&
				this.session.model.id === requestedModel.id
			) {
				void this.ui.maybeWarnAboutAnthropicSubscriptionAuth(requestedModel);
				this.ui.checkDaxnutsEasterEgg(requestedModel);
			}
		} catch (error) {
			const rollbackError = stagedRuntimeApplied
				? await this.rollbackValidatedProfileMutation(settingsSnapshot)
				: undefined;
			if (!stagedRuntimeApplied) this.settingsManager.restoreReloadSnapshot(settingsSnapshot);
			if (modelRegistrySnapshot) this.session.modelRegistry.restoreReloadSnapshot(modelRegistrySnapshot);
			const message = error instanceof Error ? error.message : String(error);
			this.ui.showError(
				rollbackError
					? `${message}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
					: message,
			);
		}
	}

	/** Map where a profile currently lives to the scope we should write it back to. */
	private scopeForProfileSource(source: string): WritableProfileScope {
		switch (source) {
			case "profile-file":
				return "reusable-file";
			case "directory-overlay":
			case "embedded":
				return "directory";
			case "project-settings":
				return "project";
			case "inline":
				return "session";
			default:
				return "global";
		}
	}

	async refreshAfterProfileMutation(profileName: string): Promise<void> {
		if (this.settingsManager.getActiveResourceProfileNames().includes(profileName)) {
			if (!(await this.ui.handleReloadCommand())) return;
			const active = this.settingsManager.getActiveResourceProfileNames()[0] ?? "(none)";
			this.ui.footerDataProvider.setExtensionStatus("profile", active);
			this.ui.invalidateFooter();
			this.ui.updateEditorBorderColor();
		}
	}

	private async createProfileFlow(): Promise<void> {
		const name = await new Promise<string | undefined>((resolve) => {
			this.ui.showSelector((done) => {
				const input = new ExtensionInputComponent(
					"Create Profile / Situation",
					"Enter profile/situation name",
					(value) => {
						done();
						resolve(value);
					},
					() => {
						done();
						resolve(undefined);
					},
					{ tui: this.ui.tui },
				);
				return { component: input, focus: input, onSuperseded: () => resolve(undefined) };
			});
		});

		if (name === undefined) {
			this.ui.requestRender();
			return;
		}

		const trimmed = name.trim();
		if (!trimmed) {
			this.ui.showError("Profile/situation name cannot be empty");
			return this.createProfileFlow();
		}

		// Validate name rules using validateSkillName
		const errors = validateSkillName(trimmed);
		if (errors.length > 0) {
			this.ui.showError(`Invalid profile/situation name: ${errors.join(", ")}`);
			return this.createProfileFlow();
		}

		// Collision check
		const existing = this.settingsManager.getProfileRegistry().getProfile(trimmed);
		if (existing) {
			this.ui.showError(`Profile/situation "${trimmed}" already exists`);
			return this.createProfileFlow();
		}

		const profileModel = await this.selectProfileModel();
		if (profileModel === undefined) {
			this.ui.requestRender();
			return;
		}

		// Open the resource editor on the NEW profile
		void this.openNewProfileEditor(trimmed, profileModel ?? undefined);
	}

	private async selectProfileModel(profileModel?: string): Promise<string | null | undefined> {
		const inheritValue = "(inherit)";
		const availableModelOptions = [...this.ui.getAutoLearnModelOptions()];
		if (profileModel && !availableModelOptions.some((option) => option.value === profileModel)) {
			availableModelOptions.unshift({
				value: profileModel,
				label: profileModel,
				description: "Current profile model (not currently available)",
			});
		}
		const modelOptions = [
			{
				value: inheritValue,
				label: "Inherit session/default model",
				description: "Remove the profile model pin and use the current session/default model",
			},
			...availableModelOptions,
		];

		return await new Promise<string | null | undefined>((resolve) => {
			this.ui.showSelector((done) => {
				const selector = new SelectSubmenu(
					"Profile Model",
					"Pin a foreground model for this profile or inherit the session/default model.",
					modelOptions,
					profileModel ?? inheritValue,
					(value) => {
						done();
						resolve(value === inheritValue ? null : value);
					},
					() => {
						done();
						resolve(undefined);
					},
				);
				return {
					component: selector,
					focus: selector.getSelectList(),
					onSuperseded: () => resolve(undefined),
				};
			});
		});
	}

	private async openNewProfileEditor(profileName: string, profileModel?: string): Promise<void> {
		const scope = "reusable-file";
		const kinds = await this.getProfileResourceKinds();
		this.ui.showSelector((done) => {
			const editor = new ProfileResourceEditorComponent({
				profileName,
				profileScope: scope,
				initialResources: {},
				kinds,
				cwd: this.sessionManager.getCwd(),
				agentDir: getAgentDir(),
				externalResourceRoots: this.settingsManager.getExternalResourceRoots(),
				onSave: (resources) => {
					done();
					try {
						this.settingsManager.setProfileDefinition(
							profileName,
							{
								name: profileName,
								model: profileModel,
								resources,
							},
							scope,
						);
						this.ui.showStatus(`Saved profile "${profileName}" to ${scope}.`);
						this.ui.requestRender();
					} catch (error) {
						this.ui.showError(error instanceof Error ? error.message : String(error));
					}
				},
				onCancel: () => {
					done();
					this.ui.requestRender();
				},
				onEdit: async (id, pathValue, kind) => {
					done();
					const resolvedEditPath = resolveResourceEditPath(id, pathValue, kind);
					if (!resolvedEditPath) {
						this.ui.showWarning(`Resource "${id}" of kind "${kind}" has no editable file path.`);
						void this.openNewProfileEditor(profileName, profileModel);
						return;
					}
					if (!fs.existsSync(resolvedEditPath)) {
						this.ui.showError(`Resolved path for "${id}" does not exist: ${resolvedEditPath}`);
						void this.openNewProfileEditor(profileName, profileModel);
						return;
					}
					await this.ui.openEditorForPath(resolvedEditPath);
					await this.ui.handleReloadCommand();
					void this.openNewProfileEditor(profileName, profileModel);
				},
			});
			return { component: editor, focus: editor };
		});
	}

	private persistActiveProfile(scope: "session" | "directory" | "project" | "global"): void {
		const active = this.settingsManager.getActiveResourceProfileNames()[0];
		if (!active) {
			this.ui.showError("No active profile to persist. Select one with /profiles first.");
			return;
		}
		try {
			if (scope === "session") {
				this.settingsManager.setRuntimeResourceProfiles([active]);
			} else {
				this.settingsManager.setActiveProfile(active, scope);
			}
			this.ui.showStatus(`Active profile "${active}" persisted to ${scope}.`);
		} catch (error) {
			this.ui.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async deleteProfileFromSource(profileName: string): Promise<void> {
		const registry = this.settingsManager.getProfileRegistry();
		const profile = registry.getProfile(profileName);
		if (!profile) {
			this.ui.showError(`Profile not found: ${profileName}`);
			return;
		}
		const scope = deletionScopeForProfile(profile);
		if (!scope) {
			const location = profile.sourcePath ? ` at ${profile.sourcePath}` : "";
			this.ui.showError(
				`Profile "${profileName}" comes from read-only source ${profile.source}${location}; edit or remove that source definition directly.`,
			);
			return;
		}
		const wasActive = this.settingsManager.getActiveResourceProfileNames().some((profileRef) => {
			if (profileRef === profileName || profileRef === profile.name) return true;
			const activeProfile =
				profileRef.startsWith("./") || profileRef.startsWith("../")
					? registry.resolveProfileRef(profileRef, this.sessionManager.getCwd())
					: registry.getProfile(profileRef);
			return Boolean(
				activeProfile && activeProfile.name === profile.name && activeProfile.sourcePath === profile.sourcePath,
			);
		});
		const settingsSnapshot = this.settingsManager.createReloadSnapshot();
		const profileFilesSnapshot =
			scope === "reusable-file" ? captureProfileFiles(path.join(getAgentDir(), "profiles")) : undefined;
		let switchedToNone = false;
		try {
			if (wasActive) {
				// Stage an explicit empty runtime selection while the definition is still intact. The
				// full reload can now remove the profile's extensions, tools, providers, model, and
				// memory generation atomically. Persisting the deletion is deliberately deferred until
				// that generation passes its doctor, so a failed reload has no on-disk deletion to undo.
				this.settingsManager.setRuntimeResourceProfiles([]);
				if (!(await this.ui.handleReloadCommand())) {
					this.settingsManager.restoreReloadSnapshot(settingsSnapshot);
					return;
				}
				switchedToNone = true;
			}

			this.settingsManager.deleteProfile(profileName, scope);
			const remaining = this.settingsManager.getProfileRegistry().getProfile(profileName);
			if (remaining && remaining.source === profile.source && remaining.sourcePath === profile.sourcePath) {
				throw new Error(`Profile "${profileName}" was not removed from ${profile.source}.`);
			}
			if (wasActive) {
				this.settingsManager.setActiveProfile(undefined, "global");
				await this.settingsManager.flush();
				this.session.sessionManager.appendCustomEntry("pi.activeResourceProfiles", { profiles: [] });
				this.ui.footerDataProvider.setExtensionStatus("profile", "(none)");
				this.ui.invalidateFooter();
				this.ui.updateEditorBorderColor();
			}
			this.ui.showStatus(`Deleted profile "${profileName}" from ${scope}.`);
		} catch (error) {
			const rollbackError = switchedToNone
				? await this.rollbackValidatedProfileMutation(settingsSnapshot, {
						profileName,
						scope,
						profileFilesSnapshot,
					})
				: undefined;
			if (!switchedToNone) this.settingsManager.restoreReloadSnapshot(settingsSnapshot);
			const message = error instanceof Error ? error.message : String(error);
			this.ui.showError(
				rollbackError
					? `${message}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
					: message,
			);
		}
	}

	private async addExternalResourceRootFlow(): Promise<void> {
		const rootPath = await new Promise<string | undefined>((resolve) => {
			this.ui.showSelector((done) => {
				const input = new ExtensionInputComponent(
					"Add External Root",
					"Enter external root directory path",
					(value) => {
						done();
						resolve(value);
					},
					() => {
						done();
						resolve(undefined);
					},
					{ tui: this.ui.tui },
				);
				return { component: input, focus: input, onSuperseded: () => resolve(undefined) };
			});
		});

		if (rootPath === undefined) {
			this.ui.requestRender();
			return;
		}

		const trimmed = rootPath.trim();
		if (!trimmed) {
			this.ui.showError("Directory path cannot be empty");
			return;
		}

		const canonical = this.settingsManager.canonicalizePath(trimmed);
		if (!canonical) {
			this.ui.showError(`Invalid path: ${trimmed}`);
			return;
		}

		// Prompt for trust confirmation (Yes/No)
		const trust = await new Promise<boolean>((resolve) => {
			this.ui.showSelector((done) => {
				const submenu = new SelectSubmenu(
					"Trust external source?",
					"This directory can load custom extensions that execute arbitrary code on your machine.",
					[
						{ value: "yes", label: "Yes", description: "Trust this directory and enable loading resources." },
						{ value: "no", label: "No", description: "Do not trust this directory. Skip loading resources." },
					],
					"no",
					(value) => {
						done();
						resolve(value === "yes");
					},
					() => {
						done();
						resolve(false);
					},
				);
				return {
					component: submenu,
					focus: submenu.getSelectList(),
					onSuperseded: () => resolve(false),
				};
			});
		});

		if (!trust) {
			this.ui.showStatus("Aborted. External root was not trusted.");
			return;
		}

		try {
			const currentRoots = this.settingsManager.getExternalResourceRoots();
			if (!currentRoots.includes(canonical)) {
				this.settingsManager.setExternalResourceRoots([...currentRoots, canonical], "global");
			}
			this.settingsManager.addTrustedResourceRoot(canonical, "global");
			this.ui.showStatus(`Added trusted external root: ${canonical}`);
			await this.ui.handleReloadCommand();
		} catch (error) {
			this.ui.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async removeExternalResourceRootFlow(root: string): Promise<void> {
		try {
			const currentRoots = this.settingsManager.getExternalResourceRoots();
			const currentTrusted = this.settingsManager.getTrustedResourceRoots();

			const newRoots = currentRoots.filter((r) => r !== root);
			const newTrusted = currentTrusted.filter((r) => r !== root);

			this.settingsManager.setExternalResourceRoots(newRoots, "global");
			this.settingsManager.setTrustedResourceRoots(newTrusted, "global");

			this.ui.showStatus(`Removed external root: ${root}`);
			await this.ui.handleReloadCommand();
		} catch (error) {
			this.ui.showError(error instanceof Error ? error.message : String(error));
		}
	}
}
