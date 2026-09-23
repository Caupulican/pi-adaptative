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
import { configureHttpDispatcher, formatHttpIdleTimeoutMs } from "../../core/http-dispatcher.ts";
import { resolveCliModel } from "../../core/model-resolver.ts";
import { describeRouterCalibration, formatRouterCalibrationRow } from "../../core/model-router/calibration.ts";
import { formatRouterPoolSummary } from "../../core/model-router/candidate-pool.ts";
import type {
	AutonomyMode,
	SelfModificationSettings,
	SettingsManager,
	SettingsScope,
} from "../../core/settings-manager.ts";
import { describeSystemOneAccess } from "../../core/system-one/access.ts";
import { ActionTranscriptComponent } from "./components/action-transcript.ts";
import type { CustomEditor } from "./components/custom-editor.ts";
import type { FooterComponent } from "./components/footer.ts";
import { type ModelRouterPoolView, SettingsSelectorComponent } from "./components/settings-selector.ts";
import { getAvailableThemes, setTheme } from "./theme/theme.ts";

export interface SettingsSelectorHost {
	readonly session: AgentSession;
	readonly settingsManager: SettingsManager;
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
	validateAutoLearnModelValue(value: string | undefined): string | undefined;
	updateAutoLearnFooter(): void;
	handleResourcesHubAction(action: string): Promise<void>;
	/** Router Setup actions (configure-models, calibrate-*, preview:<task>, diagnostics). */
	handleModelRouterAction(action: string): Promise<void>;
}

/**
 * The router's pool as the settings screen shows it: the session's live candidate pool, favorites
 * for ordering only, subscription ownership from the registry, and existing fitness/tool-probe
 * evidence per router surface. Reading it never runs a probe.
 */
