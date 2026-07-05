/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
	Agent,
	AgentContext,
	AgentEvent,
	AgentMessage,
	AgentState,
	AgentTool,
	StreamFn,
	StreamIdleOptions,
	ThinkingLevel,
} from "@caupulican/pi-agent-core";
import {
	type CustomMessage,
	classifyFailure,
	compactToolResultDetailsForRetention,
	computeRetryDelayMs,
	createCustomMessage,
	DEFAULT_RETRY_POLICY,
	RetryController,
	type RetryPolicy,
	sleepAbortable,
	withStreamIdleWatchdog,
} from "@caupulican/pi-agent-core";
import {
	type BranchSummaryEntry,
	type CompactionEntry,
	type CompactionResult,
	type CompactionSettings,
	calculateContextTokens,
	compact,
	createDeterministicCompaction,
	estimateContextTokens,
	getLatestCompactionEntry,
	prepareCompaction,
	runCompactionLoop,
	type SessionManager,
	shouldCompact,
} from "@caupulican/pi-agent-core/node";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	ImageContent,
	Message,
	Model,
	StopReason,
	TextContent,
	Usage,
} from "@caupulican/pi-ai";
import { cleanupSessionResources, isContextOverflow, streamSimple } from "@caupulican/pi-ai";
import { getAgentDir } from "../config.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import type {
	CapabilityEnvelope,
	EvidenceBundle,
	GateOutcome,
	LearningDecision,
	RouteDecision,
	WorkerRequest,
	WorkerResult,
} from "./autonomy/contracts.ts";
import { buildForegroundEnvelope, formatForegroundEnvelopeObservation } from "./autonomy/foreground-envelope.ts";
import type { LaneRecord } from "./autonomy/lane-tracker.ts";
import type { AutonomyDiagnosticSnapshot, AutonomyStatusSnapshot, GateOutcomeHistoryEntry } from "./autonomy/status.ts";
import type { AutonomyTelemetryEvent } from "./autonomy/telemetry-events.ts";
import { AutonomyTelemetry } from "./autonomy-telemetry.ts";
import { BackgroundLaneController } from "./background-lane-controller.ts";
import { BashExecutionController } from "./bash-execution-controller.ts";
import type { BashResult } from "./bash-executor.ts";
import { CompactionSupport } from "./compaction-support.ts";
// (module-scope helper for curation goal extraction defined below the imports)
import type { CurationTelemetrySnapshot } from "./context/brain-curator.ts";
import type { ArtifactStore } from "./context/context-artifacts.ts";
import type { ContextAuditReport } from "./context/context-audit.ts";
import {
	buildContextCompositionReport,
	type ContextCompositionReport,
	formatContextCompositionDashboard,
} from "./context/context-composition.ts";
import type { PromptEnforcementReport } from "./context/context-prompt-enforcement.ts";
import type { PromptPolicyGcCorrelationReport, PromptPolicyShadowReport } from "./context/context-prompt-policy.ts";
import type { MemoryPromptInclusionReport } from "./context/memory-diagnostics.ts";
import type { MemoryRetrievalReport } from "./context/memory-retrieval.ts";
import type { ContextGcReport } from "./context-gc.ts";
import { ContextPipeline } from "./context-pipeline.ts";
import type { DailyUsageTotals } from "./cost/daily-usage.ts";
import { type CostGuardDecision, downgradeReasoning, estimateTurnCostUsd, evaluateCostGuard } from "./cost-guard.ts";
import { appendWorkerResultSnapshot, getWorkerResultSnapshots } from "./delegation/session-worker-result.ts";
import type { WorkerRunOutcome } from "./delegation/worker-runner.ts";
import type {
	ContextUsage,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionErrorListener,
	ExtensionRunner,
	ExtensionUIContext,
	InputSource,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	ReplacedSessionContext,
	SessionBeforeCompactResult,
	SessionStartEvent,
	ShutdownHandler,
	ToolDefinition,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	ToolInfo,
	TurnEndEvent,
	TurnStartEvent,
} from "./extensions/index.ts";
import { type ChannelProvider, GatewayRegistry, type JobSchedulerProvider } from "./gateways/channel-provider.ts";
import { GoalLoopController } from "./goal-loop-controller.ts";
import type { GoalContinuationPrompt, GoalContinuationPromptLimits } from "./goals/goal-continuation-prompt.ts";
import {
	buildGoalRuntimeSnapshot,
	type GoalRuntimeSnapshot,
	type GoalRuntimeSnapshotSettings,
} from "./goals/goal-runtime-snapshot.ts";
import type { GoalState } from "./goals/goal-state.ts";
import { appendGoalStateSnapshot, getLatestGoalStateSnapshot } from "./goals/session-goal-state.ts";
import type { LearningAuditRecord } from "./learning/learning-audit.ts";
import type { DemandSignals, ReflectionResult } from "./learning/reflection-engine.ts";
import { appendLearningDecisionSnapshot, getLearningDecisionSnapshots } from "./learning/session-learning-decision.ts";
import { type CurationProposals, isPromotedFrontmatter, SkillCurator } from "./learning/skill-curator.ts";
import { LocalRuntimeController } from "./local-runtime-controller.ts";
import type { MemoryProvider } from "./memory/memory-provider.ts";
import { MemoryController } from "./memory-controller.ts";
import {
	deriveModelCapabilityProfile,
	filterToolNamesForCapability,
	type ModelCapabilityProfile,
} from "./model-capability.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { formatModelRouterModel, ModelRouterController } from "./model-router-controller.ts";
import { ModelSelectionController } from "./model-selection-controller.ts";
import type { StoredFitnessReport } from "./models/fitness-store.ts";
import type { LocalRuntimeDeps, OllamaRuntime } from "./models/local-runtime.ts";
import { ProfileFilterController } from "./profile-filter-controller.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import { ReflectionController } from "./reflection-controller.ts";
import type { ModelFitnessReport } from "./research/model-fitness.ts";
import type { ResearchRunResult } from "./research/research-runner.ts";
import {
	appendEvidenceBundleSnapshot,
	getEvidenceBundleSnapshots,
	getLatestEvidenceBundleSnapshot,
} from "./research/session-evidence-bundle.ts";
import { collectWorkspaceSources } from "./research/workspace-collector.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import { stripResourceProfileBlocks } from "./resource-profile-blocks.ts";
import { RuntimeBuilder } from "./runtime-builder.ts";
import { SessionAnalytics } from "./session-analytics.ts";
import { SessionTreeNavigator } from "./session-tree-navigator.ts";
import type { ResourceProfileFilterSettings, SettingsManager } from "./settings-manager.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { SystemPromptBuilder } from "./system-prompt-builder.ts";
import { ToolGateController } from "./tool-gate-controller.ts";
import type { BashOperations } from "./tools/bash.ts";

// ============================================================================
// Stream-idle watchdog wiring
// ============================================================================

/**
 * Marks a watchdog-wrapped stream fn whose inner base was the raw `streamSimple`.
 *
 * The session tests `streamFn === streamSimple` in three places to decide whether it must
 * inject request auth explicitly (the raw-provider path used in tests and no-key setups).
 * Wrapping the fn with the idle watchdog breaks that identity, so the wrapper carries this
 * marker and those checks go through `_isRawStreamSimple` instead. `Symbol.for` keeps the
 * key stable regardless of how many times this module is evaluated.
 */
const RAW_STREAM_MARKER = Symbol.for("pi.rawStreamSimple");

/** Test-only override of the stream-idle bounds. Read per-request by the wiring's resolver. */
let streamIdleOptionsOverride: Partial<StreamIdleOptions> | undefined;

/**
 * Test hook: override the stream-idle bounds so a stall can be provoked in-suite without a
 * multi-minute wait. Pass `undefined` to restore the user-locked defaults (connect 120s /
 * active 180s / quiet 600s, or the user's retry.stall settings). Applies per request — it
 * may be set or changed at any time before the request that should observe it.
 */
export function setStreamIdleOptionsForTests(opts: Partial<StreamIdleOptions> | undefined): void {
	streamIdleOptionsOverride = opts;
}

/**
 * Tag a watchdog-wrapped stream fn with whether its inner base was the raw `streamSimple`,
 * so `_isRawStreamSimple` can see the raw-provider path through the wrapper.
 */
function tagRawness(wrapped: StreamFn, innerIsRawStreamSimple: boolean): StreamFn {
	Object.defineProperty(wrapped, RAW_STREAM_MARKER, { value: innerIsRawStreamSimple });
	return wrapped;
}

// ============================================================================
// Skill Block Parsing
// ============================================================================

/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" }>
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
	  }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
			commands: readonly string[];
	  }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| { type: "warning"; message: string }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
			/**
			 * Benign no-op explanation for auto-compaction (e.g. "nothing to compact yet"). Auto
			 * bails must never be silent: without a result, either errorMessage (real failure) or
			 * skipReason (harmless skip) is set so the UI can show why nothing changed.
			 */
			skipReason?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	// Brackets the routing/prep phase of a turn (judge + model/auth checks + compaction, etc.) — the
	// gap between the user's prompt painting and the turn actually starting to stream, which today
	// has no visible feedback. UI-only: no persistence, no bearing on the turn itself. Always paired
	// exactly once per _promptUnserialized attempt that reaches past the early-return paths (queued
	// steer/followUp, extension commands, input-transform) — never emitted for those.
	| { type: "routing_start" }
	| { type: "routing_end" };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// Types
// ============================================================================

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	/** User-level agent state directory for generated runtime artifacts. */
	agentDir?: string;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** Resource loader for skills, prompts, themes, context files, system prompt */
	resourceLoader: ResourceLoader;
	/** SDK custom tools registered outside extensions */
	customTools?: ToolDefinition[];
	/** Model registry for API key resolution and model discovery */
	modelRegistry: ModelRegistry;
	/** Initial active built-in tool names. Default: [read, bash, edit, write, context_audit, goal] */
	initialActiveToolNames?: string[];
	/** Optional allowlist of tool names. When provided, only these tool names are exposed. */
	allowedToolNames?: string[];
	/** Optional denylist of tool names. When provided, these tool names are not exposed. */
	excludedToolNames?: string[];
	/** Optional resource-profile allow/block filters for tool names. */
	toolProfileFilter?: ResourceProfileFilterSettings;
	/**
	 * Whether the model/thinking level came from an explicit launch flag. When false, the active
	 * profile's model/thinking is re-applied on reload() so live profile edits take effect; when
	 * true, the explicit launch-time choice is preserved.
	 */
	isExplicitModel?: boolean;
	isExplicitThinking?: boolean;
	/** True when this session is a spawned subagent/child — gates durable memory writes. */
	isChildSession?: boolean;
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Mutable ref used by Agent to access the current ExtensionRunner */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** Session start event metadata emitted when extensions bind to this runtime. */
	sessionStartEvent?: SessionStartEvent;
	/**
	 * Pointer-first workspace source collector for the autonomous research lane. Injected in unit
	 * tests so they don't spawn a real ripgrep child (which would escape fake timers); production
	 * defaults to the real, best-effort collector.
	 */
	collectWorkspaceSources?: typeof collectWorkspaceSources;
	/**
	 * Injected fetch/spawn/exists for the local (Ollama) runtime health-check + boot used by the
	 * model router before a turn routed to a local model (see LocalRuntimeController.ensureLocalModelReady).
	 * Unit tests inject fakes so they never hit a real network/process; production defaults to the real ones.
	 */
	localRuntimeDeps?: LocalRuntimeDeps;
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	mode?: ExtensionContext["mode"];
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to expand file-based prompt templates and skills (default: true). */
	expandPromptTemplates?: boolean;
	/** Whether slash commands should be handled before sending to the model. Defaults to expandPromptTemplates. */
	processSlashCommands?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
	/** Internal hook used by RPC mode to observe prompt preflight acceptance or rejection. */
	preflightResult?: (success: boolean) => void;
	/** Whether an idle active goal should auto-inject bounded continuation prompts after this prompt settles. Default: true. */
	autoContinueGoal?: boolean;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

/** Session statistics for /session command */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
}

/** customType for spawned-usage roll-up entries (Cost Aggregation, Model A). */
export const SPAWNED_USAGE_CUSTOM_TYPE = "spawned_usage";

/**
 * A single spawned/subagent usage report, persisted as a `CustomEntry`
 * (`customType: "spawned_usage"`). Persistence-only — does NOT enter LLM context.
 *
 * Single-hop invariant: each report MUST already include the reporter's own usage AND its
 * accumulated sub-usage. A child rolls up its grandchildren, then reports once to its direct
 * parent. Only the direct parent records the report — never a grandparent — so cost cannot be
 * double-counted across levels.
 */
export interface SpawnedUsageReport {
	/** Cumulative usage attributed to the spawned session (own + its own sub-usage). */
	usage: Usage;
	/** Human-readable source label for diagnostics (e.g. subagent name). */
	label?: string;
	/** Session id of the reporting child, if known. */
	sourceSessionId?: string;
	/** Stable id used to de-duplicate re-reports (retries, double agent_end). */
	reportId?: string;
}

/** Aggregated spawned-usage totals derived from `spawned_usage` custom entries. */
export interface SpawnedUsageTotals {
	/** Summed `usage.cost.total` across all recorded reports. */
	cost: number;
	/** Number of distinct reports recorded. */
	reports: number;
}

/**
 * Options for {@link AgentSession.runIsolatedCompletion} — a one-shot LLM call fully isolated from
 * the main session (used by the native reflection engine, R2). See the adaptive-agent design §6c/§7.
 */
export interface IsolatedCompletionOptions {
	/** System prompt for the isolated call. */
	systemPrompt: string;
	/** The isolated conversation (e.g. the reflection prompt). NOT the main session history. */
	messages: Message[];
	/** Model to use. Defaults to the session model; callers should pass a cheap model. */
	model?: Model<any>;
	/** Thinking level. Defaults to "off" to keep the call cheap. */
	thinkingLevel?: ThinkingLevel;
	/** Output token cap. */
	maxTokens?: number;
	/** Abort signal. */
	signal?: AbortSignal;
	/**
	 * Prompt-cache retention for this isolated call. Defaults to `"none"` (no caching — preserves full
	 * isolation). Callers whose `systemPrompt` is STATIC across calls (e.g. reflection, #33) can pass
	 * `"short"`/`"long"` so the provider reuses the cached prefix and bills only the variable tail.
	 */
	cacheRetention?: CacheRetention;
}

/** Result of an isolated completion: the text, the usage spent, and the stop reason. */
export interface IsolatedCompletionResult {
	text: string;
	usage: Usage;
	stopReason: StopReason;
}

export interface ResearchLaneRunOutcome {
	/** False when the pass was skipped before starting (see skipReason). */
	started: boolean;
	skipReason?: string;
	/** Terminal lane record when the pass ran. */
	record?: LaneRecord;
	result?: ResearchRunResult;
}

