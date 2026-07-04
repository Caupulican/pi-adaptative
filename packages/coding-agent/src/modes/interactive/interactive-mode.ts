/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core";
import { createCompactionSummaryMessage } from "@caupulican/pi-agent-core";
import {
	isAutoLearnSessionId,
	type SessionContext,
	type SessionManager,
	type TruncationResult,
} from "@caupulican/pi-agent-core/node";
import {
	type AssistantMessage,
	getProviders,
	type ImageContent,
	type Message,
	type Model,
	type OAuthProviderId,
	type OAuthSelectPrompt,
} from "@caupulican/pi-ai";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	EditorComponent,
	Keybinding,
	KeyId,
	MarkdownTheme,
	OverlayHandle,
	OverlayOptions,
	SelectItem,
	SlashCommand,
} from "@caupulican/pi-tui";
import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	fuzzyFilter,
	getCapabilities,
	hyperlink,
	Loader,
	type LoaderIndicatorOptions,
	Markdown,
	matchesKey,
	ProcessTerminal,
	Spacer,
	setKeybindings,
	Text,
	TruncatedText,
	TUI,
	visibleWidth,
} from "@caupulican/pi-tui";
import chalk from "chalk";
import { spawn, spawnSync } from "child_process";
import lockfile from "proper-lockfile";
import {
	APP_NAME,
	APP_TITLE,
	getAgentDir,
	getAuthPath,
	getDebugLogPath,
	getDocsPath,
	getShareViewerUrl,
	VERSION,
} from "../../config.ts";
import { type AgentSession, type AgentSessionEvent, parseSkillBlock } from "../../core/agent-session.ts";
import { type AgentSessionRuntime, SessionImportFileNotFoundError } from "../../core/agent-session-runtime.ts";
import { formatAutonomyDiagnostics } from "../../core/autonomy/status.ts";
import { readAutoLearnSessionIdFromFile, reportCompletedAutoLearnUsageHelper } from "../../core/cost/session-usage.ts";
import type {
	AutocompleteProviderFactory,
	EditorFactory,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionRunner,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
} from "../../core/extensions/index.ts";
import { FooterDataProvider, type ReadonlyFooterDataProvider } from "../../core/footer-data-provider.ts";
import {
	DEFAULT_GOAL_CONTINUE_MAX_STALL_TURNS,
	DEFAULT_GOAL_CONTINUE_MAX_TURNS,
	DEFAULT_GOAL_CONTINUE_MAX_WALL_CLOCK_MINUTES,
	MAX_GOAL_CONTINUE_MAX_STALL_TURNS,
	MAX_GOAL_CONTINUE_MAX_TURNS,
	MAX_GOAL_CONTINUE_MAX_WALL_CLOCK_MINUTES,
} from "../../core/goals/goal-continuation-defaults.ts";
import { configureHttpDispatcher, formatHttpIdleTimeoutMs } from "../../core/http-dispatcher.ts";
import { type AppKeybinding, KeybindingsManager } from "../../core/keybindings.ts";
import {
	cliProviderAliases,
	defaultModelPerProvider,
	findExactModelReferenceMatch,
	resolveCliModel,
	resolveModelScope,
} from "../../core/model-resolver.ts";
import { DEFAULT_MODEL_SUGGESTIONS } from "../../core/models/default-model-suggestions.ts";
import { FitnessStore } from "../../core/models/fitness-store.ts";
import { registerLocalModel, unregisterLocalModel } from "../../core/models/local-registration.ts";
import type { OllamaRuntime } from "../../core/models/local-runtime.ts";
import { matchesInstalledLocalModel, normalizeModelSource } from "../../core/models/model-ref.ts";
import { DefaultPackageManager } from "../../core/package-manager.ts";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "../../core/provider-display-names.ts";
import { getPendingReloadBlockers } from "../../core/reload-blockers.ts";
import { formatModelFitnessReport, isProbeAllFailed } from "../../core/research/model-fitness.ts";
import type { ResourceDiagnostic } from "../../core/resource-loader.ts";
import { resourceProfileSettingsChangedKinds } from "../../core/resource-profile-equality.ts";
import { formatMissingSessionCwdPrompt, MissingSessionCwdError } from "../../core/session-cwd.ts";
import { listAllSessions, listSessions, openSession } from "../../core/session-manager-factory.ts";
import type {
	AutoLearnSettings,
	AutonomyMode,
	SelfModificationSettings,
	SettingsScope,
} from "../../core/settings-manager.ts";
import { validateSkillName } from "../../core/skills.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.ts";
import type { SourceInfo } from "../../core/source-info.ts";
import { isInstallTelemetryEnabled } from "../../core/telemetry.ts";
import { allToolNames } from "../../core/tools/index.ts";
import { hasProjectTrustInputs, ProjectTrustStore } from "../../core/trust-manager.ts";
import { getChangelogPath, getNewEntries, parseChangelog } from "../../utils/changelog.ts";
import { copyToClipboard } from "../../utils/clipboard.ts";
import { readClipboardImage } from "../../utils/clipboard-image.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { parseGitUrl } from "../../utils/git.ts";
import { getCwdRelativePath, resolvePath } from "../../utils/paths.ts";
import { getPiUserAgent } from "../../utils/pi-user-agent.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { ensureTool } from "../../utils/tools-manager.ts";
import { checkForNewPiVersion, type LatestPiRelease } from "../../utils/version-check.ts";
import { ArminComponent } from "./components/armin.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { BashExecutionComponent } from "./components/bash-execution.ts";
import { BorderedLoader } from "./components/bordered-loader.ts";
import { BranchSummaryMessageComponent } from "./components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.ts";
import { CountdownTimer } from "./components/countdown-timer.ts";
import { CustomEditor } from "./components/custom-editor.ts";
import { CustomMessageComponent } from "./components/custom-message.ts";
import { DaxnutsComponent } from "./components/daxnuts.ts";
import { DynamicBorder } from "./components/dynamic-border.ts";
import { EarendilAnnouncementComponent } from "./components/earendil-announcement.ts";
import { ExtensionEditorComponent } from "./components/extension-editor.ts";
import { ExtensionInputComponent } from "./components/extension-input.ts";
import { ExtensionSelectorComponent } from "./components/extension-selector.ts";
import { type FitnessRole, FitnessRoleSelectorComponent } from "./components/fitness-role-selector.ts";
import { FooterComponent } from "./components/footer.ts";
import { formatKeyText, keyDisplayText, keyHint, keyText, rawKeyHint } from "./components/keybinding-hints.ts";
import { LoginDialogComponent } from "./components/login-dialog.ts";
import { ModelSelectorComponent } from "./components/model-selector.ts";
import { ModelSuggestionSelectorComponent } from "./components/model-suggestion-selector.ts";
import { type AuthSelectorProvider, OAuthSelectorComponent } from "./components/oauth-selector.ts";
import {
	ProfileResourceEditorComponent,
	type ProfileResourceEditorKind,
	resolveResourceEditPath,
} from "./components/profile-resource-editor.ts";
import { ProfileSelectorComponent } from "./components/profile-selector.ts";
import { ScopedModelsSelectorComponent } from "./components/scoped-models-selector.ts";
import { SessionSelectorComponent } from "./components/session-selector.ts";
import { SelectSubmenu, SettingsSelectorComponent } from "./components/settings-selector.ts";
import { SkillInvocationMessageComponent } from "./components/skill-invocation-message.ts";
import { ToolExecutionComponent } from "./components/tool-execution.ts";
import { ToolGroupComponent } from "./components/tool-group.ts";
import {
	getToolPanelActionKey,
	getToolPanelResultActionKeys,
	shouldReuseToolPanelInPlace,
	ToolPanelRegistry,
} from "./components/tool-panel-registry.ts";
import { TreeSelectorComponent } from "./components/tree-selector.ts";
import { TrustSelectorComponent } from "./components/trust-selector.ts";
import { UserMessageComponent } from "./components/user-message.ts";
import { UserMessageSelectorComponent } from "./components/user-message-selector.ts";
import {
	getAvailableThemes,
	getAvailableThemesWithPaths,
	getEditorTheme,
	getMarkdownTheme,
	getThemeByName,
	initTheme,
	onThemeChange,
	setRegisteredThemes,
	setTheme,
	setThemeInstance,
	stopThemeWatcher,
	Theme,
	type ThemeColor,
	theme,
} from "./theme/theme.ts";

const TUI_HISTORY_RELOAD_MAX_LINES = 1000;
const TUI_HISTORY_RELOAD_WRAP_WIDTH = 100;
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

const DEAD_TERMINAL_ERROR_CODES = new Set(["EIO", "EPIPE", "ENOTCONN"]);

function isDeadTerminalError(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) {
		return false;
	}
	const code = (error as NodeJS.ErrnoException).code;
	return code !== undefined && DEAD_TERMINAL_ERROR_CODES.has(code);
}

const ANTHROPIC_SUBSCRIPTION_AUTH_WARNING =
	"Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage.";

const AUTO_LEARN_DEFAULTS = {
	enabled: false,
	model: "active",
	thinkingLevel: "low",
	longSessionMessages: 32,
	longSessionContextPercent: 70,
	cooldownMinutes: 24 * 60,
	leaseMinutes: 90,
	maxConcurrentLearners: 1,
	applyHighConfidence: false,
	reflectionReview: true,
	reflectionMinToolCalls: 12,
	reflectionCooldownMinutes: 24 * 60,
	complexTaskToolCalls: 12,
} as const satisfies Required<AutoLearnSettings>;

const AUTONOMY_AUTO_LEARN_PRESETS = {
	off: { ...AUTO_LEARN_DEFAULTS, enabled: false, reflectionReview: false },
	safe: {
		...AUTO_LEARN_DEFAULTS,
		enabled: false,
		longSessionMessages: 64,
		longSessionContextPercent: 85,
		cooldownMinutes: 24 * 60,
		leaseMinutes: 60,
		maxConcurrentLearners: 1,
		applyHighConfidence: false,
		reflectionReview: false,
		reflectionMinToolCalls: 12,
		reflectionCooldownMinutes: 24 * 60,
		complexTaskToolCalls: 12,
	},
	balanced: {
		...AUTO_LEARN_DEFAULTS,
		enabled: false,
		longSessionMessages: 64,
		longSessionContextPercent: 85,
		cooldownMinutes: 24 * 60,
		leaseMinutes: 90,
		maxConcurrentLearners: 1,
		applyHighConfidence: false,
		reflectionReview: false,
		reflectionMinToolCalls: 12,
		reflectionCooldownMinutes: 24 * 60,
		complexTaskToolCalls: 12,
	},
	full: {
		...AUTO_LEARN_DEFAULTS,
		enabled: true,
		longSessionMessages: 64,
		longSessionContextPercent: 85,
		cooldownMinutes: 24 * 60,
		leaseMinutes: 90,
		maxConcurrentLearners: 1,
		applyHighConfidence: true,
		reflectionReview: true,
		reflectionMinToolCalls: 12,
		reflectionCooldownMinutes: 24 * 60,
		complexTaskToolCalls: 12,
	},
} as const satisfies Record<AutonomyMode, Required<AutoLearnSettings>>;

const AUTONOMY_MODES: AutonomyMode[] = ["off", "safe", "balanced", "full"];
const AUTO_LEARN_RESERVATION_MS = 2 * 60 * 1000;
export const AUTO_LEARN_HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface AutoLearnHistoryPruneResult {
	promptFiles: number;
	logFiles: number;
	sessionFiles: number;
	errors: number;
}

export interface AutoLearnHistoryPruneOptions {
	dataDir: string;
	now?: number;
	retentionMs?: number;
	activeRunIds?: Iterable<string | undefined>;
	activeSessionIds?: Iterable<string | undefined>;
}

type AutoLearnHistoryPruneCounter = Exclude<keyof AutoLearnHistoryPruneResult, "errors">;

function definedStringSet(values: Iterable<string | undefined> | undefined): Set<string> {
	const set = new Set<string>();
	if (!values) return set;
	for (const value of values) {
		if (typeof value === "string" && value.length > 0) set.add(value);
	}
	return set;
}

function sanitizeAutoLearnPathPart(input: string | undefined, fallback: string): string {
	const cleaned = (input || fallback)
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return cleaned || fallback;
}

function isOldAutoLearnArtifact(filePath: string, now: number, retentionMs: number): boolean {
	const stats = fs.lstatSync(filePath);
	return stats.isFile() && now - stats.mtimeMs > retentionMs;
}

function removeOldAutoLearnArtifact(
	filePath: string,
	result: AutoLearnHistoryPruneResult,
	counter: AutoLearnHistoryPruneCounter,
): void {
	try {
		fs.rmSync(filePath, { force: true });
		result[counter]++;
	} catch {
		result.errors++;
	}
}

function isPathInside(target: string, root: string): boolean {
	const resolvedTarget = path.resolve(target);
	const resolvedRoot = path.resolve(root);
	return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

function removeAutoLearnArtifactPath(filePath: string, root: string): boolean {
	if (!isPathInside(filePath, root)) return false;
	try {
		fs.rmSync(filePath, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}

function getAutoLearnSessionIdFromFileName(fileName: string): string | undefined {
	return fileName.match(/_(auto-learn-[A-Za-z0-9._-]+)\.jsonl$/)?.[1];
}

function pruneAutoLearnSessionFiles(
	dir: string,
	activeSessionIds: ReadonlySet<string>,
	now: number,
	retentionMs: number,
	result: AutoLearnHistoryPruneResult,
): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		const filePath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			pruneAutoLearnSessionFiles(filePath, activeSessionIds, now, retentionMs, result);
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
		let shouldPrune = false;
		try {
			shouldPrune = isOldAutoLearnArtifact(filePath, now, retentionMs);
		} catch {
			result.errors++;
			continue;
		}
		if (!shouldPrune) continue;
		const sessionId = readAutoLearnSessionIdFromFile(filePath) ?? getAutoLearnSessionIdFromFileName(entry.name);
		if (!sessionId || !isAutoLearnSessionId(sessionId) || activeSessionIds.has(sessionId)) continue;
		removeOldAutoLearnArtifact(filePath, result, "sessionFiles");
	}
}

function pruneAutoLearnRunArtifacts(
	dir: string,
	activeRunIds: ReadonlySet<string>,
	now: number,
	retentionMs: number,
	result: AutoLearnHistoryPruneResult,
): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		const filePath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			pruneAutoLearnRunArtifacts(filePath, activeRunIds, now, retentionMs, result);
			continue;
		}
		if (!entry.isFile()) continue;
		const promptRunId = entry.name.endsWith(".prompt.md") ? entry.name.slice(0, -".prompt.md".length) : undefined;
		const logRunId = entry.name.endsWith(".log") ? entry.name.slice(0, -".log".length) : undefined;
		const runId = promptRunId ?? logRunId;
		if (!runId || activeRunIds.has(runId)) continue;
		let shouldPrune = false;
		try {
			shouldPrune = isOldAutoLearnArtifact(filePath, now, retentionMs);
		} catch {
			result.errors++;
			continue;
		}
		if (!shouldPrune) continue;
		removeOldAutoLearnArtifact(filePath, result, promptRunId ? "promptFiles" : "logFiles");
	}
}

export function pruneAutoLearnConversationHistory(options: AutoLearnHistoryPruneOptions): AutoLearnHistoryPruneResult {
	const result: AutoLearnHistoryPruneResult = { promptFiles: 0, logFiles: 0, sessionFiles: 0, errors: 0 };
	const dataDir = path.resolve(options.dataDir);
	const now = options.now ?? Date.now();
	const retentionMs = options.retentionMs ?? AUTO_LEARN_HISTORY_RETENTION_MS;
	const activeRunIds = definedStringSet(options.activeRunIds);
	const activeSessionIds = definedStringSet(options.activeSessionIds);
	if (retentionMs <= 0 || !fs.existsSync(dataDir)) return result;

	pruneAutoLearnRunArtifacts(dataDir, activeRunIds, now, retentionMs, result);
	pruneAutoLearnSessionFiles(dataDir, activeSessionIds, now, retentionMs, result);
	return result;
}

interface AutoLearnRunRecord {
	tenant: string;
	pid?: number;
	model: string;
	reason: string;
	startedAt: number;
	expiresAt: number;
	cwd: string;
	logPath: string;
	sessionDir?: string;
	sessionId?: string;
	promptPath?: string;
	kind?: "auto" | "reflection";
	autonomyMode?: AutonomyMode;
	authority?: string;
	status?: "reserved" | "running";
}

interface AutoLearnState {
	lastLaunchByTenant?: Record<string, number>;
	lastReflectionByTenant?: Record<string, number>;
	runs?: Record<string, AutoLearnRunRecord>;
}

interface AutoLearnStateLockResult<T> {
	result: T;
	next?: AutoLearnState;
}

interface AutoLearnDecision {
	shouldRun: boolean;
	reason: string;
	messageCount: number;
	contextPercent: number | null;
	cooldownRemainingMs: number;
	runningCount: number;
	bypassCooldown?: boolean;
}

interface AutoLearnReservation {
	runId: string;
	startedAt: number;
}

type AutoLearnReservationResult = { ok: true; reservation: AutoLearnReservation } | { ok: false; reason: string };

interface AutonomyReviewDecision extends AutoLearnDecision {
	toolCalls: number;
	digest?: string;
}

export interface AutoLearnSpawnTarget {
	command: string;
	argsPrefix: string[];
}

export interface AutoLearnSpawnArgsOptions {
	name: string;
	modelPattern: string;
	thinkingLevel?: string;
	sessionDir: string;
	sessionId: string;
	promptPath: string;
}

export function buildAutoLearnSpawnArgs(
	spawnTarget: AutoLearnSpawnTarget,
	options: AutoLearnSpawnArgsOptions,
): string[] {
	return [
		...spawnTarget.argsPrefix,
		"--print",
		"--name",
		options.name,
		"--model",
		options.modelPattern,
		...(options.thinkingLevel ? ["--thinking", options.thinkingLevel] : []),
		"--session-dir",
		options.sessionDir,
		"--session-id",
		options.sessionId,
		`@${options.promptPath}`,
	];
}

export function findAutoLearnSpawnNullByteInput(command: string, args: readonly string[]): string | undefined {
	if (command.includes("\0")) return "command";
	const argIndex = args.findIndex((arg) => arg.includes("\0"));
	return argIndex === -1 ? undefined : `args[${argIndex}]`;
}

function isAnthropicSubscriptionAuthKey(apiKey: string | undefined): boolean {
	return typeof apiKey === "string" && apiKey.startsWith("sk-ant-oat");
}

