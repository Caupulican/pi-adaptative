import type { Transport } from "@caupulican/pi-ai";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { minimatch } from "minimatch";
import { homedir } from "os";
import { basename, dirname, join, relative, resolve, sep } from "path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME, getAgentDir, getProfilesDir } from "../config.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import {
	DEFAULT_GOAL_AUTO_CONTINUE,
	DEFAULT_GOAL_AUTO_CONTINUE_DELAY_MS,
	DEFAULT_GOAL_CONTINUE_MAX_STALL_TURNS,
	DEFAULT_GOAL_CONTINUE_MAX_TURNS,
	DEFAULT_GOAL_CONTINUE_MAX_WALL_CLOCK_MINUTES,
	MAX_GOAL_AUTO_CONTINUE_DELAY_MS,
	MAX_GOAL_CONTINUE_MAX_STALL_TURNS,
	MAX_GOAL_CONTINUE_MAX_TURNS,
	MAX_GOAL_CONTINUE_MAX_WALL_CLOCK_MINUTES,
} from "./goals/goal-continuation-defaults.ts";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS, parseHttpIdleTimeoutMs } from "./http-dispatcher.ts";
import { ProfileRegistry } from "./profile-registry.ts";
import { mergeResourceProfileMap } from "./resource-profile-blocks.ts";
import { validateSkillName } from "./skills.ts";
import type { ToolkitScript } from "./toolkit/script-registry.ts";

export interface CompactionSettings {
	enabled?: boolean; // default: true
	reserveTokens?: number; // default: 16384
	keepRecentTokens?: number; // default: 20000
	triggerPercent?: number; // default: 0.7 — also compact past this fraction of the window (cost guard)
	model?: string; // default: "auto" — cheap auxiliary model for the summary; "auto" picks cheapest authed, else the session model
}

export interface SemanticMemoryGcSettings {
	enabled?: boolean; // default: true
	preserveRecentPages?: number; // default: 2
	minChars?: number; // default: 1200
	markers?: string[]; // default: Automata/Mind XML-ish response tags
}

export interface ContextGcSettings {
	enabled?: boolean; // default: true
	preserveRecentMessages?: number; // default: 12
	minToolResultChars?: number; // default: 2500
	tools?: string[]; // default: read,bash,rg,grep,context_headroom_retrieve,headroom_retrieve
	semanticMemory?: SemanticMemoryGcSettings;
}

/**
 * Conservative, opt-in first enforcement pilot for the context-policy layer (observe-only
 * by default -- see context/context-prompt-enforcement.ts). When enabled, stale
 * artifact-backed tool_output results outside the recent window are stubbed in place in
 * the provider-visible prompt only; the transcript/session history is never touched.
 */
export interface ContextPromptEnforcementSettings {
	enabled?: boolean; // default: false -- no behavior change unless explicitly opted in
	preserveRecentMessages?: number; // default: 8 (mirrors context-gc's own default recency window)
	minChars?: number; // default: 1200 (mirrors context-gc's own minToolResultChars default)
}

/**
 * Local memory retrieval (see context/memory-retrieval.ts, context/memory-prompt-block.ts):
 * when `enabled`, each turn queries the local, read-only Pi OKF memory provider under
 * `<agentDir>/okf-memory` (fixed path, not user-configurable in this slice) and stores a
 * report of source-labeled evidence. By default (`includeInPrompt` false) this is
 * report-only -- nothing is injected into the provider-visible prompt or transcript. When
 * `includeInPrompt` is also true, a single bounded, source-labeled, untrusted-content-
 * wrapped evidence block is appended to the provider-visible prompt each turn (never
 * written to the transcript/session history). External/non-local providers are never
 * constructed or queried by this setting.
 */
export interface MemoryRetrievalSettings {
	enabled?: boolean; // default: false -- no behavior change unless explicitly opted in
	maxResults?: number; // default: 5, clamped to [1, 20]
	includeInPrompt?: boolean; // default: false -- requires `enabled` too; report-only otherwise
}

export interface ContextCurationSettings {
	enabled?: boolean; // default: false -- the curator never runs unless explicitly opted in
	/** Local model ref ("provider/id" or bare id) used for curation jobs. Required to drain. */
	model?: string;
	maxJobsPerTurn?: number; // default: 4, clamped to [1, 16]
}

export interface ContextPolicySettings {
	enforcement?: ContextPromptEnforcementSettings;
	memory?: MemoryRetrievalSettings;
	curation?: ContextCurationSettings;
}

export const MEMORY_RETRIEVAL_MAX_RESULTS_MIN = 1;
export const MEMORY_RETRIEVAL_MAX_RESULTS_MAX = 20;
const MEMORY_RETRIEVAL_MAX_RESULTS_DEFAULT = 5;

function clampMemoryRetrievalMaxResults(value: number): number {
	return Math.min(MEMORY_RETRIEVAL_MAX_RESULTS_MAX, Math.max(MEMORY_RETRIEVAL_MAX_RESULTS_MIN, Math.trunc(value)));
}

export interface BranchSummarySettings {
	reserveTokens?: number; // default: 16384 (tokens reserved for prompt + LLM response)
	skipPrompt?: boolean; // default: false - when true, skips "Summarize branch?" prompt and defaults to no summary
}

export interface ProviderRetrySettings {
	timeoutMs?: number; // SDK/provider request timeout in milliseconds
	maxRetries?: number; // SDK/provider retry attempts
	maxRetryDelayMs?: number; // default: 60000 (max server-requested delay before failing)
}

export interface StreamStallSettings {
	connectMs?: number; // default: 120000 — max wait for the first stream event
	activeIdleMs?: number; // default: 180000 — max event gap while content is flowing
	quietIdleMs?: number; // default: 600000 — max event gap during prefill/unstreamed thinking; keep below httpIdleTimeoutMs
}

export interface RetrySettings {
	enabled?: boolean; // default: true
	maxRetries?: number; // default: 3
	baseDelayMs?: number; // default: 2000 (exponential backoff: 2s, 4s, 8s)
	provider?: ProviderRetrySettings;
	stall?: StreamStallSettings; // stream-stall watchdog bounds (pi-agent-core reliability/watchdogs.ts)
}

export interface TerminalSettings {
	showImages?: boolean; // default: true (only relevant if terminal supports images)
	imageWidthCells?: number; // default: 60 (preferred inline image width in terminal cells)
	clearOnShrink?: boolean; // default: false (clear empty rows when content shrinks)
	showTerminalProgress?: boolean; // default: false (OSC 9;4 terminal progress indicators)
}

export interface ImageSettings {
	autoResize?: boolean; // default: true (resize images to 2000x2000 max for better model compatibility)
	blockImages?: boolean; // default: false - when true, prevents all images from being sent to LLM providers
}

