/**
 * Slash-command handlers for the interactive mode: the body of each `/command` the editor routes, the operator
 * command hosts those bodies use, the shortcut window, and the reload and extension-refresh paths. The mode builds the
 * SlashCommandHost port; the editor submit router calls these methods in its ordered dispatch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { EditorComponent, Keybinding, MarkdownTheme } from "@caupulican/pi-tui";
import { type Component, Container, type Loader, type OverlayHandle, Spacer, Text, type TUI } from "@caupulican/pi-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type { EdgeClass } from "../../core/autonomy/edge-policy.ts";
import {
	DEFAULT_GOAL_CONTINUE_MAX_STALL_TURNS,
	DEFAULT_GOAL_CONTINUE_MAX_TURNS,
	DEFAULT_GOAL_CONTINUE_MAX_WALL_CLOCK_MINUTES,
	MAX_GOAL_CONTINUE_MAX_STALL_TURNS,
	MAX_GOAL_CONTINUE_MAX_TURNS,
	MAX_GOAL_CONTINUE_MAX_WALL_CLOCK_MINUTES,
} from "../../core/goals/goal-continuation-defaults.ts";
import { configureHttpDispatcher } from "../../core/http-dispatcher.ts";
import type { AppKeybinding, KeybindingsManager } from "../../core/keybindings.ts";
import type { ManagedMemoryTarget } from "../../core/memory/providers/file-store.ts";
import { recordLessonCandidate } from "../../core/proof/lesson-candidates.ts";
import { AccountUsageMonitor } from "../../core/provider-admission/account-usage-monitor.ts";
import type { MissingSessionCwdError } from "../../core/session-cwd.ts";
import type { AutoLearnSettings, MemorySystem } from "../../core/settings/settings-schema.ts";
import type { SessionManager } from "../../kernel/node.ts";
import { keyDisplayText, keyText } from "../../presentation/keybinding-hints.ts";
import { theme } from "../../presentation/theme-model.ts";
import type { ActivityLaneComponent } from "./components/activity-lane.ts";
import type { BashExecutionComponent } from "./components/bash-execution.ts";
import { DynamicBorder } from "./components/dynamic-border.ts";
import type { FooterComponent } from "./components/footer.ts";
import { type ShortcutSection, ShortcutsWindow } from "./components/shortcuts-window.ts";
import { TreeSelectorComponent } from "./components/tree-selector.ts";
import * as configBackup from "./config-backup.ts";
import type { EditorOverlayHost } from "./editor-overlay-host.ts";
import type { ExtensionUiHost } from "./extension-ui-host.ts";
import type { InteractiveLayout } from "./interactive-layout.ts";
import type { LoadedResourcesViewOptions } from "./loaded-resources-view.ts";
import type { ProfileMenuController } from "./profile-menu-controller.ts";
import * as reportCommands from "./report-commands.ts";
import * as resourceShellCommands from "./resource-shell-commands.ts";
import { SecretMenuController } from "./secret-menu-controller.ts";
import * as sessionFlows from "./session-flow-commands.ts";
import * as sessionIoCommands from "./session-io-commands.ts";
import { handleSoulCommand } from "./soul-command.ts";
import { handleSystemPromptCommand } from "./system-prompt-command.ts";
import * as usageCommands from "./usage-commands.ts";

export interface SlashCommandHost {
	readonly runtimeHost: AgentSessionRuntime;
	readonly session: AgentSession;
	readonly sessionManager: SessionManager;
	readonly settingsManager: AgentSessionRuntime["services"]["settingsManager"];
	readonly modelRegistry: AgentSessionRuntime["services"]["modelRegistry"];
	readonly extensionRunner: AgentSessionRuntime["extensionRunner"];
	readonly ui: TUI;
	readonly chatContainer: Container;
	readonly statusContainer: Container;
	readonly editorContainer: Container;
	readonly pendingMessagesContainer: Container;
	readonly editor: EditorComponent;
	readonly footer: FooterComponent;
	readonly overlayHost: EditorOverlayHost;
	readonly keybindings: KeybindingsManager;
	readonly extensionUiHost: ExtensionUiHost;
	readonly profileMenu: ProfileMenuController;
	readonly layout: InteractiveLayout;
	readonly activityLane: ActivityLaneComponent | undefined;
	readonly hasHumanAudience: boolean;
	loadingAnimation: Loader | undefined;
	bashComponent: BashExecutionComponent | undefined;
	pendingBashComponents: BashExecutionComponent[];
	showStatus(message: string): void;
	showWarning(message: string): void;
	showError(message: string): void;
	showSelector(
		create: (done: () => void) => { component: Component; focus: Component; onSuperseded?: () => void },
	): void;
	refreshActivityLane(options?: { replace?: boolean }): void;
	refreshAutonomyFooterStatus(): void;
	renderCurrentSessionState(): void;
	handleNonFatalSessionReplacementError(error: unknown): "previous_restored" | "replacement_committed" | undefined;
	handleFatalRuntimeError(prefix: string, error: unknown): Promise<never>;
	promptForMissingSessionCwd(error: MissingSessionCwdError): Promise<string | undefined>;
	rebuildChatFromMessages(options?: { checkpointWhenDeferred?: boolean }): Promise<boolean>;
	refreshExtensionPresentation(): void;
	setupAutocompleteProvider(): void;
	showLoadedResources(options?: LoadedResourcesViewOptions): void;
	sessionFlowHost(): sessionFlows.SessionFlowHost;
	getCurrentAutoLearnSettings(): Required<AutoLearnSettings>;
	getMarkdownThemeWithSettings(): MarkdownTheme;
	getAppKeyDisplay(action: AppKeybinding): string;
}

export class SlashCommandController {
	private readonly host: SlashCommandHost;
	private usageMonitor: AccountUsageMonitor | undefined;
	private shortcutsHandle: OverlayHandle | undefined;

	constructor(host: SlashCommandHost) {
		this.host = host;
	}

	loadHost() {
		return {
			getLoadView: () => this.host.session.getProviderLoadView(),
			setEmergencyStop: (engaged: boolean, reason?: string) => this.host.session.setEmergencyStop(engaged, reason),
			...this.operatorCommandOutput(),
		};
	}

	verificationHost() {
		return {
			listVerificationFindings: () => this.host.session.listVerificationFindings(),
			waiveVerificationFindings: (ids: readonly string[] | "all", note: string) =>
				this.host.session.waiveVerificationFindings(ids, note),
			...this.operatorCommandOutput(),
		};
	}

	edgeHost() {
		return {
			getEdgeGrants: () => this.host.session.getEdgeGrants(),
			grantEdge: async (edgeClass: EdgeClass, note?: string) => {
				this.host.session.grantEdge(edgeClass, "operator", note ? { note } : {});
				this.host.refreshActivityLane();
			},
			revokeEdge: async (edgeClass: EdgeClass) => {
				const revoked = this.host.session.revokeEdge(edgeClass);
				this.host.refreshActivityLane();
				return revoked;
			},
			...this.operatorCommandOutput(),
		};
	}

	/** The three ways an operator-only command speaks: a status row, an error row, or a block in the conversation. */
	operatorCommandOutput() {
		return {
			showStatus: (message: string) => this.host.showStatus(message),
			showError: (message: string) => this.host.showError(message),
			showText: (body: string) => {
				this.host.chatContainer.addChild(new Spacer(1));
				this.host.chatContainer.addChild(new Text(body, 1, 0));
				this.host.ui.requestRender();
			},
		};
	}

	memoryCommandHost() {
		return {
			getTranscriptHistoryStatus: () => this.host.session.getTranscriptHistoryStatus(),
			getKnowledgeCollectionStatus: () => this.host.session.memoryOperator.getKnowledgeCollectionStatus(),
			memoryDriftReport: () => this.host.session.memoryOperator.memoryDriftReport(),
			memoryAcceptDrift: (target: ManagedMemoryTarget) => this.host.session.memoryOperator.memoryAcceptDrift(target),
			memoryRestoreManaged: (target: ManagedMemoryTarget) =>
				this.host.session.memoryOperator.memoryRestoreManaged(target),
			forgetHistorySession: (sessionId: string) => this.host.session.memoryOperator.forgetHistorySession(sessionId),
			repairHistoryForgetState: () => this.host.session.memoryOperator.repairHistoryForgetState(),
			getMemorySystem: () => this.host.session.getMemorySystem(),
			setMemorySystem: (system: MemorySystem) => this.host.session.setMemorySystem(system),
			...this.operatorCommandOutput(),
		};
	}

	verifyHost() {
		return {
			getVerificationObligations: () => this.host.session.getVerificationObligations(),
			dismissVerificationObligations: (ids: readonly string[], note?: string) =>
				this.host.session.dismissVerificationObligations(ids, note),
			...this.operatorCommandOutput(),
		};
	}

	handleSecretsCommand(): Promise<void> {
		if (!this.host.hasHumanAudience) {
			this.host.showWarning("/secrets requires an owner-controlled interactive terminal.");
			return Promise.resolve();
		}
		const controller = new SecretMenuController({
			manager: this.host.session.credentialManager,
			cwd: this.host.sessionManager.getCwd(),
		});
		return controller.open(this.host.extensionUiHost.createExtensionUIContext());
	}

	handleProfilesCommand(profileName?: string): Promise<void> {
		return this.host.profileMenu.handleProfilesCommand(profileName);
	}

	async handleModelCommand(searchTerm?: string): Promise<void> {
		await sessionFlows.handleModelCommand(this.host.sessionFlowHost(), searchTerm);
	}

	async handleThinkingCommand(arg?: string): Promise<void> {
		await sessionFlows.handleThinkingCommand(this.host.sessionFlowHost(), arg);
	}

	/**
	 * Open the Models editor and resolve once it leaves the screen: "closed" when the operator
	 * closed it, "superseded" when another overlay took the slot first. The flow's own promise only
	 * covers mounting the selector, so the close signal is taken from the `done` callback the flow
	 * hands its component.
	 */
	async showModelsSelector(): Promise<"closed" | "superseded"> {
		let settle: (outcome: "closed" | "superseded") => void = () => {};
		const left = new Promise<"closed" | "superseded">((resolve) => {
			settle = resolve;
		});
		let mounted = false;
		const host = this.host.sessionFlowHost();
		host.showSelector = (create) => {
			mounted = true;
			this.host.showSelector((done) => {
				const selector = create(() => {
					done();
					settle("closed");
				});
				return { ...selector, onSuperseded: () => settle("superseded") };
			});
		};
		await sessionFlows.showModelsSelector(host);
		// Nothing was mounted (no models to edit): there is no editor to wait for.
		return mounted ? await left : "closed";
	}

	async handleCloneCommand(newSessionName?: string): Promise<void> {
		await sessionFlows.handleCloneCommand(
			{
				sessionManager: this.host.sessionManager,
				runtimeHost: this.host.runtimeHost,
				renderCurrentSessionState: () => this.host.renderCurrentSessionState(),
				editor: this.host.editor,
				session: this.host.session,
				showStatus: (message) => this.host.showStatus(message),
				showError: (message) => this.host.showError(message),
				ui: this.host.ui,
			},
			newSessionName,
		);
	}

	async handleReloadCommand(): Promise<void> {
		await this.handleReloadCommandWithResult();
	}

	/** Reload and report whether the previous runtime was replaced successfully. */
	async handleReloadCommandWithResult(): Promise<boolean> {
		if (this.host.session.isStreaming) {
			this.host.showWarning("Wait for the current response to finish before reloading.");
			return false;
		}
		if (this.host.session.isCompacting) {
			this.host.showWarning("Wait for compaction to finish before reloading.");
			return false;
		}

		this.host.extensionUiHost.resetExtensionUI();

		const reloadBox = new Container();
		const borderColor = (s: string) => theme.fg("border", s);
		reloadBox.addChild(new DynamicBorder(borderColor));
		reloadBox.addChild(new Spacer(1));
		reloadBox.addChild(
			new Text(theme.fg("muted", "Reloading keybindings, extensions, skills, prompts, themes..."), 1, 0),
		);
		reloadBox.addChild(new Spacer(1));
		reloadBox.addChild(new DynamicBorder(borderColor));

		const previousEditor = this.host.editor;
		let reloadBoxActive = true;
		this.host.overlayHost.swap(reloadBox, {
			render: "sync",
			onUnmount: () => {
				reloadBoxActive = false;
			},
		});
		// Let the terminal paint the reload notice before CPU-heavy extension/theme
		// work begins. process.nextTick runs before I/O and can still make reloads
		// appear frozen.
		await new Promise((resolve) => setImmediate(resolve));

		const dismissReloadBox = (editor: Component) => {
			if (!reloadBoxActive) return;
			reloadBoxActive = false;
			this.host.overlayHost.swap(editor);
		};

		try {
			await this.host.session.reload();
			configureHttpDispatcher(this.host.settingsManager.getHttpIdleTimeoutMs());
			this.host.keybindings.reload();
			this.host.refreshExtensionPresentation();
			this.host.ui.setShowHardwareCursor(this.host.settingsManager.getShowHardwareCursor());
			this.host.ui.setClearOnShrink(this.host.settingsManager.getClearOnShrink());
			this.host.setupAutocompleteProvider();
			const runner = this.host.extensionRunner;
			this.host.extensionUiHost.setupExtensionShortcuts(runner);
			await this.host.rebuildChatFromMessages();
			dismissReloadBox(this.host.editor as Component);
			this.host.showLoadedResources({
				force: false,
				showDiagnosticsWhenQuiet: true,
			});
			const modelsJsonError = this.host.modelRegistry.getError();
			if (modelsJsonError) {
				this.host.showError(`models.json error: ${modelsJsonError}`);
			}
			this.host.showStatus("Reloaded keybindings, extensions, skills, prompts, themes");
			return true;
		} catch (error) {
			dismissReloadBox(previousEditor as Component);
			this.host.showError(`Reload failed: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}

	/**
	 * Refresh UI after extensions are loaded/unloaded live.
	 * Performs the same refresh calls as handleReloadCommand but without the full reload.
	 */
	async refreshUIAfterExtensionsChanged(): Promise<void> {
		try {
			// Refresh keybindings and autocomplete
			this.host.keybindings.reload();
			this.host.setupAutocompleteProvider();

			this.host.refreshExtensionPresentation();

			// Refresh extension shortcuts
			const runner = this.host.extensionRunner;
			this.host.extensionUiHost.setupExtensionShortcuts(runner);

			// Refresh chat and UI
			await this.host.rebuildChatFromMessages();
			this.host.footer.invalidate();
			this.host.ui.requestRender();
		} catch (error) {
			this.host.showError(`Extension refresh failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	handleExportCommand(text: string): Promise<void> {
		return sessionIoCommands.handleExportCommand(
			{
				session: this.host.session,
				getPathCommandArgument: (t, command) => this.getPathCommandArgument(t, command),
				showStatus: (message) => this.host.showStatus(message),
				showError: (message) => this.host.showError(message),
			},
			text,
		);
	}

	getPathCommandArgument(text: string, command: "/export" | "/import"): string | undefined {
		if (text === command) {
			return undefined;
		}
		if (!text.startsWith(`${command} `)) {
			return undefined;
		}

		const argsString = text.slice(command.length + 1).trimStart();
		if (!argsString) {
			return undefined;
		}

		const firstChar = argsString[0];
		if (firstChar === '"' || firstChar === "'") {
			const closingQuoteIndex = argsString.indexOf(firstChar, 1);
			if (closingQuoteIndex < 0) {
				return undefined;
			}
			return argsString.slice(1, closingQuoteIndex);
		}

		const firstWhitespaceIndex = argsString.search(/\s/);
		if (firstWhitespaceIndex < 0) {
			return argsString;
		}
		return argsString.slice(0, firstWhitespaceIndex);
	}

	handleImportCommand(text: string): Promise<void> {
		const host = this.host;
		return sessionIoCommands.handleImportCommand(
			{
				getPathCommandArgument: (t, command) => this.getPathCommandArgument(t, command),
				showError: (message) => this.host.showError(message),
				showStatus: (message) => this.host.showStatus(message),
				extensionUiHost: this.host.extensionUiHost,
				get loadingAnimation() {
					return host.loadingAnimation;
				},
				set loadingAnimation(value) {
					host.loadingAnimation = value;
				},
				statusContainer: this.host.statusContainer,
				runtimeHost: this.host.runtimeHost,
				renderCurrentSessionState: () => this.host.renderCurrentSessionState(),
				promptForMissingSessionCwd: (error) => this.host.promptForMissingSessionCwd(error),
				handleFatalRuntimeError: (prefix, error) => this.host.handleFatalRuntimeError(prefix, error),
			},
			text,
		);
	}

	handleShareCommand(): Promise<void> {
		return sessionIoCommands.handleShareCommand({
			showError: (message) => this.host.showError(message),
			showStatus: (message) => this.host.showStatus(message),
			session: this.host.session,
			ui: this.host.ui,
			overlayHost: this.host.overlayHost,
			editor: this.host.editor,
		});
	}

	handleCopyCommand(): Promise<void> {
		return sessionIoCommands.handleCopyCommand({
			session: this.host.session,
			showError: (message) => this.host.showError(message),
			showStatus: (message) => this.host.showStatus(message),
			getSelectionText: () => {
				const activeOverlay = this.host.editorContainer.children[0];
				return activeOverlay instanceof TreeSelectorComponent
					? activeOverlay.getSelectedCopyText()
					: activeOverlay === this.host.editor
						? this.host.layout.workbench?.view.conversation.selectionText()
						: undefined;
			},
		});
	}

	handleNameCommand(text: string): void {
		sessionIoCommands.handleNameCommand(
			{
				sessionManager: this.host.sessionManager,
				chatContainer: this.host.chatContainer,
				showWarning: (message) => this.host.showWarning(message),
				session: this.host.session,
				ui: this.host.ui,
			},
			text,
		);
	}

	parseGoalContinueCommand(
		text: string,
	):
		| { ok: true; maxTurns: number; maxStallTurns: number; maxWallClockMinutes: number }
		| { ok: false; error: string } {
		const usage = "Usage: /goal-continue [maxTurns 0=unbounded] [maxStallTurns 0-100] [maxMinutes 0-1440]";
		const parts = text.trim().split(/\s+/).slice(1);
		if (parts.length > 3) {
			return { ok: false, error: usage };
		}

		const parseBoundedInteger = (
			value: string | undefined,
			fallback: number,
			min: number,
			max: number,
		): number | undefined => {
			if (value === undefined || value.length === 0) return fallback;
			if (!/^\d+$/.test(value)) return undefined;
			const parsed = Number.parseInt(value, 10);
			if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return undefined;
			return parsed;
		};

		const maxTurns = parseBoundedInteger(parts[0], DEFAULT_GOAL_CONTINUE_MAX_TURNS, 0, MAX_GOAL_CONTINUE_MAX_TURNS);
		const maxStallTurns = parseBoundedInteger(
			parts[1],
			DEFAULT_GOAL_CONTINUE_MAX_STALL_TURNS,
			0,
			MAX_GOAL_CONTINUE_MAX_STALL_TURNS,
		);
		const maxWallClockMinutes = parseBoundedInteger(
			parts[2],
			DEFAULT_GOAL_CONTINUE_MAX_WALL_CLOCK_MINUTES,
			0,
			MAX_GOAL_CONTINUE_MAX_WALL_CLOCK_MINUTES,
		);
		if (maxTurns === undefined || maxStallTurns === undefined || maxWallClockMinutes === undefined) {
			return { ok: false, error: usage };
		}
		return { ok: true, maxTurns, maxStallTurns, maxWallClockMinutes };
	}

	async handleGoalCommand(text: string): Promise<void> {
		let statusMessage: string | undefined;
		await sessionFlows.handleGoalCommand(
			{
				session: this.host.session,
				promptForGoalEdit: (currentObjective) =>
					this.host.extensionUiHost.showExtensionEditor("Edit goal objective", currentObjective),
				recordLessonCandidate: (entry) =>
					recordLessonCandidate(
						this.host.runtimeHost.services.agentDir,
						{ ...entry, sessionId: this.host.sessionManager.getSessionId() },
						(message) => this.host.showWarning(message),
					),
				getMaxStallTurns: () => this.host.settingsManager?.getAutonomySettings().maxStallTurns ?? 20,
				showStatus: (message) => {
					statusMessage = message;
				},
				showError: (message) => this.host.showError(message),
				refreshAutonomyFooterStatus: () => this.host.refreshAutonomyFooterStatus(),
			},
			text,
		);
		this.host.refreshActivityLane?.();
		if (statusMessage) this.host.activityLane?.announce(statusMessage, "neutral");
	}

	/** The editor panel and status surface shared by the owner commands that edit text verbatim. */
	ownerTextCommandSurface() {
		return {
			promptForEdit: (title: string, prefill: string) =>
				this.host.extensionUiHost.showExtensionEditor(title, prefill, { exactText: true }),
			showStatus: (message: string) => this.host.showStatus(message),
			showError: (message: string) => this.host.showError(message),
		};
	}

	async handleSoulCommand(text: string): Promise<void> {
		await handleSoulCommand({ soul: this.host.session.soul, ...this.ownerTextCommandSurface() }, text);
	}

	async handleSystemPromptCommand(text: string): Promise<void> {
		await handleSystemPromptCommand(
			{ prompt: this.host.session.ownerSystemPrompt, ...this.ownerTextCommandSurface() },
			text,
		);
	}

	handleTaskCommand(text: string): void {
		let statusMessage: string | undefined;
		sessionFlows.handleTaskCommand(
			{
				session: this.host.session,
				showStatus: (message) => {
					statusMessage = message;
				},
				showError: (message) => this.host.showError(message),
			},
			text,
		);
		this.host.refreshActivityLane?.();
		const state = this.host.session.getTaskStepsStateSnapshot();
		if ((!state || state.steps.length === 0 || statusMessage?.startsWith("/task ")) && statusMessage) {
			this.host.activityLane?.announce(statusMessage, "neutral");
		}
	}

	async handleGoalContinueCommand(text: string): Promise<void> {
		await sessionFlows.handleGoalContinueCommand(
			{
				session: this.host.session,
				parseGoalContinueCommand: (t) => this.parseGoalContinueCommand(t),
				showStatus: (message) => this.host.activityLane?.announce(message),
				showError: (message) => this.host.showError(message),
				refreshAutonomyFooterStatus: () => this.host.refreshAutonomyFooterStatus(),
			},
			text,
		);
		this.host.refreshActivityLane?.();
	}

	handleSessionCommand(): void {
		sessionFlows.handleSessionCommand({
			session: this.host.session,
			sessionManager: this.host.sessionManager,
			chatContainer: this.host.chatContainer,
			ui: this.host.ui,
		});
	}

	async handleSelfCompactNowCommand(): Promise<void> {
		try {
			const outcome = await this.host.session.selfCompactNow();
			if (outcome.kind === "refused") this.host.showError(`Self-compaction: ${outcome.reason}.`);
			else if (outcome.kind === "resumed")
				this.host.showStatus(
					`Self-compaction: compacting with the saved note (${outcome.noteChars.toLocaleString("en-US")} chars).`,
				);
			else this.host.showStatus("Self-compaction: asked the agent to write its note and compact.");
		} catch (error) {
			this.host.showError(`Self-compaction failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	handleUsageCommand(): void {
		reportCommands.handleUsageCommand({
			session: this.host.session,
			settingsManager: this.host.settingsManager,
			modelRegistry: this.host.modelRegistry,
			chatContainer: this.host.chatContainer,
			ui: this.host.ui,
			getCurrentAutoLearnSettings: () => this.host.getCurrentAutoLearnSettings(),
		});
	}

	handleUsageMenuCommand(text: string): void {
		this.usageMonitor ??= new AccountUsageMonitor();
		usageCommands.handleUsageMenuCommand(
			{
				modelRegistry: this.host.modelRegistry,
				session: this.host.session,
				usageMonitor: this.usageMonitor,
				showSelector: (create) => this.host.showSelector(create),
				showStatus: (message) => this.host.showStatus(message),
				showError: (message) => this.host.showError(message),
				requestRender: () => this.host.ui.requestRender(),
				terminalRows: () => this.host.ui.terminal.rows,
			},
			text,
		);
	}

	handleChangelogCommand(): void {
		reportCommands.handleChangelogCommand({
			chatContainer: this.host.chatContainer,
			ui: this.host.ui,
			getMarkdownThemeWithSettings: () => this.host.getMarkdownThemeWithSettings(),
		});
	}

	/**
	 * Get capitalized display string for an editor keybinding action.
	 */
	getEditorKeyDisplay(action: Keybinding): string {
		return keyDisplayText(action);
	}

	handleHotkeysCommand(): void {
		reportCommands.handleHotkeysCommand({
			extensionRunner: this.host.extensionRunner,
			keybindings: this.host.keybindings,
			chatContainer: this.host.chatContainer,
			ui: this.host.ui,
			showShortcuts: (sections) => this.showShortcutsWindow(sections),
			getAppKeyDisplay: (action) => this.host.getAppKeyDisplay(action),
			getEditorKeyDisplay: (action) => this.getEditorKeyDisplay(action),
		});
	}

	/** The shortcuts as a floating window over the conversation, closed by escape or the key that opened it. */
	showShortcutsWindow(sections: readonly ShortcutSection[]): void {
		this.shortcutsHandle?.hide();
		const window = new ShortcutsWindow({
			sections,
			viewportRows: () => this.host.ui.terminal.rows,
			closeLabel: keyText("app.shortcuts.show"),
			isCloseKey: (data) => this.host.keybindings.matches(data, "app.shortcuts.show"),
			requestRender: () => this.host.ui.requestRender(),
			onClose: () => this.shortcutsHandle?.hide(),
		});
		this.shortcutsHandle = this.host.ui.showOverlay(window, {
			anchor: "center",
			width: Math.min(92, Math.max(40, this.host.ui.terminal.columns - 8)),
			minWidth: 40,
			maxHeight: "85%",
			onRemove: () => {
				this.shortcutsHandle = undefined;
			},
		});
	}

	async handleClearCommand(newSessionName?: string): Promise<void> {
		if (this.host.loadingAnimation) {
			this.host.loadingAnimation.stop();
			this.host.loadingAnimation = undefined;
		}
		this.host.statusContainer.clear();
		try {
			const result = await this.host.runtimeHost.newSession();
			if (result.cancelled) {
				return;
			}
			this.host.renderCurrentSessionState();
			if (newSessionName) {
				this.host.session.setSessionName(newSessionName);
			}
			this.host.chatContainer.addChild(new Spacer(1));
			const label = newSessionName ? `✓ New session started: ${newSessionName}` : "✓ New session started";
			this.host.chatContainer.addChild(new Text(`${theme.fg("accent", label)}`, 1, 1));
			this.host.ui.requestRender();
		} catch (error: unknown) {
			if (this.host.handleNonFatalSessionReplacementError(error)) return;
			await this.host.handleFatalRuntimeError("Failed to create session", error);
		}
	}

	copyResourcesRecursively(
		src: string,
		dest: string,
		force: boolean,
		stats: { installed: string[]; skipped: string[] },
	): void {
		if (!fs.existsSync(src)) return;

		const entries = fs.readdirSync(src, { withFileTypes: true });
		fs.mkdirSync(dest, { recursive: true });

		for (const entry of entries) {
			const srcPath = path.join(src, entry.name);
			const destPath = path.join(dest, entry.name);

			if (entry.isDirectory()) {
				this.copyResourcesRecursively(srcPath, destPath, force, stats);
			} else if (entry.isFile()) {
				if (fs.existsSync(destPath) && !force) {
					stats.skipped.push(destPath);
				} else {
					fs.copyFileSync(srcPath, destPath);
					stats.installed.push(destPath);
				}
			}
		}
	}

	handleInstallResourcesCommand(argsString: string): Promise<void> {
		return resourceShellCommands.handleInstallResourcesCommand(
			{
				settingsManager: this.host.settingsManager,
				showError: (message) => this.host.showError(message),
				showStatus: (message) => this.host.showStatus(message),
				showSelector: (create) => this.host.showSelector(create),
				handleReloadCommand: () => this.handleReloadCommand(),
				copyResourcesRecursively: (src, dest, force, stats) =>
					this.copyResourcesRecursively(src, dest, force, stats),
			},
			argsString,
		);
	}

	/**
	 * `/curate` — skill curator (#32). With no args, lists reflection-promoted skills proposed for
	 * archival (stale/unused) and pairs proposed for consolidation (overlapping). PROPOSE-ONLY: the user
	 * applies actions explicitly via `/curate archive <name>` / `/curate restore <name>`. Never touches
	 * hand-authored skills; archival is restorable.
	 */
	handleCurateCommand(args: string): void {
		resourceShellCommands.handleCurateCommand(
			{
				session: this.host.session,
				showStatus: (message) => this.host.showStatus(message),
			},
			args,
		);
	}

	async handleConfigBackupCommand(fileArg?: string): Promise<void> {
		await configBackup.handleConfigBackupCommand(
			{
				settingsManager: this.host.settingsManager,
				showStatus: (message) => this.host.showStatus(message),
				showError: (message) => this.host.showError(message),
			},
			fileArg,
		);
	}

	async handleConfigRestoreCommand(fileArg: string): Promise<void> {
		await configBackup.handleConfigRestoreCommand(
			{
				settingsManager: this.host.settingsManager,
				showStatus: (message) => this.host.showStatus(message),
				showError: (message) => this.host.showError(message),
				showSelector: (create) => this.host.showSelector(create),
				handleReloadCommand: () => this.handleReloadCommandWithResult(),
			},
			fileArg,
		);
	}

	handleDebugCommand(): void {
		reportCommands.handleDebugCommand({
			session: this.host.session,
			chatContainer: this.host.chatContainer,
			ui: this.host.ui,
		});
	}

	handleArminSaysHi(): void {
		reportCommands.handleArminSaysHi({ chatContainer: this.host.chatContainer, ui: this.host.ui });
	}

	handleDementedDelves(): void {
		reportCommands.handleDementedDelves({ chatContainer: this.host.chatContainer, ui: this.host.ui });
	}

	handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
		const host = this.host;
		return resourceShellCommands.handleBashCommand(
			{
				session: this.host.session,
				extensionRunner: this.host.extensionRunner,
				sessionManager: this.host.sessionManager,
				ui: this.host.ui,
				chatContainer: this.host.chatContainer,
				pendingMessagesContainer: this.host.pendingMessagesContainer,
				pendingBashComponents: this.host.pendingBashComponents,
				get bashComponent() {
					return host.bashComponent;
				},
				set bashComponent(value) {
					host.bashComponent = value;
				},
				showError: (message) => this.host.showError(message),
			},
			command,
			excludeFromContext,
		);
	}

	handleCompactCommand(customInstructions?: string): Promise<void> {
		return resourceShellCommands.handleCompactCommand(
			{
				sessionManager: this.host.sessionManager,
				showWarning: (message) => this.host.showWarning(message),
				session: this.host.session,
			},
			customInstructions,
		);
	}
}
