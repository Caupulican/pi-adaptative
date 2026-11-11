/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AssistantMessage, ImageContent, Message, Model } from "@caupulican/pi-ai";
import type { AutocompleteProvider, EditorComponent, MarkdownTheme, SelectItem, Terminal } from "@caupulican/pi-tui";
import {
	applyTerminalSettings,
	type Component,
	Container,
	InputOnlyTerminal,
	type Loader,
	type LoaderIndicatorOptions,
	ProcessTerminal,
	Spacer,
	setKeybindings,
	Text,
	TUI,
} from "@caupulican/pi-tui";
import { APP_NAME, APP_TITLE, VERSION } from "../../config.ts";
import { type AgentSession, type AgentSessionEvent, parseSkillBlock } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import {
	type CacheMissObservation,
	detectCacheMissNotice,
	observeCacheStateFromMessages,
} from "../../core/cache-miss-notice.ts";
import type { CiStatusSource } from "../../core/ci-status-view.ts";
import { expandArgumentsForDisplay, expandMessageForDisplay } from "../../core/context/path-alias-display.ts";
import type { AutocompleteProviderFactory, ExtensionCommandContext } from "../../core/extensions/index.ts";
import { FooterDataProvider } from "../../core/footer-data-provider.ts";
import { configureHttpDispatcher } from "../../core/http-dispatcher.ts";
import { subscribeHumanInputActivity } from "../../core/human-input-activity.ts";
import { type AppKeybinding, KeybindingsManager } from "../../core/keybindings.ts";
import { interfaceText, onInterfaceLanguageChange } from "../../core/language/interface-text.ts";
import {
	OWNER_EVIDENCE_CUSTOM_TYPE,
	type OwnerTextRange,
	ownerPasteRestorer,
	sliceOwnerRanges,
	trimOwnerWords,
} from "../../core/learning/owner-evidence-ledger.ts";
import type { ForegroundRouteSnapshot } from "../../core/model-router-controller.ts";
import type { FitnessRole } from "../../core/models/fitness-role.ts";
import type { PrismLlamaCppRuntime } from "../../core/models/llamacpp-runtime.ts";
import type { OllamaRuntime, TransformersRuntime } from "../../core/models/local-runtime.ts";
import { planStepByAttempt } from "../../core/plan/plan-panel.ts";
import { namedPlanViews } from "../../core/plan/plan-views-named.ts";
import { REPLY_ROUTE_CUSTOM_TYPE, type ReplyRouteRecord } from "../../core/reply-route.ts";
import { boundedRedactedDiagnosticText } from "../../core/security/secret-text.ts";
import { formatMissingSessionCwdPrompt, type MissingSessionCwdError } from "../../core/session-cwd.ts";
import { SessionImageStore } from "../../core/session-image-store.ts";
import { getSessionRole } from "../../core/session-role.ts";
import type {
	AutoLearnSettings,
	AutonomyMode,
	SelfModificationSettings,
	SettingsScope,
} from "../../core/settings/settings-schema.ts";
import { collectSelfModificationSourceCandidates } from "../../core/system-prompt-builder.ts";
import { describeCause, type TerminalWarnings } from "../../core/terminal-warnings.ts";
import { isRecordObject } from "../../core/util/value-guards.ts";
import type { SessionContext, SessionManager, TruncationResult } from "../../kernel/node.ts";
import { ownerInputIdOf } from "../../kernel/owner-input-stamp.ts";
import { turnOriginStampOf } from "../../kernel/turn-origin-stamp.ts";
import type { AgentMessage, ToolCallRepairInfo } from "../../kernel/types.ts";
import * as clipboardInput from "../../presentation/clipboard-input.ts";
import { formatKeyText, keyDisplayText, keyText } from "../../presentation/keybinding-hints.ts";
import { isModelFacingText } from "../../presentation/plain-text.ts";
import {
	initTheme,
	onThemeChange,
	setRegisteredThemes,
	setTheme,
	stopThemeWatcher,
} from "../../presentation/theme/theme.ts";
import { getEditorTheme, getMarkdownTheme, theme } from "../../presentation/theme-model.ts";
import { resolvePath } from "../../utils/paths.ts";
import { ensureTool } from "../../utils/tools-manager.ts";
import { checkForNewPiVersion, type LatestPiRelease } from "../../utils/version-check.ts";
import { AuthDialogsController } from "./auth-dialogs-controller.ts";
import { AutoLearnController, type AutoLearnState } from "./auto-learn-controller.ts";
import * as autocompleteProvider from "./autocomplete-provider.ts";
import * as autonomyCommands from "./autonomy-commands.ts";
import { BotTeamChatController } from "./bot-team-chat-controller.ts";
import type * as compactionQueue from "./compaction-queue.ts";
import { ActionTranscriptComponent } from "./components/action-transcript.ts";
import { ActiveToolCallRegistry } from "./components/active-tool-call-registry.ts";
import { ActivityLaneComponent, type ActivityLaneKind } from "./components/activity-lane.ts";
import { AgentsOverlay } from "./components/agents-overlay.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { BashExecutionComponent } from "./components/bash-execution.ts";
import { BotTeamSelectorComponent } from "./components/bot-team-selector.ts";
import { BranchSummaryMessageComponent } from "./components/branch-summary-message.ts";
import { ChannelMessageComponent } from "./components/channel-message.ts";
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.ts";
import { CustomEditor } from "./components/custom-editor.ts";
import { CustomMessageComponent } from "./components/custom-message.ts";
import { ExpandableText, isExpandable } from "./components/expandable-text.ts";
import { FooterComponent, type FooterServices } from "./components/footer.ts";
import type { MarkdownTransformFn } from "./components/markdown-transform.ts";
import { ReplyBylineTracker, replyByline, replyModelRef } from "./components/reply-byline.ts";
import { SkillInvocationMessageComponent } from "./components/skill-invocation-message.ts";
import {
	compactStartupHints,
	expandedStartupHints,
	startupHelpLine,
	startupOnboarding,
} from "./components/startup-header.ts";
import { ToolExecutionComponent } from "./components/tool-execution.ts";
import { openTranscriptOverlay } from "./components/transcript-overlay.ts";
import { UserMessageComponent } from "./components/user-message.ts";
import { countConversationEntries } from "./conversation-entries.ts";
import { EditorOverlayHost } from "./editor-overlay-host.ts";
import { composeEditorPlaceholder } from "./editor-placeholder.ts";
import { type EditorSubmitHost, EditorSubmitRouter } from "./editor-submit-router.ts";
import { ExtensionUiHost } from "./extension-ui-host.ts";
import { openEditorForPath, openExternalEditor } from "./external-editor.ts";
import * as historyReloadMath from "./history-reload-math.ts";
import { InteractiveEventController } from "./interactive-event-controller.ts";
import { InteractiveLayout } from "./interactive-layout.ts";
import * as keyHandlers from "./key-handlers.ts";
import { type LoadedResourcesViewOptions, renderLoadedResources } from "./loaded-resources-view.ts";
import * as localModelCommands from "./local-model-commands.ts";
import { type MisalignmentBlock, offerMisalignmentContinuation } from "./misalignment-continuation.ts";
import * as modelRouterSetupCommands from "./model-router-setup-commands.ts";
import { bindPersistenceFenceIndicator } from "./persistence-fence-indicator.ts";
import { ProfileMenuController } from "./profile-menu-controller.ts";
import { QueuedMessageController, type UserInputSubmission } from "./queued-message-controller.ts";
import { promptHarnessReadiness } from "./readiness-prompt.ts";
import * as reportCommands from "./report-commands.ts";
import { RuntimeStatusController } from "./runtime-status-controller.ts";
import { describeSelfModificationSourceProblem } from "./self-modification-source.ts";
import * as sessionFlows from "./session-flow-commands.ts";
import { handleNonFatalSessionReplacementError } from "./session-replacement-errors.ts";
import * as settingsSelectorFlow from "./settings-selector-flow.ts";
import * as signalLifecycle from "./signal-lifecycle.ts";
import { SlashCommandController } from "./slash-command-controller.ts";
import * as startupChecks from "./startup-checks.ts";
import { terminalCapabilityOverridesFromSettings } from "./terminal-capability-settings.ts";

const TUI_HISTORY_RELOAD_CHUNK_SIZE = 20;
const TUI_LIVE_HISTORY_MAX_COMPONENTS = 260;
const TUI_LIVE_HISTORY_TRIM_TO_COMPONENTS = 220;

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
	/** CI projection supplied by the session's host resource. */
	ciStatus?: CiStatusSource;
	/**
	 * Where the closing warnings go. Held while the TUI runs, so they never land on the screen; written to stderr once the terminal is
	 * restored (stop()).
	 */
	terminalWarnings?: TerminalWarnings;
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
	/** Whether a human owns this terminal. False for unattended worker panes. */
	hasHumanAudience?: boolean;
	/** The terminal the TUI drives. Defaults to the process terminal (input-only without a human audience). */
	terminal?: Terminal;
	/** The process effects of the signal lifecycle. Defaults to the process itself. */
	signalIo?: Partial<signalLifecycle.SignalLifecycleIo>;
}

export class InteractiveMode {
	private runtimeHost: AgentSessionRuntime;
	private ui: TUI;
	private chatContainer: Container;
	/** The transcript components each owner message added, keyed by its message object. */
	private readonly userEchoComponents = new WeakMap<AgentMessage, Component[]>();
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
	private readonly runtimeStatus: RuntimeStatusController;
	private onInputCallback?: (submission: UserInputSubmission) => void;
	private pendingUserInputs: UserInputSubmission[] = [];
	private readonly clipboardQueue: clipboardInput.ClipboardQueueState = {
		pendingClipboardImages: [],
		clipboardImageCounter: 0,
	};
	private clipboardImageStore: SessionImageStore | undefined;
	private lastSigintTime = 0;
	private lastEscapeTime = 0;
	private changelogMarkdown: string | undefined = undefined;
	private startupNoticesShown = false;
	private anthropicSubscriptionWarningShown = false;
	/** Evidence for the P1m cache-miss notice: the previous turn's actual usage, not a guess. */
	private lastCacheObservation: CacheMissObservation | undefined = undefined;

	// Status line tracking (for mutating immediately-sequential status updates)
	private lastStatusSpacer: Spacer | undefined = undefined;
	private lastStatusText: Text | undefined = undefined;

	// Live TUI history cap. Full session history remains in SessionManager/model state.
	private liveHistoryHiddenNotice: Text | undefined = undefined;
	private liveHistoryHiddenComponents = 0;
	private tuiHistoryLoaded = false;
	private tuiHistoryLoadInProgress = false;

	// Active execution identity. Completed actions are owned by the transcript.
	private activeToolCalls = new ActiveToolCallRegistry(() => this.layout.workbench?.refreshExecution());

	// Tool output expansion state
	private toolOutputExpanded = false;
	private transcriptActionsExpanded = false;

	// Thinking block visibility state
	private hideThinkingBlock = true;
	/** Which replies carry a byline; shared by the live event path and history reload. */
	replyBylines = new ReplyBylineTracker();
	/** Routes of routed replies, by reply timestamp, read from the session while history reloads. */
	private replyRoutes: Map<number, ForegroundRouteSnapshot> | undefined;

	// Skill commands: command name -> skill file path
	private skillCommands = new Map<string, string>();