export interface ThinkingBudgetsSettings {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

export interface MarkdownSettings {
	codeBlockIndent?: string; // default: "  "
}

export interface WarningSettings {
	anthropicExtraUsage?: boolean; // default: true
}

export interface SelfModificationSettings {
	enabled?: boolean; // default: false
	sourcePath?: string; // Single pi-adaptative source tree path (legacy; still honored)
	sourcePaths?: string[]; // Ordered candidate source trees; first existing wins. Enables portable WSL/Termux switching from settings alone.
}

export type AutoLearnThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface AutoLearnSettings {
	enabled?: boolean; // default: false - autonomously trigger background history scavenging for long sessions
	model?: string; // "active" or omitted uses the current session model; otherwise a pi --model pattern
	thinkingLevel?: AutoLearnThinkingLevel; // default: low for background learner subprocesses
	longSessionMessages?: number; // default: 64
	longSessionContextPercent?: number; // default: 85
	cooldownMinutes?: number; // default: 1440 per session tenant (manual /auto-learn run bypasses)
	leaseMinutes?: number; // default: 90 for background learner state leases
	maxConcurrentLearners?: number; // default: 2 per session tenant
	applyHighConfidence?: boolean; // default: false unless the learning extension config opts in
	reflectionReview?: boolean; // default: true when Auto Learn is enabled - post-turn review after corrective/complex turns
	reflectionMinToolCalls?: number; // default: 12 tool calls in a turn before reflection review triggers
	reflectionCooldownMinutes?: number; // default: 1440 per session tenant for reflection reviews
	complexTaskToolCalls?: number; // default: 12 tool calls before bypassing reflection cooldown as a complex task
}

export type AutonomyMode = "off" | "safe" | "balanced" | "full";

export const DEFAULT_AUTONOMY_MAX_STALL_TURNS = DEFAULT_GOAL_CONTINUE_MAX_STALL_TURNS;
export const DEFAULT_AUTONOMY_GOAL_CONTINUE_TURNS = DEFAULT_GOAL_CONTINUE_MAX_TURNS;
export const DEFAULT_AUTONOMY_GOAL_CONTINUE_MAX_WALL_CLOCK_MINUTES = DEFAULT_GOAL_CONTINUE_MAX_WALL_CLOCK_MINUTES;
export const DEFAULT_AUTONOMY_GOAL_AUTO_CONTINUE = DEFAULT_GOAL_AUTO_CONTINUE;
export const DEFAULT_AUTONOMY_GOAL_AUTO_CONTINUE_DELAY_MS = DEFAULT_GOAL_AUTO_CONTINUE_DELAY_MS;

export interface AutonomySettings {
	mode?: AutonomyMode; // default: off; presets drive Auto Learn/reflection without many knobs
	maxStallTurns?: number; // default: 20; maximum no-progress rounds before goal continuation asks the user
	goalContinueTurns?: number; // default: 20; maximum continuation prompts per idle/explicit goal loop
	goalContinueMaxWallClockMinutes?: number; // default: 0; 0 disables wall-clock budget
	goalAutoContinue?: boolean; // default: true; auto-inject continuation prompts when an active goal is idle
	goalAutoContinueDelayMs?: number; // default: 0; delay before idle auto-continuation starts
}

export interface ModelRouterSettings {
	enabled?: boolean; // default: false — routing is opt-in until escalation safeguards are complete
	cheapModel?: string; // model pattern for read-only/research turns
	mediumModel?: string; // model pattern for normal scoped implementation, edits, and refactors
	expensiveModel?: string; // model pattern for modify/tool-heavy turns
	learningModel?: string; // model pattern for background reflection/learn/skill-creator work; "active" uses session model
	judgeEnabled?: boolean; // default: true — the routing judge runs automatically whenever the router is enabled and a judge model resolves
	judgeModel?: string; // model pattern for the routing-only judge; unset falls back to mediumModel
	executorModel?: string; // model pattern for the local executor lane (direct toolkit commands); unset disables it
	// Per-tier thinking (R1): overrides the inherited-and-clamped session thinking level for a routed
	// turn on that tier only (see agent-session.ts's routed-turn swap). Unset reproduces today's
	// behavior exactly — inherit the session thinking level, clamped to the routed model. learningModel
	// already has its own thinking via autoLearn.thinkingLevel, so there is deliberately no learningThinking.
	cheapThinking?: ThinkingLevel;
	mediumThinking?: ThinkingLevel;
	expensiveThinking?: ThinkingLevel;
	executorThinking?: ThinkingLevel; // thinking level for the executor-direct lane
	judgeThinking?: ThinkingLevel; // thinking level for the routing judge's own completion; unset keeps today's "off"
}

export const DEFAULT_RESEARCH_LANE_ENABLED = false;
export const DEFAULT_RESEARCH_LANE_MAX_USD = 0.25;
export const DEFAULT_RESEARCH_LANE_MAX_SOURCES = 8;
export const DEFAULT_RESEARCH_LANE_MAX_FINDINGS = 10;
export const DEFAULT_RESEARCH_LANE_MAX_WALL_CLOCK_MS = 120_000;
export const DEFAULT_RESEARCH_LANE_IDLE_DELAY_MS = 0;
export const DEFAULT_RESEARCH_LANE_MAX_RUNS_PER_SESSION = 10;
export const MAX_RESEARCH_LANE_MAX_USD = 5;
export const MAX_RESEARCH_LANE_MAX_SOURCES = 32;
export const MAX_RESEARCH_LANE_MAX_FINDINGS = 50;
export const MAX_RESEARCH_LANE_MAX_WALL_CLOCK_MS = 3_600_000;
export const MAX_RESEARCH_LANE_IDLE_DELAY_MS = 300_000;
export const MAX_RESEARCH_LANE_MAX_RUNS_PER_SESSION = 100;

export interface ResearchLaneSettings {
	enabled?: boolean; // default: false — autonomous background research is opt-in
	model?: string; // model pattern; unset inherits the session model the lane was shipped from
	profile?: string; // resource profile shipped with the lane: its model/soul/thinking/tool grants govern the lane
	systemPrompt?: string; // replaces the lane role prompt (the level-0 subagent core always remains)
	maxUsd?: number; // default: 0.25 per research pass; post-hoc breaches mark the lane budget_exhausted
	maxSources?: number; // default: 8 evidence sources per bundle
	maxFindings?: number; // default: 10 findings per bundle
	maxWallClockMs?: number; // default: 120000; 0 disables the wall-clock budget
	idleDelayMs?: number; // default: 0 — delay before idle-triggered research starts
	maxRunsPerSession?: number; // default: 10 idle-triggered research passes per session
}

export type ResolvedResearchLaneSettings = Required<Omit<ResearchLaneSettings, "model" | "profile" | "systemPrompt">> &
	Pick<ResearchLaneSettings, "model" | "profile" | "systemPrompt">;

export const DEFAULT_WORKER_DELEGATION_ENABLED = false;
export const DEFAULT_WORKER_DELEGATION_MAX_USD = 0.5;
export const DEFAULT_WORKER_DELEGATION_MAX_WALL_CLOCK_MS = 120_000;
export const MAX_WORKER_DELEGATION_MAX_USD = 5;
export const MAX_WORKER_DELEGATION_MAX_WALL_CLOCK_MS = 3_600_000;

export interface WorkerDelegationSettings {
	enabled?: boolean; // default: false — the delegate tool refuses (with a reason) until enabled
	model?: string; // model pattern; unset inherits the session model the lane was shipped from
	profile?: string; // resource profile shipped with the worker: its model/soul/thinking/tool grants govern the lane
	systemPrompt?: string; // replaces the worker role prompt (the level-0 subagent core always remains)
	maxUsd?: number; // default: 0.50 per delegated worker; post-hoc breaches mark the lane budget_exhausted
	maxWallClockMs?: number; // default: 120000; 0 disables the wall-clock budget
	writeEnabled?: boolean; // default: false — grants write_files so workers may emit file actions
	writePaths?: string[]; // envelope path scope for write workers (REQUIRED for writes; empty = writes refused)
	maxConcurrent?: number; // default: 1, clamped [1,3] — concurrent delegated workers
}

export type ResolvedWorkerDelegationSettings = Required<
	Omit<WorkerDelegationSettings, "model" | "profile" | "systemPrompt">
> &
	Pick<WorkerDelegationSettings, "model" | "profile" | "systemPrompt">;

export type LearningPolicyLayer =
	| "memory"
	| "skill"
	| "prompt"
	| "extension"
	| "tool"
	| "script"
	| "settings"
	| "source";

export const DEFAULT_LEARNING_POLICY_ENABLED = false;
export const DEFAULT_LEARNING_POLICY_AUTO_APPLY_ENABLED = false;
export const DEFAULT_LEARNING_POLICY_CONFIDENCE_THRESHOLD = 90;
export const DEFAULT_LEARNING_POLICY_MIN_OBSERVATIONS = 2;
export const DEFAULT_LEARNING_POLICY_ALLOWED_AUTO_APPLY_LAYERS: readonly LearningPolicyLayer[] = ["memory"];
export const DEFAULT_LEARNING_POLICY_REFLECTION_SOURCE_CONFIDENCE = 50;
export const DEFAULT_LEARNING_POLICY_AUTO_APPLY_SUPERSESSIONS = false;

export interface LearningPolicySettings {
	enabled?: boolean; // default: false — until enabled, reflection writes keep the legacy direct-apply path (now audited)
	autoApplyEnabled?: boolean; // default: false — with the policy on, writes become proposals unless auto-apply is enabled
	confidenceThreshold?: number; // default: 90 (0-100)
	minObservations?: number; // default: 2 — single-session cues do not auto-apply
	allowedAutoApplyLayers?: LearningPolicyLayer[]; // default: ["memory"] — every other layer stays proposal-first
	requireRollbackPlan?: boolean; // default: true — durable writes need a rollback plan to auto-apply
	reflectionSourceConfidence?: number; // default: 50 — trust assigned to single-session reflection cues (0-100)
	autoApplySupersessions?: boolean; // default: false — a memory_replace/memory_remove (supersedes/deletes an existing fact) stays a proposal even when otherwise eligible, unless explicitly opted in
}

export type ResolvedLearningPolicySettings = Required<LearningPolicySettings>;

export interface ToolkitSettings {
	/** The blessed daily-ops scripts run_toolkit_script may execute. Nothing else ever runs. */
	scripts?: ToolkitScript[];
}

export type ModelCapabilityMode = "auto" | "off" | "full" | "lean" | "minimal" | "chat";

export const DEFAULT_MODEL_CAPABILITY_MODE: ModelCapabilityMode = "auto";

export interface ModelCapabilitySettings {
	/**
	 * default: "auto" — derive the tool/lane surface from the model's context window so small open
	 * models stay usable for chat. "off" disables detection; a class name forces that class.
	 */
	mode?: ModelCapabilityMode;
}

export type TransportSetting = Transport;

/**
 * Package source for npm/git packages.
 * - String form: load all resources from the package
 * - Object form: filter which resources to load
 */
export type PackageSource =
	| string
	| {
			source: string;
			extensions?: string[];
			skills?: string[];
			prompts?: string[];
			themes?: string[];
	  };

export type ResourceProfileKind = "extensions" | "skills" | "prompts" | "themes" | "agents" | "tools";

export interface ResourceProfileFilterSettings {
	/** Allowlist patterns. When non-empty, only matching resources stay available. */
	allow?: string[];
	/** Blocklist patterns. Applied after allow. */
	block?: string[];
}

export type ResourceProfileSettings = Partial<Record<ResourceProfileKind, ResourceProfileFilterSettings>>;

export interface DisabledResourcesSettings {
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
	agents?: string[];
	tools?: string[];
}

export interface Settings {
	lastChangelogVersion?: string;
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	transport?: TransportSetting; // default: "auto"
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	theme?: string;
	/** Resource catalog directory (round resource management): the folder pi installs/updates/backs up from. */
	catalogDir?: string;
	compaction?: CompactionSettings;
	/** Proactive per-turn cost guard (#34). */
	costGuard?: { maxTurnUsd?: number; action?: "warn" | "downgrade" };
	/** Skill curator (#32): auto-archive stale reflection-promoted skills at session start. */
	curator?: { autoArchive?: boolean; staleDays?: number };
	contextGc?: ContextGcSettings;
	contextPolicy?: ContextPolicySettings;
	branchSummary?: BranchSummarySettings;
	retry?: RetrySettings;
	hideThinkingBlock?: boolean;
	shellPath?: string; // Custom shell path (e.g., for Cygwin users on Windows)
	quietStartup?: boolean;
	shellCommandPrefix?: string; // Prefix prepended to every bash command (e.g., "shopt -s expand_aliases" for alias support)
	npmCommand?: string[]; // Command used for npm package lookup/install operations, argv-style (e.g., ["mise", "exec", "node@20", "--", "npm"])
	collapseChangelog?: boolean; // Show condensed changelog after update (use /changelog for full)
	enableInstallTelemetry?: boolean; // default: true - anonymous version/update ping after changelog-detected updates
	packages?: PackageSource[]; // Array of npm/git package sources (string or object with filtering)
	extensions?: string[]; // Array of local extension file paths/directories or include/exclude patterns
	skills?: string[]; // Array of local skill file paths/directories or include/exclude patterns
	prompts?: string[]; // Array of local prompt template paths/directories or include/exclude patterns
	themes?: string[]; // Array of local theme file paths/directories or include/exclude patterns
	externalResourceRoots?: string[]; // External directory roots to scan for resources
	trustedResourceRoots?: string[]; // Explicitly trusted external directory roots (canonical absolute paths)
	disabledResources?: DisabledResourcesSettings; // Legacy reversible block filters for extensions/skills/prompts/themes/agents/tools
	resourceProfiles?: Record<string, ResourceProfileSettings>; // Named resource allow/block filters
	activeResourceProfile?: string | string[]; // Active profile name(s), applied after global/project/directory settings merge
	activeResourceProfiles?: string[]; // Active profile names, equivalent to activeResourceProfile array
	enableSkillCommands?: boolean; // default: true - register skills as /skill:name commands
	terminal?: TerminalSettings;
	images?: ImageSettings;
	enabledModels?: string[]; // Model patterns for cycling (same format as --models CLI flag)
	doubleEscapeAction?: "fork" | "tree" | "none"; // Action for double-escape with empty editor (default: "tree")
	treeFilterMode?: "default" | "no-tools" | "user-only" | "labeled-only" | "all"; // Default filter when opening /tree
	thinkingBudgets?: ThinkingBudgetsSettings; // Custom token budgets for thinking levels
	editorPaddingX?: number; // Horizontal padding for input editor (default: 0)
	autocompleteMaxVisible?: number; // Max visible items in autocomplete dropdown (default: 5)
	showHardwareCursor?: boolean; // Show terminal cursor while still positioning it for IME
	markdown?: MarkdownSettings;
	warnings?: WarningSettings;
	selfModification?: SelfModificationSettings; // Local guardrails for modifying the pi-adaptative source/harness
	autonomy?: AutonomySettings; // Low-config autonomy preset controlling background learning/reflection defaults
	researchLane?: ResearchLaneSettings; // Opt-in autonomous read-only research lane producing evidence bundles
	workerDelegation?: WorkerDelegationSettings; // Opt-in bounded scout-worker delegation via the delegate tool
	learningPolicy?: LearningPolicySettings; // Opt-in learning apply policy: proposal-first durable writes with audit/rollback
	modelCapability?: ModelCapabilitySettings; // Auto-detected small-model tool/lane surface (default: auto)
	toolkit?: ToolkitSettings; // User's blessed daily-ops script registry for run_toolkit_script
	modelRouter?: ModelRouterSettings; // Opt-in deterministic cheap/expensive model routing foundation
	autoLearn?: AutoLearnSettings; // Setting-gated autonomous background learning for long sessions
	sessionDir?: string; // Custom session storage directory (same format as --session-dir CLI flag)
	httpIdleTimeoutMs?: number; // HTTP header/body idle timeout in ms; 0 disables it. Keep above retry.stall.quietIdleMs or the HTTP layer kills quiet streams before the stall watchdog can
	websocketConnectTimeoutMs?: number; // WebSocket connect/open handshake timeout in milliseconds; 0 disables it
}

/** Deep merge settings: project/overrides take precedence, nested objects merge recursively */
function deepMergeSettings(base: Settings, overrides: Settings): Settings {
	const result: Settings = { ...base };

	for (const key of Object.keys(overrides) as (keyof Settings)[]) {
		const overrideValue = overrides[key];
		const baseValue = base[key];

		if (overrideValue === undefined) {
			continue;
		}

		// For nested objects, merge recursively
		if (
			typeof overrideValue === "object" &&
			overrideValue !== null &&
			!Array.isArray(overrideValue) &&
			typeof baseValue === "object" &&
			baseValue !== null &&
			!Array.isArray(baseValue)
		) {
			(result as Record<string, unknown>)[key] = { ...baseValue, ...overrideValue };
		} else {
			// For primitives and arrays, override value wins
			(result as Record<string, unknown>)[key] = overrideValue;
		}
	}

	return result;
}

function toPosixPath(p: string): string {
	return p.split(sep).join("/");
}

function findDirectoryProfileRoot(cwd: string): string {
	let current = resolvePath(cwd);
	while (true) {
		for (const marker of [".git", ".hg", ".svn"]) {
			try {
				statSync(join(current, marker));
				return current;
			} catch {}
		}
		const parent = resolve(current, "..");
		if (parent === current) return resolvePath(cwd);
		current = parent;
	}
}

export interface DirectoryResourceProfileInfo {
	root: string;
	hash: string;
	path: string;
}

export function getDirectoryResourceProfileInfo(
	cwd: string,
	agentDir: string = getAgentDir(),
): DirectoryResourceProfileInfo {
	const root = findDirectoryProfileRoot(cwd);
	const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
	return {
		root,
		hash,
		path: join(resolvePath(agentDir), "resource-profiles", hash, "settings.json"),
	};
}

export function matchesResourceProfilePattern(resourcePath: string, patterns: string[], baseDir = ""): boolean {
	if (patterns.length === 0) return false;
	const resolvedBase = baseDir ? resolvePath(baseDir) : "";
	const rel = resolvedBase ? toPosixPath(relative(resolvedBase, resourcePath)) : toPosixPath(resourcePath);
	const name = basename(resourcePath);
	const filePathPosix = toPosixPath(resourcePath);
	const parentDir = dirname(resourcePath);
	const parentRel = resolvedBase ? toPosixPath(relative(resolvedBase, parentDir)) : toPosixPath(parentDir);
	const parentName = basename(parentDir);
	const parentDirPosix = toPosixPath(parentDir);

	return patterns.some((pattern) => {
		const normalizedPattern = toPosixPath(pattern);
		return (
			minimatch(rel, normalizedPattern) ||
			minimatch(name, normalizedPattern) ||
			minimatch(filePathPosix, normalizedPattern) ||
			minimatch(parentRel, normalizedPattern) ||
			minimatch(parentName, normalizedPattern) ||
			minimatch(parentDirPosix, normalizedPattern)
		);
	});
}

function normalizeResourceProfileNames(value: unknown): string[] {
	const values: string[] = [];
	const add = (candidate: unknown) => {
		if (Array.isArray(candidate)) {
			for (const item of candidate) add(item);
			return;
		}
		if (typeof candidate === "string") {
			for (const part of candidate.split(",")) {
				const trimmed = part.trim();
				if (trimmed) values.push(trimmed);
			}
		}
	};
	add(value);
	return [...new Set(values)];
}

function hasExplicitActiveResourceProfileSelection(settings: Settings): boolean {
	return Object.hasOwn(settings, "activeResourceProfiles") || Object.hasOwn(settings, "activeResourceProfile");
}

function normalizeActiveResourceProfiles(settings: Settings): string[] {
	const explicitProfiles = normalizeResourceProfileNames(settings.activeResourceProfiles);
	const values =
		explicitProfiles.length > 0 ? explicitProfiles : normalizeResourceProfileNames(settings.activeResourceProfile);
	if (
		values.length === 0 &&
		!hasExplicitActiveResourceProfileSelection(settings) &&
		settings.resourceProfiles?.default
	) {
		values.push("default");
	}
	return [...new Set(values)];
}

function appendFilter(target: ResourceProfileFilterSettings, source?: ResourceProfileFilterSettings): void {
	if (!source) return;
	if (Array.isArray(source.allow)) target.allow = [...(target.allow ?? []), ...source.allow];
	if (Array.isArray(source.block)) target.block = [...(target.block ?? []), ...source.block];
}

function collectLegacyDisabledFilterFromSettings(
	settings: Settings,
	kind: ResourceProfileKind,
): ResourceProfileFilterSettings {
	const legacyDisabled = settings.disabledResources?.[kind];
	return Array.isArray(legacyDisabled) ? { block: legacyDisabled } : {};
}

function mergeResourceProfileFilters(...filters: ResourceProfileFilterSettings[]): ResourceProfileFilterSettings {
	const result: ResourceProfileFilterSettings = {};
	for (const filter of filters) appendFilter(result, filter);
	return result;
}

function parseTimeoutSetting(value: unknown, settingName: string): number | undefined {
	const timeoutMs = parseHttpIdleTimeoutMs(value);
	if (timeoutMs !== undefined) {
		return timeoutMs;
	}
	if (value !== undefined) {
		throw new Error(`Invalid ${settingName} setting: ${String(value)}`);
	}
	return undefined;
}

/** Stall bounds must be strictly positive — 0 is not "disabled" here (it would stall instantly). */
function parseStallBoundMs(value: unknown, settingName: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`Invalid ${settingName} setting: ${String(value)}`);
	}
	return Math.floor(value);
}

function sanitizeIntegerSetting(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
	if (value < min || value > max) return fallback;
	return value;
}

