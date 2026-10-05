import type { Transport } from "@caupulican/pi-ai";
import type { GnuToolsDirSetting } from "../../utils/shell.ts";
import type { EdgeClass } from "../autonomy/edge-policy.ts";
import type { CostGuardSettings } from "../cost-guard.ts";
import type {
	HmoeIndependence,
	HmoePreference,
	HmoePreset,
	HmoeTeamStrategy,
	HmoeWeights,
} from "../expert-routing/vocabulary.ts";
import type { FastModePreference } from "../fast-mode.ts";
import type { WorkerModelPinsSettings } from "../orchestration/worker-model-pins.ts";
import type { SystemOneProviderChoice } from "../system-one/access.ts";
import type { ToolkitScript } from "../toolkit/script-registry.ts";

export interface CompactionSettings {
	enabled?: boolean; // default: true
	reserveTokens?: number; // default: 16384
	keepRecentTokens?: number; // default: 20000
	triggerPercent?: number; // default: 0.6 — early context-efficiency threshold, separate from the USD cost guard
	model?: string; // default: "auto" — cheap auxiliary model for the summary; "auto" picks cheapest authed, else the session model
	selfMonitor?: {
		enabled?: boolean;
		notice?: number;
		warning?: number;
		forced?: number;
		prompts?: { notice?: string; warning?: string; summary?: string };
	};
}

export interface ScoutSettings {
	enabled?: boolean; // default: false
	model?: string; // default: "auto" — resolve an installed FastContext model, else return unavailable from the tool
}

export interface SystemOneSettings {
	enabled?: boolean; // default: true
	/** Which key System One authenticates with; `auto` (default) prefers TypeSafe, then OpenRouter. The engine version is pinned (Jev 1.13). */
	provider?: SystemOneProviderChoice;
	/** Who drives an active goal: System One's objective routes (default when System One is bound) or the legacy continuation. */
	loopMode?: "legacy_goal" | "objective_shadow" | "objective_primary";
	/** Completion assurance the objective must pass; default semantic_enhanced under a semantic plane, mechanical without. */
	completionProfile?: "mechanical" | "mechanical_plus_reviewer" | "semantic_enhanced" | "system_one_required";
}

export interface SemanticMemoryGcSettings {
	enabled?: boolean; // default: true
	preserveRecentPages?: number; // default: 1 -- see context-gc.ts DEFAULT_CONTEXT_GC_SETTINGS (canonical)
	minChars?: number; // default: 900 -- see context-gc.ts DEFAULT_CONTEXT_GC_SETTINGS (canonical)
	markers?: string[]; // default: memory/automata recall markers + the task_steps_context checklist marker
}

export interface ContextGcSettings {
	enabled?: boolean; // default: true
	preserveRecentMessages?: number; // default: 24 -- see context-gc.ts DEFAULT_CONTEXT_GC_SETTINGS (canonical)
	// Grid the preserve-recent boundary advances on, so packing batches instead of rewriting history
	// every turn and busting the provider prefix cache -- see context/prefix-stability.ts.
	packStrideMessages?: number; // default: half preserveRecentMessages; 1 restores continuous packing
	minToolResultChars?: number; // default: 1200
	tools?: string[]; // default: the packed-output tools, ls, skill/automata/delegation records, artifact_retrieve
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
	// default: mirrors the live contextGc.preserveRecentMessages (getContextGcSettings()), so tuning
	// GC's window moves this default with it; an explicit value here always wins over the mirror.
	preserveRecentMessages?: number;
	// default: mirrors the live contextGc.minToolResultChars (getContextGcSettings()); an explicit
	// value here always wins over the mirror.
	minChars?: number;
}

/**
 * Local memory retrieval (see context/memory-retrieval.ts, context/memory-prompt-block.ts):
 * default-on for local, safe-auto sources. Prompt inclusion is still budget-gated per turn;
 * compact models get at most a 10-line/~200-token source-labeled block or no memory block.
 * External/non-local providers remain blocked unless explicitly allowed by policy.
 */
export interface MemoryRetrievalSettings {
	enabled?: boolean; // default: true -- local safe-auto retrieval
	maxResults?: number; // default: 5, clamped to [1, 20]
	includeInPrompt?: boolean; // default: true -- budget-gated safe-auto prompt inclusion
	allowExternalEgress?: boolean; // default: false -- explicit opt-in for raw query egress
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
	connectMs?: number; // max wait for the first stream event (default: local 120000, cloud 120000)
	activeIdleMs?: number; // max event gap while content is flowing (default: local 180000, cloud 120000)
	quietIdleMs?: number; // max event gap during prefill/unstreamed thinking, clamped below nonzero httpIdleTimeoutMs (default: local 600000, cloud 300000)
}