	// Agent subscription unsubscribe function
	private unsubscribe?: () => void;
	private unsubscribeForegroundActivity?: () => void;
	private unsubscribePlanChanges?: () => void;
	private unsubscribeHumanInputActivity?: () => void;
	private unsubscribePersistenceFence?: () => void;
	private subscriptionGeneration = 0;
	private unsubscribeExtensionsChanged?: () => void;
	private unsubscribeLanguage?: () => void;
	/** Owns shutdown state and the process listeners it registered; see signal-lifecycle.ts. */
	private readonly signals: signalLifecycle.SignalLifecycle;
	/** Owns the mounted Workbench and its session listeners; see interactive-layout.ts. */
	private readonly layout: InteractiveLayout;
	/** Owns the streaming reply and the retry/compaction escape handlers; see interactive-event-controller.ts. */
	private readonly events: InteractiveEventController;
	/** Owns the /command handlers and their operator hosts; see slash-command-controller.ts. */
	private readonly slashCommands: SlashCommandController;
	/** Owns the queued owner input: steering, follow-up and after-compaction messages; see queued-message-controller.ts. */
	private readonly queuedMessages: QueuedMessageController;
	/** Routes each editor submission in its fixed order; see editor-submit-router.ts. */
	private readonly submitRouter: EditorSubmitRouter;
	/** Owns the live-chat target (Brain, Bot, Team) and the bot/team chat rendering; see bot-team-chat-controller.ts. */
	private readonly botTeamChat: BotTeamChatController;
	private readonly botPendingToolCalls = new Map<string, ToolExecutionComponent>();

	// Track if editor is in bash mode (text starts with !)
	private isBashMode = false;

	// Track current bash execution component
	private bashComponent: BashExecutionComponent | undefined = undefined;

	// Track pending bash components (shown in pending area, moved to chat on submit)
	private pendingBashComponents: BashExecutionComponent[] = [];

	// Messages queued while compaction is running
	private compactionQueuedMessages: compactionQueue.CompactionQueuedMessage[] = [];

	// Shutdown state
	private shutdownRequested = false;

	// Extension widget containers (hold components rendered above/below the editor)
	private widgetContainerAbove!: Container;
	private widgetContainerBelow!: Container;
	private activityLane: ActivityLaneComponent | undefined;
	private readonly hasHumanAudience: boolean;

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
	// The runtime host builds the session and its services together and replaces them as a unit, so
	// these read the current ones per use; the session itself no longer exposes them.
	private get sessionManager() {
		return this.runtimeHost.sessionManager;
	}
	private get settingsManager() {
		return this.runtimeHost.services.settingsManager;
	}
	private get modelRegistry() {
		return this.runtimeHost.services.modelRegistry;
	}
	private get extensionRunner() {
		return this.runtimeHost.extensionRunner;
	}

	private get loadingAnimation(): Loader | undefined {
		return this.runtimeStatus.loadingAnimation;
	}

	private set loadingAnimation(value: Loader | undefined) {
		this.runtimeStatus.loadingAnimation = value;
	}

	get workingVisible(): boolean {
		return this.runtimeStatus.isWorkingVisible;
	}

	set workingVisible(value: boolean) {
		this.runtimeStatus.isWorkingVisible = value;
	}

	get workingIndicatorOptions(): LoaderIndicatorOptions | undefined {
		return this.runtimeStatus.indicatorOptions;
	}

	set workingIndicatorOptions(value: LoaderIndicatorOptions | undefined) {
		this.runtimeStatus.indicatorOptions = value;
	}

