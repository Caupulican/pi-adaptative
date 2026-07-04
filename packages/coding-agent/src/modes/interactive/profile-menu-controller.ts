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
import type { Model } from "@caupulican/pi-ai";
import type { Component, SelectItem, TUI } from "@caupulican/pi-tui";
import { getAgentDir } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { resolveCliModel } from "../../core/model-resolver.ts";
import { resourceProfileSettingsChangedKinds } from "../../core/resource-profile-equality.ts";
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
import { getAvailableThemesWithPaths } from "./theme/theme.ts";

export interface ProfileMenuControllerUi {
	showSelector(create: (done: () => void) => { component: Component; focus: Component }): void;
	showStatus(message: string): void;
	showError(message: string): void;
	showWarning(message: string): void;
	requestRender(): void;
	readonly tui: TUI;
	readonly footerDataProvider: { setExtensionStatus(key: string, text: string | undefined): void };
	invalidateFooter(): void;
	updateEditorBorderColor(): void;
	openEditorForPath(filePath: string): Promise<boolean>;
	handleReloadCommand(): Promise<void>;
	reconcileExtensionsAndRefreshUI(profileName: string): Promise<void>;
	maybeWarnAboutAnthropicSubscriptionAuth(model?: Model<any>): void;
	checkDaxnutsEasterEgg(model: { provider: string; id: string }): void;
	showSettingsSelector(): void;
	getAutoLearnModelOptions(): SelectItem[];
}