export interface WorkerDelegationRunOutcome {
	/** False when the delegation was skipped before starting (see skipReason). */
	started: boolean;
	skipReason?: string;
	/** Terminal lane record when the delegation ran. */
	record?: LaneRecord;
	outcome?: WorkerRunOutcome;
}

export interface GoalContinuationOnceOptions {
	maxStallTurns: number;
	promptLimits?: GoalContinuationPromptLimits;
}

export interface GoalContinuationOnceResult {
	submitted: boolean;
	snapshot: GoalRuntimeSnapshot;
	prompt?: GoalContinuationPrompt;
}

export type GoalContinuationLoopStopReason =
	| "continuation_not_allowed"
	| "max_turns_reached"
	| "wall_clock_budget_reached"
	| "goal_state_not_advanced";

export interface GoalContinuationLoopOptions extends GoalContinuationOnceOptions {
	maxTurns: number;
	/** 0 or undefined disables wall-clock budget. */
	maxWallClockMinutes?: number;
	/** Test seam for wall-clock budget enforcement. Defaults to Date.now. */
	now?: () => number;
}

export interface GoalContinuationLoopResult {
	turnsSubmitted: number;
	stopReason: GoalContinuationLoopStopReason;
	finalSnapshot: GoalRuntimeSnapshot;
}

