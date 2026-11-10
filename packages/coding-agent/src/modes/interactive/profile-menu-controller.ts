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
import { getAgentDir, getProfilesDir } from "../../config.ts";
import { interfaceText } from "../../core/language/interface-text.ts";
import { resolveCliModel } from "../../core/model-resolver.ts";
import type { NormalizedProfile } from "../../core/profile-registry.ts";
import { resourceProfileSettingsChangedKinds } from "../../core/resource-profile-equality.ts";
import type { ResourceProfileKind, SettingsReloadSnapshot } from "../../core/settings/settings-schema.ts";
import { validateSkillName } from "../../core/skills.ts";
import { ProfileResourceEditorComponent, resolveResourceEditPath } from "./components/profile-resource-editor.ts";
import { ProfileSelectorComponent, profileSourceLabel } from "./components/profile-selector.ts";
import { SelectSubmenu } from "./components/settings-selector.ts";
import { captureProfileFiles, restoreProfileFiles } from "./config-backup.ts";
import { confirmExternalResourceTrust, promptForTextInput } from "./interactive-selection-prompts.ts";
import type { LiveSessionServices } from "./live-session.ts";
import { profileResourceKinds } from "./profile-resource-kinds.ts";

type WritableProfileScope = "session" | "directory" | "project" | "global" | "reusable-file";

/** The scopes a profile can be written to; the scope's own id is the value the code saves with. */
const PROFILE_SCOPES = ["session", "directory", "project", "global"] as const;

/** Where a profile can be written, as the owner reads it. */
function profileScopeOptions(): SelectItem[] {
	const scopes = interfaceText().profilesScreen.menu.scopes;
	return PROFILE_SCOPES.map((scope) => ({
		value: scope,
		label: scopes[scope].label,
		description: scopes[scope].description,
	}));
}

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
			const localProfilePath = path.resolve(getProfilesDir(), `${profile.name}.json`);
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