function sanitizeNumberSetting(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	if (value < min || value > max) return fallback;
	return value;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ProfileDefinitionInput {
	name?: string;
	description?: string;
	model?: string;
	thinking?: ThinkingLevel;
	modelRouter?: ModelRouterSettings;
	/**
	 * Situational identity (R6): a system-prompt prefix injected while this profile is active, so a
	 * profile becomes a full "situation" = soul + capabilities + model/thinking, switched atomically.
	 */
	soul?: string;
	resources: ResourceProfileSettings;
}

export type ProfilePersistenceScope = "session" | "directory" | "project" | "global" | "reusable-file";

const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && VALID_THINKING_LEVELS.includes(value as ThinkingLevel);
}

function asStringArrayWithPattern(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const values = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
	return values.length > 0 ? values : undefined;
}

function normalizeProfileFilterResource(value: unknown): ResourceProfileFilterSettings {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("resource profile filter must be an object");
	}
	const filter = value as Record<string, unknown>;
	return {
		allow: asStringArrayWithPattern(filter.allow),
		block: asStringArrayWithPattern(filter.block),
	};
}

function normalizeProfileResources(value: unknown): ResourceProfileSettings {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("resources must be an object");
	}
	const input = value as Record<string, unknown>;
	const result: ResourceProfileSettings = {};
	for (const kind of ["extensions", "skills", "prompts", "themes", "agents", "tools"] as const) {
		if (input[kind] === undefined) continue;
		result[kind] = normalizeProfileFilterResource(input[kind]);
	}
	return result;
}

function normalizeModelRouterSettings(value: unknown): ModelRouterSettings | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	const settings: ModelRouterSettings = {};
	if (typeof input.enabled === "boolean") settings.enabled = input.enabled;
	for (const key of ["cheapModel", "mediumModel", "expensiveModel", "learningModel"] as const) {
		const candidate = input[key];
		if (typeof candidate !== "string") continue;
		const trimmed = candidate.trim();
		if (trimmed) settings[key] = trimmed;
	}
	return Object.keys(settings).length > 0 ? settings : undefined;
}

function parseProfileFileDefinition(content: string): ProfileDefinitionInput {
	const parsed = JSON.parse(content) as Record<string, unknown>;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("profile file must contain a JSON object");
	}
	const name = typeof parsed.name === "string" ? parsed.name.trim() : undefined;
	if (!name) {
		throw new Error("profile name is required");
	}
	const resourceSection = parsed.resources ?? {};
	return {
		name,
		description: typeof parsed.description === "string" ? parsed.description.trim() || undefined : undefined,
		model: typeof parsed.model === "string" ? parsed.model.trim() || undefined : undefined,
		thinking: isThinkingLevel(parsed.thinking) ? parsed.thinking : undefined,
		modelRouter: normalizeModelRouterSettings(parsed.modelRouter),
		soul: typeof parsed.soul === "string" ? parsed.soul.trim() || undefined : undefined,
		resources: normalizeProfileResources(resourceSection),
	};
}

export type SettingsScope = "global" | "project" | "directoryProfile";
export type SettingsErrorScope = SettingsScope;

export interface SettingsManagerCreateOptions {
	projectTrusted?: boolean;
}

export interface SettingsStorage {
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
	getProfilesDir?(): string;
}

export interface SettingsError {
	scope: SettingsErrorScope;
	error: Error;
}

export class FileSettingsStorage implements SettingsStorage {
	private globalSettingsPath: string;
	private projectSettingsPath: string;
	private directoryProfileInfo: DirectoryResourceProfileInfo;
	private profilesDir: string;

	constructor(cwd: string, agentDir: string) {
		const resolvedCwd = resolvePath(cwd);
		const resolvedAgentDir = resolvePath(agentDir);
		this.globalSettingsPath = join(resolvedAgentDir, "settings.json");
		this.projectSettingsPath = join(resolvedCwd, CONFIG_DIR_NAME, "settings.json");
		this.directoryProfileInfo = getDirectoryResourceProfileInfo(resolvedCwd, resolvedAgentDir);
		this.profilesDir = getProfilesDir(resolvedAgentDir);
	}

	getDirectoryResourceProfileInfo(): DirectoryResourceProfileInfo {
		return { ...this.directoryProfileInfo };
	}

	getProfilesDir(): string {
		return this.profilesDir;
	}

	readDirectoryResourceProfile(): string | undefined {
		const path = this.directoryProfileInfo.path;
		return existsSync(path) ? readFileSync(path, "utf-8") : undefined;
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire settings lock");
	}

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const path =
			scope === "global"
				? this.globalSettingsPath
				: scope === "project"
					? this.projectSettingsPath
					: this.directoryProfileInfo.path;
		const dir = dirname(path);

		let release: (() => void) | undefined;
		try {
			// Only create directory and lock if file exists or we need to write
			const fileExists = existsSync(path);
			if (fileExists) {
				release = this.acquireLockSyncWithRetry(path);
			}
			const current = fileExists ? readFileSync(path, "utf-8") : undefined;
			const next = fn(current);
			if (next !== undefined) {
				// Only create directory when we actually need to write
				if (!existsSync(dir)) {
					mkdirSync(dir, { recursive: true });
				}
				if (!release) {
					release = this.acquireLockSyncWithRetry(path);
				}
				writeFileSync(path, next, "utf-8");
			}
		} finally {
			if (release) {
				release();
			}
		}
	}
}

export class InMemorySettingsStorage implements SettingsStorage {
	private global: string | undefined;
	private project: string | undefined;
	private directoryProfile: string | undefined;

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const current = scope === "global" ? this.global : scope === "project" ? this.project : this.directoryProfile;
		const next = fn(current);
		if (next === undefined) {
			return;
		}
		if (scope === "global") {
			this.global = next;
			return;
		}
		if (scope === "project") {
			this.project = next;
			return;
		}
		this.directoryProfile = next;
	}
}

export class SettingsManager {
	private storage: SettingsStorage;
	private globalSettings: Settings;
	private projectSettings: Settings;
	private directoryProfileSettings: Settings;
	private runtimeResourceProfiles: string[] | undefined;
	private inlineResourceProfileDefinitions: Record<string, ResourceProfileSettings> = {};
	private discoveredResourceProfileDefinitions: Record<string, ResourceProfileSettings> = {};
	settings: Settings;
	private projectTrusted: boolean;
	private modifiedFields = new Set<keyof Settings>(); // Track global fields modified during session
	private modifiedNestedFields = new Map<keyof Settings, Set<string>>(); // Track global nested field modifications
	private modifiedProjectFields = new Set<keyof Settings>(); // Track project fields modified during session
	private modifiedProjectNestedFields = new Map<keyof Settings, Set<string>>(); // Track project nested field modifications
	private globalSettingsLoadError: Error | null = null; // Track if global settings file had parse errors
	private projectSettingsLoadError: Error | null = null; // Track if project settings file had parse errors
	private directoryProfileInfo: DirectoryResourceProfileInfo | null = null;
	private profileRegistry!: ProfileRegistry;
	private writeQueue: Promise<void> = Promise.resolve();
	private errors: SettingsError[];

	private constructor(
		storage: SettingsStorage,
		initialGlobal: Settings,
		initialProject: Settings,
		initialDirectoryProfile: Settings = {},
		globalLoadError: Error | null = null,
		projectLoadError: Error | null = null,
		initialErrors: SettingsError[] = [],
		projectTrusted = true,
		directoryProfileInfo: DirectoryResourceProfileInfo | null = null,
	) {
		this.storage = storage;
		this.globalSettings = initialGlobal;
		this.projectSettings = initialProject;
		this.directoryProfileSettings = initialDirectoryProfile;
		this.projectTrusted = projectTrusted;
		this.globalSettingsLoadError = globalLoadError;
		this.projectSettingsLoadError = projectLoadError;
		this.directoryProfileInfo = directoryProfileInfo;
		this.errors = [...initialErrors];
		this.settings = this.mergeEffectiveSettings();
		this.refreshProfileRegistry();
	}

	private createProfileRegistry(): ProfileRegistry {
		return new ProfileRegistry({
			globalSettings: this.globalSettings,
			projectSettings: this.projectSettings,
			directoryProfileSettings: this.directoryProfileSettings,
			inlineResourceProfileDefinitions: this.inlineResourceProfileDefinitions,
			discoveredResourceProfileDefinitions: this.discoveredResourceProfileDefinitions,
			profilesDir: this.storage.getProfilesDir?.(),
			externalResourceRoots: this.getEffectiveExternalResourceRoots(),
		});
	}

	private profileDiagnosticKeys = new Set<string>();
	private reportProfileDiagnostic(scope: SettingsErrorScope, message: string): void {
		const key = `${scope}:${message}`;
		if (this.profileDiagnosticKeys.has(key)) {
			return;
		}
		this.profileDiagnosticKeys.add(key);
		this.errors.push({ scope, error: new Error(message) });
	}

	private getActiveProfileNamesForDiagnostics(): string[] {
		// Mirror getActiveResourceProfileNames()'s source precedence (runtime profiles from
		// --resource-profile take priority) so a bad runtime profile name still surfaces a
		// "profile not found" diagnostic instead of silently applying zero filtering.
		if (this.runtimeResourceProfiles && this.runtimeResourceProfiles.length > 0) {
			return normalizeResourceProfileNames(this.runtimeResourceProfiles);
		}
		const explicitProfiles =
			this.settings.activeResourceProfiles && this.settings.activeResourceProfiles.length > 0
				? this.settings.activeResourceProfiles
				: this.settings.activeResourceProfile
					? [this.settings.activeResourceProfile]
					: [];
		const names = normalizeResourceProfileNames(explicitProfiles);
		return names.length > 0 || hasExplicitActiveResourceProfileSelection(this.settings)
			? names
			: this.getExternalRootActiveResourceProfileNames();
	}

	private getExternalRootActiveResourceProfileNames(): string[] {
		const names: string[] = [];
		for (const root of this.getEffectiveExternalResourceRoots()) {
			try {
				const settingsPath = join(root, "settings.json");
				if (!existsSync(settingsPath)) continue;
				const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as Settings;
				names.push(...normalizeActiveResourceProfiles(parsed));
			} catch {
				// External-root settings are optional; ignore malformed files for active-profile fallback.
			}
		}
		return [...new Set(names)];
	}

	private refreshProfileRegistry(): void {
		this.profileDiagnosticKeys.clear();
		this.profileRegistry = this.createProfileRegistry();
		const registryDiagnostics = this.profileRegistry.listDiagnostics();
		for (const diagnostic of registryDiagnostics) {
			const path = diagnostic.path ? ` (${diagnostic.path})` : "";
			this.reportProfileDiagnostic("global", `Profile diagnostic${path}: ${diagnostic.message}`);
		}
		for (const profileName of this.getActiveProfileNamesForDiagnostics()) {
			if (!this.profileRegistry.getProfile(profileName)) {
				this.reportProfileDiagnostic("global", `Active profile not found: ${profileName}`);
			}
		}
	}

	private mergeEffectiveSettings(): Settings {
		let merged = deepMergeSettings(this.globalSettings, this.projectSettings);
		merged = deepMergeSettings(merged, this.directoryProfileSettings);
		if (this.runtimeResourceProfiles) {
			merged = deepMergeSettings(merged, { activeResourceProfiles: this.runtimeResourceProfiles });
		}
		return merged;
	}

	private recomputeSettings(): void {
		this.settings = this.mergeEffectiveSettings();
		this.refreshProfileRegistry();
	}

	/** Create a SettingsManager that loads from files */
	static create(
		cwd: string,
		agentDir: string = getAgentDir(),
		options: SettingsManagerCreateOptions = {},
	): SettingsManager {
		const storage = new FileSettingsStorage(cwd, agentDir);
		return SettingsManager.fromStorage(storage, options);
	}

	/** Create a SettingsManager from an arbitrary storage backend */
	static fromStorage(storage: SettingsStorage, options: SettingsManagerCreateOptions = {}): SettingsManager {
		const projectTrusted = options.projectTrusted ?? true;
		const globalLoad = SettingsManager.tryLoadFromStorage(storage, "global");
		const projectLoad = SettingsManager.tryLoadFromStorage(storage, "project", projectTrusted);
		const directoryProfileLoad = SettingsManager.tryLoadDirectoryProfileFromStorage(storage);
		const initialErrors: SettingsError[] = [];
		if (globalLoad.error) {
			initialErrors.push({ scope: "global", error: globalLoad.error });
		}
		if (projectLoad.error) {
			initialErrors.push({ scope: "project", error: projectLoad.error });
		}
		if (directoryProfileLoad.error) {
			initialErrors.push({ scope: "directoryProfile", error: directoryProfileLoad.error });
		}

		return new SettingsManager(
			storage,
			globalLoad.settings,
			projectLoad.settings,
			directoryProfileLoad.settings,
			globalLoad.error,
			projectLoad.error,
			initialErrors,
			projectTrusted,
			directoryProfileLoad.info,
		);
	}

	/** Create an in-memory SettingsManager (no file I/O) */
	static inMemory(settings: Partial<Settings> = {}): SettingsManager {
		const storage = new InMemorySettingsStorage();
		const initialSettings = SettingsManager.migrateSettings(structuredClone(settings) as Record<string, unknown>);
		storage.withLock("global", () => JSON.stringify(initialSettings, null, 2));
		return SettingsManager.fromStorage(storage);
	}

	private static loadFromStorage(storage: SettingsStorage, scope: SettingsScope, projectTrusted = true): Settings {
		if (scope === "project" && !projectTrusted) {
			return {};
		}

		let content: string | undefined;
		storage.withLock(scope, (current) => {
			content = current;
			return undefined;
		});

		if (!content) {
			return {};
		}
		const settings = JSON.parse(content);
		return SettingsManager.migrateSettings(settings);
	}

	private static tryLoadFromStorage(
		storage: SettingsStorage,
		scope: SettingsScope,
		projectTrusted = true,
	): { settings: Settings; error: Error | null } {
		try {
			return { settings: SettingsManager.loadFromStorage(storage, scope, projectTrusted), error: null };
		} catch (error) {
			return { settings: {}, error: error as Error };
		}
	}