	constructor(runtimeHost: AgentSessionRuntime, options: InteractiveModeOptions = {}) {
		this.runtimeHost = runtimeHost;
		this.options = options;
		options.terminalWarnings?.hold();
		this.hasHumanAudience = (options.hasHumanAudience ?? true) && getSessionRole() === "main";
		this.runtimeHost.setBeforeSessionInvalidate(() => {
			this.extensionUiHost.resetExtensionUI();
		});
		this.runtimeHost.setRebindSession(async () => {
			await this.rebindCurrentSession();
		});
		this.version = VERSION;
		// Must run before anything (including TUI/ProcessTerminal construction) can call
		// getCapabilities() and cache a settings-less result (P1g).
		applyTerminalSettings(terminalCapabilityOverridesFromSettings(this.settingsManager));
		this.ui = new TUI(
			options.terminal ??
				(this.hasHumanAudience
					? new ProcessTerminal({
							workbench: true,
							mouse: this.settingsManager.getWorkbenchSettings().mouse === "on",
						})
					: new InputOnlyTerminal()),
			this.settingsManager.getShowHardwareCursor(),
		);
		this.signals = new signalLifecycle.SignalLifecycle(
			{
				runtimeHost: this.runtimeHost,
				ui: this.ui,
				isShutdownRequested: () => this.shutdownRequested,
				stop: () => this.stop(),
				formatResumeCommand: () => formatResumeCommand(this.sessionManager),
				showStatus: (message) => this.showStatus(message),
				showError: (message) => this.showError(message),
			},
			options.signalIo,
		);
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
		this.headerContainer = new Container();
		this.chatContainer = new Container();
		this.pendingMessagesContainer = new Container();
		this.statusContainer = new Container();
		this.widgetContainerAbove = new Container();
		this.widgetContainerBelow = new Container();
		this.activityLane = this.hasHumanAudience
			? new ActivityLaneComponent(theme, () => this.ui.requestRender())
			: undefined;
		this.runtimeStatus = new RuntimeStatusController({
			ui: this.ui,
			statusContainer: this.statusContainer,
			activityLane: this.activityLane,
			hasHumanAudience: this.hasHumanAudience,
			isStreaming: () => this.session.isStreaming,
			isThinkingHidden: () => this.hideThinkingBlock,
		});
		// The runtime's own agent directory (the process default in production): one source for every per-agent file.
		this.keybindings = KeybindingsManager.create(this.runtimeHost.services.agentDir);
		setKeybindings(this.keybindings);
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
			paddingX: editorPaddingX,
			autocompleteMaxVisible,
			placeholder: this.editorPlaceholder(),
		});
		this.editor = this.defaultEditor;
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor as Component);
		this.overlayHost = new EditorOverlayHost(this.editorContainer, this.ui);
		this.footerDataProvider = new FooterDataProvider(this.sessionManager.getCwd(), {
			watchGit: this.hasHumanAudience,
		});
		this.footer = new FooterComponent(this.session, this.footerServices(), this.footerDataProvider);
		this.autoLearnController = new AutoLearnController({
			isActive: () => this.isInitialized,
			getSession: () => this.runtimeHost.session,
			getSessionManager: () => this.sessionManager,
			getSettingsManager: () => this.settingsManager,
			getModelRegistry: () => this.modelRegistry,
			resolveSelfModificationSource: (settings) => this.resolveSelfModificationSource(settings),
			ui: {
				showStatus: (message) => this.showStatus(message),
				footerDataProvider: this.footerDataProvider,
				invalidateFooter: () => this.footer.invalidate(),
				requestRender: () => this.ui.requestRender(),
			},
		});
		const sharedControllerUi = {
			showSelector: (create: Parameters<typeof this.showSelector>[0]) => this.showSelector(create),
			showStatus: (message: string) => this.showStatus(message),
			showError: (message: string) => this.showError(message),
			requestRender: () => this.ui.requestRender(),
			tui: this.ui,
		};
		this.profileMenu = new ProfileMenuController({
			getSession: () => this.runtimeHost.session,
			getSessionManager: () => this.sessionManager,
			getSettingsManager: () => this.settingsManager,
			getModelRegistry: () => this.modelRegistry,
			ui: {
				...sharedControllerUi,
				showWarning: (message) => this.showWarning(message),
				footerDataProvider: this.footerDataProvider,
				invalidateFooter: () => this.footer.invalidate(),
				updateEditorBorderColor: () => this.updateEditorBorderColor(),
				openEditorForPath: (filePath) => this.openEditorForPath(filePath),
				handleReloadCommand: () => this.slashCommands.handleReloadCommandWithResult(),
				maybeWarnAboutAnthropicSubscriptionAuth: (model) =>
					void this.maybeWarnAboutAnthropicSubscriptionAuth(model),
				checkDaxnutsEasterEgg: (model) => this.checkDaxnutsEasterEgg(model),
				showSettingsSelector: () => this.showSettingsSelector(),
				getAutoLearnModelOptions: () => this.getAutoLearnModelOptions(),
			},
		});
		this.authDialogs = new AuthDialogsController({
			getSession: () => this.runtimeHost.session,
			getSettingsManager: () => this.settingsManager,
			getModelRegistry: () => this.modelRegistry,
			ui: {
				...sharedControllerUi,
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
			getSessionManager: () => this.sessionManager,
			getSettingsManager: () => this.settingsManager,
			getModelRegistry: () => this.modelRegistry,
			ui: {
				tui: this.ui,
				overlayHost: this.overlayHost,
				keybindings: this.keybindings,
				footer: this.footer,
				footerDataProvider: this.footerDataProvider,
				headerContainer: this.headerContainer,
				chatContainer: this.chatContainer,
				defaultEditor: this.defaultEditor,
				widgetContainerAbove: this.widgetContainerAbove,
				widgetContainerBelow: this.widgetContainerBelow,
				getEditor: () => this.editor,
				getWorkbenchView: () => this.layout.workbench?.view,
				setEditor: (editor) => {
					const previousEditor = this.editor;
					this.editor = editor;
					if (previousEditor !== editor && previousEditor !== this.defaultEditor) {
						const disposableEditor = previousEditor as typeof previousEditor & { dispose?: () => void };
						disposableEditor.dispose?.();
					}
				},
				getBuiltInHeader: () => this.builtInHeader,
				getAutocompleteProvider: () => this.autocompleteProvider,
				getClipboardImageStore: () => this.clipboardImageStore,
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
					this.queuedMessages.restoreQueuedMessagesToEditor({ abort: true });
				},
				reload: () => this.slashCommands.handleReloadCommand(),
				showStatus: (message) => this.showStatus(message),
				showWarning: (message) => this.showWarning(message),
				showError: (message) => this.showError(message),
			},
		});
		this.botTeamChat = new BotTeamChatController({
			chatContainer: this.chatContainer,
			ui: this.ui,
			getSessionPort: () => this.session,
			renderRootConversation: async () => {
				await this.renderCurrentSessionState();
			},
			appendRenderedMessageToChat: (message) => {
				this.renderBotOrTeamMessage(message);
			},
			showStatus: (message) => this.showStatus(message),
			showWarning: (message) => this.showWarning(message),
			showError: (message) => this.showError(message),
			promptForEdit: (title, prefill) =>
				this.extensionUiHost.showExtensionEditor(title, prefill, { exactText: true }),
			openSelectorModal: () => this.showBotTeamSelector(),
			onActiveTargetChanged: () => {
				this.defaultEditor.setPlaceholder(this.editorPlaceholder());
				this.updateEditorBorderColor();
				this.ui.requestRender();
			},
		});
		this.events = new InteractiveEventController({
			hasHumanAudience: this.hasHumanAudience,
			ui: this.ui,
			footer: this.footer,
			footerDataProvider: this.footerDataProvider,
			defaultEditor: this.defaultEditor,
			statusContainer: this.statusContainer,
			chatContainer: this.chatContainer,
			activityLane: this.activityLane,
			runtimeStatus: this.runtimeStatus,
			replyBylines: this.replyBylines,
			findModelName: (modelRef) => this.findModelName(modelRef),
			activeToolCalls: this.activeToolCalls,
			transformMarkdownForDisplay: this.transformMarkdownForDisplay,
			getSession: () => this.session,
			getSessionManager: () => this.sessionManager,
			getSettings: () => this.settingsManager,
			getWorkbench: () => this.layout.workbench,
			isInitialized: () => this.isInitialized,
			isThinkingHidden: () => this.hideThinkingBlock,
			init: () => this.init(),
			isRootChatActive: () => this.botTeamChat.isRootChatActive(),
			clearActiveToolCalls: () => this.clearActiveToolCalls(),
			updatePendingMessagesDisplay: () => this.queuedMessages.updatePendingMessagesDisplay(),
			updateTerminalTitle: () => this.updateTerminalTitle(),
			refreshActivityLane: () => this.refreshActivityLane(),
			updateEditorBorderColor: () => this.updateEditorBorderColor(),
			showError: (message) => this.showError(message),
			addMessageToChat: (message) => this.addMessageToChat(message),
			removeUserMessageFromChat: (message) => this.removeUserMessageFromChat(message),
			getMarkdownThemeWithSettings: () => this.getMarkdownThemeWithSettings(),
			trimLiveTuiHistory: () => this.trimLiveTuiHistory(),
			attachToolExecutionComponent: (toolName, toolCallId, args, repair) =>
				this.attachToolExecutionComponent(toolName, toolCallId, args, repair),
			toolActivityKind: (toolName) => this.toolActivityKind(toolName),
			toolActivityLabel: (toolName) => this.toolActivityLabel(toolName),
			toolActivityTerminalStatus: (isError, details) => this.toolActivityTerminalStatus(isError, details),
			isNativeReflectionEnabled: () => this.isNativeReflectionEnabled(),
			maybeRunNativeReflection: (messages) => this.maybeRunNativeReflection(messages),
			maybeStartAutoLearn: () => this.maybeStartAutoLearn(),
			maybeStartAutonomyReview: (messages) => this.maybeStartAutonomyReview(messages),
			offerMisalignmentContinuation: (block) => this.offerMisalignmentContinuation(block),
			checkShutdownRequested: () => this.checkShutdownRequested(),
			rebuildChatFromMessages: (options) => this.rebuildChatFromMessages(options),
			flushCompactionQueue: (options) => this.queuedMessages.flushCompactionQueue(options),
		});
		this.layout = new InteractiveLayout({
			hasHumanAudience: this.hasHumanAudience,
			ciStatus: options.ciStatus,
			ui: this.ui,
			headerContainer: this.headerContainer,
			chatContainer: this.chatContainer,
			editorContainer: this.editorContainer,
			pendingMessagesContainer: this.pendingMessagesContainer,
			statusContainer: this.statusContainer,
			widgetContainerAbove: this.widgetContainerAbove,
			widgetContainerBelow: this.widgetContainerBelow,
			footer: this.footer,
			footerDataProvider: this.footerDataProvider,
			activityLane: this.activityLane,
			keybindings: this.keybindings,
			extensionUiHost: this.extensionUiHost,
			activeToolCalls: this.activeToolCalls,
			getSession: () => this.session,
			findModelName: (modelRef) => this.findModelName(modelRef),
			getSessionManager: () => this.sessionManager,
			getEditor: () => this.editor,
			getSettings: () => this.settingsManager,
			getStreamingMessage: () => this.events.getStreamingMessage(),
			getConversationTitle: () => this.botTeamChat.getConversationTitleLabel(),
			getSwitchChatChip: () => this.botTeamChat.getSwitchChipLabel(),
			getChatRoster: () => {
				const activeTarget = this.botTeamChat.getActiveTarget();
				return {
					activeTarget,
					rootModelLabel: this.session.getRootModelLabel(),
					rootRunning: this.session.isStreaming,
					bots: this.chatBots(),
					lanes: this.session.listManagedLanes(),
					teams: this.session.listPersistentTeams(),
				};
			},
			getPersistentBots: () => this.chatBots(),
			onSelectChatTarget: (target) => {
				void this.botTeamChat.switchTarget(target);
			},
			onSwitchChat: () => this.showBotTeamSelector(),
		});
		// The edge asks here, once, with one key: an ungranted operation waits for the answer in the
		// workbench instead of failing the model's call. Escape declines.
		this.session.setEdgeConfirmation(async (request, signal) => {
			const words = interfaceText().interactive;
			const choices = [words.allowOnce, words.allowForSession, words.deny];
			const choice = await this.extensionUiHost.showExtensionSelector(
				words.edgeTitle(request.class, request.operation, request.reason),
				choices,
				signal ? { signal } : undefined,
			);
			this.refreshActivityLane();
			if (choice === choices[0]) return "allow-once";
			if (choice === choices[1]) return "allow-session";
			return "deny";
		});
		this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);

		// Load hide thinking block setting
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();

		// Register themes from resource loader and initialize
		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		initTheme(this.settingsManager.getTheme(), true);
		const commandHost = this.commandHost();
		this.slashCommands = new SlashCommandController(commandHost);
		this.queuedMessages = new QueuedMessageController(commandHost);
		this.submitRouter = new EditorSubmitRouter(commandHost, this.slashCommands, this.queuedMessages);
	}

	// Thin delegate: the base-provider seam that setupAutocompleteProvider calls, kept as a method so it can be replaced.
	private createBaseAutocompleteProvider(): AutocompleteProvider {
		return autocompleteProvider.createBaseAutocompleteProvider({
			session: this.session,
			settingsManager: this.settingsManager,
			sessionManager: this.sessionManager,
			modelRegistry: this.modelRegistry,
			extensionRunner: this.extensionRunner,
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

	/**
	 * Mounts the layout, wires input, and starts the UI. It runs before extensions initialize so
	 * session_start handlers can use interactive dialogs.
	 */
	private startInteractiveSurface(): void {
		this.layout.mount();
		this.ui.setFocus(this.editor);
		this.setupKeyHandlers();
		this.setupEditorSubmitHandler();
		this.ui.start();
		this.isInitialized = true;
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		this.registerSignalHandlers();
		if (!this.hasHumanAudience) {
			this.builtInHeader = new Text("", 0, 0);
			this.startInteractiveSurface();
			await this.rebindCurrentSession();
			return;
		}

		// Load changelog (only show new entries, skip for resumed sessions)
		this.changelogMarkdown = this.getChangelogForDisplay();

		// Ensure shared discovery/projection binaries and the owner credential provider are available.
		// fd feeds autocomplete; rg and jq keep source/JSON filtering outside V8; bw stays dormant until /secrets.
		const [fdPath] = await Promise.all([
			ensureTool("fd"),
			ensureTool("rg"),
			ensureTool("jq"),
			ensureTool("jscpd"),
			ensureTool("bw"),
		]);
		this.fdPath = fdPath;

		if (this.session.scopedModels.length > 0 && (this.options.verbose || !this.settingsManager.getQuietStartup())) {
			const modelList = this.session.scopedModels
				.map((sm) => {
					const thinkingStr = sm.thinkingLevel
						? `:${interfaceText().interactive.thinkingLevelName(sm.thinkingLevel)}`
						: "";
					return `${sm.model.id}${thinkingStr}`;
				})
				.join(", ");
			const cycleKeys = this.keybindings.getKeys("app.model.cycleForward");
			const cycleHint =
				cycleKeys.length > 0
					? theme.fg(
							"muted",
							interfaceText().interactive.startup.cycleHint(
								formatKeyText(cycleKeys.join("/"), { capitalize: true }),
							),
						)
					: "";
			console.log(theme.fg("dim", interfaceText().interactive.startup.modelScope(modelList, cycleHint)));
		}

		// Add header container as first child

		// Add header with keybindings from config (unless silenced)
		if (this.options.verbose || !this.settingsManager.getQuietStartup()) {
			const logo = theme.bold(theme.fg("accent", APP_NAME)) + theme.fg("dim", ` v${this.version}`);

			this.builtInHeader = new ExpandableText(
				() => `${logo}\n${compactStartupHints()}\n${startupHelpLine()}\n\n${startupOnboarding()}`,
				() => `${logo}\n${expandedStartupHints()}\n\n${startupOnboarding()}`,
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

		this.startInteractiveSurface();

		// Initialize extensions first so resources are shown before messages
		await this.rebindCurrentSession();

		// Register extensions-changed listener for live reload UI refresh
		this.subscribeToExtensionsChanged();

		// Render initial messages AFTER showing loaded resources
		await this.renderInitialMessages();
		this.renderProjectTrustWarningIfNeeded();

		// Set up theme file watcher
		onThemeChange(() => {
			this.ui.invalidate();
			this.updateEditorBorderColor();
			this.refreshActivityLane();
			this.ui.requestRender();
		});

		// The interface language changes while the interface runs: redraw every row in the new words.
		this.unsubscribeLanguage = onInterfaceLanguageChange(() => {
			this.defaultEditor.setPlaceholder(this.editorPlaceholder());
			this.setupAutocompleteProvider();
			this.ui.invalidate();
			this.refreshActivityLane();
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
		const notices = interfaceText().notices;
		await this.init();
		if (this.hasHumanAudience) this.startAudienceChecks();

		const { initialMessage, initialImages, initialMessages } = this.options;
		if (initialMessage) {
			try {
				await this.session.prompt(initialMessage, { images: initialImages });
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : notices.unknownErrorOccurred;
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
					const errorMessage = error instanceof Error ? error.message : notices.unknownErrorOccurred;
					this.showError(errorMessage);
				} finally {
					this.refreshAutonomyFooterStatus();
				}
			}
		}

		while (true) {
			const userInput = await this.getUserInput();
			try {
				await this.session.prompt(userInput.text, { images: userInput.images, pasted: userInput.pasted });
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : notices.unknownErrorOccurred;
				this.showError(errorMessage);
			} finally {
				this.reportCacheMissNoticeIfEvidenced();
				this.refreshAutonomyFooterStatus();
			}
		}
	}

	/** The harness-ready check, off the start-up path: it prompts only when the owner has something to fix. */
	private checkHarnessReadiness(): void {
		setTimeout(() => {
			void promptHarnessReadiness({
				probe: () => this.session.backgroundLanes.probeWorkerReadiness(),
				availableModels: () => this.modelRegistry.getAvailable(),
				currentModel: () => this.session.model ?? undefined,
				subscriptionProviders: () =>
					this.modelRegistry.authStorage
						.list()
						.filter((provider) => this.modelRegistry.authStorage.get(provider)?.type === "oauth"),
				currentWorkerDelegation: () => this.settingsManager.getGlobalSettings().workerDelegation ?? {},
				saveWorkerDelegation: (settings) => this.settingsManager.setWorkerDelegationSettings(settings),
				select: (title, options) => this.extensionUiHost.showExtensionSelector(title, options),
				showStatus: (text) => this.showStatus(text),
			});
		}, 2000).unref();
	}

	private startAudienceChecks(): void {
		this.checkHarnessReadiness();
		// Start version check asynchronously
		checkForNewPiVersion(this.version).then((newRelease) => {
			if (newRelease) {
				this.showNewVersionNotification(newRelease);
			}
		});

		// Start package update check asynchronously
		this.checkForPackageUpdates()
			.then((updates) => {
				if (updates.length > 0) {
					this.showPackageUpdateNotification(updates);
				}
			})
			.finally(() => {
				// npm can overwrite the shared Windows console title while checking extension versions.
				if (process.platform === "win32" && this.isInitialized) {
					this.updateTerminalTitle();
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
					this.showStatus(interfaceText().notices.curatorArchived(archived.length, archived.join(", ")));
				}
			})
			.catch(() => {
				// curation is best-effort; never disrupt startup
			});

		const { migratedProviders, modelFallbackMessage } = this.options;

		if (migratedProviders && migratedProviders.length > 0) {
			this.showWarning(interfaceText().notices.migratedCredentials(migratedProviders.join(", ")));
		}

		const modelsJsonError = this.modelRegistry.getError();
		if (modelsJsonError) {
			this.showError(interfaceText().notices.modelsJsonError(modelsJsonError));
		}

		if (modelFallbackMessage) {
			this.showWarning(modelFallbackMessage);
		}

		void this.maybeWarnAboutAnthropicSubscriptionAuth();
	}

	private refreshAutonomyFooterStatus(): void {
		if (!this.hasHumanAudience) return;
		this.footerDataProvider.setAutonomyStatusSnapshot(this.session.getAutonomyStatusSnapshot());
		this.footer.invalidate();
	}

	/**
	 * P1m: after a turn completes, compare its actual usage against the previous turn's for
	 * EVIDENCE of a cache miss (never guesses ahead of the request). Reuses the per-message usage
	 * already recorded on assistant messages -- no new metering.
	 */
	private reportCacheMissNoticeIfEvidenced(): void {
		if (!this.hasHumanAudience) return;
		const current = observeCacheStateFromMessages(this.session.messages);
		if (!current) return;
		if (this.settingsManager.getShowCacheMissNotices()) {
			const notice = detectCacheMissNotice(current, this.lastCacheObservation);
			if (notice) this.showWarning(notice.message);
		}
		this.lastCacheObservation = current;
	}

	private activityLaneSnapshot() {
		const verification = this.session.getVerificationObligations();
		const peerFindings = this.session.getSemanticVerificationObligations();
		const edge = this.session.getEdgeGrants();
		const ledger = this.session.backgroundLanes.getTaskRuntimeSnapshot();
		const plans = namedPlanViews(ledger, this.runtimeHost.services.agentDir);
		return {
			goalState: this.session.getGoalStateSnapshot(),
			taskState: this.session.getTaskStepsStateSnapshot(),
			...(ledger ? { plans, planStepByAttempt: planStepByAttempt(ledger, plans) } : {}),
			laneRecords: this.session.getLaneRecords(),
			...(verification.length ? { verification } : {}),
			...(peerFindings.length ? { peerFindings } : {}),
			...(edge.length ? { edge } : {}),
		};
	}

	private refreshActivityLane(options: { replace?: boolean } = {}): void {
		if (!this.activityLane) return;
		const sessionKey = this.sessionManager.getSessionId();
		const snapshot = this.activityLaneSnapshot();
		if (options.replace) {
			this.activityLane.replaceCanonical(sessionKey, snapshot);
			this.layout.workbench?.reset();
		} else {
			this.activityLane.updateCanonical(sessionKey, snapshot);
		}
		this.layout.workbench?.refresh({ ...snapshot, items: this.activityLane.getItems() });
	}

	public toolActivityKind(toolName: string): ActivityLaneKind {
		if (toolName === "task_steps") return "task";
		if (toolName === "goal") return "goal";
		if (toolName === "delegate") return "worker";
		return "tool";
	}

	public toolActivityLabel(toolName: string): string {
		const label = this.getRegisteredToolDefinition(toolName)?.label?.trim() || toolName;
		return label.replace(/[_-]+/g, " ").replace(/(^|\s)\S/g, (character) => character.toUpperCase());
	}

	public toolActivityTerminalStatus(isError: boolean, details: unknown): "success" | "failure" | "neutral" {
		if (isError) return "failure";
		if (!isRecordObject(details)) return "success";
		if (details.applied === false || details.kind === "error") return "failure";
		if (details.kind === "review" && details.reviewed === false) return "failure";
		if (details.started === false) return "neutral";
		return "success";
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

	/**
	 * Bound reference to the extension runner's markdown transformer chain (P2g), handed to
	 * message components so they can re-run it per render width. A bound arrow class field so it
	 * stays a stable, safely-passable callback (ExtensionRunner#transformMarkdown is a plain
	 * method, not auto-bound).
	 */
	private readonly transformMarkdownForDisplay: MarkdownTransformFn = (markdown, context) =>
		this.extensionRunner.transformMarkdown(markdown, context);

	// =========================================================================
	// Extension System
	// =========================================================================

	private getStartupExpansionState(): boolean {
		return this.options.verbose || this.toolOutputExpanded;
	}

	private showLoadedResources(options?: LoadedResourcesViewOptions): void {
		renderLoadedResources(
			{
				session: this.session,
				sessionManager: this.sessionManager,
				settingsManager: this.settingsManager,
				extensionRunner: this.extensionRunner,
				chatContainer: this.chatContainer,
				verbose: this.options.verbose ?? false,
				expanded: this.getStartupExpansionState(),
			},
			options,
		);
	}
	/**
	 * Initialize the extension system with TUI-based UI context.
	 */
	private async bindCurrentSessionExtensions(): Promise<void> {
		const uiContext = this.hasHumanAudience ? this.extensionUiHost.createExtensionUIContext() : undefined;
		await this.session.bindExtensions({
			uiContext,
			mode: this.hasHumanAudience ? "tui" : "print",
			abortHandler: () => {
				this.queuedMessages.restoreQueuedMessagesToEditor({ abort: true });
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
						const disposition = this.handleNonFatalSessionReplacementError(error);
						if (disposition) return { cancelled: disposition === "previous_restored" };
						return this.handleFatalRuntimeError(interfaceText().notices.failedToCreateSession, error);
					}
				},
				fork: async (entryId, options) => {
					try {
						const result = await this.runtimeHost.fork(entryId, options);
						if (!result.cancelled) {
							this.renderCurrentSessionState();
							this.editor.setText(result.selectedText ?? "", result.pasted);
							this.showStatus(interfaceText().interactive.forked);
						}
						return { cancelled: result.cancelled };
					} catch (error: unknown) {
						const disposition = this.handleNonFatalSessionReplacementError(error);
						if (disposition) return { cancelled: disposition === "previous_restored" };
						return this.handleFatalRuntimeError(interfaceText().notices.failedToForkSession, error);
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
						this.editor.setText(result.editorText, result.pasted);
					}
					this.showStatus(interfaceText().interactive.navigated);
					void this.queuedMessages.flushCompactionQueue({ willRetry: false });
					return { cancelled: false };
				},
				switchSession: async (sessionPath, options) => {
					return this.handleResumeSession(sessionPath, options);
				},
				reload: async () => {
					await this.slashCommands.handleReloadCommand();
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

		const extensionRunner = this.extensionRunner;
		this.extensionUiHost.setupExtensionShortcuts(extensionRunner);
		if (!this.hasHumanAudience) return;
		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		this.setupAutocompleteProvider();
		this.showLoadedResources({ force: false, showDiagnosticsWhenQuiet: true });
		this.showStartupNoticesIfNeeded();
	}

	private footerServices(): FooterServices {
		return {
			sessionManager: this.sessionManager,
			settingsManager: this.settingsManager,
			modelRegistry: this.modelRegistry,
		};
	}

	private applyRuntimeSettings(): void {
		configureHttpDispatcher(this.settingsManager.getHttpIdleTimeoutMs());
		this.footer.setSession(this.session, this.footerServices());
		this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);
		this.footerDataProvider.setCwd(this.sessionManager.getCwd());
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
		this.applyEditorPresentationSettings();
	}

	private applyEditorPresentationSettings(): void {
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor.setPaddingX(editorPaddingX);
		this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
		if (this.editor !== this.defaultEditor) {
			this.editor.setPaddingX?.(editorPaddingX);
			this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
		}
	}

	private refreshExtensionPresentation(): void {
		const activeHeader = this.extensionUiHost.getCustomHeader() ?? this.builtInHeader;
		if (isExpandable(activeHeader)) {
			activeHeader.setExpanded(this.toolOutputExpanded);
		}
		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		const themeName = this.settingsManager.getTheme();
		const themeResult = themeName ? setTheme(themeName, true) : { success: true };
		if (themeName && !themeResult.success) {
			this.showError(interfaceText().notices.themeLoadFailed(themeName, themeResult.error ?? ""));
		}
		this.applyEditorPresentationSettings();
	}

	private async rebindCurrentSession(): Promise<void> {
		this.subscriptionGeneration++;
		this.unsubscribeHumanInputActivity?.();
		this.unsubscribeHumanInputActivity = undefined;
		this.unsubscribePersistenceFence?.();
		this.unsubscribePersistenceFence = undefined;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.unsubscribeForegroundActivity?.();
		this.unsubscribeForegroundActivity = undefined;
		this.unsubscribePlanChanges?.();
		this.unsubscribePlanChanges = undefined;
		this.clipboardQueue.pendingClipboardImages = [];
		this.clipboardQueue.clipboardImageCounter = 0;
		const clipboardImageDirectory = this.settingsManager.getClipboardImageDirectory();
		this.clipboardImageStore =
			this.sessionManager.isPersisted() || clipboardImageDirectory
				? new SessionImageStore({
						agentDir: this.runtimeHost.services.agentDir,
						cwd: this.sessionManager.getCwd(),
						sessionId: this.sessionManager.getSessionId(),
						directory: clipboardImageDirectory,
					})
				: undefined;
		this.applyRuntimeSettings();
		await this.bindCurrentSessionExtensions();
		this.subscribeToAgent();
		this.botTeamChat.bindSession();
		if (this.hasHumanAudience) {
			// The Workbench's own listeners (projection, stage log, System One ledger, questions) follow the session too.
			this.layout.rebindSession();
			this.subscribeToExtensionsChanged();
			await this.updateAvailableProviderCount();
			this.updateEditorBorderColor();
			this.updateTerminalTitle();
			this.refreshActivityLane({ replace: true });
		}
		try {
			await this.session.resumePendingHumanInput();
		} catch (error: unknown) {
			this.showError(
				interfaceText().notices.pendingInputResumeFailed(error instanceof Error ? error.message : String(error)),
			);
		}
		// Input the previous run still held queued returns pending, visible and takeable into the editor.
		const restoredQueueNotice = this.session.takeRestoredQueuedInputNotice();
		if (restoredQueueNotice) {
			this.queuedMessages.updatePendingMessagesDisplay();
			this.showWarning(restoredQueueNotice);
		}
		// Learner proposals a previous session could not apply are offered once more, under the same gates.
		void this.autoLearnController.reofferUnappliedProposals().catch((error: unknown) => {
			this.showWarning(
				interfaceText().notices.autoLearnOfferFailed(error instanceof Error ? error.message : String(error)),
			);
		});
		this.session.resumeSelfCompaction();
	}

	private subscribeToExtensionsChanged(): void {
		this.unsubscribeExtensionsChanged?.();
		this.unsubscribeExtensionsChanged = this.session.onExtensionsChanged(() => {
			this.slashCommands.refreshUIAfterExtensionsChanged();
		});
	}

	private async handleFatalRuntimeError(prefix: string, error: unknown): Promise<never> {
		const text = `${prefix}: ${describeCause(error)}`;
		// The UI draws on the alternate screen, so a message shown in it is erased by the stop: the lifecycle records it, stops, then prints it.
		this.signals.fatalRuntimeError(text, error instanceof Error ? (error.stack ?? text) : text, stopThemeWatcher);
		// The lifecycle's exit ends the process. Only an injected exit returns, and the failure then stays with the caller.
		throw error;
	}

	private handleNonFatalSessionReplacementError(
		error: unknown,
	): "previous_restored" | "replacement_committed" | undefined {
		return handleNonFatalSessionReplacementError(
			{
				renderCurrentSessionState: () => this.renderCurrentSessionState(),
				showError: (message) => this.showError(message),
			},
			error,
		);
	}

	private renderCurrentSessionState(): void {
		this.pendingMessagesContainer.clear();
		this.compactionQueuedMessages = [];
		this.events.discardStreaming();
		this.clearActiveToolCallState();
		void this.renderInitialMessages();
	}

	/**
	 * Get a registered tool definition by name (for custom rendering).
	 */
	private getRegisteredToolDefinition(toolName: string) {
		return this.session.getToolDefinition(toolName);
	}

	private appendTranscriptAction(component: ToolExecutionComponent): void {
		const children = this.chatContainer.children;
		for (let index = children.length - 1; index >= 0; index--) {
			const candidate = children[index];
			if (candidate instanceof ActionTranscriptComponent) {
				if (candidate.canAccept()) {
					candidate.addAction(component);
					this.trimLiveTuiHistory();
					return;
				}
				break;
			}
			if (candidate instanceof AssistantMessageComponent && !candidate.hasVisibleOutput()) continue;
			break;
		}
		const transcript = new ActionTranscriptComponent([component]);
		transcript.setTranscriptExpanded(this.transcriptActionsExpanded);
		this.chatContainer.addChild(transcript);
		this.trimLiveTuiHistory();
	}

	private attachToolExecutionComponent(
		toolName: string,
		toolCallId: string,
		args: any,
		repair?: ToolCallRepairInfo,
		deferResultUntilExpanded = false,
	): ToolExecutionComponent {
		const toolDefinition = this.getRegisteredToolDefinition(toolName);
		const component = new ToolExecutionComponent(
			toolName,
			toolCallId,
			args,
			{
				showImages: this.settingsManager.getShowImages(),
				imageWidthCells: this.settingsManager.getImageWidthCells(),
				repair,
				deferResultUntilExpanded,
			},
			toolDefinition,
			this.ui,
			this.sessionManager.getCwd(),
		);
		this.appendTranscriptAction(component);
		this.activeToolCalls.register(toolCallId, component);
		return component;
	}

	public clearActiveToolCalls(): void {
		this.activeToolCalls.clearActive();
	}

	private clearActiveToolCallState(): void {
		this.activeToolCalls.clearActive();
	}

	private getWorkingLoaderMessage(): string {
		return this.runtimeStatus.getWorkingLoaderMessage();
	}

	private createWorkingLoader(): Loader {
		return this.runtimeStatus.createWorkingLoader();
	}

	private stopWorkingLoader(): void {
		this.runtimeStatus.stopWorkingLoader();
	}

	private setWorkingVisible(visible: boolean): void {
		this.runtimeStatus.setWorkingVisible(visible);
		this.syncForegroundActivity();
	}

	private setWorkingIndicator(options?: LoaderIndicatorOptions): void {
		this.runtimeStatus.setWorkingIndicator(options);
		this.syncForegroundActivity();
	}

	private setHiddenThinkingLabel(label?: string): void {
		this.runtimeStatus.setHiddenThinkingLabel(label);
		const streamingMessage = this.events.getStreamingMessage();
		if (streamingMessage) this.updateRuntimeStatus(streamingMessage);
	}

	public updateRuntimeStatus(message?: AssistantMessage): void {
		this.runtimeStatus.updateRuntimeStatus(message);
	}

	/**
	 * Set the extension-provided working-loader message (undefined restores the default).
	 */
	private setWorkingMessage(message: string | undefined): void {
		this.runtimeStatus.setWorkingMessage(message, this.events.getStreamingMessage());
	}

	/**
	 * Reset the working indicator and hidden-thinking label to their built-in defaults.
	 */
	private resetWorkingIndicators(): void {
		this.runtimeStatus.resetWorkingIndicators();
		const streamingMessage = this.events.getStreamingMessage();
		if (streamingMessage) this.updateRuntimeStatus(streamingMessage);
	}

	private async promptForMissingSessionCwd(error: MissingSessionCwdError): Promise<string | undefined> {
		const confirmed = await this.extensionUiHost.showExtensionConfirm(
			interfaceText().interactive.sessionCwdTitle,
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
			restoreQueuedMessagesToEditor: (options) => this.queuedMessages.restoreQueuedMessagesToEditor(options),
			updateEditorBorderColor: () => this.updateEditorBorderColor(),
			showTreeSelector: (id) => this.showTreeSelector(id),
			showUserMessageSelector: (name) => this.showUserMessageSelector(name),
			handleCtrlC: () => this.handleCtrlC(),
			handleCtrlD: () => this.handleCtrlD(),
			handleCtrlZ: () => this.handleCtrlZ(),
			cycleThinkingLevel: () => this.cycleThinkingLevel(),
			cycleModel: (direction) => this.cycleModel(direction),
			handleDebugCommand: () => this.slashCommands.handleDebugCommand(),
			showModelSelector: (input) => this.showModelSelector(input),
			loadTuiHistoryOnDemand: () => this.loadTuiHistoryOnDemand(),
			toggleToolOutputExpansion: () => this.toggleToolOutputExpansion(),
			showTranscriptPager: () => this.showTranscriptPager(),
			toggleAgentsOverlay: () => this.toggleAgentsOverlay(),
			showBotTeamSelector: () => this.showBotTeamSelector(),
			toggleThinkingBlockVisibility: () => this.toggleThinkingBlockVisibility(),
			openExternalEditor: () => this.openExternalEditor(),
			handleFollowUp: () => this.handleFollowUp(),
			handleDequeue: () => this.queuedMessages.handleDequeue(),
			handleClearCommand: (name) => this.slashCommands.handleClearCommand(name),
			showSessionSelector: () => this.showSessionSelector(),
			handleClipboardImagePaste: () => this.handleClipboardImagePaste(),
			handleCopyCommand: () => this.slashCommands.handleCopyCommand(),
		};
	}

	private handleClipboardImagePaste(): Promise<void> {
		const selectedModel = this.session?.model;
		const modelCannotSeeImages = selectedModel ? !selectedModel.input.includes("image") : false;
		return clipboardInput.handleClipboardImagePaste(
			clipboardInput.bindClipboardQueue(this.clipboardQueue, {
				editor: this.editor,
				ui: this.ui,
				autoResizeImages: this.settingsManager.getImageAutoResize(),
				blockImages: this.settingsManager.getBlockImages() || modelCannotSeeImages,
				blockImagesReason: modelCannotSeeImages ? interfaceText().interactive.imagesBlocked : undefined,
				imageStore: this.clipboardImageStore,
				showStatus: (message) => this.showStatus(message),
				showWarning: (message) => this.showWarning(message),
			}),
		);
	}

	private takeClipboardImagesForText(text: string): ImageContent[] | undefined {
		return clipboardInput.takeClipboardImagesForText(
			clipboardInput.bindClipboardQueue(this.clipboardQueue, {
				clipboardImageStore: this.clipboardImageStore,
			}),
			text,
		);
	}

	private buildUserInputSubmission(text: string): UserInputSubmission {
		return clipboardInput.buildUserInputSubmission(
			{ takeClipboardImagesForText: (t) => this.takeClipboardImagesForText(t) },
			text,
		);
	}

	/** The status, warning, error and selector surface shared by the command port and the model-router flow. */
	private presentationHost() {
		return {
			showStatus: (message: string) => this.showStatus(message),
			showWarning: (message: string) => this.showWarning(message),
			showError: (message: string) => this.showError(message),
			showSelector: (create: Parameters<typeof this.showSelector>[0]) => this.showSelector(create),
		};
	}

	/** The single port the command surface, the queue and the submit router read the mode through. */
	private commandHost(): EditorSubmitHost {
		const self = this;
		return {
			get session() {
				return self.session;
			},
			get sessionManager() {
				return self.sessionManager;
			},
			get settingsManager() {
				return self.settingsManager;
			},
			get modelRegistry() {
				return self.modelRegistry;
			},
			get extensionRunner() {
				return self.extensionRunner;
			},
			get editor() {
				return self.editor;
			},
			get chatContainer() {
				return self.chatContainer;
			},
			get activityLane() {
				return self.activityLane;
			},
			get clipboardImageStore() {
				return self.clipboardImageStore;
			},
			get isBashMode() {
				return self.isBashMode;
			},
			set isBashMode(value) {
				self.isBashMode = value;
			},
			get loadingAnimation() {
				return self.loadingAnimation;
			},
			set loadingAnimation(value) {
				self.loadingAnimation = value;
			},
			get bashComponent() {
				return self.bashComponent;
			},
			set bashComponent(value) {
				self.bashComponent = value;
			},
			get pendingBashComponents() {
				return self.pendingBashComponents;
			},
			set pendingBashComponents(value) {
				self.pendingBashComponents = value;
			},
			get compactionQueuedMessages() {
				return self.compactionQueuedMessages;
			},
			set compactionQueuedMessages(value) {
				self.compactionQueuedMessages = value;
			},
			runtimeHost: this.runtimeHost,
			ui: this.ui,
			statusContainer: this.statusContainer,
			pendingMessagesContainer: this.pendingMessagesContainer,
			editorContainer: this.editorContainer,
			footer: this.footer,
			overlayHost: this.overlayHost,
			keybindings: this.keybindings,
			extensionUiHost: this.extensionUiHost,
			profileMenu: this.profileMenu,
			authDialogs: this.authDialogs,
			botTeamChat: this.botTeamChat,
			layout: this.layout,
			hasHumanAudience: this.hasHumanAudience,
			clipboardQueue: this.clipboardQueue,
			...this.presentationHost(),
			refreshActivityLane: (options) => this.refreshActivityLane(options),
			refreshAutonomyFooterStatus: () => this.refreshAutonomyFooterStatus(),
			renderCurrentSessionState: () => this.renderCurrentSessionState(),
			handleNonFatalSessionReplacementError: (error) => this.handleNonFatalSessionReplacementError(error),
			handleFatalRuntimeError: (prefix, error) => this.handleFatalRuntimeError(prefix, error),
			promptForMissingSessionCwd: (error) => this.promptForMissingSessionCwd(error),
			rebuildChatFromMessages: (options) => this.rebuildChatFromMessages(options),
			refreshExtensionPresentation: () => this.refreshExtensionPresentation(),
			setupAutocompleteProvider: () => this.setupAutocompleteProvider(),
			showLoadedResources: (options) => this.showLoadedResources(options),
			sessionFlowHost: () => this.sessionFlowHost(),
			getCurrentAutoLearnSettings: () => this.getCurrentAutoLearnSettings(),
			getMarkdownThemeWithSettings: () => this.getMarkdownThemeWithSettings(),
			getAppKeyDisplay: (action) => this.getAppKeyDisplay(action),
			handleAutonomyCommand: (text) => this.handleAutonomyCommand(text),
			handleAutoLearnCommand: (text) => this.handleAutoLearnCommand(text),
			handleModelsCommand: (argsText) => this.handleModelsCommand(argsText),
			showFitnessModelSelector: () => this.showFitnessModelSelector(),
			showSettingsSelector: (initialItemId) => this.showSettingsSelector(initialItemId),
			showUserMessageSelector: (newSessionName) => this.showUserMessageSelector(newSessionName),
			showTreeSelector: (initialSelectedId) => this.showTreeSelector(initialSelectedId),
			showTrustSelector: () => this.showTrustSelector(),
			showSessionSelector: () => this.showSessionSelector(),
			shutdown: (options) => this.shutdown(options),
			takeClipboardImagesForText: (text) => this.takeClipboardImagesForText(text),
			updateEditorBorderColor: () => this.updateEditorBorderColor(),
			buildUserInputSubmission: (text) => this.buildUserInputSubmission(text),
			deliverUserInput: (submission) => this.deliverUserInput(submission),
		};
	}

	private setupEditorSubmitHandler(): void {
		this.defaultEditor.onShortcuts = () => this.slashCommands.handleHotkeysCommand();
		this.defaultEditor.onSubmit = (text: string, pasted?: readonly OwnerTextRange[]) =>
			this.submitRouter.route(text, pasted);
	}

	private subscribeToAgent(): void {
		const session = this.session;
		const generation = ++this.subscriptionGeneration;
		if (!this.hasHumanAudience) {
			this.unsubscribe = session.subscribe(async (event) => {
				if (generation !== this.subscriptionGeneration || session !== this.session) return;
				await this.handleUnattendedEvent(event);
			});
			return;
		}
		this.unsubscribe = session.subscribe(async (event) => {
			if (generation !== this.subscriptionGeneration || session !== this.session) return;
			await this.handleEvent(event);
		});
		this.unsubscribeForegroundActivity?.();
		this.unsubscribeForegroundActivity = session.subscribeForegroundActivity(() => {
			if (generation !== this.subscriptionGeneration || session !== this.session) return;
			this.syncForegroundActivity();
		});
		this.syncForegroundActivity();
		this.unsubscribePlanChanges?.();
		this.unsubscribePlanChanges = session.backgroundLanes.subscribePlanChanges(() => {
			if (generation !== this.subscriptionGeneration || session !== this.session) return;
			this.refreshActivityLane();
			this.ui.requestRender();
		});
		this.unsubscribePersistenceFence?.();
		this.unsubscribePersistenceFence = bindPersistenceFenceIndicator({
			sessionManager: this.sessionManager,
			footerData: this.footerDataProvider,
			showWarning: (message) => this.showWarning(message),
			refresh: () => {
				this.footer.invalidate();
				this.ui.requestRender();
			},
		});
		this.unsubscribeHumanInputActivity?.();
		this.unsubscribeHumanInputActivity = subscribeHumanInputActivity(this.sessionManager, (activity) => {
			if (generation !== this.subscriptionGeneration || session !== this.session) return;
			this.activityLane?.syncHumanInputActivity({
				requestId: activity.request.requestId,
				toolCallId: activity.request.toolCallId,
				waiting: activity.phase === "waiting",
			});
			this.loadingAnimation?.setMessage(
				activity.phase === "waiting" ? interfaceText().frame.activity.awaitingYou : this.getWorkingLoaderMessage(),
			);
			// The POV bar derives CONTROL from the durable human-input record on its next read; the
			// render is what makes an opening or closing question visible the moment it happens.
			this.ui.requestRender();
		});
	}

	private syncForegroundActivity(): void {
		const activity = this.session.getSessionWorkState();
		if (activity.busy && activity.epoch !== undefined) {
			this.layout.workbench?.beginCycle(this.sessionManager.getCwd(), activity.epoch);
		}
		this.activityLane?.setParentVisible(this.workingVisible && !this.workingIndicatorOptions);
		this.activityLane?.syncForegroundActivity({ ...activity, sessionId: activity.sessionId ?? "unknown" });
		if (activity.busy && this.workingVisible && this.workingIndicatorOptions && !this.loadingAnimation) {
			this.loadingAnimation = this.createWorkingLoader();
			this.statusContainer.addChild(this.loadingAnimation);
		} else if (!activity.busy && this.loadingAnimation) {
			this.stopWorkingLoader();
		}
	}

	private handleEvent(event: AgentSessionEvent): Promise<void> {
		return this.events.handle(event);
	}

	private async handleUnattendedEvent(event: AgentSessionEvent): Promise<void> {
		if (event.type === "agent_end") {
			this.maybeRunNativeReflection(event.messages);
			await this.checkShutdownRequested();
		} else if (event.type === "compaction_end") {
			await this.queuedMessages.flushCompactionQueue({ willRetry: event.willRetry });
		}
	}
	/** Extract text content from a user message */
	// Thin `this.`-delegate to the pure formatter in ./history-reload-math.ts; kept so
	// addMessageToChat and the prototype-based interactive-mode tests resolve it via `this`.
	private getUserMessageText(message: Message): string {
		return historyReloadMath.getUserMessageText(message);
	}

	/**
	 * Prompt history rebuilt from the persisted user messages of the branch, oldest first. Each entry keeps the ranges the
	 * owner pasted in it (`ownerPasteRestorer`, by the entry that holds it), so a recalled message is never resubmitted as typed.
	 */
	private setEditorInputHistory(
		history: readonly { readonly entryId: string | undefined; readonly text: string }[],
	): void {
		const restore = ownerPasteRestorer(this.sessionManager.getCustomEntriesOnBranch([OWNER_EVIDENCE_CUSTOM_TYPE]));
		const entries = history.map(({ entryId, text }) => ({ text, pasted: restore(entryId, text) }));
		if (this.editor.setHistory) {
			this.editor.setHistory(entries);
			return;
		}
		for (const entry of entries) {
			this.editor.addToHistory?.(entry.text, entry.pasted);
		}
	}

	private populateEditorInputHistoryFromMessages(messages: readonly AgentMessage[]): void {
		const history = messages
			.filter((message): message is Message => message.role === "user")
			.map((message) => ({
				entryId: this.sessionManager.getMessageEntryId(message),
				text: this.getUserMessageText(message).trim(),
			}))
			.filter((entry) => entry.text.length > 0)
			.slice(-100);
		this.setEditorInputHistory(history);
	}

	private populateEditorInputHistoryFromSession(): void {
		this.setEditorInputHistory(this.sessionManager.getRecentUserInputHistory(100));
	}

	private resetLiveTuiHistoryTrim(): void {
		this.liveHistoryHiddenNotice = undefined;
		this.liveHistoryHiddenComponents = 0;
	}

	/**
	 * Conversation turns on the session, not control records: what "History hidden" can stand for.
	 * The manager counts them itself; startup never walks the entries here (typing performance).
	 */
	private getSessionRecordCount(): number {
		const manager = this.sessionManager as typeof this.sessionManager & {
			getConversationEntryCount?: () => number;
			getEntryCount?: () => number;
		};
		return (
			manager.getConversationEntryCount?.() ??
			manager.getEntryCount?.() ??
			countConversationEntries(manager.getEntries())
		);
	}

	private showDeferredHistoryPlaceholder(options: { requestRender?: boolean } = {}): void {
		this.chatContainer.children = [];
		this.resetLiveTuiHistoryTrim();
		this.clearActiveToolCallState();

		const recordCount = this.getSessionRecordCount();
		if (recordCount > 0) {
			this.chatContainer.addChild(
				new Text(
					theme.fg("dim", interfaceText().interactive.historyHiddenForTyping(keyText("app.history.load"))),
					1,
					0,
				),
			);
		}

		if (options.requestRender ?? true) this.ui.requestRender();
	}

	private loadTuiHistoryOnDemand(): void {
		if (this.tuiHistoryLoadInProgress || this.tuiHistoryLoaded || this.getSessionRecordCount() === 0) return;

		this.tuiHistoryLoadInProgress = true;
		void (async () => {
			try {
				await this.renderInitialMessages({ forceHistoryLoad: true });
			} catch (error) {
				this.showError(
					interfaceText().notices.historyLoadFailed(error instanceof Error ? error.message : String(error)),
				);
			} finally {
				this.tuiHistoryLoadInProgress = false;
			}
		})();
	}

	private agentsOverlay: AgentsOverlay | undefined;
	private agentsOverlayHandle: ReturnType<TUI["showOverlay"]> | undefined;

	private handleAgentsOverlayRemoved(overlay: AgentsOverlay): void {
		overlay.dispose();
		if (this.agentsOverlay !== overlay) return;
		this.agentsOverlay = undefined;
		this.agentsOverlayHandle = undefined;
	}

	private closeAgentsOverlay(overlay = this.agentsOverlay): void {
		if (!overlay) {
			const handle = this.agentsOverlayHandle;
			this.agentsOverlayHandle = undefined;
			handle?.hide();
			return;
		}
		if (this.agentsOverlay !== overlay) {
			overlay.dispose();
			return;
		}
		const handle = this.agentsOverlayHandle;
		handle?.hide();
		if (this.agentsOverlay === overlay) this.handleAgentsOverlayRemoved(overlay);
	}

	private toggleAgentsOverlay(): void {
		if (!this.hasHumanAudience) return;
		if (this.agentsOverlayHandle) {
			this.closeAgentsOverlay();
			return;
		}
		const overlay = new AgentsOverlay({
			keybindings: this.keybindings,
			snapshot: () => ({
				...this.activityLaneSnapshot(),
				items: this.activityLane?.getItems() ?? [],
			}),
			requestRender: () => this.ui.requestRender(),
			onClose: () => this.closeAgentsOverlay(overlay),
			onSwitchChat: () => this.showBotTeamSelector(),
			viewportRows: () => this.ui.terminal.rows,
		});
		this.agentsOverlay = overlay;
		this.agentsOverlayHandle = this.ui.showOverlay(overlay, {
			width: "90%",
			maxHeight: "100%",
			onRemove: () => this.handleAgentsOverlayRemoved(overlay),
		});
		overlay.mount();
	}

	private showTranscriptPager(): void {
		openTranscriptOverlay({
			source: this.chatContainer,
			viewportRows: () => this.ui.terminal.rows,
			keybindings: this.keybindings,
			getToolsExpanded: () => this.toolOutputExpanded,
			setToolsExpanded: (expanded) => this.setToolsExpanded(expanded),
			getActionsExpanded: () => this.transcriptActionsExpanded,
			setActionsExpanded: (expanded) => this.setTranscriptActionsExpanded(expanded),
			showOverlay: (component, options) => this.ui.showOverlay(component, options),
		});
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

		protect(this.events.getStreamingComponent());
		protect(this.lastStatusSpacer);
		protect(this.lastStatusText);
		for (const [, action] of this.activeToolCalls.activeEntries()) {
			const transcript = children.find(
				(child): child is ActionTranscriptComponent =>
					child instanceof ActionTranscriptComponent && child.containsAction(action),
			);
			protect(transcript);
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
			interfaceText().interactive.olderHistoryHidden(this.liveHistoryHiddenComponents),
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
		if (!this.hasHumanAudience) return;
		this.appendStatusToChat(message);
	}

	/** Takes an owner echo back out of the transcript: its input was never delivered and is held in the pending queue. */
	private removeUserMessageFromChat(rawMessage: AgentMessage): void {
		const components = this.userEchoComponents.get(rawMessage) ?? [];
		this.userEchoComponents.delete(rawMessage);
		for (const component of components) this.chatContainer.removeChild(component);
	}

	private addMessageToChat(rawMessage: AgentMessage, options?: { populateHistory?: boolean }): void {
		// Aliases are a wire-format token optimization; the operator reads their own paths.
		const message = expandMessageForDisplay(this.session.peekPathAliasTable(), rawMessage);
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
					const renderer = this.extensionRunner.getMessageRenderer(message.customType);
					// 1 matches the paddingX every other top-level transcript component uses (assistant
					// text, bash output, ...), so a custom renderer that honors MessageRenderOptions.outputPad
					// aligns with its neighbors instead of silently seeing the unplumbed default of 0.
					const component = new CustomMessageComponent(message, renderer, this.getMarkdownThemeWithSettings(), 1);
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
				const echoStart = this.chatContainer.children.length;
				const textContent = this.getUserMessageText(message);
				const origin = turnOriginStampOf(rawMessage);
				if (
					textContent &&
					(origin?.shown !== undefined ||
						ownerInputIdOf(rawMessage) !== undefined ||
						!isModelFacingText(textContent))
				) {
					this.replyBylines.ownerMessage();
					if (this.chatContainer.children.length > 0) this.chatContainer.addChild(new Spacer(1));
					const mdTheme = this.getMarkdownThemeWithSettings();
					const skillBlock = origin?.shown === undefined ? parseSkillBlock(textContent) : undefined;
					if (origin?.shown !== undefined && origin.channel !== undefined) {
						// A third party's words read as who wrote them and what they said, not as the frame the model gets.
						this.chatContainer.addChild(new ChannelMessageComponent(origin.channel, origin.shown, mdTheme));
					} else if (skillBlock) {
						const component = new SkillInvocationMessageComponent(skillBlock, mdTheme);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);
						if (skillBlock.userMessage) {
							this.chatContainer.addChild(
								new UserMessageComponent(skillBlock.userMessage, mdTheme, this.transformMarkdownForDisplay),
							);
						}
					} else {
						this.chatContainer.addChild(
							new UserMessageComponent(textContent, mdTheme, this.transformMarkdownForDisplay),
						);
					}
					if (options?.populateHistory) this.editor.addToHistory?.(textContent);
				}
				// The components this message added, so a withdrawn echo can be taken back out (see removeUserMessageFromChat).
				this.userEchoComponents.set(rawMessage, this.chatContainer.children.slice(echoStart));
				break;
			}
			case "assistant": {
				const modelRef = replyModelRef(message);
				const byline = this.replyBylines.shouldShow(modelRef)
					? replyByline(modelRef, this.replyRoutes?.get(message.timestamp), this.findModelName(modelRef))
					: undefined;
				const assistantComponent = new AssistantMessageComponent(
					message,
					this.hideThinkingBlock,
					this.getMarkdownThemeWithSettings(),
					{
						isStreaming: false,
						showCommentary: this.hasHumanAudience,
						transformMarkdown: this.transformMarkdownForDisplay,
						...(byline ? { byline } : {}),
					},
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
		return historyReloadMath.messagesForTuiHistoryReload(messages, {
			includeToolResultContent: this.toolOutputExpanded,
		});
	}

	/**
	 * Render session context to chat. Used for initial load and rebuild after compaction.
	 * @param sessionContext Session context to render
	 * @param options.updateFooter Update footer state
	 * @param options.populateHistory Add user messages to editor history
	 */
	private renderGeneration = 0;
	private renderQueue?: Promise<void>;

	private async renderSessionContext(
		sessionContext: SessionContext,
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): Promise<void> {
		const run = async () => {
			// Build long history offscreen, then atomically swap it into the visible
			// chat container. This keeps the TUI responsive without flashing blank or
			// partial transcript frames during resume/reload/compaction rebuilds.
			this.renderGeneration = (this.renderGeneration ?? 0) + 1;
			const generation = this.renderGeneration;
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
			this.clearActiveToolCallState();
			const renderedPendingTools = new Map<string, ToolExecutionComponent>();

			try {
				if (options.updateFooter) {
					this.footer.invalidate();
					this.updateEditorBorderColor();
				}

				this.replyBylines.reset();
				this.replyRoutes = new Map();
				for (const entry of this.sessionManager.getEntries()) {
					if (entry.type !== "custom" || entry.customType !== REPLY_ROUTE_CUSTOM_TYPE) continue;
					const record = entry.data as ReplyRouteRecord | undefined;
					if (record && typeof record.timestamp === "number") this.replyRoutes.set(record.timestamp, record.route);
				}
				const tuiHistory = this.messagesForTuiHistoryReload(sessionContext.messages);
				if (tuiHistory.omittedMessages > 0) {
					this.appendStatusToChat(
						interfaceText().interactive.historyWindow(
							historyReloadMath.TUI_HISTORY_RELOAD_MAX_LINES,
							tuiHistory.omittedMessages,
						),
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
								const component = this.attachToolExecutionComponent(
									content.name,
									content.id,
									expandArgumentsForDisplay(this.session.peekPathAliasTable(), content.arguments),
									undefined,
									true,
								);

								if (message.stopReason === "aborted" || message.stopReason === "error") {
									let errorMessage: string;
									if (message.stopReason === "aborted") {
										const retryAttempt = this.session.retryAttempt;
										errorMessage =
											retryAttempt > 0
												? interfaceText().conversation.abortedAfterRetries(retryAttempt)
												: interfaceText().conversation.operationAborted;
									} else {
										errorMessage = message.errorMessage || interfaceText().notices.errorWord;
									}
									component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
									this.activeToolCalls.finish(content.id);
								} else {
									renderedPendingTools.set(content.id, component);
								}
							}
						}
					} else if (message.role === "toolResult") {
						// Match tool results to pending tool components
						const component = renderedPendingTools.get(message.toolCallId);
						if (component) {
							component.updateResult(expandMessageForDisplay(this.session.peekPathAliasTable(), message));
							renderedPendingTools.delete(message.toolCallId);
							this.activeToolCalls.finish(message.toolCallId);
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
		};

		this.renderQueue = (this.renderQueue ?? Promise.resolve()).then(run, run);
		return this.renderQueue;
	}

	async renderInitialMessages(options: { forceHistoryLoad?: boolean } = {}): Promise<void> {
		if (!options.forceHistoryLoad) {
			this.populateEditorInputHistoryFromSession();
			this.tuiHistoryLoaded = false;
			this.showDeferredHistoryPlaceholder({ requestRender: true });
			this.footer.invalidate();
			this.updateEditorBorderColor();
			return;
		}

		// Get aligned messages and entries from session context only when the user
		// explicitly requests TUI history. The model/session state is already loaded.
		const context = this.sessionManager.buildSessionContext();
		this.populateEditorInputHistoryFromMessages(context.messages);
		await this.renderSessionContext(context, {
			updateFooter: true,
		});
		this.tuiHistoryLoaded = true;

		// Show compaction info if session was compacted
		const allEntries = this.sessionManager.getEntries();
		const compactionCount = allEntries.filter((e) => e.type === "compaction").length;
		if (compactionCount > 0) {
			this.showStatus(interfaceText().interactive.sessionCompacted(compactionCount));
		}
	}

	/** Hands a submitted input to the turn waiting for one; otherwise it waits in the queue for the next request. */
	private deliverUserInput(submission: UserInputSubmission): void {
		if (this.onInputCallback) {
			this.onInputCallback(submission);
		} else {
			this.pendingUserInputs.push(submission);
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

	private renderBotOrTeamMessage(message: AgentMessage): void {
		if (this.chatContainer.children.length <= 3) {
			this.botPendingToolCalls.clear();
		}
		if (message.role === "assistant") {
			this.addMessageToChat(message);
			for (const content of message.content) {
				if (content.type !== "toolCall") continue;
				const toolDefinition = this.getRegisteredToolDefinition(content.name);
				const component = new ToolExecutionComponent(
					content.name,
					content.id,
					expandArgumentsForDisplay(this.session.peekPathAliasTable(), content.arguments),
					{
						showImages: this.settingsManager.getShowImages(),
						imageWidthCells: this.settingsManager.getImageWidthCells(),
						deferResultUntilExpanded: true,
					},
					toolDefinition,
					this.ui,
					this.sessionManager.getCwd(),
				);
				this.appendTranscriptAction(component);
				if (message.stopReason === "aborted" || message.stopReason === "error") {
					const errorText =
						message.stopReason === "aborted"
							? interfaceText().conversation.operationAborted
							: (boundedRedactedDiagnosticText(message.errorMessage ?? "") ?? interfaceText().notices.errorWord);
					component.updateResult({ content: [{ type: "text", text: errorText }], isError: true });
				} else {
					this.botPendingToolCalls.set(content.id, component);
				}
			}
			return;
		}
		if (message.role === "toolResult") {
			const component = this.botPendingToolCalls.get(message.toolCallId);
			if (component) {
				component.updateResult(expandMessageForDisplay(this.session.peekPathAliasTable(), message));
				this.botPendingToolCalls.delete(message.toolCallId);
			}
			return;
		}
		this.addMessageToChat(message);
	}

	private async rebuildChatFromMessages(options?: { checkpointWhenDeferred?: boolean }): Promise<boolean> {
		if (this.botTeamChat && !this.botTeamChat.isRootChatActive()) {
			await this.botTeamChat.refreshActiveChatView();
			return true;
		}
		if (!this.tuiHistoryLoaded && !options?.checkpointWhenDeferred) {
			this.showDeferredHistoryPlaceholder({ requestRender: true });
			return false;
		}
		const context = this.sessionManager.buildSessionContext();
		await this.renderSessionContext(context);
		// The provider context is what a history load renders. After compaction that context is the
		// checkpoint, not the pre-compaction entry tree. Marking it loaded keeps a later rebuild from
		// replacing the checkpoint with the hidden-history placeholder.
		if (options?.checkpointWhenDeferred) this.tuiHistoryLoaded = true;
		return true;
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
	private shutdown(options?: { fromSignal?: boolean }): Promise<void> {
		return this.signals.shutdown(options);
	}

	private emergencyTerminalExit(): void {
		this.signals.emergencyTerminalExit();
	}

	private uncaughtCrash(error: unknown): void {
		this.signals.uncaughtCrash(error);
	}

	private checkShutdownRequested(): Promise<void> {
		return this.signals.checkShutdownRequested();
	}

	private registerSignalHandlers(): void {
		this.signals.registerSignalHandlers();
	}

	private unregisterSignalHandlers(): void {
		this.signals.unregisterSignalHandlers();
	}

	private handleCtrlZ(): void {
		signalLifecycle.handleCtrlZ({ ui: this.ui, showStatus: (message) => this.showStatus(message) });
	}

	private async handleFollowUp(): Promise<void> {
		const { text, pasted } = trimOwnerWords({
			text: this.editor.getExpandedText?.() ?? this.editor.getText(),
			pasted: this.editor.getPastedRanges?.(),
		});
		if (!text) return;

		// Queue input during compaction (extension commands execute immediately)
		if (this.session.isCompacting) {
			if (this.queuedMessages.isExtensionCommand(text)) {
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				try {
					await this.session.prompt(text);
				} finally {
					this.refreshAutonomyFooterStatus();
				}
			} else {
				const images = this.takeClipboardImagesForText(text);
				this.queuedMessages.queueCompactionMessage(text, "followUp", images, pasted);
			}
			return;
		}

		// Alt+Enter queues a follow-up message (waits until agent finishes)
		// This handles extension commands (execute immediately), prompt template expansion, and queueing
		if (this.session.isStreaming) {
			const images = this.takeClipboardImagesForText(text);
			this.editor.addToHistory?.(text, pasted);
			this.editor.setText("");
			try {
				await this.session.prompt(text, { streamingBehavior: "followUp", images, pasted });
			} finally {
				this.refreshAutonomyFooterStatus();
			}
			this.queuedMessages.updatePendingMessagesDisplay();
			this.ui.requestRender();
		}
		// If not streaming, Alt+Enter acts like regular Enter (trigger onSubmit). While the session is
		// busy without a live stream (an answer under evaluation, a retry backoff, an armed
		// continuation) Enter would queue the text as steering; the follow-up intent is kept through the
		// editor's own chord-free ">>" form. Commands are never prefixed: they run as commands.
		else if (this.editor.onSubmit) {
			const isCommandText = text.startsWith("/") || text.startsWith("!");
			const keepFollowUp = this.session.getSessionWorkState().busy && !isCommandText;
			this.editor.setText("");
			await this.editor.onSubmit(
				keepFollowUp ? `>>${text}` : text,
				keepFollowUp ? sliceOwnerRanges(pasted, -2, text.length) : pasted,
			);
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
		const words = interfaceText().interactive;
		if (newLevel === undefined) {
			this.showStatus(words.thinkingUnsupported);
		} else {
			this.footer.invalidate();
			this.updateEditorBorderColor();
			this.showStatus(words.thinkingLevel(words.thinkingLevelName(newLevel)));
		}
	}

	private async cycleModel(direction: "forward" | "backward"): Promise<void> {
		try {
			const result = await this.session.cycleModel(direction);
			if (result === undefined) {
				const words = interfaceText().interactive;
				this.showStatus(
					this.session.scopedModels.length > 0 ? words.onlyOneModelInScope : words.onlyOneModelAvailable,
				);
			} else {
				this.footer.invalidate();
				this.updateEditorBorderColor();
				const words = interfaceText().interactive;
				const level =
					result.model.reasoning && result.thinkingLevel !== "off"
						? words.thinkingLevelName(result.thinkingLevel)
						: undefined;
				this.showStatus(words.switchedTo(result.model.name || result.model.id, level));
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

	private setTranscriptActionsExpanded(expanded: boolean): void {
		this.transcriptActionsExpanded = expanded;
		for (const child of this.chatContainer.children) {
			if (child instanceof ActionTranscriptComponent) child.setTranscriptExpanded(expanded);
		}
		this.ui.requestRender();
	}

	private async toggleThinkingBlockVisibility(): Promise<void> {
		this.hideThinkingBlock = !this.hideThinkingBlock;
		this.settingsManager.setHideThinkingBlock(this.hideThinkingBlock);
		this.updateThinkingBlockVisibility();
		this.showStatus(interfaceText().interactive.thinkingBlocks(this.hideThinkingBlock));
	}

	private updateThinkingBlockVisibility(): void {
		for (const child of this.chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				child.setHideThinkingBlock(this.hideThinkingBlock);
			}
		}
		const streamingComponent = this.events.getStreamingComponent();
		if (streamingComponent && !this.chatContainer.children.includes(streamingComponent)) {
			streamingComponent.setHideThinkingBlock(this.hideThinkingBlock);
		}
		this.ui.requestRender();
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
		this.chatContainer.addChild(new Text(theme.fg("error", interfaceText().notices.error(errorMessage)), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.ui.requestRender();
	}

	showWarning(warningMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("warning", interfaceText().notices.warning(warningMessage)), 1, 0));
		this.ui.requestRender();
	}

	showNewVersionNotification(release: LatestPiRelease): void {
		startupChecks.showNewVersionNotification(this.startupChecksHost(), release);
	}

	showPackageUpdateNotification(packages: string[]): void {
		startupChecks.showPackageUpdateNotification(this.startupChecksHost(), packages);
	}

	// =========================================================================
	// Selectors
	// =========================================================================

	/** The bots a chat list shows: a retired bot or worker is history, not a chat to resume; the open chat stays listed. */
	private chatBots() {
		const activeTarget = this.botTeamChat.getActiveTarget();
		return this.session
			.listPersistentBots()
			.filter(
				(bot) => bot.state !== "retired" || (activeTarget.kind === "bot" && activeTarget.agentId === bot.agentId),
			);
	}

	private showBotTeamSelector(): void {
		this.showSelector((done) => {
			const selector = new BotTeamSelectorComponent({
				activeTarget: this.botTeamChat.getActiveTarget(),
				rootModelLabel: this.session.getRootModelLabel(),
				rootStatusLabel: this.session.getRootStatusLabel(),
				bots: this.chatBots(),
				teams: this.session.listPersistentTeams(),
				onSelectTarget: (target) => {
					done();
					void this.botTeamChat.switchTarget(target);
				},
				onCancel: () => {
					done();
					this.ui.requestRender();
				},
			});
			return { component: selector, focus: selector.getSelectList() };
		});
	}

	/**
	 * Shows a selector component in place of the editor.
	 * @param create Factory that receives a `done` callback and returns the component and focus target
	 */
	private showSelector(
		create: (done: () => void) => {
			component: Component;
			focus: Component;
			onSuperseded?: () => void;
		},
	): void {
		this.overlayHost.showSelector(() => this.editor, create);
	}

	/** Narrow seam shared by the session-picker/tree/fork and model-selector flows. */
	private sessionFlowHost(): sessionFlows.SessionFlowHost {
		const self = this;
		return {
			session: this.session,
			sessionManager: this.sessionManager,
			settingsManager: this.settingsManager,
			modelRegistry: this.modelRegistry,
			extensionRunner: this.extensionRunner,
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
			refreshAutonomyFooterStatus: () => this.refreshAutonomyFooterStatus(),
			renderCurrentSessionState: () => this.renderCurrentSessionState(),
			renderInitialMessages: (options) => this.renderInitialMessages(options),
			flushCompactionQueue: (options) => this.queuedMessages.flushCompactionQueue(options),
			handleFatalRuntimeError: (prefix, error) => this.handleFatalRuntimeError(prefix, error),
			promptForMissingSessionCwd: (error) => this.promptForMissingSessionCwd(error),
			updateEditorBorderColor: () => this.updateEditorBorderColor(),
			updateAvailableProviderCount: () => this.updateAvailableProviderCount(),
			maybeWarnAboutAnthropicSubscriptionAuth: (model) => this.maybeWarnAboutAnthropicSubscriptionAuth(model),
			checkDaxnutsEasterEgg: (model) => this.checkDaxnutsEasterEgg(model),
			getModelCandidates: () => this.getModelCandidates(),
			shutdown: (options) => this.shutdown(options),
			reload: () => this.slashCommands.handleReloadCommandWithResult(),
		};
	}

	/** The display name of a `provider/model` ref, as the status line shows it. */
	private findModelName(modelRef: string): string | undefined {
		const slash = modelRef.indexOf("/");
		if (slash <= 0) return undefined;
		const model = this.modelRegistry.find(modelRef.slice(0, slash), modelRef.slice(slash + 1));
		return model ? model.name || model.id : undefined;
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

	private validateAutoLearnModelValue(...args: Parameters<AutoLearnController["validateAutoLearnModelValue"]>) {
		return this.autoLearnController.validateAutoLearnModelValue(...args);
	}

	private getCurrentCwdForSettings(): string {
		return this.runtimeHost?.sessionManager?.getCwd?.() || process.cwd();
	}

	private resolveSelfModificationSource(settings: {
		sourcePath?: string;
		sourcePaths?: string[];
	}): string | undefined {
		const cwd = this.getCurrentCwdForSettings();
		const resolved = collectSelfModificationSourceCandidates(settings).map((candidate) =>
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
		return describeSelfModificationSourceProblem(settings, this.getCurrentCwdForSettings());
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

	/** Event-host hook: the owner may continue past a Codex misalignment block (interactive-event-controller). */
	offerMisalignmentContinuation(block: MisalignmentBlock): void {
		offerMisalignmentContinuation(
			{ showSelector: (create) => this.showSelector(create), submit: (text) => this.session.prompt(text) },
			block,
		);
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

	private getTransformersRuntime(modelId: string, baseUrl?: string): TransformersRuntime {
		return this.session.getTransformersRuntime(modelId, baseUrl);
	}

	private getPrismLlamaCppRuntime(): PrismLlamaCppRuntime {
		return this.session.getPrismLlamaCppRuntime();
	}

	/** Narrow seam shared by the /models and /fitness flows. */
	private localModelHost(): localModelCommands.LocalModelHost {
		return {
			localRuntime: this.localRuntime,
			session: this.session,
			modelRegistry: this.modelRegistry,
			settingsManager: this.settingsManager,
			ui: this.ui,
			chatContainer: this.chatContainer,
			getTransformersRuntime: (modelId, baseUrl) => this.getTransformersRuntime(modelId, baseUrl),
			getPrismLlamaCppRuntime: () => this.getPrismLlamaCppRuntime(),
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
			modelRegistry: this.modelRegistry,
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
			rebuildChatFromMessages: async () => {
				await this.rebuildChatFromMessages();
			},
			updateThinkingBlockVisibility: () => this.updateThinkingBlockVisibility(),
			validateSelfModificationSource: (settings) => this.validateSelfModificationSource(settings),
			applyAutonomyMode: (mode, scope) => this.applyAutonomyMode(mode, scope),
			validateAutoLearnModelValue: (...args) => this.validateAutoLearnModelValue(...args),
			updateAutoLearnFooter: () => this.updateAutoLearnFooter(),
			handleResourcesHubAction: (action) => this.handleResourcesHubAction(action),
			handleModelRouterAction: (action) => this.handleModelRouterAction(action),
		};
	}

	private handleModelRouterAction(action: string): Promise<void> {
		// A superseded Models editor means another overlay owns the screen; Router Setup must not
		// displace it, so the reopen is skipped in that case only.
		let modelsEditorSuperseded = false;
		return modelRouterSetupCommands.handleModelRouterAction(
			{
				session: this.session,
				modelRegistry: this.modelRegistry,
				settingsManager: this.settingsManager,
				...this.presentationHost(),
				showModelsSelector: async () => {
					modelsEditorSuperseded = (await this.slashCommands.showModelsSelector()) === "superseded";
				},
				reopenModelRouterSetup: () => {
					if (!modelsEditorSuperseded) this.showSettingsSelector("model-router");
				},
				runFitnessAndAssign: (modelRef) => this.runFitnessAndAssign(modelRef),
			},
			action,
		);
	}

	private showSettingsSelector(initialItemId?: string): void {
		settingsSelectorFlow.showSettingsSelector(this.settingsSelectorHost(), initialItemId);
	}

	private handleResourcesHubAction(action: string): Promise<void> {
		return this.profileMenu.handleResourcesHubAction(action);
	}

	private async getModelCandidates(): Promise<Model<any>[]> {
		if (this.session.scopedModels.length > 0) {
			return this.session.scopedModels.map((scoped) => scoped.model);
		}

		this.modelRegistry.refresh();
		try {
			return await this.modelRegistry.getAvailable();
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
		if (model?.provider !== "anthropic") {
			return;
		}

		const storedCredential = this.modelRegistry.authStorage.get("anthropic");
		if (storedCredential?.type === "oauth") {
			this.anthropicSubscriptionWarningShown = true;
			this.showWarning(interfaceText().notices.anthropicSubscriptionAuth);
			return;
		}

		try {
			const apiKey = await this.modelRegistry.getApiKeyForProvider(model.provider);
			if (!isAnthropicSubscriptionAuthKey(apiKey)) {
				return;
			}
			this.anthropicSubscriptionWarningShown = true;
			this.showWarning(interfaceText().notices.anthropicSubscriptionAuth);
		} catch {
			// Ignore auth lookup failures for warning-only checks.
		}
	}

	private async showModelSelector(initialSearchInput?: string): Promise<void> {
		await sessionFlows.showModelSelector(this.sessionFlowHost(), initialSearchInput);
	}

	private showUserMessageSelector(newSessionName?: string): void {
		sessionFlows.showUserMessageSelector(this.sessionFlowHost(), newSessionName);
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

	/**
	 * Get capitalized display string for an app keybinding action.
	 */
	private getAppKeyDisplay(action: AppKeybinding): string {
		return keyDisplayText(action);
	}

	/** The input's own hints: what to type and the few keys that matter every turn; `?` lists the rest. */
	private editorPlaceholder(): string {
		const chat = this.botTeamChat;
		return composeEditorPlaceholder(chat && !chat.isRootChatActive() ? chat.getActiveTargetBadge() : undefined);
	}

	private checkDaxnutsEasterEgg(model: { provider: string; id: string }): void {
		reportCommands.checkDaxnutsEasterEgg({ chatContainer: this.chatContainer, ui: this.ui }, model);
	}

	stop(): void {
		const wasInitialized = this.isInitialized;
		this.isInitialized = false;
		// Each teardown step runs whatever the earlier ones did, and every failure is kept: a failing widget, overlay or footer must not skip
		// the subscriptions and the terminal restore (`ui.stop`) and the release of the warnings held for the TUI must not be skipped either.
		const failures: unknown[] = [];
		const attempt = (step: () => void): void => {
			try {
				step();
			} catch (error: unknown) {
				failures.push(error);
			}
		};
		this.subscriptionGeneration++;
		attempt(() => this.unsubscribeHumanInputActivity?.());
		this.unsubscribeHumanInputActivity = undefined;
		attempt(() => this.unsubscribePersistenceFence?.());
		this.unsubscribePersistenceFence = undefined;
		attempt(() => this.layout.dispose());
		attempt(() => this.botTeamChat.dispose());
		attempt(() => {
			// A quit keeps the process guards armed through its dispose: they go with the process (see SignalLifecycle.shutdown).
			if (!this.signals.isShuttingDown) this.unregisterSignalHandlers();
		});
		attempt(() => this.closeAgentsOverlay());
		attempt(() => {
			if (this.settingsManager.getShowTerminalProgress()) this.ui.terminal.setProgress(false);
		});
		const loadingAnimation = this.loadingAnimation;
		this.loadingAnimation = undefined;
		attempt(() => loadingAnimation?.stop());
		attempt(() => this.authDialogs.cancelActiveDialog());
		attempt(() => this.extensionUiHost.clearHostWidgets());
		attempt(() => this.extensionUiHost.resetExtensionUI());
		attempt(() => this.overlayHost.unmount());
		attempt(() => this.activityLane?.dispose());
		attempt(() => this.footer.dispose());
		attempt(() => this.footerDataProvider.dispose());
		attempt(() => this.unsubscribeForegroundActivity?.());
		this.unsubscribeForegroundActivity = undefined;
		attempt(() => this.unsubscribePlanChanges?.());
		this.unsubscribePlanChanges = undefined;
		attempt(() => this.unsubscribe?.());
		attempt(() => this.unsubscribeExtensionsChanged?.());
		attempt(() => this.unsubscribeLanguage?.());
		try {
			if (wasInitialized) {
				this.ui.stop();
			}
		} catch (error: unknown) {
			failures.push(error);
		}
		// The terminal is restored (or its restore failed and nothing more can be done for it): the held warnings are written now.
		try {
			this.options.terminalWarnings?.release();
		} catch (error: unknown) {
			failures.push(error);
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) {
			throw new AggregateError(
				failures,
				failures[0] instanceof Error ? failures[0].message : "The interactive stop failed.",
			);
		}
	}
}