export interface ProfileMenuControllerDeps {
	getSession(): AgentSession;
	ui: ProfileMenuControllerUi;
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
			{ value: "(none)", label: "(none)", description: "No active profile/situation (all resources enabled)" },
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
				"Create, delete, or persist profile/situation definitions.",
				options,
				"",
				(value) => {
					done();
					if (value === "create") {
						void this.createProfileFlow().then(() => {
							void this.ui.showSettingsSelector();
						});
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
					this.deleteProfileFromSource(value);
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
				return { component: input, focus: input };
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
			const profileModel = await this.selectProfileModelForCreate();
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
				"directory",
			);
			await this.applyProfile(trimmed);
			void this.openLibraryEditorForProfile(trimmed, "directory");
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
		const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
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
				items: allDiscoverableExtensions.map((e) => ({
					id: base(e),
					path: e,
					description: getExtensionDescription(e),
				})),
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
					try {
						this.settingsManager.setProfileDefinition(
							profileName,
							{
								name: profileName,
								description: profile!.description,
								model: profile!.model,
								thinking: profile!.thinking,
								resources,
							},
							currentScope,
						);
						this.ui.showStatus(`Saved profile "${profileName}" to ${currentScope}.`);
						if (isActiveProfile) {
							const changedKinds = resourceProfileSettingsChangedKinds(originalResources, resources);
							if (changedKinds.size === 1 && changedKinds.has("extensions")) {
								void this.ui.reconcileExtensionsAndRefreshUI(profileName);
							} else if (changedKinds.size > 0) {
								void this.refreshAfterProfileMutation(profileName);
							} else {
								this.ui.requestRender();
							}
						}
					} catch (error) {
						this.ui.showError(error instanceof Error ? error.message : String(error));
					}
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
			try {
				this.settingsManager.setRuntimeResourceProfiles([]);
				// Clearing must also survive restarts (otherwise the old global selection returns).
				this.settingsManager.setActiveProfile(undefined, "global");
				this.session.sessionManager.appendCustomEntry("pi.activeResourceProfiles", {
					profiles: [],
				});
				await this.ui.handleReloadCommand();
				const activeProfileName = this.settingsManager.getActiveResourceProfileNames()[0] ?? "(none)";
				this.ui.footerDataProvider.setExtensionStatus("profile", activeProfileName);
				this.ui.invalidateFooter();
				this.ui.updateEditorBorderColor();
				this.ui.showStatus(`Profile: ${activeProfileName}`);
			} catch (error) {
				this.ui.showError(error instanceof Error ? error.message : String(error));
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

		try {
			let appliedModel: Model<any> | undefined;
			if (profile.model) {
				this.session.modelRegistry.refresh();
				const resolved = resolveCliModel({ cliModel: profile.model, modelRegistry: this.session.modelRegistry });
				if (resolved.error) {
					this.ui.showError(resolved.error);
					return;
				}
				if (resolved.warning) {
					this.ui.showWarning(resolved.warning);
				}
				if (resolved.model) {
					await this.session.setModel(resolved.model, { persistSettings: false });
					appliedModel = resolved.model;
				}
				if (resolved.thinkingLevel && !profile.thinking) {
					this.session.setThinkingLevel(resolved.thinkingLevel, { persistSettings: false });
				}
			}
			if (profile.thinking) {
				this.session.setThinkingLevel(profile.thinking, { persistSettings: false });
			}
			this.settingsManager.setRuntimeResourceProfiles([profile.name]);
			// Selection must survive pi restarts: persist globally (like model/theme selections).
			// Runtime + session-entry alone made every /profile choice evaporate on exit.
			this.settingsManager.setActiveProfile(profile.name, "global");
			this.session.sessionManager.appendCustomEntry("pi.activeResourceProfiles", {
				profiles: [profile.name],
			});
			await this.ui.handleReloadCommand();
			this.ui.footerDataProvider.setExtensionStatus("profile", profile.name);
			this.ui.invalidateFooter();
			this.ui.updateEditorBorderColor();
			this.ui.showStatus(`Profile: ${profile.name}`);
			if (appliedModel) {
				void this.ui.maybeWarnAboutAnthropicSubscriptionAuth(appliedModel);
				this.ui.checkDaxnutsEasterEgg(appliedModel);
			}
		} catch (error) {
			this.ui.showError(error instanceof Error ? error.message : String(error));
		}
	}

	/** Map where a profile currently lives to the scope we should write it back to. */
	private scopeForProfileSource(source: string): "session" | "directory" | "project" | "global" | "reusable-file" {
		switch (source) {
			case "profile-file":
				return "reusable-file";
			case "directory-overlay":
			case "embedded":
				return "directory";
			case "inline":
				return "session";
			default:
				return "global"; // "settings"
		}
	}

	async refreshAfterProfileMutation(profileName: string): Promise<void> {
		if (this.settingsManager.getActiveResourceProfileNames().includes(profileName)) {
			await this.ui.handleReloadCommand();
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
				return { component: input, focus: input };
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

		const profileModel = await this.selectProfileModelForCreate();
		if (profileModel === undefined) {
			this.ui.requestRender();
			return;
		}

		// Open the resource editor on the NEW profile
		void this.openNewProfileEditor(trimmed, profileModel ?? undefined);
	}

	private async selectProfileModelForCreate(): Promise<string | null | undefined> {
		const modelOptions = [
			{
				value: "(none)",
				label: "(none)",
				description: "Do not pin a foreground profile model; use the session/default model",
			},
			...this.ui.getAutoLearnModelOptions(),
		];

		return await new Promise<string | null | undefined>((resolve) => {
			this.ui.showSelector((done) => {
				const selector = new SelectSubmenu(
					"Profile Model",
					"Pick the foreground model for this profile from authenticated/configured providers.",
					modelOptions,
					"(none)",
					(value) => {
						done();
						resolve(value === "(none)" ? null : value);
					},
					() => {
						done();
						resolve(undefined);
					},
				);
				return { component: selector, focus: selector.getSelectList() };
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

	private deleteProfileFromSource(profileName: string): void {
		const profile = this.settingsManager.getProfileRegistry().getProfile(profileName);
		if (!profile) {
			this.ui.showError(`Profile not found: ${profileName}`);
			return;
		}
		const scope = this.scopeForProfileSource(profile.source);
		try {
			this.settingsManager.deleteProfile(profileName, scope);
			this.ui.showStatus(`Deleted profile "${profileName}" from ${scope}.`);
			void this.refreshAfterProfileMutation(profileName);
		} catch (error) {
			this.ui.showError(error instanceof Error ? error.message : String(error));
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
				return { component: input, focus: input };
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
				return { component: submenu, focus: submenu.getSelectList() };
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