	private static tryLoadDirectoryProfileFromStorage(storage: SettingsStorage): {
		settings: Settings;
		error: Error | null;
		info: DirectoryResourceProfileInfo | null;
	} {
		if (!(storage instanceof FileSettingsStorage)) {
			return { settings: {}, error: null, info: null };
		}
		const info = storage.getDirectoryResourceProfileInfo();
		try {
			const content = storage.readDirectoryResourceProfile();
			if (!content) return { settings: {}, error: null, info };
			const settings = JSON.parse(content);
			return { settings: SettingsManager.migrateSettings(settings), error: null, info };
		} catch (error) {
			return { settings: {}, error: error as Error, info };
		}
	}

	/** Migrate old settings format to new format */
	private static migrateSettings(settings: Record<string, unknown>): Settings {
		// Migrate queueMode -> steeringMode
		if ("queueMode" in settings && !("steeringMode" in settings)) {
			settings.steeringMode = settings.queueMode;
			delete settings.queueMode;
		}

		// Migrate legacy websockets boolean -> transport enum
		if (!("transport" in settings) && typeof settings.websockets === "boolean") {
			settings.transport = settings.websockets ? "websocket" : "sse";
			delete settings.websockets;
		}

		// Migrate old skills object format to new array format
		if (
			"skills" in settings &&
			typeof settings.skills === "object" &&
			settings.skills !== null &&
			!Array.isArray(settings.skills)
		) {
			const skillsSettings = settings.skills as {
				enableSkillCommands?: boolean;
				customDirectories?: unknown;
			};
			if (skillsSettings.enableSkillCommands !== undefined && settings.enableSkillCommands === undefined) {
				settings.enableSkillCommands = skillsSettings.enableSkillCommands;
			}
			if (Array.isArray(skillsSettings.customDirectories) && skillsSettings.customDirectories.length > 0) {
				settings.skills = skillsSettings.customDirectories;
			} else {
				delete settings.skills;
			}
		}

		// Migrate retry.maxDelayMs -> retry.provider.maxRetryDelayMs
		if (
			"retry" in settings &&
			typeof settings.retry === "object" &&
			settings.retry !== null &&
			!Array.isArray(settings.retry)
		) {
			const retrySettings = settings.retry as Record<string, unknown>;
			const providerSettings =
				typeof retrySettings.provider === "object" && retrySettings.provider !== null
					? (retrySettings.provider as Record<string, unknown>)
					: undefined;
			if (
				typeof retrySettings.maxDelayMs === "number" &&
				(providerSettings?.maxRetryDelayMs === undefined || providerSettings?.maxRetryDelayMs === null)
			) {
				retrySettings.provider = {
					...(providerSettings ?? {}),
					maxRetryDelayMs: retrySettings.maxDelayMs,
				};
			}
			delete retrySettings.maxDelayMs;
		}

		return settings as Settings;
	}

	getGlobalSettings(): Settings {
		return structuredClone(this.globalSettings);
	}

	getProjectSettings(): Settings {
		return structuredClone(this.projectSettings);
	}

	getDirectoryResourceProfileSettings(): Settings {
		return structuredClone(this.directoryProfileSettings);
	}

	getDirectoryResourceProfileInfo(): DirectoryResourceProfileInfo | null {
		return this.directoryProfileInfo ? { ...this.directoryProfileInfo } : null;
	}

	getProfileRegistry(): ProfileRegistry {
		this.refreshProfileRegistry();
		return this.profileRegistry;
	}

	getActiveResourceProfileNames(): string[] {
		if (this.runtimeResourceProfiles && this.runtimeResourceProfiles.length > 0) {
			return [...this.runtimeResourceProfiles];
		}
		const names = normalizeActiveResourceProfiles(this.settings);
		return names.length > 0 || hasExplicitActiveResourceProfileSelection(this.settings)
			? names
			: this.getExternalRootActiveResourceProfileNames();
	}

	hasExplicitActiveResourceProfileSelection(): boolean {
		return hasExplicitActiveResourceProfileSelection(this.settings);
	}

	/**
	 * Aggregate ONLY the active profiles' contribution to a resource kind's filter — the user's own
	 * legacy `disabledResources` list is not merged in. Includes the strict-UAC deny-all (an
	 * authority-bearing kind no active profile mentions is denied outright); that denial is
	 * profile-driven too. Shared by `getResourceProfileFilter` (which merges the legacy disable list
	 * on top) and `isResourceDeniedByActiveProfile` (which must attribute a denial to the profile
	 * ALONE — a user-only disable must never be reported as "withheld by the active resource
	 * profile").
	 */
	private computeProfileOnlyResourceFilter(kind: ResourceProfileKind): Required<ResourceProfileFilterSettings> {
		const profileFilter: ResourceProfileFilterSettings = {};
		const seenProfiles = new Set<string>();
		const registry = this.getProfileRegistry();
		const activeProfileNames = this.getActiveResourceProfileNames();
		let kindMentionedByProfile = false;
		for (const profileName of activeProfileNames) {
			if (seenProfiles.has(profileName)) continue;
			seenProfiles.add(profileName);
			const kindFilter = registry.getProfile(profileName)?.resources[kind];
			if (kindFilter && ((kindFilter.allow?.length ?? 0) > 0 || (kindFilter.block?.length ?? 0) > 0)) {
				kindMentionedByProfile = true;
			}
			appendFilter(profileFilter, kindFilter);
		}

		// Strict UAC: an active profile set is the COMPLETE grant. An authority-bearing kind that no
		// active profile explicitly mentions is denied outright — grant-all must be said out loud
		// via `allow: ["*"]`. Themes are exempt (cosmetic, no authority). With no active profile,
		// behavior is unchanged: profiles are the opt-in least-privilege boundary.
		if (activeProfileNames.length > 0 && kind !== "themes" && !kindMentionedByProfile) {
			return { allow: [], block: ["*"] };
		}

		return {
			allow: [...new Set(profileFilter.allow ?? [])],
			block: [...new Set(profileFilter.block ?? [])],
		};
	}

	getResourceProfileFilter(kind: ResourceProfileKind): Required<ResourceProfileFilterSettings> {
		const legacyFilter = mergeResourceProfileFilters(
			collectLegacyDisabledFilterFromSettings(this.globalSettings, kind),
			collectLegacyDisabledFilterFromSettings(this.projectSettings, kind),
			collectLegacyDisabledFilterFromSettings(this.directoryProfileSettings, kind),
		);
		const filter = mergeResourceProfileFilters(legacyFilter, this.computeProfileOnlyResourceFilter(kind));
		return {
			allow: [...new Set(filter.allow ?? [])],
			block: [...new Set(filter.block ?? [])],
		};
	}

	/**
	 * Profile grants the user's own disable list overrides. RATIFIED precedence: a user disable
	 * (`disabledResources` / `!` overrides) is a hard off-switch that always WINS over a profile
	 * allow (the legacy disabled filter merges into every profile filter as a block, and blocks
	 * beat allows). This helper only SURFACES the conflict so a granted-but-disabled resource
	 * doesn't look like a broken grant.
	 */
	getProfileGrantsOverriddenByUserDisable(kind: ResourceProfileKind): string[] {
		const disabled = this.settings.disabledResources?.[kind] ?? [];
		if (!Array.isArray(disabled) || disabled.length === 0) return [];
		const registry = this.getProfileRegistry();
		const conflicts = new Set<string>();
		for (const profileName of this.getActiveResourceProfileNames()) {
			const filter = registry.getProfile(profileName)?.resources[kind];
			for (const allowEntry of filter?.allow ?? []) {
				if (allowEntry === "*") continue;
				if (disabled.includes(allowEntry) || matchesResourceProfilePattern(allowEntry, disabled)) {
					conflicts.add(allowEntry);
				}
			}
		}
		return [...conflicts];
	}

	isResourceAllowedByProfile(kind: ResourceProfileKind, resourcePath: string, baseDir = ""): boolean {
		const filter = this.getResourceProfileFilter(kind);
		if (filter.allow.length > 0 && !matchesResourceProfilePattern(resourcePath, filter.allow, baseDir)) {
			return false;
		}
		if (matchesResourceProfilePattern(resourcePath, filter.block, baseDir)) {
			return false;
		}
		return true;
	}

	/**
	 * Whether the ACTIVE PROFILE alone denies this resource — the user's own legacy
	 * `disabledResources` list is ignored. A "withheld by the active resource profile" report must
	 * use this, not `isResourceAllowedByProfile`: that check merges the user's own disables in, so a
	 * plain user-disabled resource (no profile even mentioning it) would otherwise be misattributed
	 * to the profile.
	 */
	isResourceDeniedByActiveProfile(kind: ResourceProfileKind, resourcePath: string, baseDir = ""): boolean {
		if (this.getActiveResourceProfileNames().length === 0) return false;
		const filter = this.computeProfileOnlyResourceFilter(kind);
		if (filter.allow.length > 0 && !matchesResourceProfilePattern(resourcePath, filter.allow, baseDir)) {
			return true;
		}
		return matchesResourceProfilePattern(resourcePath, filter.block, baseDir);
	}

	/**
	 * Situational soul(s) of the currently active profile(s) (R6): a system-prompt identity prefix
	 * injected while the profile is active. Multiple active profiles' souls are concatenated.
	 */
	getActiveProfileSoul(): string | undefined {
		// First-wins precedence (like profile model/thinking): the most-specific active profile's soul
		// is the identity — concatenating multiple souls would inject contradictory identities (Bug #16).
		const registry = this.getProfileRegistry();
		const seen = new Set<string>();
		for (const profileName of this.getActiveResourceProfileNames()) {
			if (seen.has(profileName)) continue;
			seen.add(profileName);
			const soul = registry.getProfile(profileName)?.soul?.trim();
			if (soul) return soul;
		}
		return undefined;
	}

	isProjectTrusted(): boolean {
		return this.projectTrusted;
	}

	setProjectTrusted(trusted: boolean): void {
		if (this.projectTrusted === trusted) {
			return;
		}

		this.projectTrusted = trusted;
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();

		if (!trusted) {
			this.projectSettings = {};
			this.projectSettingsLoadError = null;
			this.recomputeSettings();
			return;
		}

		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project", trusted);
		this.projectSettings = projectLoad.settings;
		this.projectSettingsLoadError = projectLoad.error;
		if (projectLoad.error) {
			this.recordError("project", projectLoad.error);
		}
		this.recomputeSettings();
	}

	async reload(): Promise<void> {
		await this.writeQueue;
		const globalLoad = SettingsManager.tryLoadFromStorage(this.storage, "global");
		if (!globalLoad.error) {
			this.globalSettings = globalLoad.settings;
			this.globalSettingsLoadError = null;
		} else {
			this.globalSettingsLoadError = globalLoad.error;
			this.recordError("global", globalLoad.error);
		}

		this.modifiedFields.clear();
		this.modifiedNestedFields.clear();
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();

		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project", this.projectTrusted);
		if (!projectLoad.error) {
			this.projectSettings = projectLoad.settings;
			this.projectSettingsLoadError = null;
		} else {
			this.projectSettingsLoadError = projectLoad.error;
			this.recordError("project", projectLoad.error);
		}

		const directoryProfileLoad = SettingsManager.tryLoadDirectoryProfileFromStorage(this.storage);
		this.directoryProfileInfo = directoryProfileLoad.info;
		if (!directoryProfileLoad.error) {
			this.directoryProfileSettings = directoryProfileLoad.settings;
		} else {
			this.recordError("directoryProfile", directoryProfileLoad.error);
		}

		this.recomputeSettings();
	}

	/** Apply additional overrides on top of current settings */
	applyOverrides(overrides: Partial<Settings>): void {
		this.settings = deepMergeSettings(this.settings, overrides);
	}

	/** Select runtime-only resource profiles, e.g. from CLI/subagent launch options. */
	setRuntimeResourceProfiles(profileNames: string[]): void {
		this.runtimeResourceProfiles = profileNames.length > 0 ? [...profileNames] : undefined;
		this.recomputeSettings();
	}

	/** Add one-shot profile definitions from CLI/SDK/ephemeral agent launch input. Never writes to disk. */
	addInlineResourceProfileDefinitions(profiles: Record<string, ResourceProfileSettings>): void {
		this.inlineResourceProfileDefinitions = mergeResourceProfileMap(this.inlineResourceProfileDefinitions, profiles);
		this.refreshProfileRegistry();
	}

	/** Replace profile definitions discovered inside loaded resource files. Never writes to disk. */
	replaceDiscoveredResourceProfileDefinitions(profiles: Record<string, ResourceProfileSettings>): void {
		this.discoveredResourceProfileDefinitions = { ...profiles };
		this.refreshProfileRegistry();
	}

	/** Add profile definitions discovered after resource resolution, e.g. context agent files. Never writes to disk. */
	addDiscoveredResourceProfileDefinitions(profiles: Record<string, ResourceProfileSettings>): void {
		this.discoveredResourceProfileDefinitions = mergeResourceProfileMap(
			this.discoveredResourceProfileDefinitions,
			profiles,
		);
		this.refreshProfileRegistry();
	}

	private normalizeProfileName(profileName: string): string {
		const trimmed = profileName.trim();
		if (!trimmed) {
			throw new Error("Profile name is required");
		}
		const errors = validateSkillName(trimmed);
		if (errors.length > 0) {
			throw new Error(`Invalid profile name "${trimmed}": ${errors.join(", ")}`);
		}
		return trimmed;
	}

	private sanitizeProfileResources(resources: ResourceProfileSettings): ResourceProfileSettings {
		const result: ResourceProfileSettings = {};
		for (const kind of ["extensions", "skills", "prompts", "themes", "agents", "tools"] as const) {
			const filter = resources[kind];
			if (!filter) {
				continue;
			}
			result[kind] = {
				allow: filter.allow ? [...filter.allow] : undefined,
				block: filter.block ? [...filter.block] : undefined,
			};
		}
		return result;
	}

	private setActiveProfileInSettings(settings: Settings, profileName: string | undefined): void {
		if (profileName) {
			settings.activeResourceProfile = profileName;
			settings.activeResourceProfiles = [profileName];
			return;
		}
		delete settings.activeResourceProfiles;
		delete settings.activeResourceProfile;
	}