/**
 * Stream-stall bounds, split by model class: a CPU-served local model legitimately sits silent
 * for minutes while it loads and prefills, a hosted stream that goes quiet that long is dead.
 * `local` governs local and pi-managed models, `cloud` every hosted provider.
 *
 * The top-level bounds predate the split and still work: they are the `local` budget (a `local`
 * entry wins field by field over them), and while they are set without a `cloud` entry the
 * manager reports once that cloud providers are now governed by `retry.stall.cloud`.
 */
export interface StreamStallBudgetSettings extends StreamStallSettings {
	local?: StreamStallSettings;
	cloud?: StreamStallSettings;
}

/** Which stall budget a model draws on; see {@link StreamStallBudgetSettings}. */
export type StreamStallModelClass = "local" | "cloud";

export interface RetrySettings {
	enabled?: boolean; // default: true
	maxRetries?: number; // default: 3
	baseDelayMs?: number; // default: 2000 (exponential backoff: 2s, 4s, 8s)
	provider?: ProviderRetrySettings;
	stall?: StreamStallBudgetSettings; // stream-stall watchdog bounds per model class (pi-agent-core reliability/watchdogs.ts)
}

export interface TerminalSettings {
	showImages?: boolean; // default: true (only relevant if terminal supports images)
	imageWidthCells?: number; // default: 60 (preferred inline image width in terminal cells)
	clearOnShrink?: boolean; // default: false (clear empty rows when content shrinks)
	showTerminalProgress?: boolean; // default: false (OSC 9;4 terminal progress indicators)
	hyperlinks?: boolean;
	images?: "kitty" | "iterm2" | "none" | null;
	trueColor?: boolean;
}