function isUnknownModel(model: Model<any> | undefined): boolean {
	return !!model && model.provider === "unknown" && model.id === "unknown" && model.api === "unknown";
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

function hasDefaultModelProvider(providerId: string): providerId is keyof typeof defaultModelPerProvider {
	return providerId in defaultModelPerProvider;
}

const BEDROCK_PROVIDER_ID = "amazon-bedrock";

const BUILT_IN_MODEL_PROVIDERS = new Set<string>(getProviders());

export function isApiKeyLoginProvider(
	providerId: string,
	oauthProviderIds: ReadonlySet<string>,
	builtInProviderIds: ReadonlySet<string> = BUILT_IN_MODEL_PROVIDERS,
): boolean {
	if (BUILT_IN_PROVIDER_DISPLAY_NAMES[providerId]) {
		return true;
	}
	if (builtInProviderIds.has(providerId)) {
		return false;
	}
	return !oauthProviderIds.has(providerId);
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
	private editorComponentFactory: EditorFactory | undefined;
	private autocompleteProvider: AutocompleteProvider | undefined;
	private autocompleteProviderWrappers: AutocompleteProviderFactory[] = [];
	private fdPath: string | undefined;
	private editorContainer: Container;
	private footer: FooterComponent;
	private footerDataProvider: FooterDataProvider;
	// Stored so the same manager can be injected into custom editors, selectors, and extension UI.
	private keybindings: KeybindingsManager;
	private version: string;
	private isInitialized = false;
	private onInputCallback?: (submission: UserInputSubmission) => void;
	private pendingUserInputs: UserInputSubmission[] = [];
	private pendingClipboardImages: PendingClipboardImage[] = [];
	private clipboardImageCounter = 0;
	private loadingAnimation: Loader | undefined = undefined;
	// Native-reflection debounce: prevents back-to-back/overlapping background reflection passes (cost
	// guard). `_nativeReflectionInFlight` blocks a second pass while one runs; `_lastNativeReflectionAt`
	// enforces a minimum gap between passes. A debounce-skipped turn's text is BUFFERED in
	// `_pendingReflectionText` (not dropped) and folded into the next pass, so no corrective feedback is
	// lost — reflection sees only the current turn's messages, so dropping a skipped turn would lose its
	// learning entirely (bug #29).
	private _nativeReflectionInFlight = false;
	private _lastNativeReflectionAt = 0;
	private _pendingReflectionText: string[] = [];
	private static readonly NATIVE_REFLECTION_MIN_INTERVAL_MS = 45_000;
	private static readonly PENDING_REFLECTION_MAX_CHARS = 12_000;
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

	// Extension UI state
	private extensionSelector: ExtensionSelectorComponent | undefined = undefined;
	private extensionInput: ExtensionInputComponent | undefined = undefined;
	private extensionEditor: ExtensionEditorComponent | undefined = undefined;
	private extensionTerminalInputUnsubscribers = new Set<() => void>();

	// Extension widgets (components rendered above/below the editor)
	private extensionWidgetsAbove = new Map<string, Component & { dispose?(): void }>();
	private extensionWidgetsBelow = new Map<string, Component & { dispose?(): void }>();
	private widgetContainerAbove!: Container;
	private widgetContainerBelow!: Container;

	// Custom footer from extension (undefined = use built-in footer)
	private customFooter: (Component & { dispose?(): void }) | undefined = undefined;

	// Header container that holds the built-in or custom header
	private headerContainer: Container;

	// Built-in header (logo + keybinding hints + changelog)
	private builtInHeader: Component | undefined = undefined;

	// Custom header from extension (undefined = use built-in header)
	private customHeader: (Component & { dispose?(): void }) | undefined = undefined;

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
			this.resetExtensionUI();
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
		this.footerDataProvider = new FooterDataProvider(this.sessionManager.getCwd());
		this.footer = new FooterComponent(this.session, this.footerDataProvider);
		this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);

		// Load hide thinking block setting
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();

		// Register themes from resource loader and initialize
		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		initTheme(this.settingsManager.getTheme(), true);
	}

	private getAutocompleteSourceTag(sourceInfo?: SourceInfo): string | undefined {
		if (!sourceInfo) {
			return undefined;
		}

		const scopePrefix = sourceInfo.scope === "user" ? "u" : sourceInfo.scope === "project" ? "p" : "t";
		const source = sourceInfo.source.trim();

		if (source === "auto" || source === "local" || source === "cli") {
			return scopePrefix;
		}

		if (source.startsWith("npm:")) {
			return `${scopePrefix}:${source}`;
		}

		const gitSource = parseGitUrl(source);
		if (gitSource) {
			const ref = gitSource.ref ? `@${gitSource.ref}` : "";
			return `${scopePrefix}:git:${gitSource.host}/${gitSource.path}${ref}`;
		}

		return scopePrefix;
	}

	private prefixAutocompleteDescription(description: string | undefined, sourceInfo?: SourceInfo): string | undefined {
		const sourceTag = this.getAutocompleteSourceTag(sourceInfo);
		if (!sourceTag) {
			return description;
		}
		return description ? `[${sourceTag}] ${description}` : `[${sourceTag}]`;
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

	private createBaseAutocompleteProvider(): AutocompleteProvider {
		// Define commands for autocomplete
		const slashCommands: SlashCommand[] = BUILTIN_SLASH_COMMANDS.map((command) => ({
			name: command.name,
			description: command.description,
		}));

		const modelCommand = slashCommands.find((command) => command.name === "model");
		if (modelCommand) {
			modelCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
				// Get available models (scoped or from registry)
				const models =
					this.session.scopedModels.length > 0
						? this.session.scopedModels.map((s) => s.model)
						: this.session.modelRegistry.getAvailable();

				if (models.length === 0) return null;

				// Create items with provider/id format
				const items = models.map((m) => ({
					id: m.id,
					provider: m.provider,
					label: `${m.provider}/${m.id}`,
				}));

				// Fuzzy filter by model ID + provider (allows "opus anthropic" to match)
				const filtered = fuzzyFilter(items, prefix, (item) => `${item.id} ${item.provider}`);

				if (filtered.length === 0) return null;

				return filtered.map((item) => ({
					value: item.label,
					label: item.id,
					description: item.provider,
				}));
			};
		}

		// Convert prompt templates to SlashCommand format for autocomplete
		const templateCommands: SlashCommand[] = this.session.promptTemplates.map((cmd) => ({
			name: cmd.name,
			description: this.prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
			...(cmd.argumentHint && { argumentHint: cmd.argumentHint }),
		}));

		// Convert extension commands to SlashCommand format
		const builtinCommandNames = new Set(slashCommands.map((c) => c.name));
		const extensionCommands: SlashCommand[] = this.session.extensionRunner
			.getRegisteredCommands()
			.filter((cmd) => !builtinCommandNames.has(cmd.name))
			.map((cmd) => ({
				name: cmd.invocationName,
				description: this.prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
				getArgumentCompletions: cmd.getArgumentCompletions,
			}));

		// Build skill commands from session.skills (if enabled)
		this.skillCommands.clear();
		const skillCommandList: SlashCommand[] = [];
		if (this.settingsManager.getEnableSkillCommands()) {
			for (const skill of this.session.resourceLoader.getActiveSkills()) {
				const commandName = `skill:${skill.name}`;
				this.skillCommands.set(commandName, skill.filePath);
				skillCommandList.push({
					name: commandName,
					description: this.prefixAutocompleteDescription(skill.description, skill.sourceInfo),
				});
			}
		}

		return new CombinedAutocompleteProvider(
			[...slashCommands, ...templateCommands, ...extensionCommands, ...skillCommandList],
			this.sessionManager.getCwd(),
			this.fdPath,
		);
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

	private showStartupNoticesIfNeeded(): void {
		if (this.startupNoticesShown) {
			return;
		}
		this.startupNoticesShown = true;

		if (!this.changelogMarkdown) {
			return;
		}

		if (this.chatContainer.children.length > 0) {
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(new DynamicBorder());
		if (this.settingsManager.getCollapseChangelog()) {
			const versionMatch = this.changelogMarkdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
			const latestVersion = versionMatch ? versionMatch[1] : this.version;
			const condensedText = `Updated to v${latestVersion}. Use ${theme.bold("/changelog")} to view full changelog.`;
			this.chatContainer.addChild(new Text(condensedText, 1, 0));
		} else {
			this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Markdown(this.changelogMarkdown.trim(), 1, 0, this.getMarkdownThemeWithSettings()),
			);
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(new DynamicBorder());
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
		this.renderWidgets(); // Initialize with default spacer
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
		if (this.settingsManager.isProjectTrusted() || !hasProjectTrustInputs(this.sessionManager.getCwd())) {
			return;
		}

		if (this.chatContainer.children.length > 0) {
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(
			new Text(
				theme.fg(
					"warning",
					"This project is not trusted. Project instructions (AGENTS.md/CLAUDE.md/GEMINI.md), .pi resources, and project packages are ignored. Use /trust to save a trust decision, then restart pi.",
				),
				1,
				0,
			),
		);
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

	private async checkForPackageUpdates(): Promise<string[]> {
		if (process.env.PI_OFFLINE) {
			return [];
		}

		try {
			const packageManager = new DefaultPackageManager({
				cwd: this.sessionManager.getCwd(),
				agentDir: getAgentDir(),
				settingsManager: this.settingsManager,
			});
			const updates = await packageManager.checkForAvailableUpdates();
			return updates.map((update) => update.displayName);
		} catch {
			return [];
		}
	}

	private async checkTmuxKeyboardSetup(): Promise<string | undefined> {
		if (!process.env.TMUX) return undefined;

		const runTmuxShow = (option: string): Promise<string | undefined> => {
			return new Promise((resolve) => {
				const proc = spawn("tmux", ["show", "-gv", option], {
					stdio: ["ignore", "pipe", "ignore"],
				});
				let stdout = "";
				const timer = setTimeout(() => {
					proc.kill();
					resolve(undefined);
				}, 2000);

				proc.stdout?.on("data", (data) => {
					stdout += data.toString();
				});
				proc.on("error", () => {
					clearTimeout(timer);
					resolve(undefined);
				});
				proc.on("close", (code) => {
					clearTimeout(timer);
					resolve(code === 0 ? stdout.trim() : undefined);
				});
			});
		};

		const [extendedKeys, extendedKeysFormat] = await Promise.all([
			runTmuxShow("extended-keys"),
			runTmuxShow("extended-keys-format"),
		]);

		// If we couldn't query tmux (timeout, sandbox, etc.), don't warn
		if (extendedKeys === undefined) return undefined;

		if (extendedKeys !== "on" && extendedKeys !== "always") {
			return "tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.";
		}

		if (extendedKeysFormat === "xterm") {
			return "tmux extended-keys-format is xterm. Pi works best with csi-u. Add `set -g extended-keys-format csi-u` to ~/.tmux.conf and restart tmux.";
		}

		return undefined;
	}

	/**
	 * Get changelog entries to display on startup.
	 * Only shows new entries since last seen version, skips for resumed sessions.
	 */
	private getChangelogForDisplay(): string | undefined {
		// Skip changelog for resumed/continued sessions (already have messages)
		if (this.session.state.messages.length > 0) {
			return undefined;
		}

		const lastVersion = this.settingsManager.getLastChangelogVersion();
		const changelogPath = getChangelogPath();
		const entries = parseChangelog(changelogPath);

		if (!lastVersion) {
			// Fresh install - record the version, send telemetry, don't show changelog
			this.settingsManager.setLastChangelogVersion(VERSION);
			this.reportInstallTelemetry(VERSION);
			return undefined;
		}

		const newEntries = getNewEntries(entries, lastVersion);
		if (newEntries.length > 0) {
			this.settingsManager.setLastChangelogVersion(VERSION);
			this.reportInstallTelemetry(VERSION);
			return newEntries.map((e) => e.content).join("\n\n");
		}

		return undefined;
	}

	private reportInstallTelemetry(version: string): void {
		if (process.env.PI_OFFLINE) {
			return;
		}

		if (!isInstallTelemetryEnabled(this.settingsManager)) {
			return;
		}

		void fetch(`https://pi.dev/api/report-install?version=${encodeURIComponent(version)}`, {
			headers: {
				"User-Agent": getPiUserAgent(version),
			},
			signal: AbortSignal.timeout(5000),
		})
			.then(() => undefined)
			.catch(() => undefined);
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

	private formatDisplayPath(p: string): string {
		const home = os.homedir();
		let result = p;

		// Replace home directory with ~
		if (result.startsWith(home)) {
			result = `~${result.slice(home.length)}`;
		}

		return result;
	}

	private formatExtensionDisplayPath(path: string): string {
		let result = this.formatDisplayPath(path);
		result = result.replace(/\/index\.ts$/, "").replace(/\/index\.js$/, "");
		return result;
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

	/**
	 * Get a short path relative to the package root for display.
	 */
	private getShortPath(fullPath: string, sourceInfo?: SourceInfo): string {
		const baseDir = sourceInfo?.baseDir;
		if (baseDir && this.isPackageSource(sourceInfo)) {
			const relativePath = path.relative(path.resolve(baseDir), path.resolve(fullPath));
			if (
				relativePath &&
				relativePath !== "." &&
				!relativePath.startsWith("..") &&
				!relativePath.startsWith(`..${path.sep}`) &&
				!path.isAbsolute(relativePath)
			) {
				return relativePath.replace(/\\/g, "/");
			}
		}

		const source = sourceInfo?.source ?? "";
		const npmMatch = fullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
		if (npmMatch && source.startsWith("npm:")) {
			return npmMatch[2];
		}

		const gitMatch = fullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
		if (gitMatch && source.startsWith("git:")) {
			return gitMatch[1];
		}

		return this.formatDisplayPath(fullPath);
	}

	private getCompactPathLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
		const shortPath = this.getShortPath(resourcePath, sourceInfo);
		const normalizedPath = shortPath.replace(/\\/g, "/");
		const segments = normalizedPath.split("/").filter((segment) => segment.length > 0 && segment !== "~");
		if (segments.length > 0) {
			return segments[segments.length - 1]!;
		}
		return shortPath;
	}

	private getCompactPackageSourceLabel(sourceInfo?: SourceInfo): string {
		const source = sourceInfo?.source ?? "";
		if (source.startsWith("npm:")) {
			return source.slice("npm:".length) || source;
		}

		const gitSource = parseGitUrl(source);
		if (gitSource) {
			return gitSource.path || source;
		}

		return source;
	}

	private getCompactExtensionLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
		if (!this.isPackageSource(sourceInfo)) {
			return this.getCompactPathLabel(resourcePath, sourceInfo);
		}

		const sourceLabel = this.getCompactPackageSourceLabel(sourceInfo);
		if (!sourceLabel) {
			return this.getCompactPathLabel(resourcePath, sourceInfo);
		}

		const shortPath = this.getShortPath(resourcePath, sourceInfo).replace(/\\/g, "/");
		const packagePath = shortPath.startsWith("extensions/") ? shortPath.slice("extensions/".length) : shortPath;
		const parsedPath = path.posix.parse(packagePath);

		if (parsedPath.name === "index") {
			return !parsedPath.dir || parsedPath.dir === "." ? sourceLabel : `${sourceLabel}:${parsedPath.dir}`;
		}

		return `${sourceLabel}:${packagePath}`;
	}

	private getCompactDisplayPathSegments(resourcePath: string): string[] {
		return this.formatDisplayPath(resourcePath)
			.replace(/\\/g, "/")
			.split("/")
			.filter((segment) => segment.length > 0 && segment !== "~");
	}

	private getCompactNonPackageExtensionLabel(
		resourcePath: string,
		index: number,
		allPaths: Array<{ path: string; segments: string[] }>,
	): string {
		const segments = allPaths[index]?.segments;
		if (!segments || segments.length === 0) {
			return this.getCompactPathLabel(resourcePath);
		}

		for (let segmentCount = 1; segmentCount <= segments.length; segmentCount += 1) {
			const candidate = segments.slice(-segmentCount).join("/");
			const isUnique = allPaths.every((item, itemIndex) => {
				if (itemIndex === index) {
					return true;
				}
				return item.segments.slice(-segmentCount).join("/") !== candidate;
			});

			if (isUnique) {
				return candidate;
			}
		}

		return segments.join("/");
	}

	private getCompactExtensionLabels(extensions: Array<{ path: string; sourceInfo?: SourceInfo }>): string[] {
		const nonPackageExtensions = extensions
			.map((extension) => {
				const segments = this.getCompactDisplayPathSegments(extension.path);
				const lastSegment = segments[segments.length - 1];
				if (segments.length > 1 && (lastSegment === "index.ts" || lastSegment === "index.js")) {
					segments.pop();
				}
				return {
					path: extension.path,
					sourceInfo: extension.sourceInfo,
					segments,
				};
			})
			.filter((extension) => !this.isPackageSource(extension.sourceInfo));

		return extensions.map((extension) => {
			if (this.isPackageSource(extension.sourceInfo)) {
				return this.getCompactExtensionLabel(extension.path, extension.sourceInfo);
			}

			const nonPackageIndex = nonPackageExtensions.findIndex((item) => item.path === extension.path);
			if (nonPackageIndex === -1) {
				return this.getCompactPathLabel(extension.path, extension.sourceInfo);
			}

			return this.getCompactNonPackageExtensionLabel(extension.path, nonPackageIndex, nonPackageExtensions);
		});
	}

	private getDisplaySourceInfo(sourceInfo?: SourceInfo): {
		label: string;
		scopeLabel?: string;
		color: "accent" | "muted";
	} {
		const source = sourceInfo?.source ?? "local";
		const scope = sourceInfo?.scope ?? "project";
		if (source === "local") {
			if (scope === "user") {
				return { label: "user", color: "muted" };
			}
			if (scope === "project") {
				return { label: "project", color: "muted" };
			}
			if (scope === "temporary") {
				return { label: "path", scopeLabel: "temp", color: "muted" };
			}
			return { label: "path", color: "muted" };
		}

		if (source === "cli") {
			return { label: "path", scopeLabel: scope === "temporary" ? "temp" : undefined, color: "muted" };
		}

		const scopeLabel =
			scope === "user" ? "user" : scope === "project" ? "project" : scope === "temporary" ? "temp" : undefined;
		return { label: source, scopeLabel, color: "accent" };
	}

	private getScopeGroup(sourceInfo?: SourceInfo): "user" | "project" | "path" {
		const source = sourceInfo?.source ?? "local";
		const scope = sourceInfo?.scope ?? "project";
		if (source === "cli" || scope === "temporary") return "path";
		if (scope === "user") return "user";
		if (scope === "project") return "project";
		return "path";
	}

	private isPackageSource(sourceInfo?: SourceInfo): boolean {
		const source = sourceInfo?.source ?? "";
		return source.startsWith("npm:") || source.startsWith("git:");
	}

	private buildScopeGroups(items: Array<{ path: string; sourceInfo?: SourceInfo }>): Array<{
		scope: "user" | "project" | "path";
		paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
		packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
	}> {
		const groups: Record<
			"user" | "project" | "path",
			{
				scope: "user" | "project" | "path";
				paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
				packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
			}
		> = {
			user: { scope: "user", paths: [], packages: new Map() },
			project: { scope: "project", paths: [], packages: new Map() },
			path: { scope: "path", paths: [], packages: new Map() },
		};

		for (const item of items) {
			const groupKey = this.getScopeGroup(item.sourceInfo);
			const group = groups[groupKey];
			const source = item.sourceInfo?.source ?? "local";

			if (this.isPackageSource(item.sourceInfo)) {
				const list = group.packages.get(source) ?? [];
				list.push(item);
				group.packages.set(source, list);
			} else {
				group.paths.push(item);
			}
		}

		return [groups.project, groups.user, groups.path].filter(
			(group) => group.paths.length > 0 || group.packages.size > 0,
		);
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
		const lines: string[] = [];

		for (const group of groups) {
			lines.push(`  ${theme.fg("accent", group.scope)}`);

			const sortedPaths = [...group.paths].sort((a, b) => a.path.localeCompare(b.path));
			for (const item of sortedPaths) {
				lines.push(theme.fg("dim", `    ${options.formatPath(item)}`));
			}

			const sortedPackages = Array.from(group.packages.entries()).sort(([a], [b]) => a.localeCompare(b));
			for (const [source, items] of sortedPackages) {
				lines.push(`    ${theme.fg("mdLink", source)}`);
				const sortedPackagePaths = [...items].sort((a, b) => a.path.localeCompare(b.path));
				for (const item of sortedPackagePaths) {
					lines.push(theme.fg("dim", `      ${options.formatPackagePath(item, source)}`));
				}
			}
		}

		return lines.join("\n");
	}

	private findSourceInfoForPath(p: string, sourceInfos: Map<string, SourceInfo>): SourceInfo | undefined {
		const exact = sourceInfos.get(p);
		if (exact) return exact;

		let current = p;
		while (current.includes("/")) {
			current = current.substring(0, current.lastIndexOf("/"));
			const parent = sourceInfos.get(current);
			if (parent) return parent;
		}

		return undefined;
	}

	private formatPathWithSource(p: string, sourceInfo?: SourceInfo): string {
		if (sourceInfo) {
			const shortPath = this.getShortPath(p, sourceInfo);
			const { label, scopeLabel } = this.getDisplaySourceInfo(sourceInfo);
			const labelText = scopeLabel ? `${label} (${scopeLabel})` : label;
			return `${labelText} ${shortPath}`;
		}
		return this.formatDisplayPath(p);
	}

	private formatDiagnostics(diagnostics: readonly ResourceDiagnostic[], sourceInfos: Map<string, SourceInfo>): string {
		const lines: string[] = [];

		// Group collision diagnostics by name
		const collisions = new Map<string, ResourceDiagnostic[]>();
		const otherDiagnostics: ResourceDiagnostic[] = [];

		for (const d of diagnostics) {
			if (d.type === "collision" && d.collision) {
				const list = collisions.get(d.collision.name) ?? [];
				list.push(d);
				collisions.set(d.collision.name, list);
			} else {
				otherDiagnostics.push(d);
			}
		}

		// Format collision diagnostics grouped by name
		for (const [name, collisionList] of collisions) {
			const first = collisionList[0]?.collision;
			if (!first) continue;
			lines.push(theme.fg("warning", `  "${name}" collision:`));
			lines.push(
				theme.fg(
					"dim",
					`    ${theme.fg("success", "✓")} ${this.formatPathWithSource(first.winnerPath, this.findSourceInfoForPath(first.winnerPath, sourceInfos))}`,
				),
			);
			for (const d of collisionList) {
				if (d.collision) {
					lines.push(
						theme.fg(
							"dim",
							`    ${theme.fg("warning", "✗")} ${this.formatPathWithSource(d.collision.loserPath, this.findSourceInfoForPath(d.collision.loserPath, sourceInfos))} (skipped)`,
						),
					);
				}
			}
		}

		for (const d of otherDiagnostics) {
			if (d.path) {
				const formattedPath = this.formatPathWithSource(d.path, this.findSourceInfoForPath(d.path, sourceInfos));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${formattedPath}`));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `    ${d.message}`));
			} else {
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${d.message}`));
			}
		}

		return lines.join("\n");
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
		const uiContext = this.createExtensionUIContext();
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
				this.showExtensionError(error.extensionPath, error.error, error.stack);
			},
		});

		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		this.setupAutocompleteProvider();

		const extensionRunner = this.session.extensionRunner;
		this.setupExtensionShortcuts(extensionRunner);
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

	/**
	 * Set up keyboard shortcuts registered by extensions.
	 */
	private setupExtensionShortcuts(extensionRunner: ExtensionRunner): void {
		const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
		if (shortcuts.size === 0) return;

		// Create a context for shortcut handlers
		const createContext = (): ExtensionContext => ({
			ui: this.createExtensionUIContext(),
			hasUI: true,
			mode: "tui",
			cwd: this.sessionManager.getCwd(),
			sessionManager: this.sessionManager,
			modelRegistry: this.session.modelRegistry,
			model: this.session.model,
			isIdle: () => !this.session.isStreaming,
			signal: this.session.agent.signal,
			abort: () => {
				this.restoreQueuedMessagesToEditor({ abort: true });
			},
			hasPendingMessages: () => this.session.pendingMessageCount > 0,
			shutdown: () => {
				this.shutdownRequested = true;
			},
			getContextUsage: () => this.session.getContextUsage(),
			compact: (options) => {
				void (async () => {
					try {
						const result = await this.session.compact(options?.customInstructions);
						options?.onComplete?.(result);
					} catch (error) {
						const err = error instanceof Error ? error : new Error(String(error));
						options?.onError?.(err);
					}
				})();
			},
			reload: async () => {
				await this.handleReloadCommand();
			},
			getSystemPrompt: () => this.session.systemPrompt,
		});

		// Set up the extension shortcut handler on the default editor
		this.defaultEditor.onExtensionShortcut = (data: string) => {
			for (const [shortcutStr, shortcut] of shortcuts) {
				// Cast to KeyId - extension shortcuts use the same format
				if (matchesKey(data, shortcutStr as KeyId)) {
					// Run handler async, don't block input
					Promise.resolve(shortcut.handler(createContext())).catch((err) => {
						this.showError(`Shortcut handler error: ${err instanceof Error ? err.message : String(err)}`);
					});
					return true;
				}
			}
			return false;
		};
	}

	/**
	 * Set extension status text in the footer.
	 */
	private setExtensionStatus(key: string, text: string | undefined): void {
		this.footerDataProvider.setExtensionStatus(key, text);
		this.ui.requestRender();
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
	 * Set an extension widget (string array or custom component).
	 */
	private setExtensionWidget(
		key: string,
		content: string[] | ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void {
		const placement = options?.placement ?? "aboveEditor";
		const removeExisting = (map: Map<string, Component & { dispose?(): void }>) => {
			const existing = map.get(key);
			if (existing?.dispose) existing.dispose();
			map.delete(key);
		};

		removeExisting(this.extensionWidgetsAbove);
		removeExisting(this.extensionWidgetsBelow);

		if (content === undefined) {
			this.renderWidgets();
			return;
		}

		let component: Component & { dispose?(): void };

		if (Array.isArray(content)) {
			// Wrap string array in a Container with Text components
			const container = new Container();
			for (const line of content.slice(0, InteractiveMode.MAX_WIDGET_LINES)) {
				container.addChild(new Text(line, 1, 0));
			}
			if (content.length > InteractiveMode.MAX_WIDGET_LINES) {
				container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
			}
			component = container;
		} else {
			// Factory function - create component
			component = content(this.ui, theme);
		}

		const targetMap = placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
		targetMap.set(key, component);
		this.renderWidgets();
	}

	private clearExtensionWidgets(): void {
		for (const widget of this.extensionWidgetsAbove.values()) {
			widget.dispose?.();
		}
		for (const widget of this.extensionWidgetsBelow.values()) {
			widget.dispose?.();
		}
		this.extensionWidgetsAbove.clear();
		this.extensionWidgetsBelow.clear();
		this.renderWidgets();
	}

	private resetExtensionUI(): void {
		if (this.extensionSelector) {
			this.hideExtensionSelector();
		}
		if (this.extensionInput) {
			this.hideExtensionInput();
		}
		if (this.extensionEditor) {
			this.hideExtensionEditor();
		}
		this.ui.hideOverlay();
		this.clearExtensionTerminalInputListeners();
		this.setExtensionFooter(undefined);
		this.setExtensionHeader(undefined);
		this.clearExtensionWidgets();
		this.footerDataProvider.clearExtensionStatuses();
		this.footer.invalidate();
		this.autocompleteProviderWrappers = [];
		this.setCustomEditorComponent(undefined);
		this.setupAutocompleteProvider();
		this.defaultEditor.onExtensionShortcut = undefined;
		this.updateTerminalTitle();
		this.workingMessage = undefined;
		this.workingVisible = true;
		this.setWorkingIndicator();
		if (this.loadingAnimation) {
			this.loadingAnimation.setMessage(`${this.defaultWorkingMessage} (${keyText("app.interrupt")} to interrupt)`);
		}
		this.setHiddenThinkingLabel();
	}

	// Maximum total widget lines to prevent viewport overflow
	private static readonly MAX_WIDGET_LINES = 10;

	/**
	 * Render all extension widgets to the widget container.
	 */
	private renderWidgets(): void {
		if (!this.widgetContainerAbove || !this.widgetContainerBelow) return;
		this.renderWidgetContainer(this.widgetContainerAbove, this.extensionWidgetsAbove, true, true);
		this.renderWidgetContainer(this.widgetContainerBelow, this.extensionWidgetsBelow, false, false);
		this.ui.requestRender();
	}

	private renderWidgetContainer(
		container: Container,
		widgets: Map<string, Component & { dispose?(): void }>,
		spacerWhenEmpty: boolean,
		leadingSpacer: boolean,
	): void {
		container.clear();

		if (widgets.size === 0) {
			if (spacerWhenEmpty) {
				container.addChild(new Spacer(1));
			}
			return;
		}

		if (leadingSpacer) {
			container.addChild(new Spacer(1));
		}
		for (const component of widgets.values()) {
			container.addChild(component);
		}
	}

	/**
	 * Set a custom footer component, or restore the built-in footer.
	 */
	private setExtensionFooter(
		factory:
			| ((tui: TUI, thm: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			| undefined,
	): void {
		// Dispose existing custom footer
		if (this.customFooter?.dispose) {
			this.customFooter.dispose();
		}

		// Remove current footer from UI
		if (this.customFooter) {
			this.ui.removeChild(this.customFooter);
		} else {
			this.ui.removeChild(this.footer);
		}

		if (factory) {
			// Create and add custom footer, passing the data provider
			this.customFooter = factory(this.ui, theme, this.footerDataProvider);
			this.ui.addChild(this.customFooter);
		} else {
			// Restore built-in footer
			this.customFooter = undefined;
			this.ui.addChild(this.footer);
		}

		this.ui.requestRender();
	}

	/**
	 * Set a custom header component, or restore the built-in header.
	 */
	private setExtensionHeader(factory: ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined): void {
		// Header may not be initialized yet if called during early initialization
		if (!this.builtInHeader) {
			return;
		}

		// Dispose existing custom header
		if (this.customHeader?.dispose) {
			this.customHeader.dispose();
		}

		// Find the index of the current header in the header container
		const currentHeader = this.customHeader || this.builtInHeader;
		const index = this.headerContainer.children.indexOf(currentHeader);

		if (factory) {
			// Create and add custom header
			this.customHeader = factory(this.ui, theme);
			if (isExpandable(this.customHeader)) {
				this.customHeader.setExpanded(this.toolOutputExpanded);
			}
			if (index !== -1) {
				this.headerContainer.children[index] = this.customHeader;
			} else {
				// If not found (e.g. builtInHeader was never added), add at the top
				this.headerContainer.children.unshift(this.customHeader);
			}
		} else {
			// Restore built-in header
			this.customHeader = undefined;
			if (isExpandable(this.builtInHeader)) {
				this.builtInHeader.setExpanded(this.toolOutputExpanded);
			}
			if (index !== -1) {
				this.headerContainer.children[index] = this.builtInHeader;
			}
		}

		this.ui.requestRender();
	}

	private addExtensionTerminalInputListener(
		handler: (data: string) => { consume?: boolean; data?: string } | undefined,
	): () => void {
		const unsubscribe = this.ui.addInputListener(handler);
		this.extensionTerminalInputUnsubscribers.add(unsubscribe);
		return () => {
			unsubscribe();
			this.extensionTerminalInputUnsubscribers.delete(unsubscribe);
		};
	}

	private clearExtensionTerminalInputListeners(): void {
		for (const unsubscribe of this.extensionTerminalInputUnsubscribers) {
			unsubscribe();
		}
		this.extensionTerminalInputUnsubscribers.clear();
	}

	/**
	 * Create the ExtensionUIContext for extensions.
	 */
	private createExtensionUIContext(): ExtensionUIContext {
		return {
			select: (title, options, opts) => this.showExtensionSelector(title, options, opts),
			confirm: (title, message, opts) => this.showExtensionConfirm(title, message, opts),
			input: (title, placeholder, opts) => this.showExtensionInput(title, placeholder, opts),
			notify: (message, type) => this.showExtensionNotify(message, type),
			onTerminalInput: (handler) => this.addExtensionTerminalInputListener(handler),
			setStatus: (key, text) => this.setExtensionStatus(key, text),
			setWorkingMessage: (message) => {
				this.workingMessage = message;
				if (this.loadingAnimation) {
					this.loadingAnimation.setMessage(message ?? this.defaultWorkingMessage);
				}
			},
			setWorkingVisible: (visible) => this.setWorkingVisible(visible),
			setWorkingIndicator: (options) => this.setWorkingIndicator(options),
			setHiddenThinkingLabel: (label) => this.setHiddenThinkingLabel(label),
			setWidget: (key, content, options) => this.setExtensionWidget(key, content, options),
			setFooter: (factory) => this.setExtensionFooter(factory),
			setHeader: (factory) => this.setExtensionHeader(factory),
			setTitle: (title) => this.ui.terminal.setTitle(title),
			custom: (factory, options) => this.showExtensionCustom(factory, options),
			pasteToEditor: (text) => this.editor.handleInput(`\x1b[200~${text}\x1b[201~`),
			setEditorText: (text) => this.editor.setText(text),
			getEditorText: () => this.editor.getExpandedText?.() ?? this.editor.getText(),
			editor: (title, prefill) => this.showExtensionEditor(title, prefill),
			addAutocompleteProvider: (factory) => {
				this.autocompleteProviderWrappers.push(factory);
				this.setupAutocompleteProvider();
			},
			setEditorComponent: (factory) => this.setCustomEditorComponent(factory),
			getEditorComponent: () => this.editorComponentFactory,
			get theme() {
				return theme;
			},
			getAllThemes: () => getAvailableThemesWithPaths(),
			getTheme: (name) => getThemeByName(name),
			setTheme: (themeOrName) => {
				if (themeOrName instanceof Theme) {
					setThemeInstance(themeOrName);
					this.ui.requestRender();
					return { success: true };
				}
				const result = setTheme(themeOrName, true);
				if (result.success) {
					if (this.settingsManager.getTheme() !== themeOrName) {
						this.settingsManager.setTheme(themeOrName);
					}
					this.ui.requestRender();
				}
				return result;
			},
			getToolsExpanded: () => this.toolOutputExpanded,
			setToolsExpanded: (expanded) => this.setToolsExpanded(expanded),
		};
	}

	/**
	 * Show a selector for extensions.
	 */
	private showExtensionSelector(
		title: string,
		options: string[],
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionSelector();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionSelector = new ExtensionSelectorComponent(
				title,
				options,
				(option) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(option);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout, onToggleToolsExpanded: () => this.toggleToolOutputExpansion() },
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionSelector);
			this.ui.setFocus(this.extensionSelector);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the extension selector.
	 */
	private hideExtensionSelector(): void {
		this.extensionSelector?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionSelector = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Show a confirmation dialog for extensions.
	 */
	private async showExtensionConfirm(
		title: string,
		message: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<boolean> {
		const result = await this.showExtensionSelector(`${title}\n${message}`, ["Yes", "No"], opts);
		return result === "Yes";
	}

	private async promptForMissingSessionCwd(error: MissingSessionCwdError): Promise<string | undefined> {
		const confirmed = await this.showExtensionConfirm(
			"Session cwd not found",
			formatMissingSessionCwdPrompt(error.issue),
		);
		return confirmed ? error.issue.fallbackCwd : undefined;
	}

	/**
	 * Show a text input for extensions.
	 */
	private showExtensionInput(
		title: string,
		placeholder?: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionInput();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionInput = new ExtensionInputComponent(
				title,
				placeholder,
				(value) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(value);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout },
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionInput);
			this.ui.setFocus(this.extensionInput);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the extension input.
	 */
	private hideExtensionInput(): void {
		this.extensionInput?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionInput = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Show a multi-line editor for extensions (with Ctrl+G support).
	 */
	private showExtensionEditor(title: string, prefill?: string): Promise<string | undefined> {
		return new Promise((resolve) => {
			this.extensionEditor = new ExtensionEditorComponent(
				this.ui,
				this.keybindings,
				title,
				prefill,
				(value) => {
					this.hideExtensionEditor();
					resolve(value);
				},
				() => {
					this.hideExtensionEditor();
					resolve(undefined);
				},
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionEditor);
			this.ui.setFocus(this.extensionEditor);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the extension editor.
	 */
	private hideExtensionEditor(): void {
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionEditor = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Set a custom editor component from an extension.
	 * Pass undefined to restore the default editor.
	 */
	private setCustomEditorComponent(factory: EditorFactory | undefined): void {
		this.editorComponentFactory = factory;

		// Save text from current editor before switching
		const currentText = this.editor.getText();

		this.editorContainer.clear();

		if (factory) {
			// Create the custom editor with tui, theme, and keybindings
			const newEditor = factory(this.ui, getEditorTheme(), this.keybindings);

			// Wire up callbacks from the default editor
			newEditor.onSubmit = this.defaultEditor.onSubmit;
			newEditor.onChange = this.defaultEditor.onChange;

			// Copy text from previous editor
			newEditor.setText(currentText);

			// Copy appearance settings if supported
			if (newEditor.borderColor !== undefined) {
				newEditor.borderColor = this.defaultEditor.borderColor;
			}
			if (newEditor.setPaddingX !== undefined) {
				newEditor.setPaddingX(this.defaultEditor.getPaddingX());
			}

			// Set autocomplete if supported
			if (newEditor.setAutocompleteProvider && this.autocompleteProvider) {
				newEditor.setAutocompleteProvider(this.autocompleteProvider);
			}

			// If extending CustomEditor, copy app-level handlers
			// Use duck typing since instanceof fails across jiti module boundaries
			const customEditor = newEditor as unknown as Record<string, unknown>;
			if ("actionHandlers" in customEditor && customEditor.actionHandlers instanceof Map) {
				if (!customEditor.onEscape) {
					customEditor.onEscape = () => this.defaultEditor.onEscape?.();
				}
				if (!customEditor.onCtrlD) {
					customEditor.onCtrlD = () => this.defaultEditor.onCtrlD?.();
				}
				if (!customEditor.onPasteImage) {
					customEditor.onPasteImage = () => this.defaultEditor.onPasteImage?.();
				}
				if (!customEditor.onExtensionShortcut) {
					customEditor.onExtensionShortcut = (data: string) => this.defaultEditor.onExtensionShortcut?.(data);
				}
				// Copy action handlers (clear, suspend, model switching, etc.)
				for (const [action, handler] of this.defaultEditor.actionHandlers) {
					(customEditor.actionHandlers as Map<string, () => void>).set(action, handler);
				}
			}

			this.editor = newEditor;
		} else {
			// Restore default editor with text from custom editor
			this.defaultEditor.setText(currentText);
			this.editor = this.defaultEditor;
		}

		this.editorContainer.addChild(this.editor as Component);
		this.ui.setFocus(this.editor as Component);
		this.ui.requestRender();
	}

	/**
	 * Show a notification for extensions.
	 */
	private showExtensionNotify(message: string, type?: "info" | "warning" | "error"): void {
		if (type === "error") {
			this.showError(message);
		} else if (type === "warning") {
			this.showWarning(message);
		} else {
			this.showStatus(message);
		}
	}

	/** Show a custom component with keyboard focus. Overlay mode renders on top of existing content. */
	private async showExtensionCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T> {
		const savedText = this.editor.getText();
		const isOverlay = options?.overlay ?? false;

		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.editor.setText(savedText);
			this.ui.restoreFocus(this.editor);
			this.ui.requestRender();
		};

		return new Promise((resolve, reject) => {
			let component: Component & { dispose?(): void };
			let closed = false;

			const close = (result: T) => {
				if (closed) return;
				closed = true;
				if (isOverlay) this.ui.hideOverlay();
				else restoreEditor();
				// Note: both branches above already call requestRender
				resolve(result);
				try {
					component?.dispose?.();
				} catch {
					/* ignore dispose errors */
				}
			};

			Promise.resolve(factory(this.ui, theme, this.keybindings, close))
				.then((c) => {
					if (closed) return;
					component = c;
					if (isOverlay) {
						// Resolve overlay options - can be static or dynamic function
						const resolveOptions = (): OverlayOptions | undefined => {
							if (options?.overlayOptions) {
								const opts =
									typeof options.overlayOptions === "function"
										? options.overlayOptions()
										: options.overlayOptions;
								return opts;
							}
							// Fallback: use component's width property if available
							const w = (component as { width?: number }).width;
							return w ? { width: w } : undefined;
						};
						const handle = this.ui.showOverlay(component, resolveOptions());
						// Expose handle to caller for visibility control
						options?.onHandle?.(handle);
					} else {
						this.editorContainer.clear();
						this.editorContainer.addChild(component);
						this.ui.setFocus(component);
						this.ui.requestRender();
					}
				})
				.catch((err) => {
					if (closed) return;
					if (!isOverlay) restoreEditor();
					reject(err);
				});
		});
	}

	/**
	 * Show an extension error in the UI.
	 */
	private showExtensionError(extensionPath: string, error: string, stack?: string): void {
		const errorMsg = `Extension "${extensionPath}" error: ${error}`;
		const errorText = new Text(theme.fg("error", errorMsg), 1, 0);
		this.chatContainer.addChild(errorText);
		if (stack) {
			// Show stack trace in dim color, indented
			const stackLines = stack
				.split("\n")
				.slice(1) // Skip first line (duplicates error message)
				.map((line) => theme.fg("dim", `  ${line.trim()}`))
				.join("\n");
			if (stackLines) {
				this.chatContainer.addChild(new Text(stackLines, 1, 0));
			}
		}
		this.ui.requestRender();
	}

	// =========================================================================
	// Key Handlers
	// =========================================================================

	private setupKeyHandlers(): void {
		// Set up handlers on defaultEditor - they use this.editor for text access
		// so they work correctly regardless of which editor is active
		this.defaultEditor.onEscape = () => {
			if (this.session.isStreaming) {
				this.restoreQueuedMessagesToEditor({ abort: true });
			} else if (this.session.isBashRunning) {
				this.session.abortBash();
			} else if (this.isBashMode) {
				this.editor.setText("");
				this.isBashMode = false;
				this.updateEditorBorderColor();
			} else if (!this.editor.getText().trim()) {
				// Double-escape with empty editor triggers /tree, /fork, or nothing based on setting
				const action = this.settingsManager.getDoubleEscapeAction();
				if (action !== "none") {
					const now = Date.now();
					if (now - this.lastEscapeTime < 500) {
						if (action === "tree") {
							this.showTreeSelector();
						} else {
							this.showUserMessageSelector();
						}
						this.lastEscapeTime = 0;
					} else {
						this.lastEscapeTime = now;
					}
				}
			}
		};

		// Register app action handlers
		this.defaultEditor.onAction("app.clear", () => this.handleCtrlC());
		this.defaultEditor.onCtrlD = () => this.handleCtrlD();
		this.defaultEditor.onAction("app.suspend", () => this.handleCtrlZ());
		this.defaultEditor.onAction("app.thinking.cycle", () => this.cycleThinkingLevel());
		this.defaultEditor.onAction("app.model.cycleForward", () => this.cycleModel("forward"));
		this.defaultEditor.onAction("app.model.cycleBackward", () => this.cycleModel("backward"));

		// Global debug handler on TUI (works regardless of focus)
		this.ui.onDebug = () => this.handleDebugCommand();
		this.defaultEditor.onAction("app.model.select", () => void this.showModelSelector());
		this.defaultEditor.onAction("app.tools.expand", () => this.loadTuiHistoryOnDemand());
		this.defaultEditor.onAction("app.thinking.toggle", () => void this.toggleThinkingBlockVisibility());
		this.defaultEditor.onAction("app.editor.external", () => this.openExternalEditor());
		this.defaultEditor.onAction("app.message.followUp", () => this.handleFollowUp());
		this.defaultEditor.onAction("app.message.dequeue", () => this.handleDequeue());
		// Plain Up arrow on an empty editor recalls queued messages for editing
		// before history navigation. Many terminals (e.g. Windows Terminal) swallow
		// the alt-chord bindings, so the queue must be reachable without them.
		this.defaultEditor.onRecallQueued = () => this.restoreQueuedMessagesToEditor() > 0;
		this.defaultEditor.onAction("app.session.new", () => this.handleClearCommand());
		this.defaultEditor.onAction("app.session.tree", () => this.showTreeSelector());
		this.defaultEditor.onAction("app.session.fork", () => this.showUserMessageSelector());
		this.defaultEditor.onAction("app.session.resume", () => this.showSessionSelector());

		this.defaultEditor.onChange = (text: string) => {
			const wasBashMode = this.isBashMode;
			this.isBashMode = text.trimStart().startsWith("!");
			if (wasBashMode !== this.isBashMode) {
				this.updateEditorBorderColor();
			}
		};

		// Handle clipboard image paste (triggered on Ctrl+V)
		this.defaultEditor.onPasteImage = () => {
			this.handleClipboardImagePaste();
		};
	}

	private async handleClipboardImagePaste(): Promise<void> {
		try {
			const image = await readClipboardImage();
			if (!image) {
				return;
			}

			const label = this.nextClipboardImageLabel();
			const mimeType = image.mimeType.split(";")[0]?.trim().toLowerCase() || image.mimeType;
			this.pendingClipboardImages.push({
				label,
				content: {
					type: "image",
					data: Buffer.from(image.bytes).toString("base64"),
					mimeType,
				},
			});

			this.editor.insertTextAtCursor?.(`${label} `);
			this.showStatus(`Attached clipboard image ${label} (${mimeType})`);
			this.ui.requestRender();
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			this.showWarning(`Failed to paste image: ${message}`);
		}
	}

	private nextClipboardImageLabel(): string {
		if (this.pendingClipboardImages.length === 0) {
			this.clipboardImageCounter = 0;
		}
		this.clipboardImageCounter += 1;
		return `[Image #${this.clipboardImageCounter}]`;
	}

	private takeClipboardImagesForText(text: string): ImageContent[] | undefined {
		if (this.pendingClipboardImages.length === 0) {
			return undefined;
		}

		const images = this.pendingClipboardImages
			.filter((image) => text.includes(image.label))
			.map((image) => image.content);
		this.pendingClipboardImages = [];
		this.clipboardImageCounter = 0;
		return images.length > 0 ? images : undefined;
	}

	private buildUserInputSubmission(text: string): UserInputSubmission {
		const images = this.takeClipboardImagesForText(text);
		return images ? { text, images } : { text };
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
				await this.showOAuthSelector("login", text.slice("/login".length).trim() || undefined);
				this.editor.setText("");
				return;
			}
			if (text === "/logout" || text.startsWith("/logout ")) {
				await this.showOAuthSelector("logout", text.slice("/logout".length).trim() || undefined);
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
	private getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const textBlocks =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content.filter((c: { type: string }) => c.type === "text");
		return textBlocks.map((c) => (c as { text: string }).text).join("");
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

	private getContentText(content: unknown): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.map((part) => {
					const maybeText = (part as { text?: unknown }).text;
					return typeof maybeText === "string" ? maybeText : "";
				})
				.join("");
		}
		return "";
	}

	private getTuiHistoryMessageText(message: AgentMessage): string {
		switch (message.role) {
			case "bashExecution":
				return [message.command, message.output ?? ""].filter(Boolean).join("\n");
			case "user":
				return this.getUserMessageText(message);
			case "assistant":
				return this.getContentText(message.content);
			case "toolResult":
				return this.getContentText(message.content);
			case "custom":
				return this.getContentText(message.content);
			case "compactionSummary":
			case "branchSummary":
				return message.summary;
			default: {
				const _exhaustive: never = message;
				return JSON.stringify(_exhaustive);
			}
		}
	}

	private estimateTuiHistoryLines(message: AgentMessage): number {
		const text = this.getTuiHistoryMessageText(message);
		const hardLines = text.length > 0 ? text.split(/\r\n|\r|\n/).length : 1;
		const wrappedLines = Math.ceil(text.length / TUI_HISTORY_RELOAD_WRAP_WIDTH);
		// Add one line for role/tool chrome or spacing. Tool-call-only assistant messages
		// have little text but still render a component.
		return Math.max(1, hardLines, wrappedLines) + 1;
	}

	private trimTextToTuiHistoryTail(text: string, maxEstimatedLines: number): string {
		const maxLines = Math.max(1, maxEstimatedLines);
		const lines = text.split(/\r\n|\r|\n/);
		if (lines.length > maxLines) {
			const omitted = lines.length - maxLines;
			return `[Earlier ${omitted} line${omitted === 1 ? "" : "s"} omitted from TUI reload history; full session remains available to the model.]\n${lines.slice(-maxLines).join("\n")}`;
		}
		const maxChars = Math.max(TUI_HISTORY_RELOAD_WRAP_WIDTH, maxLines * TUI_HISTORY_RELOAD_WRAP_WIDTH);
		if (text.length > maxChars) {
			const omitted = text.length - maxChars;
			return `[Earlier ${omitted} character${omitted === 1 ? "" : "s"} omitted from TUI reload history; full session remains available to the model.]\n${text.slice(-maxChars)}`;
		}
		return text;
	}

	private trimMessageToTuiHistoryTail(message: AgentMessage, maxEstimatedLines: number): AgentMessage {
		const text = this.getTuiHistoryMessageText(message);
		const trimmedText = this.trimTextToTuiHistoryTail(text, maxEstimatedLines);
		if (trimmedText === text) return message;
		const clone = JSON.parse(JSON.stringify(message)) as AgentMessage;
		const mutable = clone as unknown as { role?: string; content?: unknown; output?: unknown };
		if (mutable.role === "bashExecution" && typeof mutable.output === "string") {
			mutable.output = trimmedText;
		} else if (mutable.role === "compactionSummary" || mutable.role === "branchSummary") {
			(mutable as { summary?: string }).summary = trimmedText;
		} else if (typeof mutable.content === "string") {
			mutable.content = trimmedText;
		} else {
			mutable.content = [{ type: "text", text: trimmedText }];
		}
		return clone;
	}

	private messagesForTuiHistoryReload(messages: AgentMessage[]): {
		messages: AgentMessage[];
		omittedMessages: number;
		estimatedLines: number;
	} {
		let estimatedLines = 0;
		let start = messages.length;
		for (let i = messages.length - 1; i >= 0; i--) {
			const nextLines = this.estimateTuiHistoryLines(messages[i]);
			if (start < messages.length && estimatedLines + nextLines > TUI_HISTORY_RELOAD_MAX_LINES) break;
			estimatedLines += nextLines;
			start = i;
			if (estimatedLines >= TUI_HISTORY_RELOAD_MAX_LINES) break;
		}
		const selected = messages.slice(start);
		if (selected.length > 0 && estimatedLines > TUI_HISTORY_RELOAD_MAX_LINES) {
			const tailLines = selected.slice(1).reduce((sum, message) => sum + this.estimateTuiHistoryLines(message), 0);
			const firstAllowance = TUI_HISTORY_RELOAD_MAX_LINES - tailLines;
			if (firstAllowance <= 4) {
				selected.shift();
				start += 1;
				estimatedLines = tailLines;
			} else {
				// Reserve room for truncation marker, role chrome, and wrap variance.
				selected[0] = this.trimMessageToTuiHistoryTail(selected[0], firstAllowance - 4);
				estimatedLines = tailLines + this.estimateTuiHistoryLines(selected[0]);
			}
		}
		return {
			messages: selected,
			omittedMessages: start,
			estimatedLines,
		};
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
					`Showing last ~${TUI_HISTORY_RELOAD_MAX_LINES} TUI history lines; omitted ${tuiHistory.omittedMessages} older message${tuiHistory.omittedMessages === 1 ? "" : "s"}. Full session remains available to the model.`,
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

	private async shutdown(options?: { fromSignal?: boolean }): Promise<void> {
		if (this.isShuttingDown) return;
		this.isShuttingDown = true;
		this.unregisterSignalHandlers();

		if (options?.fromSignal) {
			// Signal-triggered shutdown (SIGTERM/SIGHUP). Emit extension cleanup
			// (session_shutdown) BEFORE touching the terminal. Extension teardown
			// such as removing sockets does not write to the tty, so it must not be
			// skipped if a later terminal-restore write fails on a dead or stalled
			// terminal. If the terminal is gone, the restore writes below emit EIO,
			// which the stdout/stderr error handler turns into emergencyTerminalExit;
			// the render loop is already idle, so this cannot hot-spin (see #4144).
			await this.runtimeHost.dispose();
			await this.ui.terminal.drainInput(1000);
			this.stop();
			process.exit(0);
		}

		// Interactive quit (Ctrl+D, Ctrl+C, /quit, extension shutdown()). Stop the
		// TUI before emitting shutdown events so extension UI cleanup cannot repaint
		// the final frame while the process is exiting.
		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		await this.ui.terminal.drainInput(1000);

		this.stop();
		await this.runtimeHost.dispose();

		const resumeCommand = formatResumeCommand(this.sessionManager);
		if (resumeCommand) {
			process.stdout.write(`${chalk.dim("To resume this session:")} ${resumeCommand}\n`);
		}

		process.exit(0);
	}

	private emergencyTerminalExit(): never {
		this.isShuttingDown = true;
		this.unregisterSignalHandlers();
		killTrackedDetachedChildren();
		// The terminal is gone. Do not run normal shutdown because TUI and
		// extension cleanup can write restore sequences and re-trigger EIO.
		process.exit(129);
	}

	/**
	 * Last-resort handler for uncaught exceptions. The TUI puts stdin into raw
	 * mode and hides the cursor; without this handler, an uncaught throw from
	 * anywhere (e.g. an extension's async `ChildProcess.on("exit")` callback)
	 * tears down the process while leaving the terminal in raw mode with no
	 * cursor, requiring `stty sane && reset` to recover.
	 *
	 * Unlike emergencyTerminalExit, the terminal is still alive here, so we
	 * call ui.stop() to restore cooked mode, the cursor, and disable bracketed
	 * paste / Kitty / modifyOtherKeys sequences.
	 */
	private uncaughtCrash(error: Error): never {
		if (this.isShuttingDown) {
			process.exit(1);
		}
		this.isShuttingDown = true;
		try {
			this.unregisterSignalHandlers();
		} catch {}
		try {
			killTrackedDetachedChildren();
		} catch {}
		try {
			this.ui.stop();
		} catch {}
		console.error("pi exiting due to uncaughtException:");
		console.error(error);
		process.exit(1);
	}

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 */
	private async checkShutdownRequested(): Promise<void> {
		if (!this.shutdownRequested) return;
		await this.shutdown();
	}

	private registerSignalHandlers(): void {
		this.unregisterSignalHandlers();

		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				// SIGHUP no longer hard-exits: graceful shutdown emits session_shutdown
				// first, then attempts terminal restore. A genuinely dead terminal
				// surfaces as an EIO on the restore writes, which the stdout/stderr
				// error handler converts into emergencyTerminalExit (see #4144, #5080).
				killTrackedDetachedChildren();
				void this.shutdown({ fromSignal: true });
			};
			process.prependListener(signal, handler);
			this.signalCleanupHandlers.push(() => process.off(signal, handler));
		}

		const terminalErrorHandler = (error: Error) => {
			if (isDeadTerminalError(error)) {
				this.emergencyTerminalExit();
			}
			throw error;
		};
		process.stdout.on("error", terminalErrorHandler);
		process.stderr.on("error", terminalErrorHandler);
		this.signalCleanupHandlers.push(() => process.stdout.off("error", terminalErrorHandler));
		this.signalCleanupHandlers.push(() => process.stderr.off("error", terminalErrorHandler));

		// Restore the terminal before the process dies on any uncaught throw.
		// Without this, an unhandled exception from extension code (or anywhere
		// in pi) leaves the terminal in raw mode with no cursor.
		const uncaughtExceptionHandler = (error: Error) => this.uncaughtCrash(error);
		process.prependListener("uncaughtException", uncaughtExceptionHandler);
		this.signalCleanupHandlers.push(() => process.off("uncaughtException", uncaughtExceptionHandler));
	}

	private unregisterSignalHandlers(): void {
		for (const cleanup of this.signalCleanupHandlers) {
			cleanup();
		}
		this.signalCleanupHandlers = [];
	}

	private handleCtrlZ(): void {
		if (process.platform === "win32") {
			this.showStatus("Suspend to background is not supported on Windows");
			return;
		}

		// Keep the event loop alive while suspended. Without this, stopping the TUI
		// can leave Node with no ref'ed handles, causing the process to exit on fg
		// before the SIGCONT handler gets a chance to restore the terminal.
		const suspendKeepAlive = setInterval(() => {}, 2 ** 30);

		// Ignore SIGINT while suspended so Ctrl+C in the terminal does not
		// kill the backgrounded process. The handler is removed on resume.
		const ignoreSigint = () => {};
		process.on("SIGINT", ignoreSigint);

		// Set up handler to restore TUI when resumed
		process.once("SIGCONT", () => {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			this.ui.start();
			this.ui.requestRender(true);
		});

		try {
			// Stop the TUI (restore terminal to normal mode)
			this.ui.stop();

			// Send SIGTSTP to process group (pid=0 means all processes in group)
			process.kill(0, "SIGTSTP");
		} catch (error) {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			throw error;
		}
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
		const activeHeader = this.customHeader ?? this.builtInHeader;
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

	private async openExternalEditor(): Promise<void> {
		// Determine editor (respect $VISUAL, then $EDITOR)
		const editorCmd = process.env.VISUAL || process.env.EDITOR;
		if (!editorCmd) {
			this.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		const currentText = this.editor.getExpandedText?.() ?? this.editor.getText();
		const tmpFile = path.join(os.tmpdir(), `pi-editor-${Date.now()}.pi.md`);

		try {
			// Write current content to temp file
			fs.writeFileSync(tmpFile, currentText, "utf-8");

			// Stop TUI to release terminal
			this.ui.stop();

			// Split by space to support editor arguments (e.g., "code --wait")
			const [editor, ...editorArgs] = editorCmd.split(" ");

			process.stdout.write(`Launching external editor: ${editorCmd}\nPi will resume when the editor exits.\n`);

			// Do not use spawnSync here. On Windows, synchronous child_process calls can keep
			// Node/libuv's console input read active after ui.stop() pauses stdin, racing
			// vim/nvim for the console input buffer until Ctrl+C cancels the pending read.
			const status = await new Promise<number | null>((resolve) => {
				const child = spawn(editor, [...editorArgs, tmpFile], {
					stdio: "inherit",
					shell: process.platform === "win32",
				});
				child.on("error", () => resolve(null));
				child.on("close", (code) => resolve(code));
			});

			// On successful exit (status 0), replace editor content
			if (status === 0) {
				const newContent = fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
				this.editor.setText(newContent);
			}
			// On non-zero exit, keep original text (no action needed)
		} finally {
			// Clean up temp file
			try {
				fs.unlinkSync(tmpFile);
			} catch {
				// Ignore cleanup errors
			}

			// Restart TUI
			this.ui.start();
			// Force full re-render since external editor uses alternate screen
			this.ui.requestRender(true);
		}
	}

	private async openEditorForPath(filePath: string): Promise<boolean> {
		let editorCmd = process.env.EDITOR || process.env.VISUAL;
		let isFallback = false;
		if (!editorCmd) {
			editorCmd = "vi";
			isFallback = true;
		}

		try {
			// Stop TUI to release terminal
			this.ui.stop();

			// Split by space to support editor arguments (e.g., "code --wait")
			const [editor, ...editorArgs] = editorCmd.split(" ");

			process.stdout.write(
				`Launching external editor: ${editorCmd} ${filePath}\nPi will resume when the editor exits.\n`,
			);

			const status = await new Promise<number | null>((resolve) => {
				const child = spawn(editor, [...editorArgs, filePath], {
					stdio: "inherit",
					shell: process.platform === "win32",
				});
				child.on("error", () => resolve(null));
				child.on("close", (code) => resolve(code));
			});

			if (status === null) {
				if (isFallback) {
					process.stdout.write(`\nError: Failed to launch fallback editor "vi".\n`);
				} else {
					process.stdout.write(`\nError: Failed to launch editor "${editorCmd}".\n`);
				}
				process.stdout.write(`Please set the $EDITOR or $VISUAL environment variable to edit inline.\n`);
				process.stdout.write(`Absolute file path: ${filePath}\n\nPress Enter to return to Pi...`);
				// Wait for enter key
				await new Promise<void>((resolve) => {
					process.stdin.once("data", () => resolve());
				});
			}

			return status === 0;
		} finally {
			// Restart TUI
			this.ui.start();
			// Force full re-render since external editor uses alternate screen
			this.ui.requestRender(true);
		}
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
		const action = theme.fg("accent", `${APP_NAME} update`);
		const updateInstruction = theme.fg("muted", `New version ${release.version} is available. Run `) + action;
		const changelogUrl = "https://pi.dev/changelog";
		const changelogLink = getCapabilities().hyperlinks
			? hyperlink(theme.fg("accent", "open changelog"), changelogUrl)
			: theme.fg("accent", changelogUrl);
		const changelogLine = theme.fg("muted", "Changelog: ") + changelogLink;
		const note = release.note?.trim();

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.chatContainer.addChild(
			new Text(`${theme.bold(theme.fg("warning", "Update Available"))}\n${updateInstruction}`, 1, 0),
		);
		if (note) {
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Markdown(note, 1, 0, this.getMarkdownThemeWithSettings(), {
					color: (text) => theme.fg("muted", text),
				}),
			);
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(new Text(changelogLine, 1, 0));
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.ui.requestRender();
	}

	showPackageUpdateNotification(packages: string[]): void {
		const action = theme.fg("accent", `${APP_NAME} update`);
		const updateInstruction = theme.fg("muted", "Package updates are available. Run ") + action;
		const packageLines = packages.map((pkg) => `- ${pkg}`).join("\n");

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.chatContainer.addChild(
			new Text(
				`${theme.bold(theme.fg("warning", "Package Updates Available"))}\n${updateInstruction}\n${theme.fg("muted", "Packages:")}\n${packageLines}`,
				1,
				0,
			),
		);
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.ui.requestRender();
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

	private async flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		if (this.compactionQueuedMessages.length === 0) {
			return;
		}

		const queuedMessages = [...this.compactionQueuedMessages];
		this.compactionQueuedMessages = [];
		this.updatePendingMessagesDisplay();

		const restoreQueue = (error: unknown) => {
			this.session.clearQueue();
			this.compactionQueuedMessages = queuedMessages;
			this.updatePendingMessagesDisplay();
			this.showError(
				`Failed to send queued message${queuedMessages.length > 1 ? "s" : ""}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		};

		try {
			if (options?.willRetry) {
				// When retry is pending, queue messages for the retry turn
				for (const message of queuedMessages) {
					if (this.isExtensionCommand(message.text)) {
						await this.session.prompt(message.text);
					} else if (message.mode === "followUp") {
						await this.session.followUp(message.text, message.images);
					} else {
						await this.session.steer(message.text, message.images);
					}
				}
				this.updatePendingMessagesDisplay();
				return;
			}

			// Find first non-extension-command message to use as prompt
			const firstPromptIndex = queuedMessages.findIndex((message) => !this.isExtensionCommand(message.text));
			if (firstPromptIndex === -1) {
				// All extension commands - execute them all
				for (const message of queuedMessages) {
					await this.session.prompt(message.text);
				}
				return;
			}

			// Execute any extension commands before the first prompt
			const preCommands = queuedMessages.slice(0, firstPromptIndex);
			const firstPrompt = queuedMessages[firstPromptIndex];
			const rest = queuedMessages.slice(firstPromptIndex + 1);

			for (const message of preCommands) {
				await this.session.prompt(message.text);
			}

			// Send first prompt (starts streaming). Auto-compaction can finish while the
			// agent is still processing; in that case, queue the message with the same
			// steering/follow-up mode instead of surfacing an internal streamingBehavior error.
			const promptOptions = this.session.isStreaming
				? { images: firstPrompt.images, streamingBehavior: firstPrompt.mode }
				: { images: firstPrompt.images };
			const promptPromise = this.session
				.prompt(firstPrompt.text, promptOptions)
				.catch((error) => {
					restoreQueue(error);
				})
				.finally(() => {
					this.refreshAutonomyFooterStatus();
				});

			// Queue remaining messages
			for (const message of rest) {
				if (this.isExtensionCommand(message.text)) {
					await this.session.prompt(message.text);
				} else if (message.mode === "followUp") {
					await this.session.followUp(message.text, message.images);
				} else {
					await this.session.steer(message.text, message.images);
				}
			}
			this.updatePendingMessagesDisplay();
			void promptPromise;
		} catch (error) {
			restoreQueue(error);
		}
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
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.restoreFocus(this.editor);
		};
		const { component, focus } = create(done);
		this.editorContainer.clear();
		this.editorContainer.addChild(component);
		this.ui.setFocus(focus);
		this.ui.requestRender();
	}

	private getAutoLearnModelAuthPriority(model: Model<any>): number {
		if (this.session.model && model.provider === this.session.model.provider && model.id === this.session.model.id) {
			return 0;
		}

		const credential = this.session.modelRegistry.authStorage.get(model.provider);
		if (credential?.type === "oauth") return 1;
		if (credential?.type === "api_key") return 2;

		const authStatus = this.session.modelRegistry.getProviderAuthStatus(model.provider);
		switch (authStatus.source) {
			case "runtime":
				return 3;
			case "environment":
				return 4;
			case "models_json_key":
			case "models_json_command":
			case "fallback":
				return 5;
			default:
				return 6;
		}
	}

	private getAutoLearnModelAuthLabel(model: Model<any>): string {
		const credential = this.session.modelRegistry.authStorage.get(model.provider);
		if (credential?.type === "oauth") return "subscription";
		if (credential?.type === "api_key") return "API key";

		const authStatus = this.session.modelRegistry.getProviderAuthStatus(model.provider);
		switch (authStatus.source) {
			case "runtime":
				return authStatus.label ? `runtime ${authStatus.label}` : "runtime API key";
			case "environment":
				return authStatus.label ? `env ${authStatus.label}` : "environment API key";
			case "models_json_key":
				return "models.json API key";
			case "models_json_command":
				return "models.json command";
			case "fallback":
				return authStatus.label ?? "custom provider config";
			default:
				return "configured";
		}
	}

	private getAutoLearnModelOptions(): SelectItem[] {
		this.session.modelRegistry.refresh();
		const availableModels = this.session.modelRegistry.getAvailable();
		const sortedModels = [...availableModels].sort((a, b) => {
			const priorityDelta = this.getAutoLearnModelAuthPriority(a) - this.getAutoLearnModelAuthPriority(b);
			if (priorityDelta !== 0) return priorityDelta;
			const providerDelta = this.session.modelRegistry
				.getProviderDisplayName(a.provider)
				.localeCompare(this.session.modelRegistry.getProviderDisplayName(b.provider));
			if (providerDelta !== 0) return providerDelta;
			return a.id.localeCompare(b.id);
		});

		return sortedModels.map((model) => {
			const providerName = this.session.modelRegistry.getProviderDisplayName(model.provider);
			const authLabel = this.getAutoLearnModelAuthLabel(model);
			const modelPattern = `${model.provider}/${model.id}`;
			const currentLabel =
				this.session.model && model.provider === this.session.model.provider && model.id === this.session.model.id
					? " · current"
					: "";
			const displayName = model.name && model.name !== model.id ? ` · ${model.name}` : "";
			return {
				value: modelPattern,
				label: modelPattern,
				description: `${providerName} · ${authLabel}${currentLabel}${displayName}`,
			};
		});
	}

	private getAutoLearnDataDir(): string {
		return path.join(getAgentDir(), "auto-learn");
	}

	private getAutoLearnStatePath(): string {
		return path.join(this.getAutoLearnDataDir(), "state.json");
	}

	private ensureAutoLearnStateFile(): void {
		const dir = this.getAutoLearnDataDir();
		fs.mkdirSync(dir, { recursive: true });
		const statePath = this.getAutoLearnStatePath();
		if (!fs.existsSync(statePath)) {
			fs.writeFileSync(statePath, "{}\n", "utf-8");
		}
	}

	private readAutoLearnState(): AutoLearnState {
		try {
			const statePath = this.getAutoLearnStatePath();
			if (!fs.existsSync(statePath)) return {};
			return JSON.parse(fs.readFileSync(statePath, "utf-8")) as AutoLearnState;
		} catch {
			return {};
		}
	}

	private writeAutoLearnState(state: AutoLearnState): void {
		const dir = this.getAutoLearnDataDir();
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(this.getAutoLearnStatePath(), `${JSON.stringify(state, null, 2)}\n`, "utf-8");
	}

	private acquireAutoLearnStateLock(): () => void {
		this.ensureAutoLearnStateFile();
		const statePath = this.getAutoLearnStatePath();
		const maxAttempts = 20;
		const delayMs = 25;
		let lastError: unknown;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(statePath, { realpath: false, stale: 30000 });
			} catch (error: unknown) {
				const code =
					error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Synchronous callers need a synchronous lock retry loop.
				}
			}
		}
		throw lastError instanceof Error ? lastError : new Error("Failed to acquire Auto Learn state lock");
	}

	private withAutoLearnStateLock<T>(fn: (state: AutoLearnState) => AutoLearnStateLockResult<T>): T {
		let release: (() => void) | undefined;
		try {
			release = this.acquireAutoLearnStateLock();
			const { result, next } = fn(this.readAutoLearnState());
			if (next !== undefined) {
				this.writeAutoLearnState(next);
			}
			return result;
		} finally {
			release?.();
		}
	}

	private appendAutoLearnLog(logPath: string, message: string): void {
		try {
			fs.appendFileSync(logPath, `${message}\n`, "utf-8");
		} catch {
			// Logging must never turn a background learner startup failure into an interactive crash.
		}
	}

	private isAutoLearnPidAlive(pid: number | undefined): boolean {
		if (typeof pid !== "number" || pid <= 0) return false;
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			const code =
				error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
			return code === "EPERM";
		}
	}

	private pruneAutoLearnState(state: AutoLearnState, now = Date.now()): AutoLearnState {
		const runs = { ...(state.runs ?? {}) };
		for (const [id, run] of Object.entries(runs)) {
			if (run.expiresAt <= now) {
				delete runs[id];
				continue;
			}
			if (run.status === "reserved" && run.pid === undefined) {
				continue;
			}
			if (!this.isAutoLearnPidAlive(run.pid)) {
				delete runs[id];
			}
		}
		return { ...state, runs };
	}

	private pruneAutoLearnHistoryFromState(state: AutoLearnState, now = Date.now()): AutoLearnState {
		const prunedState = this.pruneAutoLearnState(state, now);
		pruneAutoLearnConversationHistory({
			dataDir: this.getAutoLearnDataDir(),
			now,
			activeRunIds: Object.keys(prunedState.runs ?? {}),
			activeSessionIds: Object.values(prunedState.runs ?? {}).map((run) => run.sessionId),
		});
		return prunedState;
	}

	private getPrunedAutoLearnState(): AutoLearnState {
		return this.withAutoLearnStateLock((current) => {
			const state = this.pruneAutoLearnHistoryFromState(current);
			return { result: state, next: state };
		});
	}

	private getAutoLearnPresetForAutonomyMode(
		mode: AutonomyMode,
		current: AutoLearnSettings = {},
	): Required<AutoLearnSettings> {
		const preset = AUTONOMY_AUTO_LEARN_PRESETS[mode] ?? AUTONOMY_AUTO_LEARN_PRESETS.off;
		return { ...preset, model: current.model?.trim() || preset.model };
	}

	private getEffectiveAutoLearnSettings(): Required<AutoLearnSettings> {
		const settings = this.settingsManager.getAutoLearnSettings();
		const preset = this.getAutoLearnPresetForAutonomyMode(this.settingsManager.getAutonomySettings().mode, settings);
		return {
			enabled: settings.enabled ?? preset.enabled,
			model: settings.model?.trim() || preset.model,
			longSessionMessages: settings.longSessionMessages ?? preset.longSessionMessages,
			longSessionContextPercent: settings.longSessionContextPercent ?? preset.longSessionContextPercent,
			cooldownMinutes: settings.cooldownMinutes ?? preset.cooldownMinutes,
			leaseMinutes: settings.leaseMinutes ?? preset.leaseMinutes,
			maxConcurrentLearners: settings.maxConcurrentLearners ?? preset.maxConcurrentLearners,
			applyHighConfidence: settings.applyHighConfidence ?? preset.applyHighConfidence,
			reflectionReview: settings.reflectionReview ?? preset.reflectionReview,
			reflectionMinToolCalls: settings.reflectionMinToolCalls ?? preset.reflectionMinToolCalls,
			reflectionCooldownMinutes: settings.reflectionCooldownMinutes ?? preset.reflectionCooldownMinutes,
			complexTaskToolCalls: settings.complexTaskToolCalls ?? preset.complexTaskToolCalls,
			thinkingLevel: settings.thinkingLevel ?? preset.thinkingLevel,
		};
	}

	private getCurrentAutoLearnSettings(): Required<AutoLearnSettings> {
		return this.getEffectiveAutoLearnSettings();
	}

	private getAutoLearnTenantKey(): string {
		return `${this.sessionManager.getCwd()}::${this.session.sessionId}`;
	}

	private getAutoLearnTenantId(): string {
		const cwdHash = crypto.createHash("sha256").update(this.sessionManager.getCwd()).digest("hex").slice(0, 8);
		const sessionPart = sanitizeAutoLearnPathPart(this.session.sessionId, "session");
		return `${sessionPart}-${cwdHash}`;
	}

	private getAutoLearnTenantDataDir(): string {
		return path.join(this.getAutoLearnDataDir(), "tenants", this.getAutoLearnTenantId());
	}

	private getAutoLearnMessageCount(): number {
		return this.sessionManager.getBranch().filter((entry) => entry.type === "message").length;
	}

	private buildAutoLearnDecisionFromState(
		state: AutoLearnState,
		settings: Required<AutoLearnSettings>,
		force = false,
	): AutoLearnDecision {
		const now = Date.now();
		const tenant = this.getAutoLearnTenantKey();
		const runningCount = Object.values(state.runs ?? {}).filter((run) => run.tenant === tenant).length;
		const lastLaunch = state.lastLaunchByTenant?.[tenant] ?? 0;
		const cooldownMs = settings.cooldownMinutes * 60 * 1000;
		const cooldownRemainingMs = Math.max(0, lastLaunch + cooldownMs - now);
		const messageCount = this.getAutoLearnMessageCount();
		const contextPercent = this.session.getContextUsage()?.percent ?? null;

		if (!settings.enabled && !force) {
			return {
				shouldRun: false,
				reason: "disabled",
				messageCount,
				contextPercent,
				cooldownRemainingMs,
				runningCount,
			};
		}
		if (runningCount >= settings.maxConcurrentLearners) {
			return {
				shouldRun: false,
				reason: `max tenant learners running (${runningCount}/${settings.maxConcurrentLearners})`,
				messageCount,
				contextPercent,
				cooldownRemainingMs,
				runningCount,
			};
		}
		if (!force && cooldownRemainingMs > 0) {
			return {
				shouldRun: false,
				reason: "cooldown",
				messageCount,
				contextPercent,
				cooldownRemainingMs,
				runningCount,
			};
		}
		if (force) {
			return { shouldRun: true, reason: "manual", messageCount, contextPercent, cooldownRemainingMs, runningCount };
		}
		if (messageCount >= settings.longSessionMessages) {
			return {
				shouldRun: true,
				reason: `message trigger (${messageCount}/${settings.longSessionMessages})`,
				messageCount,
				contextPercent,
				cooldownRemainingMs,
				runningCount,
			};
		}
		if (contextPercent !== null && contextPercent >= settings.longSessionContextPercent) {
			return {
				shouldRun: true,
				reason: `context trigger (${contextPercent.toFixed(1)}%/${settings.longSessionContextPercent}%)`,
				messageCount,
				contextPercent,
				cooldownRemainingMs,
				runningCount,
			};
		}
		return {
			shouldRun: false,
			reason: "thresholds not met",
			messageCount,
			contextPercent,
			cooldownRemainingMs,
			runningCount,
		};
	}

	private resolveAutoLearnModelPattern(settings: Required<AutoLearnSettings>): string | undefined {
		if (settings.model === "active") {
			return this.session.model ? `${this.session.model.provider}/${this.session.model.id}` : undefined;
		}
		return settings.model;
	}

	private getAutoLearnSpawnTarget(): AutoLearnSpawnTarget | undefined {
		const overridePath = process.env.PI_AUTO_LEARN_CLI_PATH?.trim();
		if (overridePath) {
			return { command: overridePath, argsPrefix: [] };
		}

		const execBase = path.basename(process.execPath).toLowerCase();
		const isScriptRuntime =
			execBase === "node" || execBase === "node.exe" || execBase === "bun" || execBase === "bun.exe";
		if (!isScriptRuntime) {
			return { command: process.execPath, argsPrefix: [] };
		}

		const cliPath = process.argv[1];
		if (!cliPath || cliPath.startsWith("-")) {
			return undefined;
		}
		return { command: process.execPath, argsPrefix: [cliPath] };
	}

	private validateAutoLearnModelValue(value: string | undefined): string | undefined {
		const modelValue = value?.trim();
		if (!modelValue || modelValue === "active") return undefined;
		const available = this.session.modelRegistry.getAvailable();
		if (modelValue.includes("/")) {
			const [provider, modelId] = modelValue.split("/", 2);
			if (available.some((model) => model.provider === provider && model.id === modelId)) return undefined;
			return `Auto Learn model "${modelValue}" is not in configured subscription/API models; saved as manual/unverified.`;
		}
		if (available.some((model) => model.id === modelValue)) return undefined;
		return `Auto Learn model "${modelValue}" is not in configured subscription/API models; saved as manual/unverified.`;
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

	private evaluateAutoLearn(force = false): AutoLearnDecision {
		const settings = this.getEffectiveAutoLearnSettings();
		return this.withAutoLearnStateLock((current) => {
			const state = this.pruneAutoLearnHistoryFromState(current);
			return { result: this.buildAutoLearnDecisionFromState(state, settings, force), next: state };
		});
	}

	private buildAutonomyAuthorityPrompt(): string {
		const autonomy = this.settingsManager.getAutonomySettings();
		const selfModification = this.settingsManager.getSelfModificationSettings();
		if (autonomy.mode !== "full") {
			return [
				"Authority mode: proposal-gated.",
				"- You may autonomously query memory and run bounded learning tools.",
				"- Durable memory writes require the configured high-confidence policy; skills, extensions, source, settings, publishing, tagging, and releases remain proposals unless the foreground user explicitly asks.",
			].join("\n");
		}

		const selfModificationSource = selfModification.enabled
			? this.resolveSelfModificationSource(selfModification)
			: undefined;
		const sourceAuthority =
			selfModification.enabled && selfModificationSource
				? `- Pi source: standing authority to edit the authorized selfModification source (${selfModificationSource}) for self-evolution improvements; inspect git status first, preserve unrelated user changes, run focused validation, and leave a clear rollback/test summary.`
				: "- Pi source: no standing source-edit authority until selfModification.enabled and selfModification.sourcePaths are set.";
		return [
			"Authority mode: FULL AUTONOMOUS standing grant.",
			"- Memory: may apply high-confidence durable Automata memory/corrections after duplicate and corroboration checks.",
			"- Skills: may create or patch user/project-owned procedural skills and support files; prefer updating existing umbrella skills; do not delete skills without making a recoverable archive/backup.",
			"- User/project extensions and tools: may create or patch small scoped extensions/tools under Pi user/project roots when they address repeated workflow/tooling gaps; validate and keep changes auditable.",
			"- Settings: may auto-tune autonomy/autoLearn settings to reduce bottlenecks; do not modify credentials, provider auth, package sources, or unrelated user preferences.",
			sourceAuthority,
			"- Hard stops without explicit foreground approval: publish, npm release, git push, tag creation, credential changes, destructive user-data deletion, network-exposed services, or authority expansion beyond this policy.",
			"- Audit: final output must list changed paths/settings, commands/tests run, evidence, residual risks, and rollback guidance. If no safe validation is possible, leave the change as a proposal instead of applying it.",
		].join("\n");
	}

	private buildAutoLearnPrompt(
		reason: string,
		settings: Required<AutoLearnSettings>,
		options: { kind?: "auto" | "reflection"; turnDigest?: string } = {},
	): string {
		const authorityBlock = this.buildAutonomyAuthorityPrompt();
		const reflectionBlock =
			options.kind === "reflection" && options.turnDigest
				? `\n\nLatest completed turn digest (bounded; use only as current-session evidence, not as longitudinal proof):\n<turn_digest>\n${options.turnDigest}\n</turn_digest>`
				: "";
		const objective =
			options.kind === "reflection"
				? "review the latest completed turn for durable memory, skill, validation, tooling, and code-baked self-improvement cues, then run one bounded continuous-learning pass if the learning tools are available"
				: "run one bounded continuous-learning pass for this Pi tenant";
		return `You are Pi Auto Learn running as a background learner.\n\nObjective: ${objective}.\nTrigger: ${reason}.\n\n${authorityBlock}\n\nRequired workflow:\n1. Query existing durable memory/rules first when tools allow it. Memory confrontation is mandatory before accepting, merging, upgrading, or rejecting learning candidates.\n2. Run the available Auto Learn tooling, preferably learning_run_auto, with applyHighConfidence=${settings.applyHighConfidence}. Process candidate validation in vectorized chunks/batches; avoid scalar per-candidate memory queries except for final selected writes.\n3. Apply the learning validation tree to each candidate chunk: (a) Why is this good for the user? (b) Is it unique, or similar to existing memory/skills/agents so it should merge or upgrade existing knowledge? (c) Will this make Pi a better agent? Candidates that cannot answer all three are noise.\n4. Hermes-style learning cycle: after a complex task (${settings.complexTaskToolCalls}+ tool calls), user correction, repeated steering pattern, non-trivial fix/workaround/debugging path, loaded-skill defect, trigger gap, tool gap, or harness workflow defect, actively create or update durable learning artifacts. Memory stores compact facts/preferences/state; skills/prompts/agents/extensions/source store procedural behavior. When a lesson changes how Pi should act on a future class of task, memory alone is not completion.\n5. Skill update preference order: (1) patch the currently loaded or consulted skill that governed the task; (2) patch an existing class-level umbrella skill/agent/prompt; (3) add a support file under references/, templates/, or scripts/ and add a SKILL.md pointer; (4) create a new class-level umbrella skill only when no existing artifact fits. Never create one-off PR/error/codename/session skills.\n6. Behavioral self-improvement is code-baked by default: prefer the lowest durable executable layer that fixes the behavior — patch an existing skill/prompt/agent/extension/tool, tune an approved setting, or edit the authorized Pi source when source authority is available. Use Automata only for concise facts/evidence pointers that support the baked change.\n7. Do not harden transient or environment-dependent failures into durable behavior: missing binaries, fresh-install package gaps, credentials not configured, path mismatches, one-off task narratives, or negative tool-broken claims should become setup/troubleshooting fixes only when the fix itself is reusable.\n8. Treat the latest-turn digest as current-session evidence only; do not auto-commit one-off cues unless deterministic tooling and memory confrontation corroborate them.\n9. In mode=full, apply safe memory/skill/user-extension/authorized-source improvements under the standing grant above; otherwise keep them proposal-gated.\n10. Never cross hard-stop boundaries from the authority policy.\n11. If the learning tools are unavailable, report BLOCKED with the missing tool names and do not improvise.\n12. Finish with PASS, BLOCKED, or FAIL and concise evidence, including chunk counts, merge/upgrade/code-bake decisions, changed paths/settings, validation, and cleanup/purge status.${reflectionBlock}`;
	}

	private reserveAutoLearnRun(params: {
		settings: Required<AutoLearnSettings>;
		force: boolean;
		cooldownKind?: "auto" | "reflection";
		bypassReflectionCooldown?: boolean;
		runId: string;
		modelPattern: string;
		reason: string;
		logPath: string;
		sessionDir: string;
		sessionId: string;
		promptPath: string;
		kind: "auto" | "reflection";
	}): AutoLearnReservationResult {
		return this.withAutoLearnStateLock<AutoLearnReservationResult>((current) => {
			const now = Date.now();
			const state = this.pruneAutoLearnHistoryFromState(current, now);
			const tenant = this.getAutoLearnTenantKey();

			if (params.cooldownKind === "reflection" && !params.bypassReflectionCooldown) {
				const lastReflection = state.lastReflectionByTenant?.[tenant] ?? 0;
				const cooldownMs = params.settings.reflectionCooldownMinutes * 60 * 1000;
				if (Math.max(0, lastReflection + cooldownMs - now) > 0) {
					return { result: { ok: false, reason: "reflection cooldown" }, next: state };
				}
			}

			const decision = this.buildAutoLearnDecisionFromState(state, params.settings, params.force);
			if (!decision.shouldRun) {
				return { result: { ok: false, reason: decision.reason }, next: state };
			}

			const run: AutoLearnRunRecord = {
				tenant,
				model: params.modelPattern,
				reason: params.reason,
				startedAt: now,
				expiresAt: now + AUTO_LEARN_RESERVATION_MS,
				cwd: this.sessionManager.getCwd(),
				logPath: params.logPath,
				sessionDir: params.sessionDir,
				sessionId: params.sessionId,
				promptPath: params.promptPath,
				kind: params.kind,
				autonomyMode: this.settingsManager.getAutonomySettings().mode,
				authority:
					this.settingsManager.getAutonomySettings().mode === "full"
						? "standing-full-autonomous"
						: "proposal-gated",
				status: "reserved",
			};
			const next: AutoLearnState = {
				...state,
				runs: { ...(state.runs ?? {}), [params.runId]: run },
			};
			if (params.cooldownKind === "reflection") {
				next.lastReflectionByTenant = { ...(state.lastReflectionByTenant ?? {}), [tenant]: now };
			} else {
				next.lastLaunchByTenant = { ...(state.lastLaunchByTenant ?? {}), [tenant]: now };
			}
			return { result: { ok: true, reservation: { runId: params.runId, startedAt: now } }, next };
		});
	}

	private releaseAutoLearnReservation(reservation: AutoLearnReservation, cooldownKind?: "auto" | "reflection"): void {
		this.withAutoLearnStateLock((current) => {
			const state = this.pruneAutoLearnHistoryFromState(current);
			const tenant = this.getAutoLearnTenantKey();
			const runs = { ...(state.runs ?? {}) };
			delete runs[reservation.runId];
			const next: AutoLearnState = { ...state, runs };
			if (cooldownKind === "reflection" && next.lastReflectionByTenant?.[tenant] === reservation.startedAt) {
				next.lastReflectionByTenant = { ...next.lastReflectionByTenant };
				delete next.lastReflectionByTenant[tenant];
			} else if (cooldownKind !== "reflection" && next.lastLaunchByTenant?.[tenant] === reservation.startedAt) {
				next.lastLaunchByTenant = { ...next.lastLaunchByTenant };
				delete next.lastLaunchByTenant[tenant];
			}
			return { result: undefined, next };
		});
	}

	private reportCompletedAutoLearnUsage(runId: string, sessionDir: string, sessionId: string, logPath: string): void {
		try {
			reportCompletedAutoLearnUsageHelper({
				runId,
				sessionDir,
				sessionId,
				logPath,
				parentSession: this.session,
				appendLog: (p, msg) => this.appendAutoLearnLog(p, msg),
			});
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			this.appendAutoLearnLog(logPath, `Auto Learn usage report failed: ${message}`);
		}
	}

	private cleanupCompletedAutoLearnRun(
		runId: string,
		options: {
			artifactPaths: string[];
			sessionDir: string;
			sessionId: string;
			logPath: string;
		},
	): void {
		this.reportCompletedAutoLearnUsage(runId, options.sessionDir, options.sessionId, options.logPath);
		const dataDir = this.getAutoLearnDataDir();
		for (const filePath of options.artifactPaths) removeAutoLearnArtifactPath(filePath, dataDir);
		this.withAutoLearnStateLock((current) => {
			const state = this.pruneAutoLearnState(current);
			const runs = { ...(state.runs ?? {}) };
			delete runs[runId];
			return { result: undefined, next: { ...state, runs } };
		});
		this.updateAutoLearnFooter();
	}

	private markAutoLearnReservationRunning(
		reservation: AutoLearnReservation,
		pid: number,
		settings: Required<AutoLearnSettings>,
	): void {
		this.withAutoLearnStateLock((current) => {
			const now = Date.now();
			const state = this.pruneAutoLearnHistoryFromState(current, now);
			const run = state.runs?.[reservation.runId];
			if (!run) {
				return { result: undefined, next: state };
			}
			return {
				result: undefined,
				next: {
					...state,
					runs: {
						...(state.runs ?? {}),
						[reservation.runId]: {
							...run,
							pid,
							expiresAt: now + settings.leaseMinutes * 60 * 1000,
							status: "running",
						},
					},
				},
			};
		});
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
		const settings = this.getEffectiveAutoLearnSettings();
		const modelPattern = this.resolveAutoLearnModelPattern(settings);
		if (!modelPattern) {
			return "Auto Learn not started: no active model is available for model=active.";
		}
		const spawnTarget = this.getAutoLearnSpawnTarget();
		if (!spawnTarget) {
			return "Auto Learn not started: could not resolve current pi CLI path.";
		}

		const dir = this.getAutoLearnTenantDataDir();
		fs.mkdirSync(dir, { recursive: true });
		const runId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
		const logPath = path.join(dir, `${runId}.log`);
		const promptPath = path.join(dir, `${runId}.prompt.md`);
		const kind = options.promptKind ?? "auto";
		const sessionDir = path.join(dir, "sessions", runId);
		const sessionId = `auto-learn-${kind}-${this.getAutoLearnTenantId()}-${runId}`;
		fs.mkdirSync(sessionDir, { recursive: true });
		const prompt = this.buildAutoLearnPrompt(reason, settings, {
			kind,
			turnDigest: options.turnDigest,
		});
		const args = buildAutoLearnSpawnArgs(spawnTarget, {
			name: `Auto Learn ${runId}`,
			modelPattern,
			thinkingLevel: settings.thinkingLevel ?? "low",
			sessionDir,
			sessionId,
			promptPath,
		});
		const invalidSpawnInput = findAutoLearnSpawnNullByteInput(spawnTarget.command, args);
		if (invalidSpawnInput) {
			const message = `Auto Learn not started: ${invalidSpawnInput} contains a null byte.`;
			this.appendAutoLearnLog(logPath, message);
			this.updateAutoLearnFooter();
			return `${message} Log: ${logPath}`;
		}

		const reservationResult = this.reserveAutoLearnRun({
			settings,
			force,
			cooldownKind: options.cooldownKind,
			bypassReflectionCooldown: options.bypassReflectionCooldown,
			runId,
			modelPattern,
			reason,
			logPath,
			sessionDir,
			sessionId,
			promptPath,
			kind,
		});
		if (!reservationResult.ok) {
			return `Auto Learn not started: ${reservationResult.reason}`;
		}
		const { reservation } = reservationResult;

		try {
			fs.writeFileSync(promptPath, prompt, "utf-8");
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			this.releaseAutoLearnReservation(reservation, options.cooldownKind);
			this.appendAutoLearnLog(logPath, `Auto Learn failed to write prompt file: ${message}`);
			this.updateAutoLearnFooter();
			return `Auto Learn not started: failed to write prompt file (${message}). Log: ${logPath}`;
		}

		let child: ReturnType<typeof spawn> | undefined;
		let outFd: number | undefined;
		try {
			outFd = fs.openSync(logPath, "a");
			const sourceSessionFile = this.sessionManager.getSessionFile();
			child = spawn(spawnTarget.command, args, {
				cwd: this.sessionManager.getCwd(),
				detached: true,
				stdio: ["ignore", outFd, outFd],
				env: {
					...process.env,
					PI_AUTO_LEARN_CHILD: "1",
					...(sourceSessionFile ? { PI_AUTO_LEARN_SOURCE_SESSION_FILE: sourceSessionFile } : {}),
				},
			});
			child.once("error", (error) => {
				const message = error instanceof Error ? error.message : String(error);
				this.appendAutoLearnLog(logPath, `Auto Learn failed to start: ${message}`);
			});
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			this.releaseAutoLearnReservation(reservation, options.cooldownKind);
			this.appendAutoLearnLog(logPath, `Auto Learn failed to start: ${message}`);
			this.updateAutoLearnFooter();
			return `Auto Learn not started: failed to spawn background learner (${message}). Log: ${logPath}`;
		} finally {
			if (outFd !== undefined) {
				try {
					fs.closeSync(outFd);
				} catch {
					// The child has already been spawned or startup has already failed; ignore close errors here.
				}
			}
		}
		if (!child || typeof child.pid !== "number" || child.pid <= 0) {
			this.releaseAutoLearnReservation(reservation, options.cooldownKind);
			this.updateAutoLearnFooter();
			return `Auto Learn not started: failed to spawn background learner. Log: ${logPath}`;
		}
		const childPid = child.pid;
		child.once("exit", (code) => {
			if (code === 0) {
				this.cleanupCompletedAutoLearnRun(reservation.runId, {
					artifactPaths: [promptPath, logPath, sessionDir],
					sessionDir,
					sessionId,
					logPath,
				});
			}
		});
		child.unref();
		this.markAutoLearnReservationRunning(reservation, childPid, settings);

		this.updateAutoLearnFooter();
		return `Auto Learn started. Log: ${logPath}`;
	}

	private sanitizeAutoLearnDigestText(text: string): string {
		return text
			.replace(
				/-----BEGIN [A-Z ]*(?:PRIVATE|OPENSSH|RSA|DSA|EC) KEY-----[\s\S]*?-----END [A-Z ]*(?:PRIVATE|OPENSSH|RSA|DSA|EC) KEY-----/g,
				"[redacted-private-key]",
			)
			.replace(/\b(?:sk|pk)-(?:proj-)?[A-Za-z0-9_-]{12,}/g, "[redacted-api-key]")
			.replace(/\bsk-ant-[A-Za-z0-9_-]{12,}/g, "[redacted-api-key]")
			.replace(/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/g, "[redacted-github-token]")
			.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted-aws-access-key]")
			.replace(/(?:Bearer\s+)[A-Za-z0-9._-]{16,}/gi, "Bearer [redacted]")
			.replace(/([?&](?:key|token|api_key|access_token|secret|password)=)[^&\s]+/gi, "$1[redacted]")
			.replace(
				/((?:access|refresh|token|apiKey|api_key|password|secret|authorization|auth)\s*[:=]\s*)[^\s,'"}]{8,}/gi,
				"$1[redacted]",
			);
	}

	private capAutoLearnDigestText(text: string, maxChars: number): string {
		const compact = this.sanitizeAutoLearnDigestText(text).replace(/\s+/g, " ").trim();
		if (compact.length <= maxChars) return compact;
		return `${compact.slice(0, Math.max(0, maxChars - 20)).trimEnd()} …[truncated]`;
	}

	private getAgentMessagePlainText(message: AgentMessage): string {
		const raw = message as unknown as Record<string, unknown>;
		const content = raw.content;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		const parts: string[] = [];
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const item = block as Record<string, unknown>;
			if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
			if (item.type === "toolCall" && typeof item.name === "string") parts.push(`[tool call: ${item.name}]`);
		}
		return parts.join("\n");
	}

	private countAgentToolCalls(messages: AgentMessage[]): number {
		let toolCalls = 0;
		let toolResults = 0;
		for (const message of messages) {
			const raw = message as unknown as Record<string, unknown>;
			const role = String(raw.role ?? "");
			if (role === "toolResult" || role === "bashExecution") toolResults++;
			const content = raw.content;
			if (!Array.isArray(content)) continue;
			for (const block of content) {
				if (block && typeof block === "object" && (block as Record<string, unknown>).type === "toolCall") {
					toolCalls++;
				}
			}
		}
		return Math.max(toolCalls, toolResults);
	}

	private buildAutonomyReviewDigest(messages: AgentMessage[]): string {
		const lines: string[] = [];
		for (const message of messages.slice(-18)) {
			const raw = message as unknown as Record<string, unknown>;
			const role = String(raw.role ?? "message");
			const label = role === "toolResult" && typeof raw.toolName === "string" ? `toolResult:${raw.toolName}` : role;
			const text = this.capAutoLearnDigestText(this.getAgentMessagePlainText(message), 700);
			if (text) lines.push(`${label}: ${text}`);
		}
		const digest = lines.join("\n---\n");
		return this.capAutoLearnDigestText(digest || "[No textual turn digest available.]", 6000);
	}

	private evaluateAutonomyReview(messages: AgentMessage[]): AutonomyReviewDecision {
		const settings = this.getEffectiveAutoLearnSettings();
		const state = this.withAutoLearnStateLock((current) => {
			const pruned = this.pruneAutoLearnHistoryFromState(current);
			return { result: pruned, next: pruned };
		});
		const now = Date.now();
		const tenant = this.getAutoLearnTenantKey();
		const runningCount = Object.values(state.runs ?? {}).filter((run) => run.tenant === tenant).length;
		const lastReflection = state.lastReflectionByTenant?.[tenant] ?? 0;
		const cooldownMs = settings.reflectionCooldownMinutes * 60 * 1000;
		const cooldownRemainingMs = Math.max(0, lastReflection + cooldownMs - now);
		const messageCount = this.getAutoLearnMessageCount();
		const contextPercent = this.session.getContextUsage()?.percent ?? null;
		const toolCalls = this.countAgentToolCalls(messages);
		const userText = messages
			.filter((message) => String((message as unknown as Record<string, unknown>).role ?? "") === "user")
			.map((message) => this.getAgentMessagePlainText(message))
			.join("\n");
		const correctionSignal =
			/\b(next time|for future|from now on|remember this|don't|do not|avoid|instead|you should|should have|you forgot|you missed|not what i asked|wrong again)\b/i.test(
				userText,
			);
		const behavioralSelfImprovementSignal =
			/\b(harness|pi|agent|autonomy|autonomous|self[- ]?improv(?:e|ement|ing)?|steer(?:ing)?|trigger(?:s)?|skill(?:s)?|code[- ]?bak(?:e|ed)|bake(?:d)? into code|not (?:automata|memory)|reference agent|hermes)\b/i.test(
				userText,
			) &&
			/\b(improve|automatic(?:ally)?|autonomous|trigger|fire|skill|steer|self[- ]?improv(?:e|ement|ing)?|code[- ]?bak(?:e|ed)|bake(?:d)?|too much|less)\b/i.test(
				userText,
			);
		const complexTaskThreshold = Math.max(1, settings.complexTaskToolCalls ?? 12);
		const complexTaskSignal = toolCalls >= complexTaskThreshold;
		const bypassCooldown = correctionSignal || behavioralSelfImprovementSignal || complexTaskSignal;
		const base = { messageCount, contextPercent, cooldownRemainingMs, runningCount, toolCalls };
		if (!settings.enabled) return { ...base, shouldRun: false, reason: "disabled" };
		if (!settings.reflectionReview) return { ...base, shouldRun: false, reason: "reflection disabled" };
		if (runningCount >= settings.maxConcurrentLearners) {
			return {
				...base,
				shouldRun: false,
				reason: `max tenant learners running (${runningCount}/${settings.maxConcurrentLearners})`,
			};
		}
		if (cooldownRemainingMs > 0 && !bypassCooldown) {
			return { ...base, shouldRun: false, reason: "reflection cooldown" };
		}
		if (behavioralSelfImprovementSignal) {
			return {
				...base,
				shouldRun: true,
				reason: "reflection behavioral self-improvement signal",
				digest: this.buildAutonomyReviewDigest(messages),
				bypassCooldown: true,
			};
		}
		if (correctionSignal) {
			return {
				...base,
				shouldRun: true,
				reason: "reflection correction signal",
				digest: this.buildAutonomyReviewDigest(messages),
				bypassCooldown: true,
			};
		}
		if (complexTaskSignal) {
			return {
				...base,
				shouldRun: true,
				reason: `reflection complex task learning signal (${toolCalls}/${complexTaskThreshold} tool calls)`,
				digest: this.buildAutonomyReviewDigest(messages),
				bypassCooldown: true,
			};
		}
		// Full autonomy expands allowed action scope for triggered reviews; it does not make every turn a review trigger.
		if (toolCalls >= settings.reflectionMinToolCalls) {
			return {
				...base,
				shouldRun: true,
				reason: `reflection tool trigger (${toolCalls}/${settings.reflectionMinToolCalls})`,
				digest: this.buildAutonomyReviewDigest(messages),
			};
		}
		return { ...base, shouldRun: false, reason: "reflection thresholds not met" };
	}

	/**
	 * Native reflection (R2) is the in-process replacement for the buggy `continuous-learning`
	 * subprocess. It runs when auto-learn is enabled and is not killed via `PI_NATIVE_REFLECTION=0`.
	 */
	private isNativeReflectionEnabled(): boolean {
		if (process.env.PI_NATIVE_REFLECTION === "0") return false;
		if (process.env.PI_AUTO_LEARN_CHILD === "1") return false;
		return this.getEffectiveAutoLearnSettings().enabled;
	}

	/** Heuristic: does the user's turn text read like a correction/steer worth learning from? */
	private hasCorrectionSignal(userText: string): boolean {
		return /\b(next time|for future|from now on|remember this|don't|do not|avoid|instead|you should|should have|you forgot|you missed|not what i asked|wrong again)\b/i.test(
			userText,
		);
	}

	/**
	 * End-of-loop native reflection: demand-gate the just-finished turn (zero-I/O) and, when
	 * warranted, run the in-process {@link AgentSession.runReflectionPass} as a fire-and-forget
	 * background microtask. No subprocess, no blocking of the UI.
	 */
	/**
	 * Resolve the model + thinking level the native reflection pass should use, from auto-learn
	 * settings (`model`, `thinkingLevel`). The configured model is honored only when its provider is
	 * AVAILABLE (api key / logged in) — otherwise we fall back to the session model (undefined). This
	 * lets the user pick a balanced/cheaper reflection model without risking an unusable one.
	 */
	private _resolveReflectionModel(settings: Required<AutoLearnSettings>) {
		let model: Model<any> | undefined;
		if (settings.model && settings.model !== "active") {
			const resolved = resolveCliModel({ cliModel: settings.model, modelRegistry: this.session.modelRegistry });
			if (resolved.model && this.session.modelRegistry.hasConfiguredAuth(resolved.model)) {
				model = resolved.model;
			}
		}
		const thinkingLevel = settings.thinkingLevel ?? "low";
		return { model, thinkingLevel };
	}

	/** Buffer a debounce-skipped turn's text so its learning is folded into the next pass (bug #29). */
	private _bufferPendingReflection(text: string): void {
		const t = text.trim();
		if (!t) return;
		this._pendingReflectionText.push(t);
		// Bound the buffer so a long skipped streak can't grow unbounded; drop oldest past the budget
		// (the most recent corrections matter most).
		let total = this._pendingReflectionText.reduce((n, s) => n + s.length + 1, 0);
		while (this._pendingReflectionText.length > 1 && total > InteractiveMode.PENDING_REFLECTION_MAX_CHARS) {
			total -= (this._pendingReflectionText.shift()?.length ?? 0) + 1;
		}
	}

	private _drainPendingReflection(): string {
		if (this._pendingReflectionText.length === 0) return "";
		const joined = this._pendingReflectionText.join("\n");
		this._pendingReflectionText = [];
		return joined;
	}

	private maybeRunNativeReflection(messages: AgentMessage[]): void {
		if (!this.isNativeReflectionEnabled()) return;

		const settings = this.getEffectiveAutoLearnSettings();
		const toolCallCount = this.countAgentToolCalls(messages);
		const contextPercent = this.session.getContextUsage()?.percent ?? 0;
		const contextHeadroomPct = Math.max(0, 100 - contextPercent);

		const userText = messages
			.filter((m) => String((m as unknown as Record<string, unknown>).role ?? "") === "user")
			.map((m) => this.getAgentMessagePlainText(m))
			.join("\n");
		const hadCorrection = this.hasCorrectionSignal(userText);

		// A correction is worth learning from even on a short turn; otherwise require a complex turn.
		const trigger: "complex" | "corrective" | "none" = hadCorrection
			? "corrective"
			: toolCallCount >= Math.max(1, settings.complexTaskToolCalls ?? 12)
				? "complex"
				: "none";
		if (trigger === "none") return;

		const recentTurnText = messages
			.map((m) =>
				`${String((m as unknown as Record<string, unknown>).role ?? "")}: ${this.getAgentMessagePlainText(m)}`.trim(),
			)
			.filter(Boolean)
			.join("\n");

		// Debounce (cost guard): never run two background reflection passes at once, and never start one
		// within the min interval of the last — a multi-turn correction session would otherwise spawn
		// overlapping passes that re-reason the same task. A skipped turn is NOT dropped: its text is
		// buffered and folded into the next pass, so the corrective feedback is still learned (bug #29).
		const now = Date.now();
		const debounced =
			this._nativeReflectionInFlight ||
			now - this._lastNativeReflectionAt < InteractiveMode.NATIVE_REFLECTION_MIN_INTERVAL_MS;
		if (debounced) {
			this._bufferPendingReflection(recentTurnText);
			return;
		}

		// Fold any buffered (previously debounced) turns into this pass so nothing learned is lost.
		const pending = this._drainPendingReflection();
		const reflectionText = pending ? `${pending}\n${recentTurnText}` : recentTurnText;

		// Stable per-turn id so a duplicate scheduling/retry can't double-count the reflection cost.
		// Messages carry no `id` on the real path (only timestamps), so derive the key from the last
		// message's timestamp + the turn size — present on every real turn, stable across a retry of the
		// same agent_end, and distinct between turns. Falls back to a content signature if needed.
		const last = messages[messages.length - 1] as unknown as { id?: string; timestamp?: number | string };
		const turnKey = last?.id ?? (last?.timestamp != null ? `${last.timestamp}:${recentTurnText.length}` : undefined);
		const reportId = turnKey ? `reflection:${turnKey}` : undefined;

		// User-configurable reflection model + thinking (auto-learn settings), restricted to AVAILABLE
		// (authed) models — falls back to the session model when unset or unavailable.
		const { model, thinkingLevel } = this._resolveReflectionModel(settings);

		this._nativeReflectionInFlight = true;
		this._lastNativeReflectionAt = now;
		void this.session
			.runReflectionPass({
				signals: { trigger, toolCallCount, hadCorrection, contextHeadroomPct, usefulLately: 0 },
				recentTurnText: reflectionText,
				reportId,
				model,
				thinkingLevel,
			})
			.catch(() => {
				// best-effort background learning; never disrupt the session
			})
			.finally(() => {
				this._nativeReflectionInFlight = false;
			});
	}

	private maybeStartAutoLearn(): boolean {
		if (process.env.PI_AUTO_LEARN_CHILD === "1") return false;
		const decision = this.evaluateAutoLearn(false);
		if (!decision.shouldRun) {
			this.updateAutoLearnFooter();
			return false;
		}
		const message = this.launchAutoLearn(decision.reason, false);
		if (!message.startsWith("Auto Learn started")) this.showStatus(message);
		return message.startsWith("Auto Learn started");
	}

	private maybeStartAutonomyReview(messages: AgentMessage[]): boolean {
		if (process.env.PI_AUTO_LEARN_CHILD === "1") return false;
		const decision = this.evaluateAutonomyReview(messages);
		if (!decision.shouldRun) return false;
		const message = this.launchAutoLearn(decision.reason, true, {
			cooldownKind: "reflection",
			promptKind: "reflection",
			turnDigest: decision.digest,
			bypassReflectionCooldown: decision.bypassCooldown,
		});
		if (!message.startsWith("Auto Learn started")) this.showStatus(message);
		return message.startsWith("Auto Learn started");
	}

	private updateAutoLearnFooter(): void {
		const settings = this.getEffectiveAutoLearnSettings();
		if (!settings.enabled) {
			this.footerDataProvider.setExtensionStatus("auto-learn", undefined);
			return;
		}
		const tenant = this.getAutoLearnTenantKey();
		const state = this.getPrunedAutoLearnState();
		const hasActiveRun = Object.values(state.runs ?? {}).some(
			(run) => run.tenant === tenant && this.isAutoLearnPidAlive(run.pid),
		);
		this.footerDataProvider.setExtensionStatus(
			"auto-learn",
			hasActiveRun ? theme.fg("warning", "(learning)") : undefined,
		);
		this.footer.invalidate();
		this.ui.requestRender();
	}

	private formatAutoLearnStatus(): string {
		const settings = this.getEffectiveAutoLearnSettings();
		const decision = this.evaluateAutoLearn(false);
		const state = this.getPrunedAutoLearnState();
		const tenant = this.getAutoLearnTenantKey();
		const runs = Object.entries(state.runs ?? {}).filter(([, run]) => run.tenant === tenant);
		const otherTenantRuns = Object.values(state.runs ?? {}).filter((run) => run.tenant !== tenant).length;
		const contextText = decision.contextPercent === null ? "unknown" : `${decision.contextPercent.toFixed(1)}%`;
		const cooldownText =
			decision.cooldownRemainingMs > 0 ? `${Math.ceil(decision.cooldownRemainingMs / 60000)}m remaining` : "ready";
		const runLines = runs.length
			? runs
					.map(([id, run]) => {
						const session = [
							run.sessionId ? `session=${run.sessionId}` : "",
							run.sessionDir ? `sessionDir=${run.sessionDir}` : "",
						]
							.filter(Boolean)
							.join(", ");
						const sessionText = session ? `, ${session}` : "";
						return `- ${id}: ${run.model}, kind=${run.kind ?? "auto"}, status=${run.status ?? "running"}, authority=${run.authority ?? "unknown"}, pid=${run.pid ?? "?"}${sessionText}, log=${run.logPath}`;
					})
					.join("\n")
			: "- none";
		const reloadBlockers = getPendingReloadBlockers({
			ownPid: process.pid,
			ownSessionId: this.sessionManager.getSessionId(),
			ownSessionFile: this.sessionManager.getSessionFile(),
		});
		const reloadBlockerLines = reloadBlockers.pending
			? reloadBlockers.descriptions.map((description) => `- ${description}`).join("\n")
			: "- none";
		const reflectionLast = state.lastReflectionByTenant?.[this.getAutoLearnTenantKey()] ?? 0;
		const reflectionCooldownRemainingMs = Math.max(
			0,
			reflectionLast + settings.reflectionCooldownMinutes * 60 * 1000 - Date.now(),
		);
		const reflectionCooldownText =
			reflectionCooldownRemainingMs > 0 ? `${Math.ceil(reflectionCooldownRemainingMs / 60000)}m remaining` : "ready";
		return `Auto Learn status\nEnabled: ${settings.enabled}\nModel: ${settings.model}\nNext decision: ${decision.shouldRun ? "ready" : decision.reason}\nMessages: ${decision.messageCount}/${settings.longSessionMessages}\nContext: ${contextText}/${settings.longSessionContextPercent}%\nCooldown: ${cooldownText}\nReflection review: ${settings.reflectionReview ? "enabled" : "disabled"} (tool trigger ${settings.reflectionMinToolCalls}, cooldown ${reflectionCooldownText})\nHistory retention: 7 days for internal Auto Learn prompts/logs/sessions\nRunning tenant leases: ${runs.length}/${settings.maxConcurrentLearners}\nOther tenant leases: ${otherTenantRuns}\nTenant artifact dir: ${this.getAutoLearnTenantDataDir()}\nPi auto-reload blockers: ${reloadBlockers.pending ? reloadBlockers.reason : "none"}\n${reloadBlockerLines}\nRuns:\n${runLines}`;
	}

	private formatAutonomyStatus(): string {
		const autonomy = this.settingsManager.getAutonomySettings();
		const settings = this.getEffectiveAutoLearnSettings();
		const autoLearnState = this.getPrunedAutoLearnState();
		const tenant = this.getAutoLearnTenantKey();
		const running = Object.entries(autoLearnState.runs ?? {}).filter(([, run]) => run.tenant === tenant);
		const otherTenantRunning = Object.values(autoLearnState.runs ?? {}).filter((run) => run.tenant !== tenant).length;
		const safety =
			autonomy.mode === "full"
				? "standing grant for memory, skills, user/project extensions, autonomy/autoLearn tuning, and authorized selfModification.sourcePath edits; hard stops still require explicit foreground approval"
				: "proposal-gated outside configured high-confidence memory policy";
		const reflectionLine =
			autonomy.mode === "full"
				? `Reflection review: ${settings.reflectionReview ? "enabled" : "disabled"}; post-turn when concurrency allows; cooldown=${settings.reflectionCooldownMinutes}m`
				: `Reflection review: ${settings.reflectionReview ? "enabled" : "disabled"}; tool trigger=${settings.reflectionMinToolCalls}; cooldown=${settings.reflectionCooldownMinutes}m`;
		return [
			"Autonomy status",
			`Mode: ${autonomy.mode}${autonomy.mode === "full" ? " (standing autonomy)" : ""}`,
			`Goal loop rounds: ${autonomy.maxStallTurns}`,
			`Auto Learn: ${settings.enabled ? "enabled" : "disabled"}; model=${settings.model}; applyHighConfidence=${settings.applyHighConfidence}`,
			`Long-session trigger: ${settings.longSessionMessages} messages or ${settings.longSessionContextPercent}% context; cooldown=${settings.cooldownMinutes}m`,
			reflectionLine,
			`Running tenant learners: ${running.length}/${settings.maxConcurrentLearners}`,
			`Other tenant learners: ${otherTenantRunning}`,
			"History retention: 7 days for internal Auto Learn prompts/logs/sessions",
			`Standing authority: ${safety}`,
			`Audit/log dir: ${this.getAutoLearnDataDir()}`,
			`Tenant artifact dir: ${this.getAutoLearnTenantDataDir()}`,
			"Use /autonomy off|safe|balanced|full to switch presets. Advanced overrides remain in /settings → Auto Learn Advanced.",
		].join("\n");
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

	/**
	 * /models — USER-invoked local model lifecycle (never a model-invokable tool):
	 * list/add/remove/stop per local-model-lifecycle-design.md. Removal is explicit-only with
	 * full disclosure; a pasted install command is parsed for its ref, never executed.
	 */
	private async handleModelsCommand(argsText: string): Promise<void> {
		const [action = "list", ...rest] = argsText.split(/\s+/).filter(Boolean);
		try {
			if (action === "suggest" || action === "suggestions") {
				this.showModelSuggestionSelector();
				return;
			}
			if (action === "stop") {
				const stopped = this.localRuntime.stop();
				this.showStatus(
					stopped.stopped
						? "Pi-managed local model server stopped (models remain installed)."
						: "No pi-managed server running (a system server, if any, is not pi's to stop).",
				);
				return;
			}

			if (action === "add") {
				const rawRef = rest.join(" ");
				if (!rawRef) {
					this.showStatus(
						"Usage: /models add <ollama-tag | hf.co/org/repo[:quant] | huggingface URL | pasted install command>",
					);
					this.showStatus("Or start from a validated suggestion: /models suggest");
					return;
				}
				const source = normalizeModelSource(rawRef);
				if (source.type === "rejected") {
					this.showStatus(`Not added: ${source.reason}`);
					return;
				}
				if (source.type === "api") {
					this.showStatus(
						`${source.ref} is an API model — nothing to install. Configure auth for the provider, then probe it with /fitness ${source.ref}.`,
					);
					return;
				}
				await this.addLocalModel(source.pullRef);
				return;
			}

			if (action === "remove") {
				const ref = rest[0];
				const confirmed = rest[1] === "confirm";
				if (!ref) {
					this.showStatus("Usage: /models remove <ref> confirm");
					return;
				}
				await this.removeLocalModel(ref, confirmed);
				return;
			}

			await this.listLocalModels();
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async ensureLocalServer(): Promise<boolean> {
		const status = await this.localRuntime.detect();
		if (status.serverUp) return true;
		if (!status.binaryPath) {
			for (const line of this.localRuntime.installGuide()) this.showStatus(line);
			return false;
		}
		this.showStatus(
			`Starting local model server (${status.binarySource} binary, owned storage: ${status.ownedModelsDir})…`,
		);
		const started = await this.localRuntime.start();
		if (!started.started) {
			this.showStatus(`Could not start the local server: ${started.reason}`);
			return false;
		}
		return true;
	}

	private async listLocalModels(): Promise<void> {
		const status = await this.localRuntime.detect();
		if (!status.serverUp) {
			if (!status.binaryPath) {
				for (const line of this.localRuntime.installGuide()) this.showStatus(line);
				return;
			}
			this.showStatus(
				`Local server not running (binary: ${status.binarySource}). /models add starts it on demand; /fitness probes registered models.`,
			);
			return;
		}
		const models = await this.localRuntime.list();
		const fitness = FitnessStore.forAgentDir(getAgentDir()).getForHost();
		const lines = [
			`Local models (${status.managedByPi ? `pi-managed server, storage: ${status.ownedModelsDir}` : "system server — storage owned by the system daemon"}):`,
			...(models.length === 0
				? ["  (none installed — /models add <ref>, or /models suggest for a validated roster)"]
				: []),
			...models.map((model) => {
				const report = fitness.find((entry) => entry.model === `ollama/${model.name}`);
				const gb = (model.sizeBytes / 1e9).toFixed(2);
				const probe = report
					? `probed ${report.at.slice(0, 10)}: digest ${report.report.digest?.succeeded ?? "?"}/${report.report.digest?.total ?? "?"}, tool-calls ${report.report.toolCall.succeeded}/${report.report.toolCall.total}${report.report.tokensPerSecond ? `, ~${report.report.tokensPerSecond} tok/s` : ""}`
					: `unprobed — run /fitness ollama/${model.name}`;
				return `  - ${model.name} (${gb} GB) · ${probe}`;
			}),
			"Commands: /models add <ref> · /models remove <ref> confirm · /models stop",
		];
		for (const line of lines) this.showStatus(line);
	}

	private async addLocalModel(pullRef: string, preselectRole?: FitnessRole): Promise<void> {
		if (!(await this.ensureLocalServer())) return;
		this.showStatus(`Pulling ${pullRef}… (weights land in the server's model storage)`);
		let lastShown = 0;
		const pulled = await this.localRuntime.pull(pullRef, (progress) => {
			const now = Date.now();
			if (now - lastShown > 2000) {
				lastShown = now;
				this.showStatus(`  ${pullRef}: ${progress}`);
			}
		});
		if (!pulled.ok) {
			this.showStatus(`Pull failed: ${pulled.error}`);
			return;
		}
		const registration = registerLocalModel({
			agentDir: getAgentDir(),
			ref: pullRef,
			baseUrl: this.localRuntime.baseUrl,
		});
		if (!registration.ok) {
			this.showStatus(`Pulled, but not auto-registered: ${registration.reason}`);
			if (registration.manualSnippet) {
				this.showStatus(`Add this to ${registration.modelsJsonPath} yourself:\n${registration.manualSnippet}`);
			}
			return;
		}
		this.session.modelRegistry.refresh();
		this.showStatus(`${pullRef} installed and registered as ollama/${pullRef}. Probing fitness…`);
		await this.runFitnessAndAssign(`ollama/${pullRef}`, preselectRole);
	}

	private async removeLocalModel(ref: string, confirmed: boolean): Promise<void> {
		const status = await this.localRuntime.detect();
		if (!status.serverUp) {
			this.showStatus("Local server not running — start it (any /models action) before removing.");
			return;
		}
		const models = await this.localRuntime.list();
		const target = models.find((model) => matchesInstalledLocalModel(ref, model.name));
		if (!target) {
			this.showStatus(
				`${ref} is not installed. Installed: ${models.map((model) => model.name).join(", ") || "(none)"}`,
			);
			return;
		}
		if (!confirmed) {
			// EXPLICIT USER ACTION ONLY: full disclosure, then require the confirm token.
			const gb = (target.sizeBytes / 1e9).toFixed(2);
			this.showStatus(
				[
					`Removing ${ref} will delete:`,
					`  - model weights (${gb} GB) from ${status.managedByPi ? status.ownedModelsDir : "the system server's storage"}`,
					`  - the ollama/${ref} entry in models.json`,
					`  - its cached fitness report for this host`,
					`Run: /models remove ${ref} confirm`,
				].join("\n"),
			);
			return;
		}
		const removed = await this.localRuntime.remove(ref);
		if (!removed.ok) {
			this.showStatus(`Remove failed: ${removed.error}`);
			return;
		}
		unregisterLocalModel({ agentDir: getAgentDir(), ref });
		FitnessStore.forAgentDir(getAgentDir()).remove(`ollama/${ref}`);
		this.session.modelRegistry.refresh();
		this.showStatus(`${ref} removed: weights deleted, registration and fitness report dropped.`);
	}

	/** /fitness with no args: pick a model from the configured registry, probe it, assign a role. */
	/** Pick a validated suggestion → install it → probe on this host → land its shaped role. */
	private showModelSuggestionSelector(): void {
		this.showSelector((done) => {
			const selector = new ModelSuggestionSelectorComponent(
				DEFAULT_MODEL_SUGGESTIONS,
				async (suggestion) => {
					done();
					// The shaped role rides along so the post-probe selector lands on it pre-selected;
					// non-tool-callers carry curator/judge/none, never executor, so this can't footgun.
					await this.addLocalModel(suggestion.pullRef, suggestion.assignRole);
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private showFitnessModelSelector(): void {
		this.showSelector((done) => {
			const selector = new ModelSelectorComponent(
				this.ui,
				this.session.model,
				this.settingsManager,
				this.session.modelRegistry,
				this.session.scopedModels,
				async (model) => {
					done();
					await this.runFitnessAndAssign(`${model.provider}/${model.id}`);
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	/** Probe a model's fitness, show the report, then offer one-step role assignment. When the model
	 * came from a validated suggestion, `preselectRole` lands its shaped role already highlighted. */
	private async runFitnessAndAssign(modelRef: string, preselectRole?: FitnessRole): Promise<void> {
		this.showStatus(`Model fitness probe running on ${modelRef}… (6 surfaces; local models may take a few minutes)`);
		try {
			const outcome = await this.session.runModelFitness({ model: modelRef });
			if (!outcome.started) {
				this.showStatus(`Model fitness skipped: ${outcome.skipReason}`);
				return;
			}
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(formatModelFitnessReport(outcome.model, outcome.report), 1, 0));
			this.ui.requestRender();
			// Validate-before-load: zero successes on every probed surface means the model cannot
			// drive any of the harness's subagent contracts on this host — refuse adoption instead
			// of landing a role selector the user might reflexively confirm (this is the reported
			// bug: a 0/3-everywhere model still got set as judge model and saved to Model Router).
			if (isProbeAllFailed(outcome.report)) {
				this.showStatus(
					`${outcome.model} failed the fitness probe on all surfaces — not configured. Use /model to set it manually if you accept the risk.`,
				);
				return;
			}
			this.showSelector((done) => {
				const selector = new FitnessRoleSelectorComponent(
					outcome.model,
					(role) => {
						done();
						this.assignFitnessRole(outcome.model, role);
					},
					() => {
						done();
						this.ui.requestRender();
					},
					preselectRole,
				);
				return { component: selector, focus: selector };
			});
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	/** Persist a role assignment from the post-probe selector into the matching settings. */
	private assignFitnessRole(modelRef: string, role: FitnessRole): void {
		if (role === "none") {
			this.showStatus(`Fitness result for ${modelRef} saved. Assign a role later from /settings.`);
			return;
		}
		if (role === "curator") {
			const current = this.settingsManager.getContextCurationSettings();
			this.settingsManager.setContextCurationSettings({ ...current, enabled: true, model: modelRef });
			this.showStatus(`Context curation enabled with ${modelRef} as the curator.`);
			return;
		}
		if (role === "executor") {
			const router = this.settingsManager.getModelRouterSettings();
			this.settingsManager.setModelRouterSettings({ ...router, executorModel: modelRef });
			const hint = router.enabled
				? ""
				: " Model router is currently disabled — enable it in /settings → Model Router.";
			this.showStatus(`${modelRef} set as the toolkit executor (direct Level-0 hits route to it).${hint}`);
			return;
		}
		const router = this.settingsManager.getModelRouterSettings();
		const field =
			role === "router-cheap"
				? "cheapModel"
				: role === "router-medium"
					? "mediumModel"
					: role === "router-expensive"
						? "expensiveModel"
						: role === "judge"
							? "judgeModel"
							: "learningModel";
		this.settingsManager.setModelRouterSettings({ ...router, [field]: modelRef });
		const hint = router.enabled ? "" : " Model router is currently disabled — enable it in /settings → Model Router.";
		this.showStatus(`${modelRef} set as ${role.replace("router-", "router ")} model.${hint}`);
	}

	private handleAutonomyCommand(text: string): void {
		const action = text.slice("/autonomy".length).trim() || "status";
		if (AUTONOMY_MODES.includes(action as AutonomyMode)) {
			const mode = action as AutonomyMode;
			this.applyAutonomyMode(mode);
			this.showStatus(`Autonomy mode set to ${mode}${mode === "full" ? " (standing autonomy)" : ""}.`);
			return;
		}
		if (action === "status") {
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(this.formatAutonomyStatus(), 1, 0));
			this.ui.requestRender();
			return;
		}
		if (action === "diagnostics") {
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Text(formatAutonomyDiagnostics(this.session.getAutonomyDiagnosticSnapshot()), 1, 0),
			);
			this.ui.requestRender();
			return;
		}
		if (action.startsWith("rollback")) {
			const auditId = action.slice("rollback".length).trim();
			if (!auditId) {
				this.showStatus("Usage: /autonomy rollback <auditId> (see /autonomy diagnostics for audit ids)");
				return;
			}
			void this.session
				.rollbackLearningWrite(auditId)
				.then((result) => {
					this.showStatus(
						result.ok ? `Rolled back learning change ${auditId}.` : `Rollback skipped: ${result.reason}`,
					);
				})
				.catch((error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					this.showStatus(`Rollback failed: ${message}`);
				});
			return;
		}
		if (action.startsWith("fitness")) {
			const rest = action.slice("fitness".length).trim().split(/\s+/).filter(Boolean);
			const modelPattern = rest[0];
			if (!modelPattern) {
				this.showStatus("Usage: /autonomy fitness <model-pattern> [trials]");
				return;
			}
			const trials = rest[1] ? Number(rest[1]) : undefined;
			this.showStatus(`Model fitness probe running on ${modelPattern}…`);
			void this.session
				.runModelFitness({ model: modelPattern, trials: Number.isFinite(trials) ? trials : undefined })
				.then((outcome) => {
					if (!outcome.started) {
						this.showStatus(`Model fitness skipped: ${outcome.skipReason}`);
						return;
					}
					this.chatContainer.addChild(new Spacer(1));
					this.chatContainer.addChild(new Text(formatModelFitnessReport(outcome.model, outcome.report), 1, 0));
					this.ui.requestRender();
				})
				.catch((error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					this.showStatus(`Model fitness failed: ${message}`);
				});
			return;
		}
		if (action === "research") {
			this.showStatus("Research lane: running…");
			void this.session
				.runResearchLaneOnce()
				.then((outcome) => {
					if (!outcome.started) {
						this.showStatus(`Research lane skipped: ${outcome.skipReason ?? "unknown"}`);
						return;
					}
					const status = outcome.record?.status ?? "unknown";
					const reason = outcome.record?.reasonCode ? ` (${outcome.record.reasonCode})` : "";
					this.showStatus(`Research lane ${status}${reason}`);
				})
				.catch((error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					this.showStatus(`Research lane failed: ${message}`);
				});
			return;
		}
		this.showStatus("Usage: /autonomy [status|diagnostics|research|rollback <auditId>|off|safe|balanced|full]");
	}

	private handleAutoLearnCommand(text: string): void {
		const action = text.slice("/auto-learn".length).trim() || "status";
		if (action === "run" || action === "now" || action === "run-now") {
			this.showStatus(this.launchAutoLearn("manual", true));
			return;
		}
		if (action === "status") {
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(this.formatAutoLearnStatus(), 1, 0));
			this.ui.requestRender();
			return;
		}
		this.showStatus("Usage: /auto-learn [status|run]");
	}

	private showSettingsSelector(): void {
		this.showSelector((done) => {
			const projectSettings = this.settingsManager.getProjectSettings();
			const profileOptions = [
				{
					value: "(none)",
					label: "(none)",
					description: "Use configured profile selection (session default)",
				},
				...this.settingsManager
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
					autoCompact: this.session.autoCompactionEnabled,
					showImages: this.settingsManager.getShowImages(),
					imageWidthCells: this.settingsManager.getImageWidthCells(),
					autoResizeImages: this.settingsManager.getImageAutoResize(),
					blockImages: this.settingsManager.getBlockImages(),
					enableSkillCommands: this.settingsManager.getEnableSkillCommands(),
					steeringMode: this.session.steeringMode,
					followUpMode: this.session.followUpMode,
					transport: this.settingsManager.getTransport(),
					httpIdleTimeoutMs: this.settingsManager.getHttpIdleTimeoutMs(),
					thinkingLevel: this.session.thinkingLevel,
					availableThinkingLevels: this.session.getAvailableThinkingLevels(),
					currentTheme: this.settingsManager.getTheme() || "dark",
					// The picker offers only themes the active profile permits (no-bypass). The theme
					// registry/renderer keeps the full set, so an already-applied theme still renders
					// even if the profile would block re-selecting it.
					availableThemes: getAvailableThemes().filter((name) =>
						this.settingsManager.isResourceAllowedByProfile("themes", name),
					),
					hideThinkingBlock: this.hideThinkingBlock,
					collapseChangelog: this.settingsManager.getCollapseChangelog(),
					enableInstallTelemetry: this.settingsManager.getEnableInstallTelemetry(),
					doubleEscapeAction: this.settingsManager.getDoubleEscapeAction(),
					treeFilterMode: this.settingsManager.getTreeFilterMode(),
					showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
					editorPaddingX: this.settingsManager.getEditorPaddingX(),
					autocompleteMaxVisible: this.settingsManager.getAutocompleteMaxVisible(),
					quietStartup: this.settingsManager.getQuietStartup(),
					clearOnShrink: this.settingsManager.getClearOnShrink(),
					showTerminalProgress: this.settingsManager.getShowTerminalProgress(),
					warnings: this.settingsManager.getWarnings(),
					selfModification: this.settingsManager.getSelfModificationSettings(),
					selfModificationScope: projectSettings.selfModification ? "project" : "global",
					autonomy: this.settingsManager.getAutonomySettings(),
					autonomyScope: projectSettings.autonomy ? "project" : "global",
					researchLane: this.settingsManager.getResearchLaneSettings(),
					researchLaneScope: projectSettings.researchLane ? "project" : "global",
					workerDelegation: this.settingsManager.getWorkerDelegationSettings(),
					workerDelegationScope: projectSettings.workerDelegation ? "project" : "global",
					contextCuration: this.settingsManager.getContextCurationSettings(),
					contextCurationScope: projectSettings.contextPolicy?.curation ? "project" : "global",
					learningPolicy: this.settingsManager.getLearningPolicySettings(),
					learningPolicyScope: projectSettings.learningPolicy ? "project" : "global",
					modelCapability: this.settingsManager.getModelCapabilitySettings(),
					modelCapabilityScope: projectSettings.modelCapability ? "project" : "global",
					modelRouter: this.settingsManager.getModelRouterSettings(),
					modelRouterScope: projectSettings.modelRouter ? "project" : "global",
					autoLearn: this.settingsManager.getAutoLearnSettings(),
					autoLearnScope: projectSettings.autoLearn ? "project" : "global",
					autoLearnModelOptions: this.getAutoLearnModelOptions(),
					contextPolicyEnforcement: this.settingsManager.getContextPromptEnforcementSettings(),
					contextPolicyEnforcementScope: projectSettings.contextPolicy?.enforcement ? "project" : "global",
					contextMemoryRetrieval: this.settingsManager.getMemoryRetrievalSettings(),
					contextMemoryRetrievalScope: projectSettings.contextPolicy?.memory ? "project" : "global",
					currentModelPattern: this.session.model
						? `${this.session.model.provider}/${this.session.model.id}`
						: undefined,
					activeProfileName: this.settingsManager.getActiveResourceProfileNames()[0],
					profileOptions,
					externalResourceRoots: this.settingsManager.getExternalResourceRoots(),
					trustedResourceRoots: this.settingsManager.getTrustedResourceRoots(),
				},
				{
					onAutoCompactChange: (enabled) => {
						this.session.setAutoCompactionEnabled(enabled);
						this.footer.setAutoCompactEnabled(enabled);
					},
					onShowImagesChange: (enabled) => {
						this.settingsManager.setShowImages(enabled);
						for (const child of this.chatContainer.children) {
							if (child instanceof ToolExecutionComponent || child instanceof ToolGroupComponent) {
								child.setShowImages(enabled);
							}
						}
						this.ui.requestRender();
					},
					onImageWidthCellsChange: (width) => {
						this.settingsManager.setImageWidthCells(width);
						for (const child of this.chatContainer.children) {
							if (child instanceof ToolExecutionComponent || child instanceof ToolGroupComponent) {
								child.setImageWidthCells(width);
							}
						}
						this.ui.requestRender();
					},
					onAutoResizeImagesChange: (enabled) => {
						this.settingsManager.setImageAutoResize(enabled);
					},
					onBlockImagesChange: (blocked) => {
						this.settingsManager.setBlockImages(blocked);
					},
					onEnableSkillCommandsChange: (enabled) => {
						this.settingsManager.setEnableSkillCommands(enabled);
						this.setupAutocompleteProvider();
					},
					onSteeringModeChange: (mode) => {
						this.session.setSteeringMode(mode);
					},
					onFollowUpModeChange: (mode) => {
						this.session.setFollowUpMode(mode);
					},
					onTransportChange: (transport) => {
						this.settingsManager.setTransport(transport);
						this.session.agent.transport = transport;
					},
					onHttpIdleTimeoutMsChange: (timeoutMs) => {
						this.settingsManager.setHttpIdleTimeoutMs(timeoutMs);
						configureHttpDispatcher(timeoutMs);
						this.showStatus(`HTTP idle timeout: ${formatHttpIdleTimeoutMs(timeoutMs)}`);
					},
					onThinkingLevelChange: (level) => {
						this.session.setThinkingLevel(level);
						this.footer.invalidate();
						this.updateEditorBorderColor();
					},
					onThemeChange: (themeName) => {
						const result = setTheme(themeName, true);
						this.settingsManager.setTheme(themeName);
						this.ui.invalidate();
						if (!result.success) {
							this.showError(`Failed to load theme "${themeName}": ${result.error}\nFell back to dark theme.`);
						}
					},
					onThemePreview: (themeName) => {
						const result = setTheme(themeName, true);
						if (result.success) {
							this.ui.invalidate();
							this.ui.requestRender();
						}
					},
					onHideThinkingBlockChange: (hidden) => {
						this.hideThinkingBlock = hidden;
						this.settingsManager.setHideThinkingBlock(hidden);
						for (const child of this.chatContainer.children) {
							if (child instanceof AssistantMessageComponent) {
								child.setHideThinkingBlock(hidden);
							}
						}
						void this.rebuildChatFromMessages();
					},
					onCollapseChangelogChange: (collapsed) => {
						this.settingsManager.setCollapseChangelog(collapsed);
					},
					onEnableInstallTelemetryChange: (enabled) => {
						this.settingsManager.setEnableInstallTelemetry(enabled);
					},
					onQuietStartupChange: (enabled) => {
						this.settingsManager.setQuietStartup(enabled);
					},
					onDoubleEscapeActionChange: (action) => {
						this.settingsManager.setDoubleEscapeAction(action);
					},
					onTreeFilterModeChange: (mode) => {
						this.settingsManager.setTreeFilterMode(mode);
					},
					onShowHardwareCursorChange: (enabled) => {
						this.settingsManager.setShowHardwareCursor(enabled);
						this.ui.setShowHardwareCursor(enabled);
					},
					onEditorPaddingXChange: (padding) => {
						this.settingsManager.setEditorPaddingX(padding);
						this.defaultEditor.setPaddingX(padding);
						if (this.editor !== this.defaultEditor && this.editor.setPaddingX !== undefined) {
							this.editor.setPaddingX(padding);
						}
					},
					onAutocompleteMaxVisibleChange: (maxVisible) => {
						this.settingsManager.setAutocompleteMaxVisible(maxVisible);
						this.defaultEditor.setAutocompleteMaxVisible(maxVisible);
						if (this.editor !== this.defaultEditor && this.editor.setAutocompleteMaxVisible !== undefined) {
							this.editor.setAutocompleteMaxVisible(maxVisible);
						}
					},
					onClearOnShrinkChange: (enabled) => {
						this.settingsManager.setClearOnShrink(enabled);
						this.ui.setClearOnShrink(enabled);
					},
					onShowTerminalProgressChange: (enabled) => {
						this.settingsManager.setShowTerminalProgress(enabled);
					},
					onWarningsChange: (warnings) => {
						this.settingsManager.setWarnings(warnings);
					},
					onSelfModificationChange: (settings, scope) => {
						this.settingsManager.setSelfModificationSettings(settings, scope);
						const validationMessage = this.validateSelfModificationSource(settings);
						if (validationMessage) {
							this.showWarning(validationMessage);
						}
						this.showStatus(
							`Self modification settings saved to ${scope}. Start a new session or /reload for system-prompt guardrails to fully refresh.`,
						);
					},
					onAutonomyChange: (settings, scope) => {
						this.applyAutonomyMode(settings.mode ?? "off", scope);
						this.showStatus(`Autonomy mode ${settings.mode ?? "off"} saved to ${scope}. Use /autonomy status.`);
					},
					onResearchLaneChange: (settings, scope) => {
						this.settingsManager.setResearchLaneSettings(settings, scope);
						this.showStatus(
							`Research lane settings saved to ${scope}. Use /autonomy research or /autonomy diagnostics.`,
						);
					},
					onWorkerDelegationChange: (settings, scope) => {
						this.settingsManager.setWorkerDelegationSettings(settings, scope);
						this.showStatus(`Worker delegation settings saved to ${scope}. The delegate tool uses them.`);
					},
					onLearningPolicyChange: (settings, scope) => {
						this.settingsManager.setLearningPolicySettings(settings, scope);
						this.showStatus(`Learning policy saved to ${scope}.`);
					},
					onModelCapabilityChange: (settings, scope) => {
						this.settingsManager.setModelCapabilitySettings(settings, scope);
						this.showStatus(
							`Model capability mode saved to ${scope}. Applies on the next model switch or /reload.`,
						);
					},
					onContextCurationChange: (settings, scope) => {
						this.settingsManager.setContextCurationSettings(settings, scope);
						this.showStatus(
							`Context curation settings saved to ${scope}. Run /fitness <model> first if the model is unprobed.`,
						);
					},
					onModelRouterChange: (settings, scope) => {
						this.settingsManager.setModelRouterSettings(settings, scope);
						for (const value of [settings.cheapModel, settings.expensiveModel, settings.learningModel]) {
							const validationMessage = this.validateAutoLearnModelValue(value);
							if (validationMessage) {
								this.showWarning(validationMessage.replace("Auto Learn model", "Model router model"));
							}
						}
						this.updateAutoLearnFooter();
						this.showStatus(
							`Model Router settings saved to ${scope}. Use /session or /usage to inspect routing.`,
						);
					},
					onAutoLearnChange: (settings, scope) => {
						this.settingsManager.setAutoLearnSettings(settings, scope);
						const validationMessage = this.validateAutoLearnModelValue(settings.model);
						if (validationMessage) {
							this.showWarning(validationMessage);
						}
						this.updateAutoLearnFooter();
						this.showStatus(`Auto Learn settings saved to ${scope}. Use /auto-learn status or /auto-learn run.`);
					},
					onContextPolicyEnforcementChange: (settings, scope) => {
						this.settingsManager.setContextPromptEnforcementSettings(settings, scope);
						this.showStatus(`Context/prompt-policy settings saved to ${scope}.`);
					},
					onContextMemoryRetrievalChange: (settings, scope) => {
						this.settingsManager.setMemoryRetrievalSettings(settings, scope);
						this.showStatus(`Context/memory-retrieval settings saved to ${scope}.`);
					},
					onResourcesHubAction: (action) => {
						done();
						void this.handleResourcesHubAction(action);
					},
					onCancel: () => {
						done();
						this.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector.getSettingsList() };
		});
	}

	private async handleResourcesHubAction(action: string): Promise<void> {
		switch (action) {
			case "nudge-add-source":
				void this.addExternalResourceRootFlow().then(() => {
					void this.showSettingsSelector();
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

		this.showSelector((done) => {
			const selector = new SelectSubmenu(
				"Profile / Situation",
				"Select the active runtime profile/situation for this session. This is session-only unless saved elsewhere.",
				options,
				activeNames[0] || "(none)",
				(value) => {
					done();
					void this.applyProfile(value === "(none)" ? "" : value).then(() => {
						void this.showSettingsSelector();
					});
				},
				() => {
					done();
					void this.showSettingsSelector();
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

		this.showSelector((done) => {
			const selector = new SelectSubmenu(
				"Manage Profiles / Situations",
				"Create, delete, or persist profile/situation definitions.",
				options,
				"",
				(value) => {
					done();
					if (value === "create") {
						void this.createProfileFlow().then(() => {
							void this.showSettingsSelector();
						});
					} else if (value === "persist") {
						void this.openPersistProfileSelector();
					} else if (value === "delete") {
						void this.openDeleteProfileSelector();
					}
				},
				() => {
					done();
					void this.showSettingsSelector();
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

		this.showSelector((done) => {
			const selector = new SelectSubmenu(
				"Persist Active Profile / Situation",
				"Choose where to write the active profile/situation selection.",
				scopeOptions,
				"directory",
				(value) => {
					done();
					this.persistActiveProfile(value as "session" | "directory" | "project" | "global");
					void this.showSettingsSelector();
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

		this.showSelector((done) => {
			const selector = new SelectSubmenu(
				"Delete Profile / Situation",
				"Pick a profile/situation to delete.",
				editableProfiles,
				"",
				(value) => {
					done();
					this.deleteProfileFromSource(value);
					void this.showSettingsSelector();
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

		this.showSelector((done) => {
			const selector = new SelectSubmenu(
				"Sources",
				"Manage external resource roots. Adding a root requires trust confirmation.",
				options,
				"",
				(value) => {
					done();
					if (value === "add") {
						void this.addExternalResourceRootFlow().then(() => {
							void this.showSettingsSelector();
						});
					} else if (value.startsWith("remove:")) {
						const root = value.slice("remove:".length);
						void this.removeExternalResourceRootFlow(root).then(() => {
							void this.showSettingsSelector();
						});
					}
				},
				() => {
					done();
					void this.showSettingsSelector();
				},
			);
			return { component: selector, focus: selector.getSelectList() };
		});
	}

	private async openLibraryManagerFlow(): Promise<void> {
		const activeNames = this.settingsManager.getActiveResourceProfileNames();
		const activeName = activeNames[0];

		if (!activeName || activeName === "(none)") {
			this.showSelector((done) => {
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
						void this.showSettingsSelector();
					},
				);
				return { component: selector, focus: selector.getSelectList() };
			});
			return;
		}

		const registry = this.settingsManager.getProfileRegistry();
		const profile = registry.getProfile(activeName);
		if (!profile) {
			this.showError(`Active profile/situation "${activeName}" not found in registry.`);
			return;
		}
		const scope = this.scopeForProfileSource(profile.source);
		void this.openLibraryEditorForProfile(profile.name, scope);
	}

	private async createProfileAndOpenLibraryFlow(): Promise<void> {
		const name = await new Promise<string | undefined>((resolve) => {
			this.showSelector((done) => {
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
					{ tui: this.ui },
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
			this.showWarning("Profile/situation name cannot be empty.");
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
			this.showError(error instanceof Error ? error.message : String(error));
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
			this.showWarning("No existing profiles/situations to select. Please create one.");
			void this.createProfileAndOpenLibraryFlow();
			return;
		}

		this.showSelector((done) => {
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
			this.showError(`Profile not found: ${profileName}`);
			return;
		}

		const kinds = await this.getProfileResourceKinds();
		const originalResources = profile.resources;
		const isActiveProfile = this.settingsManager.getActiveResourceProfileNames().includes(profile.name);

		this.showSelector((done) => {
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
						this.showStatus(`Saved profile "${profileName}" to ${currentScope}.`);
						if (isActiveProfile) {
							const changedKinds = resourceProfileSettingsChangedKinds(originalResources, resources);
							if (changedKinds.size === 1 && changedKinds.has("extensions")) {
								void this.reconcileExtensionsAndRefreshUI(profileName);
							} else if (changedKinds.size > 0) {
								void this.refreshAfterProfileMutation(profileName);
							} else {
								this.ui.requestRender();
							}
						}
					} catch (error) {
						this.showError(error instanceof Error ? error.message : String(error));
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
						this.showWarning(`Resource "${id}" of kind "${kind}" has no editable file path.`);
						void this.openLibraryEditorForProfile(profileName, currentScope);
						return;
					}
					if (!fs.existsSync(resolvedEditPath)) {
						this.showError(`Resolved path for "${id}" does not exist: ${resolvedEditPath}`);
						void this.openLibraryEditorForProfile(profileName, currentScope);
						return;
					}
					await this.openEditorForPath(resolvedEditPath);
					await this.handleReloadCommand();
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

		this.showSelector((done) => {
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

	private async handleProfilesCommand(profileName?: string): Promise<void> {
		if (profileName) {
			await this.applyProfile(profileName);
			return;
		}

		const registry = this.settingsManager.getProfileRegistry();
		const profiles = registry.listProfiles();
		if (profiles.length === 0) {
			this.showWarning(
				"No profiles found. Add resourceProfiles to settings or JSON files under ~/.pi/agent/profiles/.",
			);
			return;
		}

		this.showSelector((done) => {
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
				await this.handleReloadCommand();
				const activeProfileName = this.settingsManager.getActiveResourceProfileNames()[0] ?? "(none)";
				this.footerDataProvider.setExtensionStatus("profile", activeProfileName);
				this.footer.invalidate();
				this.updateEditorBorderColor();
				this.showStatus(`Profile: ${activeProfileName}`);
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		const registry = this.settingsManager.getProfileRegistry();
		const profile =
			normalizedName.startsWith("./") || normalizedName.startsWith("../")
				? registry.resolveProfileRef(normalizedName, this.sessionManager.getCwd())
				: registry.getProfile(normalizedName);
		if (!profile) {
			this.showError(`Profile not found: ${profileName}`);
			return;
		}

		try {
			let appliedModel: Model<any> | undefined;
			if (profile.model) {
				this.session.modelRegistry.refresh();
				const resolved = resolveCliModel({ cliModel: profile.model, modelRegistry: this.session.modelRegistry });
				if (resolved.error) {
					this.showError(resolved.error);
					return;
				}
				if (resolved.warning) {
					this.showWarning(resolved.warning);
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
			await this.handleReloadCommand();
			this.footerDataProvider.setExtensionStatus("profile", profile.name);
			this.footer.invalidate();
			this.updateEditorBorderColor();
			this.showStatus(`Profile: ${profile.name}`);
			if (appliedModel) {
				void this.maybeWarnAboutAnthropicSubscriptionAuth(appliedModel);
				this.checkDaxnutsEasterEgg(appliedModel);
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
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

	private async refreshAfterProfileMutation(profileName: string): Promise<void> {
		if (this.settingsManager.getActiveResourceProfileNames().includes(profileName)) {
			await this.handleReloadCommand();
			const active = this.settingsManager.getActiveResourceProfileNames()[0] ?? "(none)";
			this.footerDataProvider.setExtensionStatus("profile", active);
			this.footer.invalidate();
			this.updateEditorBorderColor();
		}
	}

	private async createProfileFlow(): Promise<void> {
		const name = await new Promise<string | undefined>((resolve) => {
			this.showSelector((done) => {
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
					{ tui: this.ui },
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
			this.showError("Profile/situation name cannot be empty");
			return this.createProfileFlow();
		}

		// Validate name rules using validateSkillName
		const errors = validateSkillName(trimmed);
		if (errors.length > 0) {
			this.showError(`Invalid profile/situation name: ${errors.join(", ")}`);
			return this.createProfileFlow();
		}

		// Collision check
		const existing = this.settingsManager.getProfileRegistry().getProfile(trimmed);
		if (existing) {
			this.showError(`Profile/situation "${trimmed}" already exists`);
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
			...this.getAutoLearnModelOptions(),
		];

		return await new Promise<string | null | undefined>((resolve) => {
			this.showSelector((done) => {
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
		this.showSelector((done) => {
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
						this.showStatus(`Saved profile "${profileName}" to ${scope}.`);
						this.ui.requestRender();
					} catch (error) {
						this.showError(error instanceof Error ? error.message : String(error));
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
						this.showWarning(`Resource "${id}" of kind "${kind}" has no editable file path.`);
						void this.openNewProfileEditor(profileName, profileModel);
						return;
					}
					if (!fs.existsSync(resolvedEditPath)) {
						this.showError(`Resolved path for "${id}" does not exist: ${resolvedEditPath}`);
						void this.openNewProfileEditor(profileName, profileModel);
						return;
					}
					await this.openEditorForPath(resolvedEditPath);
					await this.handleReloadCommand();
					void this.openNewProfileEditor(profileName, profileModel);
				},
			});
			return { component: editor, focus: editor };
		});
	}

	private persistActiveProfile(scope: "session" | "directory" | "project" | "global"): void {
		const active = this.settingsManager.getActiveResourceProfileNames()[0];
		if (!active) {
			this.showError("No active profile to persist. Select one with /profiles first.");
			return;
		}
		try {
			if (scope === "session") {
				this.settingsManager.setRuntimeResourceProfiles([active]);
			} else {
				this.settingsManager.setActiveProfile(active, scope);
			}
			this.showStatus(`Active profile "${active}" persisted to ${scope}.`);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private deleteProfileFromSource(profileName: string): void {
		const profile = this.settingsManager.getProfileRegistry().getProfile(profileName);
		if (!profile) {
			this.showError(`Profile not found: ${profileName}`);
			return;
		}
		const scope = this.scopeForProfileSource(profile.source);
		try {
			this.settingsManager.deleteProfile(profileName, scope);
			this.showStatus(`Deleted profile "${profileName}" from ${scope}.`);
			void this.refreshAfterProfileMutation(profileName);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async addExternalResourceRootFlow(): Promise<void> {
		const rootPath = await new Promise<string | undefined>((resolve) => {
			this.showSelector((done) => {
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
					{ tui: this.ui },
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
			this.showError("Directory path cannot be empty");
			return;
		}

		const canonical = this.settingsManager.canonicalizePath(trimmed);
		if (!canonical) {
			this.showError(`Invalid path: ${trimmed}`);
			return;
		}

		// Prompt for trust confirmation (Yes/No)
		const trust = await new Promise<boolean>((resolve) => {
			this.showSelector((done) => {
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
			this.showStatus("Aborted. External root was not trusted.");
			return;
		}

		try {
			const currentRoots = this.settingsManager.getExternalResourceRoots();
			if (!currentRoots.includes(canonical)) {
				this.settingsManager.setExternalResourceRoots([...currentRoots, canonical], "global");
			}
			this.settingsManager.addTrustedResourceRoot(canonical, "global");
			this.showStatus(`Added trusted external root: ${canonical}`);
			await this.handleReloadCommand();
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
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

			this.showStatus(`Removed external root: ${root}`);
			await this.handleReloadCommand();
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async handleModelCommand(searchTerm?: string): Promise<void> {
		if (!searchTerm) {
			await this.showModelSelector();
			return;
		}

		const model = await this.findExactModelMatch(searchTerm);
		if (model) {
			try {
				await this.session.setModel(model);
				this.footer.invalidate();
				this.updateEditorBorderColor();
				this.showStatus(`Model: ${model.id}`);
				void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
				this.checkDaxnutsEasterEgg(model);
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		await this.showModelSelector(searchTerm);
	}

	private async findExactModelMatch(searchTerm: string): Promise<Model<any> | undefined> {
		const models = await this.getModelCandidates();
		return findExactModelReferenceMatch(searchTerm, models);
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
		try {
			await this.session.extensionRunner.emit({
				type: "model_selector_open",
				currentModel: this.session.model,
				scopedModels: this.session.scopedModels,
				initialSearchInput,
			});
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
			return;
		}

		this.showSelector((done) => {
			const selector = new ModelSelectorComponent(
				this.ui,
				this.session.model,
				this.settingsManager,
				this.session.modelRegistry,
				this.session.scopedModels,
				async (model) => {
					try {
						await this.session.setModel(model);
						this.footer.invalidate();
						this.updateEditorBorderColor();
						done();
						this.showStatus(`Model: ${model.id}`);
						void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
						this.checkDaxnutsEasterEgg(model);
					} catch (error) {
						done();
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				initialSearchInput,
			);
			return { component: selector, focus: selector };
		});
	}

	private async showModelsSelector(): Promise<void> {
		// Get all available models
		this.session.modelRegistry.refresh();
		const allModels = this.session.modelRegistry.getAvailable();

		if (allModels.length === 0) {
			this.showStatus("No models available");
			return;
		}

		// Check if session has scoped models (from previous session-only changes or CLI --models)
		const sessionScopedModels = this.session.scopedModels;
		const hasSessionScope = sessionScopedModels.length > 0;

		// Build enabled model IDs from session state or settings
		let currentEnabledIds: string[] | null = null;

		if (hasSessionScope) {
			// Use current session's scoped models
			currentEnabledIds = sessionScopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
		} else {
			// Fall back to settings
			const patterns = this.settingsManager.getEnabledModels();
			if (patterns !== undefined && patterns.length > 0) {
				const scopedModels = await resolveModelScope(patterns, this.session.modelRegistry);
				currentEnabledIds = scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
			}
		}

		// Helper to update session's scoped models (session-only, no persist)
		const updateSessionModels = async (enabledIds: string[] | null) => {
			currentEnabledIds = enabledIds === null ? null : [...enabledIds];
			if (enabledIds && enabledIds.length > 0 && enabledIds.length < allModels.length) {
				const newScopedModels = await resolveModelScope(enabledIds, this.session.modelRegistry);
				this.session.setScopedModels(
					newScopedModels.map((sm) => ({
						model: sm.model,
						thinkingLevel: sm.thinkingLevel,
					})),
				);
			} else {
				// All enabled or none enabled = no filter
				this.session.setScopedModels([]);
			}
			await this.updateAvailableProviderCount();
			this.ui.requestRender();
		};

		this.showSelector((done) => {
			const selector = new ScopedModelsSelectorComponent(
				{
					allModels,
					enabledModelIds: currentEnabledIds,
				},
				{
					onChange: async (enabledIds) => {
						await updateSessionModels(enabledIds);
					},
					onPersist: (enabledIds) => {
						// Persist to settings
						const newPatterns =
							enabledIds === null || enabledIds.length === allModels.length
								? undefined // All enabled = clear filter
								: enabledIds;
						this.settingsManager.setEnabledModels(newPatterns ? [...newPatterns] : undefined);
						this.showStatus("Model selection saved to settings");
					},
					onCancel: () => {
						done();
						this.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private showUserMessageSelector(newSessionName?: string): void {
		const userMessages = this.session.getUserMessagesForForking();

		if (userMessages.length === 0) {
			this.showStatus("No messages to fork from");
			return;
		}

		const initialSelectedId = userMessages[userMessages.length - 1]?.entryId;

		this.showSelector((done) => {
			const selector = new UserMessageSelectorComponent(
				userMessages.map((m) => ({ id: m.entryId, text: m.text })),
				async (entryId) => {
					try {
						const result = await this.runtimeHost.fork(entryId);
						if (result.cancelled) {
							done();
							this.ui.requestRender();
							return;
						}

						this.renderCurrentSessionState();
						if (newSessionName) {
							this.session.setSessionName(newSessionName);
						}
						this.editor.setText(result.selectedText ?? "");
						done();
						this.showStatus(
							newSessionName ? `Forked to new session: ${newSessionName}` : "Forked to new session",
						);
					} catch (error: unknown) {
						done();
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				initialSelectedId,
			);
			return { component: selector, focus: selector.getMessageList() };
		});
	}

	private async handleCloneCommand(newSessionName?: string): Promise<void> {
		const leafId = this.sessionManager.getLeafId();
		if (!leafId) {
			this.showStatus("Nothing to clone yet");
			return;
		}

		try {
			const result = await this.runtimeHost.fork(leafId, { position: "at" });
			if (result.cancelled) {
				this.ui.requestRender();
				return;
			}

			this.renderCurrentSessionState();
			if (newSessionName) {
				this.session.setSessionName(newSessionName);
			}
			this.editor.setText("");
			this.showStatus(newSessionName ? `Cloned to new session: ${newSessionName}` : "Cloned to new session");
		} catch (error: unknown) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private showTreeSelector(initialSelectedId?: string): void {
		const tree = this.sessionManager.getTree();
		const realLeafId = this.sessionManager.getLeafId();
		const initialFilterMode = this.settingsManager.getTreeFilterMode();

		if (tree.length === 0) {
			this.showStatus("No entries in session");
			return;
		}

		this.showSelector((done) => {
			const selector = new TreeSelectorComponent(
				tree,
				realLeafId,
				this.ui.terminal.rows,
				async (entryId) => {
					// Selecting the current leaf is a no-op (already there)
					if (entryId === realLeafId) {
						done();
						this.showStatus("Already at this point");
						return;
					}

					// Ask about summarization
					done(); // Close selector first

					// Loop until user makes a complete choice or cancels to tree
					let wantsSummary = false;
					let customInstructions: string | undefined;

					// Check if we should skip the prompt (user preference to always default to no summary)
					if (!this.settingsManager.getBranchSummarySkipPrompt()) {
						while (true) {
							const summaryChoice = await this.showExtensionSelector("Summarize branch?", [
								"No summary",
								"Summarize",
								"Summarize with custom prompt",
							]);

							if (summaryChoice === undefined) {
								// User pressed escape - re-show tree selector with same selection
								this.showTreeSelector(entryId);
								return;
							}

							wantsSummary = summaryChoice !== "No summary";

							if (summaryChoice === "Summarize with custom prompt") {
								customInstructions = await this.showExtensionEditor("Custom summarization instructions");
								if (customInstructions === undefined) {
									// User cancelled - loop back to summary selector
									continue;
								}
							}

							// User made a complete choice
							break;
						}
					}

					// Set up escape handler and loader if summarizing
					let summaryLoader: Loader | undefined;
					const originalOnEscape = this.defaultEditor.onEscape;

					if (wantsSummary) {
						this.defaultEditor.onEscape = () => {
							this.session.abortBranchSummary();
						};
						this.chatContainer.addChild(new Spacer(1));
						summaryLoader = new Loader(
							this.ui,
							(spinner) => theme.fg("accent", spinner),
							(text) => theme.fg("muted", text),
							`Summarizing branch... (${keyText("app.interrupt")} to cancel)`,
						);
						this.statusContainer.addChild(summaryLoader);
						this.ui.requestRender();
					}

					try {
						const result = await this.session.navigateTree(entryId, {
							summarize: wantsSummary,
							customInstructions,
						});

						if (result.aborted) {
							// Summarization aborted - re-show tree selector with same selection
							this.showStatus("Branch summarization cancelled");
							this.showTreeSelector(entryId);
							return;
						}
						if (result.cancelled) {
							this.showStatus("Navigation cancelled");
							return;
						}

						// Update UI
						await this.renderInitialMessages();
						if (result.editorText && !this.editor.getText().trim()) {
							this.editor.setText(result.editorText);
						}
						this.showStatus("Navigated to selected point");
						void this.flushCompactionQueue({ willRetry: false });
					} catch (error) {
						this.showError(error instanceof Error ? error.message : String(error));
					} finally {
						if (summaryLoader) {
							summaryLoader.stop();
							this.statusContainer.clear();
						}
						this.defaultEditor.onEscape = originalOnEscape;
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				(entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
					this.ui.requestRender();
				},
				initialSelectedId,
				initialFilterMode,
			);
			return { component: selector, focus: selector };
		});
	}

	private showTrustSelector(): void {
		const cwd = this.sessionManager.getCwd();
		const trustStore = new ProjectTrustStore(this.runtimeHost.services.agentDir);
		const savedDecision = trustStore.get(cwd);
		this.showSelector((done) => {
			const selector = new TrustSelectorComponent({
				cwd,
				savedDecision,
				projectTrusted: this.settingsManager.isProjectTrusted(),
				onSelect: (trusted) => {
					trustStore.set(cwd, trusted);
					done();
					this.showStatus(
						`Saved trust decision: ${trusted ? "trusted" : "untrusted"}. Restart pi for this to take effect.`,
					);
				},
				onCancel: () => {
					done();
					this.ui.requestRender();
				},
			});
			return { component: selector, focus: selector };
		});
	}

	private showSessionSelector(): void {
		this.showSelector((done) => {
			const selector = new SessionSelectorComponent(
				(onProgress) => listSessions(this.sessionManager.getCwd(), this.sessionManager.getSessionDir(), onProgress),
				(onProgress) =>
					this.sessionManager.usesDefaultSessionDir()
						? listAllSessions(onProgress)
						: listAllSessions(this.sessionManager.getSessionDir(), onProgress),
				async (sessionPath) => {
					done();
					await this.handleResumeSession(sessionPath);
				},
				() => {
					done();
					this.ui.requestRender();
				},
				() => {
					void this.shutdown();
				},
				() => this.ui.requestRender(),
				{
					renameSession: async (sessionFilePath: string, nextName: string | undefined) => {
						const next = (nextName ?? "").trim();
						if (!next) return;
						const mgr = openSession(sessionFilePath);
						mgr.appendSessionInfo(next);
					},
					showRenameHint: true,
					keybindings: this.keybindings,
				},

				this.sessionManager.getSessionFile(),
			);
			return { component: selector, focus: selector };
		});
	}

	private async handleResumeSession(
		sessionPath: string,
		options?: Parameters<ExtensionCommandContext["switchSession"]>[1],
	): Promise<{ cancelled: boolean }> {
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();
		try {
			const result = await this.runtimeHost.switchSession(sessionPath, {
				withSession: options?.withSession,
			});
			if (result.cancelled) {
				return result;
			}
			this.renderCurrentSessionState();
			this.showStatus("Resumed session");
			return result;
		} catch (error: unknown) {
			if (error instanceof MissingSessionCwdError) {
				const selectedCwd = await this.promptForMissingSessionCwd(error);
				if (!selectedCwd) {
					this.showStatus("Resume cancelled");
					return { cancelled: true };
				}
				const result = await this.runtimeHost.switchSession(sessionPath, {
					cwdOverride: selectedCwd,
					withSession: options?.withSession,
				});
				if (result.cancelled) {
					return result;
				}
				this.renderCurrentSessionState();
				this.showStatus("Resumed session in current cwd");
				return result;
			}
			return this.handleFatalRuntimeError("Failed to resume session", error);
		}
	}

	private getLoginProviderOptions(authType?: "oauth" | "api_key"): AuthSelectorProvider[] {
		const authStorage = this.session.modelRegistry.authStorage;
		const oauthProviders = authStorage.getOAuthProviders();
		const oauthProviderIds = new Set(oauthProviders.map((provider) => provider.id));
		const options: AuthSelectorProvider[] = oauthProviders.map((provider) => ({
			id: provider.id,
			name: provider.name,
			authType: "oauth",
		}));

		const modelProviders = new Set(this.session.modelRegistry.getAll().map((model) => model.provider));
		for (const providerId of modelProviders) {
			if (!isApiKeyLoginProvider(providerId, oauthProviderIds)) {
				continue;
			}
			options.push({
				id: providerId,
				name: this.session.modelRegistry.getProviderDisplayName(providerId),
				authType: "api_key",
			});
		}

		const filteredOptions = authType ? options.filter((option) => option.authType === authType) : options;
		return filteredOptions.sort((a, b) => a.name.localeCompare(b.name));
	}

	private getLogoutProviderOptions(): AuthSelectorProvider[] {
		const authStorage = this.session.modelRegistry.authStorage;
		const options: AuthSelectorProvider[] = [];

		for (const providerId of authStorage.list()) {
			const credential = authStorage.get(providerId);
			if (!credential) {
				continue;
			}
			options.push({
				id: providerId,
				name: this.session.modelRegistry.getProviderDisplayName(providerId),
				authType: credential.type,
			});
		}

		return options.sort((a, b) => a.name.localeCompare(b.name));
	}

	private resolveAuthProviderOption(
		providerReference: string,
		providerOptions: AuthSelectorProvider[],
	): AuthSelectorProvider | undefined {
		const normalized = providerReference.trim().toLowerCase();
		if (!normalized) return undefined;
		const exactMatch = providerOptions.find((provider) => {
			const id = provider.id.toLowerCase();
			const name = provider.name.toLowerCase();
			return id === normalized || name === normalized;
		});
		if (exactMatch) return exactMatch;
		const aliasTarget = cliProviderAliases[normalized] ?? normalized;
		return providerOptions.find((provider) => {
			const id = provider.id.toLowerCase();
			const name = provider.name.toLowerCase();
			return id === aliasTarget || name === aliasTarget;
		});
	}

	private async startProviderLogin(providerOption: AuthSelectorProvider): Promise<void> {
		if (providerOption.authType === "oauth") {
			await this.showLoginDialog(providerOption.id, providerOption.name);
		} else if (providerOption.id === BEDROCK_PROVIDER_ID) {
			this.showBedrockSetupDialog(providerOption.id, providerOption.name);
		} else {
			await this.showApiKeyLoginDialog(providerOption.id, providerOption.name);
		}
	}

	private showLoginAuthTypeSelector(): void {
		const subscriptionLabel = "Use a subscription";
		const apiKeyLabel = "Use an API key";
		this.showSelector((done) => {
			const selector = new ExtensionSelectorComponent(
				"Select authentication method:",
				[subscriptionLabel, apiKeyLabel],
				(option) => {
					done();
					const authType = option === subscriptionLabel ? "oauth" : "api_key";
					this.showLoginProviderSelector(authType);
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private showLoginProviderSelector(authType: "oauth" | "api_key"): void {
		const providerOptions = this.getLoginProviderOptions(authType);
		if (providerOptions.length === 0) {
			this.showStatus(
				authType === "oauth" ? "No subscription providers available." : "No API key providers available.",
			);
			return;
		}

		this.showSelector((done) => {
			const selector = new OAuthSelectorComponent(
				"login",
				this.session.modelRegistry.authStorage,
				providerOptions,
				async (providerId: string) => {
					done();

					const providerOption = providerOptions.find((provider) => provider.id === providerId);
					if (!providerOption) {
						return;
					}

					await this.startProviderLogin(providerOption);
				},
				() => {
					done();
					this.showLoginAuthTypeSelector();
				},
				(providerId) => this.session.modelRegistry.getProviderAuthStatus(providerId),
			);
			return { component: selector, focus: selector };
		});
	}

	private async showOAuthSelector(mode: "login" | "logout", providerReference?: string): Promise<void> {
		if (mode === "login") {
			if (providerReference) {
				const providerOptions = this.getLoginProviderOptions();
				const providerOption = this.resolveAuthProviderOption(providerReference, providerOptions);
				if (!providerOption) {
					this.showError(
						`Unknown login provider "${providerReference}". Use /login to select from available providers.`,
					);
					return;
				}
				await this.startProviderLogin(providerOption);
				return;
			}
			this.showLoginAuthTypeSelector();
			return;
		}

		const providerOptions = this.getLogoutProviderOptions();
		if (providerOptions.length === 0) {
			this.showStatus(
				"No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged.",
			);
			return;
		}

		if (providerReference) {
			const providerOption = this.resolveAuthProviderOption(providerReference, providerOptions);
			if (!providerOption) {
				this.showError(
					`No stored credentials found for "${providerReference}". Use /logout to select a saved provider.`,
				);
				return;
			}
			try {
				this.session.modelRegistry.authStorage.logout(providerOption.id);
				this.session.modelRegistry.refresh();
				await this.updateAvailableProviderCount();
				const message =
					providerOption.authType === "oauth"
						? `Logged out of ${providerOption.name}`
						: `Removed stored API key for ${providerOption.name}. Environment variables and models.json config are unchanged.`;
				this.showStatus(message);
			} catch (error: unknown) {
				this.showError(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			return;
		}

		this.showSelector((done) => {
			const selector = new OAuthSelectorComponent(
				mode,
				this.session.modelRegistry.authStorage,
				providerOptions,
				async (providerId: string) => {
					done();

					const providerOption = providerOptions.find((provider) => provider.id === providerId);
					if (!providerOption) {
						return;
					}

					try {
						this.session.modelRegistry.authStorage.logout(providerOption.id);
						this.session.modelRegistry.refresh();
						await this.updateAvailableProviderCount();
						const message =
							providerOption.authType === "oauth"
								? `Logged out of ${providerOption.name}`
								: `Removed stored API key for ${providerOption.name}. Environment variables and models.json config are unchanged.`;
						this.showStatus(message);
					} catch (error: unknown) {
						this.showError(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private async completeProviderAuthentication(
		providerId: string,
		providerName: string,
		authType: "oauth" | "api_key",
		previousModel: Model<any> | undefined,
	): Promise<void> {
		this.session.modelRegistry.refresh();

		const actionLabel = authType === "oauth" ? `Logged in to ${providerName}` : `Saved API key for ${providerName}`;

		let selectedModel: Model<any> | undefined;
		let selectionError: string | undefined;
		if (isUnknownModel(previousModel)) {
			const availableModels = this.session.modelRegistry.getAvailable();
			const providerModels = availableModels.filter((model) => model.provider === providerId);
			if (!hasDefaultModelProvider(providerId)) {
				selectionError = `${actionLabel}, but no default model is configured for provider "${providerId}". Use /model to select a model.`;
			} else if (providerModels.length === 0) {
				selectionError = `${actionLabel}, but no models are available for that provider. Use /model to select a model.`;
			} else {
				const defaultModelId = defaultModelPerProvider[providerId];
				selectedModel = providerModels.find((model) => model.id === defaultModelId);
				if (!selectedModel) {
					selectionError = `${actionLabel}, but its default model "${defaultModelId}" is not available. Use /model to select a model.`;
				} else {
					try {
						await this.session.setModel(selectedModel);
					} catch (error: unknown) {
						selectedModel = undefined;
						const errorMessage = error instanceof Error ? error.message : String(error);
						selectionError = `${actionLabel}, but selecting its default model failed: ${errorMessage}. Use /model to select a model.`;
					}
				}
			}
		}

		await this.updateAvailableProviderCount();
		this.footer.invalidate();
		this.updateEditorBorderColor();
		if (selectedModel) {
			this.showStatus(`${actionLabel}. Selected ${selectedModel.id}. Credentials saved to ${getAuthPath()}`);
			void this.maybeWarnAboutAnthropicSubscriptionAuth(selectedModel);
			this.checkDaxnutsEasterEgg(selectedModel);
		} else {
			this.showStatus(`${actionLabel}. Credentials saved to ${getAuthPath()}`);
			if (selectionError) {
				this.showError(selectionError);
			} else {
				void this.maybeWarnAboutAnthropicSubscriptionAuth();
			}
		}
	}

	private showBedrockSetupDialog(providerId: string, providerName: string): void {
		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		const dialog = new LoginDialogComponent(
			this.ui,
			providerId,
			() => restoreEditor(),
			providerName,
			"Amazon Bedrock setup",
		);
		dialog.showInfo([
			theme.fg("text", "Amazon Bedrock uses AWS credentials instead of a single API key."),
			theme.fg("text", "Configure an AWS profile, IAM keys, bearer token, or role-based credentials."),
			theme.fg("muted", "See:"),
			theme.fg("accent", `  ${path.join(getDocsPath(), "providers.md")}`),
		]);

		this.editorContainer.clear();
		this.editorContainer.addChild(dialog);
		this.ui.setFocus(dialog);
		this.ui.requestRender();
	}

	private async showApiKeyLoginDialog(providerId: string, providerName: string): Promise<void> {
		const previousModel = this.session.model;

		const dialog = new LoginDialogComponent(
			this.ui,
			providerId,
			(_success, _message) => {
				// Completion handled below
			},
			providerName,
		);

		this.editorContainer.clear();
		this.editorContainer.addChild(dialog);
		this.ui.setFocus(dialog);
		this.ui.requestRender();

		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		try {
			const apiKey = (await dialog.showPrompt("Enter API key:")).trim();
			if (!apiKey) {
				throw new Error("API key cannot be empty.");
			}

			this.session.modelRegistry.authStorage.set(providerId, { type: "api_key", key: apiKey });

			restoreEditor();
			await this.completeProviderAuthentication(providerId, providerName, "api_key", previousModel);
		} catch (error: unknown) {
			restoreEditor();
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (errorMsg !== "Login cancelled") {
				this.showError(`Failed to save API key for ${providerName}: ${errorMsg}`);
			}
		}
	}

	private showOAuthLoginSelect(dialog: LoginDialogComponent, prompt: OAuthSelectPrompt): Promise<string | undefined> {
		return new Promise((resolve) => {
			const restoreDialog = () => {
				this.editorContainer.clear();
				this.editorContainer.addChild(dialog);
				this.ui.setFocus(dialog);
				this.ui.requestRender();
			};
			const labels = prompt.options.map((option) => option.label);
			const selector = new ExtensionSelectorComponent(
				prompt.message,
				labels,
				(optionLabel) => {
					restoreDialog();
					resolve(prompt.options.find((option) => option.label === optionLabel)?.id);
				},
				() => {
					restoreDialog();
					resolve(undefined);
				},
			);
			this.editorContainer.clear();
			this.editorContainer.addChild(selector);
			this.ui.setFocus(selector);
			this.ui.requestRender();
		});
	}

	private async showLoginDialog(providerId: string, providerName: string): Promise<void> {
		const providerInfo = this.session.modelRegistry.authStorage
			.getOAuthProviders()
			.find((provider) => provider.id === providerId);
		const previousModel = this.session.model;

		// Providers that use callback servers (can paste redirect URL)
		const usesCallbackServer = providerInfo?.usesCallbackServer ?? false;

		// Create login dialog component
		const dialog = new LoginDialogComponent(
			this.ui,
			providerId,
			(_success, _message) => {
				// Completion handled below
			},
			providerName,
		);

		// Show dialog in editor container
		this.editorContainer.clear();
		this.editorContainer.addChild(dialog);
		this.ui.setFocus(dialog);
		this.ui.requestRender();

		// Promise for manual code input (racing with callback server)
		let manualCodeResolve: ((code: string) => void) | undefined;
		let manualCodeReject: ((err: Error) => void) | undefined;
		const manualCodePromise = new Promise<string>((resolve, reject) => {
			manualCodeResolve = resolve;
			manualCodeReject = reject;
		});

		// Restore editor helper
		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		try {
			await this.session.modelRegistry.authStorage.login(providerId as OAuthProviderId, {
				onAuth: (info: { url: string; instructions?: string }) => {
					dialog.showAuth(info.url, info.instructions);

					if (usesCallbackServer) {
						// Show input for manual paste, racing with callback
						dialog
							.showManualInput("Paste redirect URL below, or complete login in browser:")
							.then((value) => {
								if (value && manualCodeResolve) {
									manualCodeResolve(value);
									manualCodeResolve = undefined;
								}
							})
							.catch(() => {
								if (manualCodeReject) {
									manualCodeReject(new Error("Login cancelled"));
									manualCodeReject = undefined;
								}
							});
					}
					// For Anthropic: onPrompt is called immediately after
				},

				onDeviceCode: (info) => {
					dialog.showDeviceCode(info);
					dialog.showWaiting("Waiting for authentication...");
				},

				onPrompt: async (prompt: { message: string; placeholder?: string }) => {
					return dialog.showPrompt(prompt.message, prompt.placeholder);
				},

				onProgress: (message: string) => {
					dialog.showProgress(message);
				},

				onSelect: (prompt: OAuthSelectPrompt) => this.showOAuthLoginSelect(dialog, prompt),

				onManualCodeInput: () => manualCodePromise,

				signal: dialog.signal,
			});

			// Success
			restoreEditor();
			await this.completeProviderAuthentication(providerId, providerName, "oauth", previousModel);
		} catch (error: unknown) {
			restoreEditor();
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (errorMsg !== "Login cancelled") {
				this.showError(`Failed to login to ${providerName}: ${errorMsg}`);
			}
		}
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

		this.resetExtensionUI();

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
		this.editorContainer.clear();
		this.editorContainer.addChild(reloadBox);
		this.ui.setFocus(reloadBox);
		this.ui.requestRender(true);
		// Let the terminal paint the reload notice before CPU-heavy extension/theme
		// work begins. process.nextTick runs before I/O and can still make reloads
		// appear frozen.
		await new Promise((resolve) => setImmediate(resolve));

		const dismissReloadBox = (editor: Component) => {
			this.editorContainer.clear();
			this.editorContainer.addChild(editor);
			this.ui.setFocus(editor);
			this.ui.requestRender();
		};

		try {
			await this.session.reload();
			configureHttpDispatcher(this.settingsManager.getHttpIdleTimeoutMs());
			this.keybindings.reload();
			const activeHeader = this.customHeader ?? this.builtInHeader;
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
			this.setupExtensionShortcuts(runner);
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
			const activeHeader = this.customHeader ?? this.builtInHeader;
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
			this.setupExtensionShortcuts(runner);

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

	private async handleExportCommand(text: string): Promise<void> {
		const outputPath = this.getPathCommandArgument(text, "/export");

		try {
			if (outputPath?.endsWith(".jsonl")) {
				const filePath = this.session.exportToJsonl(outputPath);
				this.showStatus(`Session exported to: ${filePath}`);
			} else {
				const filePath = await this.session.exportToHtml(outputPath);
				this.showStatus(`Session exported to: ${filePath}`);
			}
		} catch (error: unknown) {
			this.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
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

	private async handleImportCommand(text: string): Promise<void> {
		const inputPath = this.getPathCommandArgument(text, "/import");
		if (!inputPath) {
			this.showError("Usage: /import <path.jsonl>");
			return;
		}

		const confirmed = await this.showExtensionConfirm("Import session", `Replace current session with ${inputPath}?`);
		if (!confirmed) {
			this.showStatus("Import cancelled");
			return;
		}

		try {
			if (this.loadingAnimation) {
				this.loadingAnimation.stop();
				this.loadingAnimation = undefined;
			}
			this.statusContainer.clear();
			const result = await this.runtimeHost.importFromJsonl(inputPath);
			if (result.cancelled) {
				this.showStatus("Import cancelled");
				return;
			}
			this.renderCurrentSessionState();
			this.showStatus(`Session imported from: ${inputPath}`);
		} catch (error: unknown) {
			if (error instanceof MissingSessionCwdError) {
				const selectedCwd = await this.promptForMissingSessionCwd(error);
				if (!selectedCwd) {
					this.showStatus("Import cancelled");
					return;
				}
				const result = await this.runtimeHost.importFromJsonl(inputPath, selectedCwd);
				if (result.cancelled) {
					this.showStatus("Import cancelled");
					return;
				}
				this.renderCurrentSessionState();
				this.showStatus(`Session imported from: ${inputPath}`);
				return;
			}
			if (error instanceof SessionImportFileNotFoundError) {
				this.showError(`Failed to import session: ${error.message}`);
				return;
			}
			await this.handleFatalRuntimeError("Failed to import session", error);
		}
	}

	private async handleShareCommand(): Promise<void> {
		// Check if gh is available and logged in
		try {
			const authResult = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
			if (authResult.status !== 0) {
				this.showError("GitHub CLI is not logged in. Run 'gh auth login' first.");
				return;
			}
		} catch {
			this.showError("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/");
			return;
		}

		// Export to a temp file
		const tmpFile = path.join(os.tmpdir(), "session.html");
		try {
			await this.session.exportToHtml(tmpFile);
		} catch (error: unknown) {
			this.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
			return;
		}

		// Show cancellable loader, replacing the editor
		const loader = new BorderedLoader(this.ui, theme, "Creating gist...");
		this.editorContainer.clear();
		this.editorContainer.addChild(loader);
		this.ui.setFocus(loader);
		this.ui.requestRender();

		const restoreEditor = () => {
			loader.dispose();
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			try {
				fs.unlinkSync(tmpFile);
			} catch {
				// Ignore cleanup errors
			}
		};

		// Create a secret gist asynchronously
		let proc: ReturnType<typeof spawn> | null = null;

		loader.onAbort = () => {
			proc?.kill();
			restoreEditor();
			this.showStatus("Share cancelled");
		};

		try {
			const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
				proc = spawn("gh", ["gist", "create", "--public=false", tmpFile]);
				let stdout = "";
				let stderr = "";
				proc.stdout?.on("data", (data) => {
					stdout += data.toString();
				});
				proc.stderr?.on("data", (data) => {
					stderr += data.toString();
				});
				proc.on("close", (code) => resolve({ stdout, stderr, code }));
			});

			if (loader.signal.aborted) return;

			restoreEditor();

			if (result.code !== 0) {
				const errorMsg = result.stderr?.trim() || "Unknown error";
				this.showError(`Failed to create gist: ${errorMsg}`);
				return;
			}

			// Extract gist ID from the URL returned by gh
			// gh returns something like: https://gist.github.com/username/GIST_ID
			const gistUrl = result.stdout?.trim();
			const gistId = gistUrl?.split("/").pop();
			if (!gistId) {
				this.showError("Failed to parse gist ID from gh output");
				return;
			}

			// Create the preview URL
			const previewUrl = getShareViewerUrl(gistId);
			this.showStatus(`Share URL: ${previewUrl}\nGist: ${gistUrl}`);
		} catch (error: unknown) {
			if (!loader.signal.aborted) {
				restoreEditor();
				this.showError(`Failed to create gist: ${error instanceof Error ? error.message : "Unknown error"}`);
			}
		}
	}

	private async handleCopyCommand(): Promise<void> {
		const text = this.session.getLastAssistantText();
		if (!text) {
			this.showError("No agent messages to copy yet.");
			return;
		}

		try {
			await copyToClipboard(text);
			this.showStatus("Copied last agent message to clipboard");
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private handleNameCommand(text: string): void {
		const name = text.replace(/^\/name\s*/, "").trim();
		if (!name) {
			const currentName = this.sessionManager.getSessionName();
			if (currentName) {
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(new Text(theme.fg("dim", `Session name: ${currentName}`), 1, 0));
			} else {
				this.showWarning("Usage: /name <name>");
			}
			this.ui.requestRender();
			return;
		}

		this.session.setSessionName(name);
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("dim", `Session name set: ${name}`), 1, 0));
		this.ui.requestRender();
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
		const parsed = this.parseGoalContinueCommand(text);
		if (!parsed.ok) {
			this.showError(parsed.error);
			return;
		}

		this.showStatus(
			`Goal continuation started: up to ${parsed.maxTurns} turn(s), stall limit ${parsed.maxStallTurns}, wall-clock limit ${parsed.maxWallClockMinutes || "disabled"} minute(s).`,
		);
		try {
			const result = await this.session.continueGoalLoop({
				maxTurns: parsed.maxTurns,
				maxStallTurns: parsed.maxStallTurns,
				maxWallClockMinutes: parsed.maxWallClockMinutes,
			});
			const continuation = result.finalSnapshot.continuation;
			this.showStatus(
				`Goal continuation stopped: ${result.stopReason}; submitted ${result.turnsSubmitted} turn(s); latest decision ${continuation.action}/${continuation.reasonCode}.`,
			);
		} catch (error) {
			this.showError(`Goal continuation failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.refreshAutonomyFooterStatus();
		}
	}

	private handleSessionCommand(): void {
		const stats = this.session.getSessionStats();
		const sessionName = this.sessionManager.getSessionName();

		let info = `${theme.bold("Session Info")}\n\n`;
		if (sessionName) {
			info += `${theme.fg("dim", "Name:")} ${sessionName}\n`;
		}
		info += `${theme.fg("dim", "File:")} ${stats.sessionFile ?? "In-memory"}\n`;
		info += `${theme.fg("dim", "ID:")} ${stats.sessionId}\n\n`;
		info += `${theme.bold("Messages")}\n`;
		info += `${theme.fg("dim", "User:")} ${stats.userMessages}\n`;
		info += `${theme.fg("dim", "Assistant:")} ${stats.assistantMessages}\n`;
		info += `${theme.fg("dim", "Tool Calls:")} ${stats.toolCalls}\n`;
		info += `${theme.fg("dim", "Tool Results:")} ${stats.toolResults}\n`;
		info += `${theme.fg("dim", "Total:")} ${stats.totalMessages}\n\n`;
		info += `${theme.bold("Tokens")}\n`;
		info += `${theme.fg("dim", "Input:")} ${stats.tokens.input.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}\n`;
		if (stats.tokens.cacheRead > 0) {
			info += `${theme.fg("dim", "Cache Read:")} ${stats.tokens.cacheRead.toLocaleString()}\n`;
		}
		if (stats.tokens.cacheWrite > 0) {
			info += `${theme.fg("dim", "Cache Write:")} ${stats.tokens.cacheWrite.toLocaleString()}\n`;
		}
		info += `${theme.fg("dim", "Total:")} ${stats.tokens.total.toLocaleString()}\n`;

		const dailyUsage = this.session.getDailyUsageTotals();
		if (stats.cost > 0 || dailyUsage.totalCost > 0) {
			info += `\n${theme.bold("Cost")}\n`;
			info += `${theme.fg("dim", "Total:")} $${stats.cost.toFixed(4)}\n`;
			info += `${this.session.getDailyUsageBreakdown((label) => theme.fg("dim", label))}`;
		}

		info += `\n\n${theme.bold("Model Router")}\n`;
		info += this.session.getModelRouterStatus((label) => theme.fg("dim", label));

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.ui.requestRender();
	}

	private handleUsageCommand(): void {
		const stats = this.session.getSessionStats();
		const spawned = this.session.getSpawnedUsage();
		const daily = this.session.getDailyUsageTotals();
		const context = this.session.getContextUsage();
		const autoLearn = this.getCurrentAutoLearnSettings();
		const costGuard = this.session.getLastCostGuardDecision();

		let info = `${theme.bold("Usage & Optimization")}\n\n`;
		info += `${theme.bold("Session tokens")}\n`;
		info += `${theme.fg("dim", "Input:")} ${stats.tokens.input.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Cache read:")} ${stats.tokens.cacheRead.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Cache write:")} ${stats.tokens.cacheWrite.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Total:")} ${stats.tokens.total.toLocaleString()}\n\n`;

		info += `${theme.bold("Cost")}\n`;
		info += `${theme.fg("dim", "Session:")} $${stats.cost.toFixed(4)}\n`;
		info += `${theme.fg("dim", "Spawned/background:")} $${spawned.cost.toFixed(4)} (${spawned.reports} reports)\n`;
		info += `${theme.fg("dim", "Today:")} $${daily.totalCost.toFixed(4)}\n`;
		info += `${theme.fg("dim", "Today own:")} $${daily.ownCost.toFixed(4)}\n`;
		info += `${theme.fg("dim", "Today spawned/background:")} $${daily.spawnedCost.toFixed(4)}\n`;
		info += `${theme.fg("dim", "Today tokens:")} ${daily.totalTokens.toLocaleString()}\n\n`;

		info += `${theme.bold("Optimization state")}\n`;
		const contextPercent = context?.percent;
		const contextTokens = context?.tokens;
		if (
			context &&
			contextPercent !== undefined &&
			contextPercent !== null &&
			contextTokens !== undefined &&
			contextTokens !== null
		) {
			info += `${theme.fg("dim", "Context:")} ${contextPercent.toFixed(1)}% (${contextTokens.toLocaleString()}/${context.contextWindow.toLocaleString()})\n`;
		} else {
			info += `${theme.fg("dim", "Context:")} unknown until next provider usage sample\n`;
		}
		info += `${theme.fg("dim", "Auto-compaction:")} ${this.session.autoCompactionEnabled ? "enabled" : "disabled"}\n`;
		if (costGuard) {
			const status = costGuard.over ? "over" : "ok";
			info += `${theme.fg("dim", "Cost guard:")} ${status} $${costGuard.estUsd.toFixed(4)}/$${costGuard.thresholdUsd.toFixed(4)} (${costGuard.action})\n`;
		} else {
			info += `${theme.fg("dim", "Cost guard:")} disabled\n`;
		}
		info += `${theme.fg("dim", "Auto Learn:")} ${autoLearn.enabled ? "enabled" : "disabled"}\n`;
		info += `${theme.fg("dim", "Scavenger model:")} ${autoLearn.model || "active"}\n`;
		info += `${theme.fg("dim", "Reflection review:")} ${autoLearn.reflectionReview ? "enabled" : "disabled"} (${autoLearn.reflectionMinToolCalls} tool-call trigger)\n`;
		info += `${theme.fg("dim", "Auto Learn concurrency:")} ${autoLearn.maxConcurrentLearners} learner(s), ${autoLearn.cooldownMinutes}m cooldown\n\n`;

		info += `${theme.bold("Model Router")}\n`;
		info += `${this.session.getModelRouterStatus((label) => theme.fg("dim", label))}\n\n`;

		info += `${theme.bold("Manual controls")}\n`;
		info += `${theme.fg("dim", "/compact")}: compact the active context now\n`;
		info += `${theme.fg("dim", "/settings")}: adjust Auto Learn, cost guard, compaction, and model-router config\n`;
		info += `${theme.fg("dim", "/auto-learn status|run")}: inspect or launch background learning\n`;
		info += `${theme.fg("dim", "context_audit")}: ask the agent to inspect provider-visible context contributors\n`;

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.ui.requestRender();
	}

	private handleChangelogCommand(): void {
		const changelogPath = getChangelogPath();
		const allEntries = parseChangelog(changelogPath);

		const changelogMarkdown =
			allEntries.length > 0
				? allEntries
						.reverse()
						.map((e) => e.content)
						.join("\n\n")
				: "No changelog entries found.";

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(changelogMarkdown, 1, 1, this.getMarkdownThemeWithSettings()));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
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
		// Navigation keybindings
		const cursorUp = this.getEditorKeyDisplay("tui.editor.cursorUp");
		const cursorDown = this.getEditorKeyDisplay("tui.editor.cursorDown");
		const cursorLeft = this.getEditorKeyDisplay("tui.editor.cursorLeft");
		const cursorRight = this.getEditorKeyDisplay("tui.editor.cursorRight");
		const cursorWordLeft = this.getEditorKeyDisplay("tui.editor.cursorWordLeft");
		const cursorWordRight = this.getEditorKeyDisplay("tui.editor.cursorWordRight");
		const cursorLineStart = this.getEditorKeyDisplay("tui.editor.cursorLineStart");
		const cursorLineEnd = this.getEditorKeyDisplay("tui.editor.cursorLineEnd");
		const jumpForward = this.getEditorKeyDisplay("tui.editor.jumpForward");
		const jumpBackward = this.getEditorKeyDisplay("tui.editor.jumpBackward");
		const pageUp = this.getEditorKeyDisplay("tui.editor.pageUp");
		const pageDown = this.getEditorKeyDisplay("tui.editor.pageDown");

		// Editing keybindings
		const submit = this.getEditorKeyDisplay("tui.input.submit");
		const newLine = this.getEditorKeyDisplay("tui.input.newLine");
		const deleteWordBackward = this.getEditorKeyDisplay("tui.editor.deleteWordBackward");
		const deleteWordForward = this.getEditorKeyDisplay("tui.editor.deleteWordForward");
		const deleteToLineStart = this.getEditorKeyDisplay("tui.editor.deleteToLineStart");
		const deleteToLineEnd = this.getEditorKeyDisplay("tui.editor.deleteToLineEnd");
		const yank = this.getEditorKeyDisplay("tui.editor.yank");
		const yankPop = this.getEditorKeyDisplay("tui.editor.yankPop");
		const undo = this.getEditorKeyDisplay("tui.editor.undo");
		const tab = this.getEditorKeyDisplay("tui.input.tab");

		// App keybindings
		const interrupt = this.getAppKeyDisplay("app.interrupt");
		const clear = this.getAppKeyDisplay("app.clear");
		const exit = this.getAppKeyDisplay("app.exit");
		const suspend = this.getAppKeyDisplay("app.suspend");
		const cycleThinkingLevel = this.getAppKeyDisplay("app.thinking.cycle");
		const cycleModelForward = this.getAppKeyDisplay("app.model.cycleForward");
		const selectModel = this.getAppKeyDisplay("app.model.select");
		const expandTools = this.getAppKeyDisplay("app.tools.expand");
		const toggleThinking = this.getAppKeyDisplay("app.thinking.toggle");
		const externalEditor = this.getAppKeyDisplay("app.editor.external");
		const cycleModelBackward = this.getAppKeyDisplay("app.model.cycleBackward");
		const followUp = this.getAppKeyDisplay("app.message.followUp");
		const dequeue = this.getAppKeyDisplay("app.message.dequeue");
		const pasteImage = this.getAppKeyDisplay("app.clipboard.pasteImage");

		let hotkeys = `
**Navigation**
| Key | Action |
|-----|--------|
| \`${cursorUp}\` / \`${cursorDown}\` / \`${cursorLeft}\` / \`${cursorRight}\` | Move cursor / browse history (Up when empty) |
| \`${cursorWordLeft}\` / \`${cursorWordRight}\` | Move by word |
| \`${cursorLineStart}\` | Start of line |
| \`${cursorLineEnd}\` | End of line |
| \`${jumpForward}\` | Jump forward to character |
| \`${jumpBackward}\` | Jump backward to character |
| \`${pageUp}\` / \`${pageDown}\` | Scroll by page |

**Editing**
| Key | Action |
|-----|--------|
| \`${submit}\` | Send message |
| \`${newLine}\` | New line${process.platform === "win32" ? " (Ctrl+Enter on Windows Terminal)" : ""} |
| \`${deleteWordBackward}\` | Delete word backwards |
| \`${deleteWordForward}\` | Delete word forwards |
| \`${deleteToLineStart}\` | Delete to start of line |
| \`${deleteToLineEnd}\` | Delete to end of line |
| \`${yank}\` | Paste the most-recently-deleted text |
| \`${yankPop}\` | Cycle through the deleted text after pasting |
| \`${undo}\` | Undo |

**Other**
| Key | Action |
|-----|--------|
| \`${tab}\` | Path completion / accept autocomplete |
| \`${interrupt}\` | Cancel autocomplete / abort streaming |
| \`${clear}\` | Clear editor (first) / exit (second) |
| \`${exit}\` | Exit (when editor is empty) |
| \`${suspend}\` | Suspend to background |
| \`${cycleThinkingLevel}\` | Cycle thinking level |
| \`${cycleModelForward}\` / \`${cycleModelBackward}\` | Cycle models |
| \`${selectModel}\` | Open model selector |
| \`${expandTools}\` | Toggle tool output expansion |
| \`${toggleThinking}\` | Toggle thinking block visibility |
| \`${externalEditor}\` | Edit message in external editor |
| \`${followUp}\` | Queue follow-up message |
| \`${dequeue}\` | Restore queued messages |
| \`${pasteImage}\` | Paste image from clipboard |
| \`/\` | Slash commands |
| \`!\` | Run bash command |
| \`!!\` | Run bash command (excluded from context) |
`;

		// Add extension-registered shortcuts
		const extensionRunner = this.session.extensionRunner;
		const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
		if (shortcuts.size > 0) {
			hotkeys += `
**Extensions**
| Key | Action |
|-----|--------|
`;
			for (const [key, shortcut] of shortcuts) {
				const description = shortcut.description ?? shortcut.extensionPath;
				const keyDisplay = formatKeyText(key, { capitalize: true });
				hotkeys += `| \`${keyDisplay}\` | ${description} |\n`;
			}
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "Keyboard Shortcuts")), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(hotkeys.trim(), 1, 1, this.getMarkdownThemeWithSettings()));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
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

	private async handleInstallResourcesCommand(argsString: string): Promise<void> {
		try {
			const tokens = argsString.split(/\s+/).filter(Boolean);
			let force = false;
			let dir = "";
			for (const t of tokens) {
				if (t === "--force") {
					force = true;
				} else {
					dir = t;
				}
			}

			if (!dir) {
				this.showError("Usage: /install-resources <dir> [--force]");
				return;
			}

			const canonical = this.settingsManager.canonicalizePath(dir);
			if (!canonical || !fs.existsSync(canonical)) {
				this.showError(`Source directory does not exist: ${dir}`);
				return;
			}

			const trustedRoots = this.settingsManager.getTrustedResourceRoots();
			const trusted = trustedRoots.includes(canonical);

			if (!trusted) {
				const trust = await new Promise<boolean>((resolve) => {
					this.showSelector((done) => {
						const submenu = new SelectSubmenu(
							"Trust external source for installation?",
							`The directory "${canonical}" contains extensions/resources to install. Extensions can execute arbitrary code on your machine. Do you trust it?`,
							[
								{
									value: "yes",
									label: "Yes",
									description: "Trust this directory and proceed with installation.",
								},
								{ value: "no", label: "No", description: "Do not trust this directory. Abort." },
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
					this.showStatus("Installation aborted. Source directory was not trusted.");
					return;
				}

				this.settingsManager.addTrustedResourceRoot(canonical, "global");
			}

			const subdirs = ["skills", "extensions", "prompts", "themes", "profiles", "agents"];
			const stats = { installed: [] as string[], skipped: [] as string[] };
			const userAgentDir = getAgentDir();

			for (const sub of subdirs) {
				const srcSub = path.join(canonical, sub);
				const destSub = path.join(userAgentDir, sub);
				if (fs.existsSync(srcSub)) {
					this.copyResourcesRecursively(srcSub, destSub, force, stats);
				}
			}

			const installedCount = stats.installed.length;
			const skippedCount = stats.skipped.length;
			this.showStatus(`Installation complete: ${installedCount} resources installed, ${skippedCount} skipped.`);

			await this.handleReloadCommand();
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	/**
	 * `/curate` — skill curator (#32). With no args, lists reflection-promoted skills proposed for
	 * archival (stale/unused) and pairs proposed for consolidation (overlapping). PROPOSE-ONLY: the user
	 * applies actions explicitly via `/curate archive <name>` / `/curate restore <name>`. Never touches
	 * hand-authored skills; archival is restorable.
	 */
	private handleCurateCommand(args: string): void {
		const [sub, name] = args.split(/\s+/, 2);
		if (sub === "archive" && name) {
			this.showStatus(
				this.session.archivePromotedSkill(name)
					? `Archived promoted skill '${name}'`
					: `Could not archive '${name}' (not a promoted skill?)`,
			);
			return;
		}
		if (sub === "restore" && name) {
			this.showStatus(
				this.session.restorePromotedSkill(name) ? `Restored skill '${name}'` : `Could not restore '${name}'`,
			);
			return;
		}
		const proposals = this.session.proposeSkillCuration();
		if (proposals.archive.length === 0 && proposals.consolidate.length === 0) {
			this.showStatus("Curator: no stale or overlapping promoted skills. Nothing to propose.");
			return;
		}
		const lines: string[] = ["Skill curator proposals (nothing applied automatically):"];
		for (const a of proposals.archive) {
			lines.push(`  • archive '${a.name}' — ${a.reason}  →  /curate archive ${a.name}`);
		}
		for (const c of proposals.consolidate) {
			lines.push(`  • consider merging '${c.names[0]}' + '${c.names[1]}' (overlap ${(c.overlap * 100) | 0}%)`);
		}
		this.showStatus(lines.join("\n"));
	}

	private async handleConfigBackupCommand(fileArg?: string): Promise<void> {
		try {
			const profilesDir = path.join(getAgentDir(), "profiles");
			const profiles: Record<string, any> = {};
			if (fs.existsSync(profilesDir)) {
				const entries = fs.readdirSync(profilesDir);
				for (const entry of entries) {
					if (entry.endsWith(".json")) {
						const pPath = path.join(profilesDir, entry);
						try {
							const content = fs.readFileSync(pPath, "utf-8");
							profiles[entry] = JSON.parse(content);
						} catch {
							// skip
						}
					}
				}
			}

			const backupData = {
				profiles,
				settings: {
					resourceProfiles: this.settingsManager.settings.resourceProfiles,
					activeResourceProfile: this.settingsManager.settings.activeResourceProfile,
					externalResourceRoots: this.settingsManager.settings.externalResourceRoots,
					trustedResourceRoots: this.settingsManager.settings.trustedResourceRoots,
				},
			};

			let targetFile = fileArg;
			if (!targetFile) {
				const backupsDir = path.join(getAgentDir(), "backups");
				fs.mkdirSync(backupsDir, { recursive: true });
				const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
				targetFile = path.join(backupsDir, `config-${timestamp}.json`);
			} else {
				const resolved = this.settingsManager.canonicalizePath(targetFile);
				if (resolved) {
					targetFile = resolved;
				}
			}

			fs.mkdirSync(path.dirname(targetFile), { recursive: true });
			fs.writeFileSync(targetFile, JSON.stringify(backupData, null, 2), "utf-8");
			this.showStatus(`Configuration backup saved to ${targetFile}`);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async handleConfigRestoreCommand(fileArg: string): Promise<void> {
		try {
			const trimmed = fileArg.trim();
			if (!trimmed) {
				this.showError("Usage: /config-restore <file>");
				return;
			}

			const resolved = this.settingsManager.canonicalizePath(trimmed);
			if (!resolved || !fs.existsSync(resolved)) {
				this.showError(`Backup file does not exist: ${trimmed}`);
				return;
			}

			let bundle: any;
			try {
				const content = fs.readFileSync(resolved, "utf-8");
				bundle = JSON.parse(content);
			} catch (error) {
				this.showError(`Failed to parse backup file: ${error instanceof Error ? error.message : String(error)}`);
				return;
			}

			if (!bundle || typeof bundle !== "object") {
				this.showError("Invalid backup file: must be a JSON object");
				return;
			}

			// Confirm before clobbering
			const confirm = await new Promise<boolean>((resolve) => {
				this.showSelector((done) => {
					const submenu = new SelectSubmenu(
						"Restore configuration?",
						"This will overwrite existing local profiles and settings with the backup values. Do you want to continue?",
						[
							{ value: "yes", label: "Yes", description: "Proceed with restoration." },
							{ value: "no", label: "No", description: "Cancel and abort." },
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

			if (!confirm) {
				this.showStatus("Restore aborted.");
				return;
			}

			// 1. Restore profile files (reusable-file scope)
			if (bundle.profiles && typeof bundle.profiles === "object") {
				const profilesDir = path.join(getAgentDir(), "profiles");
				fs.mkdirSync(profilesDir, { recursive: true });
				for (const [filename, content] of Object.entries(bundle.profiles)) {
					const targetPath = path.join(profilesDir, filename);
					fs.writeFileSync(targetPath, JSON.stringify(content, null, 2), "utf-8");
				}
			}

			// 2. Restore settings
			if (bundle.settings && typeof bundle.settings === "object") {
				const bs = bundle.settings;

				// Global profiles definitions
				if (bs.resourceProfiles && typeof bs.resourceProfiles === "object") {
					for (const [name, definition] of Object.entries(bs.resourceProfiles)) {
						this.settingsManager.setProfileDefinition(name, definition as any, "global");
					}
				}

				// Active profile selection
				if (bs.activeResourceProfile) {
					this.settingsManager.setActiveProfile(bs.activeResourceProfile, "global");
				}

				// External roots (trustedRoots are NOT restored, as per SECURITY requirement)
				if (Array.isArray(bs.externalResourceRoots)) {
					this.settingsManager.setExternalResourceRoots(bs.externalResourceRoots, "global");

					const currentTrusted = this.settingsManager.getTrustedResourceRoots();
					const newTrusted = currentTrusted.filter((r) => !bs.externalResourceRoots.includes(r));
					this.settingsManager.setTrustedResourceRoots(newTrusted, "global");
				}
			}

			this.showStatus("Configuration restored successfully.");
			await this.handleReloadCommand();
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private handleDebugCommand(): void {
		const width = this.ui.terminal.columns;
		const height = this.ui.terminal.rows;
		const allLines = this.ui.render(width);

		const debugLogPath = getDebugLogPath();
		const debugData = [
			`Debug output at ${new Date().toISOString()}`,
			`Terminal: ${width}x${height}`,
			`Total lines: ${allLines.length}`,
			"",
			"=== All rendered lines with visible widths ===",
			...allLines.map((line, idx) => {
				const vw = visibleWidth(line);
				const escaped = JSON.stringify(line);
				return `[${idx}] (w=${vw}) ${escaped}`;
			}),
			"",
			"=== Agent messages (JSONL) ===",
			...this.session.messages.map((msg) => JSON.stringify(msg)),
			"",
		].join("\n");

		fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
		fs.writeFileSync(debugLogPath, debugData);

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(`${theme.fg("accent", "✓ Debug log written")}\n${theme.fg("muted", debugLogPath)}`, 1, 1),
		);
		this.ui.requestRender();
	}

	private handleArminSaysHi(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new ArminComponent(this.ui));
		this.ui.requestRender();
	}

	private handleDementedDelves(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new EarendilAnnouncementComponent());
		this.ui.requestRender();
	}

	private handleDaxnuts(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DaxnutsComponent(this.ui));
		this.ui.requestRender();
	}

	private checkDaxnutsEasterEgg(model: { provider: string; id: string }): void {
		if (model.provider === "opencode" && model.id.toLowerCase().includes("kimi-k2.5")) {
			this.handleDaxnuts();
		}
	}

	private async handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
		const extensionRunner = this.session.extensionRunner;

		// Emit user_bash event to let extensions intercept
		const eventResult = await extensionRunner.emitUserBash({
			type: "user_bash",
			command,
			excludeFromContext,
			cwd: this.sessionManager.getCwd(),
		});

		// If extension returned a full result, use it directly
		if (eventResult?.result) {
			const result = eventResult.result;

			// Create UI component for display
			this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);
			if (this.session.isStreaming) {
				this.pendingMessagesContainer.addChild(this.bashComponent);
				this.pendingBashComponents.push(this.bashComponent);
			} else {
				this.chatContainer.addChild(this.bashComponent);
			}

			// Show output and complete
			if (result.output) {
				this.bashComponent.appendOutput(result.output);
			}
			this.bashComponent.setComplete(
				result.exitCode,
				result.cancelled,
				result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
				result.fullOutputPath,
			);

			// Record the result in session
			this.session.recordBashResult(command, result, { excludeFromContext });
			this.bashComponent = undefined;
			this.ui.requestRender();
			return;
		}

		// Normal execution path (possibly with custom operations)
		const isDeferred = this.session.isStreaming;
		this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);

		if (isDeferred) {
			// Show in pending area when agent is streaming
			this.pendingMessagesContainer.addChild(this.bashComponent);
			this.pendingBashComponents.push(this.bashComponent);
		} else {
			// Show in chat immediately when agent is idle
			this.chatContainer.addChild(this.bashComponent);
		}
		this.ui.requestRender();

		try {
			const result = await this.session.executeBash(
				command,
				(chunk) => {
					if (this.bashComponent) {
						this.bashComponent.appendOutput(chunk);
						this.ui.requestRender();
					}
				},
				{ excludeFromContext, operations: eventResult?.operations },
			);

			if (this.bashComponent) {
				this.bashComponent.setComplete(
					result.exitCode,
					result.cancelled,
					result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
					result.fullOutputPath,
				);
			}
		} catch (error) {
			if (this.bashComponent) {
				this.bashComponent.setComplete(undefined, false);
			}
			this.showError(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}

		this.bashComponent = undefined;
		this.ui.requestRender();
	}

	private async handleCompactCommand(customInstructions?: string): Promise<void> {
		const entries = this.sessionManager.getEntries();
		const messageCount = entries.filter((e) => e.type === "message").length;

		if (messageCount < 2) {
			this.showWarning("Nothing to compact (no messages yet)");
			return;
		}

		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();

		try {
			await this.session.compact(customInstructions);
		} catch {
			// Ignore, will be emitted as an event
		}
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
		this.clearExtensionTerminalInputListeners();
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