	private persistDirectoryProfiles(update: (settings: Settings) => void): void {
		const next = structuredClone(this.directoryProfileSettings);
		update(next);
		this.directoryProfileSettings = next;
		this.recomputeSettings();

		if (!this.directoryProfileInfo) {
			return;
		}

		this.enqueueWrite("directoryProfile", () => {
			this.storage.withLock("directoryProfile", (current) => {
				const currentSettings = current
					? SettingsManager.migrateSettings(JSON.parse(current) as Record<string, unknown>)
					: {};
				const merged: Settings = {
					...currentSettings,
					...next,
					resourceProfiles: next.resourceProfiles,
					activeResourceProfiles: next.activeResourceProfiles,
					activeResourceProfile: next.activeResourceProfile,
				};
				if (!next.resourceProfiles) {
					delete merged.resourceProfiles;
				}
				if (!next.activeResourceProfiles && next.activeResourceProfile === undefined) {
					delete merged.activeResourceProfiles;
					delete merged.activeResourceProfile;
				}
				return JSON.stringify(merged, null, 2);
			});
		});
	}

	private getProfileFilePath(profileName: string): string {
		const normalized = this.normalizeProfileName(profileName);
		const profilesDir = this.storage.getProfilesDir?.();
		if (!profilesDir) {
			throw new Error("Profiles directory is not configured");
		}
		return join(resolve(profilesDir), `${normalized}.json`);
	}