function profileSelectionItems(profiles: NormalizedProfile[]): SelectItem[] {
	return profiles.map((profile) => ({
		value: profile.name,
		label: profile.name,
		description: profile.description || profileSourceLabel(profile),
	}));
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

export interface ProfileMenuControllerDeps extends LiveSessionServices {
	ui: ProfileMenuControllerUi;
}

export class ProfileMenuController {
	private readonly deps: ProfileMenuControllerDeps;

	constructor(deps: ProfileMenuControllerDeps) {
		this.deps = deps;
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
		const registry = this.deps.getSettingsManager().getProfileRegistry();
		const profiles = registry.listProfiles();
		const activeNames = this.deps.getSettingsManager().getActiveResourceProfileNames();

		const text = interfaceText().profilesScreen.menu;
		const options = [
			{ value: "(none)", label: text.noneLabel, description: text.noActiveProfile },
			...profileSelectionItems(profiles),
		];

		this.ui.showSelector((done) => {
			const selector = new SelectSubmenu(
				text.activeTitle,
				text.activeDescription,
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
		const registry = this.deps.getSettingsManager().getProfileRegistry();
		const profiles = registry.listProfiles();
		const editableProfiles = profileSelectionItems(profiles);

		const text = interfaceText().profilesScreen.menu;
		const options = [
			{
				value: "create",
				label: text.createProfile.label,
				description: text.createProfile.description,
			},
		];

		if (editableProfiles.length > 0) {
			options.push({
				value: "edit-model",
				label: text.editModel.label,
				description: text.editModel.description,
			});
		}

		if (this.deps.getSettingsManager().getActiveResourceProfileNames().length > 0) {
			options.push({
				value: "persist",
				label: text.persistTo.label,
				description: text.persistTo.description,
			});
		}

		if (editableProfiles.length > 0) {
			options.push({
				value: "delete",
				label: text.deleteProfile.label,
				description: text.deleteProfile.description,
			});
		}

		this.ui.showSelector((done) => {
			const selector = new SelectSubmenu(
				text.manageTitle,
				text.manageDescription,
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
		const profiles = this.deps
			.getSettingsManager()
			.getProfileRegistry()
			.listProfiles()
			.filter((profile) => deletionScopeForProfile(profile) !== undefined);
		if (profiles.length === 0) {
			this.ui.showStatus(interfaceText().profilesScreen.menu.noWritable);
			return;
		}
		const activeNames = this.deps.getSettingsManager().getActiveResourceProfileNames();
		const initialValue = profiles.find((profile) => activeNames.includes(profile.name))?.name ?? profiles[0].name;
		const text = interfaceText().profilesScreen.menu;
		const items = profiles.map((profile) => ({
			value: profile.name,
			label: profile.name,
			description: text.profileItemDescription(
				profile.model ? text.pinned(profile.model) : text.inherits,
				profile.description || profileSourceLabel(profile),
			),
		}));

		this.ui.showSelector((done) => {
			const selector = new SelectSubmenu(
				text.editModelTitle,
				text.editModelDescription,
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
		const text = interfaceText().profilesScreen.menu;
		const profile = this.deps.getSettingsManager().getProfileRegistry().getProfile(profileName);
		if (!profile) {
			this.ui.showError(text.profileGone(profileName));
			return;
		}
		const scope = deletionScopeForProfile(profile);
		if (!scope) {
			this.ui.showError(text.profileReadOnly(profileName, profileSourceLabel(profile)));
			return;
		}
		const selectedModel = await this.selectProfileModel(profile.model);
		if (selectedModel === undefined) {
			void this.openManageProfilesFlow();
			return;
		}
		const model = selectedModel ?? undefined;
		if (model === profile.model) {
			this.ui.showStatus(text.modelUnchanged(profileName));
			return;
		}
		await this.saveProfileResources(
			{ ...profile, model },
			profile.resources,
			profile.resources,
			scope,
			this.deps.getSettingsManager().getActiveResourceProfileNames().includes(profile.name),
			true,
		);
	}

	private async openPersistProfileSelector(): Promise<void> {
		const text = interfaceText().profilesScreen.menu;
		this.ui.showSelector((done) => {
			const selector = new SelectSubmenu(
				text.persistTitle,
				text.persistDescription,
				profileScopeOptions(),
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
		const registry = this.deps.getSettingsManager().getProfileRegistry();
		const editableProfiles = profileSelectionItems(registry.listProfiles());
		const text = interfaceText().profilesScreen.menu;

		this.ui.showSelector((done) => {
			const selector = new SelectSubmenu(
				text.deleteTitle,
				text.deleteDescription,
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
		const externalRoots = this.deps.getSettingsManager().getExternalResourceRoots();
		const trustedRoots = this.deps.getSettingsManager().getTrustedResourceRoots();
		const text = interfaceText().profilesScreen.menu;

		const options = [
			{
				value: "add",
				label: text.addRoot.label,
				description: text.addRoot.description,
			},
		];

		for (const r of externalRoots) {
			const isTrusted = trustedRoots.includes(r);
			options.push({
				value: `remove:${r}`,
				label: text.removeRoot(r),
				description: isTrusted ? text.trustedRoot : text.untrustedRoot,
			});
		}

		this.ui.showSelector((done) => {
			const selector = new SelectSubmenu(
				text.sourcesTitle,
				text.sourcesDescription,
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
		const activeNames = this.deps.getSettingsManager().getActiveResourceProfileNames();
		const activeName = activeNames[0];

		const text = interfaceText().profilesScreen.menu;
		if (!activeName || activeName === "(none)") {
			this.ui.showSelector((done) => {
				const selector = new SelectSubmenu(
					text.noActiveTitle,
					text.noActiveDescription,
					[
						{
							value: "select",
							label: text.selectExisting.label,
							description: text.selectExisting.description,
						},
						{
							value: "create",
							label: text.createNew.label,
							description: text.createNew.description,
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

		const registry = this.deps.getSettingsManager().getProfileRegistry();
		const profile = registry.getProfile(activeName);
		if (!profile) {
			this.ui.showError(text.activeMissing(activeName));
			return;
		}
		const scope = this.scopeForProfileSource(profile.source);
		void this.openLibraryEditorForProfile(profile.name, scope);
	}

	private async createProfileAndOpenLibraryFlow(): Promise<void> {
		const text = interfaceText().profilesScreen.menu;
		const name = await promptForTextInput(this.ui, text.createTitle, text.createPlaceholder);

		if (name === undefined) {
			void this.openLibraryManagerFlow();
			return;
		}

		const trimmed = name.trim();
		if (!trimmed) {
			this.ui.showWarning(text.nameEmpty);
			void this.openLibraryManagerFlow();
			return;
		}

		try {
			const profileModel = await this.selectProfileModel();
			if (profileModel === undefined) {
				void this.openLibraryManagerFlow();
				return;
			}
			this.deps.getSettingsManager().setProfileDefinition(
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
		const registry = this.deps.getSettingsManager().getProfileRegistry();
		const profiles = registry.listProfiles();
		const editableProfiles = profileSelectionItems(profiles);

		if (editableProfiles.length === 0) {
			this.ui.showWarning(interfaceText().profilesScreen.menu.noExisting);
			void this.createProfileAndOpenLibraryFlow();
			return;
		}

		const selectText = interfaceText().profilesScreen.menu;
		this.ui.showSelector((done) => {
			const selector = new SelectSubmenu(
				selectText.selectTitle,
				selectText.selectDescription,
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

	private async editProfileResource(
		id: string,
		pathValue: string,
		kind: ResourceProfileKind,
		reopen: () => void,
	): Promise<void> {
		const resolvedEditPath = resolveResourceEditPath(id, pathValue, kind);
		if (!resolvedEditPath) {
			this.ui.showWarning(interfaceText().profilesScreen.menu.noEditablePath(id, kind));
			reopen();
			return;
		}
		if (!fs.existsSync(resolvedEditPath)) {
			this.ui.showError(interfaceText().profilesScreen.menu.pathMissing(id, resolvedEditPath));
			reopen();
			return;
		}
		await this.ui.openEditorForPath(resolvedEditPath);
		await this.ui.handleReloadCommand();
		reopen();
	}

	private async openLibraryEditorForProfile(
		profileName: string,
		initialScope: "session" | "directory" | "project" | "global" | "reusable-file",
	): Promise<void> {
		const currentScope = initialScope;
		const registry = this.deps.getSettingsManager().getProfileRegistry();
		const profile = registry.getProfile(profileName);
		if (!profile) {
			this.ui.showError(interfaceText().profilesScreen.menu.profileNotFound(profileName));
			return;
		}

		const kinds = await profileResourceKinds(this.deps.getSession());
		const originalResources = profile.resources;
		const isActiveProfile = this.deps.getSettingsManager().getActiveResourceProfileNames().includes(profile.name);

		this.ui.showSelector((done) => {
			const editor = new ProfileResourceEditorComponent({
				profileName: profile!.name,
				profileScope: currentScope,
				initialResources: profile!.resources,
				kinds,
				cwd: this.deps.getSessionManager().getCwd(),
				agentDir: getAgentDir(),
				externalResourceRoots: this.deps.getSettingsManager().getExternalResourceRoots(),
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
					await this.editProfileResource(id, pathValue, kind, () => {
						void this.openLibraryEditorForProfile(profileName, currentScope);
					});
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
				this.deps.getSettingsManager().setProfileDefinition(profile.name, definition, scope);
				this.ui.showStatus(interfaceText().profilesScreen.menu.savedTo(profile.name, scope));
				this.ui.requestRender();
			} catch (error) {
				this.ui.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		const settingsSnapshot = this.deps.getSettingsManager().createReloadSnapshot();
		const profilesDir = getProfilesDir();
		const profileFilesSnapshot = scope === "reusable-file" ? captureProfileFiles(profilesDir) : undefined;
		let stagedRuntimeApplied = false;
		try {
			// Validate the edited authority surface as a session overlay first. Persistent scopes are
			// written only after the complete runtime generation passes its reload doctor.
			this.deps.getSettingsManager().setProfileDefinition(profile.name, definition, "session");
			if (!(await this.ui.handleReloadCommand())) {
				this.deps.getSettingsManager().restoreReloadSnapshot(settingsSnapshot);
				return;
			}
			stagedRuntimeApplied = true;

			if (scope !== "session") {
				this.deps.getSettingsManager().setProfileDefinition(profile.name, definition, scope);
				await this.deps.getSettingsManager().flush();
				// Drop the validation-only inline winner, then refresh the registry from the now-validated
				// persistent definition. The live runtime already represents the same profile definition.
				this.deps.getSettingsManager().restoreReloadSnapshot(settingsSnapshot);
				await this.deps.getSettingsManager().reload();
			}

			const active = this.deps.getSettingsManager().getActiveResourceProfileNames()[0] ?? "(none)";
			this.ui.footerDataProvider.setExtensionStatus("profile", active);
			this.ui.invalidateFooter();
			this.ui.updateEditorBorderColor();
			this.ui.showStatus(interfaceText().profilesScreen.menu.savedTo(profile.name, scope));
		} catch (error) {
			await this.reportProfileMutationFailure(error, settingsSnapshot, stagedRuntimeApplied, {
				profileName: profile.name,
				scope,
				profileFilesSnapshot,
			});
		}
	}

	private async rollbackValidatedProfileMutation(
		settingsSnapshot: SettingsReloadSnapshot,
		definition?: ProfileDefinitionRollbackTarget,
	): Promise<unknown> {
		const errors: string[] = [];
		try {
			if (definition?.scope === "reusable-file") {
				restoreProfileFiles(getProfilesDir(), definition.profileFilesSnapshot!);
			} else if (definition && definition.scope !== "session") {
				this.deps
					.getSettingsManager()
					.restoreProfileDefinitionFromReloadSnapshot(definition.profileName, definition.scope, settingsSnapshot);
			}
			const global = settingsSnapshot.globalSettings;
			this.deps.getSettingsManager().replaceGlobalResourceProfileConfiguration({
				resourceProfiles: global.resourceProfiles,
				activeResourceProfile: global.activeResourceProfile,
				activeResourceProfiles: global.activeResourceProfiles,
				externalResourceRoots: global.externalResourceRoots,
				trustedResourceRoots: global.trustedResourceRoots,
			});
			await this.deps.getSettingsManager().flush();
		} catch (error) {
			errors.push(
				interfaceText().profilesScreen.menu.rollbackPersistence(
					error instanceof Error ? error.message : String(error),
				),
			);
		}
		this.deps.getSettingsManager().restoreReloadSnapshot(settingsSnapshot);
		try {
			if (!(await this.ui.handleReloadCommand())) {
				errors.push(interfaceText().profilesScreen.menu.rollbackRuntimeUnrestored);
			}
		} catch (error) {
			errors.push(
				interfaceText().profilesScreen.menu.rollbackRuntime(error instanceof Error ? error.message : String(error)),
			);
		}
		return errors.length > 0 ? new Error(errors.join("; ")) : undefined;
	}

	private async reportProfileMutationFailure(
		error: unknown,
		settingsSnapshot: SettingsReloadSnapshot,
		runtimeWasApplied: boolean,
		definition?: ProfileDefinitionRollbackTarget,
		restoreAdditional?: () => void,
	): Promise<void> {
		const rollbackError = runtimeWasApplied
			? await this.rollbackValidatedProfileMutation(settingsSnapshot, definition)
			: undefined;
		if (!runtimeWasApplied) this.deps.getSettingsManager().restoreReloadSnapshot(settingsSnapshot);
		restoreAdditional?.();
		const message = error instanceof Error ? error.message : String(error);
		this.ui.showError(
			rollbackError
				? interfaceText().profilesScreen.menu.rollbackFailed(
						message,
						rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
					)
				: message,
		);
	}

	private async promptScopeChangeForProfile(
		profileName: string,
		currentScope: "session" | "directory" | "project" | "global" | "reusable-file",
	): Promise<void> {
		const text = interfaceText().profilesScreen.menu;
		this.ui.showSelector((done) => {
			const selector = new SelectSubmenu(
				text.scopeTitle,
				text.scopeDescription(profileName),
				profileScopeOptions(),
				currentScope,
				(value) => {
					done();
					void this.openLibraryEditorForProfile(profileName, value as WritableProfileScope);
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

		const registry = this.deps.getSettingsManager().getProfileRegistry();
		const profiles = registry.listProfiles();
		if (profiles.length === 0) {
			this.ui.showWarning(interfaceText().profilesScreen.menu.noProfiles);
			return;
		}

		this.ui.showSelector((done) => {
			const selector = new ProfileSelectorComponent(
				profiles,
				this.deps.getSettingsManager().getActiveResourceProfileNames(),
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
			const settingsSnapshot = this.deps.getSettingsManager().createReloadSnapshot();
			let stagedRuntimeApplied = false;
			try {
				this.deps.getSettingsManager().setRuntimeResourceProfiles([]);
				if (!(await this.ui.handleReloadCommand())) {
					this.deps.getSettingsManager().restoreReloadSnapshot(settingsSnapshot);
					return;
				}
				stagedRuntimeApplied = true;
				// Persist only after the new runtime generation passes its reload doctor.
				this.deps.getSettingsManager().setActiveProfile(undefined, "global");
				await this.deps.getSettingsManager().flush();
				this.deps.getSessionManager().appendCustomEntry("pi.activeResourceProfiles", {
					profiles: [],
				});
				const activeProfileName = this.deps.getSettingsManager().getActiveResourceProfileNames()[0] ?? "(none)";
				this.ui.footerDataProvider.setExtensionStatus("profile", activeProfileName);
				this.ui.invalidateFooter();
				this.ui.updateEditorBorderColor();
				this.ui.showStatus(interfaceText().profilesScreen.menu.profileStatus(activeProfileName));
			} catch (error) {
				await this.reportProfileMutationFailure(error, settingsSnapshot, stagedRuntimeApplied);
			}
			return;
		}

		const registry = this.deps.getSettingsManager().getProfileRegistry();
		const profile =
			normalizedName.startsWith("./") || normalizedName.startsWith("../")
				? registry.resolveProfileRef(normalizedName, this.deps.getSessionManager().getCwd())
				: registry.getProfile(normalizedName);
		if (!profile) {
			this.ui.showError(interfaceText().profilesScreen.menu.profileNotFound(profileName));
			return;
		}

		const settingsSnapshot = this.deps.getSettingsManager().createReloadSnapshot();
		const modelRegistrySnapshot = profile.model ? this.deps.getModelRegistry().createReloadSnapshot() : undefined;
		let stagedRuntimeApplied = false;
		try {
			const activeProfileRef =
				normalizedName.startsWith("./") || normalizedName.startsWith("../") ? normalizedName : profile.name;
			let requestedModel: Model<Api> | undefined;
			if (profile.model) {
				this.deps.getModelRegistry().refresh();
				const resolved = resolveCliModel({ cliModel: profile.model, modelRegistry: this.deps.getModelRegistry() });
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
			this.deps.getSettingsManager().setRuntimeResourceProfiles([activeProfileRef]);
			if (!(await this.ui.handleReloadCommand())) {
				this.deps.getSettingsManager().restoreReloadSnapshot(settingsSnapshot);
				if (modelRegistrySnapshot) this.deps.getModelRegistry().restoreReloadSnapshot(modelRegistrySnapshot);
				return;
			}
			stagedRuntimeApplied = true;

			// Selection survives restarts only after the new runtime generation passes its reload doctor.
			this.deps.getSettingsManager().setActiveProfile(activeProfileRef, "global");
			await this.deps.getSettingsManager().flush();
			this.deps.getSessionManager().appendCustomEntry("pi.activeResourceProfiles", {
				profiles: [activeProfileRef],
			});
			this.ui.footerDataProvider.setExtensionStatus("profile", profile.name);
			this.ui.invalidateFooter();
			this.ui.updateEditorBorderColor();
			this.ui.showStatus(interfaceText().profilesScreen.menu.profileStatus(profile.name));
			const currentModel = this.deps.getSession().model;
			if (
				requestedModel &&
				currentModel?.provider === requestedModel.provider &&
				currentModel.id === requestedModel.id
			) {
				void this.ui.maybeWarnAboutAnthropicSubscriptionAuth(requestedModel);
				this.ui.checkDaxnutsEasterEgg(requestedModel);
			}
		} catch (error) {
			await this.reportProfileMutationFailure(error, settingsSnapshot, stagedRuntimeApplied, undefined, () => {
				if (modelRegistrySnapshot) this.deps.getModelRegistry().restoreReloadSnapshot(modelRegistrySnapshot);
			});
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

	private async createProfileFlow(): Promise<void> {
		const text = interfaceText().profilesScreen.menu;
		const name = await promptForTextInput(this.ui, text.createTitle, text.createPlaceholder);

		if (name === undefined) {
			this.ui.requestRender();
			return;
		}

		const trimmed = name.trim();
		if (!trimmed) {
			this.ui.showError(text.nameEmptyError);
			return this.createProfileFlow();
		}

		// Validate name rules using validateSkillName
		const errors = validateSkillName(trimmed);
		if (errors.length > 0) {
			this.ui.showError(text.invalidName(errors.join(", ")));
			return this.createProfileFlow();
		}

		// Collision check
		const existing = this.deps.getSettingsManager().getProfileRegistry().getProfile(trimmed);
		if (existing) {
			this.ui.showError(text.alreadyExists(trimmed));
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
		const text = interfaceText().profilesScreen.menu;
		// The value the code keeps for "no model pinned"; only its label comes from the catalogue.
		const inheritValue = text.inheritValue;
		const availableModelOptions = [...this.ui.getAutoLearnModelOptions()];
		if (profileModel && !availableModelOptions.some((option) => option.value === profileModel)) {
			availableModelOptions.unshift({
				value: profileModel,
				label: profileModel,
				description: text.unavailableModelDescription,
			});
		}
		const modelOptions = [
			{
				value: inheritValue,
				label: text.inherit.label,
				description: text.inherit.description,
			},
			...availableModelOptions,
		];

		return await new Promise<string | null | undefined>((resolve) => {
			this.ui.showSelector((done) => {
				const selector = new SelectSubmenu(
					text.profileModelTitle,
					text.profileModelDescription,
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
		const kinds = await profileResourceKinds(this.deps.getSession());
		this.ui.showSelector((done) => {
			const editor = new ProfileResourceEditorComponent({
				profileName,
				profileScope: scope,
				initialResources: {},
				kinds,
				cwd: this.deps.getSessionManager().getCwd(),
				agentDir: getAgentDir(),
				externalResourceRoots: this.deps.getSettingsManager().getExternalResourceRoots(),
				onSave: (resources) => {
					done();
					try {
						this.deps.getSettingsManager().setProfileDefinition(
							profileName,
							{
								name: profileName,
								model: profileModel,
								resources,
							},
							scope,
						);
						this.ui.showStatus(interfaceText().profilesScreen.menu.savedTo(profileName, scope));
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
					await this.editProfileResource(id, pathValue, kind, () => {
						void this.openNewProfileEditor(profileName, profileModel);
					});
				},
			});
			return { component: editor, focus: editor };
		});
	}

	private persistActiveProfile(scope: "session" | "directory" | "project" | "global"): void {
		const text = interfaceText().profilesScreen.menu;
		const active = this.deps.getSettingsManager().getActiveResourceProfileNames()[0];
		if (!active) {
			this.ui.showError(text.noActiveToPersist);
			return;
		}
		try {
			if (scope === "session") {
				this.deps.getSettingsManager().setRuntimeResourceProfiles([active]);
			} else {
				this.deps.getSettingsManager().setActiveProfile(active, scope);
			}
			this.ui.showStatus(text.persisted(active, scope));
		} catch (error) {
			this.ui.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async deleteProfileFromSource(profileName: string): Promise<void> {
		const text = interfaceText().profilesScreen.menu;
		const registry = this.deps.getSettingsManager().getProfileRegistry();
		const profile = registry.getProfile(profileName);
		if (!profile) {
			this.ui.showError(text.profileNotFound(profileName));
			return;
		}
		const scope = deletionScopeForProfile(profile);
		if (!scope) {
			const location = profile.sourcePath ? ` at ${profile.sourcePath}` : "";
			this.ui.showError(text.readOnlySource(profileName, profileSourceLabel(profile), location));
			return;
		}
		const wasActive = this.deps
			.getSettingsManager()
			.getActiveResourceProfileNames()
			.some((profileRef) => {
				if (profileRef === profileName || profileRef === profile.name) return true;
				const activeProfile =
					profileRef.startsWith("./") || profileRef.startsWith("../")
						? registry.resolveProfileRef(profileRef, this.deps.getSessionManager().getCwd())
						: registry.getProfile(profileRef);
				return Boolean(
					activeProfile && activeProfile.name === profile.name && activeProfile.sourcePath === profile.sourcePath,
				);
			});
		const settingsSnapshot = this.deps.getSettingsManager().createReloadSnapshot();
		const profileFilesSnapshot = scope === "reusable-file" ? captureProfileFiles(getProfilesDir()) : undefined;
		let switchedToNone = false;
		try {
			if (wasActive) {
				// Stage an explicit empty runtime selection while the definition is still intact. The
				// full reload can now remove the profile's extensions, tools, providers, model, and
				// memory generation atomically. Persisting the deletion is deliberately deferred until
				// that generation passes its doctor, so a failed reload has no on-disk deletion to undo.
				this.deps.getSettingsManager().setRuntimeResourceProfiles([]);
				if (!(await this.ui.handleReloadCommand())) {
					this.deps.getSettingsManager().restoreReloadSnapshot(settingsSnapshot);
					return;
				}
				switchedToNone = true;
			}

			this.deps.getSettingsManager().deleteProfile(profileName, scope);
			const remaining = this.deps.getSettingsManager().getProfileRegistry().getProfile(profileName);
			if (remaining && remaining.source === profile.source && remaining.sourcePath === profile.sourcePath) {
				throw new Error(text.notRemoved(profileName, profile.source));
			}
			if (wasActive) {
				this.deps.getSettingsManager().setActiveProfile(undefined, "global");
				await this.deps.getSettingsManager().flush();
				this.deps.getSessionManager().appendCustomEntry("pi.activeResourceProfiles", { profiles: [] });
				this.ui.footerDataProvider.setExtensionStatus("profile", "(none)");
				this.ui.invalidateFooter();
				this.ui.updateEditorBorderColor();
			}
			this.ui.showStatus(text.deleted(profileName, scope));
		} catch (error) {
			await this.reportProfileMutationFailure(error, settingsSnapshot, switchedToNone, {
				profileName,
				scope,
				profileFilesSnapshot,
			});
		}
	}

	private async addExternalResourceRootFlow(): Promise<void> {
		const text = interfaceText().profilesScreen.menu;
		const rootPath = await promptForTextInput(this.ui, text.addRootTitle, text.addRootPlaceholder);

		if (rootPath === undefined) {
			this.ui.requestRender();
			return;
		}

		const trimmed = rootPath.trim();
		if (!trimmed) {
			this.ui.showError(text.pathEmpty);
			return;
		}

		const canonical = this.deps.getSettingsManager().canonicalizePath(trimmed);
		if (!canonical) {
			this.ui.showError(text.invalidPath(trimmed));
			return;
		}

		const trust = await confirmExternalResourceTrust(this.ui, {
			title: text.trustTitle,
			description: text.trustDescription,
			acceptDescription: text.trustAccept,
			rejectDescription: text.trustReject,
		});

		if (!trust) {
			this.ui.showStatus(text.trustAborted);
			return;
		}

		try {
			const currentRoots = this.deps.getSettingsManager().getExternalResourceRoots();
			if (!currentRoots.includes(canonical)) {
				this.deps.getSettingsManager().setExternalResourceRoots([...currentRoots, canonical], "global");
			}
			this.deps.getSettingsManager().addTrustedResourceRoot(canonical, "global");
			this.ui.showStatus(text.rootAdded(canonical));
			await this.ui.handleReloadCommand();
		} catch (error) {
			this.ui.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async removeExternalResourceRootFlow(root: string): Promise<void> {
		try {
			const currentRoots = this.deps.getSettingsManager().getExternalResourceRoots();
			const currentTrusted = this.deps.getSettingsManager().getTrustedResourceRoots();

			const newRoots = currentRoots.filter((r) => r !== root);
			const newTrusted = currentTrusted.filter((r) => r !== root);

			this.deps.getSettingsManager().setExternalResourceRoots(newRoots, "global");
			this.deps.getSettingsManager().setTrustedResourceRoots(newTrusted, "global");

			this.ui.showStatus(interfaceText().profilesScreen.menu.rootRemoved(root));
			await this.ui.handleReloadCommand();
		} catch (error) {
			this.ui.showError(error instanceof Error ? error.message : String(error));
		}
	}
}