export function buildModelRouterPoolView(
	host: Pick<SettingsSelectorHost, "session" | "settingsManager">,
): ModelRouterPoolView {
	const pool = host.session.getRouterCandidatePool();
	const registry = host.session.modelRegistry;
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
				label: "(none)",
				description: "Use configured profile selection (session default)",
			},
			...host.settingsManager
				.getProfileRegistry()
				.listProfiles()
				.map((profile) => ({
					value: profile.name,
					label: profile.name,
					description: profile.description ?? profile.source,
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
				modelCapability: host.settingsManager.getModelCapabilitySettings(),
				modelCapabilityScope: projectSettings.modelCapability ? "project" : "global",
				modelRouter: host.settingsManager.getModelRouterSettings(),
				systemOneProvider: host.settingsManager.getSystemOneSettings().provider,
				describeSystemOneAccess: (choice) =>
					describeSystemOneAccess(choice, (provider) => host.session.modelRegistry.authStorage.hasAuth(provider)),
				modelRouterScope: projectSettings.modelRouter ? "project" : "global",
				modelRouterPool: buildModelRouterPoolView(host),
				autoLearn: host.settingsManager.getAutoLearnSettings(),
				autoLearnScope: projectSettings.autoLearn ? "project" : "global",
				autoLearnModelOptions: host.getAutoLearnModelOptions(),
				resolveModelThinkingLevels: (modelPattern) => {
					if (!modelPattern) return host.session.getAvailableThinkingLevels();
					const resolved = resolveCliModel({ cliModel: modelPattern, modelRegistry: host.session.modelRegistry });
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
					host.showStatus(
						settings.enabled
							? `Foreground cost guard enabled at $${settings.maxTurnUsd.toFixed(2)}/turn (${settings.action}).`
							: "Foreground cost guard disabled.",
					);
				},
				onShowImagesChange: (enabled) => {
					host.settingsManager.setShowImages(enabled);
					for (const child of host.chatContainer.children) {
						if (child instanceof ActionTranscriptComponent) {
							child.setShowImages(enabled);
						}
					}
					host.ui.requestRender();
				},
				onImageWidthCellsChange: (width) => {
					host.settingsManager.setImageWidthCells(width);
					for (const child of host.chatContainer.children) {
						if (child instanceof ActionTranscriptComponent) {
							child.setImageWidthCells(width);
						}
					}
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
					host.showStatus(`HTTP idle timeout: ${formatHttpIdleTimeoutMs(timeoutMs)}`);
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
						host.showError(`Failed to load theme "${themeName}": ${result.error}\nFell back to dark theme.`);
					}
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
					const where =
						scope === "directoryProfile"
							? "this directory"
							: scope === "project"
								? "this project"
								: "all projects";
					const load = mode === "on-demand" ? "lists this project's AGENTS.md" : "global AGENTS.md only";
					host.showStatus(`Project context files: ${load} (${where}). Run /reload to apply.`);
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
					host.showStatus(
						`Self modification settings saved to ${scope}. Start a new session or /reload for system-prompt guardrails to fully refresh.`,
					);
				},
				onAutonomyChange: (settings, scope) => {
					host.applyAutonomyMode(settings.mode ?? "off", scope);
					host.showStatus(`Autonomy mode ${settings.mode ?? "off"} saved to ${scope}. Use /autonomy status.`);
				},
				onResearchLaneChange: (settings, scope) => {
					host.settingsManager.setResearchLaneSettings(settings, scope);
					host.showStatus(
						`Research lane settings saved to ${scope}. Use /autonomy research or /autonomy diagnostics.`,
					);
				},
				onWorkerDelegationChange: (settings, scope) => {
					host.settingsManager.setWorkerDelegationSettings(settings, scope);
					host.showStatus(`Worker delegation settings saved to ${scope}. The delegate tool uses them.`);
				},
				onLearningPolicyChange: (settings, scope) => {
					host.settingsManager.setLearningPolicySettings(settings, scope);
					host.showStatus(`Learning policy saved to ${scope}.`);
				},
				onSystemOneProviderChange: (choice) => {
					host.settingsManager.setSystemOneProvider(choice);
					host.showStatus(`System One provider set to ${choice}; the next evaluation uses it.`);
				},
				onModelCapabilityChange: (settings, scope) => {
					host.settingsManager.setModelCapabilitySettings(settings, scope);
					host.showStatus(`Model capability mode saved to ${scope}. Applies on the next model switch or /reload.`);
				},
				onContextCurationChange: (settings, scope) => {
					host.settingsManager.setContextCurationSettings(settings, scope);
					host.showStatus(
						`Context curation settings saved to ${scope}. Run /fitness <model> first if the model is unprobed.`,
					);
				},
				onModelRouterChange: (settings, scope) => {
					host.settingsManager.setModelRouterSettings(settings, scope);
					for (const value of [settings.cheapModel, settings.expensiveModel, settings.learningModel]) {
						const validationMessage = host.validateAutoLearnModelValue(value);
						if (validationMessage) {
							host.showWarning(validationMessage.replace("Auto Learn model", "Model router model"));
						}
					}
					host.updateAutoLearnFooter();
					host.showStatus(`Model Router settings saved to ${scope}. Use /session or /usage to inspect routing.`);
				},
				onAutoLearnChange: (settings, scope) => {
					host.settingsManager.setAutoLearnSettings(settings, scope);
					const validationMessage = host.validateAutoLearnModelValue(settings.model);
					if (validationMessage) {
						host.showWarning(validationMessage);
					}
					host.updateAutoLearnFooter();
					host.showStatus(`Auto Learn settings saved to ${scope}. Use /auto-learn status or /auto-learn run.`);
				},
				onContextPolicyEnforcementChange: (settings, scope) => {
					host.settingsManager.setContextPromptEnforcementSettings(settings, scope);
					host.showStatus(`Context/prompt-policy settings saved to ${scope}.`);
				},
				onContextMemoryRetrievalChange: (settings, scope) => {
					host.settingsManager.setMemoryRetrievalSettings(settings, scope);
					host.showStatus(`Context/memory-retrieval settings saved to ${scope}.`);
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