// ============================================================================
// Constants
// ============================================================================

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	public capabilityEnvelope?: CapabilityEnvelope;

	private _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _extensionsChangedListeners: Array<() => void> = [];

	/** Tracks pending steering messages for UI display. Removed when delivered. */
	private _steeringMessages: string[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered. */
	private _followUpMessages: string[] = [];
	/** Tracks extension slash commands queued while the agent is streaming. */
	private _queuedExtensionCommands: string[] = [];
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];
	/** Serializes prompt() submissions made while streaming so queued steering/follow-ups keep user-typed FIFO order. */
	private _streamingPromptSubmissionTail: Promise<void> = Promise.resolve();
	/**
	 * The last tool set requested via setActiveToolsByName BEFORE model-capability filtering, so
	 * switching from a small-window model back to a large one restores the full requested set.
	 */
	private _requestedActiveToolNames: string[] | undefined;

	// Compaction/context hygiene state
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	private _overflowRecoveryAttempted = false;
	private _unboundToolGrantWarnings: string[] = [];

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// Auto-retry driver — owns the attempt counter and abortable backoff (reliability kernel).
	private _retryController!: RetryController;

	// Bash execution state
	/** User-facing model + thinking-level selection (see model-selection-controller.ts). */
	private readonly _modelSelection: ModelSelectionController;
	/** Standalone bash-command execution (see bash-execution-controller.ts); owns the bash abort
	 * controller and the streaming-deferred pending-message queue. */
	private readonly _bash: BashExecutionController;
	/** Resource-profile tool/extension gating + reload-time profile model re-apply (see profile-filter-controller.ts). */
	private readonly _profileFilter: ProfileFilterController;
	/** Agent tool-call gate: escalation, autonomy gating, extension hooks, untrusted boundary (see tool-gate-controller.ts). */
	private readonly _toolGate: ToolGateController;

	// Extension system
	private _extensionRunner!: ExtensionRunner;
	private _turnIndex = 0;
	/** G7: per-turn foreground CapabilityEnvelope auto-built for visibility (observe-only; not enforced). */
	private _currentForegroundEnvelope?: CapabilityEnvelope;

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _cwd: string;
	private _agentDir: string;
	private _collectWorkspaceSources: typeof collectWorkspaceSources;
	/** Owns the cached per-server OllamaRuntime instances and the local-model router readiness gate
	 * (see local-runtime-controller.ts). */
	private readonly _localRuntimeController: LocalRuntimeController;
	/** Assembles the session's base system prompt from live session state (see
	 * system-prompt-builder.ts); owns the paired _baseSystemPromptOptions. */
	private readonly _systemPromptBuilder: SystemPromptBuilder;
	/** G3/G8 autonomy telemetry sink + status/diagnostic snapshots (see autonomy-telemetry.ts); owns
	 * the latest gate outcome and the bounded gate-outcome history. */
	private readonly _autonomyTelemetry: AutonomyTelemetry;
	/** Goal auto-continue + research lane + scout-worker delegation + model-fitness probe (see
	 * background-lane-controller.ts); owns the lane timers/guards, the last research-lane skip
	 * reason, the live LaneTracker, and the in-flight research/worker abort controllers. */
	private readonly _backgroundLanes: BackgroundLaneController;
	/** Plug-and-play memory subsystem (see memory-controller.ts); owns the OKF retrieval provider, the
	 * latest retrieval/prompt-inclusion reports, the reload-safe MemoryManager, the recall
	 * effectiveness tracker, and the extension-contributed pending providers. */
	private readonly _memory: MemoryController;
	/** Summarizer model/auth/settings resolution (see compaction-support.ts). */
	private readonly _compactionSupport: CompactionSupport;
	/** Per-turn context-shaping subsystem (see context-pipeline.ts); owns the latest
	 * audit/policy/correlation/enforcement/gc reports, the brain-curation sidecar + its skip reasons,
	 * and the tool-output artifact store. Invoked stage-by-stage from the context transform. */
	private readonly _pipeline: ContextPipeline;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	private _allowedToolNames?: Set<string>;
	private _excludedToolNames?: Set<string>;
	private _toolProfileFilter?: Required<ResourceProfileFilterSettings>;
	private readonly _isExplicitModel: boolean;
	private readonly _isExplicitThinking: boolean;
	/** R8: registry for deployment-supplied gateway channels + schedulers (lifecycle driven by the host runner). */
	private readonly _gatewayRegistry = new GatewayRegistry();
	/** Cache for getSpawnedUsage(), keyed by session entry count (Bug #22 — avoid O(N) per render frame). */
	/** Usage/cost/stats accounting, /context estimate, and session export (see session-analytics.ts);
	 * owns the spawned-usage and daily-usage memo caches. */
	private readonly _analytics: SessionAnalytics;
	/** In-file session-tree branch switching + fork-selector reads (see session-tree-navigator.ts). */
	private readonly _treeNavigator: SessionTreeNavigator;
	/** Latest proactive cost-guard decision (#34), for the host UI to surface. Undefined when disabled. */
	private _lastCostGuardDecision?: CostGuardDecision;
	/** One-shot latch so the cost guard downgrades reasoning once per over-threshold episode, not every call. */
	private _costGuardDowngraded = false;
	/** Per-turn model-router subsystem (see model-router-controller.ts); owns the transient route/intent,
	 * the cheap-turn session buffer, the escalation/retry flags, and the sticky last-decision/skip-reason
	 * used by the status report. Its parallel routed drive path delegates every turn back to
	 * {@link _runAgentPrompt} so the drive loop stays host-side. */
	private readonly _modelRouter: ModelRouterController;
	/** Lazily-built skill curator (#32) over `<agentDir>/skills`. */
	private _skillCuratorInstance?: SkillCurator;
	/** Set on dispose so in-flight background reflection bails instead of writing to a dead session (Bug #21). */
	private _disposed = false;
	/** Aborts in-flight background reflection completions on dispose (Bug #21). */
	private readonly _reflectionAbort = new AbortController();
	/** Native reflection engine + learning-apply/rollback path (see reflection-controller.ts); owns no
	 * session state, applies durable writes through the bundled memory tool and the session log. */
	private readonly _reflection: ReflectionController;
	/** Bounded goal auto-continuation loop (see goal-loop-controller.ts); reads goal state fresh
	 * each pass and re-enters the session's own prompt path. */
	private readonly _goalContinuation: GoalLoopController;
	private readonly _isChildSession: boolean;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _sessionStartEvent: SessionStartEvent;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionMode: ExtensionContext["mode"] = "print";
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionAbortHandler?: () => void;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;

	// Model registry for API key resolution
	private _modelRegistry: ModelRegistry;

	/** Tool-registry assembly + the self-modification-safe extension reload (see runtime-builder.ts);
	 * owns the base/wrapped tool definitions, the live tool registry, and the per-tool prompt
	 * snippet/guideline maps. The reload snapshot spans host/agent state reached through its deps. */
	private readonly _runtimeBuilder: RuntimeBuilder;

	// Base system prompt (without extension appends) - used to apply fresh appends each turn.
	// The paired _baseSystemPromptOptions and their construction live in SystemPromptBuilder.
	private _baseSystemPrompt = "";

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		// Bound every provider stream this session starts against a silently dead connection: a
		// stall aborts the inner request and surfaces as a retryable "stream stalled" error, which
		// _isRetryableError routes into the existing auto-retry path. Wrapped exactly once, here.
		// The wrapper reports the stall immediately and aborts the inner request; releasing the
		// inner pump relies on the provider ending its stream after abort (real providers do — see
		// withStreamIdleWatchdog's contract), so no extra drain is added at this wiring site.
		// Wrapping also breaks the `streamFn === streamSimple` identity the auth-injection checks
		// use, so the wrapper carries a rawness marker that _isRawStreamSimple reads.
		const baseStreamFn = this.agent.streamFn;
		// `this.settingsManager` is assigned below; the resolver closes over the config reference
		// because the wrapper must be installed before that assignment runs.
		const stallSettingsSource = config.settingsManager;
		this.agent.streamFn = tagRawness(
			withStreamIdleWatchdog(baseStreamFn, () => ({
				...stallSettingsSource.getStreamStallSettings(),
				...streamIdleOptionsOverride,
			})),
			baseStreamFn === streamSimple,
		);
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		// Auto-retry rides the reliability kernel: the controller owns the attempt counter and the
		// abortable backoff. This session maps its retry settings onto a RetryPolicy, bridges the
		// controller's events onto the session event stream, and supplies the live context window so
		// the overflow-aware classifier can route overflow to compaction instead of a pointless retry.
		this._retryController = new RetryController(
			this.agent,
			() => {
				const retry = this.settingsManager.getRetrySettings();
				return {
					enabled: retry.enabled,
					maxAttempts: retry.maxRetries,
					baseDelayMs: retry.baseDelayMs,
					maxDelayMs: DEFAULT_RETRY_POLICY.maxDelayMs,
					jitterRatio: 0,
				};
			},
			{
				onRetryStart: (info) => this._emit({ type: "auto_retry_start", ...info }),
				onRetryEnd: (info) => this._emit({ type: "auto_retry_end", ...info }),
			},
			() => this.model?.contextWindow ?? 0,
		);
		this._scopedModels = config.scopedModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._agentDir = config.agentDir ?? getAgentDir();
		this._collectWorkspaceSources = config.collectWorkspaceSources ?? collectWorkspaceSources;
		this._localRuntimeController = new LocalRuntimeController({
			agentDir: this._agentDir,
			localRuntimeDeps: config.localRuntimeDeps,
			getLastAssistantMessage: () => this._findLastAssistantMessage(),
			getUIContext: () => this._extensionUIContext,
			emit: (event) => this._emit(event),
			resolveConfiguredTierModel: (tier) => this._modelRouter.resolveConfiguredTierModel(tier),
			formatModel: (model) => formatModelRouterModel(model),
		});
		this._systemPromptBuilder = new SystemPromptBuilder({
			getCwd: () => this._cwd,
			getSettingsManager: () => this.settingsManager,
			getResourceLoader: () => this._resourceLoader,
			getMemoryManager: () => this._memory.getMemoryManager(),
			hasTool: (name) => this._runtimeBuilder.hasTool(name),
			getToolPromptSnippet: (name) => this._runtimeBuilder.getToolPromptSnippet(name),
			getToolPromptGuidelines: (name) => this._runtimeBuilder.getToolPromptGuidelines(name),
			getActiveExtensions: () => this._extensionRunner.activeExtensions,
		});
		this._autonomyTelemetry = new AutonomyTelemetry({
			getSessionManager: () => this.sessionManager,
			getLastModelRouterDecision: () => this._modelRouter.getLastDecision(),
			getLastResearchLaneSkipReason: () => this._backgroundLanes.getLastResearchLaneSkipReason(),
			getSessionStats: () => this.getSessionStats(),
			getSpawnedUsage: () => this.getSpawnedUsage(),
			getDailyUsageTotals: () => this.getDailyUsageTotals?.(),
			getGoalStateSnapshot: () => this.getGoalStateSnapshot(),
			getActiveLaneCount: () => this._backgroundLanes.getActiveLaneCount(),
			getEvidenceBundleSnapshots: () => this.getEvidenceBundleSnapshots(),
			getWorkerResultSnapshots: () => this.getWorkerResultSnapshots(),
			getLearningDecisionSnapshots: () => this.getLearningDecisionSnapshots(),
			getLearningAuditRecords: () => this.getLearningAuditRecords(),
		});
		this._backgroundLanes = new BackgroundLaneController({
			isDisposed: () => this._disposed,
			isChildSession: () => this._isChildSession,
			getSessionId: () => this.sessionId,
			getCwd: () => this._cwd,
			getAgentDir: () => this._agentDir,
			getSessionManager: () => this.sessionManager,
			getSettingsManager: () => this.settingsManager,
			getModelRegistry: () => this._modelRegistry,
			getModel: () => this.model ?? undefined,
			getCapabilityEnvelope: () => this.capabilityEnvelope,
			getModelCapabilityProfile: () => this.getModelCapabilityProfile(),
			emit: (event) => this._emit(event),
			emitAutonomyTelemetry: (event) => this._emitAutonomyTelemetry(event),
			getGoalStateSnapshot: () => this.getGoalStateSnapshot(),
			getGoalRuntimeSnapshot: (settings) => this.getGoalRuntimeSnapshot(settings),
			getEvidenceBundleSnapshot: () => this.getEvidenceBundleSnapshot(),
			saveEvidenceBundleSnapshot: (bundle) => this.saveEvidenceBundleSnapshot(bundle),
			saveWorkerResultSnapshot: (result, request) => this.saveWorkerResultSnapshot(result, request),
			addSpawnedUsage: (usage, opts) => this.addSpawnedUsage(usage, opts),
			runIsolatedCompletion: (opts) => this.runIsolatedCompletion(opts),
			continueGoalLoop: (options) => this.continueGoalLoop(options),
			collectWorkspaceSources: (args) => this._collectWorkspaceSources(args),
		});
		this._memory = new MemoryController({
			getSettingsManager: () => this.settingsManager,
			getTurnIndex: () => this._turnIndex,
			getAgentDir: () => this._agentDir,
			getCwd: () => this._cwd,
			getSessionId: () => this.sessionManager.getSessionId(),
			isChildSession: () => this._isChildSession,
			refreshToolRegistry: () => this._refreshToolRegistry(),
		});
		this._compactionSupport = new CompactionSupport({
			getModel: () => this.model,
			getSettingsManager: () => this.settingsManager,
			getModelRegistry: () => this._modelRegistry,
			isRawStream: () => this._isRawStreamSimple(this.agent.streamFn),
			getRequiredRequestAuth: (model) => this._getRequiredRequestAuth(model),
		});
		this._pipeline = new ContextPipeline({
			getTurnIndex: () => this._turnIndex,
			getSessionManager: () => this.sessionManager,
			getSettingsManager: () => this.settingsManager,
			getModelRegistry: () => this._modelRegistry,
			getAgentDir: () => this._agentDir,
			getCwd: () => this._cwd,
			getActiveToolNames: () => this.getActiveToolNames(),
			isDisposed: () => this._disposed,
			getMemoryManager: () => this._memory.getMemoryManager(),
			addSpawnedUsage: (usage, opts) => this.addSpawnedUsage(usage, opts),
			runIsolatedCompletion: (opts) => this.runIsolatedCompletion(opts),
		});
		this._modelRouter = new ModelRouterController({
			getAgent: () => this.agent,
			getModel: () => this.model ?? undefined,
			getSettingsManager: () => this.settingsManager,
			getSessionManager: () => this.sessionManager,
			getModelRegistry: () => this._modelRegistry,
			getAgentDir: () => this._agentDir,
			getReflectionSignal: () => this._reflectionAbort.signal,
			getBaseSystemPrompt: () => this._baseSystemPrompt,
			runAgentPrompt: (messages) => this._runAgentPrompt(messages),
			buildSystemPromptForToolNames: (toolNames) => this._buildSystemPromptForToolNames(toolNames),
			refreshCurrentModelFromRegistry: () => this._refreshCurrentModelFromRegistry(),
			runIsolatedCompletion: (opts) => this.runIsolatedCompletion(opts),
			addSpawnedUsage: (usage, opts) => this.addSpawnedUsage(usage, opts),
			emit: (event) => this._emit(event),
			emitAutonomyTelemetry: (event) => this._emitAutonomyTelemetry(event),
			resolveLaneModel: (pattern) => this._backgroundLanes.resolveLaneModel(pattern),
			resolveCurationModelIfFit: () => this._resolveCurationModelIfFit(),
		});
		this._reflection = new ReflectionController({
			getModel: () => this.model,
			getAgent: () => this.agent,
			isRawStreamSimple: () => this._isRawStreamSimple(this.agent.streamFn),
			getModelRegistry: () => this._modelRegistry,
			getMemoryManager: () => this._memory.getMemoryManager(),
			getSettingsManager: () => this.settingsManager,
			getSessionManager: () => this.sessionManager,
			getAgentDir: () => this._agentDir,
			isChildSession: () => this._isChildSession,
			isDisposed: () => this._disposed,
			getReflectionSignal: () => this._reflectionAbort.signal,
			archivePromotedSkill: (name) => this.archivePromotedSkill(name),
			emitAutonomyTelemetry: (event) => this._emitAutonomyTelemetry(event),
			addSpawnedUsage: (usage, opts) => this.addSpawnedUsage(usage, opts),
			saveLearningDecisionSnapshot: (decision) => this.saveLearningDecisionSnapshot(decision),
		});
		this._goalContinuation = new GoalLoopController({
			getGoalRuntimeSnapshot: (settings) => this.getGoalRuntimeSnapshot(settings),
			prompt: (text, options) => this.prompt(text, options),
		});
		this._modelRegistry = config.modelRegistry;
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._allowedToolNames = config.allowedToolNames ? new Set(config.allowedToolNames) : undefined;
		this._excludedToolNames = config.excludedToolNames ? new Set(config.excludedToolNames) : undefined;
		this._toolProfileFilter = config.toolProfileFilter
			? { allow: config.toolProfileFilter.allow ?? [], block: config.toolProfileFilter.block ?? [] }
			: undefined;
		this._isExplicitModel = config.isExplicitModel ?? false;
		this._isExplicitThinking = config.isExplicitThinking ?? false;
		this._isChildSession = config.isChildSession ?? process.env.PI_CHILD_SESSION === "1";
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };
		this._runtimeBuilder = new RuntimeBuilder({
			getAgent: () => this.agent,
			getCwd: () => this._cwd,
			getAgentDir: () => this._agentDir,
			getSessionManager: () => this.sessionManager,
			getSettingsManager: () => this.settingsManager,
			getModelRegistry: () => this._modelRegistry,
			getResourceLoader: () => this._resourceLoader,
			getExtensionRunner: () => this._extensionRunner,
			setExtensionRunner: (runner) => {
				this._extensionRunner = runner;
				if (this._extensionRunnerRef) {
					this._extensionRunnerRef.current = runner;
				}
			},
			getBaseSystemPrompt: () => this._baseSystemPrompt,
			setBaseSystemPrompt: (prompt) => {
				this._baseSystemPrompt = prompt;
			},
			getCustomTools: () => this._customTools,
			getBaseToolsOverride: () => this._baseToolsOverride,
			getRequestedActiveToolNames: () => this._requestedActiveToolNames,
			setRequestedActiveToolNames: (names) => {
				this._requestedActiveToolNames = names;
			},
			getToolProfileFilter: () => this._toolProfileFilter,
			setToolProfileFilter: (filter) => {
				this._toolProfileFilter = filter;
			},
			getAllowedToolNames: () => this._allowedToolNames,
			getExcludedToolNames: () => this._excludedToolNames,
			deriveToolProfileFilter: () => this._profileFilter.deriveToolProfileFilter(),
			isToolOrCommandAllowedByProfile: (name) => this._profileFilter.isToolOrCommandAllowedByProfile(name),
			filterExtensionsForRuntime: (extensions) => this._profileFilter.filterExtensionsForRuntime(extensions),
			setUnboundToolGrantWarnings: (warnings) => {
				this._unboundToolGrantWarnings = warnings;
			},
			getActiveToolNames: () => this.getActiveToolNames(),
			setActiveToolsByName: (toolNames) => this.setActiveToolsByName(toolNames),
			normalizePromptSnippet: (text) => this._normalizePromptSnippet(text),
			normalizePromptGuidelines: (guidelines) => this._normalizePromptGuidelines(guidelines),
			bindExtensionCore: (runner) => this._bindExtensionCore(runner),
			applyExtensionBindings: (runner) => this._applyExtensionBindings(runner),
			extendResourcesFromExtensions: (reason) => this.extendResourcesFromExtensions(reason),
			reapplyActiveProfileModelSettings: () => this._profileFilter.reapplyActiveProfileModelSettings(),
			notifyExtensionsChanged: () => this._notifyExtensionsChanged(),
			getToolArtifactStore: () => this._getToolArtifactStore(),
			getMemoryManager: () => this._memory.getMemoryManager(),
			getMemoryAuditDiagnostics: () => this._memory.getMemoryAuditDiagnostics(),
			clearPendingMemoryProviders: () => this._memory.clearPendingProviders(),
			initializeMemory: () => this._memory.initialize(),
			getGoalStateSnapshot: () => this.getGoalStateSnapshot(),
			saveGoalStateSnapshot: (state) => this.saveGoalStateSnapshot(state),
			getContextGcReport: (messages) => this.getContextGcReport(messages),
			runWorkerDelegationOnce: (request) => this.runWorkerDelegationOnce(request),
			runModelFitness: (args) => this.runModelFitness(args),
			resolveCurationModelIfFit: () => this._resolveCurationModelIfFit(),
			runIsolatedCompletion: (opts) => this.runIsolatedCompletion(opts),
			addSpawnedUsage: (usage, opts) => this.addSpawnedUsage(usage, opts),
			createAgentContextSnapshot: () => this._createAgentContextSnapshot(),
			getContextUsage: () => this.getContextUsage(),
			isStreaming: () => this.isStreaming,
			isCompacting: () => this.isCompacting,
			getExtensionUIContext: () => this._extensionUIContext,
			getExtensionCommandContextActions: () => this._extensionCommandContextActions,
			getExtensionShutdownHandler: () => this._extensionShutdownHandler,
			getExtensionErrorListener: () => this._extensionErrorListener,
		});
		this._analytics = new SessionAnalytics({
			getState: () => this.state,
			getMessages: () => this.messages,
			getModel: () => this.model,
			getSessionManager: () => this.sessionManager,
			getSettingsManager: () => this.settingsManager,
			getToolDefinition: (name) => this.getToolDefinition(name),
		});
		this._treeNavigator = new SessionTreeNavigator({
			getSessionManager: () => this.sessionManager,
			getModel: () => this.model,
			getExtensionRunner: () => this._extensionRunner,
			getRequiredRequestAuth: (model) => this._getRequiredRequestAuth(model),
			getSettingsManager: () => this.settingsManager,
			getAgent: () => this.agent,
			setBranchSummaryAbort: (controller) => {
				this._branchSummaryAbortController = controller;
			},
		});
		this._modelSelection = new ModelSelectionController({
			getAgent: () => this.agent,
			getModel: () => this.model,
			getThinkingLevel: () => this.thinkingLevel,
			getModelRegistry: () => this._modelRegistry,
			getSessionManager: () => this.sessionManager,
			getSettingsManager: () => this.settingsManager,
			getExtensionRunner: () => this._extensionRunner,
			getAgentDir: () => this._agentDir,
			getScopedModels: () => this._scopedModels,
			getRequestedActiveToolNames: () => this._requestedActiveToolNames,
			getActiveToolNames: () => this.getActiveToolNames(),
			setActiveToolsByName: (names) => this.setActiveToolsByName(names),
			getModelCapabilityProfile: () => this.getModelCapabilityProfile(),
			emit: (event) => this._emit(event),
			checkContextWindowUsageWarning: () => this._checkContextWindowUsageWarning(),
			deriveOllamaServerUrl: (baseUrl) => this._deriveOllamaServerUrl(baseUrl),
			getLocalRuntime: (serverUrl) => this.getLocalRuntime(serverUrl),
		});
		this._bash = new BashExecutionController({
			getAgent: () => this.agent,
			getSessionManager: () => this.sessionManager,
			getSettingsManager: () => this.settingsManager,
			isStreaming: () => this.isStreaming,
		});
		this._profileFilter = new ProfileFilterController({
			getSettingsManager: () => this.settingsManager,
			getResourceLoader: () => this._resourceLoader,
			getModelRegistry: () => this._modelRegistry,
			getCwd: () => this._cwd,
			getAgent: () => this.agent,
			getSessionManager: () => this.sessionManager,
			getAllowedToolNames: () => this._allowedToolNames,
			getExcludedToolNames: () => this._excludedToolNames,
			getToolProfileFilter: () => this._toolProfileFilter,
			isExplicitModel: () => this._isExplicitModel,
			isExplicitThinking: () => this._isExplicitThinking,
			setThinkingLevel: (level) => this.setThinkingLevel(level),
		});
		this._toolGate = new ToolGateController({
			maybeEscalateToolCall: (toolName, args) => this._modelRouter.maybeEscalateToolCall(toolName, args),
			getCwd: () => this._cwd,
			getCapabilityEnvelope: () => this.capabilityEnvelope,
			recordGateOutcome: (outcome) => this._recordGateOutcome(outcome),
			getExtensionRunner: () => this._extensionRunner,
		});

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installAgentContextTransform();
		this._installAgentTurnRefresh();

		this._runtimeBuilder.buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
	}

	/** Model registry for API key resolution and model discovery */
	get modelRegistry(): ModelRegistry {
		return this._modelRegistry;
	}

	/**
	 * True when the session's stream fn is the raw `streamSimple` provider entry (directly, or as the
	 * base wrapped by the idle watchdog at construction). Callers use this to decide whether request
	 * auth must be injected explicitly — see {@link RAW_STREAM_MARKER}.
	 */
	private _isRawStreamSimple(fn: StreamFn): boolean {
		return fn === streamSimple || (fn as { [RAW_STREAM_MARKER]?: boolean })[RAW_STREAM_MARKER] === true;
	}

	private async _getRequiredRequestAuth(model: Model<any>): Promise<{
		apiKey: string;
		headers?: Record<string, string>;
	}> {
		const result = await this._modelRegistry.getApiKeyAndHeaders(model);
		if (!result.ok) {
			if (result.error.startsWith("No API key found")) {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw new Error(result.error);
		}
		if (result.apiKey) {
			return { apiKey: result.apiKey, headers: result.headers };
		}

		const isOAuth = this._modelRegistry.isUsingOAuth(model);
		if (isOAuth) {
			throw new Error(
				`Authentication failed for "${model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${model.provider}' to re-authenticate.`,
			);
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	// Summarizer model selection, request auth (with session-model fallback), and window-adapted
	// settings live in CompactionSupport (see compaction-support.ts). Same-signature delegations.
	private _getCompactionRequestAuth(model: Model<any>): Promise<{
		apiKey?: string;
		headers?: Record<string, string>;
	}> {
		return this._compactionSupport.getRequestAuth(model);
	}

	private _resolveCompactionModelAndAuth(
		compactionModel: Model<any>,
		sessionModel: Model<any>,
	): Promise<{ model: Model<any>; apiKey?: string; headers?: Record<string, string>; failure?: string }> {
		return this._compactionSupport.resolveModelAndAuth(compactionModel, sessionModel);
	}

	private _resolveCompactionModel(sessionModel: Model<any>): Model<any> {
		return this._compactionSupport.resolveModel(sessionModel);
	}

	/**
	 * Install tool hooks once on the Agent instance.
	 *
	 * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
	 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
	 * registered tool execution to the extension context. Tool call and tool result interception now
	 * happens here instead of in wrappers.
	 */
	private _installAgentContextTransform(): void {
		const previousTransformContext = this.agent.transformContext?.bind(this.agent);
		this.agent.transformContext = async (messages, signal) => {
			const transformed = previousTransformContext ? await previousTransformContext(messages, signal) : messages;
			const authoritativeMessages = this.agent.state.messages.length > 0 ? this.agent.state.messages : transformed;
			let currentMessages = authoritativeMessages;
			try {
				const settings = this._getAdaptedCompactionSettings();
				const contextWindow = this.model?.contextWindow ?? 0;
				if (settings.enabled && contextWindow > 0 && !this.isCompacting) {
					const contextTokens = this._estimateCurrentContextTokens(authoritativeMessages);
					if (shouldCompact(contextTokens, contextWindow, settings, this.model?.autoCompactionTriggerTokens)) {
						const latestBefore = getLatestCompactionEntry(this.sessionManager.getBranch())?.id;
						await this._runAutoCompaction("threshold", false);
						const latestAfter = getLatestCompactionEntry(this.sessionManager.getBranch())?.id;
						if (latestAfter && latestAfter !== latestBefore) {
							currentMessages = this.agent.state.messages.slice();
						}
					}
				}
			} catch {
				currentMessages = authoritativeMessages;
			}

			let finalMessages = currentMessages;
			if (this._extensionRunner.hasHandlers("context")) {
				finalMessages = await this._extensionRunner.emitContext(currentMessages);
			}
			const auditReport = this._runContextAudit(finalMessages);
			const shadowReport = this._runPromptPolicyPlanning(auditReport);
			const memoryReport = await this._runMemoryRetrieval(finalMessages);
			const gcResult = this._applyContextGc(finalMessages, true);
			this._correlatePromptPolicyWithContextGc(gcResult.report);
			const enforcementResult = this._runPromptEnforcement(gcResult.messages, shadowReport);
			this._enqueueRelevanceCuration(gcResult.messages, shadowReport);
			// Fire-and-forget: the local curator overlaps the frontier call; it never blocks a turn.
			this._maybeDrainBrainCuration();
			// Appended LAST, after gc and enforcement, so the bounded evidence block is
			// never packed/stubbed/reshaped by either pass and always reflects this turn's
			// fresh retrieval. Because nothing downstream trims it, memory-prompt-block.ts's
			// character caps are the only budget protection for this block -- load-bearing,
			// not merely defensive.
			const gcMessages = this._maybeAppendMemoryEvidenceBlock(enforcementResult.messages, memoryReport);
			this._applyCostGuard(gcMessages);
			return gcMessages;
		};
	}

	/**
	 * Proactive per-turn cost guard (#34): estimate the USD cost of the about-to-be-submitted turn and,
	 * when it exceeds the user's ceiling, record a warning decision (for the host UI to surface) and —
	 * if configured to `downgrade` — step reasoning effort down ONCE per over-threshold episode to curb a
	 * runaway billing spike. Disabled by default (`maxTurnUsd<=0`), so it never alters behavior unless the
	 * user opts in. Best-effort: never throws into the turn.
	 */
	private _applyCostGuard(messages: AgentMessage[]): void {
		try {
			const guard = this.settingsManager.getCostGuardSettings();
			if (guard.maxTurnUsd <= 0 || !this.model?.cost) {
				this._lastCostGuardDecision = undefined;
				return;
			}
			const inputTokens = this._estimateCurrentContextTokens(messages);
			const maxOutputTokens = this.model.maxTokens ?? 4096;
			const estUsd = estimateTurnCostUsd({ inputTokens, maxOutputTokens, cost: this.model.cost });
			const decision = evaluateCostGuard(estUsd, { maxTurnUsd: guard.maxTurnUsd, action: guard.action });
			this._lastCostGuardDecision = decision;
			if (!decision.over) {
				this._costGuardDowngraded = false; // back under the ceiling — re-arm the one-shot downgrade
				return;
			}
			if (guard.action === "downgrade" && !this._costGuardDowngraded && this.supportsThinking()) {
				const next = downgradeReasoning(this.thinkingLevel);
				if (next !== this.thinkingLevel) {
					this.setThinkingLevel(next as ThinkingLevel);
					this._costGuardDowngraded = true;
				}
			}
		} catch {
			// cost guard must never disrupt a turn
		}
	}

	/** Latest cost-guard decision (for the host footer/UI to surface a warning). Undefined if disabled. */
	getLastCostGuardDecision(): CostGuardDecision | undefined {
		return this._lastCostGuardDecision;
	}

	private get _skillCurator(): SkillCurator {
		if (!this._skillCuratorInstance) {
			this._skillCuratorInstance = new SkillCurator(join(this._agentDir, "skills"));
		}
		return this._skillCuratorInstance;
	}

	/**
	 * Skill curator (#32): PROPOSE (never auto-apply) archival of stale reflection-promoted skills and
	 * consolidation of overlapping ones. The host surfaces these (e.g. a `/curate` command) for approval.
	 */
	proposeSkillCuration(options?: { staleDays?: number; overlapThreshold?: number }): CurationProposals {
		return this._skillCurator.proposeCuration(Date.now(), options);
	}

	/**
	 * Session-start auto-curation (#32, default ON): archive stale reflection-promoted skills in one
	 * locked batch and return the names archived so the host can ANNOUNCE it (never silent). Skipped in
	 * child sessions and when `curator.autoArchive` is disabled. Restorable via `/curate restore`.
	 */
	async runStartupSkillCuration(): Promise<string[]> {
		if (this._isChildSession) return [];
		const settings = this.settingsManager.getCuratorSettings();
		if (!settings.autoArchive) return [];
		return this._skillCurator.autoArchiveStale(Date.now(), { staleDays: settings.staleDays });
	}

	/** Archive a promoted skill into `skills/.archive/` (restorable, non-destructive). Returns true if moved. */
	archivePromotedSkill(name: string): boolean {
		return this._skillCurator.archiveSkill(name);
	}

	/** Restore a previously-archived promoted skill. Returns true if moved back. */
	restorePromotedSkill(name: string): boolean {
		return this._skillCurator.restoreSkill(name);
	}

	private _installAgentTurnRefresh(): void {
		const previousPrepareNextTurn = this.agent.prepareNextTurn?.bind(this.agent);
		this.agent.prepareNextTurn = async (signal) => {
			const previous = previousPrepareNextTurn ? await previousPrepareNextTurn(signal) : undefined;
			const snapshot = this._createAgentContextSnapshot();
			return {
				...previous,
				context: {
					...(previous?.context ?? snapshot),
					systemPrompt: snapshot.systemPrompt,
					tools: snapshot.tools,
				},
				model: previous?.model ?? this.agent.state.model,
				thinkingLevel: previous?.thinkingLevel ?? this.agent.state.thinkingLevel,
			};
		};
	}

	private _createAgentContextSnapshot(): AgentContext {
		return {
			systemPrompt: this.agent.state.systemPrompt,
			messages: this.agent.state.messages.slice(),
			tools: this.agent.state.tools.slice(),
		};
	}

	/** Tool-build call-site delegation to {@link ContextPipeline.getToolArtifactStore}. */
	private _getToolArtifactStore(): ArtifactStore {
		return this._pipeline.getToolArtifactStore();
	}

	/**
	 * Context-transform hot-path delegation to {@link ContextPipeline.runContextAudit}. Kept as a
	 * one-line method (not inlined) so the transform stays the single owner of the pass ordering.
	 */
	private _runContextAudit(messages: AgentMessage[]): ContextAuditReport {
		return this._pipeline.runContextAudit(messages);
	}

	/** Read-only inspection of the context audit (delegates to {@link ContextPipeline.getContextAuditReport}). */
	getContextAuditReport(messages?: AgentMessage[]): ContextAuditReport {
		return this._pipeline.getContextAuditReport(messages);
	}

	/**
	 * Context-transform hot-path delegation to {@link ContextPipeline.runPromptPolicyPlanning}. Kept as
	 * a one-line method (not inlined) so the transform stays the single owner of the pass ordering.
	 */
	private _runPromptPolicyPlanning(auditReport: ContextAuditReport): PromptPolicyShadowReport {
		return this._pipeline.runPromptPolicyPlanning(auditReport);
	}

	/** Read-only inspection of the shadow policy plan (delegates to {@link ContextPipeline.getPromptPolicyReport}). */
	getPromptPolicyReport(messages?: AgentMessage[]): PromptPolicyShadowReport {
		return this._pipeline.getPromptPolicyReport(messages);
	}

	/**
	 * Context-transform hot-path delegation to {@link ContextPipeline.correlatePromptPolicyWithContextGc}.
	 * Kept as a one-line method (not inlined) so the transform stays the single owner of the pass ordering.
	 */
	private _correlatePromptPolicyWithContextGc(gcReport: ContextGcReport): void {
		this._pipeline.correlatePromptPolicyWithContextGc(gcReport);
	}

	/** Read-only inspection of the latest shadow-plan/legacy-gc correlation, for tests/debugging. */
	getPromptPolicyGcCorrelation(): PromptPolicyGcCorrelationReport {
		return this._pipeline.getPromptPolicyGcCorrelation();
	}

	/**
	 * Context-transform hot-path delegation to {@link ContextPipeline.runPromptEnforcement}. Kept as a
	 * one-line method (not inlined) so the transform stays the single owner of the pass ordering.
	 */
	private _runPromptEnforcement(
		messages: AgentMessage[],
		shadowReport: PromptPolicyShadowReport,
	): { messages: AgentMessage[]; report: PromptEnforcementReport } {
		return this._pipeline.runPromptEnforcement(messages, shadowReport);
	}

	/**
	 * Context-transform hot-path delegation to {@link ContextPipeline.enqueueRelevanceCuration}. Kept as
	 * a one-line method (not inlined) so the transform stays the single owner of the pass ordering.
	 */
	private _enqueueRelevanceCuration(messages: AgentMessage[], shadowReport: PromptPolicyShadowReport): void {
		this._pipeline.enqueueRelevanceCuration(messages, shadowReport);
	}

	/** Reflex/curation call-site delegation to {@link ContextPipeline.resolveCurationModelIfFit}. */
	private _resolveCurationModelIfFit(): Model<Api> | undefined {
		return this._pipeline.resolveCurationModelIfFit();
	}

	/**
	 * Context-transform hot-path delegation to {@link ContextPipeline.maybeDrainBrainCuration}. Kept as a
	 * one-line method (not inlined) so the transform stays the single owner of the pass ordering.
	 */
	private _maybeDrainBrainCuration(): void {
		this._pipeline.maybeDrainBrainCuration();
	}

	/** Compaction call-site delegation to {@link ContextPipeline.buildCompactionPreDigest}. */
	private _buildCompactionPreDigest(): ((text: string, signal?: AbortSignal) => Promise<string>) | undefined {
		return this._pipeline.buildCompactionPreDigest();
	}

	/**
	 * Context composition dashboard data: decomposes the per-request payload (system prompt, tool
	 * schemas, extension contributions, message classes incl. GC/policy stubs and recall pages)
	 * plus background spend, so users can see exactly what their integrations cost per request.
	 * Read-only: uses the GC report path (writePayloads=false), never mutates anything.
	 */
	getContextCompositionReport(): ContextCompositionReport {
		const rawMessages = this.agent.state.messages.slice();
		const gcResult = this._applyContextGc(rawMessages, false);
		const activeNames = new Set(this.getActiveToolNames());
		const extensions = this._resourceLoader.getExtensions().extensions;
		const extensionToolNames = new Set(extensions.flatMap((extension) => [...extension.tools.keys()]));
		const usage = this.getContextUsage();
		const enforcementItems = this.getPromptEnforcementReport().items;
		const curationStatus = this.getContextCurationStatus();
		const spawned = this.getSpawnedUsage();
		const promptInclusion = this.getMemoryPromptInclusionReport();
		const memoryEvidenceTokens =
			promptInclusion.status === "included" ? Math.ceil(promptInclusion.blockChars / 4) : 0;
		// Enforcement stubs are applied at SEND time (not persisted), so the message view here
		// still holds raw text for them; subtract what stubbing reclaims per request.
		const enforcementSavedTokens = enforcementItems
			.filter((item) => item.enforced && typeof item.originalChars === "number")
			.reduce((sum, item) => sum + Math.max(0, Math.ceil((item.originalChars ?? 0) / 4) - 50), 0);
		return buildContextCompositionReport({
			systemPrompt: this.systemPrompt ?? "",
			tools: this.getAllTools()
				.filter((tool) => activeNames.has(tool.name))
				.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
					source: extensionToolNames.has(tool.name) ? ("extension" as const) : ("built-in" as const),
				})),
			extensions: extensions.map((extension) => ({
				name: basename(extension.path),
				path: extension.path,
				toolNames: [...extension.tools.keys()],
				commandCount: extension.commands.size,
			})),
			messages: gcResult.messages,
			providerReportedTokens: usage?.tokens ?? null,
			contextWindow: usage?.contextWindow ?? this.model?.contextWindow ?? null,
			gc: { packedCount: gcResult.report.packedCount, savedTokens: gcResult.report.savedTokens },
			enforcement: {
				enforcedCount: enforcementItems.filter((item) => item.enforced).length,
				advisoryEvictions: enforcementItems.filter((item) => item.advisory === "brain_irrelevant").length,
			},
			curation: {
				enabled: curationStatus.enabled,
				telemetry: curationStatus.telemetry,
				lastSkipReason: curationStatus.lastSkipReason,
			},
			spawned: { cost: spawned.cost, reports: spawned.reports },
			adjustments: { memoryEvidenceTokens, enforcementSavedTokens },
			extraObservations: [
				...this._resourceLoader.getAgentsDiagnostics().map((diagnostic) => diagnostic.message),
				...this._profileFilter.profileDeniedResourceObservations(),
				...this._profileFilter.getInertExtensionWarnings(),
				...this._unboundToolGrantWarnings,
				// G7: auto-built per-turn foreground envelope (observe-only; not enforced). Falls back to a
				// live preview when no turn has run yet so /context always shows the current scope.
				formatForegroundEnvelopeObservation(
					this._currentForegroundEnvelope ?? this._buildForegroundEnvelopeFromState(),
				),
				// G14 (ratified): a user disable always beats a profile grant — surface the conflict.
				...(["tools", "skills", "prompts", "extensions"] as const).flatMap((kind) =>
					this.settingsManager
						.getProfileGrantsOverriddenByUserDisable(kind)
						.map(
							(entry) =>
								`profile grants ${kind} "${entry}" but your disable list overrides it (user disable wins; re-enable to use)`,
						),
				),
			],
		});
	}

	/** Bounded plain-text rendering of {@link getContextCompositionReport} for the /context command. */
	formatContextCompositionDashboard(): string {
		return formatContextCompositionDashboard(this.getContextCompositionReport());
	}

	/** Curation status for diagnostics/dashboard: settings, live telemetry, last refusal reason. */
	/** Curation status for diagnostics/dashboard (delegates to {@link ContextPipeline.getContextCurationStatus}). */
	getContextCurationStatus(): {
		enabled: boolean;
		model?: string;
		telemetry: CurationTelemetrySnapshot;
		lastSkipReason?: string;
		lastPreDigestSkipReason?: string;
	} {
		return this._pipeline.getContextCurationStatus();
	}

	/** Read-only inspection of the latest prompt-enforcement report, for tests/debugging. */
	getPromptEnforcementReport(): PromptEnforcementReport {
		return this._pipeline.getPromptEnforcementReport();
	}

	/**
	 * Context-transform hot-path delegation to {@link MemoryController.runMemoryRetrieval}. Kept as a
	 * one-line method (not inlined) so the transform stays the single owner of the pass ordering.
	 */
	private _runMemoryRetrieval(messages: AgentMessage[]): Promise<MemoryRetrievalReport> {
		return this._memory.runMemoryRetrieval(messages);
	}

	/** Read-only inspection of the latest memory-retrieval report, for tests/debugging. */
	getMemoryRetrievalReport(): MemoryRetrievalReport {
		return this._memory.getMemoryRetrievalReport();
	}

	/**
	 * Context-transform hot-path delegation to {@link MemoryController.maybeAppendMemoryEvidenceBlock}.
	 * Kept as a one-line method (not inlined) so the transform stays the single owner of the pass ordering.
	 */
	private _maybeAppendMemoryEvidenceBlock(messages: AgentMessage[], report: MemoryRetrievalReport): AgentMessage[] {
		return this._memory.maybeAppendMemoryEvidenceBlock(messages, report);
	}

	/** Read-only inspection of the latest memory-prompt-inclusion decision, for tests/debugging and context_audit. */
	getMemoryPromptInclusionReport(): MemoryPromptInclusionReport {
		return this._memory.getMemoryPromptInclusionReport();
	}

	/**
	 * Context-transform hot-path delegation to {@link ContextPipeline.applyContextGc}. Kept as a
	 * one-line method (not inlined) so the transform stays the single owner of the pass ordering;
	 * also serves the composition dashboard and {@link getContextGcReport} read-only paths.
	 */
	private _applyContextGc(
		messages: AgentMessage[],
		writePayloads: boolean,
	): { messages: AgentMessage[]; report: ContextGcReport } {
		return this._pipeline.applyContextGc(messages, writePayloads);
	}

	/** Read-only inspection of the latest context-gc report (delegates to {@link ContextPipeline.getContextGcReport}). */
	getContextGcReport(messages?: AgentMessage[]): ContextGcReport {
		return this._pipeline.getContextGcReport(messages);
	}

	/**
	 * Context-transform hot-path delegation to {@link ContextPipeline.estimateCurrentContextTokens}. Kept
	 * as a one-line method (not inlined) so the transform stays the single owner of the pass ordering;
	 * also feeds the per-turn cost guard.
	 */
	private _estimateCurrentContextTokens(messages: AgentMessage[]): number {
		return this._pipeline.estimateCurrentContextTokens(messages);
	}

	private _installAgentToolHooks(): void {
		this.agent.beforeToolCall = this._toolGate.beforeToolCall;
		this.agent.afterToolCall = this._toolGate.afterToolCall;
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit an event to all listeners */
	private _emit(event: AgentSessionEvent): void {
		for (const l of this._eventListeners) {
			l(event);
		}
	}

	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: [...this._steeringMessages],
			followUp: [...this._followUpMessages],
			commands: [...this._queuedExtensionCommands],
		});
	}

	// Track last assistant message for auto-compaction check
	private _lastAssistantMessage: AssistantMessage | undefined = undefined;

	/**
	 * User messages already painted to the UI by an early, synthetic `message_start` fired from
	 * `_promptUnserialized` — before the model-router judge's bounded LLM call — so the prompt
	 * appears immediately instead of hanging until routing finishes. The real agent-loop run emits
	 * its own authoritative `message_start` for the SAME message object once the turn actually
	 * starts; `_handleAgentEvent` consumes (deletes) it from this set to suppress that one duplicate
	 * listener notification. Persistence is untouched: it stays keyed off `message_end`, which is
	 * never added here and never suppressed.
	 */
	private _earlyDisplayedUserMessages = new Set<AgentMessage>();

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		// When a user message starts, check if it's from either queue and remove it BEFORE emitting
		// This ensures the UI sees the updated queue state
		if (event.type === "message_start" && event.message.role === "user") {
			this._overflowRecoveryAttempted = false;
			const messageText = this._getUserMessageText(event.message);
			if (messageText) {
				// Check steering queue first
				const steeringIndex = this._steeringMessages.indexOf(messageText);
				if (steeringIndex !== -1) {
					this._steeringMessages.splice(steeringIndex, 1);
					this._emitQueueUpdate();
				} else {
					// Check follow-up queue
					const followUpIndex = this._followUpMessages.indexOf(messageText);
					if (followUpIndex !== -1) {
						this._followUpMessages.splice(followUpIndex, 1);
						this._emitQueueUpdate();
					}
				}
			}
		}

		// Emit to extensions first
		await this._emitExtensionEvent(event);

		const suppressRetryPromptEvent =
			this._modelRouter.isRetryInFlight() &&
			(event.type === "message_start" || event.type === "message_end") &&
			(event.message.role === "user" || event.message.role === "custom");

		// This is the authoritative message_start for a user message already painted early (see
		// _promptUnserialized). Set#delete both tests and consumes membership in one step, so only
		// this one duplicate is suppressed and a later, unrelated user message is never affected.
		const suppressAlreadyDisplayedUserMessage =
			event.type === "message_start" &&
			event.message.role === "user" &&
			this._earlyDisplayedUserMessages.delete(event.message);

		// Notify all listeners
		if (!suppressRetryPromptEvent && !suppressAlreadyDisplayedUserMessage) {
			this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);
		}

		// Handle session/context retention. Tool result details are UI/log metadata,
		// not provider-visible content, and large graph/search payloads can otherwise
		// accumulate until the interactive Node process hits the V8 heap limit.
		if (event.type === "message_end") {
			compactToolResultDetailsForRetention(event.message);
			// While a cheap routed turn is buffering, its messages are captured for later flush/discard
			// instead of persisted here (see ModelRouterController.captureSessionMessage).
			if (this._modelRouter.captureSessionMessage(event.message)) {
				// buffered by the router; persistence is deferred to the routed-turn flush
			}
			// Check if this is a custom message from extensions
			else if (event.message.role === "custom") {
				// Persist as CustomMessageEntry
				this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
				);
			} else if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				this.sessionManager.appendMessage(event.message);
			}
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

			// Track assistant message for auto-compaction (checked on agent_end)
			if (event.message.role === "assistant") {
				this._lastAssistantMessage = event.message;

				const assistantMsg = event.message as AssistantMessage;
				if (assistantMsg.stopReason !== "error") {
					this._overflowRecoveryAttempted = false;
				}

				// Reset retry counter immediately on successful assistant response
				// This prevents accumulation across multiple LLM calls within a turn
				if (assistantMsg.stopReason !== "error" && this._retryController.attempt > 0) {
					this._emit({
						type: "auto_retry_end",
						success: true,
						attempt: this._retryController.attempt,
					});
					this._retryController.reset();
				}
			}
		}
	};

	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled || this._retryController.attempt >= settings.maxRetries) {
			return false;
		}

		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				return this._isRetryableError(message as AssistantMessage);
			}
		}
		return false;
	}

	/** Extract text content from a message */
	private _getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const content = message.content;
		if (typeof content === "string") return content;
		const textBlocks = content.filter((c) => c.type === "text");
		return textBlocks.map((c) => (c as TextContent).text).join("");
	}

	/** Find the last assistant message in agent state (including aborted ones) */
	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	private _replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
		// Agent-core stores the finalized message object in its state before emitting message_end.
		// SessionManager persistence happens later in _handleAgentEvent() with event.message.
		// Mutating this object in place keeps agent state, later turn/agent events, listeners,
		// and the eventual SessionManager.appendMessage(event.message) persistence in sync.
		if (target === replacement) {
			return;
		}

		const targetRecord = target as unknown as Record<string, unknown>;
		for (const key of Object.keys(targetRecord)) {
			delete targetRecord[key];
		}
		Object.assign(targetRecord, replacement);
	}

	/** Emit extension events based on agent events */
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			this._turnIndex = 0;
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
		} else if (event.type === "turn_start") {
			this._refreshForegroundEnvelope();
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			const extensionEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this._turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this._extensionRunner.emit(extensionEvent);
			this._turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent);
			if (replacement) {
				this._replaceMessageInPlace(event.message, replacement);
			}
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
			await this._extensionRunner.emit(extensionEvent);
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Subscribe to extensions changed events (load/unload live).
	 * Returns unsubscribe function for this listener.
	 */
	onExtensionsChanged(cb: () => void): () => void {
		this._extensionsChangedListeners.push(cb);

		return () => {
			const index = this._extensionsChangedListeners.indexOf(cb);
			if (index !== -1) {
				this._extensionsChangedListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Notify all extensions-changed listeners.
	 * Called after successful load/unload operations.
	 */
	private _notifyExtensionsChanged(): void {
		for (const listener of this._extensionsChangedListeners) {
			try {
				listener();
			} catch {
				// Suppress errors from listeners to avoid cascading failures
			}
		}
	}

	/**
	 * Temporarily disconnect from agent events.
	 * User listeners are preserved and will receive events again after resubscribe().
	 * Used internally during operations that need to pause event processing.
	 */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * Reconnect to agent events after _disconnectFromAgent().
	 * Preserves all existing listeners.
	 */
	private _reconnectToAgent(): void {
		if (this._unsubscribeAgent) return; // Already connected
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	dispose(): void {
		try {
			this._backgroundLanes.clearGoalAutoContinueTimer();
			this._backgroundLanes.clearResearchLaneTimer();
			this.abortRetry();
			this.abortCompaction();
			this.abortBranchSummary();
			this.abortBash();
			this.agent.abort();
			// R8: stop any deployment-registered gateway channels / schedulers.
			void this._gatewayRegistry.stop().catch(() => {});
			// Bug #21: abort any in-flight background reflection so it cannot keep spending tokens or
			// write memory/skills against this now-disposed session.
			this._disposed = true;
			this._reflectionAbort.abort();
			// Abort any in-flight research pass or delegated worker for the same reason: a disposed
			// session must not keep spending tokens or persist evidence against dead state.
			this._backgroundLanes.abortInFlightLanes();
			// Bug #20: clear the hooks this session installed on the shared agent so their closures stop
			// pinning this (deactivated) session — and all its history/maps — in memory if the agent
			// instance outlives the session.
			this.agent.afterToolCall = undefined;
			this.agent.transformContext = undefined;
		} catch {
			// Dispose must succeed even if an abort hook throws.
		}

		this._extensionRunner.invalidate(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		this._disconnectFromAgent();
		this._eventListeners = [];
		// Best-effort memory cleanup (release locks/handles). Write-side onSessionEnd is wired on a
		// true session-end hook (P3); file-store shutdown is a no-op.
		void this._memory
			.getMemoryManager()
			.shutdownAll()
			.catch(() => {});
		cleanupSessionResources(this.sessionId);
		// Best-effort final sweep for any grep/find artifact already released (reference
		// count zero) but not yet reclaimed -- e.g. a release whose cleanup() call failed
		// transiently. This is conservative: it never releases a still-referenced
		// artifact, so a session that ends before context-gc ever evicts a result (too
		// short to cross preserveRecentMessages) correctly leaves that artifact in place,
		// resolvable if the same session is resumed later. It does not sweep OTHER
		// sessions' artifact directories.
		try {
			this._pipeline.cleanupToolArtifactStoreOnDispose();
		} catch {
			// Best-effort; dispose must succeed regardless.
		}
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	/** Whether agent is currently streaming a response */
	get isStreaming(): boolean {
		return this.agent.state.isStreaming;
	}

	/** Current effective system prompt (includes any per-turn extension modifications) */
	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retryController.attempt;
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/** G7: build a foreground {@link CapabilityEnvelope} from the live session state (active tools, cwd, cost ceiling). */
	private _buildForegroundEnvelopeFromState(): CapabilityEnvelope {
		return buildForegroundEnvelope({
			turnIndex: this._turnIndex,
			activeToolNames: this.getActiveToolNames(),
			cwd: this._cwd,
			maxTurnUsd: this.settingsManager.getCostGuardSettings().maxTurnUsd,
		});
	}

	/**
	 * G7: (re)build the foreground envelope for the current turn. Visibility only -- the foreground
	 * envelope is NOT enforced this round. Best-effort: never throws into the turn.
	 */
	private _refreshForegroundEnvelope(): void {
		try {
			this._currentForegroundEnvelope = this._buildForegroundEnvelopeFromState();
		} catch {
			// Visibility only: a failure to build the envelope must never disturb the turn.
		}
	}

	/** G7: the auto-constructed foreground envelope for the current/most-recent turn (visibility only). */
	getForegroundEnvelope(): CapabilityEnvelope | undefined {
		return this._currentForegroundEnvelope;
	}

	/**
	 * Get all configured tools with name, description, parameter schema, prompt guidelines, and source metadata.
	 */
	getAllTools(): ToolInfo[] {
		return this._runtimeBuilder.getAllTools();
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._runtimeBuilder.getToolDefinition(name);
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 *
	 * artifact_retrieve is auto-activated as a companion whenever grep or find ends up
	 * in the resulting active set and artifact_retrieve is registered (i.e. not excluded/
	 * blocked/outside an allowlist -- the registry itself is built with that same filter,
	 * so registry presence already tracks "allowed"). This is enforced here, not just in
	 * the settings/profile refresh flow, because this method is a public, extension-
	 * exposed activation path (`setActiveTools`) on its own: without this, grep/find could
	 * end up active while still being handed an artifact store (gated on "allowed" in
	 * `_buildRuntime`) with no active tool able to resolve the resulting
	 * "Full output: artifact tool-output:<id>" handle.
	 */
	setActiveToolsByName(toolNames: string[]): void {
		// Model capability: small-window models get a reduced tool surface derived from the model's
		// own metadata. The unfiltered request is remembered so a later switch to a larger model
		// restores it (the filter is re-applied on every model change).
		this._requestedActiveToolNames = [...toolNames];
		const capabilityFiltered = filterToolNamesForCapability(toolNames, this.getModelCapabilityProfile());

		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		const seen = new Set<string>();
		const addIfRegistered = (name: string): void => {
			if (seen.has(name)) return;
			const tool = this._runtimeBuilder.getRegisteredTool(name);
			if (!tool) return;
			seen.add(name);
			tools.push(tool);
			validToolNames.push(name);
		};

		for (const name of capabilityFiltered) {
			addIfRegistered(name);
		}
		if (validToolNames.includes("grep") || validToolNames.includes("find")) {
			addIfRegistered("artifact_retrieve");
		}

		this.agent.state.tools = tools;

		// Rebuild base system prompt with new tool set
		this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
		this.agent.state.systemPrompt = this._baseSystemPrompt;

		this._checkContextWindowUsageWarning();
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return (
			this._autoCompactionAbortController !== undefined ||
			this._compactionAbortController !== undefined ||
			this._branchSummaryAbortController !== undefined
		);
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this._scopedModels;
	}

	/** Update scoped models for cycling */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._scopedModels = scopedModels;
	}

	/** File-based prompt templates */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getActivePrompts();
	}

	// System-prompt construction lives in SystemPromptBuilder (see system-prompt-builder.ts). These
	// stubs keep the god file's internal call surface stable while the assembly logic — situational
	// soul, self-modification/autonomy guardrails, per-tool snippet/guideline options — lives there.
	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		return this._systemPromptBuilder.normalizePromptSnippet(text);
	}

	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		return this._systemPromptBuilder.normalizePromptGuidelines(guidelines);
	}

	private _rebuildSystemPrompt(toolNames: string[]): string {
		return this._systemPromptBuilder.rebuildSystemPrompt(toolNames);
	}

	/**
	 * Build a system prompt for a specific tool surface WITHOUT touching the session's base prompt
	 * state (G4 router-swap; see {@link SystemPromptBuilder.buildSystemPromptForToolNames}).
	 */
	private _buildSystemPromptForToolNames(toolNames: string[]): string {
		return this._systemPromptBuilder.buildSystemPromptForToolNames(toolNames);
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	private async _runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void> {
		try {
			const maxGoalLoopRounds = this.settingsManager.getAutonomySettings().maxStallTurns;
			this.agent.maxStallTurns = maxGoalLoopRounds;
			let goalLoopRounds = 1;
			await this.agent.prompt(messages);
			while ((maxGoalLoopRounds === 0 || goalLoopRounds < maxGoalLoopRounds) && (await this._handlePostAgentRun())) {
				await this.agent.continue();
				goalLoopRounds++;
			}
		} finally {
			this._flushPendingBashMessages();
			await this._drainQueuedExtensionCommands();
		}
	}

	/**
	 * Shared {@link OllamaRuntime} for a given server, lazily created and cached by baseUrl so every
	 * caller — the router's readiness gate and any host UI's own model-lifecycle commands (e.g.
	 * `/models`) — sees and can stop the SAME pi-managed process instead of each tracking its own
	 * untracked child. Delegates to {@link LocalRuntimeController}.
	 */
	getLocalRuntime(baseUrl?: string): OllamaRuntime {
		return this._localRuntimeController.getLocalRuntime(baseUrl);
	}

	/** models.json registers a local model's baseUrl as `<server>/v1` (OpenAI-compat); the runtime's
	 * own health/boot endpoints are on the Ollama-native server root. Delegates to
	 * {@link LocalRuntimeController}; kept here for `_warnIfManualModelChoiceIsRisky`'s own use. */
	private _deriveOllamaServerUrl(modelBaseUrl: string): string {
		return this._localRuntimeController.deriveOllamaServerUrl(modelBaseUrl);
	}

	/**
	 * Router-swap gate (#27): a turn routed to a local model must not dead-end the turn just because
	 * ollama isn't up. Delegates to {@link LocalRuntimeController}; see there for the full
	 * consent-then-escalate contract (which includes the local-model readiness check itself).
	 */
	private async _ensureRouteModelReady(
		resolved: { decision: RouteDecision; model: Model<Api> } | undefined,
	): Promise<{ decision: RouteDecision; model: Model<Api> } | undefined> {
		return this._localRuntimeController.ensureRouteModelReady(resolved);
	}

	/** Model-router status + config diagnostics report. Delegates to {@link ModelRouterController}. */
	getModelRouterStatus(formatLabel?: (label: string) => string): string {
		return this._modelRouter.getStatus(formatLabel);
	}

	private async _handlePostAgentRun(): Promise<boolean> {
		const msg = this._lastAssistantMessage;
		this._lastAssistantMessage = undefined;
		if (!msg) {
			return false;
		}

		if (this._isRetryableError(msg) && (await this._prepareRetry(msg))) {
			return true;
		}

		if (msg.stopReason === "error" && this._retryController.attempt > 0) {
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryController.attempt,
				finalError: msg.errorMessage,
			});
			this._retryController.reset();
		}

		if (await this._checkCompaction(msg)) {
			return true;
		}

		// The agent loop drains both queues before emitting agent_end. Any messages
		// here were queued by agent_end extension handlers and need a continuation.
		return this.agent.hasQueuedMessages();
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		if (options?.autoContinueGoal !== false) {
			this._backgroundLanes.clearGoalAutoContinueTimer();
		}

		if ((this.isStreaming || this.isRetrying) && options?.streamingBehavior) {
			const run = this._streamingPromptSubmissionTail.then(
				() => this._promptUnserialized(text, options),
				() => this._promptUnserialized(text, options),
			);
			this._streamingPromptSubmissionTail = run.catch(() => {});
			return run;
		}
		return this._promptUnserialized(text, options);
	}

	private async _promptUnserialized(text: string, options?: PromptOptions): Promise<void> {
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const processSlashCommands = options?.processSlashCommands ?? expandPromptTemplates;
		const preflightResult = options?.preflightResult;
		let messages: AgentMessage[] | undefined;
		let routedTurnModel: Model<Api> | undefined;
		let routedTurnRouteDecision: RouteDecision | undefined;
		// Built and painted early (see below) so a later throw in this try block — e.g. no model
		// selected/authenticated — can un-register it from _earlyDisplayedUserMessages instead of
		// leaking the reference forever.
		let userMessage: AgentMessage | undefined;
		// R4 effectiveness feedback: remember the recall page + the query so we can score, after the
		// response, whether the agent actually used the recalled context.
		let injectedRecall = "";
		let recallQuery = "";

		try {
			// Handle extension commands first. Programmatic extension messages may opt
			// into command handling; if the agent is currently streaming, queue the
			// command for the end of the run instead of sending it to the model.
			if (processSlashCommands && text.startsWith("/")) {
				if (this.isStreaming && options?.source === "extension" && options?.streamingBehavior) {
					const commandName = this._parseCommandName(text);
					if (this._extensionRunner.getCommand(commandName)) {
						this._queueExtensionCommand(text);
						preflightResult?.(true);
						return;
					}
				}
				const handled = await this._tryExecuteExtensionCommand(text);
				if (handled) {
					// Extension command executed, no prompt to send
					preflightResult?.(true);
					return;
				}
			}

			// Emit input event for extension interception (before skill/template expansion)
			let currentText = text;
			let currentImages = options?.images;
			if (this._extensionRunner.hasHandlers("input")) {
				const inputResult = await this._extensionRunner.emitInput(
					currentText,
					currentImages,
					options?.source ?? "interactive",
					this.isStreaming ? options?.streamingBehavior : undefined,
				);
				if (inputResult.action === "handled") {
					preflightResult?.(true);
					return;
				}
				if (inputResult.action === "transform") {
					currentText = inputResult.text;
					currentImages = inputResult.images ?? currentImages;
				}
			}

			// Expand skill commands (/skill:name args) and prompt templates (/template args)
			let expandedText = currentText;
			if (expandPromptTemplates) {
				expandedText = this._expandSkillCommand(expandedText);
				expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
			}

			// If streaming — or waiting out a retry backoff, which is still an active
			// operation — queue via steer() or followUp() instead of starting a
			// concurrent run that would race the pending retry continuation.
			if (this.isStreaming || this.isRetrying) {
				if (!options?.streamingBehavior) {
					throw new Error(
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				}
				if (options.streamingBehavior === "followUp") {
					await this._queueFollowUp(expandedText, currentImages);
				} else {
					await this._queueSteer(expandedText, currentImages);
				}
				preflightResult?.(true);
				return;
			}

			// Flush any pending bash messages before the new prompt
			this._flushPendingBashMessages();

			// Build the user message now — before the router judge — and paint it to the UI
			// immediately via a synthetic message_start. The judge is a real bounded LLM completion
			// (seconds), not a regex; awaiting it first made the prompt appear to hang. The
			// authoritative message_start emitted later for this SAME object is suppressed in
			// _handleAgentEvent (see _earlyDisplayedUserMessages) so it is still shown exactly once.
			const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
			if (currentImages) {
				userContent.push(...currentImages);
			}
			userMessage = {
				role: "user",
				content: userContent,
				timestamp: Date.now(),
			};
			this._earlyDisplayedUserMessages.add(userMessage);
			this._emit({ type: "message_start", message: userMessage });

			// Bracket the routing/prep phase (judge, model/auth checks, compaction, ...) so the UI can
			// show general "working" feedback for it — otherwise the user stares at their own echoed
			// prompt with nothing happening for however long the judge takes. routing_end is emitted
			// exactly once below: either in the catch block (this phase failed) or right after the try
			// block (this phase succeeded, whether or not it produced a turn to run).
			this._emit({ type: "routing_start" });

			const resolvedRouteInfo = await this._modelRouter.resolveTurnRouteJudged(expandedText, {
				// Internally generated turns (goal continuation, lane follow-ups) never consult the judge:
				// the regex floor already classified them, and a 20-turn loop must not buy 20 judge calls.
				skipJudge: options?.autoContinueGoal === false,
			});
			// #27: a route landing on a local (ollama) model must not hard-fail the turn just because
			// the server isn't up yet — boot/reuse it here, or escalate to a non-local tier.
			const readyRouteInfo = await this._ensureRouteModelReady(resolvedRouteInfo);
			routedTurnModel = readyRouteInfo?.model;
			routedTurnRouteDecision = readyRouteInfo?.decision;
			const requestModel = routedTurnModel ?? this.model;

			// Validate model
			if (!requestModel) {
				throw new Error(formatNoModelSelectedMessage());
			}

			if (!this._modelRegistry.hasConfiguredAuth(requestModel)) {
				const isOAuth = this._modelRegistry.isUsingOAuth(requestModel);
				if (isOAuth) {
					throw new Error(
						`Authentication failed for "${requestModel.provider}". ` +
							`Credentials may have expired or network is unavailable. ` +
							`Run '/login ${requestModel.provider}' to re-authenticate.`,
					);
				}
				throw new Error(formatNoApiKeyFoundMessage(requestModel.provider));
			}

			this._checkContextWindowUsageWarning();

			// Check if we need to compact before sending (catches aborted responses).
			// Do not call agent.continue() here: the next model turn must include the
			// user's pending prompt, not an empty continuation after compaction.
			const lastAssistant = this._findLastAssistantMessage();
			if (lastAssistant) {
				await this._checkCompaction(lastAssistant, false);
			}

			// Build messages array (recall page, then custom message if any, then user message)
			messages = [];

			// R3: cross-session similarity recall. For a substantive turn, ask the memory providers to
			// prefetch a relevant <memory_context> page from past sessions and prepend it as data ahead of
			// the user message. Best-effort and gated: trivial turns are skipped, and providers return ""
			// (no page) when nothing is relevant — so it stays net-negative and the GC packs stale pages.
			if (this._memory.shouldAttemptRecall(expandedText)) {
				try {
					const recall = await this._memory.getMemoryManager().prefetch(expandedText);
					if (recall) {
						injectedRecall = recall;
						recallQuery = expandedText;
						// Inject as a GC-managed custom context message (role "custom", customType
						// "memory_context"), NOT a persisted user message: the semantic-memory context-GC packs
						// stale recall pages so they don't accumulate forever (Bug #7), and the transcript index
						// only re-reads user/assistant text so recalled snippets can't recirculate (Bug #10).
						messages.push(
							createCustomMessage("memory_context", recall, false, undefined, new Date().toISOString()),
						);
					}
				} catch {
					// recall must never break a turn
				}
			}

			// Add user message (built earlier, before the router judge, so it could be painted
			// immediately — see the early message_start emit above).
			messages.push(userMessage);

			// Inject any pending "nextTurn" messages as context alongside the user message
			for (const msg of this._pendingNextTurnMessages) {
				messages.push(msg);
			}
			this._pendingNextTurnMessages = [];

			// Emit before_agent_start extension event
			const result = await this._extensionRunner.emitBeforeAgentStart(
				expandedText,
				currentImages,
				this._baseSystemPrompt,
				this._systemPromptBuilder.getBaseSystemPromptOptions(),
			);
			// Add all custom messages from extensions
			if (result?.messages) {
				for (const msg of result.messages) {
					messages.push({
						role: "custom",
						customType: msg.customType,
						content: msg.content,
						display: msg.display,
						details: msg.details,
						timestamp: Date.now(),
					});
				}
			}
			// Apply extension-modified system prompt, or reset to base
			if (result?.systemPrompt) {
				this.agent.state.systemPrompt = result.systemPrompt;
			} else {
				// Ensure we're using the base prompt (in case previous turn had modifications)
				this.agent.state.systemPrompt = this._baseSystemPrompt;
			}
		} catch (error) {
			// The turn never reached _runAgentPrompt, so the authoritative message_start that would
			// normally consume this entry (see _handleAgentEvent) never fires — un-register it here
			// instead of leaking the reference.
			if (userMessage) {
				this._earlyDisplayedUserMessages.delete(userMessage);
			}
			// The routing/prep phase (routing_start above) failed before ever reaching the turn — end
			// it here, or the UI's "working" indicator for it spins forever with nothing behind it.
			this._emit({ type: "routing_end" });
			preflightResult?.(false);
			throw error;
		}

		// The routing/prep phase is over — either we're about to hand off into the turn (which emits
		// its own agent_start/streaming events right after), or messages is unexpectedly unset and we
		// bail below. Either way nothing is left "routing" past this point.
		this._emit({ type: "routing_end" });

		if (!messages) {
			return;
		}

		preflightResult?.(true);
		await this._modelRouter.runRoutedTurn(messages, routedTurnModel, routedTurnRouteDecision);

		// R4: score whether the agent actually used the recalled context, so the recall gate can adapt.
		if (injectedRecall) {
			const response = this._findLastAssistantMessage();
			const responseText = response
				? response.content
						.filter((c): c is TextContent => c.type === "text")
						.map((c) => c.text)
						.join(" ")
				: "";
			if (responseText) {
				this._memory.recordRecallOutcome(injectedRecall, recallQuery, responseText);
			}
		}

		this._backgroundLanes.scheduleGoalAutoContinueFromIdle(options);
		this._backgroundLanes.scheduleResearchLaneFromIdle();
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	private _parseCommandName(text: string): string {
		const spaceIndex = text.indexOf(" ");
		return spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	}

	private async _tryExecuteExtensionCommand(text: string): Promise<boolean> {
		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = this._parseCommandName(text);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		const ctx = this._extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// Emit error via extension runner
			this._extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	/**
	 * Expand skill commands (/skill:name args) to their full content.
	 * Returns the expanded text, or the original text if not a skill command or skill not found.
	 * Emits errors via extension runner if file read fails.
	 */
	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		// Resolve only against profile-active skills so a `/skill:` the active profile blocks cannot be
		// expanded/invoked — by the user OR the agent — even if it loaded before a runtime profile switch.
		const skill = this.resourceLoader.getActiveSkills().find((s) => s.name === skillName);
		if (!skill) return text; // Unknown or profile-blocked skill, pass through unchanged

		try {
			const content = readFileSync(skill.filePath, "utf-8");
			// Curator (#32): record use of a reflection-PROMOTED skill so stale ones can later be proposed
			// for archival. Only promoted skills carry the marker, so hand-authored skills are untouched.
			if (isPromotedFrontmatter(content)) {
				this._skillCurator.recordUse(skill.name, Date.now());
			}
			const body = stripResourceProfileBlocks(stripFrontmatter(content)).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			// Emit error like extension commands do
			this._extensionRunner.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text; // Return original on error
		}
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async steer(text: string, images?: ImageContent[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueSteer(expandedText, images);
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueFollowUp(expandedText, images);
	}

	/**
	 * Internal: Queue a steering message (already expanded, no extension command check).
	 */
	private async _queueSteer(text: string, images?: ImageContent[]): Promise<void> {
		this._steeringMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.steer({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	private async _queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
		this._followUpMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.followUp({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * Internal: Queue an extension command to execute after the current agent run.
	 */
	private _queueExtensionCommand(text: string): void {
		this._queuedExtensionCommands.push(text);
		this._emitQueueUpdate();
	}

	private async _drainQueuedExtensionCommands(): Promise<void> {
		while (this._queuedExtensionCommands.length > 0 && !this.isStreaming) {
			const commandText = this._queuedExtensionCommands.shift()!;
			this._emitQueueUpdate();
			await this._tryExecuteExtensionCommand(commandText);
		}
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	private _throwIfExtensionCommand(text: string): void {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles three cases:
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		if (options?.deliverAs === "nextTurn") {
			this._pendingNextTurnMessages.push(appMessage);
		} else if (this.isStreaming) {
			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this.agent.steer(appMessage);
			}
		} else if (options?.triggerTurn) {
			await this._runAgentPrompt(appMessage);
		} else {
			this.agent.state.messages.push(appMessage);
			this.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
			this._emit({ type: "message_start", message: appMessage });
			this._emit({ type: "message_end", message: appMessage });
		}
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; processSlashCommands?: boolean },
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		// Skip skill/template expansion by default. Extensions that intentionally
		// want slash commands to execute (for example self-maintenance reloads)
		// can opt in with processSlashCommands.
		await this.prompt(text, {
			expandPromptTemplates: false,
			processSlashCommands: options?.processSlashCommands ?? false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
	}

	/**
	 * Clear all queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 * @returns Object with steering, followUp, and queued extension command arrays
	 */
	clearQueue(): { steering: string[]; followUp: string[]; commands: string[] } {
		const steering = [...this._steeringMessages];
		const followUp = [...this._followUpMessages];
		const commands = [...this._queuedExtensionCommands];
		this._steeringMessages = [];
		this._followUpMessages = [];
		this._queuedExtensionCommands = [];
		this.agent.clearAllQueues();
		this._emitQueueUpdate();
		return { steering, followUp, commands };
	}

	/** Number of pending messages (includes steering, follow-up, and queued extension commands) */
	get pendingMessageCount(): number {
		return this._steeringMessages.length + this._followUpMessages.length + this._queuedExtensionCommands.length;
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly string[] {
		return this._steeringMessages;
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly string[] {
		return this._followUpMessages;
	}

	/** Get pending extension commands (read-only). */
	getQueuedExtensionCommands(): readonly string[] {
		return this._queuedExtensionCommands;
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	async abort(): Promise<void> {
		this.abortRetry();
		this.agent.abort();
		await this.agent.waitForIdle();
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	async setModel(model: Model<any>, options: { persistSettings?: boolean } = {}): Promise<void> {
		return this._modelSelection.setModel(model, options);
	}

	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		return this._modelSelection.cycleModel(direction);
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	setThinkingLevel(level: ThinkingLevel, options: { persistSettings?: boolean } = {}): void {
		this._modelSelection.setThinkingLevel(level, options);
	}

	cycleThinkingLevel(): ThinkingLevel | undefined {
		return this._modelSelection.cycleThinkingLevel();
	}

	getAvailableThinkingLevels(): ThinkingLevel[] {
		return this._modelSelection.getAvailableThinkingLevels();
	}

	supportsThinking(): boolean {
		return this._modelSelection.supportsThinking();
	}

	// =========================================================================
	// Queue Mode Management
	// =========================================================================

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		this._disconnectFromAgent();
		await this.abort();
		this._compactionAbortController = new AbortController();
		this._emit({ type: "compaction_start", reason: "manual" });

		try {
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const compactionModel = this._resolveCompactionModel(this.model);
			const { apiKey, headers } = await this._getCompactionRequestAuth(compactionModel);

			const pathEntries = this.sessionManager.getBranch();
			const settings = this._getAdaptedCompactionSettings();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				// Check why we can't compact
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					signal: this._compactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (result?.cancel) {
					throw new Error("Compaction cancelled");
				}

				if (result?.compaction) {
					extensionCompaction = result.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				details = extensionCompaction.details;
			} else {
				// Generate compaction result
				const compactionSignal = this._compactionAbortController!.signal;
				const result = await this._compactWithRetry(
					() =>
						compact(
							preparation,
							compactionModel,
							apiKey,
							headers,
							customInstructions,
							compactionSignal,
							this.thinkingLevel,
							this.agent.streamFn,
							this._buildCompactionPreDigest(),
						),
					compactionSignal,
				);
				summary = result.summary;
				firstKeptEntryId = result.firstKeptEntryId;
				tokensBefore = result.tokensBefore;
				details = result.details;
			}

			if (this._compactionAbortController.signal.aborted) {
				throw new Error("Compaction cancelled");
			}

			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;

			// Get the saved compaction entry for the extension event
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
				});
			}

			const compactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				details,
			};
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: compactionResult,
				aborted: false,
				willRetry: false,
			});
			return compactionResult;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage: aborted ? undefined : `Compaction failed: ${message}`,
			});
			throw error;
		} finally {
			this._compactionAbortController = undefined;
			this._reconnectToAgent();
		}
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abortCompaction(): void {
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	/**
	 * Check if compaction is needed and run it.
	 * Called after agent_end and before prompt submission.
	 *
	 * Two cases:
	 * 1. Overflow: LLM returned context overflow error, remove error message from agent state, compact, auto-retry
	 * 2. Threshold: Context over threshold, compact, NO auto-retry (user continues manually)
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 */
	private _getAdaptedCompactionSettings(): CompactionSettings {
		return this._compactionSupport.getAdaptedSettings();
	}

	private _checkContextWindowUsageWarning(): void {
		if (!this.model) return;
		const contextWindow = this.model.contextWindow ?? 0;
		if (contextWindow <= 0) return;

		const systemPromptTokens = Math.ceil((this.agent.state.systemPrompt ?? "").length / 4);

		let toolsChars = 0;
		for (const tool of this.agent.state.tools || []) {
			toolsChars += tool.name.length;
			toolsChars += tool.description?.length ?? 0;
			if (tool.parameters) {
				toolsChars += JSON.stringify(tool.parameters).length;
			}
		}
		const toolsTokens = Math.ceil(toolsChars / 4);

		const baseTokens = systemPromptTokens + toolsTokens;

		if (baseTokens >= contextWindow) {
			this._emit({
				type: "warning",
				message: `Base configuration (system prompt and active tools) consumes ${baseTokens} tokens, which exceeds the model's context window of ${contextWindow} tokens. The model cannot process any prompts in this state.`,
			});
		} else if (baseTokens >= contextWindow * 0.7) {
			this._emit({
				type: "warning",
				message: `Base configuration (system prompt and active tools) consumes ${baseTokens} tokens (${Math.round((baseTokens / contextWindow) * 100)}% of the ${contextWindow} context window). This leaves very little room for conversation history and may cause immediate compaction or context overflow.`,
			});
		}
	}

	private async _checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<boolean> {
		const settings = this._getAdaptedCompactionSettings();
		if (!settings.enabled) return false;

		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

		const contextWindow = this.model?.contextWindow ?? 0;

		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model.
		const sameModel =
			this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;

		// Skip compaction checks if this assistant message is older than the latest
		// compaction boundary. This prevents a stale pre-compaction usage/error
		// from retriggering compaction on the first prompt after compaction.
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const assistantIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
		if (assistantIsFromBeforeCompaction) {
			return false;
		}

		// Case 1: Overflow - LLM returned context overflow error
		if (sameModel && isContextOverflow(assistantMessage, contextWindow)) {
			if (this._overflowRecoveryAttempted) {
				this._emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
				});
				return false;
			}

			this._overflowRecoveryAttempted = true;
			// Remove the error message from agent state (it IS saved to session for history,
			// but we don't want it in context for the retry)
			const messages = this.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.agent.state.messages = messages.slice(0, -1);
			}
			return await this._runAutoCompaction("overflow", true);
		}

		// Case 2: Threshold - context is getting large
		// For error messages (no usage data), estimate from last successful response.
		// This ensures sessions that hit persistent API errors (e.g. 529) can still compact.
		let contextTokens: number;
		if (assistantMessage.stopReason === "error") {
			const messages = this.agent.state.messages;
			const estimate = estimateContextTokens(messages);
			if (estimate.lastUsageIndex === null) return false; // No usage data at all
			// Verify the usage source is post-compaction. Kept pre-compaction messages
			// have stale usage reflecting the old (larger) context and would falsely
			// trigger compaction right after one just finished.
			const usageMsg = messages[estimate.lastUsageIndex];
			if (
				compactionEntry &&
				usageMsg.role === "assistant" &&
				(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
			) {
				return false;
			}
			contextTokens = estimate.tokens;
		} else {
			contextTokens = calculateContextTokens(assistantMessage.usage);
			const estimate = estimateContextTokens(this.agent.state.messages);
			if (estimate.lastUsageIndex !== null) {
				const usageMsg = this.agent.state.messages[estimate.lastUsageIndex];
				const usageIsPostCompaction = !(
					compactionEntry &&
					usageMsg.role === "assistant" &&
					(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
				);
				if (usageIsPostCompaction) {
					contextTokens = Math.max(contextTokens, estimate.tokens);
				}
			}
		}
		if (shouldCompact(contextTokens, contextWindow, settings, this.model?.autoCompactionTriggerTokens)) {
			return await this._runAutoCompaction("threshold", false);
		}
		return false;
	}

	/**
	 * Internal: Run auto-compaction with events.
	 */
	private async _runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> {
		const settings = this._getAdaptedCompactionSettings();
		const model = this.model;
		this._emit({ type: "compaction_start", reason });
		const hadQueuedMessages = this.agent.hasQueuedMessages();
		this._autoCompactionAbortController = new AbortController();
		const signal = this._autoCompactionAbortController.signal;
		let fromExtension = false;
		let lastCompaction: CompactionResult | undefined;
		let extensionCancelled = false;
		try {
			if (!model) {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: false,
					willRetry: false,
					skipReason: "no model selected",
				});
				return false;
			}

			const contextWindow = model.contextWindow;
			const triggerThreshold = Math.max(0, contextWindow - settings.reserveTokens);
			const margin = Math.max(0, Math.floor(0.01 * contextWindow));
			let measureReads = 0;
			const outcome = await runCompactionLoop({
				getBranch: () => this.sessionManager.getBranch(),
				measureLiveTokens: () => {
					const measured = this._pipeline.estimateCurrentContextTokens(this.agent.state.messages);
					return measureReads++ === 0 ? Math.max(measured, triggerThreshold + 1) : measured;
				},
				getTriggerThreshold: () => triggerThreshold,
				getMargin: () => margin,
				getBaseKeepRecentTokens: () => settings.keepRecentTokens,
				resolveModelAndAuth: async (modelTier) =>
					this._resolveCompactionModelAndAuth(
						modelTier === "session" ? model : this._resolveCompactionModel(model),
						model,
					),
				summarizeAndVerify: async (params, compactModel, apiKey, headers, branchEntries) => {
					fromExtension = false;
					const adaptedSettings = { ...settings, keepRecentTokens: params.keepRecentTokens };
					const preparation = prepareCompaction(branchEntries, adaptedSettings);
					if (!preparation) {
						throw new Error("already compacted");
					}

					if (this._extensionRunner.hasHandlers("session_before_compact")) {
						const extensionResult = (await this._extensionRunner.emit({
							type: "session_before_compact",
							preparation,
							branchEntries,
							customInstructions: undefined,
							signal,
						})) as SessionBeforeCompactResult | undefined;
						if (extensionResult?.cancel) {
							extensionCancelled = true;
							throw new Error("auto-compaction-cancelled");
						}
						if (extensionResult?.compaction) {
							fromExtension = true;
							return { result: extensionResult.compaction };
						}
					}

					const compactResult = await this._compactWithRetry(
						() =>
							compact(
								preparation,
								compactModel,
								apiKey,
								headers,
								undefined,
								signal,
								this.thinkingLevel,
								this.agent.streamFn,
								this._buildCompactionPreDigest(),
								{ chunked: params.chunked },
							),
						signal,
					);
					return { result: compactResult };
				},
				buildDeterministicCheckpoint: async () => {
					const branch = this.sessionManager.getBranch();
					const preparation = prepareCompaction(branch, {
						...settings,
					});
					if (!preparation) {
						throw new Error("already compacted");
					}
					fromExtension = false;
					return { result: createDeterministicCompaction(preparation) };
				},
				apply: async (result) => {
					lastCompaction = result;
					this.sessionManager.appendCompaction(
						result.summary,
						result.firstKeptEntryId,
						result.tokensBefore,
						result.details,
						fromExtension,
					);
					this.agent.state.messages = this.sessionManager.buildSessionContext().messages;
					const newEntries = this.sessionManager.getEntries();
					const savedCompactionEntry = newEntries.find(
						(entry) => entry.type === "compaction" && entry.summary === result.summary,
					) as CompactionEntry | undefined;
					if (this._extensionRunner && savedCompactionEntry) {
						await this._extensionRunner.emit({
							type: "session_compact",
							compactionEntry: savedCompactionEntry,
							fromExtension,
						});
					}
				},
				onTransition: ({ cycle, cause }) => {
					this._emit({
						type: "warning",
						message: `auto-compaction cycle ${cycle}: ${cause} — retrying from step 0`,
					});
				},
				signal,
			});

			if (outcome.kind === "skip") {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: false,
					willRetry: false,
					skipReason: outcome.reason,
				});
				return hadQueuedMessages || this.agent.hasQueuedMessages();
			}

			if (outcome.kind === "failed") {
				if (outcome.reason === "aborted") {
					this._emit({ type: "compaction_end", reason, result: undefined, aborted: true, willRetry: false });
					return false;
				}
				throw new Error(outcome.reason);
			}

			if (extensionCancelled || signal.aborted) {
				this._emit({ type: "compaction_end", reason, result: undefined, aborted: true, willRetry: false });
				return false;
			}

			const result = outcome.kind === "success" ? outcome.result : lastCompaction;
			if (!result) {
				throw new Error("Auto-compaction succeeded without a result");
			}
			this._emit({ type: "compaction_end", reason, result, aborted: false, willRetry });

			if (willRetry) {
				const messages = this.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				if (lastMsg?.role === "assistant" && (lastMsg as AssistantMessage).stopReason === "error") {
					this.agent.state.messages = messages.slice(0, -1);
				}
				return true;
			}

			return hadQueuedMessages || this.agent.hasQueuedMessages();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			this._emit({
				type: "compaction_end",
				reason,
				result: undefined,
				aborted: false,
				willRetry: false,
				errorMessage:
					reason === "overflow"
						? `Context overflow recovery failed: ${errorMessage}`
						: `Auto-compaction failed: ${errorMessage}`,
			});
			return false;
		} finally {
			this._autoCompactionAbortController = undefined;
		}
	}

	/**
	 * Run one compaction attempt, retrying retryable provider failures (stream stalls,
	 * 429/5xx, network drops) with the session's retry policy. The reliability kernel
	 * classifies a stall as retryable by design (see withStreamIdleWatchdog); without this
	 * loop a single transient killed the whole compaction while ordinary turns survived the
	 * same failure via auto-retry. Caller aborts are never retried; sleepAbortable rejects
	 * with the abort reason if the signal fires mid-backoff.
	 */
	private async _compactWithRetry(
		run: () => Promise<CompactionResult>,
		signal: AbortSignal,
	): Promise<CompactionResult> {
		const retrySettings = this.settingsManager.getRetrySettings();
		const maxAttempts = retrySettings.enabled ? Math.max(1, retrySettings.maxRetries + 1) : 1;
		const policy: RetryPolicy = {
			maxAttempts,
			baseDelayMs: retrySettings.baseDelayMs,
			maxDelayMs: DEFAULT_RETRY_POLICY.maxDelayMs,
			jitterRatio: 0,
		};
		for (let attempt = 1; ; attempt++) {
			try {
				return await run();
			} catch (error) {
				if (signal.aborted || attempt >= maxAttempts) throw error;
				const message = error instanceof Error ? error.message : String(error);
				const classified = classifyFailure({ message });
				if (!classified.retryable) throw error;
				await sleepAbortable(
					computeRetryDelayMs(policy, attempt, { retryAfterMs: classified.retryAfterMs }),
					signal,
				);
			}
		}
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.mode !== undefined) {
			this._extensionMode = bindings.mode;
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.abortHandler !== undefined) {
			this._extensionAbortHandler = bindings.abortHandler;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}

		this._applyExtensionBindings(this._extensionRunner);
		await this._extensionRunner.emit(this._sessionStartEvent);
		await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
		// Initialize the memory subsystem after extensions have had a chance to register providers.
		await this._memory.initialize();
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			this._cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (extensionPath.startsWith("<")) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext);
		runner.setMode(this._extensionMode);
		runner.bindCommandContext(this._extensionCommandContextActions);

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _refreshCurrentModelFromRegistry(): void {
		const currentModel = this.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this._modelRegistry.find(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		this.agent.state.model = refreshedModel;
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this._resourceLoader.getActiveSkills().map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					this.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					this.sessionManager.appendCustomEntry(customType, data);
				},
				setSessionName: (name) => {
					this.setSessionName(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				refreshTools: () => this._refreshToolRegistry(),
				getCommands,
				setModel: async (model) => {
					if (!this.modelRegistry.hasConfiguredAuth(model)) return false;
					await this.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
				getExternalResourceRoots: () => this.settingsManager.getEffectiveExternalResourceRoots(),
				registerMemoryProvider: (provider) => this.registerMemoryProvider(provider),
				reportSpawnedUsage: (usage, opts) => {
					this.addSpawnedUsage(usage, opts);
				},
			},
			{
				getModel: () => this.model,
				isIdle: () => !this.isStreaming,
				getSignal: () => this.agent.signal,
				abort: () => {
					if (this._extensionAbortHandler) {
						this._extensionAbortHandler();
						return;
					}
					void this.abort();
				},
				hasPendingMessages: () => this.pendingMessageCount > 0,
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				compact: (options) => {
					void (async () => {
						try {
							const result = await this.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				reload: () => {
					if (this.isStreaming) {
						return Promise.reject(
							new Error(
								"ctx.reload() cannot run while the agent is streaming or a tool call is active. Wait for ctx.isIdle(), queue a follow-up /reload, or use an idle command/event handler so hot reload cannot destabilize the UI.",
							),
						);
					}
					if (this.isCompacting) {
						return Promise.reject(
							new Error(
								"ctx.reload() cannot run during context compaction or branch summarization. Let compaction finish before reloading so the session tree and UI remain stable.",
							),
						);
					}
					const actions = this._extensionCommandContextActions;
					if (!actions) {
						return this.reload();
					}
					return actions.reload();
				},
				getSystemPrompt: () => this.systemPrompt,
			},
			{
				registerProvider: (name, config) => {
					this._modelRegistry.registerProvider(name, config);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRegistry.unregisterProvider(name);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	/** Register a memory provider contributed by an extension; applied on the next memory (re)init. */
	registerMemoryProvider(provider: MemoryProvider): void {
		this._memory.registerMemoryProvider(provider);
	}

	/** R8: the gateway/scheduler registry. A deployment runner registers providers and drives start/stop. */
	get gateways(): GatewayRegistry {
		return this._gatewayRegistry;
	}

	/** R8: register a deployment-supplied transport channel (gateway). */
	registerChannelProvider(provider: ChannelProvider): void {
		this._gatewayRegistry.registerChannel(provider);
	}

	/** R8: register a deployment-supplied job scheduler (cron). */
	registerJobScheduler(provider: JobSchedulerProvider): void {
		this._gatewayRegistry.registerScheduler(provider);
	}

	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		this._runtimeBuilder.refreshToolRegistry(options);
	}

	async reload(): Promise<void> {
		return this._runtimeBuilder.reload();
	}

	/**
	 * Unload a single extension without full reload.
	 * Runs the extension's session_shutdown lifecycle, unregisters its providers,
	 * disposes its event subscriptions, and rebuilds the runtime.
	 * Falls back to full reload on error.
	 */
	async unloadExtensionLive(extensionPath: string): Promise<void> {
		return this._runtimeBuilder.unloadExtensionLive(extensionPath);
	}

	/**
	 * Load a single extension without full reload.
	 * Loads the extension with fresh import, rebuilds the runtime,
	 * and runs the extension's session_start lifecycle.
	 * Falls back to full reload on error.
	 */
	async loadExtensionLive(extensionPath: string): Promise<void> {
		return this._runtimeBuilder.loadExtensionLive(extensionPath);
	}

	/**
	 * Reconcile loaded extensions with the active profile.
	 * Loads extensions that should be enabled but aren't, and unloads extensions that shouldn't be.
	 * Falls back to full reload if any individual load/unload fails.
	 */
	async reconcileLoadedExtensions(): Promise<void> {
		return this._runtimeBuilder.reconcileLoadedExtensions();
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Check if an error is retryable (transient provider/network failures). Billing/quota and auth
	 * are terminal; context overflow is handled by compaction, not retry. The verdict comes from the
	 * reliability kernel's classifier, fed the host-computed context-overflow flag.
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		if (message.stopReason !== "error" || !message.errorMessage) return false;
		const contextWindow = this.model?.contextWindow ?? 0;
		return classifyFailure({
			message: message.errorMessage,
			contextOverflow: isContextOverflow(message, contextWindow),
		}).retryable;
	}

	/**
	 * Prepare a retryable error for continuation with exponential backoff.
	 * @returns true if the caller should continue the agent, false otherwise
	 */
	private async _prepareRetry(message: AssistantMessage): Promise<boolean> {
		return this._retryController.prepareRetry(message);
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this._retryController.abort();
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retryController.isRetrying;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; operations?: BashOperations },
	): Promise<BashResult> {
		return this._bash.executeBash(command, onChunk, options);
	}

	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		this._bash.recordBashResult(command, result, options);
	}

	abortBash(): void {
		this._bash.abortBash();
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this._bash.isBashRunning;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._bash.hasPendingBashMessages;
	}

	private _flushPendingBashMessages(): void {
		this._bash.flushPendingBashMessages();
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
		this._emit({ type: "session_info_changed", name: this.sessionManager.getSessionName() });
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		return this._treeNavigator.navigateTree(targetId, options);
	}

	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		return this._treeNavigator.getUserMessagesForForking();
	}

	getSessionStats(): SessionStats {
		return this._analytics.getSessionStats();
	}

	getCumulativeUsage(): Usage {
		return this._analytics.getCumulativeUsage();
	}

	addSpawnedUsage(
		usage: Usage,
		opts?: { label?: string; sourceSessionId?: string; reportId?: string },
	): string | undefined {
		return this._analytics.addSpawnedUsage(usage, opts);
	}

	getSpawnedUsage(): SpawnedUsageTotals {
		return this._analytics.getSpawnedUsage();
	}

	getDailyUsageTotals(now = new Date()): DailyUsageTotals {
		return this._analytics.getDailyUsageTotals(now);
	}

	getDailyUsageBreakdown(formatLabel?: (label: string) => string, now = new Date()): string {
		return this._analytics.getDailyUsageBreakdown(formatLabel, now);
	}

	/**
	 * Save a snapshot of the goal state to the session log.
	 *
	 * @returns the id of the appended custom entry
	 */
	saveGoalStateSnapshot(state: GoalState): string {
		return appendGoalStateSnapshot(this.sessionManager, state);
	}

	/**
	 * Retrieve the latest valid goal state snapshot from the session log.
	 */
	getGoalStateSnapshot(): GoalState | undefined {
		return getLatestGoalStateSnapshot(this.sessionManager.getEntries());
	}

	/**
	 * Save a snapshot of the evidence bundle to the session log.
	 *
	 * @returns the id of the appended custom entry
	 */
	saveEvidenceBundleSnapshot(bundle: EvidenceBundle): string {
		return appendEvidenceBundleSnapshot(this.sessionManager, bundle);
	}

	/**
	 * Retrieve the latest valid evidence bundle snapshot from the session log.
	 */
	getEvidenceBundleSnapshot(): EvidenceBundle | undefined {
		return getLatestEvidenceBundleSnapshot(this.sessionManager.getEntries());
	}

	getEvidenceBundleSnapshots(): EvidenceBundle[] {
		return getEvidenceBundleSnapshots(this.sessionManager.getEntries());
	}

	/** Live lane records tracked by this process (running and terminal). */
	getLaneRecords(): LaneRecord[] {
		return this._backgroundLanes.getLaneRecords();
	}

	// G3/G8 autonomy telemetry + gate-outcome history live in AutonomyTelemetry (see
	// autonomy-telemetry.ts). These stubs keep the god file's internal call surface stable while the
	// sink logic and the owned gate-outcome fields live there.
	private _emitAutonomyTelemetry(event: AutonomyTelemetryEvent): void {
		this._autonomyTelemetry.emitTelemetry(event);
	}

	private _recordGateOutcome(outcome: GateOutcome): void {
		this._autonomyTelemetry.recordGateOutcome(outcome);
	}

	/** G8: copies of the bounded gate-outcome history, oldest first, latest last. */
	getGateOutcomeHistory(): GateOutcomeHistoryEntry[] {
		return this._autonomyTelemetry.getGateOutcomeHistory();
	}

	saveWorkerResultSnapshot(result: WorkerResult, request?: WorkerRequest): string {
		return appendWorkerResultSnapshot(this.sessionManager, result, request);
	}

	getWorkerResultSnapshots(): WorkerResult[] {
		return getWorkerResultSnapshots(this.sessionManager.getEntries());
	}

	saveLearningDecisionSnapshot(decision: LearningDecision): string {
		return appendLearningDecisionSnapshot(this.sessionManager, decision);
	}

	getLearningDecisionSnapshots(): LearningDecision[] {
		return getLearningDecisionSnapshots(this.sessionManager.getEntries());
	}

	getGoalRuntimeSnapshot(settings: GoalRuntimeSnapshotSettings): GoalRuntimeSnapshot {
		return buildGoalRuntimeSnapshot({
			entries: this.sessionManager.getEntries(),
			settings,
		});
	}

	/**
	 * Capability profile derived from the CURRENT session model's own metadata (context window),
	 * honoring the modelCapability.mode setting ("off" disables, a class name forces).
	 */
	getModelCapabilityProfile(): ModelCapabilityProfile {
		return deriveModelCapabilityProfile({
			contextWindow: this.model?.contextWindow,
			mode: this.settingsManager.getModelCapabilitySettings().mode,
		});
	}

	/**
	 * Run one bounded, read-only research pass and persist its results. Delegates to
	 * {@link BackgroundLaneController}; see there for the full gating/budget/dedupe contract.
	 */
	async runResearchLaneOnce(request?: {
		query?: string;
		context?: string;
		goalId?: string;
	}): Promise<ResearchLaneRunOutcome> {
		return this._backgroundLanes.runResearchLaneOnce(request);
	}

	/**
	 * Run one bounded scout-worker delegation. Delegates to {@link BackgroundLaneController};
	 * consumed by the `delegate` tool.
	 */
	async runWorkerDelegationOnce(request: {
		instructions: string;
		systemPrompt?: string;
	}): Promise<WorkerDelegationRunOutcome> {
		return this._backgroundLanes.runWorkerDelegationOnce(request);
	}

	/**
	 * Probe a candidate model against the subagent contracts. Delegates to
	 * {@link BackgroundLaneController}; probe spend is reported through spawned-usage accounting.
	 */
	async runModelFitness(args: {
		model: string;
		trials?: number;
	}): Promise<{ started: true; model: string; report: ModelFitnessReport } | { started: false; skipReason: string }> {
		return this._backgroundLanes.runModelFitness(args);
	}

	/** Fitness reports persisted for THIS host (measured evidence for architect/profile decisions). */
	getStoredFitnessReports(): StoredFitnessReport[] {
		return this._backgroundLanes.getStoredFitnessReports();
	}

	async continueGoalOnce(options: GoalContinuationOnceOptions): Promise<GoalContinuationOnceResult> {
		return this._goalContinuation.continueGoalOnce(options);
	}

	async continueGoalLoop(options: GoalContinuationLoopOptions): Promise<GoalContinuationLoopResult> {
		return this._goalContinuation.continueGoalLoop(options);
	}

	/**
	 * Run a one-shot LLM completion fully ISOLATED from the main session — the load-bearing primitive
	 * for native reflection (see reflection-controller.ts for the isolation invariants).
	 */
	async runIsolatedCompletion(opts: IsolatedCompletionOptions): Promise<IsolatedCompletionResult> {
		return this._reflection.runIsolatedCompletion(opts);
	}

	/**
	 * Native end-of-loop reflection pass (R2). Delegates to {@link ReflectionController}; returns null
	 * when the demand gate skips or in a child session.
	 */
	async runReflectionPass(input: {
		signals: DemandSignals;
		recentTurnText: string;
		model?: Model<any>;
		thinkingLevel?: ThinkingLevel;
		signal?: AbortSignal;
		/** Stable id so a duplicate scheduling/retry of the same pass can't double-count its cost. */
		reportId?: string;
	}): Promise<ReflectionResult | null> {
		return this._reflection.runReflectionPass(input);
	}

	getLearningAuditRecords(): LearningAuditRecord[] {
		return this._reflection.getLearningAuditRecords();
	}

	/** Roll back one applied durable learning change. Delegates to {@link ReflectionController}. */
	async rollbackLearningWrite(auditId: string): Promise<{ ok: boolean; reason: string }> {
		return this._reflection.rollbackLearningWrite(auditId);
	}

	getContextUsage(): ContextUsage | undefined {
		return this._analytics.getContextUsage();
	}

	async exportToHtml(outputPath?: string): Promise<string> {
		return this._analytics.exportToHtml(outputPath);
	}

	exportToJsonl(outputPath?: string): string {
		return this._analytics.exportToJsonl(outputPath);
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	getLastAssistantText(): string | undefined {
		return this._analytics.getLastAssistantText();
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	public getAutonomyStatusSnapshot(): AutonomyStatusSnapshot {
		return this._autonomyTelemetry.getStatusSnapshot();
	}

	/**
	 * Aggregate an effectiveness/autonomy dashboard: what Pi has actually been doing (recent
	 * route choices, latest gate outcome, cost, and any research/delegation/learning/goal
	 * activity). Read-only — combines existing session-log getters, never mutates state or
	 * recomputes a route/gate decision.
	 */
	public getAutonomyDiagnosticSnapshot(options?: { maxEntriesPerFamily?: number }): AutonomyDiagnosticSnapshot {
		return this._autonomyTelemetry.getDiagnosticSnapshot(options);
	}

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}
