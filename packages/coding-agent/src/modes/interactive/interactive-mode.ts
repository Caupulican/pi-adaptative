/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core";
import { createCompactionSummaryMessage } from "@caupulican/pi-agent-core";
import type { SessionContext, SessionManager, TruncationResult } from "@caupulican/pi-agent-core/node";
import type { AssistantMessage, ImageContent, Message, Model } from "@caupulican/pi-ai";
import type { AutocompleteProvider, EditorComponent, Keybinding, MarkdownTheme, SelectItem } from "@caupulican/pi-tui";
import {
	type Component,
	Container,
	Loader,
	type LoaderIndicatorOptions,
	ProcessTerminal,
	Spacer,
	setKeybindings,
	Text,
	TruncatedText,
	TUI,
} from "@caupulican/pi-tui";
import { APP_NAME, APP_TITLE, VERSION } from "../../config.ts";
import { type AgentSession, type AgentSessionEvent, parseSkillBlock } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type {
	AutocompleteProviderFactory,
	ExtensionCommandContext,
	ExtensionRunner,
} from "../../core/extensions/index.ts";
import { FooterDataProvider } from "../../core/footer-data-provider.ts";
import {
	DEFAULT_GOAL_CONTINUE_MAX_STALL_TURNS,
	DEFAULT_GOAL_CONTINUE_MAX_TURNS,
	DEFAULT_GOAL_CONTINUE_MAX_WALL_CLOCK_MINUTES,
	MAX_GOAL_CONTINUE_MAX_STALL_TURNS,
	MAX_GOAL_CONTINUE_MAX_TURNS,
	MAX_GOAL_CONTINUE_MAX_WALL_CLOCK_MINUTES,
} from "../../core/goals/goal-continuation-defaults.ts";
import { configureHttpDispatcher } from "../../core/http-dispatcher.ts";
import { type AppKeybinding, KeybindingsManager } from "../../core/keybindings.ts";
import type { OllamaRuntime } from "../../core/models/local-runtime.ts";
import type { ResourceDiagnostic } from "../../core/resource-loader.ts";
import { formatMissingSessionCwdPrompt, type MissingSessionCwdError } from "../../core/session-cwd.ts";
import type {
	AutoLearnSettings,
	AutonomyMode,
	SelfModificationSettings,
	SettingsScope,
} from "../../core/settings-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.ts";
import type { SourceInfo } from "../../core/source-info.ts";
import { getCwdRelativePath, resolvePath } from "../../utils/paths.ts";
import { ensureTool } from "../../utils/tools-manager.ts";
import { checkForNewPiVersion, type LatestPiRelease } from "../../utils/version-check.ts";
import { AuthDialogsController } from "./auth-dialogs-controller.ts";
import { AutoLearnController, type AutoLearnState } from "./auto-learn-controller.ts";
import * as autocompleteProvider from "./autocomplete-provider.ts";
import * as autonomyCommands from "./autonomy-commands.ts";
import * as clipboardInput from "./clipboard-input.ts";
import * as compactionQueue from "./compaction-queue.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { BashExecutionComponent } from "./components/bash-execution.ts";
import { BranchSummaryMessageComponent } from "./components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.ts";
import { CountdownTimer } from "./components/countdown-timer.ts";
import { CustomEditor } from "./components/custom-editor.ts";
import { CustomMessageComponent } from "./components/custom-message.ts";
import { DynamicBorder } from "./components/dynamic-border.ts";
import type { FitnessRole } from "./components/fitness-role-selector.ts";
import { FooterComponent } from "./components/footer.ts";
import { formatKeyText, keyDisplayText, keyHint, keyText, rawKeyHint } from "./components/keybinding-hints.ts";
import { SkillInvocationMessageComponent } from "./components/skill-invocation-message.ts";
import { ToolExecutionComponent } from "./components/tool-execution.ts";
import { ToolGroupComponent } from "./components/tool-group.ts";
import {
	getToolPanelActionKey,
	getToolPanelResultActionKeys,
	shouldReuseToolPanelInPlace,
	ToolPanelRegistry,
} from "./components/tool-panel-registry.ts";
import { UserMessageComponent } from "./components/user-message.ts";
import * as configBackup from "./config-backup.ts";
import { EditorOverlayHost } from "./editor-overlay-host.ts";
import { ExtensionUiHost } from "./extension-ui-host.ts";
import { openEditorForPath, openExternalEditor } from "./external-editor.ts";
import * as historyReloadMath from "./history-reload-math.ts";
import * as keyHandlers from "./key-handlers.ts";
import * as localModelCommands from "./local-model-commands.ts";
import { ProfileMenuController } from "./profile-menu-controller.ts";
import * as reportCommands from "./report-commands.ts";
import * as resourceDisplay from "./resource-display.ts";
import * as resourceShellCommands from "./resource-shell-commands.ts";
import * as sessionFlows from "./session-flow-commands.ts";
import * as sessionIoCommands from "./session-io-commands.ts";
import * as settingsSelectorFlow from "./settings-selector-flow.ts";
import * as signalLifecycle from "./signal-lifecycle.ts";
import * as startupChecks from "./startup-checks.ts";
import {
	getEditorTheme,
	getMarkdownTheme,
	initTheme,
	onThemeChange,
	setRegisteredThemes,
	setTheme,
	stopThemeWatcher,
	type ThemeColor,
	theme,
} from "./theme/theme.ts";

const TUI_HISTORY_RELOAD_CHUNK_SIZE = 20;
const TUI_LIVE_HISTORY_MAX_COMPONENTS = 260;
const TUI_LIVE_HISTORY_TRIM_TO_COMPONENTS = 220;
const STREAMING_UI_UPDATE_INTERVAL_MS = 80;

/** Interface for components that can be expanded/collapsed */
interface Expandable {
	setExpanded(expanded: boolean): void;
}

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

class ExpandableText extends Text implements Expandable {
	private readonly getCollapsedText: () => string;
	private readonly getExpandedText: () => string;

	constructor(
		getCollapsedText: () => string,
		getExpandedText: () => string,
		expanded = false,
		paddingX = 0,
		paddingY = 0,
	) {
		super(expanded ? getExpandedText() : getCollapsedText(), paddingX, paddingY);
		this.getCollapsedText = getCollapsedText;
		this.getExpandedText = getExpandedText;
	}

	setExpanded(expanded: boolean): void {
		this.setText(expanded ? this.getExpandedText() : this.getCollapsedText());
	}
}

type UserInputSubmission = {
	text: string;
	images?: ImageContent[];
};

type PendingClipboardImage = {
	label: string;
	content: ImageContent;
};

type CompactionQueuedMessage = {
	text: string;
	mode: "steer" | "followUp";
	images?: ImageContent[];
};

const ANTHROPIC_SUBSCRIPTION_AUTH_WARNING =
	"Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage.";

function isAnthropicSubscriptionAuthKey(apiKey: string | undefined): boolean {
	return typeof apiKey === "string" && apiKey.startsWith("sk-ant-oat");
}

