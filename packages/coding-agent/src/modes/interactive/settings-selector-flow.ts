/**
 * `/settings` selector flow extracted from interactive-mode.
 *
 * Builds the SettingsSelectorComponent model from the current settings/session
 * state and wires its change callbacks back through a `SettingsSelectorHost`
 * seam. Self-mod/auto-learn validation, autonomy-preset application, autocomplete
 * rebuild, and the resources-hub hand-off stay host-side (shared with other
 * flows); interactive-mode keeps a thin wrapper building the host once.
 */

import type { Component, Container, EditorComponent, SelectItem, TUI } from "@caupulican/pi-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import { configureHttpDispatcher, formatHttpIdleTimeoutMs } from "../../core/http-dispatcher.ts";
import type {
	AutonomyMode,
	SelfModificationSettings,
	SettingsManager,
	SettingsScope,
} from "../../core/settings-manager.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import type { CustomEditor } from "./components/custom-editor.ts";
import type { FooterComponent } from "./components/footer.ts";
import { SettingsSelectorComponent } from "./components/settings-selector.ts";
import { ToolExecutionComponent } from "./components/tool-execution.ts";
import { ToolGroupComponent } from "./components/tool-group.ts";
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
	validateSelfModificationSource(settings: SelfModificationSettings): string | undefined;
	applyAutonomyMode(mode: AutonomyMode, scope?: SettingsScope): void;
	validateAutoLearnModelValue(value: string | undefined): string | undefined;
	updateAutoLearnFooter(): void;
	handleResourcesHubAction(action: string): Promise<void>;
}

export function showSettingsSelector(host: SettingsSelectorHost): void {
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
				collapseChangelog: host.settingsManager.getCollapseChangelog(),
				enableInstallTelemetry: host.settingsManager.getEnableInstallTelemetry(),
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
				modelRouterScope: projectSettings.modelRouter ? "project" : "global",
				autoLearn: host.settingsManager.getAutoLearnSettings(),
				autoLearnScope: projectSettings.autoLearn ? "project" : "global",
				autoLearnModelOptions: host.getAutoLearnModelOptions(),
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
			},
			{
				onAutoCompactChange: (enabled) => {
					host.session.setAutoCompactionEnabled(enabled);
					host.footer.setAutoCompactEnabled(enabled);
				},
				onShowImagesChange: (enabled) => {
					host.settingsManager.setShowImages(enabled);
					for (const child of host.chatContainer.children) {
						if (child instanceof ToolExecutionComponent || child instanceof ToolGroupComponent) {
							child.setShowImages(enabled);
						}
					}
					host.ui.requestRender();
				},
				onImageWidthCellsChange: (width) => {
					host.settingsManager.setImageWidthCells(width);
					for (const child of host.chatContainer.children) {
						if (child instanceof ToolExecutionComponent || child instanceof ToolGroupComponent) {
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
				onHideThinkingBlockChange: (hidden) => {
					host.hideThinkingBlock = hidden;
					host.settingsManager.setHideThinkingBlock(hidden);
					for (const child of host.chatContainer.children) {
						if (child instanceof AssistantMessageComponent) {
							child.setHideThinkingBlock(hidden);
						}
					}
					void host.rebuildChatFromMessages();
				},
				onCollapseChangelogChange: (collapsed) => {
					host.settingsManager.setCollapseChangelog(collapsed);
				},
				onEnableInstallTelemetryChange: (enabled) => {
					host.settingsManager.setEnableInstallTelemetry(enabled);
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
				onCancel: () => {
					done();
					host.ui.requestRender();
				},
			},
		);
		return { component: selector, focus: selector.getSettingsList() };
	});
}