export interface ImageSettings {
	autoResize?: boolean; // default: true (resize images to 2000x2000 max for better model compatibility)
	blockImages?: boolean; // default: false - when true, prevents all images from being sent to LLM providers
	clipboardDirectory?: string; // default: <agentDir>/state/attachments; relative paths resolve from the active cwd
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

export type AutoLearnThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface AutoLearnSettings {
	enabled?: boolean; // effective default: true in every autonomy preset; explicit false is the kill switch
	model?: string; // "active" or omitted uses the current session model; otherwise a pi --model pattern
	thinkingLevel?: AutoLearnThinkingLevel; // default: low for background learner subprocesses
	longSessionMessages?: number; // preset default: 32 in off, 64 otherwise
	longSessionContextPercent?: number; // preset default: 70 in off, 85 otherwise
	cooldownMinutes?: number; // default: 1440 per session tenant (manual /auto-learn run bypasses)
	leaseMinutes?: number; // default: 90 for background learner state leases
	maxConcurrentLearners?: number; // preset default: 1 per session tenant
	applyHighConfidence?: boolean; // default: false unless the learning extension config opts in
	reflectionReview?: boolean; // default: true when Auto Learn is enabled - include one root-session cue on eligible external turns; completed-turn signals coalesce
	reflectionMinToolCalls?: number; // default: 12 tool calls in a turn before a root-session reflection cue is queued
	reflectionCooldownMinutes?: number; // default: 1440 per session tenant between root-session reflection cues
	complexTaskToolCalls?: number; // default: 12 tool calls before bypassing reflection cooldown as a complex task
}

export type AutonomyMode = "off" | "safe" | "balanced" | "full";

export interface AutonomySettings {
	mode?: AutonomyMode; // default: off; presets drive Auto Learn/reflection without many knobs
	maxStallTurns?: number; // default: 20; unchanged-turn threshold that forces a different autonomous recovery approach
	goalContinueTurns?: number; // default: 0 (unbounded); a positive value is an explicit per-loop limit
	goalContinueMaxWallClockMinutes?: number; // default: 0; 0 disables wall-clock budget
	goalAutoContinue?: boolean; // default: true; auto-inject continuation prompts when an active goal is idle
	goalAutoContinueDelayMs?: number; // default: 0; delay before idle auto-continuation starts
}

export interface FailoverSettings {
	subscriptionHop?: boolean; // default: true; subscription quota can hop once to an authenticated provider default
}

/**
 * How the router picks the exact model for a tier. `manual`: the operator's per-tier pins only
 * (legacy behavior, the default for existing installs). `auto`: the router decides the tier and
 * then selects the exact model adaptively from the candidate pool. `hybrid`: a pinned tier wins,
 * an unpinned tier selects automatically.
 */
export type ModelRouterSelectionMode = "manual" | "auto" | "hybrid";

/**
 * Ranking preference applied inside the candidate pool AFTER hard admission. `subscription-first`
 * (the default) ranks adequate subscription-backed models ahead of metered ones; `balanced` keeps
 * the evidence ranking alone. Preference is never authority: it cannot override auth, quota,
 * tool incompatibility, a fitness gate, a manual pin or the pool boundary.
 */
export type ModelRouterPoolPreference = "subscription-first" | "balanced";

export interface ModelRouterSettings {
	enabled?: boolean; // default: on when the session has System One, off otherwise (setModelRouterDefaultEnabled)
	selectionMode?: ModelRouterSelectionMode; // default: manual — existing installs keep exact-pin behavior
	poolPreference?: ModelRouterPoolPreference; // default: subscription-first — applies only to auto-selected tiers
	cheapModel?: string; // model pattern for read-only/research turns
	mediumModel?: string; // model pattern for normal scoped implementation, edits, and refactors
	expensiveModel?: string; // model pattern for modify/tool-heavy turns
	learningModel?: string; // model pattern for explicit/background learning and skill-creator work; automatic reflection uses the current session turn
	fitnessGate?: boolean; // default: false — opt-in; blocks tier models whose probed relevant lane failed (Class B, subtractive)
	executorModel?: string; // model pattern for the local executor lane (direct toolkit commands); unset disables it
	// Per-tier thinking: overrides the inherited-and-clamped session thinking level for a routed
	// turn on that tier only (see agent-session.ts's routed-turn swap). Unset reproduces today's
	// behavior exactly — inherit the session thinking level, clamped to the routed model. learningModel
	// already has its own thinking via autoLearn.thinkingLevel, so there is deliberately no learningThinking.
	cheapThinking?: ThinkingLevel;
	mediumThinking?: ThinkingLevel;
	expensiveThinking?: ThinkingLevel;
	executorThinking?: ThinkingLevel; // thinking level for the executor-direct lane
	hmoePreset?: HmoePreset;
	hmoeTeamStrategy?: HmoeTeamStrategy;
	hmoeIndependence?: HmoeIndependence;
	hmoePreference?: HmoePreference;
	hmoeWeights?: HmoeWeights;
}

export interface ResearchLaneSettings {
	enabled?: boolean; // default: false — autonomous background research is opt-in
	model?: string; // model pattern; unset inherits the session model the lane was shipped from
	profile?: string; // shipped profile; model/soul/thinking plus grants over classified read-only lane tools govern it
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

/**
 * How a worker's thinking level is derived when nothing pins it: `step_down` runs workers one notch
 * below the foreground level (xhigh -> high), `inherit` copies the foreground level. Measured
 * 2026-09-11: workers inherited xhigh, and a wave of five to seven workers each spending the
 * foreground's full reasoning budget at once was the largest single source of shared-account load.
 */
export type WorkerThinkingPolicy = "inherit" | "step_down";

/**
 * Which account fresh workers run on when nothing pins their model: `other` routes them to a
 * configured provider the foreground is NOT using (a separate subscription or key, so a worker
 * wave never competes with the owner's own turn for one account's budget), `same` keeps them on the
 * foreground model. `routeProviders` orders the candidates (`provider` or `provider/modelId`);
 * every other authenticated provider follows in catalog order; with no alternative the worker
 * falls back to the foreground model.
 */
export type WorkerAccountPolicy = "other" | "same";

export interface WorkerAccountRouting {
	account: WorkerAccountPolicy;
	routeProviders: string[];
	/** Per worker role, an ordered candidate list that replaces `routeProviders` for that role. */
	routeProvidersByRole?: Record<string, string[]>;
}

export interface WorkerDelegationSettings {
	enabled?: boolean; // default: true for capable models; explicit false is a hard off-switch
	orchestrationProfile?: string; // optional execution preset; agents may replace its defaults within inherited authority
	maxUsd?: number; // default: 0 (unbounded); a positive value caps spend for one worker task
	maxWallClockMs?: number; // default: 0 (unbounded); a positive value caps one worker task's cumulative active time
	writeEnabled?: boolean; // default: true; explicit false revokes direct write/edit tools
	reportHandshake?: boolean; // default: true; a worker about to stop with something checkable (requirement ids, commands, changed files) is asked once for a report the host checks against its receipts; explicit false keeps the plain text path
	haltReportDeadlineMs?: number; // default: 120000; how long an interrupted worker gets to reach a request boundary and report before it is cancelled
	maxConcurrent?: number; // default: 5 (above the Codex CLI per-session default of 3); running leaf-worker concurrency; fixed fleet safety ceilings separately bound durable identities and queued dispatches
	modelPins?: WorkerModelPinsSettings; // optional global/local role pins; absent preserves adaptive routing exactly
	thinking?: WorkerThinkingPolicy; // default: step_down; worker thinking relative to the foreground when no authority or profile pins it
	account?: WorkerAccountPolicy; // default: other; fresh workers run on a provider the foreground is not using when one is authenticated
	routeProviders?: string[]; // ordered routing candidates, `provider` or `provider/modelId`; other authenticated providers follow
	routeProvidersByRole?: Record<string, string[]>; // per role (explorer, implementer, verifier, ...): candidates that replace routeProviders for that role
}

export type ResolvedWorkerDelegationSettings = Required<
	Omit<
		WorkerDelegationSettings,
		"orchestrationProfile" | "modelPins" | "thinking" | "account" | "routeProviders" | "routeProvidersByRole"
	>
> &
	Pick<WorkerDelegationSettings, "orchestrationProfile">;

/** Staleness-propagation policy for worktree-sync; see `core/worktree-sync/codes.ts`. */
export type WorktreeSyncPolicySetting = "on_land_mandatory" | "overlap_mandatory" | "land_time_only";

export interface ToolOutputSettings {
	/** `off` disables every reduction stage for bash and python output. Default `on`. */
	reduction?: "on" | "off";
	/** Reduction level; `auto` follows the model's capability tier. Default `auto`. */
	level?: "standard" | "compact" | "auto";
	/** Extra rules file (same schema as `.pi/output-filters.json`), loaded after the user and project files. */
	rulesFile?: string;
}

export interface ResolvedToolOutputSettings {
	reduction: "on" | "off";
	level: "standard" | "compact" | "auto";
	rulesFile?: string;
}

export interface WorktreeSyncSettings {
	enabled?: boolean; // default: true -- master switch; explicit false is the hard off-switch (zero behavior change when off)
	mainBranch?: string; // overrides default-branch resolution (main, then master; never guessed further)
	syncPolicy?: WorktreeSyncPolicySetting; // default: "on_land_mandatory" -- every land marks every other active lane sync_required
	gateCommand?: string; // land gate command run in the lane worktree at the exact tip that becomes main (e.g. "npm run check")
	gate?: "on" | "off"; // default: "on" -- "off" is the owner-level G4 opt-out, recorded per land event
	gateTimeoutMs?: number; // default: 900000
	maxLanes?: number; // default: 5 -- active-lane ceiling, matches the <=5-coder orchestration shape
	worktreesRoot?: string; // overrides the default lane-checkout root (agent-paths worktreesDir)
	workerLand?: "deny" | "allow"; // default: "deny" -- whether a WORKER session (see session-role.ts) may run the "land" action at all; "allow" still subjects the land to normal ownership/freshness gating
}

export type ResolvedWorktreeSyncSettings = Required<
	Omit<WorktreeSyncSettings, "mainBranch" | "gateCommand" | "worktreesRoot">
> &
	Pick<WorktreeSyncSettings, "mainBranch" | "gateCommand" | "worktreesRoot">;

/** Durable master/worker process-matrix supervision; see `core/process-matrix/`. */
export interface ProcessMatrixSettings {
	enabled?: boolean; // default: true -- master switch; explicit false is the hard off-switch (zero behavior change when off)
	heartbeatMs?: number; // default: 30000 -- master heartbeat interval
	adoptionGraceMs?: number; // default: 300000 -- how long an orphaned worker waits (polling for an adopt/cleanup directive) before self-exiting
	watcherPollMs?: number; // default: 25000 -- poll cadence for parent-liveness / directive checks
}

export type ResolvedProcessMatrixSettings = Required<ProcessMatrixSettings>;

/** Auto-backgrounding threshold for long-running foreground tool calls; see `core/background-tool-task-controller.ts`. */
export interface BackgroundToolSettings {
	callAfterMs?: number; // default: DEFAULT_BACKGROUND_TOOL_CALL_AFTER_MS (0 = off) -- a positive value hands a foreground tool call running longer than this off to a background task; the model's `background: true` and the operator's app.tools.background work regardless
}

export type ResolvedBackgroundToolSettings = Required<BackgroundToolSettings>;

/** Parallel tool execution (packages/agent's refill pool): how many tool bodies of one assistant message run at once. */
export interface ToolExecutionSettings {
	concurrency?: number; // default: DEFAULT_TOOL_EXECUTION_CONCURRENCY -- pool width for a parallel tool batch; sequential-mode tools still run alone
}

export type ResolvedToolExecutionSettings = Required<ToolExecutionSettings>;

/**
 * Machine-wide per-provider admission for worker and background provider requests; see
 * `core/provider-admission/`. The foreground lane never waits. No provider is capped by default:
 * the Codex CLI itself applies no per-account request cap (its only concurrency control is the
 * per-session thread limit mirrored by `workerDelegation.maxConcurrent`), and the 2026-09-11
 * census measured per-stream slowdown under shared load but not the number at which a cap pays
 * for itself. By default the ledger only records what is in flight; a limit is an owner choice.
 */
export interface ProviderAdmissionSettings {
	enabled?: boolean; // default: true
	limits?: Record<string, number>; // per provider id: in-flight cap for non-foreground lanes; none by default; 0 removes an entry
	maxWaitMs?: number; // default: 120000; a waiting request is admitted regardless after this long (recorded as timedOut)
	foregroundLimitWaitMs?: number; // default: 60000; longest the foreground waits for a machine-wide recorded provider limit before the request is refused with the reset time
}

export type ResolvedProviderAdmissionSettings = Required<ProviderAdmissionSettings>;

/**
 * Source charsets the user states for files the project itself does not declare, as EditorConfig
 * globs relative to the working directory. The harness resolves an undeclared file from its own
 * bytes through the managed Python codec, so this is for the cases content cannot settle: a tree
 * whose legacy charset is not the one detection would infer, or one that must not be inferred at
 * all. Project rules are consulted before global ones, and the first matching glob wins.
 */
export type FileEncodingsSettings = Record<string, string>;

/** The edge (`src/core/autonomy/edge-policy.ts`): operation classes this machine grants standing. */
export interface EdgeSettings {
	mode?: "guarded" | "yolo"; // default: guarded; yolo bypasses harness execution permission gates
	allow?: string[]; // default: all EDGE_CLASSES; an explicit list, including [], replaces the default; unknown names are ignored
	deny?: string[]; // shell-command globs that remain blocked in yolo; empty by default
}

export interface ResolvedEdgeSettings {
	mode: "guarded" | "yolo";
	allow: EdgeClass[];
	deny: string[];
}

/** Windows shell contract engine tier (`src/core/tools/windows-shell-engine.ts`). */
export interface WindowsShellSettings {
	pythonEngine?: boolean; // default: true -- routes complex/state-mutating Bash constructs to the bundled Python engine on Windows; explicit false restores the PowerShell-only floor verbatim
	gnuToolsDir?: GnuToolsDirSetting; // default: "auto" -- Git for Windows' usr\bin discovered from the git on PATH; "off" keeps every coreutils name on the engine builtins; else an explicit directory of GNU tools
}

export type ResolvedWindowsShellSettings = Required<WindowsShellSettings>;

export type LearningPolicyLayer =
	| "memory"
	| "skill"
	| "prompt"
	| "extension"
	| "tool"
	| "script"
	| "settings"
	| "source";

export interface LearningPolicySettings {
	enabled?: boolean; // default: true — main-session reflection routes durable writes through the audited policy
	autoApplyEnabled?: boolean; // default: true — safe additive/organizational writes may apply without user babysitting
	confidenceThreshold?: number; // default: 50 (0-100), matching the default reflection-source confidence
	minObservations?: number; // default: 1 — a main-session reflection may apply a first safe observation
	allowedAutoApplyLayers?: LearningPolicyLayer[]; // default: ["memory", "skill"] — every other layer stays proposal-first
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

export interface ModelCapabilitySettings {
	/**
	 * default: "auto" — derive the tool/lane surface from the model's context window so small open
	 * models stay usable for chat. "off" disables detection; a class name forces that class.
	 */
	mode?: ModelCapabilityMode;
}

export type BedrockScopeVerification = "identity+control-plane+runtime" | "runtime";

/** User-owned, verified Amazon Bedrock request and model-visibility boundary. */
export interface BedrockScopeSettings {
	region: string;
	profile?: string;
	modelIds: string[];
	verifiedAt: string;
	verification: BedrockScopeVerification;
}

export interface ModelFavorite {
	provider: string;
	modelId: string;
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

export interface ToolRepairSettings {
	teach?: boolean;
	textProtocol?: boolean;
	logging?: boolean;
}

/** Operator-owned Workbench geometry and input ownership; nothing here auto-sizes or auto-folds. */
export interface WorkbenchSettings {
	/** "on": the workbench owns the mouse (wheel scroll, chips, drag-select that copies on release, drag edges to resize, click titles to hide or maximize, right-click paste). "off": the terminal keeps it for its native gestures. */
	mouse?: "off" | "on";
	/** Work-area rows the operator chose (2..60), or "half" for an even split; the conversation keeps its minimum regardless. */
	rows?: number | "half";
	/** Work area collapsed to its divider. */
	collapsed?: boolean;
	/** Work plan / Team inspector shown beside Execution, or hidden so Execution takes the width. */
	inspector?: "shown" | "hidden";
	/** Execution takes every row the conversation minimum leaves. */
	executionMaximized?: boolean;
	/** Inspector width as a fraction of the work area (0.2..0.45) when the panes sit side by side. */
	inspectorFraction?: number;
	/** stacked: work area above conversation (default). columns: conversation left, execution right. */
	layout?: "stacked" | "columns";
	/** Conversation column width in columns layout (0.3..0.7). */
	conversationFraction?: number;
	/** Previews Execution retains per cycle (4..200); the transcript keeps the complete record. */
	previews?: number;
	/** The Decision graph pane beside the conversation: shown, or hidden by the operator. */
	graph?: "shown" | "hidden";
	/** The graph's share of the conversation zone (0.25..0.5). */
	graphFraction?: number;
	/** How the graph draws the loop: the stage list with timers, or the diagram composed per task. */
	graphView?: "list" | "diagram" | "lanes";
}

export interface ReasoningSettings {
	/**
	 * Thinking level for a turn the HOST started after a background tool or worker finished, whose
	 * expected work is bookkeeping: read the delivered result, cite it, continue. Ordinary turns the
	 * operator or the model drives are never affected, and `/thinking` still reports the session level.
	 *
	 * - unset (the default): one level below the session's current level, with a floor of `"low"`,
	 *   and never above the session level (so a session already at or below `"low"` is left alone).
	 * - `"inherit"`: exactly the session level, i.e. the behaviour before this setting existed.
	 * - an explicit level: that level, clamped to at most the session level. This policy only ever
	 *   lowers effort for a host turn; it can never raise it.
	 */
	hostTurnThinking?: ThinkingLevel | "inherit";
	/**
	 * Thinking level for the request that answers ONLY bookkeeping tool results (`goal`,
	 * `task_steps`): the model just recorded or read harness state and is about to continue.
	 *
	 * - unset (the default): `"low"`, clamped to at most the session level.
	 * - `"inherit"`: the session level, i.e. the policy is off.
	 * - an explicit level: that level, clamped to at most the session level. Never raises effort.
	 */
	bookkeepingThinking?: ThinkingLevel | "inherit";
}

export interface LocalRuntimeConfig {
	enabled?: boolean;
}

export interface LocalRuntimesSettings {
	ollama?: LocalRuntimeConfig;
	llamacpp?: LocalRuntimeConfig;
	transformers?: LocalRuntimeConfig;
}

export interface Settings {
	lastChangelogVersion?: string;
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: ThinkingLevel;
	/** Globally pinned model identities. Identity is the provider and model id pair, not id alone. */
	modelFavorites?: ModelFavorite[];
	memorySystem?: MemorySystem;
	/** ASD-STE100 explanation strictness 0-10 (0 off); default 9. */
	steStrictness?: number;
	/** Provider-scoped fast-mode preferences. Concrete providers own the supported modes. */
	fastMode?: Record<string, FastModePreference>;
	transport?: TransportSetting; // default: "auto"
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	theme?: string;
	/** Resource catalog directory (round resource management): the folder pi installs/updates/backs up from. */
	catalogDir?: string;
	compaction?: CompactionSettings;
	scout?: ScoutSettings;
	/** TypeSafe System One configuration (direct API or OpenRouter) */
	systemOne?: SystemOneSettings;
	/** Proactive per-turn cost guard (#34). */
	costGuard?: Partial<CostGuardSettings>;
	/** Per-request reasoning policy for turns the operator did not start. */
	reasoning?: ReasoningSettings;
	/** Skill curator (#32): auto-archive stale reflection-promoted skills at session start. */
	curator?: { autoArchive?: boolean; staleDays?: number };
	contextGc?: ContextGcSettings;
	contextPolicy?: ContextPolicySettings;
	branchSummary?: BranchSummarySettings;
	retry?: RetrySettings;
	maxOutputTokens?: number; // default: 32768 — per-response output cap; narrows the model's own limit, never widens it
	hideThinkingBlock?: boolean;
	shellPath?: string; // Custom shell path (e.g., for Cygwin users on Windows)
	exposeSessionEnvironment?: boolean; // Default true: inject session identity env vars (PI_SESSION_ID, etc.) into shell processes
	quietStartup?: boolean;
	/**
	 * How to treat repository AGENTS.md/CLAUDE.md/GEMINI.md files.
	 * `"off"` (default): global `~/.pi/agent` files only; do not walk project files.
	 * `"on-demand"`: opt in for this settings scope — list project paths, do not inject contents.
	 * Persist per directory (directory overlay), per project (`.pi/settings.json`), or globally.
	 */
	projectContextFiles?: "on-demand" | "off";
	shellCommandPrefix?: string; // Prefix prepended to every bash command (e.g., "shopt -s expand_aliases" for alias support)
	npmCommand?: string[]; // Command used for npm package lookup/install operations, argv-style (e.g., ["mise", "exec", "node@20", "--", "npm"])
	collapseChangelog?: boolean; // Show condensed changelog after update (use /changelog for full)
	packages?: PackageSource[]; // Array of npm/git package sources (string or object with filtering)
	extensions?: string[]; // Array of local extension file paths/directories or include/exclude patterns
	skills?: string[]; // Array of local skill file paths/directories or include/exclude patterns
	prompts?: string[]; // Array of local prompt template paths/directories or include/exclude patterns
	themes?: string[]; // Array of local theme file paths/directories or include/exclude patterns
	externalResourceRoots?: string[]; // External directory roots to scan for resources
	trustedResourceRoots?: string[]; // Explicitly trusted external directory roots (canonical absolute paths)
	disabledResources?: DisabledResourcesSettings; // Legacy reversible block filters for extensions/skills/prompts/themes/agents/tools
	resourceProfiles?: Record<string, ResourceProfileSettings | ProfileDefinitionInput>; // Named resource filters, optionally with full situation metadata
	activeResourceProfile?: string | string[]; // Active profile name(s), applied after global/project/directory settings merge
	activeResourceProfiles?: string[]; // Active profile names, equivalent to activeResourceProfile array
	activeOrchestrationProfile?: string; // owner-authored role/model/thinking/tools/resources/budget profile for the foreground session
	enableSkillCommands?: boolean; // default: true - register skills as /skill:name commands
	terminal?: TerminalSettings;
	images?: ImageSettings;
	enabledModels?: string[]; // Model patterns for cycling (same format as --models CLI flag)
	defaultTools?: string[]; // Default tool allowlist for main sessions (global-only)
	doubleEscapeAction?: "fork" | "tree" | "none"; // Action for double-escape with empty editor (default: "tree")
	workbench?: WorkbenchSettings;
	treeFilterMode?: "default" | "no-tools" | "user-only" | "labeled-only" | "all"; // Default filter when opening /tree
	thinkingBudgets?: ThinkingBudgetsSettings; // Custom token budgets for thinking levels
	showCacheMissNotices?: boolean; // Show notices for cache misses from idle gaps or model switches (default: false)
	editorPaddingX?: number; // Horizontal padding for input editor (default: 0)
	autocompleteMaxVisible?: number; // Max visible items in autocomplete dropdown (default: 5)
	showHardwareCursor?: boolean; // Show terminal cursor while still positioning it for IME
	markdown?: MarkdownSettings;
	warnings?: WarningSettings;
	selfModification?: SelfModificationSettings; // Local guardrails for modifying the pi-adaptative source/harness
	autonomy?: AutonomySettings; // Low-config autonomy preset controlling background learning/reflection defaults
	researchLane?: ResearchLaneSettings; // Opt-in autonomous read-only research lane producing evidence bundles
	workerDelegation?: WorkerDelegationSettings; // Autonomous persistent leaf-worker scheduling; enabled by default on capable models
	worktreeSync?: WorktreeSyncSettings; // Opt-in hard-gated worktree-per-lane parallel-work workflow (core/worktree-sync)
	toolOutput?: ToolOutputSettings; // Tool-output reduction pipeline (core/tools/output-reduction); on at the standard level by default
	processMatrix?: ProcessMatrixSettings; // Durable master/worker process-matrix supervision (core/process-matrix); on by default
	windowsShell?: WindowsShellSettings; // Windows shell contract engine tier (core/tools/windows-shell-engine); on by default
	backgroundTool?: BackgroundToolSettings; // Clock-based backgrounding of long foreground tool calls (core/background-tool-task-controller); off by default
	toolExecution?: ToolExecutionSettings; // Parallel tool batch pool width (packages/agent refill pool); 8 by default
	providerAdmission?: ProviderAdmissionSettings; // Machine-wide per-provider in-flight admission for worker/background lanes (core/provider-admission); on by default
	fileEncodings?: FileEncodingsSettings; // Source charset per EditorConfig-style glob; overrides .editorconfig, loses to an explicit encoding argument
	edge?: EdgeSettings; // Standing grants for the edge classes that would otherwise ask the operator (core/autonomy/edge-policy)
	learningPolicy?: LearningPolicySettings; // Default-on audited learning policy; destructive supersessions remain proposal-gated
	modelCapability?: ModelCapabilitySettings; // Auto-detected small-model tool/lane surface (default: auto)
	bedrock?: BedrockScopeSettings; // User-level verified profile/region/model scope for Amazon Bedrock
	toolkit?: ToolkitSettings; // User's blessed daily-ops script registry for run_toolkit_script
	modelRouter?: ModelRouterSettings; // Opt-in deterministic cheap/expensive model routing foundation
	localRuntimes?: LocalRuntimesSettings; // Operator controls to enable/disable local runtimes (ollama, llamacpp, transformers)
	toolRepair?: ToolRepairSettings; // Tool-recovery logging plus teach and text-protocol switches
	failover?: FailoverSettings; // Provider quota behavior; metered quota always halts for explicit user choice
	autoLearn?: AutoLearnSettings; // Root current-session reflection plus explicitly invoked Auto Learn compatibility settings
	sessionDir?: string; // Custom session storage directory (same format as --session-dir CLI flag)
	httpIdleTimeoutMs?: number; // HTTP header/body idle timeout in ms; 0 disables it. Nonzero values constrain every stream-watchdog phase below this timeout
	websocketConnectTimeoutMs?: number; // WebSocket connect/open handshake timeout in milliseconds; 0 disables it
}

export type MemorySystem = "okf" | "icm";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface ProfileDefinitionInput {
	name?: string;
	description?: string;
	model?: string;
	thinking?: ThinkingLevel;
	modelRouter?: ModelRouterSettings;
	/**
	 * Situational identity: a system-prompt prefix injected while this profile is active, so a
	 * profile becomes a full "situation" = soul + capabilities + model/thinking, switched atomically.
	 */
	soul?: string;
	resources: ResourceProfileSettings;
}

export type ProfilePersistenceScope = "session" | "directory" | "project" | "global" | "reusable-file";

export type SettingsScope = "global" | "project" | "directoryProfile";

export type SettingsErrorScope = SettingsScope;

export interface DirectoryResourceProfileInfo {
	root: string;
	hash: string;
	path: string;
}

export interface SettingsError {
	scope: SettingsErrorScope;
	error: Error;
}

/** In-memory settings generation captured around an atomic runtime reload. */
export interface SettingsReloadSnapshot {
	globalSettings: Settings;
	projectSettings: Settings;
	directoryProfileSettings: Settings;
	runtimeResourceProfiles: string[] | undefined;
	inlineResourceProfileDefinitions: Record<string, ProfileDefinitionInput>;
	discoveredResourceProfileDefinitions: Record<string, ResourceProfileSettings>;
	effectiveSettings: Settings;
	projectTrusted: boolean;
	modifiedFields: Set<keyof Settings>;
	modifiedNestedFields: Map<keyof Settings, Set<string>>;
	modifiedProjectFields: Set<keyof Settings>;
	modifiedProjectNestedFields: Map<keyof Settings, Set<string>>;
	globalSettingsLoadError: Error | null;
	projectSettingsLoadError: Error | null;
	directoryProfileSettingsLoadError: Error | null;
	directoryProfileInfo: DirectoryResourceProfileInfo | null;
	errors: SettingsError[];
}

export interface GlobalResourceProfileConfiguration {
	resourceProfiles?: Settings["resourceProfiles"];
	activeResourceProfile?: Settings["activeResourceProfile"];
	activeResourceProfiles?: Settings["activeResourceProfiles"];
	externalResourceRoots?: string[];
	trustedResourceRoots?: string[];
}
