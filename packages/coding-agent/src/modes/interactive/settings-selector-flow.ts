/**
 * `/settings` selector flow extracted from interactive-mode.
 *
 * Builds the SettingsSelectorComponent model from the current settings/session
 * state and wires its change callbacks back through a `SettingsSelectorHost`
 * seam. Self-mod/auto-learn validation, autonomy-preset application, autocomplete
 * rebuild, and the resources-hub hand-off stay host-side (shared with other
 * flows); interactive-mode keeps a thin wrapper building the host once.
 */

import { getSupportedThinkingLevels } from "@caupulican/pi-ai";
import type { Component, Container, EditorComponent, SelectItem, TUI } from "@caupulican/pi-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import type { CostGuardSettings } from "../../core/cost-guard.ts";
import type {
	HmoeIndependence,
	HmoePreference,
	HmoePreset,
	HmoeTeamStrategy,
	HmoeWeights,
} from "../../core/expert-routing/vocabulary.ts";
import { configureHttpDispatcher, formatHttpIdleTimeoutMs } from "../../core/http-dispatcher.ts";
import { interfaceText } from "../../core/language/interface-text.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import { resolveCliModel } from "../../core/model-resolver.ts";
import { describeRouterCalibration, formatRouterCalibrationRow } from "../../core/model-router/calibration.ts";
import { formatRouterPoolSummary } from "../../core/model-router/candidate-pool.ts";
import type { ProfileRegistry } from "../../core/profile-registry.ts";
import type {
	AdvisorSettings,
	AutoLearnSettings,
	AutonomyMode,
	AutonomySettings,
	ContextCurationSettings,
	ContextPromptEnforcementSettings,
	LearningPolicySettings,
	MemoryRetrievalSettings,
	ModelCapabilitySettings,
	ModelFavorite,
	ModelRouterPoolPreference,
	ModelRouterSelectionMode,
	ModelRouterSettings,
	ResearchLaneSettings,
	ResolvedLearningPolicySettings,
	ResolvedResearchLaneSettings,
	ResolvedWorkerDelegationSettings,
	ResourceProfileKind,
	SelfModificationSettings,
	Settings,
	SettingsScope,
	SystemOneSettings,
	ThinkingLevel,
	TransportSetting,
	WarningSettings,
	WorkerDelegationSettings,
} from "../../core/settings/settings-schema.ts";
import type { PlainSettingKey } from "../../core/settings-manager.ts";
import type { SystemOneProviderChoice } from "../../core/system-one/access.ts";
import { describeSystemOneAccess } from "../../core/system-one/access.ts";
import { plainLabel } from "../../presentation/plain-text.ts";
import { getAvailableThemes, setTheme } from "../../presentation/theme/theme.ts";
import { ActionTranscriptComponent } from "./components/action-transcript.ts";

import type { CustomEditor } from "./components/custom-editor.ts";
import type { FooterComponent } from "./components/footer.ts";
import { type ModelRouterPoolView, SettingsSelectorComponent } from "./components/settings-selector.ts";

/** The words for the scope a setting was saved to; the scope value itself stays the code's own word. */
function scopeLabel(scope: SettingsScope | undefined): string {
	return interfaceText().settingsScreen.scopes[scope ?? "global"];
}