function quoteIfNeeded(value: string): string {
	if (value.length > 0 && !/[^a-zA-Z0-9_\-./~:@]/.test(value)) {
		return value;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function formatResumeCommand(sessionManager: SessionManager): string | undefined {
	if (!process.stdout.isTTY) return undefined;
	if (!sessionManager.isPersisted()) return undefined;

	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile || !fs.existsSync(sessionFile)) return undefined;

	const args = [APP_NAME];
	if (!sessionManager.usesDefaultSessionDir()) {
		args.push("--session-dir", quoteIfNeeded(sessionManager.getSessionDir()));
	}
	args.push("--session", sessionManager.getSessionId());
	return args.join(" ");
}

/**
 * Options for InteractiveMode initialization.
 */
export interface InteractiveModeOptions {
	/** Providers that were migrated to auth.json (shows warning) */
	migratedProviders?: string[];
	/** Warning message if session model couldn't be restored */
	modelFallbackMessage?: string;
	/** Initial message to send on startup (can include @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** Additional messages to send after the initial message */
	initialMessages?: string[];
	/** Force verbose startup (overrides quietStartup setting) */
	verbose?: boolean;
}

export class InteractiveMode {
	private runtimeHost: AgentSessionRuntime;
	private ui: TUI;
	private chatContainer: Container;
	private pendingMessagesContainer: Container;
	private statusContainer: Container;
	private defaultEditor: CustomEditor;
	private editor: EditorComponent;
	private autocompleteProvider: AutocompleteProvider | undefined;
	private autocompleteProviderWrappers: AutocompleteProviderFactory[] = [];
	private fdPath: string | undefined;
	private editorContainer: Container;
	private overlayHost: EditorOverlayHost;
	private footer: FooterComponent;
	private footerDataProvider: FooterDataProvider;
	private autoLearnController: AutoLearnController;
	private profileMenu: ProfileMenuController;
	private authDialogs: AuthDialogsController;
	private extensionUiHost: ExtensionUiHost;
	// Stored so the same manager can be injected into custom editors, selectors, and extension UI.
	private keybindings: KeybindingsManager;
	private version: string;
	private isInitialized = false;
	private onInputCallback?: (submission: UserInputSubmission) => void;
	private pendingUserInputs: UserInputSubmission[] = [];
	private pendingClipboardImages: PendingClipboardImage[] = [];
	private clipboardImageCounter = 0;
	private loadingAnimation: Loader | undefined = undefined;
	private workingMessage: string | undefined = undefined;
	private workingVisible = true;
	private workingIndicatorOptions: LoaderIndicatorOptions | undefined = undefined;
	private readonly defaultWorkingMessage = "Working...";
	private readonly defaultHiddenThinkingLabel = "Thinking...";
	private hiddenThinkingLabel = this.defaultHiddenThinkingLabel;

	private lastSigintTime = 0;
	private lastEscapeTime = 0;
	private changelogMarkdown: string | undefined = undefined;
	private startupNoticesShown = false;
	private anthropicSubscriptionWarningShown = false;

	// Status line tracking (for mutating immediately-sequential status updates)
	private lastStatusSpacer: Spacer | undefined = undefined;
	private lastStatusText: Text | undefined = undefined;

	// Live TUI history cap. Full session history remains in SessionManager/model state.
	private liveHistoryHiddenNotice: Text | undefined = undefined;
	private liveHistoryHiddenComponents = 0;
	private tuiHistoryLoaded = false;
	private tuiHistoryLoadInProgress = false;

	// Streaming message tracking
	private streamingComponent: AssistantMessageComponent | undefined = undefined;
	private streamingMessage: AssistantMessage | undefined = undefined;
	private streamingUiUpdateTimer: ReturnType<typeof setTimeout> | undefined = undefined;
	private lastStreamingUiUpdateAt = 0;

	// Tool execution tracking and session-scoped reusable panels
	private toolPanels = new ToolPanelRegistry();

	// Tool output expansion state
	private toolOutputExpanded = false;

	// Thinking block visibility state
	private hideThinkingBlock = false;

	// Skill commands: command name -> skill file path
	private skillCommands = new Map<string, string>();

	// Agent subscription unsubscribe function
	private unsubscribe?: () => void;
	private unsubscribeExtensionsChanged?: () => void;
	private signalCleanupHandlers: Array<() => void> = [];

	// Track if editor is in bash mode (text starts with !)
	private isBashMode = false;

	// Track current bash execution component
	private bashComponent: BashExecutionComponent | undefined = undefined;

	// Track pending bash components (shown in pending area, moved to chat on submit)
	private pendingBashComponents: BashExecutionComponent[] = [];

	// Auto-compaction state
	private autoCompactionLoader: Loader | undefined = undefined;
	private autoCompactionEscapeHandler?: () => void;

	// Auto-retry state
	private retryLoader: Loader | undefined = undefined;
	private retryCountdown: CountdownTimer | undefined = undefined;
	private retryEscapeHandler?: () => void;

	// Messages queued while compaction is running
	private compactionQueuedMessages: CompactionQueuedMessage[] = [];

	// Shutdown state
	private shutdownRequested = false;

	// Extension widget containers (hold components rendered above/below the editor)
	private widgetContainerAbove!: Container;
	private widgetContainerBelow!: Container;

	// Header container that holds the built-in or custom header
	private headerContainer: Container;

	// Built-in header (logo + keybinding hints + changelog)
	private builtInHeader: Component | undefined = undefined;

	private options: InteractiveModeOptions;

	// Convenience accessors
	private get session(): AgentSession {
		return this.runtimeHost.session;
	}
	private get agent() {
		return this.session.agent;
	}
	private get sessionManager() {
		return this.session.sessionManager;
	}
	private get settingsManager() {
		return this.session.settingsManager;
	}

	constructor(runtimeHost: AgentSessionRuntime, options: InteractiveModeOptions = {}) {
		this.runtimeHost = runtimeHost;
		this.options = options;
		this.runtimeHost.setBeforeSessionInvalidate(() => {
			this.extensionUiHost.resetExtensionUI();
		});
		this.runtimeHost.setRebindSession(async () => {
			await this.rebindCurrentSession();
		});
		this.version = VERSION;
		this.ui = new TUI(new ProcessTerminal(), this.settingsManager.getShowHardwareCursor());
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
		this.headerContainer = new Container();
		this.chatContainer = new Container();
		this.pendingMessagesContainer = new Container();
		this.statusContainer = new Container();
		this.widgetContainerAbove = new Container();
		this.widgetContainerBelow = new Container();
		this.keybindings = KeybindingsManager.create();
		setKeybindings(this.keybindings);
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
			paddingX: editorPaddingX,
			autocompleteMaxVisible,
		});
		this.editor = this.defaultEditor;
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor as Component);
		this.overlayHost = new EditorOverlayHost(this.editorContainer, this.ui);
		this.footerDataProvider = new FooterDataProvider(this.sessionManager.getCwd());
		this.footer = new FooterComponent(this.session, this.footerDataProvider);
		this.autoLearnController = new AutoLearnController({
			getSession: () => this.runtimeHost.session,
			resolveSelfModificationSource: (settings) => this.resolveSelfModificationSource(settings),
			ui: {
				showStatus: (message) => this.showStatus(message),
				footerDataProvider: this.footerDataProvider,
				invalidateFooter: () => this.footer.invalidate(),
				requestRender: () => this.ui.requestRender(),
			},
		});
		this.profileMenu = new ProfileMenuController({
			getSession: () => this.runtimeHost.session,
			ui: {
				showSelector: (create) => this.showSelector(create),
				showStatus: (message) => this.showStatus(message),
				showError: (message) => this.showError(message),
				showWarning: (message) => this.showWarning(message),
				requestRender: () => this.ui.requestRender(),
				tui: this.ui,
				footerDataProvider: this.footerDataProvider,
				invalidateFooter: () => this.footer.invalidate(),
				updateEditorBorderColor: () => this.updateEditorBorderColor(),
				openEditorForPath: (filePath) => this.openEditorForPath(filePath),
				handleReloadCommand: () => this.handleReloadCommand(),
				reconcileExtensionsAndRefreshUI: (profileName) => this.reconcileExtensionsAndRefreshUI(profileName),
				maybeWarnAboutAnthropicSubscriptionAuth: (model) =>
					void this.maybeWarnAboutAnthropicSubscriptionAuth(model),
				checkDaxnutsEasterEgg: (model) => this.checkDaxnutsEasterEgg(model),
				showSettingsSelector: () => this.showSettingsSelector(),
				getAutoLearnModelOptions: () => this.getAutoLearnModelOptions(),
			},
		});
		this.authDialogs = new AuthDialogsController({
			getSession: () => this.runtimeHost.session,
			ui: {
				showSelector: (create) => this.showSelector(create),
				showStatus: (message) => this.showStatus(message),
				showError: (message) => this.showError(message),
				requestRender: () => this.ui.requestRender(),
				tui: this.ui,
				overlayHost: this.overlayHost,
				getEditor: () => this.editor,
				updateAvailableProviderCount: () => this.updateAvailableProviderCount(),
				invalidateFooter: () => this.footer.invalidate(),
				updateEditorBorderColor: () => this.updateEditorBorderColor(),
				maybeWarnAboutAnthropicSubscriptionAuth: (model) =>
					void this.maybeWarnAboutAnthropicSubscriptionAuth(model),
				checkDaxnutsEasterEgg: (model) => this.checkDaxnutsEasterEgg(model),
			},
		});
		this.extensionUiHost = new ExtensionUiHost({
			getSession: () => this.runtimeHost.session,
			ui: {
				tui: this.ui,
				overlayHost: this.overlayHost,
				keybindings: this.keybindings,
				footer: this.footer,
				footerDataProvider: this.footerDataProvider,
				headerContainer: this.headerContainer,
				chatContainer: this.chatContainer,
				editorContainer: this.editorContainer,
				defaultEditor: this.defaultEditor,
				widgetContainerAbove: this.widgetContainerAbove,
				widgetContainerBelow: this.widgetContainerBelow,
				getEditor: () => this.editor,
				setEditor: (editor) => {
					this.editor = editor;
				},
				getBuiltInHeader: () => this.builtInHeader,
				getAutocompleteProvider: () => this.autocompleteProvider,
				getToolsExpanded: () => this.toolOutputExpanded,
				pushAutocompleteProviderWrapper: (factory) => {
					this.autocompleteProviderWrappers.push(factory);
				},
				resetAutocompleteProviderWrappers: () => {
					this.autocompleteProviderWrappers = [];
				},
				setupAutocompleteProvider: () => this.setupAutocompleteProvider(),
				setWorkingVisible: (visible) => this.setWorkingVisible(visible),
				setWorkingIndicator: (options) => this.setWorkingIndicator(options),
				setHiddenThinkingLabel: (label) => this.setHiddenThinkingLabel(label),
				setWorkingMessage: (message) => this.setWorkingMessage(message),
				resetWorkingIndicators: () => this.resetWorkingIndicators(),
				setToolsExpanded: (expanded) => this.setToolsExpanded(expanded),
				toggleToolsExpanded: () => this.toggleToolOutputExpansion(),
				updateTerminalTitle: () => this.updateTerminalTitle(),
				markShutdownRequested: () => {
					this.shutdownRequested = true;
				},
				abort: () => {
					this.restoreQueuedMessagesToEditor({ abort: true });
				},
				reload: () => this.handleReloadCommand(),
				showStatus: (message) => this.showStatus(message),
				showWarning: (message) => this.showWarning(message),
				showError: (message) => this.showError(message),
			},
		});
		this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);

		// Load hide thinking block setting
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();

		// Register themes from resource loader and initialize
		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		initTheme(this.settingsManager.getTheme(), true);
	}

	private getBuiltInCommandConflictDiagnostics(extensionRunner: ExtensionRunner): ResourceDiagnostic[] {
		const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
		return extensionRunner
			.getRegisteredCommands()
			.filter((command) => builtinNames.has(command.name))
			.map((command) => ({
				type: "warning" as const,
				message:
					command.invocationName === command.name
						? `Extension command '/${command.name}' conflicts with built-in interactive command. Skipping in autocomplete.`
						: `Extension command '/${command.name}' conflicts with built-in interactive command. Available as '/${command.invocationName}'.`,
				path: command.sourceInfo.path,
			}));
	}

	// Thin delegate retained so setupAutocompleteProvider's base-provider seam
	// (stubbed via prototype in interactive-mode-status.test.ts) keeps working.
	private createBaseAutocompleteProvider(): AutocompleteProvider {
		return autocompleteProvider.createBaseAutocompleteProvider({
			session: this.session,
			settingsManager: this.settingsManager,
			sessionManager: this.sessionManager,
			fdPath: this.fdPath,
			skillCommands: this.skillCommands,
		});
	}

	private setupAutocompleteProvider(): void {
		let provider = this.createBaseAutocompleteProvider();
		for (const wrapProvider of this.autocompleteProviderWrappers) {
			provider = wrapProvider(provider);
		}

		this.autocompleteProvider = provider;
		this.defaultEditor.setAutocompleteProvider(provider);
		if (this.editor !== this.defaultEditor) {
			this.editor.setAutocompleteProvider?.(provider);
		}
	}

	private startupChecksHost(): startupChecks.StartupChecksHost {
		const self = this;
		return {
			sessionManager: this.sessionManager,
			settingsManager: this.settingsManager,
			session: this.session,
			chatContainer: this.chatContainer,
			ui: this.ui,
			version: this.version,
			get changelogMarkdown() {
				return self.changelogMarkdown;
			},
			get startupNoticesShown() {
				return self.startupNoticesShown;
			},
			set startupNoticesShown(value) {
				self.startupNoticesShown = value;
			},
			getMarkdownThemeWithSettings: () => this.getMarkdownThemeWithSettings(),
		};
	}

	private showStartupNoticesIfNeeded(): void {
		startupChecks.showStartupNoticesIfNeeded(this.startupChecksHost());
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		this.registerSignalHandlers();

		// Load changelog (only show new entries, skip for resumed sessions)
		this.changelogMarkdown = this.getChangelogForDisplay();

		// Ensure fd and rg are available (downloads if missing, adds to PATH via getBinDir)
		// Both are needed: fd for autocomplete, rg for grep tool and bash commands
		const [fdPath] = await Promise.all([ensureTool("fd"), ensureTool("rg")]);
		this.fdPath = fdPath;

		if (this.session.scopedModels.length > 0 && (this.options.verbose || !this.settingsManager.getQuietStartup())) {
			const modelList = this.session.scopedModels
				.map((sm) => {
					const thinkingStr = sm.thinkingLevel ? `:${sm.thinkingLevel}` : "";
					return `${sm.model.id}${thinkingStr}`;
				})
				.join(", ");
			const cycleKeys = this.keybindings.getKeys("app.model.cycleForward");
			const cycleHint =
				cycleKeys.length > 0
					? theme.fg("muted", ` (${formatKeyText(cycleKeys.join("/"), { capitalize: true })} to cycle)`)
					: "";
			console.log(theme.fg("dim", `Model scope: ${modelList}${cycleHint}`));
		}

		// Add header container as first child
		this.ui.addChild(this.headerContainer);

		// Add header with keybindings from config (unless silenced)
		if (this.options.verbose || !this.settingsManager.getQuietStartup()) {
			const logo = theme.bold(theme.fg("accent", APP_NAME)) + theme.fg("dim", ` v${this.version}`);

			// Build startup instructions using keybinding hint helpers
			const hint = (keybinding: AppKeybinding, description: string) => keyHint(keybinding, description);

			const expandedInstructions = [
				hint("app.interrupt", "to interrupt"),
				hint("app.clear", "to clear"),
				rawKeyHint(`${keyText("app.clear")} twice`, "to exit"),
				hint("app.exit", "to exit (empty)"),
				hint("app.suspend", "to suspend"),
				keyHint("tui.editor.deleteToLineEnd", "to delete to end"),
				hint("app.thinking.cycle", "to cycle thinking level"),
				rawKeyHint(`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`, "to cycle models"),
				hint("app.model.select", "to select model"),
				hint("app.tools.expand", "to load history / expand tools"),
				hint("app.thinking.toggle", "to expand thinking"),
				hint("app.editor.external", "for external editor"),
				rawKeyHint("/", "for commands"),
				rawKeyHint("!", "to run bash"),
				rawKeyHint("!!", "to run bash (no context)"),
				hint("app.message.followUp", "to queue follow-up"),
				rawKeyHint(">>", "prefix to queue follow-up"),
				hint("app.message.dequeue", "to edit all queued messages"),
				rawKeyHint("↑", "(empty editor) to recall queued messages"),
				hint("app.clipboard.pasteImage", "to paste image"),
				rawKeyHint("drop files", "to attach"),
			].join("\n");
			const compactInstructions = [
				hint("app.interrupt", "interrupt"),
				rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
				rawKeyHint("/", "commands"),
				rawKeyHint("!", "bash"),
				hint("app.tools.expand", "history/more"),
			].join(theme.fg("muted", " · "));
			const compactOnboarding = theme.fg(
				"dim",
				`Press ${keyText("app.tools.expand")} to load session history or show full startup help and loaded resources.`,
			);
			const onboarding = theme.fg(
				"dim",
				`Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.`,
			);
			this.builtInHeader = new ExpandableText(
				() => `${logo}\n${compactInstructions}\n${compactOnboarding}\n\n${onboarding}`,
				() => `${logo}\n${expandedInstructions}\n\n${onboarding}`,
				this.getStartupExpansionState(),
				1,
				0,
			);

			// Setup UI layout
			this.headerContainer.addChild(new Spacer(1));
			this.headerContainer.addChild(this.builtInHeader);
			this.headerContainer.addChild(new Spacer(1));
		} else {
			// Minimal header when silenced
			this.builtInHeader = new Text("", 0, 0);
			this.headerContainer.addChild(this.builtInHeader);
		}

		this.ui.addChild(this.chatContainer);
		this.ui.addChild(this.pendingMessagesContainer);
		this.ui.addChild(this.statusContainer);
		this.extensionUiHost.renderWidgets(); // Initialize with default spacer
		this.ui.addChild(this.widgetContainerAbove);
		this.ui.addChild(this.editorContainer);
		this.ui.addChild(this.widgetContainerBelow);
		this.ui.addChild(this.footer);
		this.ui.setFocus(this.editor);

		this.setupKeyHandlers();
		this.setupEditorSubmitHandler();

		// Start the UI before initializing extensions so session_start handlers can use interactive dialogs
		this.ui.start();
		this.isInitialized = true;

		// Initialize extensions first so resources are shown before messages
		await this.rebindCurrentSession();

		// Register extensions-changed listener for live reload UI refresh
		this.unsubscribeExtensionsChanged = this.session.onExtensionsChanged(() => {
			this.refreshUIAfterExtensionsChanged();
		});

		// Render initial messages AFTER showing loaded resources
		await this.renderInitialMessages();
		this.renderProjectTrustWarningIfNeeded();

		// Set up theme file watcher
		onThemeChange(() => {
			this.ui.invalidate();
			this.updateEditorBorderColor();
			this.ui.requestRender();
		});

		// Set up git branch watcher (uses provider instead of footer)
		this.footerDataProvider.onBranchChange(() => {
			this.ui.requestRender();
		});

		// Initialize available provider count and Auto Learn status for footer display
		await this.updateAvailableProviderCount();
		this.updateAutoLearnFooter();
	}

	private renderProjectTrustWarningIfNeeded(): void {
		startupChecks.renderProjectTrustWarningIfNeeded(this.startupChecksHost());
	}

	/**
	 * Update terminal title with session name and cwd.
	 */
	private updateTerminalTitle(): void {
		const cwdBasename = path.basename(this.sessionManager.getCwd());
		const sessionName = this.sessionManager.getSessionName();
		if (sessionName) {
			this.ui.terminal.setTitle(`${APP_TITLE} - ${sessionName} - ${cwdBasename}`);
		} else {
			this.ui.terminal.setTitle(`${APP_TITLE} - ${cwdBasename}`);
		}
	}

	/**
	 * Run the interactive mode. This is the main entry point.
	 * Initializes the UI, shows warnings, processes initial messages, and starts the interactive loop.
	 */
	async run(): Promise<void> {
		await this.init();

		// Start version check asynchronously
		checkForNewPiVersion(this.version).then((newRelease) => {
			if (newRelease) {
				this.showNewVersionNotification(newRelease);
			}
		});

		// Start package update check asynchronously
		this.checkForPackageUpdates().then((updates) => {
			if (updates.length > 0) {
				this.showPackageUpdateNotification(updates);
			}
		});

		// Check tmux keyboard setup asynchronously
		this.checkTmuxKeyboardSetup().then((warning) => {
			if (warning) {
				this.showWarning(warning);
			}
		});

		// Skill curator (#32): auto-archive stale reflection-promoted skills at startup, and ANNOUNCE it
		// (never silent — the user can restore any of them with `/curate restore <name>`).
		this.session
			.runStartupSkillCuration()
			.then((archived) => {
				if (archived.length > 0) {
					this.showStatus(
						`Curator: auto-archived ${archived.length} stale skill(s) — ${archived.join(", ")}. Restore with /curate restore <name>.`,
					);
				}
			})
			.catch(() => {
				// curation is best-effort; never disrupt startup
			});

		// Show startup warnings
		const { migratedProviders, modelFallbackMessage, initialMessage, initialImages, initialMessages } = this.options;

		if (migratedProviders && migratedProviders.length > 0) {
			this.showWarning(`Migrated credentials to auth.json: ${migratedProviders.join(", ")}`);
		}

		const modelsJsonError = this.session.modelRegistry.getError();
		if (modelsJsonError) {
			this.showError(`models.json error: ${modelsJsonError}`);
		}

		if (modelFallbackMessage) {
			this.showWarning(modelFallbackMessage);
		}

		void this.maybeWarnAboutAnthropicSubscriptionAuth();

		// Process initial messages
		if (initialMessage) {
			try {
				await this.session.prompt(initialMessage, { images: initialImages });
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			} finally {
				this.refreshAutonomyFooterStatus();
			}
		}

		if (initialMessages) {
			for (const message of initialMessages) {
				try {
					await this.session.prompt(message);
				} catch (error: unknown) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
					this.showError(errorMessage);
				} finally {
					this.refreshAutonomyFooterStatus();
				}
			}
		}

		// Main interactive loop
		while (true) {
			const userInput = await this.getUserInput();
			try {
				await this.session.prompt(userInput.text, { images: userInput.images });
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			} finally {
				this.refreshAutonomyFooterStatus();
			}
		}
	}

	private refreshAutonomyFooterStatus(): void {
		this.footerDataProvider.setAutonomyStatusSnapshot(this.session.getAutonomyStatusSnapshot());
		this.footer.invalidate();
	}

	private checkForPackageUpdates(): Promise<string[]> {
		return startupChecks.checkForPackageUpdates(this.startupChecksHost());
	}

	private checkTmuxKeyboardSetup(): Promise<string | undefined> {
		return startupChecks.checkTmuxKeyboardSetup();
	}

	/**
	 * Get changelog entries to display on startup.
	 * Only shows new entries since last seen version, skips for resumed sessions.
	 */
	private getChangelogForDisplay(): string | undefined {
		return startupChecks.getChangelogForDisplay(this.startupChecksHost());
	}

	private getMarkdownThemeWithSettings(): MarkdownTheme {
		return {
			...getMarkdownTheme(),
			codeBlockIndent: this.settingsManager.getCodeBlockIndent(),
		};
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	// The resource-display formatters below are pure and live in ./resource-display.ts.
	// These thin `this.`-delegates are retained so showLoadedResources' formatter
	// injection seam (exercised via prototype stubs in interactive-mode-status.test.ts)
	// keeps working unchanged.
	private formatDisplayPath(p: string): string {
		return resourceDisplay.formatDisplayPath(p);
	}

	private formatExtensionDisplayPath(path: string): string {
		return resourceDisplay.formatExtensionDisplayPath(path);
	}

	private formatContextPath(p: string): string {
		const cwd = path.resolve(this.sessionManager.getCwd());
		const absolutePath = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
		const relativePath = getCwdRelativePath(absolutePath, cwd);
		if (relativePath !== undefined) {
			return relativePath;
		}

		return this.formatDisplayPath(absolutePath);
	}

	private getStartupExpansionState(): boolean {
		return this.options.verbose || this.toolOutputExpanded;
	}

	private getShortPath(fullPath: string, sourceInfo?: SourceInfo): string {
		return resourceDisplay.getShortPath(fullPath, sourceInfo);
	}

	private getCompactPathLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
		return resourceDisplay.getCompactPathLabel(resourcePath, sourceInfo);
	}

	private getCompactPackageSourceLabel(sourceInfo?: SourceInfo): string {
		return resourceDisplay.getCompactPackageSourceLabel(sourceInfo);
	}

	private getCompactExtensionLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
		return resourceDisplay.getCompactExtensionLabel(resourcePath, sourceInfo);
	}

	private getCompactDisplayPathSegments(resourcePath: string): string[] {
		return resourceDisplay.getCompactDisplayPathSegments(resourcePath);
	}

	private getCompactNonPackageExtensionLabel(
		resourcePath: string,
		index: number,
		allPaths: Array<{ path: string; segments: string[] }>,
	): string {
		return resourceDisplay.getCompactNonPackageExtensionLabel(resourcePath, index, allPaths);
	}

	private getCompactExtensionLabels(extensions: Array<{ path: string; sourceInfo?: SourceInfo }>): string[] {
		return resourceDisplay.getCompactExtensionLabels(extensions);
	}

	private getScopeGroup(sourceInfo?: SourceInfo): "user" | "project" | "path" {
		return resourceDisplay.getScopeGroup(sourceInfo);
	}

	private isPackageSource(sourceInfo?: SourceInfo): boolean {
		return resourceDisplay.isPackageSource(sourceInfo);
	}

	private buildScopeGroups(items: Array<{ path: string; sourceInfo?: SourceInfo }>): Array<{
		scope: "user" | "project" | "path";
		paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
		packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
	}> {
		return resourceDisplay.buildScopeGroups(items);
	}

	private formatScopeGroups(
		groups: Array<{
			scope: "user" | "project" | "path";
			paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
			packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
		}>,
		options: {
			formatPath: (item: { path: string; sourceInfo?: SourceInfo }) => string;
			formatPackagePath: (item: { path: string; sourceInfo?: SourceInfo }, source: string) => string;
		},
	): string {
		return resourceDisplay.formatScopeGroups(groups, options);
	}

	private formatDiagnostics(diagnostics: readonly ResourceDiagnostic[], sourceInfos: Map<string, SourceInfo>): string {
		return resourceDisplay.formatDiagnostics(diagnostics, sourceInfos);
	}

	private showLoadedResources(options?: {
		extensions?: Array<{ path: string; sourceInfo?: SourceInfo }>;
		force?: boolean;
		showDiagnosticsWhenQuiet?: boolean;
	}): void {
		const showListing = options?.force || this.options.verbose || !this.settingsManager.getQuietStartup();
		const showDiagnostics = showListing || options?.showDiagnosticsWhenQuiet === true;
		if (!showListing && !showDiagnostics) {
			return;
		}

		const sectionHeader = (name: string, color: ThemeColor = "mdHeading") => theme.fg(color, `[${name}]`);
		const formatCompactList = (items: string[], options?: { sort?: boolean }): string => {
			const labels = items.map((item) => item.trim()).filter((item) => item.length > 0);
			if (options?.sort !== false) {
				labels.sort((a, b) => a.localeCompare(b));
			}
			return theme.fg("dim", `  ${labels.join(", ")}`);
		};
		const addLoadedSection = (
			name: string,
			collapsedBody: string,
			expandedBody = collapsedBody,
			color: ThemeColor = "mdHeading",
		): void => {
			const section = new ExpandableText(
				() => `${sectionHeader(name, color)}\n${collapsedBody}`,
				() => `${sectionHeader(name, color)}\n${expandedBody}`,
				this.getStartupExpansionState(),
				0,
				0,
			);
			this.chatContainer.addChild(section);
			this.chatContainer.addChild(new Spacer(1));
		};

		const skillsResult = this.session.resourceLoader.getSkills();
		const promptsResult = this.session.resourceLoader.getPrompts();
		const themesResult = this.session.resourceLoader.getThemes();
		const extensions =
			options?.extensions ??
			this.session.resourceLoader.getExtensions().extensions.map((extension) => ({
				path: extension.path,
				sourceInfo: extension.sourceInfo,
			}));
		const sourceInfos = new Map<string, SourceInfo>();
		for (const extension of extensions) {
			if (extension.sourceInfo) {
				sourceInfos.set(extension.path, extension.sourceInfo);
			}
		}
		for (const skill of skillsResult.skills) {
			if (skill.sourceInfo) {
				sourceInfos.set(skill.filePath, skill.sourceInfo);
			}
		}
		for (const prompt of promptsResult.prompts) {
			if (prompt.sourceInfo) {
				sourceInfos.set(prompt.filePath, prompt.sourceInfo);
			}
		}
		for (const loadedTheme of themesResult.themes) {
			if (loadedTheme.sourcePath && loadedTheme.sourceInfo) {
				sourceInfos.set(loadedTheme.sourcePath, loadedTheme.sourceInfo);
			}
		}

		if (showListing) {
			const contextFiles = this.session.resourceLoader.getAgentsFiles().agentsFiles;
			if (contextFiles.length > 0) {
				this.chatContainer.addChild(new Spacer(1));
				const contextList = contextFiles
					.map((f) => theme.fg("dim", `  ${this.formatDisplayPath(f.path)}`))
					.join("\n");
				const contextCompactList = formatCompactList(
					contextFiles.map((contextFile) => this.formatContextPath(contextFile.path)),
					{ sort: false },
				);
				addLoadedSection("Context", contextCompactList, contextList);
			}

			const skills = this.session.resourceLoader.getActiveSkills();
			if (skills.length > 0) {
				const groups = this.buildScopeGroups(
					skills.map((skill) => ({ path: skill.filePath, sourceInfo: skill.sourceInfo })),
				);
				const skillList = this.formatScopeGroups(groups, {
					formatPath: (item) => this.formatDisplayPath(item.path),
					formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),
				});
				const skillCompactList = formatCompactList(skills.map((skill) => skill.name));
				addLoadedSection("Skills", skillCompactList, skillList);
			}

			const templates = this.session.promptTemplates;
			if (templates.length > 0) {
				const groups = this.buildScopeGroups(
					templates.map((template) => ({ path: template.filePath, sourceInfo: template.sourceInfo })),
				);
				const templateByPath = new Map(templates.map((t) => [t.filePath, t]));
				const templateList = this.formatScopeGroups(groups, {
					formatPath: (item) => {
						const template = templateByPath.get(item.path);
						return template ? `/${template.name}` : this.formatDisplayPath(item.path);
					},
					formatPackagePath: (item) => {
						const template = templateByPath.get(item.path);
						return template ? `/${template.name}` : this.formatDisplayPath(item.path);
					},
				});
				const promptCompactList = formatCompactList(templates.map((template) => `/${template.name}`));
				addLoadedSection("Prompts", promptCompactList, templateList);
			}

			if (extensions.length > 0) {
				const groups = this.buildScopeGroups(extensions);
				const extList = this.formatScopeGroups(groups, {
					formatPath: (item) => this.formatExtensionDisplayPath(item.path),
					formatPackagePath: (item) =>
						this.formatExtensionDisplayPath(this.getShortPath(item.path, item.sourceInfo)),
				});
				const extensionCompactList = formatCompactList(this.getCompactExtensionLabels(extensions));
				addLoadedSection("Extensions", extensionCompactList, extList, "mdHeading");
			}

			// Show loaded themes (excluding built-in)
			const loadedThemes = themesResult.themes;
			const customThemes = loadedThemes.filter((t) => t.sourcePath);
			if (customThemes.length > 0) {
				const groups = this.buildScopeGroups(
					customThemes.map((loadedTheme) => ({
						path: loadedTheme.sourcePath!,
						sourceInfo: loadedTheme.sourceInfo,
					})),
				);
				const themeList = this.formatScopeGroups(groups, {
					formatPath: (item) => this.formatDisplayPath(item.path),
					formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),
				});
				const themeCompactList = formatCompactList(
					customThemes.map(
						(loadedTheme) =>
							loadedTheme.name ?? this.getCompactPathLabel(loadedTheme.sourcePath!, loadedTheme.sourceInfo),
					),
				);
				addLoadedSection("Themes", themeCompactList, themeList);
			}
		}

		if (showDiagnostics) {
			const skillDiagnostics = skillsResult.diagnostics;
			if (skillDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(skillDiagnostics, sourceInfos);
				this.chatContainer.addChild(new Text(`${theme.fg("warning", "[Skill conflicts]")}\n${warningLines}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}

			const promptDiagnostics = promptsResult.diagnostics;
			if (promptDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(promptDiagnostics, sourceInfos);
				this.chatContainer.addChild(
					new Text(`${theme.fg("warning", "[Prompt conflicts]")}\n${warningLines}`, 0, 0),
				);
				this.chatContainer.addChild(new Spacer(1));
			}

			const extensionDiagnostics: ResourceDiagnostic[] = [];
			const extensionErrors = this.session.resourceLoader.getExtensions().errors;
			if (extensionErrors.length > 0) {
				for (const error of extensionErrors) {
					extensionDiagnostics.push({ type: "error", message: error.error, path: error.path });
				}
			}

			const commandDiagnostics = this.session.extensionRunner.getCommandDiagnostics();
			extensionDiagnostics.push(...commandDiagnostics);
			extensionDiagnostics.push(...this.getBuiltInCommandConflictDiagnostics(this.session.extensionRunner));

			const shortcutDiagnostics = this.session.extensionRunner.getShortcutDiagnostics();
			extensionDiagnostics.push(...shortcutDiagnostics);

			if (extensionDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(extensionDiagnostics, sourceInfos);
				this.chatContainer.addChild(
					new Text(`${theme.fg("warning", "[Extension issues]")}\n${warningLines}`, 0, 0),
				);
				this.chatContainer.addChild(new Spacer(1));
			}

			const themeDiagnostics = themesResult.diagnostics;
			if (themeDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(themeDiagnostics, sourceInfos);
				this.chatContainer.addChild(new Text(`${theme.fg("warning", "[Theme conflicts]")}\n${warningLines}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}
		}
	}

	/**
	 * Initialize the extension system with TUI-based UI context.
	 */
	private async bindCurrentSessionExtensions(): Promise<void> {
		const uiContext = this.extensionUiHost.createExtensionUIContext();
		await this.session.bindExtensions({
			uiContext,
			mode: "tui",
			abortHandler: () => {
				this.restoreQueuedMessagesToEditor({ abort: true });
			},
			commandContextActions: {
				waitForIdle: () => this.session.agent.waitForIdle(),
				newSession: async (options) => {
					if (this.loadingAnimation) {
						this.loadingAnimation.stop();
						this.loadingAnimation = undefined;
					}
					this.statusContainer.clear();
					try {
						const result = await this.runtimeHost.newSession(options);
						if (!result.cancelled) {
							this.renderCurrentSessionState();
							this.ui.requestRender();
						}
						return result;
					} catch (error: unknown) {
						return this.handleFatalRuntimeError("Failed to create session", error);
					}
				},
				fork: async (entryId, options) => {
					try {
						const result = await this.runtimeHost.fork(entryId, options);
						if (!result.cancelled) {
							this.renderCurrentSessionState();
							this.editor.setText(result.selectedText ?? "");
							this.showStatus("Forked to new session");
						}
						return { cancelled: result.cancelled };
					} catch (error: unknown) {
						return this.handleFatalRuntimeError("Failed to fork session", error);
					}
				},
				navigateTree: async (targetId, options) => {
					const result = await this.session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					if (result.cancelled) {
						return { cancelled: true };
					}

					await this.renderInitialMessages();
					if (result.editorText && !this.editor.getText().trim()) {
						this.editor.setText(result.editorText);
					}
					this.showStatus("Navigated to selected point");
					void this.flushCompactionQueue({ willRetry: false });
					return { cancelled: false };
				},
				switchSession: async (sessionPath, options) => {
					return this.handleResumeSession(sessionPath, options);
				},
				reload: async () => {
					await this.handleReloadCommand();
				},
			},
			shutdownHandler: () => {
				this.shutdownRequested = true;
				if (!this.session.isStreaming) {
					void this.shutdown();
				}
			},
			onError: (error) => {
				this.extensionUiHost.showExtensionError(error.extensionPath, error.error, error.stack);
			},
		});

		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		this.setupAutocompleteProvider();

		const extensionRunner = this.session.extensionRunner;
		this.extensionUiHost.setupExtensionShortcuts(extensionRunner);
		this.showLoadedResources({ force: false, showDiagnosticsWhenQuiet: true });
		this.showStartupNoticesIfNeeded();
	}

	private applyRuntimeSettings(): void {
		configureHttpDispatcher(this.settingsManager.getHttpIdleTimeoutMs());
		this.footer.setSession(this.session);
		this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);
		this.footerDataProvider.setCwd(this.sessionManager.getCwd());
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor.setPaddingX(editorPaddingX);
		this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
		if (this.editor !== this.defaultEditor) {
			this.editor.setPaddingX?.(editorPaddingX);
			this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
		}
	}

	private async rebindCurrentSession(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.applyRuntimeSettings();
		await this.bindCurrentSessionExtensions();
		this.subscribeToAgent();
		await this.updateAvailableProviderCount();
		this.updateEditorBorderColor();
		this.updateTerminalTitle();
	}

	private async handleFatalRuntimeError(prefix: string, error: unknown): Promise<never> {
		const message = error instanceof Error ? error.message : String(error);
		this.showError(`${prefix}: ${message}`);
		stopThemeWatcher();
		this.stop();
		process.exit(1);
	}

	private renderCurrentSessionState(): void {
		this.pendingMessagesContainer.clear();
		this.compactionQueuedMessages = [];
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.clearRenderedToolPanelState();
		void this.renderInitialMessages();
	}

	/**
	 * Get a registered tool definition by name (for custom rendering).
	 */
	private getRegisteredToolDefinition(toolName: string) {
		return this.session.getToolDefinition(toolName);
	}

	private getToolPanelScope() {
		return {
			sessionId: this.sessionManager.getSessionId?.(),
			sessionFile: this.sessionManager.getSessionFile?.(),
			cwd: this.sessionManager.getCwd(),
		};
	}

	private appendToolExecutionComponent(component: ToolExecutionComponent, allowGrouping: boolean): void {
		const toolGroup = allowGrouping ? component.toolGroup?.trim() : undefined;
		if (!toolGroup) {
			this.chatContainer.addChild(component);
			this.trimLiveTuiHistory();
			return;
		}

		const children = this.chatContainer.children;
		const lastChild = children[children.length - 1];
		if (lastChild instanceof ToolGroupComponent && lastChild.toolGroup === toolGroup) {
			lastChild.addTool(component);
			this.trimLiveTuiHistory();
			return;
		}
		if (lastChild instanceof ToolExecutionComponent && lastChild.toolGroup?.trim() === toolGroup) {
			const group = new ToolGroupComponent(toolGroup, [lastChild, component]);
			group.setExpanded(this.toolOutputExpanded);
			children[children.length - 1] = group;
			this.trimLiveTuiHistory();
			return;
		}
		this.chatContainer.addChild(component);
		this.trimLiveTuiHistory();
	}

	private detachToolExecutionComponent(component: ToolExecutionComponent): void {
		const children = this.chatContainer.children;
		const directIndex = children.indexOf(component);
		if (directIndex !== -1) {
			children.splice(directIndex, 1);
			return;
		}
		for (let i = 0; i < children.length; i++) {
			const child = children[i];
			if (!(child instanceof ToolGroupComponent) || !child.removeTool(component)) continue;
			const remaining = child.getToolCount();
			if (remaining === 0) {
				children.splice(i, 1);
			} else if (remaining === 1) {
				const onlyTool = child.getOnlyTool();
				if (onlyTool) children[i] = onlyTool;
			}
			return;
		}
	}

	private attachToolExecutionComponent(toolName: string, toolCallId: string, args: any): ToolExecutionComponent {
		const actionKey = getToolPanelActionKey(this.getToolPanelScope(), toolName, args);
		const toolDefinition = this.getRegisteredToolDefinition(toolName);
		const reuseInPlace = shouldReuseToolPanelInPlace(toolName, args);
		const existing = this.toolPanels.getReusable(actionKey, { allowActive: reuseInPlace });
		if (existing) {
			if (reuseInPlace && actionKey) {
				existing.resetInvocation(toolName, toolCallId, args, toolDefinition);
				existing.setExpanded(this.toolOutputExpanded);
				this.toolPanels.replaceActiveForAction(toolCallId, existing, actionKey);
				this.ui.requestRender();
				return existing;
			}
			this.detachToolExecutionComponent(existing);
			existing.resetInvocation(toolName, toolCallId, args, toolDefinition);
			existing.setExpanded(this.toolOutputExpanded);
			this.appendToolExecutionComponent(existing, true);
			this.toolPanels.register(toolCallId, existing, actionKey);
			return existing;
		}
		const component = new ToolExecutionComponent(
			toolName,
			toolCallId,
			args,
			{
				showImages: this.settingsManager.getShowImages(),
				imageWidthCells: this.settingsManager.getImageWidthCells(),
			},
			toolDefinition,
			this.ui,
			this.sessionManager.getCwd(),
		);
		component.setExpanded(this.toolOutputExpanded);
		this.appendToolExecutionComponent(component, true);
		this.toolPanels.register(toolCallId, component, actionKey);
		return component;
	}

	private clearActiveToolCalls(): void {
		this.toolPanels.clearActive();
	}

	private clearRenderedToolPanelState(): void {
		this.toolPanels.clearAll();
	}

	private getWorkingLoaderMessage(): string {
		return this.workingMessage ?? this.defaultWorkingMessage;
	}

	private createWorkingLoader(): Loader {
		return new Loader(
			this.ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			this.getWorkingLoaderMessage(),
			this.workingIndicatorOptions,
		);
	}

	private stopWorkingLoader(): void {
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();
	}

	private setWorkingVisible(visible: boolean): void {
		this.workingVisible = visible;
		if (!visible) {
			this.stopWorkingLoader();
			this.ui.requestRender();
			return;
		}
		if (this.session.isStreaming && !this.loadingAnimation) {
			this.statusContainer.clear();
			this.loadingAnimation = this.createWorkingLoader();
			this.statusContainer.addChild(this.loadingAnimation);
		}
		this.ui.requestRender();
	}

	private setWorkingIndicator(options?: LoaderIndicatorOptions): void {
		this.workingIndicatorOptions = options;
		this.loadingAnimation?.setIndicator(options);
		this.ui.requestRender();
	}

	private setHiddenThinkingLabel(label?: string): void {
		this.hiddenThinkingLabel = label ?? this.defaultHiddenThinkingLabel;
		for (const child of this.chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				child.setHiddenThinkingLabel(this.hiddenThinkingLabel);
			}
		}
		if (this.streamingComponent) {
			this.streamingComponent.setHiddenThinkingLabel(this.hiddenThinkingLabel);
		}
		this.ui.requestRender();
	}

	/**
	 * Set the extension-provided working-loader message (undefined restores the default).
	 */
	private setWorkingMessage(message: string | undefined): void {
		this.workingMessage = message;
		if (this.loadingAnimation) {
			this.loadingAnimation.setMessage(message ?? this.defaultWorkingMessage);
		}
	}

	/**
	 * Reset the working indicator and hidden-thinking label to their built-in defaults.
	 */
	private resetWorkingIndicators(): void {
		this.workingMessage = undefined;
		this.workingVisible = true;
		this.setWorkingIndicator();
		if (this.loadingAnimation) {
			this.loadingAnimation.setMessage(`${this.defaultWorkingMessage} (${keyText("app.interrupt")} to interrupt)`);
		}
		this.setHiddenThinkingLabel();
	}

	private async promptForMissingSessionCwd(error: MissingSessionCwdError): Promise<string | undefined> {
		const confirmed = await this.extensionUiHost.showExtensionConfirm(
			"Session cwd not found",
			formatMissingSessionCwdPrompt(error.issue),
		);
		return confirmed ? error.issue.fallbackCwd : undefined;
	}

	// =========================================================================
	// Key Handlers
	// =========================================================================

	private setupKeyHandlers(): void {
		keyHandlers.setupKeyHandlers(this.keyHandlersHost());
	}

	private keyHandlersHost(): keyHandlers.KeyHandlersHost {
		const self = this;
		return {
			defaultEditor: this.defaultEditor,
			ui: this.ui,
			get editor() {
				return self.editor;
			},
			get session() {
				return self.session;
			},
			get settingsManager() {
				return self.settingsManager;
			},
			get isBashMode() {
				return self.isBashMode;
			},
			set isBashMode(value) {
				self.isBashMode = value;
			},
			get lastEscapeTime() {
				return self.lastEscapeTime;
			},
			set lastEscapeTime(value) {
				self.lastEscapeTime = value;
			},
			restoreQueuedMessagesToEditor: (options) => this.restoreQueuedMessagesToEditor(options),
			updateEditorBorderColor: () => this.updateEditorBorderColor(),
			showTreeSelector: (id) => this.showTreeSelector(id),
			showUserMessageSelector: (name) => this.showUserMessageSelector(name),
			handleCtrlC: () => this.handleCtrlC(),
			handleCtrlD: () => this.handleCtrlD(),
			handleCtrlZ: () => this.handleCtrlZ(),
			cycleThinkingLevel: () => this.cycleThinkingLevel(),
			cycleModel: (direction) => this.cycleModel(direction),
			handleDebugCommand: () => this.handleDebugCommand(),
			showModelSelector: (input) => this.showModelSelector(input),
			loadTuiHistoryOnDemand: () => this.loadTuiHistoryOnDemand(),
			toggleThinkingBlockVisibility: () => this.toggleThinkingBlockVisibility(),
			openExternalEditor: () => this.openExternalEditor(),
			handleFollowUp: () => this.handleFollowUp(),
			handleDequeue: () => this.handleDequeue(),
			handleClearCommand: (name) => this.handleClearCommand(name),
			showSessionSelector: () => this.showSessionSelector(),
			handleClipboardImagePaste: () => this.handleClipboardImagePaste(),
		};
	}

	private handleClipboardImagePaste(): Promise<void> {
		const self = this;
		return clipboardInput.handleClipboardImagePaste({
			get pendingClipboardImages() {
				return self.pendingClipboardImages;
			},
			set pendingClipboardImages(value) {
				self.pendingClipboardImages = value;
			},
			get clipboardImageCounter() {
				return self.clipboardImageCounter;
			},
			set clipboardImageCounter(value) {
				self.clipboardImageCounter = value;
			},
			editor: this.editor,
			ui: this.ui,
			showStatus: (message) => this.showStatus(message),
			showWarning: (message) => this.showWarning(message),
		});
	}

	private takeClipboardImagesForText(text: string): ImageContent[] | undefined {
		const self = this;
		return clipboardInput.takeClipboardImagesForText(
			{
				get pendingClipboardImages() {
					return self.pendingClipboardImages;
				},
				set pendingClipboardImages(value) {
					self.pendingClipboardImages = value;
				},
				get clipboardImageCounter() {
					return self.clipboardImageCounter;
				},
				set clipboardImageCounter(value) {
					self.clipboardImageCounter = value;
				},
			},
			text,
		);
	}

	private buildUserInputSubmission(text: string): UserInputSubmission {
		return clipboardInput.buildUserInputSubmission(
			{ takeClipboardImagesForText: (t) => this.takeClipboardImagesForText(t) },
			text,
		);
	}

	private setupEditorSubmitHandler(): void {
		this.defaultEditor.onSubmit = async (text: string) => {
			text = text.trim();
			if (!text) return;

			if (text === "/quit" || text === "/exit") {
				this.editor.setText("");
				await this.shutdown();
				return;
			}

			// A ">>" prefix queues the message as a follow-up (delivered after the
			// current work finishes, starting the next round) instead of steering.
			// This is the chord-free alternative to app.message.followUp, which many
			// terminals swallow (e.g. Windows Terminal claims alt+enter).
			const queueAsFollowUp = text.startsWith(">>");
			if (queueAsFollowUp) {
				text = text.slice(2).trim();
				if (!text) return;
			}

			// User input submitted while work is active is always steering. Treat
			// slash/bang text as user steering text instead of executing commands that
			// would interrupt the current stream or compaction.
			if (this.session.isCompacting) {
				const images = this.takeClipboardImagesForText(text);
				this.queueCompactionMessage(text, queueAsFollowUp ? "followUp" : "steer", images);
				return;
			}
			if (this.session.isStreaming || this.session.isRetrying) {
				const images = this.takeClipboardImagesForText(text);
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				try {
					await this.session.prompt(text, {
						streamingBehavior: queueAsFollowUp ? "followUp" : "steer",
						images,
						processSlashCommands: false,
					});
				} finally {
					this.refreshAutonomyFooterStatus();
				}
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
				return;
			}

			// Handle commands
			if (text === "/settings") {
				this.showSettingsSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/auto-learn" || text.startsWith("/auto-learn ")) {
				this.handleAutoLearnCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/autonomy" || text.startsWith("/autonomy ")) {
				this.handleAutonomyCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/fitness" || text.startsWith("/fitness ")) {
				const fitnessArgs = text.slice("/fitness".length).trim();
				this.editor.setText("");
				if (fitnessArgs.length === 0) {
					// No args: open the model picker, probe the selection, then offer role assignment.
					this.showFitnessModelSelector();
				} else {
					// Explicit ref: same handler as /autonomy fitness.
					this.handleAutonomyCommand(`/autonomy fitness ${fitnessArgs}`);
				}
				return;
			}
			if (text === "/models" || text.startsWith("/models ")) {
				void this.handleModelsCommand(text.slice("/models".length).trim());
				this.editor.setText("");
				return;
			}
			if (text === "/context") {
				this.showStatus(this.session.formatContextCompositionDashboard());
				this.editor.setText("");
				return;
			}
			if (text === "/scoped-models") {
				this.editor.setText("");
				await this.showModelsSelector();
				return;
			}
			if (text === "/model" || text.startsWith("/model ")) {
				const searchTerm = text.startsWith("/model ") ? text.slice(7).trim() : undefined;
				this.editor.setText("");
				await this.handleModelCommand(searchTerm);
				return;
			}
			if (text === "/profiles" || text.startsWith("/profiles ")) {
				const rawProfileName = text.startsWith("/profiles ") ? text.slice(10).trim() : undefined;
				this.editor.setText("");
				await this.handleProfilesCommand(rawProfileName?.length ? rawProfileName : undefined);
				return;
			}
			if (text === "/export" || text.startsWith("/export ")) {
				await this.handleExportCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/import" || text.startsWith("/import ")) {
				await this.handleImportCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/share") {
				await this.handleShareCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/copy") {
				await this.handleCopyCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/name" || text.startsWith("/name ")) {
				this.handleNameCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/session") {
				this.handleSessionCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/usage" || text === "/cost") {
				this.handleUsageCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/goal-continue" || text.startsWith("/goal-continue ")) {
				await this.handleGoalContinueCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/changelog") {
				this.handleChangelogCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/hotkeys") {
				this.handleHotkeysCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/fork" || text.startsWith("/fork ")) {
				this.showUserMessageSelector(text.slice("/fork".length).trim() || undefined);
				this.editor.setText("");
				return;
			}
			if (text === "/clone" || text.startsWith("/clone ")) {
				this.editor.setText("");
				await this.handleCloneCommand(text.slice("/clone".length).trim() || undefined);
				return;
			}
			if (text === "/tree") {
				this.showTreeSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/trust") {
				this.showTrustSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/login" || text.startsWith("/login ")) {
				await this.authDialogs.showOAuthSelector("login", text.slice("/login".length).trim() || undefined);
				this.editor.setText("");
				return;
			}
			if (text === "/logout" || text.startsWith("/logout ")) {
				await this.authDialogs.showOAuthSelector("logout", text.slice("/logout".length).trim() || undefined);
				this.editor.setText("");
				return;
			}
			if (text === "/new" || text.startsWith("/new ")) {
				this.editor.setText("");
				await this.handleClearCommand(text.slice("/new".length).trim() || undefined);
				return;
			}
			if (text === "/compact" || text.startsWith("/compact ")) {
				const customInstructions = text.startsWith("/compact ") ? text.slice(9).trim() : undefined;
				this.editor.setText("");
				await this.handleCompactCommand(customInstructions);
				return;
			}
			if (text === "/reload") {
				this.editor.setText("");
				await this.handleReloadCommand();
				return;
			}
			if (text === "/curate" || text.startsWith("/curate ")) {
				const args = text.slice("/curate".length).trim();
				this.editor.setText("");
				this.handleCurateCommand(args);
				return;
			}
			if (text === "/install-resources" || text.startsWith("/install-resources ")) {
				const args = text.slice("/install-resources".length).trim();
				this.editor.setText("");
				await this.handleInstallResourcesCommand(args);
				return;
			}
			if (text === "/config-backup" || text.startsWith("/config-backup ")) {
				const file = text.slice("/config-backup".length).trim() || undefined;
				this.editor.setText("");
				await this.handleConfigBackupCommand(file);
				return;
			}
			if (text === "/config-restore" || text.startsWith("/config-restore ")) {
				const file = text.slice("/config-restore".length).trim();
				this.editor.setText("");
				await this.handleConfigRestoreCommand(file);
				return;
			}
			if (text === "/debug") {
				this.handleDebugCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/arminsayshi") {
				this.handleArminSaysHi();
				this.editor.setText("");
				return;
			}
			if (text === "/dementedelves") {
				this.handleDementedDelves();
				this.editor.setText("");
				return;
			}
			if (text === "/resume") {
				this.showSessionSelector();
				this.editor.setText("");
				return;
			}
			// Handle bash command (! for normal, !! for excluded from context)
			if (text.startsWith("!")) {
				const isExcluded = text.startsWith("!!");
				const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
				if (command) {
					if (this.session.isBashRunning) {
						this.showWarning("A bash command is already running. Press Esc to cancel it first.");
						this.editor.setText(text);
						return;
					}
					this.editor.addToHistory?.(text);
					await this.handleBashCommand(command, isExcluded);
					this.isBashMode = false;
					this.updateEditorBorderColor();
					return;
				}
			}

			// Normal message submission
			// First, move any pending bash components to chat
			this.flushPendingBashComponents();

			const submission = this.buildUserInputSubmission(text);
			if (this.onInputCallback) {
				this.onInputCallback(submission);
			} else {
				this.pendingUserInputs.push(submission);
			}
			this.editor.addToHistory?.(text);
		};
	}

	private subscribeToAgent(): void {
		this.unsubscribe = this.session.subscribe(async (event) => {
			await this.handleEvent(event);
		});
	}

	private async handleEvent(event: AgentSessionEvent): Promise<void> {
		if (!this.isInitialized) {
			await this.init();
		}

		this.footer.invalidate();

		switch (event.type) {
			// Part B: general "the system is processing" feedback for the routing/prep gap before a
			// turn starts streaming (the judge is a real bounded LLM call, not instant) — independent
			// of thinking level, since this isn't model-thinking. Reuses the same working loader
			// agent_start below uses, so the hand-off into real streaming is the same
			// stop-then-recreate it already does — no distinct spinner, no double-render.
			case "routing_start":
				if (!this.session.isStreaming && !this.loadingAnimation && this.workingVisible) {
					this.loadingAnimation = this.createWorkingLoader();
					this.statusContainer.addChild(this.loadingAnimation);
					this.ui.requestRender();
				}
				break;

			case "routing_end":
				// Unconditional: covers both a clean hand-off into agent_start (which immediately
				// stops-and-recreates its own loader anyway) and a turn that failed before ever
				// starting, which must not leave the indicator spinning forever.
				this.stopWorkingLoader();
				this.ui.requestRender();
				break;

			case "agent_start":
				this.clearActiveToolCalls();
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(true);
				}
				// Restore main escape handler if retry handler is still active
				// (retry success event fires later, but we need main handler now)
				if (this.retryEscapeHandler) {
					this.defaultEditor.onEscape = this.retryEscapeHandler;
					this.retryEscapeHandler = undefined;
				}
				if (this.retryCountdown) {
					this.retryCountdown.dispose();
					this.retryCountdown = undefined;
				}
				if (this.retryLoader) {
					this.retryLoader.stop();
					this.retryLoader = undefined;
				}
				this.stopWorkingLoader();
				if (this.workingVisible) {
					this.loadingAnimation = this.createWorkingLoader();
					this.statusContainer.addChild(this.loadingAnimation);
				}
				this.ui.requestRender();
				break;

			case "queue_update":
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
				break;

			case "session_info_changed":
				this.updateTerminalTitle();
				this.footer.invalidate();
				this.ui.requestRender();
				break;

			case "thinking_level_changed":
				this.footer.invalidate();
				this.updateEditorBorderColor();
				break;

			case "warning":
				this.showWarning(event.message);
				break;

			case "message_start":
				if (event.message.role === "custom") {
					this.addMessageToChat(event.message);
					this.ui.requestRender();
				} else if (event.message.role === "user") {
					this.addMessageToChat(event.message);
					this.updatePendingMessagesDisplay();
					this.ui.requestRender();
				} else if (event.message.role === "assistant") {
					this.clearPendingStreamingUiUpdate();
					this.lastStreamingUiUpdateAt = 0;
					this.streamingComponent = new AssistantMessageComponent(
						undefined,
						this.hideThinkingBlock,
						this.getMarkdownThemeWithSettings(),
						this.hiddenThinkingLabel,
					);
					this.streamingMessage = event.message;
					this.chatContainer.addChild(this.streamingComponent);
					this.applyStreamingMessageUpdate(this.streamingMessage, { force: true });
					this.trimLiveTuiHistory();
				}
				break;

			case "message_update":
				if (this.streamingComponent && event.message.role === "assistant") {
					this.applyStreamingMessageUpdate(event.message);
				}
				break;

			case "message_end":
				if (event.message.role === "user") break;
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message;
					let errorMessage: string | undefined;
					if (this.streamingMessage.stopReason === "aborted") {
						const retryAttempt = this.session.retryAttempt;
						errorMessage =
							retryAttempt > 0
								? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
								: "Operation aborted";
						this.streamingMessage.errorMessage = errorMessage;
					}
					this.applyStreamingMessageUpdate(this.streamingMessage, { force: true });

					if (this.streamingMessage.stopReason === "aborted" || this.streamingMessage.stopReason === "error") {
						if (!errorMessage) {
							errorMessage = this.streamingMessage.errorMessage || "Error";
						}
						for (const [, component] of this.toolPanels.activeEntries()) {
							component.updateResult({
								content: [{ type: "text", text: errorMessage }],
								isError: true,
							});
						}
						this.clearActiveToolCalls();
					} else {
						// Args are now complete - trigger diff computation for edit tools
						for (const [, component] of this.toolPanels.activeEntries()) {
							component.setArgsComplete();
						}
					}
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
					this.footer.invalidate();
				}
				this.ui.requestRender();
				break;

			case "tool_execution_start": {
				let component = this.toolPanels.getActive(event.toolCallId);
				if (!component) component = this.attachToolExecutionComponent(event.toolName, event.toolCallId, event.args);
				component.markExecutionStarted();
				this.ui.requestRender();
				break;
			}

			case "tool_execution_update": {
				const component = this.toolPanels.getActive(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.partialResult, isError: false }, true);
					this.ui.requestRender();
				}
				break;
			}

			case "tool_execution_end": {
				const component = this.toolPanels.getActive(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError });
					this.toolPanels.registerAliases(
						component,
						getToolPanelResultActionKeys(this.getToolPanelScope(), event.toolName, event.result),
					);
					this.toolPanels.finish(event.toolCallId);
					this.ui.requestRender();
				}
				break;
			}

			case "agent_end":
				// Native in-process reflection fully replaces the subprocess learning paths
				// (continuous-learning AND autonomy-review) when enabled; otherwise fall back to legacy.
				if (this.isNativeReflectionEnabled()) {
					this.maybeRunNativeReflection(event.messages);
				} else if (!this.maybeStartAutoLearn()) {
					this.maybeStartAutonomyReview(event.messages);
				}
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(false);
				}
				if (this.loadingAnimation) {
					this.loadingAnimation.stop();
					this.loadingAnimation = undefined;
					this.statusContainer.clear();
				}
				if (this.streamingComponent) {
					this.chatContainer.removeChild(this.streamingComponent);
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
				}
				this.clearActiveToolCalls();

				await this.checkShutdownRequested();

				this.ui.requestRender();
				break;

			case "compaction_start": {
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(true);
				}
				// Keep editor active; submissions are queued during compaction.
				this.autoCompactionEscapeHandler = this.defaultEditor.onEscape;
				this.defaultEditor.onEscape = () => {
					this.session.abortCompaction();
				};
				this.statusContainer.clear();
				const cancelHint = `(${keyText("app.interrupt")} to cancel)`;
				const label =
					event.reason === "manual"
						? `Compacting context... ${cancelHint}`
						: `${event.reason === "overflow" ? "Context overflow detected, " : ""}Auto-compacting... ${cancelHint}`;
				this.autoCompactionLoader = new Loader(
					this.ui,
					(spinner) => theme.fg("accent", spinner),
					(text) => theme.fg("muted", text),
					label,
				);
				this.statusContainer.addChild(this.autoCompactionLoader);
				this.ui.requestRender();
				break;
			}

			case "compaction_end": {
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(false);
				}
				if (this.autoCompactionEscapeHandler) {
					this.defaultEditor.onEscape = this.autoCompactionEscapeHandler;
					this.autoCompactionEscapeHandler = undefined;
				}
				if (this.autoCompactionLoader) {
					this.autoCompactionLoader.stop();
					this.autoCompactionLoader = undefined;
					this.statusContainer.clear();
				}
				if (event.aborted) {
					if (event.reason === "manual") {
						this.showError("Compaction cancelled");
					} else {
						this.showStatus("Auto-compaction cancelled");
					}
				} else if (event.result) {
					await this.rebuildChatFromMessages();
					this.addMessageToChat(
						createCompactionSummaryMessage(
							event.result.summary,
							event.result.tokensBefore,
							new Date().toISOString(),
						),
					);
					this.footer.invalidate();
				} else if (event.errorMessage) {
					if (event.reason === "manual") {
						this.showError(event.errorMessage);
					} else {
						this.chatContainer.addChild(new Spacer(1));
						this.chatContainer.addChild(new Text(theme.fg("error", event.errorMessage), 1, 0));
					}
				} else if (event.skipReason) {
					// Benign auto-compaction no-op: still tell the user WHY nothing changed —
					// an invisible skip is indistinguishable from broken compaction.
					this.showStatus(`Auto-compaction skipped: ${event.skipReason}`);
				}
				void this.flushCompactionQueue({ willRetry: event.willRetry });
				this.ui.requestRender();
				break;
			}

			case "auto_retry_start": {
				// Set up escape to abort retry
				this.retryEscapeHandler = this.defaultEditor.onEscape;
				this.defaultEditor.onEscape = () => {
					this.session.abortRetry();
				};
				// Show retry indicator
				this.statusContainer.clear();
				this.retryCountdown?.dispose();
				const retryMessage = (seconds: number) =>
					`Retrying (${event.attempt}/${event.maxAttempts}) in ${seconds}s... (${keyText("app.interrupt")} to cancel)`;
				this.retryLoader = new Loader(
					this.ui,
					(spinner) => theme.fg("warning", spinner),
					(text) => theme.fg("muted", text),
					retryMessage(Math.ceil(event.delayMs / 1000)),
				);
				this.retryCountdown = new CountdownTimer(
					event.delayMs,
					this.ui,
					(seconds) => {
						this.retryLoader?.setMessage(retryMessage(seconds));
					},
					() => {
						this.retryCountdown = undefined;
					},
				);
				this.statusContainer.addChild(this.retryLoader);
				this.ui.requestRender();
				break;
			}

			case "auto_retry_end": {
				// Restore escape handler
				if (this.retryEscapeHandler) {
					this.defaultEditor.onEscape = this.retryEscapeHandler;
					this.retryEscapeHandler = undefined;
				}
				if (this.retryCountdown) {
					this.retryCountdown.dispose();
					this.retryCountdown = undefined;
				}
				// Stop loader
				if (this.retryLoader) {
					this.retryLoader.stop();
					this.retryLoader = undefined;
					this.statusContainer.clear();
				}
				// Show error only on final failure (success shows normal response)
				if (!event.success) {
					this.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
				}
				this.ui.requestRender();
				break;
			}
		}
	}

	/** Extract text content from a user message */
	// Thin `this.`-delegate to the pure formatter in ./history-reload-math.ts; kept so
	// addMessageToChat and the prototype-based interactive-mode tests resolve it via `this`.
	private getUserMessageText(message: Message): string {
		return historyReloadMath.getUserMessageText(message);
	}

	private resetLiveTuiHistoryTrim(): void {
		this.liveHistoryHiddenNotice = undefined;
		this.liveHistoryHiddenComponents = 0;
	}

	private clearPendingStreamingUiUpdate(): void {
		if (!this.streamingUiUpdateTimer) return;
		clearTimeout(this.streamingUiUpdateTimer);
		this.streamingUiUpdateTimer = undefined;
	}

	private getSessionEntryCount(): number {
		const manager = this.sessionManager as typeof this.sessionManager & { getEntryCount?: () => number };
		return manager.getEntryCount?.() ?? manager.getEntries().length;
	}

	private showDeferredHistoryPlaceholder(options: { requestRender?: boolean } = {}): void {
		this.chatContainer.children = [];
		this.resetLiveTuiHistoryTrim();
		this.clearRenderedToolPanelState();

		const entryCount = this.getSessionEntryCount();
		if (entryCount > 0) {
			this.chatContainer.addChild(
				new Text(
					theme.fg(
						"dim",
						`History hidden for typing performance (${entryCount} entries). Press ${keyText("app.tools.expand")} to load session history on demand.`,
					),
					1,
					0,
				),
			);
		}

		if (options.requestRender ?? true) this.ui.requestRender();
	}

	private loadTuiHistoryOnDemand(): void {
		if (this.tuiHistoryLoadInProgress) return;
		if (this.tuiHistoryLoaded || this.getSessionEntryCount() === 0) {
			this.toggleToolOutputExpansion();
			return;
		}

		this.tuiHistoryLoadInProgress = true;
		void (async () => {
			try {
				await this.renderInitialMessages({ forceHistoryLoad: true });
			} catch (error) {
				this.showError(`Failed to load TUI history: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				this.tuiHistoryLoadInProgress = false;
			}
		})();
	}

	private attachStreamingToolPanels(message: AssistantMessage): void {
		for (const content of message.content) {
			if (content.type !== "toolCall") continue;
			if (!this.toolPanels.hasActive(content.id)) {
				this.attachToolExecutionComponent(content.name, content.id, content.arguments);
			} else {
				const component = this.toolPanels.getActive(content.id);
				if (component) {
					component.updateArgs(content.arguments);
				}
			}
		}
	}

	private applyStreamingMessageUpdate(message: AssistantMessage, options: { force?: boolean } = {}): void {
		this.streamingMessage = message;
		if (!this.streamingComponent) return;

		const now = performance.now();
		const elapsed = now - this.lastStreamingUiUpdateAt;
		const hasToolCall = message.content.some((content) => content.type === "toolCall");
		const shouldUpdateNow = options.force || hasToolCall || elapsed >= STREAMING_UI_UPDATE_INTERVAL_MS;

		const update = () => {
			if (!this.streamingComponent || !this.streamingMessage) return;
			this.streamingComponent.updateContent(this.streamingMessage);
			this.attachStreamingToolPanels(this.streamingMessage);
			this.lastStreamingUiUpdateAt = performance.now();
			this.ui.requestRender();
		};

		if (shouldUpdateNow) {
			this.clearPendingStreamingUiUpdate();
			update();
			return;
		}

		if (this.streamingUiUpdateTimer) return;
		this.streamingUiUpdateTimer = setTimeout(
			() => {
				this.streamingUiUpdateTimer = undefined;
				update();
			},
			Math.max(0, STREAMING_UI_UPDATE_INTERVAL_MS - elapsed),
		);
	}

	private trimLiveTuiHistory(): void {
		const children = this.chatContainer.children;
		if (children.length <= TUI_LIVE_HISTORY_MAX_COMPONENTS) return;

		let protectedStart = children.length;
		const protect = (component: Component | undefined) => {
			if (!component) return;
			const index = children.indexOf(component);
			if (index !== -1 && index < protectedStart) protectedStart = index;
		};

		protect(this.streamingComponent);
		protect(this.lastStatusSpacer);
		protect(this.lastStatusText);
		for (const [, component] of this.toolPanels.activeEntries()) {
			protect(component);
		}

		const trimStart = children[0] === this.liveHistoryHiddenNotice ? 1 : 0;
		const targetTrimEnd = children.length - TUI_LIVE_HISTORY_TRIM_TO_COMPONENTS;
		const trimEnd = Math.min(targetTrimEnd, protectedStart);
		if (trimEnd <= trimStart) return;

		const removed = children.splice(trimStart, trimEnd - trimStart);
		this.liveHistoryHiddenComponents += removed.length;
		if (removed.includes(this.lastStatusSpacer as Component)) this.lastStatusSpacer = undefined;
		if (removed.includes(this.lastStatusText as Component)) this.lastStatusText = undefined;

		const noticeText = theme.fg(
			"dim",
			`Older TUI history hidden to preserve FPS (${this.liveHistoryHiddenComponents} components). Full session remains available to the model.`,
		);
		if (children[0] === this.liveHistoryHiddenNotice) {
			this.liveHistoryHiddenNotice?.setText(noticeText);
			return;
		}

		this.liveHistoryHiddenNotice = new Text(noticeText, 1, 0);
		children.unshift(this.liveHistoryHiddenNotice);
	}

	private appendStatusToChat(message: string, options: { requestRender?: boolean } = {}): void {
		const children = this.chatContainer.children;
		const last = children.length > 0 ? children[children.length - 1] : undefined;
		const secondLast = children.length > 1 ? children[children.length - 2] : undefined;

		if (last && secondLast && last === this.lastStatusText && secondLast === this.lastStatusSpacer) {
			this.lastStatusText.setText(theme.fg("dim", message));
			if (options.requestRender ?? true) this.ui.requestRender();
			return;
		}

		const spacer = new Spacer(1);
		const text = new Text(theme.fg("dim", message), 1, 0);
		this.chatContainer.addChild(spacer);
		this.chatContainer.addChild(text);
		this.lastStatusSpacer = spacer;
		this.lastStatusText = text;
		this.trimLiveTuiHistory();
		if (options.requestRender ?? true) this.ui.requestRender();
	}

	/**
	 * Show a status message in the chat.
	 *
	 * If multiple status messages are emitted back-to-back (without anything else being added to the chat),
	 * we update the previous status line instead of appending new ones to avoid log spam.
	 */
	private showStatus(message: string): void {
		this.appendStatusToChat(message);
	}

	private addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void {
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.ui, message.excludeFromContext);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(
					message.exitCode,
					message.cancelled,
					message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
					message.fullOutputPath,
				);
				this.chatContainer.addChild(component);
				break;
			}
			case "custom": {
				if (message.display) {
					const renderer = this.session.extensionRunner.getMessageRenderer(message.customType);
					const component = new CustomMessageComponent(message, renderer, this.getMarkdownThemeWithSettings());
					component.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(component);
				}
				break;
			}
			case "compactionSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new CompactionSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "branchSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new BranchSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "user": {
				const textContent = this.getUserMessageText(message);
				if (textContent) {
					if (this.chatContainer.children.length > 0) {
						this.chatContainer.addChild(new Spacer(1));
					}
					const skillBlock = parseSkillBlock(textContent);
					if (skillBlock) {
						// Render skill block (collapsible)
						const component = new SkillInvocationMessageComponent(
							skillBlock,
							this.getMarkdownThemeWithSettings(),
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);
						// Render user message separately if present
						if (skillBlock.userMessage) {
							const userComponent = new UserMessageComponent(
								skillBlock.userMessage,
								this.getMarkdownThemeWithSettings(),
							);
							this.chatContainer.addChild(userComponent);
						}
					} else {
						const userComponent = new UserMessageComponent(textContent, this.getMarkdownThemeWithSettings());
						this.chatContainer.addChild(userComponent);
					}
					if (options?.populateHistory) {
						this.editor.addToHistory?.(textContent);
					}
				}
				break;
			}
			case "assistant": {
				const assistantComponent = new AssistantMessageComponent(
					message,
					this.hideThinkingBlock,
					this.getMarkdownThemeWithSettings(),
					this.hiddenThinkingLabel,
				);
				this.chatContainer.addChild(assistantComponent);
				break;
			}
			case "toolResult": {
				// Tool results are rendered inline with tool calls, handled separately
				break;
			}
			default: {
				const _exhaustive: never = message;
			}
		}
		this.trimLiveTuiHistory();
	}

	// Thin `this.`-delegate to the pure reload-window math in ./history-reload-math.ts;
	// kept so renderSessionContext and the prototype-based history tests resolve it via `this`.
	private messagesForTuiHistoryReload(messages: AgentMessage[]): {
		messages: AgentMessage[];
		omittedMessages: number;
		estimatedLines: number;
	} {
		return historyReloadMath.messagesForTuiHistoryReload(messages);
	}

	/**
	 * Render session context to chat. Used for initial load and rebuild after compaction.
	 * @param sessionContext Session context to render
	 * @param options.updateFooter Update footer state
	 * @param options.populateHistory Add user messages to editor history
	 */
	private renderGeneration = 0;

	private async renderSessionContext(
		sessionContext: SessionContext,
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): Promise<void> {
		// Build long history offscreen, then atomically swap it into the visible
		// chat container. This keeps the TUI responsive without flashing blank or
		// partial transcript frames during resume/reload/compaction rebuilds.
		const generation = ++this.renderGeneration;
		let processed = 0;
		let committed = false;

		const visibleChatContainer = this.chatContainer;
		const previousLiveHistoryHiddenNotice = this.liveHistoryHiddenNotice;
		const previousLiveHistoryHiddenComponents = this.liveHistoryHiddenComponents;
		const previousLastStatusSpacer = this.lastStatusSpacer;
		const previousLastStatusText = this.lastStatusText;
		const stagingChatContainer = new Container();

		this.chatContainer = stagingChatContainer;
		this.resetLiveTuiHistoryTrim();
		this.clearRenderedToolPanelState();
		const renderedPendingTools = new Map<string, ToolExecutionComponent>();

		try {
			if (options.updateFooter) {
				this.footer.invalidate();
				this.updateEditorBorderColor();
			}

			const tuiHistory = this.messagesForTuiHistoryReload(sessionContext.messages);
			if (tuiHistory.omittedMessages > 0) {
				this.appendStatusToChat(
					`Showing last ~${historyReloadMath.TUI_HISTORY_RELOAD_MAX_LINES} TUI history lines; omitted ${tuiHistory.omittedMessages} older message${tuiHistory.omittedMessages === 1 ? "" : "s"}. Full session remains available to the model.`,
					{ requestRender: false },
				);
			}

			for (const message of tuiHistory.messages) {
				if (processed > 0 && processed % TUI_HISTORY_RELOAD_CHUNK_SIZE === 0) {
					await new Promise((resolve) => setImmediate(resolve));
					if (generation !== this.renderGeneration) return;
				}
				processed++;
				// Assistant messages need special handling for tool calls
				if (message.role === "assistant") {
					this.addMessageToChat(message);
					// Render tool call components
					for (const content of message.content) {
						if (content.type === "toolCall") {
							const component = this.attachToolExecutionComponent(content.name, content.id, content.arguments);

							if (message.stopReason === "aborted" || message.stopReason === "error") {
								let errorMessage: string;
								if (message.stopReason === "aborted") {
									const retryAttempt = this.session.retryAttempt;
									errorMessage =
										retryAttempt > 0
											? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
											: "Operation aborted";
								} else {
									errorMessage = message.errorMessage || "Error";
								}
								component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
								this.toolPanels.finish(content.id);
							} else {
								renderedPendingTools.set(content.id, component);
							}
						}
					}
				} else if (message.role === "toolResult") {
					// Match tool results to pending tool components
					const component = renderedPendingTools.get(message.toolCallId);
					if (component) {
						component.updateResult(message);
						renderedPendingTools.delete(message.toolCallId);
						this.toolPanels.finish(message.toolCallId);
					}
				} else {
					// All other messages use standard rendering
					this.addMessageToChat(message, options);
				}
			}

			if (generation !== this.renderGeneration) return;
			visibleChatContainer.children = stagingChatContainer.children;
			committed = true;
		} finally {
			const stagedLiveHistoryHiddenNotice = this.liveHistoryHiddenNotice;
			const stagedLiveHistoryHiddenComponents = this.liveHistoryHiddenComponents;
			const stagedLastStatusSpacer = this.lastStatusSpacer;
			const stagedLastStatusText = this.lastStatusText;

			this.chatContainer = visibleChatContainer;
			if (committed) {
				this.liveHistoryHiddenNotice = stagedLiveHistoryHiddenNotice;
				this.liveHistoryHiddenComponents = stagedLiveHistoryHiddenComponents;
				this.lastStatusSpacer = stagedLastStatusSpacer;
				this.lastStatusText = stagedLastStatusText;
			} else {
				this.liveHistoryHiddenNotice = previousLiveHistoryHiddenNotice;
				this.liveHistoryHiddenComponents = previousLiveHistoryHiddenComponents;
				this.lastStatusSpacer = previousLastStatusSpacer;
				this.lastStatusText = previousLastStatusText;
			}
		}

		if (committed) this.ui.requestRender();
	}

	async renderInitialMessages(options: { forceHistoryLoad?: boolean } = {}): Promise<void> {
		if (!options.forceHistoryLoad) {
			this.tuiHistoryLoaded = false;
			this.showDeferredHistoryPlaceholder({ requestRender: true });
			this.footer.invalidate();
			this.updateEditorBorderColor();
			return;
		}

		// Get aligned messages and entries from session context only when the user
		// explicitly requests TUI history. The model/session state is already loaded.
		const context = this.sessionManager.buildSessionContext();
		await this.renderSessionContext(context, {
			updateFooter: true,
			populateHistory: true,
		});
		this.tuiHistoryLoaded = true;

		// Show compaction info if session was compacted
		const allEntries = this.sessionManager.getEntries();
		const compactionCount = allEntries.filter((e) => e.type === "compaction").length;
		if (compactionCount > 0) {
			const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
			this.showStatus(`Session compacted ${times}`);
		}
	}

	async getUserInput(): Promise<UserInputSubmission> {
		const queuedInput = this.pendingUserInputs.shift();
		if (queuedInput !== undefined) {
			return queuedInput;
		}

		return new Promise((resolve) => {
			this.onInputCallback = (submission: UserInputSubmission) => {
				this.onInputCallback = undefined;
				resolve(submission);
			};
		});
	}

	private async rebuildChatFromMessages(): Promise<void> {
		if (!this.tuiHistoryLoaded) {
			this.showDeferredHistoryPlaceholder({ requestRender: true });
			return;
		}
		const context = this.sessionManager.buildSessionContext();
		await this.renderSessionContext(context);
	}

	// =========================================================================
	// Key handlers
	// =========================================================================

	private handleCtrlC(): void {
		const now = Date.now();
		if (now - this.lastSigintTime < 500) {
			void this.shutdown();
		} else {
			this.clearEditor();
			this.lastSigintTime = now;
		}
	}

	private handleCtrlD(): void {
		// Only called when editor is empty (enforced by CustomEditor)
		void this.shutdown();
	}

	/**
	 * Gracefully shutdown the agent.
	 * Stops the TUI before emitting shutdown events so extension UI cleanup cannot
	 * repaint the final frame while the process is exiting.
	 */
	private isShuttingDown = false;

	private shutdown(options?: { fromSignal?: boolean }): Promise<void> {
		const self = this;
		return signalLifecycle.shutdown(
			{
				get isShuttingDown() {
					return self.isShuttingDown;
				},
				set isShuttingDown(value) {
					self.isShuttingDown = value;
				},
				get signalCleanupHandlers() {
					return self.signalCleanupHandlers;
				},
				set signalCleanupHandlers(value) {
					self.signalCleanupHandlers = value;
				},
				get shutdownRequested() {
					return self.shutdownRequested;
				},
				runtimeHost: this.runtimeHost,
				ui: this.ui,
				stop: () => this.stop(),
				formatResumeCommand: () => formatResumeCommand(this.sessionManager),
				showStatus: (message) => this.showStatus(message),
				shutdown: (opts) => this.shutdown(opts),
				unregisterSignalHandlers: () => this.unregisterSignalHandlers(),
				emergencyTerminalExit: () => this.emergencyTerminalExit(),
				uncaughtCrash: (error) => this.uncaughtCrash(error),
			},
			options,
		);
	}

	private emergencyTerminalExit(): never {
		return signalLifecycle.emergencyTerminalExit(this as unknown as signalLifecycle.SignalLifecycleHost);
	}

	private uncaughtCrash(error: Error): never {
		return signalLifecycle.uncaughtCrash(this as unknown as signalLifecycle.SignalLifecycleHost, error);
	}

	private checkShutdownRequested(): Promise<void> {
		return signalLifecycle.checkShutdownRequested(this as unknown as signalLifecycle.SignalLifecycleHost);
	}

	private registerSignalHandlers(): void {
		signalLifecycle.registerSignalHandlers(this as unknown as signalLifecycle.SignalLifecycleHost);
	}

	private unregisterSignalHandlers(): void {
		signalLifecycle.unregisterSignalHandlers(this as unknown as signalLifecycle.SignalLifecycleHost);
	}

	private handleCtrlZ(): void {
		signalLifecycle.handleCtrlZ({ ui: this.ui, showStatus: (message) => this.showStatus(message) });
	}

	private async handleFollowUp(): Promise<void> {
		const text = (this.editor.getExpandedText?.() ?? this.editor.getText()).trim();
		if (!text) return;

		// Queue input during compaction (extension commands execute immediately)
		if (this.session.isCompacting) {
			if (this.isExtensionCommand(text)) {
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				try {
					await this.session.prompt(text);
				} finally {
					this.refreshAutonomyFooterStatus();
				}
			} else {
				const images = this.takeClipboardImagesForText(text);
				this.queueCompactionMessage(text, "followUp", images);
			}
			return;
		}

		// Alt+Enter queues a follow-up message (waits until agent finishes)
		// This handles extension commands (execute immediately), prompt template expansion, and queueing
		if (this.session.isStreaming) {
			const images = this.takeClipboardImagesForText(text);
			this.editor.addToHistory?.(text);
			this.editor.setText("");
			try {
				await this.session.prompt(text, { streamingBehavior: "followUp", images });
			} finally {
				this.refreshAutonomyFooterStatus();
			}
			this.updatePendingMessagesDisplay();
			this.ui.requestRender();
		}
		// If not streaming, Alt+Enter acts like regular Enter (trigger onSubmit)
		else if (this.editor.onSubmit) {
			await this.editor.onSubmit(text);
			this.editor.setText("");
		}
	}

	private handleDequeue(): void {
		const restored = this.restoreQueuedMessagesToEditor();
		if (restored === 0) {
			this.showStatus("No queued messages to restore");
		} else {
			this.showStatus(`Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`);
		}
	}

	private updateEditorBorderColor(): void {
		if (this.isBashMode) {
			this.editor.borderColor = theme.getBashModeBorderColor();
		} else {
			const level = this.session.thinkingLevel || "off";
			this.editor.borderColor = theme.getThinkingBorderColor(level);
		}
		this.ui.requestRender();
	}

	private cycleThinkingLevel(): void {
		const newLevel = this.session.cycleThinkingLevel();
		if (newLevel === undefined) {
			this.showStatus("Current model does not support thinking");
		} else {
			this.footer.invalidate();
			this.updateEditorBorderColor();
			this.showStatus(`Thinking level: ${newLevel}`);
		}
	}

	private async cycleModel(direction: "forward" | "backward"): Promise<void> {
		try {
			const result = await this.session.cycleModel(direction);
			if (result === undefined) {
				const msg = this.session.scopedModels.length > 0 ? "Only one model in scope" : "Only one model available";
				this.showStatus(msg);
			} else {
				this.footer.invalidate();
				this.updateEditorBorderColor();
				const thinkingStr =
					result.model.reasoning && result.thinkingLevel !== "off" ? ` (thinking: ${result.thinkingLevel})` : "";
				this.showStatus(`Switched to ${result.model.name || result.model.id}${thinkingStr}`);
				void this.maybeWarnAboutAnthropicSubscriptionAuth(result.model);
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private toggleToolOutputExpansion(): void {
		this.setToolsExpanded(!this.toolOutputExpanded);
	}

	private setToolsExpanded(expanded: boolean): void {
		this.toolOutputExpanded = expanded;
		const activeHeader = this.extensionUiHost.getCustomHeader() ?? this.builtInHeader;
		if (isExpandable(activeHeader)) {
			activeHeader.setExpanded(expanded);
		}
		for (const child of this.chatContainer.children) {
			if (isExpandable(child)) {
				child.setExpanded(expanded);
			}
		}
		this.ui.requestRender();
	}

	private async toggleThinkingBlockVisibility(): Promise<void> {
		this.hideThinkingBlock = !this.hideThinkingBlock;
		this.settingsManager.setHideThinkingBlock(this.hideThinkingBlock);

		// Rebuild chat from session messages
		await this.rebuildChatFromMessages();

		// If streaming, re-add the streaming component with updated visibility and re-render
		if (this.streamingComponent && this.streamingMessage) {
			this.streamingComponent.setHideThinkingBlock(this.hideThinkingBlock);
			this.streamingComponent.updateContent(this.streamingMessage);
			this.chatContainer.addChild(this.streamingComponent);
		}

		this.showStatus(`Thinking blocks: ${this.hideThinkingBlock ? "hidden" : "visible"}`);
	}

	private openExternalEditor(): Promise<void> {
		return openExternalEditor({
			editor: this.editor,
			ui: this.ui,
			showWarning: (message) => this.showWarning(message),
		});
	}

	private openEditorForPath(filePath: string): Promise<boolean> {
		return openEditorForPath(
			{
				editor: this.editor,
				ui: this.ui,
				showWarning: (message) => this.showWarning(message),
			},
			filePath,
		);
	}

	// =========================================================================
	// UI helpers
	// =========================================================================

	clearEditor(): void {
		this.editor.setText("");
		this.ui.requestRender();
	}

	showError(errorMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("error", `Error: ${errorMessage}`), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.ui.requestRender();
	}

	showWarning(warningMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("warning", `Warning: ${warningMessage}`), 1, 0));
		this.ui.requestRender();
	}

	showNewVersionNotification(release: LatestPiRelease): void {
		startupChecks.showNewVersionNotification(this.startupChecksHost(), release);
	}

	showPackageUpdateNotification(packages: string[]): void {
		startupChecks.showPackageUpdateNotification(this.startupChecksHost(), packages);
	}

	/**
	 * Get all queued messages (read-only).
	 * Combines session queue and compaction queue.
	 */
	private getAllQueuedMessages(): { steering: string[]; followUp: string[] } {
		return {
			steering: [
				...this.session.getSteeringMessages(),
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "steer").map((msg) => msg.text),
			],
			followUp: [
				...this.session.getFollowUpMessages(),
				...this.session.getQueuedExtensionCommands(),
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "followUp").map((msg) => msg.text),
			],
		};
	}

	/**
	 * Clear all queued messages and return their contents.
	 * Clears both session queue and compaction queue.
	 */
	private clearAllQueues(): { steering: string[]; followUp: string[] } {
		const { steering, followUp, commands } = this.session.clearQueue();
		const compactionSteering = this.compactionQueuedMessages
			.filter((msg) => msg.mode === "steer")
			.map((msg) => msg.text);
		const compactionFollowUp = this.compactionQueuedMessages
			.filter((msg) => msg.mode === "followUp")
			.map((msg) => msg.text);
		this.compactionQueuedMessages = [];
		return {
			steering: [...steering, ...compactionSteering],
			followUp: [...followUp, ...commands, ...compactionFollowUp],
		};
	}

	private updatePendingMessagesDisplay(): void {
		this.pendingMessagesContainer.clear();
		const { steering: steeringMessages, followUp: followUpMessages } = this.getAllQueuedMessages();
		if (steeringMessages.length > 0 || followUpMessages.length > 0) {
			this.pendingMessagesContainer.addChild(new Spacer(1));
			for (const message of steeringMessages) {
				const text = theme.fg("dim", `Steering: ${message}`);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			for (const message of followUpMessages) {
				const text = theme.fg("dim", `Follow-up: ${message}`);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			const dequeueHint = this.getAppKeyDisplay("app.message.dequeue");
			const hintText = theme.fg("dim", `↳ ${dequeueHint} to edit all queued messages`);
			this.pendingMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
		}
	}

	private restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
		const { steering, followUp } = this.clearAllQueues();
		const allQueued = [...steering, ...followUp];
		if (allQueued.length === 0) {
			this.updatePendingMessagesDisplay();
			if (options?.abort) {
				this.agent.abort();
			}
			return 0;
		}
		const queuedText = allQueued.join("\n\n");
		const currentText = options?.currentText ?? this.editor.getText();
		const combinedText = [queuedText, currentText].filter((t) => t.trim()).join("\n\n");
		this.editor.setText(combinedText);
		this.updatePendingMessagesDisplay();
		if (options?.abort) {
			this.agent.abort();
		}
		return allQueued.length;
	}

	private queueCompactionMessage(text: string, mode: "steer" | "followUp", images?: ImageContent[]): void {
		this.compactionQueuedMessages.push({ text, mode, images });
		this.editor.addToHistory?.(text);
		this.editor.setText("");
		this.updatePendingMessagesDisplay();
		this.showStatus("Queued message for after compaction");
	}

	private isExtensionCommand(text: string): boolean {
		if (!text.startsWith("/")) return false;

		const extensionRunner = this.session.extensionRunner;

		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		return !!extensionRunner.getCommand(commandName);
	}

	private flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		const self = this;
		return compactionQueue.flushCompactionQueue(
			{
				get compactionQueuedMessages() {
					return self.compactionQueuedMessages;
				},
				set compactionQueuedMessages(value) {
					self.compactionQueuedMessages = value;
				},
				session: this.session,
				updatePendingMessagesDisplay: () => this.updatePendingMessagesDisplay(),
				showError: (message) => this.showError(message),
				isExtensionCommand: (text) => this.isExtensionCommand(text),
				refreshAutonomyFooterStatus: () => this.refreshAutonomyFooterStatus(),
			},
			options,
		);
	}

	/** Move pending bash components from pending area to chat */
	private flushPendingBashComponents(): void {
		for (const component of this.pendingBashComponents) {
			this.pendingMessagesContainer.removeChild(component);
			this.chatContainer.addChild(component);
		}
		this.pendingBashComponents = [];
	}

	// =========================================================================
	// Selectors
	// =========================================================================

	/**
	 * Shows a selector component in place of the editor.
	 * @param create Factory that receives a `done` callback and returns the component and focus target
	 */
	private showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
		const done = () => {
			this.overlayHost.swap(this.editor, { focusMode: "restore", render: "none" });
		};
		const { component, focus } = create(done);
		this.overlayHost.swap(component, { focus });
	}

	/** Narrow seam shared by the session-picker/tree/fork and model-selector flows. */
	private sessionFlowHost(): sessionFlows.SessionFlowHost {
		const self = this;
		return {
			session: this.session,
			sessionManager: this.sessionManager,
			settingsManager: this.settingsManager,
			runtimeHost: this.runtimeHost,
			ui: this.ui,
			chatContainer: this.chatContainer,
			statusContainer: this.statusContainer,
			editor: this.editor,
			defaultEditor: this.defaultEditor,
			footer: this.footer,
			extensionUiHost: this.extensionUiHost,
			keybindings: this.keybindings,
			get loadingAnimation() {
				return self.loadingAnimation;
			},
			set loadingAnimation(value) {
				self.loadingAnimation = value;
			},
			showSelector: (create) => this.showSelector(create),
			showStatus: (message) => this.showStatus(message),
			showError: (message) => this.showError(message),
			renderCurrentSessionState: () => this.renderCurrentSessionState(),
			renderInitialMessages: (options) => this.renderInitialMessages(options),
			flushCompactionQueue: (options) => this.flushCompactionQueue(options),
			handleFatalRuntimeError: (prefix, error) => this.handleFatalRuntimeError(prefix, error),
			promptForMissingSessionCwd: (error) => this.promptForMissingSessionCwd(error),
			updateEditorBorderColor: () => this.updateEditorBorderColor(),
			updateAvailableProviderCount: () => this.updateAvailableProviderCount(),
			maybeWarnAboutAnthropicSubscriptionAuth: (model) => this.maybeWarnAboutAnthropicSubscriptionAuth(model),
			checkDaxnutsEasterEgg: (model) => this.checkDaxnutsEasterEgg(model),
			getModelCandidates: () => this.getModelCandidates(),
			shutdown: (options) => this.shutdown(options),
		};
	}

	private getAutoLearnModelOptions(): SelectItem[] {
		return this.autoLearnController.getAutoLearnModelOptions();
	}

	private getAutoLearnDataDir(): string {
		return this.autoLearnController.getAutoLearnDataDir();
	}

	private getPrunedAutoLearnState(): AutoLearnState {
		return this.autoLearnController.getPrunedAutoLearnState();
	}

	private getAutoLearnPresetForAutonomyMode(
		mode: AutonomyMode,
		current: AutoLearnSettings = {},
	): Required<AutoLearnSettings> {
		return this.autoLearnController.getAutoLearnPresetForAutonomyMode(mode, current);
	}

	private getEffectiveAutoLearnSettings(): Required<AutoLearnSettings> {
		return this.autoLearnController.getEffectiveAutoLearnSettings();
	}

	private getCurrentAutoLearnSettings(): Required<AutoLearnSettings> {
		return this.autoLearnController.getCurrentAutoLearnSettings();
	}

	private getAutoLearnTenantKey(): string {
		return this.autoLearnController.getAutoLearnTenantKey();
	}

	private getAutoLearnTenantDataDir(): string {
		return this.autoLearnController.getAutoLearnTenantDataDir();
	}

	private validateAutoLearnModelValue(value: string | undefined): string | undefined {
		return this.autoLearnController.validateAutoLearnModelValue(value);
	}

	private collectSelfModificationCandidates(settings: { sourcePath?: string; sourcePaths?: string[] }): string[] {
		return [
			...(Array.isArray(settings.sourcePaths) ? settings.sourcePaths : []),
			...(settings.sourcePath ? [settings.sourcePath] : []),
		]
			.map((candidate) => candidate?.trim())
			.filter((candidate): candidate is string => Boolean(candidate));
	}

	private getCurrentCwdForSettings(): string {
		return this.runtimeHost?.session?.sessionManager?.getCwd?.() || process.cwd();
	}

	private resolveSelfModificationSource(settings: {
		sourcePath?: string;
		sourcePaths?: string[];
	}): string | undefined {
		const cwd = this.getCurrentCwdForSettings();
		const resolved = this.collectSelfModificationCandidates(settings).map((candidate) =>
			resolvePath(candidate, cwd, { trim: true }),
		);
		if (resolved.length === 0) return undefined;
		return (
			resolved.find(
				(candidate) => fs.existsSync(candidate) && fs.existsSync(path.join(candidate, "package.json")),
			) ?? resolved[0]
		);
	}

	private validateSelfModificationSource(settings: SelfModificationSettings): string | undefined {
		if (!settings.enabled) return undefined;
		const cwd = this.getCurrentCwdForSettings();
		const resolved = this.collectSelfModificationCandidates(settings).map((candidate) =>
			resolvePath(candidate, cwd, { trim: true }),
		);
		if (resolved.length === 0) return "Self modification is enabled, but no pi-adaptative source path is set.";
		const valid = resolved.find(
			(candidate) =>
				fs.existsSync(candidate) &&
				fs.existsSync(path.join(candidate, "package.json")) &&
				fs.existsSync(path.join(candidate, "packages", "coding-agent")),
		);
		if (valid) return undefined;
		const first = resolved[0];
		if (!fs.existsSync(first)) return `Self modification source path does not exist: ${first}`;
		if (!fs.existsSync(path.join(first, "package.json"))) {
			return `Self modification source path has no package.json: ${first}`;
		}
		return `Self modification source path does not look like pi-adaptative (missing packages/coding-agent): ${first}`;
	}

	private launchAutoLearn(
		reason: string,
		force = false,
		options: {
			cooldownKind?: "auto" | "reflection";
			promptKind?: "auto" | "reflection";
			turnDigest?: string;
			bypassReflectionCooldown?: boolean;
		} = {},
	): string {
		return this.autoLearnController.launchAutoLearn(reason, force, options);
	}

	private isNativeReflectionEnabled(): boolean {
		return this.autoLearnController.isNativeReflectionEnabled();
	}

	private maybeRunNativeReflection(messages: AgentMessage[]): void {
		this.autoLearnController.maybeRunNativeReflection(messages);
	}

	private maybeStartAutoLearn(): boolean {
		return this.autoLearnController.maybeStartAutoLearn();
	}

	private maybeStartAutonomyReview(messages: AgentMessage[]): boolean {
		return this.autoLearnController.maybeStartAutonomyReview(messages);
	}

	private updateAutoLearnFooter(): void {
		this.autoLearnController.updateAutoLearnFooter();
	}

	private formatAutoLearnStatus(): string {
		return this.autoLearnController.formatAutoLearnStatus();
	}

	private applyAutonomyMode(mode: AutonomyMode, scope: SettingsScope = "global"): void {
		const currentAutoLearn = this.settingsManager.getAutoLearnSettings();
		const preset = this.getAutoLearnPresetForAutonomyMode(mode, currentAutoLearn);
		this.settingsManager.setAutonomySettings({ ...this.settingsManager.getAutonomySettings(), mode }, scope);
		this.settingsManager.setAutoLearnSettings(preset, scope);
		this.updateAutoLearnFooter();
	}

	/**
	 * Delegates to the session rather than keeping its own instance (#27): the model router boots a
	 * local server through AgentSession.getLocalRuntime() before a routed turn, and `/models`
	 * commands need to see and be able to stop that SAME pi-managed process, not an unrelated one
	 * tracked separately here.
	 */
	private get localRuntime(): OllamaRuntime {
		return this.session.getLocalRuntime();
	}

	/** Narrow seam shared by the /models and /fitness flows. */
	private localModelHost(): localModelCommands.LocalModelHost {
		return {
			localRuntime: this.localRuntime,
			session: this.session,
			settingsManager: this.settingsManager,
			ui: this.ui,
			chatContainer: this.chatContainer,
			showStatus: (message) => this.showStatus(message),
			showError: (message) => this.showError(message),
			showSelector: (create) => this.showSelector(create),
		};
	}

	private handleModelsCommand(argsText: string): Promise<void> {
		return localModelCommands.handleModelsCommand(this.localModelHost(), argsText);
	}

	private showFitnessModelSelector(): void {
		localModelCommands.showFitnessModelSelector(this.localModelHost());
	}

	private runFitnessAndAssign(modelRef: string, preselectRole?: FitnessRole): Promise<void> {
		return localModelCommands.runFitnessAndAssign(
			{
				session: this.session,
				settingsManager: this.settingsManager,
				chatContainer: this.chatContainer,
				ui: this.ui,
				showStatus: (message) => this.showStatus(message),
				showError: (message) => this.showError(message),
				showSelector: (create) => this.showSelector(create),
			},
			modelRef,
			preselectRole,
		);
	}

	private assignFitnessRole(modelRef: string, role: FitnessRole): void {
		localModelCommands.assignFitnessRole(
			{
				settingsManager: this.settingsManager,
				showStatus: (message) => this.showStatus(message),
			},
			modelRef,
			role,
		);
	}

	/** Narrow seam for the /autonomy and /auto-learn command bodies. */
	private autonomyHost(): autonomyCommands.AutonomyHost {
		return {
			session: this.session,
			settingsManager: this.settingsManager,
			chatContainer: this.chatContainer,
			ui: this.ui,
			showStatus: (message) => this.showStatus(message),
			applyAutonomyMode: (mode, scope) => this.applyAutonomyMode(mode, scope),
			launchAutoLearn: (reason, force, options) => this.launchAutoLearn(reason, force, options),
			formatAutoLearnStatus: () => this.formatAutoLearnStatus(),
			getEffectiveAutoLearnSettings: () => this.getEffectiveAutoLearnSettings(),
			getPrunedAutoLearnState: () => this.getPrunedAutoLearnState(),
			getAutoLearnTenantKey: () => this.getAutoLearnTenantKey(),
			getAutoLearnDataDir: () => this.getAutoLearnDataDir(),
			getAutoLearnTenantDataDir: () => this.getAutoLearnTenantDataDir(),
		};
	}

	private handleAutonomyCommand(text: string): void {
		autonomyCommands.handleAutonomyCommand(this.autonomyHost(), text);
	}

	private handleAutoLearnCommand(text: string): void {
		autonomyCommands.handleAutoLearnCommand(this.autonomyHost(), text);
	}

	/** Wide seam for the /settings selector; the hideThinkingBlock field is read+written here. */
	private settingsSelectorHost(): settingsSelectorFlow.SettingsSelectorHost {
		const self = this;
		return {
			session: this.session,
			settingsManager: this.settingsManager,
			footer: this.footer,
			chatContainer: this.chatContainer,
			ui: this.ui,
			defaultEditor: this.defaultEditor,
			editor: this.editor,
			get hideThinkingBlock() {
				return self.hideThinkingBlock;
			},
			set hideThinkingBlock(value) {
				self.hideThinkingBlock = value;
			},
			showSelector: (create) => this.showSelector(create),
			showStatus: (message) => this.showStatus(message),
			showWarning: (message) => this.showWarning(message),
			showError: (message) => this.showError(message),
			getAutoLearnModelOptions: () => this.getAutoLearnModelOptions(),
			setupAutocompleteProvider: () => this.setupAutocompleteProvider(),
			updateEditorBorderColor: () => this.updateEditorBorderColor(),
			rebuildChatFromMessages: () => this.rebuildChatFromMessages(),
			validateSelfModificationSource: (settings) => this.validateSelfModificationSource(settings),
			applyAutonomyMode: (mode, scope) => this.applyAutonomyMode(mode, scope),
			validateAutoLearnModelValue: (value) => this.validateAutoLearnModelValue(value),
			updateAutoLearnFooter: () => this.updateAutoLearnFooter(),
			handleResourcesHubAction: (action) => this.handleResourcesHubAction(action),
		};
	}

	private showSettingsSelector(): void {
		settingsSelectorFlow.showSettingsSelector(this.settingsSelectorHost());
	}

	private handleResourcesHubAction(action: string): Promise<void> {
		return this.profileMenu.handleResourcesHubAction(action);
	}

	private handleProfilesCommand(profileName?: string): Promise<void> {
		return this.profileMenu.handleProfilesCommand(profileName);
	}

	private refreshAfterProfileMutation(profileName: string): Promise<void> {
		return this.profileMenu.refreshAfterProfileMutation(profileName);
	}

	private async handleModelCommand(searchTerm?: string): Promise<void> {
		await sessionFlows.handleModelCommand(this.sessionFlowHost(), searchTerm);
	}

	private async getModelCandidates(): Promise<Model<any>[]> {
		if (this.session.scopedModels.length > 0) {
			return this.session.scopedModels.map((scoped) => scoped.model);
		}

		this.session.modelRegistry.refresh();
		try {
			return await this.session.modelRegistry.getAvailable();
		} catch {
			return [];
		}
	}

	/** Update the footer's available provider count from current model candidates */
	private async updateAvailableProviderCount(): Promise<void> {
		const models = await this.getModelCandidates();
		const uniqueProviders = new Set(models.map((m) => m.provider));
		this.footerDataProvider.setAvailableProviderCount(uniqueProviders.size);
	}

	private async maybeWarnAboutAnthropicSubscriptionAuth(
		model: Model<any> | undefined = this.session.model,
	): Promise<void> {
		if (this.settingsManager.getWarnings().anthropicExtraUsage === false) {
			return;
		}
		if (this.anthropicSubscriptionWarningShown) {
			return;
		}
		if (!model || model.provider !== "anthropic") {
			return;
		}

		const storedCredential = this.session.modelRegistry.authStorage.get("anthropic");
		if (storedCredential?.type === "oauth") {
			this.anthropicSubscriptionWarningShown = true;
			this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
			return;
		}

		try {
			const apiKey = await this.session.modelRegistry.getApiKeyForProvider(model.provider);
			if (!isAnthropicSubscriptionAuthKey(apiKey)) {
				return;
			}
			this.anthropicSubscriptionWarningShown = true;
			this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
		} catch {
			// Ignore auth lookup failures for warning-only checks.
		}
	}

	private async showModelSelector(initialSearchInput?: string): Promise<void> {
		await sessionFlows.showModelSelector(this.sessionFlowHost(), initialSearchInput);
	}

	private async showModelsSelector(): Promise<void> {
		await sessionFlows.showModelsSelector(this.sessionFlowHost());
	}

	private showUserMessageSelector(newSessionName?: string): void {
		sessionFlows.showUserMessageSelector(this.sessionFlowHost(), newSessionName);
	}

	private async handleCloneCommand(newSessionName?: string): Promise<void> {
		await sessionFlows.handleCloneCommand(
			{
				sessionManager: this.sessionManager,
				runtimeHost: this.runtimeHost,
				renderCurrentSessionState: () => this.renderCurrentSessionState(),
				editor: this.editor,
				session: this.session,
				showStatus: (message) => this.showStatus(message),
				showError: (message) => this.showError(message),
				ui: this.ui,
			},
			newSessionName,
		);
	}

	private showTreeSelector(initialSelectedId?: string): void {
		sessionFlows.showTreeSelector(this.sessionFlowHost(), initialSelectedId);
	}

	private showTrustSelector(): void {
		sessionFlows.showTrustSelector(this.sessionFlowHost());
	}

	private showSessionSelector(): void {
		sessionFlows.showSessionSelector(this.sessionFlowHost());
	}

	private handleResumeSession(
		sessionPath: string,
		options?: Parameters<ExtensionCommandContext["switchSession"]>[1],
	): Promise<{ cancelled: boolean }> {
		return sessionFlows.handleResumeSession(this.sessionFlowHost(), sessionPath, options);
	}

	// =========================================================================
	// Command handlers
	// =========================================================================

	private async handleReloadCommand(): Promise<void> {
		if (this.session.isStreaming) {
			this.showWarning("Wait for the current response to finish before reloading.");
			return;
		}
		if (this.session.isCompacting) {
			this.showWarning("Wait for compaction to finish before reloading.");
			return;
		}

		this.extensionUiHost.resetExtensionUI();

		const reloadBox = new Container();
		const borderColor = (s: string) => theme.fg("border", s);
		reloadBox.addChild(new DynamicBorder(borderColor));
		reloadBox.addChild(new Spacer(1));
		reloadBox.addChild(
			new Text(theme.fg("muted", "Reloading keybindings, extensions, skills, prompts, themes..."), 1, 0),
		);
		reloadBox.addChild(new Spacer(1));
		reloadBox.addChild(new DynamicBorder(borderColor));

		const previousEditor = this.editor;
		this.overlayHost.swap(reloadBox, { render: "sync" });
		// Let the terminal paint the reload notice before CPU-heavy extension/theme
		// work begins. process.nextTick runs before I/O and can still make reloads
		// appear frozen.
		await new Promise((resolve) => setImmediate(resolve));

		const dismissReloadBox = (editor: Component) => {
			this.overlayHost.swap(editor);
		};

		try {
			await this.session.reload();
			configureHttpDispatcher(this.settingsManager.getHttpIdleTimeoutMs());
			this.keybindings.reload();
			const activeHeader = this.extensionUiHost.getCustomHeader() ?? this.builtInHeader;
			if (isExpandable(activeHeader)) {
				activeHeader.setExpanded(this.toolOutputExpanded);
			}
			setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
			this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
			const themeName = this.settingsManager.getTheme();
			const themeResult = themeName ? setTheme(themeName, true) : { success: true };
			if (!themeResult.success) {
				this.showError(`Failed to load theme "${themeName}": ${themeResult.error}\nFell back to dark theme.`);
			}
			const editorPaddingX = this.settingsManager.getEditorPaddingX();
			const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
			this.defaultEditor.setPaddingX(editorPaddingX);
			this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
			if (this.editor !== this.defaultEditor) {
				this.editor.setPaddingX?.(editorPaddingX);
				this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
			}
			this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
			this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
			this.setupAutocompleteProvider();
			const runner = this.session.extensionRunner;
			this.extensionUiHost.setupExtensionShortcuts(runner);
			await this.rebuildChatFromMessages();
			dismissReloadBox(this.editor as Component);
			this.showLoadedResources({
				force: false,
				showDiagnosticsWhenQuiet: true,
			});
			const modelsJsonError = this.session.modelRegistry.getError();
			if (modelsJsonError) {
				this.showError(`models.json error: ${modelsJsonError}`);
			}
			this.showStatus("Reloaded keybindings, extensions, skills, prompts, themes");
		} catch (error) {
			dismissReloadBox(previousEditor as Component);
			this.showError(`Reload failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Refresh UI after extensions are loaded/unloaded live.
	 * Performs the same refresh calls as handleReloadCommand but without the full reload.
	 */
	private async refreshUIAfterExtensionsChanged(): Promise<void> {
		try {
			// Refresh keybindings and autocomplete
			this.keybindings.reload();
			this.setupAutocompleteProvider();

			// Refresh themes
			const activeHeader = this.extensionUiHost.getCustomHeader() ?? this.builtInHeader;
			if (isExpandable(activeHeader)) {
				activeHeader.setExpanded(this.toolOutputExpanded);
			}
			setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
			this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
			const themeName = this.settingsManager.getTheme();
			const themeResult = themeName ? setTheme(themeName, true) : { success: true };
			if (!themeResult.success) {
				this.showError(`Failed to load theme "${themeName}": ${themeResult.error}\nFell back to dark theme.`);
			}

			// Refresh editor settings
			const editorPaddingX = this.settingsManager.getEditorPaddingX();
			const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
			this.defaultEditor.setPaddingX(editorPaddingX);
			this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
			if (this.editor !== this.defaultEditor) {
				this.editor.setPaddingX?.(editorPaddingX);
				this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
			}

			// Refresh extension shortcuts
			const runner = this.session.extensionRunner;
			this.extensionUiHost.setupExtensionShortcuts(runner);

			// Refresh chat and UI
			await this.rebuildChatFromMessages();
			this.footer.invalidate();
			this.ui.requestRender();
		} catch (error) {
			this.showError(`Extension refresh failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Reconcile extensions for the active profile and refresh UI.
	 * Used when only extensions change in the active profile to avoid full reload.
	 */
	private async reconcileExtensionsAndRefreshUI(profileName: string): Promise<void> {
		try {
			await this.session.reconcileLoadedExtensions();
			const active = this.settingsManager.getActiveResourceProfileNames()[0] ?? "(none)";
			this.footerDataProvider.setExtensionStatus("profile", active);
			this.footer.invalidate();
			this.updateEditorBorderColor();
		} catch (error) {
			// On error, fall back to full reload
			try {
				await this.refreshAfterProfileMutation(profileName);
			} catch {
				// If full reload also fails, show error
				this.showError(`Failed to reconcile extensions: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	private handleExportCommand(text: string): Promise<void> {
		return sessionIoCommands.handleExportCommand(
			{
				session: this.session,
				getPathCommandArgument: (t, command) => this.getPathCommandArgument(t, command),
				showStatus: (message) => this.showStatus(message),
				showError: (message) => this.showError(message),
			},
			text,
		);
	}

	private getPathCommandArgument(text: string, command: "/export" | "/import"): string | undefined {
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

	private handleImportCommand(text: string): Promise<void> {
		const self = this;
		return sessionIoCommands.handleImportCommand(
			{
				getPathCommandArgument: (t, command) => this.getPathCommandArgument(t, command),
				showError: (message) => this.showError(message),
				showStatus: (message) => this.showStatus(message),
				extensionUiHost: this.extensionUiHost,
				get loadingAnimation() {
					return self.loadingAnimation;
				},
				set loadingAnimation(value) {
					self.loadingAnimation = value;
				},
				statusContainer: this.statusContainer,
				runtimeHost: this.runtimeHost,
				renderCurrentSessionState: () => this.renderCurrentSessionState(),
				promptForMissingSessionCwd: (error) => this.promptForMissingSessionCwd(error),
				handleFatalRuntimeError: (prefix, error) => this.handleFatalRuntimeError(prefix, error),
			},
			text,
		);
	}

	private handleShareCommand(): Promise<void> {
		return sessionIoCommands.handleShareCommand({
			showError: (message) => this.showError(message),
			showStatus: (message) => this.showStatus(message),
			session: this.session,
			ui: this.ui,
			overlayHost: this.overlayHost,
			editor: this.editor,
		});
	}

	private handleCopyCommand(): Promise<void> {
		return sessionIoCommands.handleCopyCommand({
			session: this.session,
			showError: (message) => this.showError(message),
			showStatus: (message) => this.showStatus(message),
		});
	}

	private handleNameCommand(text: string): void {
		sessionIoCommands.handleNameCommand(
			{
				sessionManager: this.sessionManager,
				chatContainer: this.chatContainer,
				showWarning: (message) => this.showWarning(message),
				session: this.session,
				ui: this.ui,
			},
			text,
		);
	}

	private parseGoalContinueCommand(
		text: string,
	):
		| { ok: true; maxTurns: number; maxStallTurns: number; maxWallClockMinutes: number }
		| { ok: false; error: string } {
		const usage = "Usage: /goal-continue [maxTurns 1-20] [maxStallTurns 0-100] [maxMinutes 0-1440]";
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

		const maxTurns = parseBoundedInteger(parts[0], DEFAULT_GOAL_CONTINUE_MAX_TURNS, 1, MAX_GOAL_CONTINUE_MAX_TURNS);
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

	private async handleGoalContinueCommand(text: string): Promise<void> {
		await sessionFlows.handleGoalContinueCommand(
			{
				session: this.session,
				parseGoalContinueCommand: (t) => this.parseGoalContinueCommand(t),
				showStatus: (message) => this.showStatus(message),
				showError: (message) => this.showError(message),
				refreshAutonomyFooterStatus: () => this.refreshAutonomyFooterStatus(),
			},
			text,
		);
	}

	private handleSessionCommand(): void {
		sessionFlows.handleSessionCommand({
			session: this.session,
			sessionManager: this.sessionManager,
			chatContainer: this.chatContainer,
			ui: this.ui,
		});
	}

	private handleUsageCommand(): void {
		reportCommands.handleUsageCommand({
			session: this.session,
			chatContainer: this.chatContainer,
			ui: this.ui,
			getCurrentAutoLearnSettings: () => this.getCurrentAutoLearnSettings(),
		});
	}

	private handleChangelogCommand(): void {
		reportCommands.handleChangelogCommand({
			chatContainer: this.chatContainer,
			ui: this.ui,
			getMarkdownThemeWithSettings: () => this.getMarkdownThemeWithSettings(),
		});
	}

	/**
	 * Get capitalized display string for an app keybinding action.
	 */
	private getAppKeyDisplay(action: AppKeybinding): string {
		return keyDisplayText(action);
	}

	/**
	 * Get capitalized display string for an editor keybinding action.
	 */
	private getEditorKeyDisplay(action: Keybinding): string {
		return keyDisplayText(action);
	}

	private handleHotkeysCommand(): void {
		reportCommands.handleHotkeysCommand({
			session: this.session,
			keybindings: this.keybindings,
			chatContainer: this.chatContainer,
			ui: this.ui,
			getMarkdownThemeWithSettings: () => this.getMarkdownThemeWithSettings(),
			getAppKeyDisplay: (action) => this.getAppKeyDisplay(action),
			getEditorKeyDisplay: (action) => this.getEditorKeyDisplay(action),
		});
	}

	private async handleClearCommand(newSessionName?: string): Promise<void> {
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();
		try {
			const result = await this.runtimeHost.newSession();
			if (result.cancelled) {
				return;
			}
			this.renderCurrentSessionState();
			if (newSessionName) {
				this.session.setSessionName(newSessionName);
			}
			this.chatContainer.addChild(new Spacer(1));
			const label = newSessionName ? `✓ New session started: ${newSessionName}` : "✓ New session started";
			this.chatContainer.addChild(new Text(`${theme.fg("accent", label)}`, 1, 1));
			this.ui.requestRender();
		} catch (error: unknown) {
			await this.handleFatalRuntimeError("Failed to create session", error);
		}
	}

	private copyResourcesRecursively(
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

	private handleInstallResourcesCommand(argsString: string): Promise<void> {
		return resourceShellCommands.handleInstallResourcesCommand(
			{
				settingsManager: this.settingsManager,
				showError: (message) => this.showError(message),
				showStatus: (message) => this.showStatus(message),
				showSelector: (create) => this.showSelector(create),
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
	private handleCurateCommand(args: string): void {
		resourceShellCommands.handleCurateCommand(
			{
				session: this.session,
				showStatus: (message) => this.showStatus(message),
			},
			args,
		);
	}

	private async handleConfigBackupCommand(fileArg?: string): Promise<void> {
		await configBackup.handleConfigBackupCommand(
			{
				settingsManager: this.settingsManager,
				showStatus: (message) => this.showStatus(message),
				showError: (message) => this.showError(message),
			},
			fileArg,
		);
	}

	private async handleConfigRestoreCommand(fileArg: string): Promise<void> {
		await configBackup.handleConfigRestoreCommand(
			{
				settingsManager: this.settingsManager,
				showStatus: (message) => this.showStatus(message),
				showError: (message) => this.showError(message),
				showSelector: (create) => this.showSelector(create),
				handleReloadCommand: () => this.handleReloadCommand(),
			},
			fileArg,
		);
	}

	private handleDebugCommand(): void {
		reportCommands.handleDebugCommand({
			session: this.session,
			chatContainer: this.chatContainer,
			ui: this.ui,
		});
	}

	private handleArminSaysHi(): void {
		reportCommands.handleArminSaysHi({ chatContainer: this.chatContainer, ui: this.ui });
	}

	private handleDementedDelves(): void {
		reportCommands.handleDementedDelves({ chatContainer: this.chatContainer, ui: this.ui });
	}

	private checkDaxnutsEasterEgg(model: { provider: string; id: string }): void {
		reportCommands.checkDaxnutsEasterEgg({ chatContainer: this.chatContainer, ui: this.ui }, model);
	}

	private handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
		const self = this;
		return resourceShellCommands.handleBashCommand(
			{
				session: this.session,
				sessionManager: this.sessionManager,
				ui: this.ui,
				chatContainer: this.chatContainer,
				pendingMessagesContainer: this.pendingMessagesContainer,
				pendingBashComponents: this.pendingBashComponents,
				get bashComponent() {
					return self.bashComponent;
				},
				set bashComponent(value) {
					self.bashComponent = value;
				},
				showError: (message) => this.showError(message),
			},
			command,
			excludeFromContext,
		);
	}

	private handleCompactCommand(customInstructions?: string): Promise<void> {
		const self = this;
		return resourceShellCommands.handleCompactCommand(
			{
				sessionManager: this.sessionManager,
				showWarning: (message) => this.showWarning(message),
				get loadingAnimation() {
					return self.loadingAnimation;
				},
				set loadingAnimation(value) {
					self.loadingAnimation = value;
				},
				statusContainer: this.statusContainer,
				session: this.session,
			},
			customInstructions,
		);
	}

	stop(): void {
		this.unregisterSignalHandlers();
		if (this.settingsManager.getShowTerminalProgress()) {
			this.ui.terminal.setProgress(false);
		}
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.extensionUiHost.clearExtensionTerminalInputListeners();
		this.footer.dispose();
		this.footerDataProvider.dispose();
		if (this.unsubscribe) {
			this.unsubscribe();
		}
		if (this.unsubscribeExtensionsChanged) {
			this.unsubscribeExtensionsChanged();
		}
		if (this.isInitialized) {
			this.ui.stop();
			this.isInitialized = false;
		}
	}
}