	/**
	 * Create or update a profile definition in the selected persistence scope.
	 */
	setProfileDefinition(profileName: string, definition: ProfileDefinitionInput, scope: ProfilePersistenceScope): void {
		const name = this.normalizeProfileName(profileName);
		const resources = this.sanitizeProfileResources(definition.resources);

		if (scope === "session") {
			const next = { ...this.inlineResourceProfileDefinitions };
			if (Object.keys(resources).length > 0) {
				next[name] = resources;
			} else {
				delete next[name];
			}
			this.inlineResourceProfileDefinitions = next;
			this.refreshProfileRegistry();
			return;
		}

		if (scope === "global") {
			const next = structuredClone(this.globalSettings);
			next.resourceProfiles = { ...(next.resourceProfiles ?? {}) };
			if (Object.keys(resources).length > 0) {
				next.resourceProfiles[name] = resources;
			} else {
				delete next.resourceProfiles[name];
			}
			if (Object.keys(next.resourceProfiles).length === 0) {
				delete next.resourceProfiles;
			}
			this.globalSettings = next;
			this.markModified("resourceProfiles");
			this.save();
			return;
		}

		if (scope === "project") {
			this.updateProjectSettings("resourceProfiles", (settings) => {
				const next = structuredClone(settings.resourceProfiles ?? {});
				if (Object.keys(resources).length > 0) {
					next[name] = resources;
				} else {
					delete next[name];
				}
				if (Object.keys(next).length > 0) {
					settings.resourceProfiles = next;
				} else {
					delete settings.resourceProfiles;
				}
			});
			return;
		}

		if (scope === "directory") {
			this.persistDirectoryProfiles((current) => {
				const next = { ...(current.resourceProfiles ?? {}) };
				if (Object.keys(resources).length > 0) {
					next[name] = resources;
				} else {
					delete next[name];
				}
				if (Object.keys(next).length > 0) {
					current.resourceProfiles = next;
				} else {
					delete current.resourceProfiles;
				}
			});
			return;
		}

		const path = this.getProfileFilePath(name);
		const existing = existsSync(path)
			? parseProfileFileDefinition(readFileSync(path, "utf-8"))
			: { name, resources: {} };
		const payload: ProfileDefinitionInput = {
			...existing,
			name,
			resources,
			description: definition.description ?? existing.description,
			model: definition.model ?? existing.model,
			thinking: definition.thinking ?? existing.thinking,
			modelRouter: definition.modelRouter ?? existing.modelRouter,
		};
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(payload, null, 2), "utf-8");
	}

	/**
	 * Delete a profile from the selected scope.
	 */
	deleteProfile(profileName: string, scope: ProfilePersistenceScope): void {
		const name = this.normalizeProfileName(profileName);

		if (scope === "session") {
			const next = { ...this.inlineResourceProfileDefinitions };
			delete next[name];
			this.inlineResourceProfileDefinitions = next;
			this.refreshProfileRegistry();
			if (this.runtimeResourceProfiles) {
				this.setRuntimeResourceProfiles(this.runtimeResourceProfiles.filter((profile) => profile !== name));
			}
			return;
		}

		if (scope === "global") {
			const next = { ...(this.globalSettings.resourceProfiles ?? {}) };
			delete next[name];
			if (Object.keys(next).length > 0) {
				this.globalSettings.resourceProfiles = next;
			} else {
				delete this.globalSettings.resourceProfiles;
			}
			if (this.globalSettings.activeResourceProfile === name) {
				delete this.globalSettings.activeResourceProfile;
			}
			if (this.globalSettings.activeResourceProfiles) {
				this.globalSettings.activeResourceProfiles = this.globalSettings.activeResourceProfiles.filter(
					(profile) => profile !== name,
				);
				if (this.globalSettings.activeResourceProfiles.length === 0) {
					delete this.globalSettings.activeResourceProfiles;
				}
			}
			this.markModified("resourceProfiles");
			this.save();
			return;
		}

		if (scope === "project") {
			this.updateProjectSettings("resourceProfiles", (settings) => {
				const next = { ...(settings.resourceProfiles ?? {}) };
				delete next[name];
				if (Object.keys(next).length > 0) {
					settings.resourceProfiles = next;
				} else {
					delete settings.resourceProfiles;
				}
				if (settings.activeResourceProfile === name) {
					delete settings.activeResourceProfile;
				}
				if (settings.activeResourceProfiles) {
					settings.activeResourceProfiles = settings.activeResourceProfiles.filter((profile) => profile !== name);
					if (settings.activeResourceProfiles.length === 0) {
						delete settings.activeResourceProfiles;
					}
				}
			});
			return;
		}

		if (scope === "directory") {
			this.persistDirectoryProfiles((current) => {
				const next = { ...(current.resourceProfiles ?? {}) };
				delete next[name];
				if (Object.keys(next).length > 0) {
					current.resourceProfiles = next;
				} else {
					delete current.resourceProfiles;
				}
				if (current.activeResourceProfile === name) {
					delete current.activeResourceProfile;
				}
				if (current.activeResourceProfiles) {
					current.activeResourceProfiles = current.activeResourceProfiles.filter((profile) => profile !== name);
					if (current.activeResourceProfiles.length === 0) {
						delete current.activeResourceProfiles;
					}
				}
			});
			return;
		}

		const profilePath = this.getProfileFilePath(name);
		if (!existsSync(profilePath)) {
			throw new Error(`Profile not found: ${name}`);
		}
		rmSync(profilePath, { force: true });
	}

	renameProfile(profileName: string, newProfileName: string, scope: ProfilePersistenceScope): void {
		const oldName = this.normalizeProfileName(profileName);
		const newName = this.normalizeProfileName(newProfileName);
		if (oldName === newName) {
			return;
		}

		if (scope === "session") {
			const profile = this.inlineResourceProfileDefinitions[oldName];
			if (!profile) {
				throw new Error(`Profile not found: ${oldName}`);
			}
			delete this.inlineResourceProfileDefinitions[oldName];
			this.inlineResourceProfileDefinitions[newName] = profile;
			if (this.runtimeResourceProfiles) {
				this.runtimeResourceProfiles = this.runtimeResourceProfiles.map((name) =>
					name === oldName ? newName : name,
				);
				this.setRuntimeResourceProfiles(this.runtimeResourceProfiles);
			}
			this.refreshProfileRegistry();
			return;
		}

		if (scope === "global") {
			const next = structuredClone(this.globalSettings);
			if (!next.resourceProfiles?.[oldName]) {
				throw new Error(`Profile not found: ${oldName}`);
			}
			if (next.resourceProfiles[newName]) {
				throw new Error(`Profile already exists: ${newName}`);
			}
			next.resourceProfiles[newName] = next.resourceProfiles[oldName]!;
			delete next.resourceProfiles[oldName];
			if (next.activeResourceProfile === oldName) {
				next.activeResourceProfile = newName;
			}
			if (next.activeResourceProfiles) {
				next.activeResourceProfiles = next.activeResourceProfiles.map((name) =>
					name === oldName ? newName : name,
				);
			}
			this.globalSettings = next;
			this.markModified("resourceProfiles");
			this.markModified("activeResourceProfile");
			this.markModified("activeResourceProfiles");
			this.save();
			return;
		}

		if (scope === "project") {
			this.updateProjectSettings("resourceProfiles", (settings) => {
				const next = structuredClone(settings.resourceProfiles ?? {});
				if (!next[oldName]) {
					throw new Error(`Profile not found: ${oldName}`);
				}
				if (next[newName]) {
					throw new Error(`Profile already exists: ${newName}`);
				}
				next[newName] = next[oldName]!;
				delete next[oldName];
				settings.resourceProfiles = next;
				if (settings.activeResourceProfile === oldName) {
					settings.activeResourceProfile = newName;
				}
				if (settings.activeResourceProfiles) {
					settings.activeResourceProfiles = settings.activeResourceProfiles.map((name) =>
						name === oldName ? newName : name,
					);
				}
			});
			return;
		}

		if (scope === "directory") {
			const next = structuredClone(this.directoryProfileSettings.resourceProfiles ?? {});
			if (!next[oldName]) {
				throw new Error(`Profile not found: ${oldName}`);
			}
			if (next[newName]) {
				throw new Error(`Profile already exists: ${newName}`);
			}
			next[newName] = next[oldName]!;
			delete next[oldName];
			this.persistDirectoryProfiles((current) => {
				current.resourceProfiles = next;
				if (current.activeResourceProfile === oldName) {
					current.activeResourceProfile = newName;
				}
				if (current.activeResourceProfiles) {
					current.activeResourceProfiles = current.activeResourceProfiles.map((name) =>
						name === oldName ? newName : name,
					);
				}
			});
			return;
		}

		const oldPath = this.getProfileFilePath(oldName);
		const newPath = this.getProfileFilePath(newName);
		if (!existsSync(oldPath)) {
			throw new Error(`Profile not found: ${oldName}`);
		}
		if (existsSync(newPath)) {
			throw new Error(`Profile already exists: ${newName}`);
		}
		const parsed = parseProfileFileDefinition(readFileSync(oldPath, "utf-8"));
		parsed.name = newName;
		writeFileSync(newPath, JSON.stringify(parsed, null, 2), "utf-8");
		rmSync(oldPath, { force: true });
	}

	/**
	 * Set active profile selection in the selected scope.
	 */
	setActiveProfile(profileName: string | undefined, scope: Exclude<ProfilePersistenceScope, "reusable-file">): void {
		const name = profileName ? this.normalizeProfileName(profileName) : undefined;
		if (scope === "session") {
			if (name) {
				this.setRuntimeResourceProfiles([name]);
			} else {
				this.setRuntimeResourceProfiles([]);
			}
			return;
		}

		if (scope === "global") {
			if (name) {
				this.globalSettings.activeResourceProfile = name;
				this.globalSettings.activeResourceProfiles = [name];
			} else {
				delete this.globalSettings.activeResourceProfile;
				delete this.globalSettings.activeResourceProfiles;
			}
			this.markModified("activeResourceProfile");
			this.markModified("activeResourceProfiles");
			this.save();
			return;
		}

		if (scope === "project") {
			this.updateProjectSettings("activeResourceProfile", (settings) => {
				this.setActiveProfileInSettings(settings, name);
			});
			return;
		}

		this.persistDirectoryProfiles((current) => {
			this.setActiveProfileInSettings(current, name);
		});
	}

	/** Mark a global field as modified during this session */
	private markModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedFields.add(field);
		if (nestedKey) {
			if (!this.modifiedNestedFields.has(field)) {
				this.modifiedNestedFields.set(field, new Set());
			}
			this.modifiedNestedFields.get(field)!.add(nestedKey);
		}
	}

	/** Mark a project field as modified during this session */
	private markProjectModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedProjectFields.add(field);
		if (nestedKey) {
			if (!this.modifiedProjectNestedFields.has(field)) {
				this.modifiedProjectNestedFields.set(field, new Set());
			}
			this.modifiedProjectNestedFields.get(field)!.add(nestedKey);
		}
	}

	private assertProjectTrustedForWrite(): void {
		if (!this.projectTrusted) {
			throw new Error("Project is not trusted; refusing to write project settings");
		}
	}

	private recordError(scope: SettingsErrorScope, error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push({ scope, error: normalizedError });
	}

	private clearModifiedScope(scope: SettingsScope): void {
		if (scope === "global") {
			this.modifiedFields.clear();
			this.modifiedNestedFields.clear();
			return;
		}

		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();
	}

	private enqueueWrite(scope: SettingsScope, task: () => void): void {
		this.writeQueue = this.writeQueue
			.then(() => {
				if (scope === "project") {
					this.assertProjectTrustedForWrite();
				}
				task();
				this.clearModifiedScope(scope);
			})
			.catch((error) => {
				this.recordError(scope, error);
			});
	}

	private cloneModifiedNestedFields(source: Map<keyof Settings, Set<string>>): Map<keyof Settings, Set<string>> {
		const snapshot = new Map<keyof Settings, Set<string>>();
		for (const [key, value] of source.entries()) {
			snapshot.set(key, new Set(value));
		}
		return snapshot;
	}

	private persistScopedSettings(
		scope: SettingsScope,
		snapshotSettings: Settings,
		modifiedFields: Set<keyof Settings>,
		modifiedNestedFields: Map<keyof Settings, Set<string>>,
	): void {
		this.storage.withLock(scope, (current) => {
			const currentFileSettings = current
				? SettingsManager.migrateSettings(JSON.parse(current) as Record<string, unknown>)
				: {};
			const mergedSettings: Settings = { ...currentFileSettings };
			for (const field of modifiedFields) {
				const value = snapshotSettings[field];
				if (modifiedNestedFields.has(field) && typeof value === "object" && value !== null) {
					const nestedModified = modifiedNestedFields.get(field)!;
					const baseNested = (currentFileSettings[field] as Record<string, unknown>) ?? {};
					const inMemoryNested = value as Record<string, unknown>;
					const mergedNested = { ...baseNested };
					for (const nestedKey of nestedModified) {
						mergedNested[nestedKey] = inMemoryNested[nestedKey];
					}
					(mergedSettings as Record<string, unknown>)[field] = mergedNested;
				} else {
					(mergedSettings as Record<string, unknown>)[field] = value;
				}
			}

			return JSON.stringify(mergedSettings, null, 2);
		});
	}

	private save(): void {
		this.recomputeSettings();

		if (this.globalSettingsLoadError) {
			return;
		}

		const snapshotGlobalSettings = structuredClone(this.globalSettings);
		const modifiedFields = new Set(this.modifiedFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedNestedFields);

		this.enqueueWrite("global", () => {
			this.persistScopedSettings("global", snapshotGlobalSettings, modifiedFields, modifiedNestedFields);
		});
	}

	private saveProjectSettings(settings: Settings): void {
		this.assertProjectTrustedForWrite();
		this.projectSettings = structuredClone(settings);
		this.recomputeSettings();

		if (this.projectSettingsLoadError) {
			return;
		}

		const snapshotProjectSettings = structuredClone(this.projectSettings);
		const modifiedFields = new Set(this.modifiedProjectFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedProjectNestedFields);
		this.enqueueWrite("project", () => {
			this.persistScopedSettings("project", snapshotProjectSettings, modifiedFields, modifiedNestedFields);
		});
	}

	private updateProjectSettings(field: keyof Settings, update: (settings: Settings) => void): void {
		this.assertProjectTrustedForWrite();
		const projectSettings = structuredClone(this.projectSettings);
		update(projectSettings);
		this.markProjectModified(field);
		this.saveProjectSettings(projectSettings);
	}

	async flush(): Promise<void> {
		await this.writeQueue;
	}

	drainErrors(): SettingsError[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	getLastChangelogVersion(): string | undefined {
		return this.settings.lastChangelogVersion;
	}

	setLastChangelogVersion(version: string): void {
		this.globalSettings.lastChangelogVersion = version;
		this.markModified("lastChangelogVersion");
		this.save();
	}

	getSessionDir(): string | undefined {
		const sessionDir = this.settings.sessionDir;
		return sessionDir ? normalizePath(sessionDir) : sessionDir;
	}

	getDefaultProvider(): string | undefined {
		return this.settings.defaultProvider;
	}

	getDefaultModel(): string | undefined {
		return this.settings.defaultModel;
	}

	setDefaultProvider(provider: string): void {
		this.globalSettings.defaultProvider = provider;
		this.markModified("defaultProvider");
		this.save();
	}

	setDefaultModel(modelId: string): void {
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultModel");
		this.save();
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.globalSettings.defaultProvider = provider;
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultProvider");
		this.markModified("defaultModel");
		this.save();
	}

	getSteeringMode(): "all" | "one-at-a-time" {
		return this.settings.steeringMode || "one-at-a-time";
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.globalSettings.steeringMode = mode;
		this.markModified("steeringMode");
		this.save();
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.settings.followUpMode || "one-at-a-time";
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.globalSettings.followUpMode = mode;
		this.markModified("followUpMode");
		this.save();
	}

	getTheme(): string | undefined {
		return this.settings.theme;
	}

	setTheme(theme: string): void {
		this.globalSettings.theme = theme;
		this.markModified("theme");
		this.save();
	}

	/** The configured resource catalog directory, if any (round resource management). */
	getCatalogDir(): string | undefined {
		return this.settings.catalogDir;
	}

	setCatalogDir(dir: string | undefined): void {
		if (dir) {
			this.globalSettings.catalogDir = dir;
		} else {
			delete this.globalSettings.catalogDir;
		}
		this.markModified("catalogDir");
		this.save();
	}

	getDefaultThinkingLevel(): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
		return this.settings.defaultThinkingLevel;
	}

	setDefaultThinkingLevel(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"): void {
		this.globalSettings.defaultThinkingLevel = level;
		this.markModified("defaultThinkingLevel");
		this.save();
	}

	getTransport(): TransportSetting {
		return this.settings.transport ?? "auto";
	}

	setTransport(transport: TransportSetting): void {
		this.globalSettings.transport = transport;
		this.markModified("transport");
		this.save();
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? true;
	}

	setCompactionEnabled(enabled: boolean): void {
		if (!this.globalSettings.compaction) {
			this.globalSettings.compaction = {};
		}
		this.globalSettings.compaction.enabled = enabled;
		this.markModified("compaction", "enabled");
		this.save();
	}

	getCompactionReserveTokens(): number {
		return this.settings.compaction?.reserveTokens ?? 16384;
	}

	getCompactionKeepRecentTokens(): number {
		return this.settings.compaction?.keepRecentTokens ?? 20000;
	}

	getCompactionTriggerPercent(): number {
		return this.settings.compaction?.triggerPercent ?? 0.7;
	}

	/**
	 * Skill curator (#32). Auto-archive of stale reflection-promoted skills is ON by default (restorable,
	 * announced, promoted-only). Set `autoArchive: false` to make it propose-only (`/curate`).
	 */
	getCuratorSettings(): { autoArchive: boolean; staleDays: number } {
		return {
			autoArchive: this.settings.curator?.autoArchive ?? true,
			staleDays: this.settings.curator?.staleDays ?? 30,
		};
	}

	/**
	 * Proactive per-turn cost guard (#34). Default ON in WARN-only mode with a high anomaly-catching
	 * ceiling so an unusually expensive turn surfaces a visible footer notice without ever silently
	 * changing behavior. Set `maxTurnUsd: 0` to disable, or `action: "downgrade"` to also auto-reduce
	 * reasoning effort over the ceiling.
	 */
	getCostGuardSettings(): { maxTurnUsd: number; action: "warn" | "downgrade" } {
		return {
			maxTurnUsd: this.settings.costGuard?.maxTurnUsd ?? 2.5,
			action: this.settings.costGuard?.action ?? "warn",
		};
	}

	private getProfileModelRouterSettings(): ModelRouterSettings | undefined {
		const activeProfileNames = this.getActiveResourceProfileNames();
		if (activeProfileNames.length === 0) return undefined;
		const merged: ModelRouterSettings = {};
		for (let index = activeProfileNames.length - 1; index >= 0; index--) {
			const profile = this.profileRegistry.getProfile(activeProfileNames[index]);
			const router = profile?.modelRouter;
			if (!router) continue;
			if (router.enabled !== undefined) merged.enabled = router.enabled;
			if (router.cheapModel !== undefined) merged.cheapModel = router.cheapModel;
			if (router.mediumModel !== undefined) merged.mediumModel = router.mediumModel;
			if (router.expensiveModel !== undefined) merged.expensiveModel = router.expensiveModel;
			if (router.learningModel !== undefined) merged.learningModel = router.learningModel;
		}
		return Object.keys(merged).length > 0 ? merged : undefined;
	}

	getModelRouterSettings(): {
		enabled: boolean;
		cheapModel?: string;
		mediumModel?: string;
		expensiveModel?: string;
		learningModel?: string;
		judgeEnabled: boolean;
		judgeModel?: string;
		executorModel?: string;
		cheapThinking?: ThinkingLevel;
		mediumThinking?: ThinkingLevel;
		expensiveThinking?: ThinkingLevel;
		executorThinking?: ThinkingLevel;
		judgeThinking?: ThinkingLevel;
	} {
		const profileSettings = this.getProfileModelRouterSettings();
		const settings = {
			enabled: this.settings.modelRouter?.enabled ?? false,
			cheapModel: this.settings.modelRouter?.cheapModel?.trim() || undefined,
			mediumModel: this.settings.modelRouter?.mediumModel?.trim() || undefined,
			expensiveModel: this.settings.modelRouter?.expensiveModel?.trim() || undefined,
			learningModel: this.settings.modelRouter?.learningModel?.trim() || undefined,
			judgeEnabled: this.settings.modelRouter?.judgeEnabled ?? true,
			judgeModel: this.settings.modelRouter?.judgeModel?.trim() || undefined,
			executorModel: this.settings.modelRouter?.executorModel?.trim() || undefined,
			// Not yet profile-overridable (same as judgeModel/executorModel above): validated here so a
			// corrupt/hand-edited value on disk never reaches the routed-turn swap in agent-session.ts.
			cheapThinking: isThinkingLevel(this.settings.modelRouter?.cheapThinking)
				? this.settings.modelRouter?.cheapThinking
				: undefined,
			mediumThinking: isThinkingLevel(this.settings.modelRouter?.mediumThinking)
				? this.settings.modelRouter?.mediumThinking
				: undefined,
			expensiveThinking: isThinkingLevel(this.settings.modelRouter?.expensiveThinking)
				? this.settings.modelRouter?.expensiveThinking
				: undefined,
			executorThinking: isThinkingLevel(this.settings.modelRouter?.executorThinking)
				? this.settings.modelRouter?.executorThinking
				: undefined,
			judgeThinking: isThinkingLevel(this.settings.modelRouter?.judgeThinking)
				? this.settings.modelRouter?.judgeThinking
				: undefined,
		};
		return {
			enabled: profileSettings?.enabled ?? settings.enabled,
			cheapModel: profileSettings?.cheapModel?.trim() || settings.cheapModel,
			mediumModel: profileSettings?.mediumModel?.trim() || settings.mediumModel,
			expensiveModel: profileSettings?.expensiveModel?.trim() || settings.expensiveModel,
			learningModel: profileSettings?.learningModel?.trim() || settings.learningModel,
			judgeEnabled: profileSettings?.judgeEnabled ?? settings.judgeEnabled,
			judgeModel: profileSettings?.judgeModel?.trim() || settings.judgeModel,
			executorModel: profileSettings?.executorModel?.trim() || settings.executorModel,
			cheapThinking: settings.cheapThinking,
			mediumThinking: settings.mediumThinking,
			expensiveThinking: settings.expensiveThinking,
			executorThinking: settings.executorThinking,
			judgeThinking: settings.judgeThinking,
		};
	}

	setModelRouterSettings(settings: ModelRouterSettings, scope: SettingsScope = "global"): void {
		const normalized: ModelRouterSettings = {
			enabled: settings.enabled ?? false,
			cheapModel: settings.cheapModel?.trim() || undefined,
			mediumModel: settings.mediumModel?.trim() || undefined,
			expensiveModel: settings.expensiveModel?.trim() || undefined,
			learningModel: settings.learningModel?.trim() || undefined,
			judgeEnabled: settings.judgeEnabled ?? true,
			judgeModel: settings.judgeModel?.trim() || undefined,
			executorModel: settings.executorModel?.trim() || undefined,
			cheapThinking: isThinkingLevel(settings.cheapThinking) ? settings.cheapThinking : undefined,
			mediumThinking: isThinkingLevel(settings.mediumThinking) ? settings.mediumThinking : undefined,
			expensiveThinking: isThinkingLevel(settings.expensiveThinking) ? settings.expensiveThinking : undefined,
			executorThinking: isThinkingLevel(settings.executorThinking) ? settings.executorThinking : undefined,
			judgeThinking: isThinkingLevel(settings.judgeThinking) ? settings.judgeThinking : undefined,
		};
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			projectSettings.modelRouter = normalized;
			this.markProjectModified("modelRouter");
			this.saveProjectSettings(projectSettings);
			return;
		}

		this.globalSettings.modelRouter = normalized;
		this.markModified("modelRouter");
		this.save();
	}

	/** Configured auxiliary summarizer model id, or "auto" (default) to pick the cheapest authed model. */
	getCompactionModel(): string {
		return this.settings.compaction?.model ?? "auto";
	}

	getCompactionSettings(): {
		enabled: boolean;
		reserveTokens: number;
		keepRecentTokens: number;
		triggerPercent: number;
	} {
		return {
			enabled: this.getCompactionEnabled(),
			reserveTokens: this.getCompactionReserveTokens(),
			keepRecentTokens: this.getCompactionKeepRecentTokens(),
			triggerPercent: this.getCompactionTriggerPercent(),
		};
	}

	getContextGcSettings(): {
		enabled: boolean;
		preserveRecentMessages: number;
		minToolResultChars: number;
		tools: string[];
		semanticMemory: {
			enabled: boolean;
			preserveRecentPages: number;
			minChars: number;
			markers: string[];
		};
	} {
		return {
			enabled: this.settings.contextGc?.enabled ?? true,
			preserveRecentMessages: this.settings.contextGc?.preserveRecentMessages ?? 8,
			minToolResultChars: this.settings.contextGc?.minToolResultChars ?? 1200,
			tools: this.settings.contextGc?.tools ?? [
				"read",
				"bash",
				"rg",
				"grep",
				"find",
				"ls",
				"skill_open",
				"automata_graph_status",
				"automata_graph_search",
				"automata_graph_query",
				"automata_graph_neighbors",
				"automata_graph_path",
				"automata_graph_pointer_pack",
				"learning_query_memory",
				"subagent",
				"task_steps",
				"task_background",
				"task_goal",
				"run_ledger",
				"context_headroom_retrieve",
				"headroom_retrieve",
			],
			semanticMemory: {
				enabled: this.settings.contextGc?.semanticMemory?.enabled ?? true,
				preserveRecentPages: this.settings.contextGc?.semanticMemory?.preserveRecentPages ?? 1,
				minChars: this.settings.contextGc?.semanticMemory?.minChars ?? 900,
				markers: this.settings.contextGc?.semanticMemory?.markers ?? [
					// Generic recall-page marker the bundled default provider (transcript-recall)
					// emits; must be present here because a non-empty settings list fully replaces
					// the context-gc code default that already includes it.
					"<memory_context",
					"<automata_context",
					"<automata_response",
					"<automata_query",
					"<automata_fetch",
					"<memory_lifecycle_audit",
					"<memory_lifecycle_purge",
					"<automata_doctor",
					"<automata_optimizer",
					"<automata_mesh",
				],
			},
		};
	}

	getContextPromptEnforcementSettings(): { enabled: boolean; preserveRecentMessages: number; minChars: number } {
		return {
			enabled: this.settings.contextPolicy?.enforcement?.enabled ?? false,
			preserveRecentMessages: this.settings.contextPolicy?.enforcement?.preserveRecentMessages ?? 8,
			minChars: this.settings.contextPolicy?.enforcement?.minChars ?? 1200,
		};
	}

	getContextCurationSettings(): { enabled: boolean; model?: string; maxJobsPerTurn: number } {
		return {
			enabled: this.settings.contextPolicy?.curation?.enabled ?? false,
			model: this.settings.contextPolicy?.curation?.model?.trim() || undefined,
			maxJobsPerTurn: sanitizeIntegerSetting(this.settings.contextPolicy?.curation?.maxJobsPerTurn, 4, 1, 16),
		};
	}

	setContextCurationSettings(settings: ContextCurationSettings, scope: SettingsScope = "global"): void {
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			projectSettings.contextPolicy = { ...projectSettings.contextPolicy, curation: { ...settings } };
			this.markProjectModified("contextPolicy");
			this.saveProjectSettings(projectSettings);
			return;
		}
		this.globalSettings.contextPolicy = { ...this.globalSettings.contextPolicy, curation: { ...settings } };
		this.markModified("contextPolicy");
		this.save();
	}

	setContextPromptEnforcementSettings(
		settings: ContextPromptEnforcementSettings,
		scope: SettingsScope = "global",
	): void {
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			projectSettings.contextPolicy = { ...projectSettings.contextPolicy, enforcement: { ...settings } };
			this.markProjectModified("contextPolicy");
			this.saveProjectSettings(projectSettings);
			return;
		}

		this.globalSettings.contextPolicy = { ...this.globalSettings.contextPolicy, enforcement: { ...settings } };
		this.markModified("contextPolicy");
		this.save();
	}

	getMemoryRetrievalSettings(): { enabled: boolean; maxResults: number; includeInPrompt: boolean } {
		return {
			enabled: this.settings.contextPolicy?.memory?.enabled ?? false,
			maxResults: clampMemoryRetrievalMaxResults(
				this.settings.contextPolicy?.memory?.maxResults ?? MEMORY_RETRIEVAL_MAX_RESULTS_DEFAULT,
			),
			includeInPrompt: this.settings.contextPolicy?.memory?.includeInPrompt ?? false,
		};
	}

	setMemoryRetrievalSettings(settings: MemoryRetrievalSettings, scope: SettingsScope = "global"): void {
		const normalized: MemoryRetrievalSettings = {
			enabled: settings.enabled,
			maxResults:
				settings.maxResults === undefined ? undefined : clampMemoryRetrievalMaxResults(settings.maxResults),
			includeInPrompt: settings.includeInPrompt,
		};
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			projectSettings.contextPolicy = { ...projectSettings.contextPolicy, memory: normalized };
			this.markProjectModified("contextPolicy");
			this.saveProjectSettings(projectSettings);
			return;
		}

		this.globalSettings.contextPolicy = { ...this.globalSettings.contextPolicy, memory: normalized };
		this.markModified("contextPolicy");
		this.save();
	}

	getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean } {
		return {
			reserveTokens: this.settings.branchSummary?.reserveTokens ?? 16384,
			skipPrompt: this.settings.branchSummary?.skipPrompt ?? false,
		};
	}

	getBranchSummarySkipPrompt(): boolean {
		return this.settings.branchSummary?.skipPrompt ?? false;
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? true;
	}

	setRetryEnabled(enabled: boolean): void {
		if (!this.globalSettings.retry) {
			this.globalSettings.retry = {};
		}
		this.globalSettings.retry.enabled = enabled;
		this.markModified("retry", "enabled");
		this.save();
	}

	getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number } {
		return {
			enabled: this.getRetryEnabled(),
			maxRetries: this.settings.retry?.maxRetries ?? 3,
			baseDelayMs: this.settings.retry?.baseDelayMs ?? 2000,
		};
	}

	/**
	 * Stream-stall watchdog bounds (pi-agent-core reliability/watchdogs.ts). Returns only the
	 * fields the user set, validated; unset fields fall back to DEFAULT_STREAM_IDLE at the
	 * wiring site (agent-session constructor). Resolved per request, so edits apply live.
	 */
	getStreamStallSettings(): { connectMs?: number; activeIdleMs?: number; quietIdleMs?: number } {
		const stall = this.settings.retry?.stall;
		return {
			connectMs: parseStallBoundMs(stall?.connectMs, "retry.stall.connectMs"),
			activeIdleMs: parseStallBoundMs(stall?.activeIdleMs, "retry.stall.activeIdleMs"),
			quietIdleMs: parseStallBoundMs(stall?.quietIdleMs, "retry.stall.quietIdleMs"),
		};
	}

	getHttpIdleTimeoutMs(): number {
		return parseTimeoutSetting(this.settings.httpIdleTimeoutMs, "httpIdleTimeoutMs") ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS;
	}

	setHttpIdleTimeoutMs(timeoutMs: number): void {
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
			throw new Error(`Invalid httpIdleTimeoutMs setting: ${String(timeoutMs)}`);
		}
		this.globalSettings.httpIdleTimeoutMs = Math.floor(timeoutMs);
		this.markModified("httpIdleTimeoutMs");
		this.save();
	}

	getProviderRetrySettings(): { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs: number } {
		return {
			timeoutMs: this.settings.retry?.provider?.timeoutMs,
			maxRetries: this.settings.retry?.provider?.maxRetries,
			maxRetryDelayMs: this.settings.retry?.provider?.maxRetryDelayMs ?? 60000,
		};
	}

	getWebSocketConnectTimeoutMs(): number | undefined {
		return parseTimeoutSetting(this.settings.websocketConnectTimeoutMs, "websocketConnectTimeoutMs");
	}

	getHideThinkingBlock(): boolean {
		return this.settings.hideThinkingBlock ?? false;
	}

	setHideThinkingBlock(hide: boolean): void {
		this.globalSettings.hideThinkingBlock = hide;
		this.markModified("hideThinkingBlock");
		this.save();
	}

	getShellPath(): string | undefined {
		return this.settings.shellPath;
	}

	setShellPath(path: string | undefined): void {
		this.globalSettings.shellPath = path;
		this.markModified("shellPath");
		this.save();
	}

	getQuietStartup(): boolean {
		return this.settings.quietStartup ?? false;
	}

	setQuietStartup(quiet: boolean): void {
		this.globalSettings.quietStartup = quiet;
		this.markModified("quietStartup");
		this.save();
	}

	getShellCommandPrefix(): string | undefined {
		return this.settings.shellCommandPrefix;
	}

	setShellCommandPrefix(prefix: string | undefined): void {
		this.globalSettings.shellCommandPrefix = prefix;
		this.markModified("shellCommandPrefix");
		this.save();
	}

	getNpmCommand(): string[] | undefined {
		return this.settings.npmCommand ? [...this.settings.npmCommand] : undefined;
	}

	setNpmCommand(command: string[] | undefined): void {
		this.globalSettings.npmCommand = command ? [...command] : undefined;
		this.markModified("npmCommand");
		this.save();
	}

	getCollapseChangelog(): boolean {
		return this.settings.collapseChangelog ?? false;
	}

	setCollapseChangelog(collapse: boolean): void {
		this.globalSettings.collapseChangelog = collapse;
		this.markModified("collapseChangelog");
		this.save();
	}

	getEnableInstallTelemetry(): boolean {
		return this.settings.enableInstallTelemetry ?? true;
	}

	setEnableInstallTelemetry(enabled: boolean): void {
		this.globalSettings.enableInstallTelemetry = enabled;
		this.markModified("enableInstallTelemetry");
		this.save();
	}

	getPackages(): PackageSource[] {
		return [...(this.settings.packages ?? [])];
	}

	setPackages(packages: PackageSource[]): void {
		this.globalSettings.packages = packages;
		this.markModified("packages");
		this.save();
	}

	setProjectPackages(packages: PackageSource[]): void {
		this.updateProjectSettings("packages", (settings) => {
			settings.packages = packages;
		});
	}

	getExtensionPaths(): string[] {
		return [...(this.settings.extensions ?? [])];
	}

	setExtensionPaths(paths: string[]): void {
		this.globalSettings.extensions = paths;
		this.markModified("extensions");
		this.save();
	}

	setProjectExtensionPaths(paths: string[]): void {
		this.updateProjectSettings("extensions", (settings) => {
			settings.extensions = paths;
		});
	}

	getSkillPaths(): string[] {
		return [...(this.settings.skills ?? [])];
	}

	setSkillPaths(paths: string[]): void {
		this.globalSettings.skills = paths;
		this.markModified("skills");
		this.save();
	}

	setProjectSkillPaths(paths: string[]): void {
		this.updateProjectSettings("skills", (settings) => {
			settings.skills = paths;
		});
	}

	getPromptTemplatePaths(): string[] {
		return [...(this.settings.prompts ?? [])];
	}

	setPromptTemplatePaths(paths: string[]): void {
		this.globalSettings.prompts = paths;
		this.markModified("prompts");
		this.save();
	}

	setProjectPromptTemplatePaths(paths: string[]): void {
		this.updateProjectSettings("prompts", (settings) => {
			settings.prompts = paths;
		});
	}

	getThemePaths(): string[] {
		return [...(this.settings.themes ?? [])];
	}

	setThemePaths(paths: string[]): void {
		this.globalSettings.themes = paths;
		this.markModified("themes");
		this.save();
	}

	setProjectThemePaths(paths: string[]): void {
		this.updateProjectSettings("themes", (settings) => {
			settings.themes = paths;
		});
	}

	getEnableSkillCommands(): boolean {
		return this.settings.enableSkillCommands ?? true;
	}

	setEnableSkillCommands(enabled: boolean): void {
		this.globalSettings.enableSkillCommands = enabled;
		this.markModified("enableSkillCommands");
		this.save();
	}

	getThinkingBudgets(): ThinkingBudgetsSettings | undefined {
		return this.settings.thinkingBudgets;
	}

	getShowImages(): boolean {
		return this.settings.terminal?.showImages ?? true;
	}

	setShowImages(show: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.showImages = show;
		this.markModified("terminal", "showImages");
		this.save();
	}

	getImageWidthCells(): number {
		const width = this.settings.terminal?.imageWidthCells;
		if (typeof width !== "number" || !Number.isFinite(width)) {
			return 60;
		}
		return Math.max(1, Math.floor(width));
	}

	setImageWidthCells(width: number): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.imageWidthCells = Math.max(1, Math.floor(width));
		this.markModified("terminal", "imageWidthCells");
		this.save();
	}

	getClearOnShrink(): boolean {
		// Settings takes precedence, then env var, then default false
		if (this.settings.terminal?.clearOnShrink !== undefined) {
			return this.settings.terminal.clearOnShrink;
		}
		return process.env.PI_CLEAR_ON_SHRINK === "1";
	}

	setClearOnShrink(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.clearOnShrink = enabled;
		this.markModified("terminal", "clearOnShrink");
		this.save();
	}

	getShowTerminalProgress(): boolean {
		return this.settings.terminal?.showTerminalProgress ?? false;
	}

	setShowTerminalProgress(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.showTerminalProgress = enabled;
		this.markModified("terminal", "showTerminalProgress");
		this.save();
	}

	getImageAutoResize(): boolean {
		return this.settings.images?.autoResize ?? true;
	}

	setImageAutoResize(enabled: boolean): void {
		if (!this.globalSettings.images) {
			this.globalSettings.images = {};
		}
		this.globalSettings.images.autoResize = enabled;
		this.markModified("images", "autoResize");
		this.save();
	}

	getBlockImages(): boolean {
		return this.settings.images?.blockImages ?? false;
	}

	setBlockImages(blocked: boolean): void {
		if (!this.globalSettings.images) {
			this.globalSettings.images = {};
		}
		this.globalSettings.images.blockImages = blocked;
		this.markModified("images", "blockImages");
		this.save();
	}

	getEnabledModels(): string[] | undefined {
		return this.settings.enabledModels;
	}

	setEnabledModels(patterns: string[] | undefined): void {
		this.globalSettings.enabledModels = patterns;
		this.markModified("enabledModels");
		this.save();
	}

	getDoubleEscapeAction(): "fork" | "tree" | "none" {
		return this.settings.doubleEscapeAction ?? "tree";
	}

	setDoubleEscapeAction(action: "fork" | "tree" | "none"): void {
		this.globalSettings.doubleEscapeAction = action;
		this.markModified("doubleEscapeAction");
		this.save();
	}

	getTreeFilterMode(): "default" | "no-tools" | "user-only" | "labeled-only" | "all" {
		const mode = this.settings.treeFilterMode;
		const valid = ["default", "no-tools", "user-only", "labeled-only", "all"];
		return mode && valid.includes(mode) ? mode : "default";
	}

	setTreeFilterMode(mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all"): void {
		this.globalSettings.treeFilterMode = mode;
		this.markModified("treeFilterMode");
		this.save();
	}

	getShowHardwareCursor(): boolean {
		return this.settings.showHardwareCursor ?? process.env.PI_HARDWARE_CURSOR === "1";
	}

	setShowHardwareCursor(enabled: boolean): void {
		this.globalSettings.showHardwareCursor = enabled;
		this.markModified("showHardwareCursor");
		this.save();
	}

	getEditorPaddingX(): number {
		return this.settings.editorPaddingX ?? 0;
	}

	setEditorPaddingX(padding: number): void {
		this.globalSettings.editorPaddingX = Math.max(0, Math.min(3, Math.floor(padding)));
		this.markModified("editorPaddingX");
		this.save();
	}

	getAutocompleteMaxVisible(): number {
		return this.settings.autocompleteMaxVisible ?? 5;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.globalSettings.autocompleteMaxVisible = Math.max(3, Math.min(20, Math.floor(maxVisible)));
		this.markModified("autocompleteMaxVisible");
		this.save();
	}

	getCodeBlockIndent(): string {
		return this.settings.markdown?.codeBlockIndent ?? "  ";
	}

	getWarnings(): WarningSettings {
		return { ...(this.settings.warnings ?? {}) };
	}

	setWarnings(warnings: WarningSettings): void {
		this.globalSettings.warnings = { ...warnings };
		this.markModified("warnings");
		this.save();
	}

	getSelfModificationSettings(): { enabled: boolean; sourcePath?: string; sourcePaths?: string[] } {
		return {
			enabled: this.settings.selfModification?.enabled ?? false,
			sourcePath: this.settings.selfModification?.sourcePath,
			sourcePaths: this.settings.selfModification?.sourcePaths,
		};
	}

	setSelfModificationSettings(settings: SelfModificationSettings, scope: SettingsScope = "global"): void {
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			const existing = projectSettings.selfModification;
			projectSettings.selfModification = {
				...existing,
				...settings,
				sourcePaths: settings.sourcePaths ?? existing?.sourcePaths,
			};
			this.markProjectModified("selfModification");
			this.saveProjectSettings(projectSettings);
			return;
		}

		const existing = this.globalSettings.selfModification;
		this.globalSettings.selfModification = {
			...existing,
			...settings,
			sourcePaths: settings.sourcePaths ?? existing?.sourcePaths,
		};
		this.markModified("selfModification");
		this.save();
	}

	getAutonomySettings(): Required<AutonomySettings> {
		const mode = this.settings.autonomy?.mode;
		const configuredMaxStallTurns = this.settings.autonomy?.maxStallTurns;
		const configuredGoalContinueTurns = this.settings.autonomy?.goalContinueTurns;
		const configuredGoalContinueMaxWallClockMinutes = this.settings.autonomy?.goalContinueMaxWallClockMinutes;
		const configuredGoalAutoContinue = this.settings.autonomy?.goalAutoContinue;
		const configuredGoalAutoContinueDelayMs = this.settings.autonomy?.goalAutoContinueDelayMs;

		const maxStallTurns = sanitizeIntegerSetting(
			configuredMaxStallTurns,
			DEFAULT_AUTONOMY_MAX_STALL_TURNS,
			0,
			MAX_GOAL_CONTINUE_MAX_STALL_TURNS,
		);
		const goalContinueTurns = sanitizeIntegerSetting(
			configuredGoalContinueTurns,
			DEFAULT_AUTONOMY_GOAL_CONTINUE_TURNS,
			1,
			MAX_GOAL_CONTINUE_MAX_TURNS,
		);
		const goalContinueMaxWallClockMinutes = sanitizeIntegerSetting(
			configuredGoalContinueMaxWallClockMinutes,
			DEFAULT_AUTONOMY_GOAL_CONTINUE_MAX_WALL_CLOCK_MINUTES,
			0,
			MAX_GOAL_CONTINUE_MAX_WALL_CLOCK_MINUTES,
		);
		const goalAutoContinueDelayMs = sanitizeIntegerSetting(
			configuredGoalAutoContinueDelayMs,
			DEFAULT_AUTONOMY_GOAL_AUTO_CONTINUE_DELAY_MS,
			0,
			MAX_GOAL_AUTO_CONTINUE_DELAY_MS,
		);

		return {
			mode: mode === "safe" || mode === "balanced" || mode === "full" ? mode : "off",
			maxStallTurns,
			goalContinueTurns,
			goalContinueMaxWallClockMinutes,
			goalAutoContinue:
				typeof configuredGoalAutoContinue === "boolean"
					? configuredGoalAutoContinue
					: DEFAULT_AUTONOMY_GOAL_AUTO_CONTINUE,
			goalAutoContinueDelayMs,
		};
	}

	setAutonomySettings(settings: AutonomySettings, scope: SettingsScope = "global"): void {
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			projectSettings.autonomy = { ...settings };
			this.markProjectModified("autonomy");
			this.saveProjectSettings(projectSettings);
			return;
		}

		this.globalSettings.autonomy = { ...settings };
		this.markModified("autonomy");
		this.save();
	}

	getResearchLaneSettings(): ResolvedResearchLaneSettings {
		const configured = this.settings.researchLane ?? {};

		const resolved: ResolvedResearchLaneSettings = {
			enabled: typeof configured.enabled === "boolean" ? configured.enabled : DEFAULT_RESEARCH_LANE_ENABLED,
			maxUsd: sanitizeNumberSetting(configured.maxUsd, DEFAULT_RESEARCH_LANE_MAX_USD, 0, MAX_RESEARCH_LANE_MAX_USD),
			maxSources: sanitizeIntegerSetting(
				configured.maxSources,
				DEFAULT_RESEARCH_LANE_MAX_SOURCES,
				1,
				MAX_RESEARCH_LANE_MAX_SOURCES,
			),
			maxFindings: sanitizeIntegerSetting(
				configured.maxFindings,
				DEFAULT_RESEARCH_LANE_MAX_FINDINGS,
				1,
				MAX_RESEARCH_LANE_MAX_FINDINGS,
			),
			maxWallClockMs: sanitizeIntegerSetting(
				configured.maxWallClockMs,
				DEFAULT_RESEARCH_LANE_MAX_WALL_CLOCK_MS,
				0,
				MAX_RESEARCH_LANE_MAX_WALL_CLOCK_MS,
			),
			idleDelayMs: sanitizeIntegerSetting(
				configured.idleDelayMs,
				DEFAULT_RESEARCH_LANE_IDLE_DELAY_MS,
				0,
				MAX_RESEARCH_LANE_IDLE_DELAY_MS,
			),
			maxRunsPerSession: sanitizeIntegerSetting(
				configured.maxRunsPerSession,
				DEFAULT_RESEARCH_LANE_MAX_RUNS_PER_SESSION,
				0,
				MAX_RESEARCH_LANE_MAX_RUNS_PER_SESSION,
			),
		};
		if (typeof configured.model === "string" && configured.model.trim().length > 0) {
			resolved.model = configured.model;
		}
		if (typeof configured.profile === "string" && configured.profile.trim().length > 0) {
			resolved.profile = configured.profile;
		}
		if (typeof configured.systemPrompt === "string" && configured.systemPrompt.trim().length > 0) {
			resolved.systemPrompt = configured.systemPrompt;
		}
		return resolved;
	}

	setResearchLaneSettings(settings: ResearchLaneSettings, scope: SettingsScope = "global"): void {
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			projectSettings.researchLane = { ...settings };
			this.markProjectModified("researchLane");
			this.saveProjectSettings(projectSettings);
			return;
		}

		this.globalSettings.researchLane = { ...settings };
		this.markModified("researchLane");
		this.save();
	}

	getWorkerDelegationSettings(): ResolvedWorkerDelegationSettings {
		const configured = this.settings.workerDelegation ?? {};

		const resolved: ResolvedWorkerDelegationSettings = {
			enabled: typeof configured.enabled === "boolean" ? configured.enabled : DEFAULT_WORKER_DELEGATION_ENABLED,
			maxUsd: sanitizeNumberSetting(
				configured.maxUsd,
				DEFAULT_WORKER_DELEGATION_MAX_USD,
				0,
				MAX_WORKER_DELEGATION_MAX_USD,
			),
			maxWallClockMs: sanitizeIntegerSetting(
				configured.maxWallClockMs,
				DEFAULT_WORKER_DELEGATION_MAX_WALL_CLOCK_MS,
				0,
				MAX_WORKER_DELEGATION_MAX_WALL_CLOCK_MS,
			),
			writeEnabled: configured.writeEnabled === true,
			writePaths: Array.isArray(configured.writePaths)
				? configured.writePaths.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
				: [],
			maxConcurrent: sanitizeIntegerSetting(configured.maxConcurrent, 1, 1, 3),
		};
		if (typeof configured.model === "string" && configured.model.trim().length > 0) {
			resolved.model = configured.model;
		}
		if (typeof configured.profile === "string" && configured.profile.trim().length > 0) {
			resolved.profile = configured.profile;
		}
		if (typeof configured.systemPrompt === "string" && configured.systemPrompt.trim().length > 0) {
			resolved.systemPrompt = configured.systemPrompt;
		}
		return resolved;
	}

	setWorkerDelegationSettings(settings: WorkerDelegationSettings, scope: SettingsScope = "global"): void {
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			projectSettings.workerDelegation = { ...settings };
			this.markProjectModified("workerDelegation");
			this.saveProjectSettings(projectSettings);
			return;
		}

		this.globalSettings.workerDelegation = { ...settings };
		this.markModified("workerDelegation");
		this.save();
	}

	getLearningPolicySettings(): ResolvedLearningPolicySettings {
		const configured = this.settings.learningPolicy ?? {};

		const allowedLayers = Array.isArray(configured.allowedAutoApplyLayers)
			? configured.allowedAutoApplyLayers.filter(
					(layer): layer is LearningPolicyLayer =>
						typeof layer === "string" &&
						["memory", "skill", "prompt", "extension", "tool", "script", "settings", "source"].includes(layer),
				)
			: [...DEFAULT_LEARNING_POLICY_ALLOWED_AUTO_APPLY_LAYERS];

		return {
			enabled: typeof configured.enabled === "boolean" ? configured.enabled : DEFAULT_LEARNING_POLICY_ENABLED,
			autoApplyEnabled:
				typeof configured.autoApplyEnabled === "boolean"
					? configured.autoApplyEnabled
					: DEFAULT_LEARNING_POLICY_AUTO_APPLY_ENABLED,
			confidenceThreshold: sanitizeIntegerSetting(
				configured.confidenceThreshold,
				DEFAULT_LEARNING_POLICY_CONFIDENCE_THRESHOLD,
				0,
				100,
			),
			minObservations: sanitizeIntegerSetting(
				configured.minObservations,
				DEFAULT_LEARNING_POLICY_MIN_OBSERVATIONS,
				0,
				100,
			),
			allowedAutoApplyLayers: allowedLayers,
			requireRollbackPlan:
				typeof configured.requireRollbackPlan === "boolean" ? configured.requireRollbackPlan : true,
			reflectionSourceConfidence: sanitizeIntegerSetting(
				configured.reflectionSourceConfidence,
				DEFAULT_LEARNING_POLICY_REFLECTION_SOURCE_CONFIDENCE,
				0,
				100,
			),
			autoApplySupersessions:
				typeof configured.autoApplySupersessions === "boolean"
					? configured.autoApplySupersessions
					: DEFAULT_LEARNING_POLICY_AUTO_APPLY_SUPERSESSIONS,
		};
	}

	getToolkitScripts(): ToolkitScript[] {
		const configured = this.settings.toolkit?.scripts;
		if (!Array.isArray(configured)) return [];
		return configured.filter(
			(script): script is ToolkitScript =>
				Boolean(script) &&
				typeof script.name === "string" &&
				script.name.length > 0 &&
				typeof script.description === "string" &&
				typeof script.path === "string" &&
				(script.runner === "uv" || script.runner === "powershell" || script.runner === "bash"),
		);
	}

	setToolkitSettings(settings: ToolkitSettings, scope: SettingsScope = "global"): void {
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			projectSettings.toolkit = { ...settings };
			this.markProjectModified("toolkit");
			this.saveProjectSettings(projectSettings);
			return;
		}

		this.globalSettings.toolkit = { ...settings };
		this.markModified("toolkit");
		this.save();
	}

	getModelCapabilitySettings(): Required<ModelCapabilitySettings> {
		const configured = this.settings.modelCapability?.mode;
		const mode: ModelCapabilityMode =
			configured === "auto" ||
			configured === "off" ||
			configured === "full" ||
			configured === "lean" ||
			configured === "minimal" ||
			configured === "chat"
				? configured
				: DEFAULT_MODEL_CAPABILITY_MODE;
		return { mode };
	}

	setModelCapabilitySettings(settings: ModelCapabilitySettings, scope: SettingsScope = "global"): void {
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			projectSettings.modelCapability = { ...settings };
			this.markProjectModified("modelCapability");
			this.saveProjectSettings(projectSettings);
			return;
		}

		this.globalSettings.modelCapability = { ...settings };
		this.markModified("modelCapability");
		this.save();
	}

	setLearningPolicySettings(settings: LearningPolicySettings, scope: SettingsScope = "global"): void {
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			projectSettings.learningPolicy = { ...settings };
			this.markProjectModified("learningPolicy");
			this.saveProjectSettings(projectSettings);
			return;
		}

		this.globalSettings.learningPolicy = { ...settings };
		this.markModified("learningPolicy");
		this.save();
	}

	getAutoLearnSettings(): AutoLearnSettings {
		const settings = this.settings.autoLearn ?? {};
		return {
			...settings,
			model: settings.model ?? this.getModelRouterSettings().learningModel,
			thinkingLevel: settings.thinkingLevel ?? "low",
			complexTaskToolCalls: settings.complexTaskToolCalls ?? 12,
		};
	}

	setAutoLearnSettings(settings: AutoLearnSettings, scope: SettingsScope = "global"): void {
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			projectSettings.autoLearn = { ...settings };
			this.markProjectModified("autoLearn");
			this.saveProjectSettings(projectSettings);
			return;
		}

		this.globalSettings.autoLearn = { ...settings };
		this.markModified("autoLearn");
		this.save();
	}

	getExternalResourceRoots(): string[] {
		return this.settings.externalResourceRoots ?? [];
	}

	setExternalResourceRoots(roots: string[], scope: SettingsScope = "global"): void {
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			projectSettings.externalResourceRoots = [...roots];
			this.markProjectModified("externalResourceRoots");
			this.saveProjectSettings(projectSettings);
			return;
		}

		this.globalSettings.externalResourceRoots = [...roots];
		this.markModified("externalResourceRoots");
		this.save();
	}

	getTrustedResourceRoots(): string[] {
		return this.settings.trustedResourceRoots ?? [];
	}

	setTrustedResourceRoots(roots: string[], scope: SettingsScope = "global"): void {
		if (scope === "project") {
			const projectSettings = structuredClone(this.projectSettings);
			projectSettings.trustedResourceRoots = [...roots];
			this.markProjectModified("trustedResourceRoots");
			this.saveProjectSettings(projectSettings);
			return;
		}

		this.globalSettings.trustedResourceRoots = [...roots];
		this.markModified("trustedResourceRoots");
		this.save();
	}

	addTrustedResourceRoot(path: string, scope: SettingsScope = "global"): void {
		const canonicalPath = this.canonicalizePath(path);
		if (!canonicalPath) return;

		const current = this.getTrustedResourceRoots();
		if (!current.includes(canonicalPath)) {
			this.setTrustedResourceRoots([...current, canonicalPath], scope);
		}
	}

	canonicalizePath(p: string): string | null {
		try {
			const resolved = resolve(p.replace(/^~/, homedir()));
			if (existsSync(resolved)) {
				return realpathSync(resolved);
			}
			return resolved;
		} catch {
			return null;
		}
	}

	getEffectiveExternalResourceRoots(): string[] {
		const roots = this.getExternalResourceRoots();
		const trusted = this.getTrustedResourceRoots();

		const canonicalTrusted = new Set(
			trusted.map((t) => this.canonicalizePath(t)).filter((t): t is string => t !== null),
		);

		const effective: string[] = [];
		for (const r of roots) {
			const canonicalR = this.canonicalizePath(r);
			if (canonicalR && canonicalR.trim() !== "" && canonicalTrusted.has(canonicalR) && existsSync(canonicalR)) {
				effective.push(canonicalR);
			}
		}
		return effective;
	}
}