/** The settings this module reads, declared by the module itself; the composition root passes the SettingsManager. */
export interface SettingsSelectorFlowSettingsSource {
	getAdvisorSettings(): AdvisorSettings & { enabled: boolean; error?: string };
	getAdvisorSettingsScope(): SettingsScope | undefined;
	setAdvisorSettings(settings: AdvisorSettings, scope?: SettingsScope): void;
	getActiveResourceProfileNames(): string[];
	getAutoLearnSettings(): AutoLearnSettings;
	getAutocompleteMaxVisible(): number;
	getAutonomySettings(): Required<AutonomySettings>;
	getBlockImages(): boolean;
	getClearOnShrink(): boolean;
	getCollapseChangelog(): boolean;
	getContextCurationSettings(): { enabled: boolean; model?: string; maxJobsPerTurn: number };
	getContextPromptEnforcementSettings(): { enabled: boolean; preserveRecentMessages: number; minChars: number };
	getCostGuardSettings(): CostGuardSettings;
	getDoubleEscapeAction(): "fork" | "tree" | "none";
	getEditorPaddingX(): number;
	getEnableSkillCommands(): boolean;
	getExternalResourceRoots(): string[];
	getHttpIdleTimeoutMs(): number;
	getImageAutoResize(): boolean;
	getImageWidthCells(): number;
	getLearningPolicySettings(): ResolvedLearningPolicySettings;
	getMemoryRetrievalSettings(): {
		enabled: boolean;
		maxResults: number;
		includeInPrompt: boolean;
		allowExternalEgress: boolean;
	};
	getModelCapabilitySettings(): Required<ModelCapabilitySettings>;
	getModelFavorites(): ModelFavorite[];
	getModelRouterSettings(): {
		enabled: boolean;
		selectionMode: ModelRouterSelectionMode;
		poolPreference: ModelRouterPoolPreference;
		cheapModel?: string;
		mediumModel?: string;
		expensiveModel?: string;
		learningModel?: string;
		executorModel?: string;
		fitnessGate: boolean;
		cheapThinking?: ThinkingLevel;
		mediumThinking?: ThinkingLevel;
		expensiveThinking?: ThinkingLevel;
		executorThinking?: ThinkingLevel;
		hmoePreset?: HmoePreset;
		hmoeTeamStrategy?: HmoeTeamStrategy;
		hmoeIndependence?: HmoeIndependence;
		hmoePreference?: HmoePreference;
		hmoeWeights?: HmoeWeights;
	};
	getProfileRegistry(): ProfileRegistry;
	getProjectContextFiles(): "on-demand" | "off";
	getProjectContextFilesScope(): SettingsScope | undefined;
	getProjectSettings(): Settings;
	getQuietStartup(): boolean;
	getResearchLaneSettings(): ResolvedResearchLaneSettings;
	getSelfModificationSettings(): { enabled: boolean; sourcePath?: string; sourcePaths?: string[] };
	getShowHardwareCursor(): boolean;
	getShowImages(): boolean;
	getShowTerminalProgress(): boolean;
	getSystemOneSettings(): {
		enabled: boolean;
		provider: SystemOneProviderChoice;
		loopMode?: SystemOneSettings["loopMode"];
		completionProfile?: SystemOneSettings["completionProfile"];
	};
	getPlain<K extends PlainSettingKey>(key: K): Settings[K];
	getTheme(): string | undefined;
	getTransport(): TransportSetting;
	getTreeFilterMode(): "default" | "no-tools" | "user-only" | "labeled-only" | "all";
	getTrustedResourceRoots(): string[];
	getWarnings(): WarningSettings;
	getWorkerDelegationSettings(): ResolvedWorkerDelegationSettings;
	isResourceAllowedByProfile(kind: ResourceProfileKind, resourcePath: string, baseDir?: string): boolean;
	setAutoLearnSettings(settings: AutoLearnSettings, scope?: SettingsScope): void;
	setAutocompleteMaxVisible(maxVisible: number): void;
	setPlain<K extends PlainSettingKey>(key: K, value: Settings[K]): void;
	setBlockImages(blocked: boolean): void;
	setClearOnShrink(enabled: boolean): void;
	setCollapseChangelog(collapse: boolean): void;
	setContextCurationSettings(settings: ContextCurationSettings, scope?: SettingsScope): void;
	setContextPromptEnforcementSettings(settings: ContextPromptEnforcementSettings, scope?: SettingsScope): void;
	setDoubleEscapeAction(action: "fork" | "tree" | "none"): void;
	setEditorPaddingX(padding: number): void;
	setEnableSkillCommands(enabled: boolean): void;
	setHideThinkingBlock(hide: boolean): void;
	setHttpIdleTimeoutMs(timeoutMs: number): void;
	setImageAutoResize(enabled: boolean): void;
	setImageWidthCells(width: number): void;
	setLearningPolicySettings(settings: LearningPolicySettings, scope?: SettingsScope): void;
	setMemoryRetrievalSettings(settings: MemoryRetrievalSettings, scope?: SettingsScope): void;
	setModelCapabilitySettings(settings: ModelCapabilitySettings, scope?: SettingsScope): void;
	setModelRouterSettings(settings: ModelRouterSettings, scope?: SettingsScope): void;
	setProjectContextFiles(mode: "on-demand" | "off", scope?: SettingsScope): void;
	setQuietStartup(quiet: boolean): void;
	setResearchLaneSettings(settings: ResearchLaneSettings, scope?: SettingsScope): void;
	setSelfModificationSettings(settings: SelfModificationSettings, scope?: SettingsScope): void;
	setShowHardwareCursor(enabled: boolean): void;
	setShowImages(show: boolean): void;
	setShowTerminalProgress(enabled: boolean): void;
	setSystemOneProvider(provider: SystemOneProviderChoice): void;
	setTheme(theme: string): void;
	setTransport(transport: TransportSetting): void;
	setTreeFilterMode(mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all"): void;
	setWarnings(warnings: WarningSettings): void;
	setWorkerDelegationSettings(settings: WorkerDelegationSettings, scope?: SettingsScope): void;
}

export interface SettingsSelectorHost {
	readonly session: AgentSession;
	/** Pushes an image-visibility change into the cached bot and team chats, which the Root loop never reaches. */
	setBotTeamShowImages(show: boolean): void;
	/** Pushes an image-width change into the cached bot and team chats, which the Root loop never reaches. */
	setBotTeamImageWidthCells(width: number): void;
	readonly settingsManager: SettingsSelectorFlowSettingsSource;
	readonly modelRegistry: ModelRegistry;
	readonly footer: FooterComponent;
	readonly chatContainer: Container;
	readonly ui: TUI;
	readonly defaultEditor: CustomEditor;
	readonly editor: EditorComponent;
	hideThinkingBlock: boolean;
	showSelector(create: (done: () => void) => { component: Component; focus: Component }): void;
	showStatus(message: string): void;
	showWarning(message: string): void;
	showError(message: string): void;
	getAutoLearnModelOptions(): SelectItem[];
	setupAutocompleteProvider(): void;
	updateEditorBorderColor(): void;
	rebuildChatFromMessages(): Promise<void>;
	updateThinkingBlockVisibility(): void;
	validateSelfModificationSource(settings: SelfModificationSettings): string | undefined;
	applyAutonomyMode(mode: AutonomyMode, scope?: SettingsScope): void;
	validateAutoLearnModelValue(value: string | undefined, setting?: "autoLearn" | "modelRouter"): string | undefined;
	updateAutoLearnFooter(): void;
	handleResourcesHubAction(action: string): Promise<void>;
	/** Router Setup actions (configure-models, calibrate-*, preview:<task>, diagnostics). */
	handleModelRouterAction(action: string): Promise<void>;
}

/**
 * The router's pool as the settings screen shows it: the session's live candidate pool, favorites
 * as eligibility, subscription ownership from the registry, and existing fitness/tool-probe
 * evidence per router surface. Reading it never runs a probe.
 */
export function buildModelRouterPoolView(
	host: Pick<SettingsSelectorHost, "session" | "settingsManager" | "modelRegistry">,
): ModelRouterPoolView {
	const pool = host.session.getRouterCandidatePool();
	const registry = host.modelRegistry;
	const rows = describeRouterCalibration(pool.models, {
		fitnessReports: host.session.getStoredFitnessReports(),
		toolProbe: (model) => host.session.getToolProbeRecord(model),
		isSubscription: (model) => registry.isUsingSubscription(model),
	});
	const favorites = new Set(
		host.settingsManager.getModelFavorites().map((favorite) => `${favorite.provider}/${favorite.modelId}`),
	);
	return {
		customized: pool.customized,
		summary: formatRouterPoolSummary(pool),
		refs: rows.map((row) => row.ref),
		subscriptionRefs: rows.filter((row) => row.subscription).map((row) => row.ref),
		favoriteRefs: rows.filter((row) => favorites.has(row.ref)).map((row) => row.ref),
		calibration: rows.map(formatRouterCalibrationRow),
		needsCalibration: rows.filter((row) => row.needsCalibration).map((row) => row.ref),
	};
}

/**
 * Open `/settings`. `initialItemId` lands directly in one setting's submenu (e.g. "model-router"),
 * which is how Router Setup comes back after the Models editor closed: the config below — the pool
 * view included — is rebuilt on every open, so the reopened submenu reads the edited pool.
 */
export function showSettingsSelector(host: SettingsSelectorHost, initialItemId?: string): void {
	host.showSelector((done) => {
		const projectSettings = host.settingsManager.getProjectSettings();
		const profileOptions = [
			{
				value: "(none)",
				label: interfaceText().settingsScreen.values.none,
				description: interfaceText().settingsScreen.resourcesMenu.profileDefault,
			},
			...host.settingsManager
				.getProfileRegistry()
				.listProfiles()
				.map((profile) => ({
					value: profile.name,
					label: profile.name,
					description: profile.description ?? plainLabel(profile.source),
				})),
		];
		const selector = new SettingsSelectorComponent(
			{
				autoCompact: host.session.autoCompactionEnabled,
				costGuard: host.settingsManager.getCostGuardSettings(),
				costGuardScope: projectSettings.costGuard ? "project" : "global",
				showImages: host.settingsManager.getShowImages(),
				imageWidthCells: host.settingsManager.getImageWidthCells(),
				autoResizeImages: host.settingsManager.getImageAutoResize(),
				blockImages: host.settingsManager.getBlockImages(),
				enableSkillCommands: host.settingsManager.getEnableSkillCommands(),
				steeringMode: host.session.steeringMode,
				followUpMode: host.session.followUpMode,
				transport: host.settingsManager.getTransport(),
				httpIdleTimeoutMs: host.settingsManager.getHttpIdleTimeoutMs(),
				thinkingLevel: host.session.thinkingLevel,
				availableThinkingLevels: host.session.getAvailableThinkingLevels(),
				currentTheme: host.settingsManager.getTheme() || "dark",
				language: host.settingsManager.getPlain("language") ?? "auto",
				// The picker offers only themes the active profile permits (no-bypass). The theme
				// registry/renderer keeps the full set, so an already-applied theme still renders
				// even if the profile would block re-selecting it.
				availableThemes: getAvailableThemes().filter((name) =>
					host.settingsManager.isResourceAllowedByProfile("themes", name),
				),
				hideThinkingBlock: host.hideThinkingBlock,
				projectContextFiles: host.settingsManager.getProjectContextFiles(),
				projectContextFilesScope: host.settingsManager.getProjectContextFilesScope(),
				collapseChangelog: host.settingsManager.getCollapseChangelog(),
				doubleEscapeAction: host.settingsManager.getDoubleEscapeAction(),
				treeFilterMode: host.settingsManager.getTreeFilterMode(),
				showHardwareCursor: host.settingsManager.getShowHardwareCursor(),
				editorPaddingX: host.settingsManager.getEditorPaddingX(),
				autocompleteMaxVisible: host.settingsManager.getAutocompleteMaxVisible(),
				quietStartup: host.settingsManager.getQuietStartup(),
				clearOnShrink: host.settingsManager.getClearOnShrink(),
				showTerminalProgress: host.settingsManager.getShowTerminalProgress(),
				warnings: host.settingsManager.getWarnings(),
				selfModification: host.settingsManager.getSelfModificationSettings(),
				selfModificationScope: projectSettings.selfModification ? "project" : "global",
				autonomy: host.settingsManager.getAutonomySettings(),
				autonomyScope: projectSettings.autonomy ? "project" : "global",
				researchLane: host.settingsManager.getResearchLaneSettings(),
				researchLaneScope: projectSettings.researchLane ? "project" : "global",
				workerDelegation: host.settingsManager.getWorkerDelegationSettings(),
				workerDelegationScope: projectSettings.workerDelegation ? "project" : "global",
				contextCuration: host.settingsManager.getContextCurationSettings(),
				contextCurationScope: projectSettings.contextPolicy?.curation ? "project" : "global",
				learningPolicy: host.settingsManager.getLearningPolicySettings(),
				learningPolicyScope: projectSettings.learningPolicy ? "project" : "global",
				advisor: host.settingsManager.getAdvisorSettings(),
				advisorScope: host.settingsManager.getAdvisorSettingsScope() ?? "global",
				getAdvisorSettingsScope: () => host.settingsManager.getAdvisorSettingsScope(),
				modelCapability: host.settingsManager.getModelCapabilitySettings(),
				modelCapabilityScope: projectSettings.modelCapability ? "project" : "global",
				modelRouter: host.settingsManager.getModelRouterSettings(),
				systemOneProvider: host.settingsManager.getSystemOneSettings().provider,
				describeSystemOneAccess: (choice) =>
					describeSystemOneAccess(choice, (provider) => host.modelRegistry.authStorage.hasAuth(provider)),
				modelRouterScope: projectSettings.modelRouter ? "project" : "global",
				modelRouterPool: buildModelRouterPoolView(host),
				autoLearn: host.settingsManager.getAutoLearnSettings(),
				autoLearnScope: projectSettings.autoLearn ? "project" : "global",
				autoLearnModelOptions: host.getAutoLearnModelOptions(),
				resolveModelThinkingLevels: (modelPattern) => {
					if (!modelPattern) return host.session.getAvailableThinkingLevels();
					const resolved = resolveCliModel({ cliModel: modelPattern, modelRegistry: host.modelRegistry });
					return resolved.model ? getSupportedThinkingLevels(resolved.model) : undefined;
				},
				contextPolicyEnforcement: host.settingsManager.getContextPromptEnforcementSettings(),
				contextPolicyEnforcementScope: projectSettings.contextPolicy?.enforcement ? "project" : "global",
				contextMemoryRetrieval: host.settingsManager.getMemoryRetrievalSettings(),
				contextMemoryRetrievalScope: projectSettings.contextPolicy?.memory ? "project" : "global",
				currentModelPattern: host.session.model
					? `${host.session.model.provider}/${host.session.model.id}`
					: undefined,
				activeProfileName: host.settingsManager.getActiveResourceProfileNames()[0],
				profileOptions,
				externalResourceRoots: host.settingsManager.getExternalResourceRoots(),
				trustedResourceRoots: host.settingsManager.getTrustedResourceRoots(),
				initialItemId,
			},
			{
				onAutoCompactChange: (enabled) => {
					host.session.setAutoCompactionEnabled(enabled);
					host.footer.setAutoCompactEnabled(enabled);
				},
				onCostGuardChange: (settings, scope) => {
					host.session.setCostGuardSettings(settings, scope);
					host.footer.invalidate();
					host.ui.requestRender();
					const text = interfaceText().settingsScreen;
					host.showStatus(
						settings.enabled
							? text.statuses.costGuardOn(
									interfaceText().reports.formats.amount(settings.maxTurnUsd, 2),
									settings.action,
								)
							: text.statuses.costGuardOff,
					);
				},
				onShowImagesChange: (enabled) => {
					host.settingsManager.setShowImages(enabled);
					for (const child of host.chatContainer.children) {
						if (child instanceof ActionTranscriptComponent) {
							child.setShowImages(enabled);
						}
					}
					host.setBotTeamShowImages(enabled);
					host.ui.requestRender();
				},
				onImageWidthCellsChange: (width) => {
					host.settingsManager.setImageWidthCells(width);
					for (const child of host.chatContainer.children) {
						if (child instanceof ActionTranscriptComponent) {
							child.setImageWidthCells(width);
						}
					}
					host.setBotTeamImageWidthCells(width);
					host.ui.requestRender();
				},
				onAutoResizeImagesChange: (enabled) => {
					host.settingsManager.setImageAutoResize(enabled);
				},
				onBlockImagesChange: (blocked) => {
					host.settingsManager.setBlockImages(blocked);
				},
				onEnableSkillCommandsChange: (enabled) => {
					host.settingsManager.setEnableSkillCommands(enabled);
					host.setupAutocompleteProvider();
				},
				onSteeringModeChange: (mode) => {
					host.session.setSteeringMode(mode);
				},
				onFollowUpModeChange: (mode) => {
					host.session.setFollowUpMode(mode);
				},
				onTransportChange: (transport) => {
					host.settingsManager.setTransport(transport);
					host.session.agent.transport = transport;
				},
				onHttpIdleTimeoutMsChange: (timeoutMs) => {
					host.settingsManager.setHttpIdleTimeoutMs(timeoutMs);
					configureHttpDispatcher(timeoutMs);
					const text = interfaceText().settingsScreen;
					const value = formatHttpIdleTimeoutMs(timeoutMs);
					host.showStatus(text.statuses.httpIdleTimeout(text.valueLabels.httpIdleTimeout[value] ?? value));
				},
				onThinkingLevelChange: (level) => {
					host.session.setThinkingLevel(level);
					host.footer.invalidate();
					host.updateEditorBorderColor();
				},
				onThemeChange: (themeName) => {
					const result = setTheme(themeName, true);
					host.settingsManager.setTheme(themeName);
					host.ui.invalidate();
					if (!result.success) {
						host.showError(interfaceText().settingsScreen.statuses.themeFailed(themeName, result.error ?? ""));
					}
				},
				onLanguageChange: (language) => {
					host.settingsManager.setPlain("language", language);
				},
				onThemePreview: (themeName) => {
					const result = setTheme(themeName, true);
					if (result.success) {
						host.ui.invalidate();
						host.ui.requestRender();
					}
				},
				onProjectContextFilesChange: (mode, scope) => {
					host.settingsManager.setProjectContextFiles(mode, scope);
					const text = interfaceText().settingsScreen;
					const where =
						scope === "directoryProfile"
							? text.statuses.projectContextWhere.thisDirectory
							: scope === "project"
								? text.statuses.projectContextWhere.thisProject
								: text.statuses.projectContextWhere.allProjects;
					const load =
						mode === "on-demand" ? text.statuses.projectContextOn : text.statuses.projectContextGlobalOnly;
					host.showStatus(text.statuses.projectContextFiles(load, where));
				},
				onHideThinkingBlockChange: (hidden) => {
					host.hideThinkingBlock = hidden;
					host.settingsManager.setHideThinkingBlock(hidden);
					host.updateThinkingBlockVisibility();
				},
				onCollapseChangelogChange: (collapsed) => {
					host.settingsManager.setCollapseChangelog(collapsed);
				},
				onQuietStartupChange: (enabled) => {
					host.settingsManager.setQuietStartup(enabled);
				},
				onDoubleEscapeActionChange: (action) => {
					host.settingsManager.setDoubleEscapeAction(action);
				},
				onTreeFilterModeChange: (mode) => {
					host.settingsManager.setTreeFilterMode(mode);
				},
				onShowHardwareCursorChange: (enabled) => {
					host.settingsManager.setShowHardwareCursor(enabled);
					host.ui.setShowHardwareCursor(enabled);
				},
				onEditorPaddingXChange: (padding) => {
					host.settingsManager.setEditorPaddingX(padding);
					host.defaultEditor.setPaddingX(padding);
					if (host.editor !== host.defaultEditor && host.editor.setPaddingX !== undefined) {
						host.editor.setPaddingX(padding);
					}
				},
				onAutocompleteMaxVisibleChange: (maxVisible) => {
					host.settingsManager.setAutocompleteMaxVisible(maxVisible);
					host.defaultEditor.setAutocompleteMaxVisible(maxVisible);
					if (host.editor !== host.defaultEditor && host.editor.setAutocompleteMaxVisible !== undefined) {
						host.editor.setAutocompleteMaxVisible(maxVisible);
					}
				},
				onClearOnShrinkChange: (enabled) => {
					host.settingsManager.setClearOnShrink(enabled);
					host.ui.setClearOnShrink(enabled);
				},
				onShowTerminalProgressChange: (enabled) => {
					host.settingsManager.setShowTerminalProgress(enabled);
				},
				onWarningsChange: (warnings) => {
					host.settingsManager.setWarnings(warnings);
				},
				onSelfModificationChange: (settings, scope) => {
					host.settingsManager.setSelfModificationSettings(settings, scope);
					const validationMessage = host.validateSelfModificationSource(settings);
					if (validationMessage) {
						host.showWarning(validationMessage);
					}
					host.showStatus(interfaceText().settingsScreen.statuses.selfModificationSaved(scopeLabel(scope)));
				},
				onAutonomyChange: (settings, scope) => {
					host.applyAutonomyMode(settings.mode ?? "off", scope);
					host.showStatus(
						interfaceText().settingsScreen.statuses.autonomySaved(settings.mode ?? "off", scopeLabel(scope)),
					);
				},
				onResearchLaneChange: (settings, scope) => {
					host.settingsManager.setResearchLaneSettings(settings, scope);
					host.showStatus(interfaceText().settingsScreen.statuses.researchLaneSaved(scopeLabel(scope)));
				},
				onWorkerDelegationChange: (settings, scope) => {
					host.settingsManager.setWorkerDelegationSettings(settings, scope);
					host.showStatus(interfaceText().settingsScreen.statuses.workerDelegationSaved(scopeLabel(scope)));
				},
				onLearningPolicyChange: (settings, scope) => {
					host.settingsManager.setLearningPolicySettings(settings, scope);
					host.showStatus(interfaceText().settingsScreen.statuses.learningPolicySaved(scopeLabel(scope)));
				},
				onSystemOneProviderChange: (choice) => {
					host.settingsManager.setSystemOneProvider(choice);
					host.showStatus(interfaceText().settingsScreen.statuses.systemOneProviderSaved(choice));
				},
				onAdvisorChange: (settings, scope) => {
					host.settingsManager.setAdvisorSettings(settings, scope);
					const activeScope = host.settingsManager.getAdvisorSettingsScope();
					const effective = host.settingsManager.getAdvisorSettings();
					if (effective.error) {
						host.showWarning(interfaceText().settingsScreen.statuses.peerError(effective.error));
						return effective;
					}
					const text = interfaceText().settingsScreen;
					const selection =
						effective.enabled === false
							? text.statuses.peerSelectionDisabled
							: text.statuses.peerSelection(
									effective.model ?? text.values.agentChoosesLower,
									effective.thinkingLevel ?? text.values.agentChoosesEffort,
								);
					if (activeScope !== scope) {
						host.showWarning(text.statuses.peerOtherScope(scopeLabel(scope), scopeLabel(activeScope), selection));
						return effective;
					}
					const options = host.session.getPeerReviewController()?.options();
					if (effective.enabled && (!options || options.reason)) {
						host.showWarning(
							text.statuses.peerSaved(scopeLabel(scope), options?.reason ?? text.statuses.peerToolUnavailable),
						);
						return effective;
					}
					host.showStatus(
						effective.enabled === false
							? text.statuses.peerDisabled
							: text.statuses.peerApplied(selection, scopeLabel(scope)),
					);
					return effective;
				},
				onModelCapabilityChange: (settings, scope) => {
					host.settingsManager.setModelCapabilitySettings(settings, scope);
					host.showStatus(interfaceText().settingsScreen.statuses.modelCapabilitySaved(scopeLabel(scope)));
				},
				onContextCurationChange: (settings, scope) => {
					host.settingsManager.setContextCurationSettings(settings, scope);
					host.showStatus(interfaceText().settingsScreen.statuses.contextCurationSaved(scopeLabel(scope)));
				},
				onModelRouterChange: (settings, scope) => {
					host.settingsManager.setModelRouterSettings(settings, scope);
					for (const value of [settings.cheapModel, settings.expensiveModel, settings.learningModel]) {
						const validationMessage = host.validateAutoLearnModelValue(value, "modelRouter");
						if (validationMessage) host.showWarning(validationMessage);
					}
					host.updateAutoLearnFooter();
					host.showStatus(interfaceText().settingsScreen.statuses.modelRouterSaved(scopeLabel(scope)));
				},
				onAutoLearnChange: (settings, scope) => {
					host.settingsManager.setAutoLearnSettings(settings, scope);
					const validationMessage = host.validateAutoLearnModelValue(settings.model);
					if (validationMessage) {
						host.showWarning(validationMessage);
					}
					host.updateAutoLearnFooter();
					host.showStatus(interfaceText().settingsScreen.statuses.autoLearnSaved(scopeLabel(scope)));
				},
				onContextPolicyEnforcementChange: (settings, scope) => {
					host.settingsManager.setContextPromptEnforcementSettings(settings, scope);
					host.showStatus(interfaceText().settingsScreen.statuses.contextPolicySaved(scopeLabel(scope)));
				},
				onContextMemoryRetrievalChange: (settings, scope) => {
					host.settingsManager.setMemoryRetrievalSettings(settings, scope);
					host.showStatus(interfaceText().settingsScreen.statuses.contextMemorySaved(scopeLabel(scope)));
				},
				onResourcesHubAction: (action) => {
					done();
					void host.handleResourcesHubAction(action);
				},
				onModelRouterAction: (action) => {
					done();
					void host.handleModelRouterAction(action);
				},
				onCancel: () => {
					done();
					host.ui.requestRender();
				},
			},
		);
		return { component: selector, focus: selector.getSettingsList() };
	});
}
