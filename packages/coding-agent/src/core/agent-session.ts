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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { totalmem } from "node:os";
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
	type BashExecutionMessage,
	type CustomMessage,
	classifyFailure,
	compactToolResultDetailsForRetention,
	createCustomMessage,
	DEFAULT_RETRY_POLICY,
	DEFAULT_STREAM_IDLE,
	RetryController,
	withStreamIdleWatchdog,
} from "@caupulican/pi-agent-core";
import {
	type BranchSummaryEntry,
	type CompactionEntry,
	type CompactionResult,
	type CompactionSettings,
	CURRENT_SESSION_VERSION,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	estimateContextTokens,
	generateBranchSummary,
	getLatestCompactionEntry,
	prepareCompaction,
	type SessionHeader,
	type SessionManager,
	shouldCompact,
} from "@caupulican/pi-agent-core/node";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	StopReason,
	TextContent,
	Usage,
} from "@caupulican/pi-ai";
import {
	clampThinkingLevel,
	cleanupSessionResources,
	getSupportedThinkingLevels,
	isContextOverflow,
	modelsAreEqual,
	resetApiProviders,
	streamSimple,
} from "@caupulican/pi-ai";
import { getAgentDir, getSessionsDir } from "../config.ts";
import { theme } from "../modes/interactive/theme/theme.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { resolvePath } from "../utils/paths.ts";
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
import { evaluateToolGate } from "./autonomy/gates.ts";
import type { LaneRecord } from "./autonomy/lane-tracker.ts";
import type { AutonomyDiagnosticSnapshot, AutonomyStatusSnapshot, GateOutcomeHistoryEntry } from "./autonomy/status.ts";
import { AUTONOMY_TELEMETRY_EVENT_TYPES, type AutonomyTelemetryEvent } from "./autonomy/telemetry-events.ts";
import { AutonomyTelemetry } from "./autonomy-telemetry.ts";
import { BackgroundLaneController } from "./background-lane-controller.ts";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
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
import {
	aggregateDailyUsageFromSessionFiles,
	aggregateDailyUsageFromSessionRoot,
	type DailyUsageTotals,
	formatDailyUsageBreakdown,
	getLocalDayWindow,
} from "./cost/daily-usage.ts";
import { type CostGuardDecision, downgradeReasoning, estimateTurnCostUsd, evaluateCostGuard } from "./cost-guard.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import { appendWorkerResultSnapshot, getWorkerResultSnapshots } from "./delegation/session-worker-result.ts";
import type { WorkerRunOutcome } from "./delegation/worker-runner.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import { createCoreDiagnosticsToolDefinitions } from "./extensions/builtin.ts";
import {
	type ContextUsage,
	type Extension,
	type ExtensionCommandContextActions,
	type ExtensionContext,
	type ExtensionErrorListener,
	ExtensionRunner,
	type ExtensionUIContext,
	type InputSource,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type ReplacedSessionContext,
	type SessionBeforeCompactResult,
	type SessionBeforeTreeResult,
	type SessionStartEvent,
	type ShutdownHandler,
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolInfo,
	type TreePreparation,
	type TurnEndEvent,
	type TurnStartEvent,
	wrapRegisteredTools,
} from "./extensions/index.ts";
import { disposeExtensionEventSubscriptions } from "./extensions/loader.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import { type ChannelProvider, GatewayRegistry, type JobSchedulerProvider } from "./gateways/channel-provider.ts";
import {
	buildGoalContinuationPrompt,
	type GoalContinuationPrompt,
	type GoalContinuationPromptLimits,
} from "./goals/goal-continuation-prompt.ts";
import {
	buildGoalRuntimeSnapshot,
	type GoalRuntimeSnapshot,
	type GoalRuntimeSnapshotSettings,
} from "./goals/goal-runtime-snapshot.ts";
import type { GoalState } from "./goals/goal-state.ts";
import { appendGoalStateSnapshot, getLatestGoalStateSnapshot } from "./goals/session-goal-state.ts";
import {
	APPLY_WRITE_REFUSED_REASON_CODE,
	appendLearningAuditSnapshot,
	contradictionsForReflectionWrite,
	getLearningAuditSnapshots,
	type LearningAuditRecord,
	proposalFromReflectionWrite,
	rollbackPlanForReflectionWrite,
} from "./learning/learning-audit.ts";
import { evaluateLearningDecision } from "./learning/learning-gate.ts";
import { ObservationStore, observationKey } from "./learning/observation-store.ts";
import {
	type DemandSignals,
	decideDemand,
	ReflectionEngine,
	type ReflectionResult,
	type ReflectionWrite,
} from "./learning/reflection-engine.ts";
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
import { resolveCliModel, resolveProfileModelSettings } from "./model-resolver.ts";
import { formatModelRouterModel, ModelRouterController } from "./model-router-controller.ts";
import { FitnessStore, type StoredFitnessReport } from "./models/fitness-store.ts";
import { OLLAMA_PROVIDER } from "./models/local-registration.ts";
import type { LocalRuntimeDeps, OllamaRuntime } from "./models/local-runtime.ts";
import { matchesInstalledLocalModel } from "./models/model-ref.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import { isProbeAllFailed, type ModelFitnessReport } from "./research/model-fitness.ts";
import type { ResearchRunResult } from "./research/research-runner.ts";
import {
	appendEvidenceBundleSnapshot,
	getEvidenceBundleSnapshots,
	getLatestEvidenceBundleSnapshot,
} from "./research/session-evidence-bundle.ts";
import { collectWorkspaceSources } from "./research/workspace-collector.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import { stripResourceProfileBlocks } from "./resource-profile-blocks.ts";
import { classifyToolTrust, wrapUntrustedText } from "./security/untrusted-boundary.ts";
import {
	matchesResourceProfilePattern,
	type ResourceProfileFilterSettings,
	type SettingsManager,
} from "./settings-manager.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import { SystemPromptBuilder } from "./system-prompt-builder.ts";
import {
	buildReflexUserPrompt,
	parseReflexPlan,
	REFLEX_INTERPRETER_SYSTEM_PROMPT,
} from "./toolkit/reflex-interpreter.ts";
import { executeToolkitScript } from "./toolkit/script-runner.ts";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.ts";
import { createDelegateToolDefinition } from "./tools/delegate.ts";
import { createGoalToolDefinition } from "./tools/goal.ts";
import { createAllToolDefinitions } from "./tools/index.ts";
import { createModelFitnessToolDefinition } from "./tools/model-fitness.ts";
import { createRunToolkitScriptToolDefinition } from "./tools/run-toolkit-script.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";

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

/** Test-only override of the stream-idle bounds. Read once per session, at construction. */
let streamIdleOptionsOverride: Partial<StreamIdleOptions> | undefined;

/**
 * Test hook: override the stream-idle bounds so a stall can be provoked in-suite without a
 * 30s wait. Pass `undefined` to restore the user-locked default (30s idle / 120s connect).
 * Must be set BEFORE the session is constructed — the wiring reads it in the constructor.
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

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

interface ReloadRuntimeSnapshot {
	extensionRunner: ExtensionRunner;
	baseToolDefinitions: Map<string, ToolDefinition>;
	toolRegistry: Map<string, AgentTool>;
	toolDefinitions: Map<string, ToolDefinitionEntry>;
	toolPromptSnippets: Map<string, string>;
	toolPromptGuidelines: Map<string, string[]>;
	agentTools: AgentTool[];
	agentSystemPrompt: string;
	baseSystemPrompt: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Standard thinking levels */
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

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
	private _inertExtensionWarnings: string[] = [];
	/** Extensions the active resource profile removed from the runtime set (surfaced in /context). */
	private _profileDeniedExtensionCount = 0;
	private _unboundToolGrantWarnings: string[] = [];

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// Auto-retry driver — owns the attempt counter and abortable backoff (reliability kernel).
	private _retryController!: RetryController;

	// Bash execution state
	private _bashAbortController: AbortController | undefined = undefined;
	private _pendingBashMessages: BashExecutionMessage[] = [];

	// Extension system
	private _extensionRunner!: ExtensionRunner;
	private _turnIndex = 0;
	/** G7: per-turn foreground CapabilityEnvelope auto-built for visibility (observe-only; not enforced). */
	private _currentForegroundEnvelope?: CapabilityEnvelope;

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
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
	private _spawnedUsageCache?: { entryCount: number; totals: SpawnedUsageTotals };
	private _dailyUsageCache?: { sessionDir: string; expiresAt: number; totals: DailyUsageTotals };
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

	// Tool registry for extension getTools/setTools
	private _toolRegistry: Map<string, AgentTool> = new Map();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

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
		this.agent.streamFn = tagRawness(
			withStreamIdleWatchdog(baseStreamFn, streamIdleOptionsOverride ?? DEFAULT_STREAM_IDLE),
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
			hasTool: (name) => this._toolRegistry.has(name),
			getToolPromptSnippet: (name) => this._toolPromptSnippets.get(name),
			getToolPromptGuidelines: (name) => this._toolPromptGuidelines.get(name),
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

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installAgentContextTransform();
		this._installAgentTurnRefresh();

		this._buildRuntime({
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

	private async _getCompactionRequestAuth(model: Model<any>): Promise<{
		apiKey?: string;
		headers?: Record<string, string>;
	}> {
		if (this._isRawStreamSimple(this.agent.streamFn)) {
			return this._getRequiredRequestAuth(model);
		}

		const result = await this._modelRegistry.getApiKeyAndHeaders(model);
		return result.ok ? { apiKey: result.apiKey, headers: result.headers } : {};
	}

	/**
	 * Resolve the model used to SUMMARIZE during compaction (cost guard, #30). A compaction summary is an
	 * extraction task — it does not need the main (expensive) model. Selection:
	 *   - an explicit `compaction.model` setting wins, but only if its provider is authed (else fall back);
	 *   - `"auto"` (default) picks the CHEAPEST authed model whose context window can hold a compaction
	 *     (capability floor), and ONLY if it is strictly cheaper than the session model — so we never
	 *     downgrade to an equally-priced but weaker summarizer (agy's floor: don't degrade the checkpoint);
	 *   - otherwise the session model is used (safe default).
	 */
	private _resolveCompactionModel(sessionModel: Model<any>): Model<any> {
		const setting = this.settingsManager.getCompactionModel();
		if (setting && setting !== "auto") {
			const resolved = resolveCliModel({ cliModel: setting, modelRegistry: this._modelRegistry });
			if (resolved.model && this._modelRegistry.hasConfiguredAuth(resolved.model)) return resolved.model;
			return sessionModel; // configured but unusable → don't break compaction
		}
		// "auto": cheapest authed model that can summarize a large context AND is cheaper than the session
		// model. The context-window floor keeps a tiny local model from being picked for a big summary.
		const FLOOR_CONTEXT = 64_000;
		const sessionInputCost = sessionModel.cost?.input ?? Number.POSITIVE_INFINITY;
		let best: Model<any> | undefined;
		for (const m of this._modelRegistry.getAvailable()) {
			if ((m.contextWindow ?? 0) < FLOOR_CONTEXT) continue;
			const cost = m.cost?.input ?? Number.POSITIVE_INFINITY;
			if (cost >= sessionInputCost) continue; // only ever pick something cheaper than the session model
			if (!best || cost < (best.cost?.input ?? Number.POSITIVE_INFINITY)) best = m;
		}
		return best ?? sessionModel;
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
				...this._profileDeniedResourceObservations(),
				...this._inertExtensionWarnings,
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
		this.agent.beforeToolCall = async ({ toolCall, args }) => {
			const escalation = this._modelRouter.maybeEscalateToolCall(toolCall.name, args);
			if (escalation) {
				return escalation;
			}

			// Autonomy tool gating
			const gateResult = evaluateToolGate({
				toolName: toolCall.name,
				args,
				cwd: this._cwd,
				envelope: this.capabilityEnvelope,
			});

			if (this.capabilityEnvelope) {
				this._recordGateOutcome(gateResult);
			}

			if (gateResult.outcome === "block" || gateResult.outcome === "ask-user") {
				return {
					block: true,
					reason: `Tool execution blocked by autonomy gate [${gateResult.gate}]: ${gateResult.message} (${gateResult.reasonCode})`,
				};
			}

			const runner = this._extensionRunner;
			if (!runner.hasHandlers("tool_call")) {
				return undefined;
			}

			try {
				return await runner.emitToolCall({
					type: "tool_call",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args as Record<string, unknown>,
				});
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Extension failed, blocking execution: ${String(err)}`);
			}
		};

		this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
			const runner = this._extensionRunner;
			let content = result.content;
			let details = result.details;
			let resolvedIsError = isError;

			if (runner.hasHandlers("tool_result")) {
				const hookResult = await runner.emitToolResult({
					type: "tool_result",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args as Record<string, unknown>,
					content,
					details,
					isError,
				});
				if (hookResult) {
					content = hookResult.content ?? content;
					details = hookResult.details;
					resolvedIsError = hookResult.isError ?? isError;
				}
			}

			// Untrusted-content boundary: structurally fence output from attacker-controllable sources
			// (web/search, subagents, recall, third-party tools) so injection payloads are framed as data.
			// First-party tools (read/grep/find/ls/edit/write/bash) are trusted and pass through unchanged.
			if (classifyToolTrust(toolCall.name) === "untrusted") {
				const source = `tool:${toolCall.name}`;
				const wrapped = content.map((block) =>
					block.type === "text" ? { ...block, text: wrapUntrustedText(block.text, source) } : block,
				);
				content = wrapped;
			}

			if (content === result.content && details === result.details && resolvedIsError === isError) {
				return undefined;
			}
			return { content, details, isError: resolvedIsError };
		};
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
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			promptGuidelines: definition.promptGuidelines,
			sourceInfo,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
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
			const tool = this._toolRegistry.get(name);
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

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		await this._extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	/**
	 * Set model directly.
	 * Validates that auth is configured, saves to session and settings.
	 * @throws Error if no auth is configured for the model
	 */
	async setModel(model: Model<any>, options: { persistSettings?: boolean } = {}): Promise<void> {
		if (!this._modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const persistSettings = options.persistSettings ?? true;
		const previousModel = this.model;
		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		this.agent.state.model = model;
		this.sessionManager.appendModelChange(model.provider, model.id);
		if (persistSettings) {
			this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
		}

		// Re-clamp thinking level for new model's capabilities
		this.setThinkingLevel(thinkingLevel, { persistSettings });

		await this._emitModelSelect(model, previousModel, "set");
		this._checkContextWindowUsageWarning();
		await this._warnIfManualModelChoiceIsRisky(model);

		// Re-derive the model-capability tool surface for the new model (restores the full requested
		// set when moving small -> large, reduces it when moving large -> small).
		if (this._requestedActiveToolNames) {
			const before = this.getActiveToolNames().join(",");
			this.setActiveToolsByName(this._requestedActiveToolNames);
			const capability = this.getModelCapabilityProfile();
			if (capability.class !== "full" && this.getActiveToolNames().join(",") !== before) {
				this._emit({
					type: "warning",
					message: `Small-context model detected (${capability.contextWindow ?? "unknown"} tokens, class '${capability.class}'): active tools reduced to [${this.getActiveToolNames().join(", ")}]; background lanes ${capability.backgroundLanesEnabled ? "enabled" : "disabled"}.`,
				});
			}
		}
	}

	/**
	 * Manual model choice is a deliberate human decision, not an auto-adoption flow — it is
	 * ADVISORY ONLY: warn on evidence the model is a bad fit, but never block and never prompt
	 * (print/RPC modes only ever see plain warning text through the existing `warning` event, the
	 * same channel `_checkContextWindowUsageWarning` above uses). Two independent checks, both
	 * best-effort:
	 *  - a recorded all-lanes-failed fitness probe on THIS host (see `isProbeAllFailed`);
	 *  - for an Ollama-served local model, weights that exceed ~90% of total system memory, which
	 *    is the exact failure the OOM report reproduced (llama-server needs the whole model resident).
	 */
	private async _warnIfManualModelChoiceIsRisky(model: Model<Api>): Promise<void> {
		const canonicalRef = `${model.provider}/${model.id}`;
		try {
			const fitness = FitnessStore.forAgentDir(this._agentDir)
				.getForHost()
				.find((entry) => entry.model === canonicalRef);
			if (fitness && isProbeAllFailed(fitness.report)) {
				this._emit({
					type: "warning",
					message: `${canonicalRef} failed its fitness probe on all surfaces on this host (probed ${fitness.at}) — it is likely to fail in production too. Proceeding because you set it manually.`,
				});
			}
		} catch {
			// advisory only; a lookup failure must never block a manual model choice
		}

		if (model.provider !== OLLAMA_PROVIDER) return;
		try {
			const serverUrl = this._deriveOllamaServerUrl(model.baseUrl);
			const installed = await this.getLocalRuntime(serverUrl).list();
			const entry = installed.find((candidate) => matchesInstalledLocalModel(model.id, candidate.name));
			if (!entry) return;
			const memoryBudget = totalmem() * 0.9;
			if (entry.sizeBytes > memoryBudget) {
				const sizeGb = (entry.sizeBytes / 1e9).toFixed(1);
				const totalGb = (totalmem() / 1e9).toFixed(1);
				this._emit({
					type: "warning",
					message: `${canonicalRef} is ~${sizeGb}GB, over 90% of this machine's ${totalGb}GB RAM — llama-server is likely to OOM when it runs. Proceeding because you set it manually.`,
				});
			}
		} catch {
			// advisory only; an unreachable local server must never block a manual model choice
		}
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction);
		}
		return this._cycleAvailableModel(direction);
	}

	private async _cycleScopedModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const scopedModels = this._scopedModels.filter((scoped) => this._modelRegistry.hasConfiguredAuth(scoped.model));
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.thinkingLevel);

		// Apply model
		this.agent.state.model = next.model;
		this.sessionManager.appendModelChange(next.model.provider, next.model.id);
		this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);

		// Apply thinking level.
		// - Explicit scoped model thinking level overrides current session level
		// - Undefined scoped model thinking level inherits the current session preference
		// setThinkingLevel clamps to model capabilities.
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(next.model, currentModel, "cycle");

		this._checkContextWindowUsageWarning();
		await this._warnIfManualModelChoiceIsRisky(next.model);

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	private async _cycleAvailableModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const availableModels = await this._modelRegistry.getAvailable();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		this.agent.state.model = nextModel;
		this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);

		// Re-clamp thinking level for new model's capabilities
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(nextModel, currentModel, "cycle");

		this._checkContextWindowUsageWarning();
		await this._warnIfManualModelChoiceIsRisky(nextModel);

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Saves to session and settings only if the level actually changes.
	 */
	setThinkingLevel(level: ThinkingLevel, options: { persistSettings?: boolean } = {}): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		// Only persist if actually changing
		const previousLevel = this.agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;
		const persistSettings = options.persistSettings ?? true;

		this.agent.state.thinkingLevel = effectiveLevel;

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			if (persistSettings && (this.supportsThinking() || effectiveLevel !== "off")) {
				this.settingsManager.setDefaultThinkingLevel(effectiveLevel);
			}
			this._emit({ type: "thinking_level_changed", level: effectiveLevel });
			void this._extensionRunner.emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
		}
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.model) return THINKING_LEVELS;
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	/**
	 * Check if current model supports thinking/reasoning.
	 */
	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	private _getThinkingLevelForModelSwitch(explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		if (!this.supportsThinking()) {
			return this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
		}
		return this.thinkingLevel;
	}

	private _clampThinkingLevel(level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
		return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
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
				const result = await compact(
					preparation,
					compactionModel,
					apiKey,
					headers,
					customInstructions,
					this._compactionAbortController.signal,
					this.thinkingLevel,
					this.agent.streamFn,
					this._buildCompactionPreDigest(),
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
		const settings = this.settingsManager.getCompactionSettings();
		if (!this.model) return settings;
		const contextWindow = this.model.contextWindow ?? 0;
		if (contextWindow <= 0) return settings;

		// Adapt reserveTokens: at most 25% of context window
		const maxReserve = Math.floor(contextWindow * 0.25);
		const reserveTokens = Math.min(settings.reserveTokens, maxReserve);

		// Adapt keepRecentTokens: at most 50% of context window
		const maxKeepRecent = Math.floor(contextWindow * 0.5);
		const keepRecentTokens = Math.min(settings.keepRecentTokens, maxKeepRecent);

		return {
			...settings,
			reserveTokens,
			keepRecentTokens,
		};
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

		this._emit({ type: "compaction_start", reason });
		this._autoCompactionAbortController = new AbortController();

		try {
			if (!this.model) {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: false,
					willRetry: false,
				});
				return false;
			}

			// Summarize with the cheap auxiliary model when available (cost guard, #30).
			const compactionModel = this._resolveCompactionModel(this.model);
			let apiKey: string | undefined;
			let headers: Record<string, string> | undefined;
			if (this._isRawStreamSimple(this.agent.streamFn)) {
				const authResult = await this._modelRegistry.getApiKeyAndHeaders(compactionModel);
				if (!authResult.ok || !authResult.apiKey) {
					this._emit({
						type: "compaction_end",
						reason,
						result: undefined,
						aborted: false,
						willRetry: false,
					});
					return false;
				}
				apiKey = authResult.apiKey;
				headers = authResult.headers;
			} else {
				({ apiKey, headers } = await this._getCompactionRequestAuth(compactionModel));
			}

			const pathEntries = this.sessionManager.getBranch();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: false,
					willRetry: false,
				});
				return false;
			}

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const extensionResult = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					signal: this._autoCompactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (extensionResult?.cancel) {
					this._emit({
						type: "compaction_end",
						reason,
						result: undefined,
						aborted: true,
						willRetry: false,
					});
					return false;
				}

				if (extensionResult?.compaction) {
					extensionCompaction = extensionResult.compaction;
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
				const compactResult = await compact(
					preparation,
					compactionModel,
					apiKey,
					headers,
					undefined,
					this._autoCompactionAbortController.signal,
					this.thinkingLevel,
					this.agent.streamFn,
					this._buildCompactionPreDigest(),
				);
				summary = compactResult.summary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				details = compactResult.details;
			}

			if (this._autoCompactionAbortController.signal.aborted) {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return false;
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

			const result: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				details,
			};
			this._emit({ type: "compaction_end", reason, result, aborted: false, willRetry });

			if (willRetry) {
				const messages = this.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				if (lastMsg?.role === "assistant" && (lastMsg as AssistantMessage).stopReason === "error") {
					this.agent.state.messages = messages.slice(0, -1);
				}
				return true;
			}

			// Auto-compaction can complete while follow-up/steering/custom messages are waiting.
			// Continue once so queued messages are delivered.
			return this.agent.hasQueuedMessages();
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

	/**
	 * Resolve the active resource-profile tool allow/block filter from current settings.
	 * Mirrors the construction-time derivation (settingsManager.getResourceProfileFilter("tools"))
	 * so reload() can re-apply it after a live settings/profile edit.
	 */
	private _deriveToolProfileFilter(): Required<ResourceProfileFilterSettings> {
		const filter = this.settingsManager.getResourceProfileFilter("tools");
		return { allow: filter.allow ?? [], block: filter.block ?? [] };
	}

	private _isToolOrCommandAllowedByProfile(name: string): boolean {
		if (this._allowedToolNames && !this._allowedToolNames.has(name)) return false;
		if (this._excludedToolNames?.has(name)) return false;
		const filter = this._toolProfileFilter;
		if (!filter) return true;
		if (filter.allow.length > 0 && !matchesResourceProfilePattern(name, filter.allow)) return false;
		if (matchesResourceProfilePattern(name, filter.block)) return false;
		return true;
	}

	private _hasToolOrCommandProfileGate(): boolean {
		return Boolean(
			this._allowedToolNames ||
				this._excludedToolNames ||
				(this._toolProfileFilter &&
					(this._toolProfileFilter.allow.length > 0 || this._toolProfileFilter.block.length > 0)),
		);
	}

	private _filterExtensionsForRuntime(extensions: Extension[]): Extension[] {
		this._inertExtensionWarnings = [];
		this._profileDeniedExtensionCount = 0;
		if (this.settingsManager.getActiveResourceProfileNames().length === 0) {
			if (this.settingsManager.hasExplicitActiveResourceProfileSelection()) {
				// An explicit profile selection that resolves to no active profile is a deliberate
				// deny-all — every extension is withheld by that choice.
				this._profileDeniedExtensionCount = extensions.length;
				return [];
			}
			// No profile in play: only inline/SDK extensions load by default. That is the baseline, not
			// a profile denial, so it is not counted as withheld.
			return extensions.filter((extension) => extension.sourceInfo.source === "inline");
		}
		const hasToolOrCommandGate = this._hasToolOrCommandProfileGate();
		const allowedExtensions = extensions.filter((extension) =>
			this.settingsManager.isResourceAllowedByProfile("extensions", extension.path, extension.sourceInfo.baseDir),
		);
		this._profileDeniedExtensionCount = extensions.length - allowedExtensions.length;
		return allowedExtensions.map((extension) => {
			if (!hasToolOrCommandGate) return extension;
			const tools = new Map(
				Array.from(extension.tools.entries()).filter(([name]) => this._isToolOrCommandAllowedByProfile(name)),
			);
			const commands = new Map(
				Array.from(extension.commands.entries()).filter(([name]) => this._isToolOrCommandAllowedByProfile(name)),
			);
			// G12: an extension the profile ALLOWS whose every tool and command the tools filter
			// then denies loads and runs lifecycle hooks but is completely uninvocable — surface
			// it instead of presenting a "loaded" extension that silently does nothing.
			if (extension.tools.size + extension.commands.size > 0 && tools.size + commands.size === 0) {
				const name = extension.path.split(/[\\/]/).pop() ?? extension.path;
				this._inertExtensionWarnings.push(
					`extension "${name}" is loaded but fully inert: the active profile's tools filter denies all ${extension.tools.size} tool(s) and ${extension.commands.size} command(s) it contributes`,
				);
			}
			return { ...extension, tools, commands };
		});
	}

	/**
	 * /context observations for skills/prompts/extensions the active resource profile removed from
	 * listings — the analog of the withheld-AGENTS.md warning. Strict UAC makes these silently absent,
	 * so a lean profile's effect on the resource surface stays visible. Counts are profile-scoped
	 * (skills/prompts via the profile-independent discovery universe filtered by the live profile
	 * filter; extensions via the runtime filter's denied tally). Empty when nothing is withheld.
	 *
	 * Uses `isResourceDeniedByActiveProfile` (profile-only), not `isResourceAllowedByProfile` (which
	 * also folds in the user's own legacy `disabledResources` list): a plain user-disabled resource
	 * must never be misattributed to "the active resource profile" — that case is already surfaced by
	 * the G14 disable-wins warning. With no active profile at all, the helper always reports nothing
	 * denied, so this naturally stays silent (extensions keep their own runtime-filter-derived count,
	 * which is already correctly zero absent a profile).
	 */
	private _profileDeniedResourceObservations(): string[] {
		const observations: string[] = [];
		const withheld = (kind: "skills" | "prompts", paths: string[]): number =>
			paths.filter((path) => this.settingsManager.isResourceDeniedByActiveProfile(kind, path, this._cwd)).length;

		const skillsWithheld = withheld("skills", this._resourceLoader.getDiscoverableSkillPaths());
		if (skillsWithheld > 0) {
			observations.push(
				`${skillsWithheld} skill(s) withheld by the active resource profile — grant the "skills" kind to restore them`,
			);
		}
		const promptsWithheld = withheld("prompts", this._resourceLoader.getDiscoverablePromptPaths());
		if (promptsWithheld > 0) {
			observations.push(
				`${promptsWithheld} prompt(s) withheld by the active resource profile — grant the "prompts" kind to restore them`,
			);
		}
		if (this._profileDeniedExtensionCount > 0) {
			observations.push(
				`${this._profileDeniedExtensionCount} extension(s) withheld by the active resource profile — grant the "extensions" kind to restore them`,
			);
		}
		return observations;
	}

	/**
	 * Re-resolve the active resource profile's model/thinking from current settings and apply it.
	 * Only acts when the profile actually binds model/thinking AND that field was not set by an
	 * explicit launch flag — so live profile edits apply on reload without clobbering an explicit
	 * --model/--thinking. A no-op for profiles that don't bind a model.
	 */
	private async _reapplyActiveProfileModelSettings(): Promise<void> {
		if (this._isExplicitModel && this._isExplicitThinking) return;
		const activeProfileNames = this.settingsManager.getActiveResourceProfileNames();
		if (activeProfileNames.length === 0) return;
		const profileSettings = resolveProfileModelSettings({
			activeProfileNames,
			registry: this.settingsManager.getProfileRegistry(),
			modelRegistry: this._modelRegistry,
			cwd: this._cwd,
		});
		if (!this._isExplicitModel && profileSettings.model) {
			const current = this.agent.state.model;
			const next = profileSettings.model;
			if (!current || current.provider !== next.provider || current.id !== next.id) {
				// Mirror the startup/cycle path: set the model directly (no auth gate, no settings
				// persist) so re-applying the profile model behaves like initial resolution rather
				// than a runtime model switch. No model_select emit here — reload rebuilds the
				// extension runtime and emits session_start("reload") right after, and the UI
				// re-renders from session.model.
				this.agent.state.model = next;
				this.sessionManager.appendModelChange(next.provider, next.id);
			}
		}
		if (!this._isExplicitThinking && profileSettings.thinkingLevel) {
			this.setThinkingLevel(profileSettings.thinkingLevel);
		}
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
		const previousRegistryNames = new Set(this._toolRegistry.keys());
		// Re-derive from the pre-filter REQUEST, never from agent.state.tools: the active set is
		// capability/profile-filtered, so feeding it back through setActiveToolsByName would
		// permanently shrink what a later switch to a larger model (or permissive profile) restores.
		const previousActiveToolNames = this._requestedActiveToolNames ?? this.getActiveToolNames();
		const allowedToolNames = this._allowedToolNames;
		const excludedToolNames = this._excludedToolNames;
		const toolProfileFilter = this._toolProfileFilter;
		const isAllowedTool = (name: string): boolean => {
			if (allowedToolNames && !allowedToolNames.has(name)) return false;
			if (excludedToolNames?.has(name)) return false;
			if (!toolProfileFilter) return true;
			if (toolProfileFilter.allow.length > 0 && !matchesResourceProfilePattern(name, toolProfileFilter.allow)) {
				return false;
			}
			if (matchesResourceProfilePattern(name, toolProfileFilter.block)) return false;
			return true;
		};

		const registeredTools = this._extensionRunner.getAllRegisteredTools();
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
			// Memory subsystem provider tools (e.g. file-store's `memory` tool).
			...this._memory
				.getMemoryManager()
				.getToolDefinitions()
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`<memory:${definition.name}>`, { source: "sdk" }),
				})),
		].filter((tool) => isAllowedTool(tool.definition.name));
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([name]) => isAllowedTool(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
					},
				]),
		);
		for (const tool of allCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		this._toolDefinitions = definitionRegistry;
		this._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = this._normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const runner = this._extensionRunner;
		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values())
				.filter((definition) => isAllowedTool(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }),
				})),
			runner,
		);

		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		this._toolRegistry = toolRegistry;

		const requestedBase = options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames];
		const nextActiveToolNames = requestedBase.filter((name) => isAllowedTool(name));

		const autoActivated: string[] = [];
		if (allowedToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (allowedToolNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
					autoActivated.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				nextActiveToolNames.push(tool.name);
				autoActivated.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousRegistryNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
					autoActivated.push(toolName);
				}
			}
		}

		// Strict UAC: the active profile is the COMPLETE grant, so a tool the profile names
		// explicitly is itself a request for that tool — it must ACTIVATE from the registry even
		// if the session never requested it. Without this, activation is only ever the requested
		// defaults ∩ allow-list, and a profile granting non-default tools (a search-only profile's
		// grep/find) yields an empty or truncated tool set on load and /reload. A blanket "*"
		// stays grant-only: activation then still derives from the request/defaults above.
		const explicitAllowPatterns = toolProfileFilter?.allow.filter((pattern) => pattern !== "*") ?? [];
		if (explicitAllowPatterns.length > 0) {
			const boundPatterns = new Set<string>();
			for (const toolName of this._toolRegistry.keys()) {
				if (!isAllowedTool(toolName)) continue;
				for (const pattern of explicitAllowPatterns) {
					if (matchesResourceProfilePattern(toolName, [pattern])) boundPatterns.add(pattern);
				}
				if (matchesResourceProfilePattern(toolName, explicitAllowPatterns)) {
					nextActiveToolNames.push(toolName);
					autoActivated.push(toolName);
				}
			}
			// G13: an explicit grant that binds to NO registered tool is a silent no-op — typo'd
			// name, or the owning extension is not granted/loaded. Surface it.
			this._unboundToolGrantWarnings = explicitAllowPatterns
				.filter((pattern) => !boundPatterns.has(pattern))
				.map(
					(pattern) =>
						`profile tool grant "${pattern}" binds to no registered tool (typo, or the owning extension is not granted/loaded)`,
				);
		} else {
			this._unboundToolGrantWarnings = [];
		}

		// artifact_retrieve companion auto-activation is enforced inside
		// setActiveToolsByName() itself (not duplicated here), so every activation path --
		// including the public, extension-exposed setActiveTools() -- gets the same
		// guarantee, not just this settings/profile refresh flow.
		this.setActiveToolsByName([...new Set(nextActiveToolNames)]);
		// setActiveToolsByName just stored the profile-filtered ACTIVE set as the request; restore
		// the true pre-filter request (plus this refresh's auto-activations) so an internal refresh
		// can never permanently narrow it.
		this._requestedActiveToolNames = [...new Set([...requestedBase, ...autoActivated])];
	}

	private _createReloadRuntimeSnapshot(): ReloadRuntimeSnapshot {
		return {
			extensionRunner: this._extensionRunner,
			baseToolDefinitions: this._baseToolDefinitions,
			toolRegistry: this._toolRegistry,
			toolDefinitions: this._toolDefinitions,
			toolPromptSnippets: this._toolPromptSnippets,
			toolPromptGuidelines: this._toolPromptGuidelines,
			agentTools: this.agent.state.tools,
			agentSystemPrompt: this.agent.state.systemPrompt,
			baseSystemPrompt: this._baseSystemPrompt,
		};
	}

	private _restoreReloadRuntimeSnapshot(snapshot: ReloadRuntimeSnapshot): void {
		this._extensionRunner = snapshot.extensionRunner;
		this._baseToolDefinitions = snapshot.baseToolDefinitions;
		this._toolRegistry = snapshot.toolRegistry;
		this._toolDefinitions = snapshot.toolDefinitions;
		this._toolPromptSnippets = snapshot.toolPromptSnippets;
		this._toolPromptGuidelines = snapshot.toolPromptGuidelines;
		this.agent.state.tools = snapshot.agentTools;
		this.agent.state.systemPrompt = snapshot.agentSystemPrompt;
		this._baseSystemPrompt = snapshot.baseSystemPrompt;
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = snapshot.extensionRunner;
		}
		this._applyExtensionBindings(snapshot.extensionRunner);
	}

	private _doctorReloadRuntime(): void {
		const extensionErrors = this._resourceLoader.getExtensions().errors;
		if (extensionErrors.length > 0) {
			const summary = extensionErrors
				.slice(0, 6)
				.map((error) => `${error.path}: ${error.error}`)
				.join("; ");
			throw new Error(`Extension reload failed doctor: ${summary}`);
		}

		const missingActiveTools = this.getActiveToolNames().filter((name) => !this._toolRegistry.has(name));
		if (missingActiveTools.length > 0) {
			throw new Error(
				`Extension reload failed doctor: active tool(s) missing after reload: ${missingActiveTools.join(", ")}`,
			);
		}

		for (const tool of this.agent.state.tools) {
			if (!this._toolDefinitions.has(tool.name)) {
				throw new Error(`Extension reload failed doctor: tool ${tool.name} missing from definition registry`);
			}
		}

		this._createAgentContextSnapshot();
		this.getContextUsage();
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const autoResizeImages = this.settingsManager.getImageAutoResize();
		const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		// grep/find must not emit a "Full output: artifact tool-output:<id>" handle that
		// nothing can resolve. If artifact_retrieve is explicitly excluded/blocked/outside
		// an active allowlist, don't hand grep/find an artifact store at all: they fall
		// back to their pre-existing bounded preview/truncation behavior, with no
		// payload/meta files ever written and no retrieval promise made.
		const toolArtifactStore = this._isToolOrCommandAllowedByProfile("artifact_retrieve")
			? this._getToolArtifactStore()
			: undefined;
		const baseToolDefinitions = this._baseToolsOverride
			? Object.fromEntries(
					Object.entries(this._baseToolsOverride).map(([name, tool]) => [
						name,
						createToolDefinitionFromAgentTool(tool),
					]),
				)
			: createAllToolDefinitions(this._cwd, {
					read: { autoResizeImages },
					bash: { commandPrefix: shellCommandPrefix, shellPath },
					grep: { artifactStore: toolArtifactStore },
					find: { artifactStore: toolArtifactStore },
					artifact_retrieve: { artifactStore: toolArtifactStore },
				});

		this._baseToolDefinitions = new Map(
			Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		);
		if (!this._baseToolsOverride) {
			for (const definition of createCoreDiagnosticsToolDefinitions(
				() => this.getActiveToolNames(),
				() => this.getAllTools(),
				(messages) => this.getContextGcReport(messages),
				() => this._memory.getMemoryAuditDiagnostics(),
			)) {
				this._baseToolDefinitions.set(definition.name, definition);
			}
			const goalToolDefinition = createGoalToolDefinition({
				getGoalState: () => this.getGoalStateSnapshot(),
				saveGoalState: (state) => {
					this.saveGoalStateSnapshot(state);
				},
			});
			this._baseToolDefinitions.set(goalToolDefinition.name, goalToolDefinition);
			const delegateToolDefinition = createDelegateToolDefinition({
				runWorkerDelegation: (args) => this.runWorkerDelegationOnce(args),
			});
			this._baseToolDefinitions.set(delegateToolDefinition.name, delegateToolDefinition);
			// Registered but not default-active: probes spend tokens on the probed model, so
			// activation is an explicit choice (settings/profile/setActiveTools or /autonomy fitness).
			const modelFitnessToolDefinition = createModelFitnessToolDefinition({
				runProbe: (args) => this.runModelFitness(args),
			});
			this._baseToolDefinitions.set(modelFitnessToolDefinition.name, modelFitnessToolDefinition);
			const runToolkitScriptToolDefinition = createRunToolkitScriptToolDefinition({
				getScripts: () => this.settingsManager.getToolkitScripts(),
				execute: (script, scriptArgs) => executeToolkitScript({ script, scriptArgs, cwd: this._cwd }),
				// Reflex brain (fitness-gated local model): resolves ambiguous requests into a
				// registry pick. Best-effort — absent/unfit brain keeps the shortlist behavior.
				interpret: async (request, scripts) => {
					const model = this._resolveCurationModelIfFit();
					if (!model) return undefined;
					const completion = await this.runIsolatedCompletion({
						systemPrompt: REFLEX_INTERPRETER_SYSTEM_PROMPT,
						messages: [
							{
								role: "user",
								content: [{ type: "text", text: buildReflexUserPrompt(request, scripts) }],
								timestamp: Date.now(),
							},
						],
						model,
						thinkingLevel: "off",
						maxTokens: 256,
						cacheRetention: "short",
					});
					if (completion.usage.cost.total > 0 || completion.usage.totalTokens > 0) {
						this.addSpawnedUsage(completion.usage, { label: "toolkit-brain" });
					}
					return parseReflexPlan(completion.text);
				},
			});
			this._baseToolDefinitions.set(runToolkitScriptToolDefinition.name, runToolkitScriptToolDefinition);
		}

		const extensionsResult = this._resourceLoader.getExtensions();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}
		const extensions = this._filterExtensionsForRuntime(extensionsResult.extensions);
		const runtimeExtensionPaths = new Set(extensions.map((extension) => extension.path));
		extensionsResult.runtime.pendingProviderRegistrations =
			extensionsResult.runtime.pendingProviderRegistrations.filter((registration) =>
				runtimeExtensionPaths.has(registration.extensionPath),
			);

		this._extensionRunner = new ExtensionRunner(
			extensions,
			extensionsResult.runtime,
			this._cwd,
			this.sessionManager,
			this._modelRegistry,
		);
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);

		const defaultActiveToolNames = this._baseToolsOverride
			? Object.keys(this._baseToolsOverride)
			: ["read", "bash", "edit", "write", "context_audit", "goal", "delegate", "run_toolkit_script"];
		const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
		this._refreshToolRegistry({
			activeToolNames: baseActiveToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
	}

	async reload(): Promise<void> {
		if (this.isStreaming) {
			throw new Error("Cannot reload while the agent is streaming or a tool call is active");
		}
		if (this.isCompacting) {
			throw new Error("Cannot reload while context compaction or branch summarization is active");
		}
		const previousRunner = this._extensionRunner;
		const snapshot = this._createReloadRuntimeSnapshot();
		// Preserve the pre-filter tool REQUEST across the rebuild, not the capability/profile-filtered
		// active set — otherwise a reload under a small model permanently shrinks the restorable set.
		const activeToolNames = this._requestedActiveToolNames ?? this.getActiveToolNames();
		const previousFlagValues = previousRunner.getFlagValues();
		const reloadErrors: string[] = [];
		let newRunner: ExtensionRunner | undefined;
		try {
			await this.settingsManager.reload();
			// Re-derive the resource-profile tool filter from the freshly reloaded settings.
			// Unlike skills/prompts/themes (which re-filter through the resource loader on every
			// reload), the tool filter is held on the session, so without this a live edit to the
			// active profile's tools allow/block — or switching the active profile — would not
			// apply on /reload and allowed tools would stay missing.
			this._toolProfileFilter = this._deriveToolProfileFilter();
			// Re-apply the active profile's model/thinking from the freshly reloaded settings, so a live
			// profile edit (or switch) takes effect on /reload. Skipped when the launch used an explicit
			// --model/--thinking flag, which must win over the profile across reloads.
			await this._reapplyActiveProfileModelSettings();
			await this._resourceLoader.reload({ failOnExtensionErrors: true, deferExtensionDispose: true });
			resetApiProviders();
			this._buildRuntime({
				activeToolNames,
				flagValues: previousFlagValues,
				includeAllExtensionTools: true,
			});
			newRunner = this._extensionRunner;
			const offDoctorErrors = newRunner.onError((error) => {
				reloadErrors.push(`${error.extensionPath} ${error.event}: ${error.error}`);
			});
			try {
				this._doctorReloadRuntime();
				// Reload starts memory providers fresh; loaded extensions re-register below.
				this._memory.clearPendingProviders();
				const hasBindings =
					this._extensionUIContext ||
					this._extensionCommandContextActions ||
					this._extensionShutdownHandler ||
					this._extensionErrorListener;
				if (hasBindings) {
					await newRunner.emit({ type: "session_start", reason: "reload" });
					await this.extendResourcesFromExtensions("reload");
					this._doctorReloadRuntime();
				}
			} finally {
				offDoctorErrors();
			}
			if (reloadErrors.length > 0) {
				throw new Error(`Extension reload failed doctor: ${reloadErrors.slice(0, 6).join("; ")}`);
			}
			await emitSessionShutdownEvent(previousRunner, { type: "session_shutdown", reason: "reload" });
			previousRunner.invalidate();
			this._resourceLoader.commitReload?.();
			// Re-derive the memory subsystem from the reloaded settings/providers.
			await this._memory.initialize();
		} catch (error) {
			if (newRunner && newRunner !== previousRunner) {
				newRunner.invalidate(
					"This extension ctx was discarded because reload failed and Pi restored the previous valid runtime.",
				);
			}
			this._resourceLoader.rollbackReload?.();
			this._restoreReloadRuntimeSnapshot(snapshot);
			throw error;
		}
	}

	/**
	 * Unload a single extension without full reload.
	 * Runs the extension's session_shutdown lifecycle, unregisters its providers,
	 * disposes its event subscriptions, and rebuilds the runtime.
	 * Falls back to full reload on error.
	 */
	async unloadExtensionLive(extensionPath: string): Promise<void> {
		if (this.isStreaming) {
			throw new Error("Cannot unload extension while the agent is streaming or a tool call is active");
		}
		if (this.isCompacting) {
			throw new Error("Cannot unload extension while context compaction or branch summarization is active");
		}

		const ext = this._resourceLoader.getLoadedExtension(extensionPath);
		if (!ext) {
			return; // Nothing to unload
		}

		const previousRunner = this._extensionRunner;
		try {
			// Run session_shutdown lifecycle for this extension only
			await this._extensionRunner.emitToExtension(ext, { type: "session_shutdown", reason: "unload" });

			// Unregister its providers (keyed by the extension's own path, as registered)
			const runtime = this._resourceLoader.getExtensions().runtime;
			for (const name of runtime.getProvidersForExtension(ext.path)) {
				runtime.unregisterProvider(name, ext.path);
			}

			// Dispose its event subscriptions and run disposers
			await disposeExtensionEventSubscriptions([ext]);

			// Remove from loaded extensions
			this._resourceLoader.removeLoadedExtension(extensionPath);

			// Rebuild runtime with new extension set
			const activeToolNames = this._requestedActiveToolNames ?? this.getActiveToolNames();
			const previousFlagValues = previousRunner.getFlagValues();
			this._buildRuntime({
				activeToolNames,
				flagValues: previousFlagValues,
				includeAllExtensionTools: true,
			});
			previousRunner.invalidate();

			// Notify extensions-changed listeners
			this._notifyExtensionsChanged();
		} catch (error) {
			// Fall back to full reload on error
			try {
				await this.reload();
			} catch {
				// Suppress nested error; original error will be thrown below
			}
			throw error;
		}
	}

	/**
	 * Load a single extension without full reload.
	 * Loads the extension with fresh import, rebuilds the runtime,
	 * and runs the extension's session_start lifecycle.
	 * Falls back to full reload on error.
	 */
	async loadExtensionLive(extensionPath: string): Promise<void> {
		if (this.isStreaming) {
			throw new Error("Cannot load extension while the agent is streaming or a tool call is active");
		}
		if (this.isCompacting) {
			throw new Error("Cannot load extension while context compaction or branch summarization is active");
		}

		const previousRunner = this._extensionRunner;
		try {
			// Load the extension with fresh import
			const { extension, error } = await this._resourceLoader.loadSingleExtension(extensionPath);
			if (error || !extension) {
				throw new Error(error || `Failed to load extension: ${extensionPath}`);
			}

			// Rebuild runtime to aggregate tools/commands/handlers/providers
			const activeToolNames = this._requestedActiveToolNames ?? this.getActiveToolNames();
			const previousFlagValues = previousRunner.getFlagValues();
			this._buildRuntime({
				activeToolNames,
				flagValues: previousFlagValues,
				includeAllExtensionTools: true,
			});

			// Run session_start lifecycle for the new extension only
			await this._extensionRunner.emitToExtension(extension, { type: "session_start", reason: "load" });

			// Notify extensions-changed listeners
			this._notifyExtensionsChanged();
		} catch (error) {
			// Fall back to full reload on error
			try {
				await this.reload();
			} catch {
				// Suppress nested error; original error will be thrown below
			}
			throw error;
		}
	}

	/**
	 * Reconcile loaded extensions with the active profile.
	 * Loads extensions that should be enabled but aren't, and unloads extensions that shouldn't be.
	 * Falls back to full reload if any individual load/unload fails.
	 */
	async reconcileLoadedExtensions(): Promise<void> {
		if (this.isStreaming) {
			throw new Error("Cannot reconcile extensions while the agent is streaming or a tool call is active");
		}
		if (this.isCompacting) {
			throw new Error("Cannot reconcile extensions while context compaction or branch summarization is active");
		}

		try {
			// Get all discoverable extension paths
			const allDiscoverablePaths = await this._resourceLoader.getDiscoverableExtensionPaths();

			// Get the target enabled set based on profile filters
			const targetEnabledSet = new Set<string>();
			for (const path of allDiscoverablePaths) {
				if (this.settingsManager.isResourceAllowedByProfile("extensions", path)) {
					targetEnabledSet.add(path);
				}
			}

			// Get currently loaded set
			const loadedExtensions = this._resourceLoader.getExtensions().extensions;
			const loadedSet = new Set<string>();
			for (const ext of loadedExtensions) {
				loadedSet.add(ext.path);
			}

			// Collect unloads and loads
			const toUnload: string[] = [];
			const toLoad: string[] = [];

			for (const path of loadedSet) {
				if (!targetEnabledSet.has(path)) {
					toUnload.push(path);
				}
			}

			for (const path of targetEnabledSet) {
				if (!loadedSet.has(path)) {
					toLoad.push(path);
				}
			}

			// Apply unloads first, then loads, to minimize churn
			// Collect errors but continue through all operations
			const errors: Error[] = [];

			for (const path of toUnload) {
				try {
					await this.unloadExtensionLive(path);
				} catch (error) {
					errors.push(error instanceof Error ? error : new Error(String(error)));
				}
			}

			for (const path of toLoad) {
				try {
					await this.loadExtensionLive(path);
				} catch (error) {
					errors.push(error instanceof Error ? error : new Error(String(error)));
				}
			}

			// If any errors occurred, throw the first one (already fell back to full reload in load/unload)
			if (errors.length > 0) {
				throw errors[0];
			}

			// Single notification at the end
			this._notifyExtensionsChanged();
		} catch (error) {
			// Fall back to full reload on error
			try {
				await this.reload();
			} catch {
				// Suppress nested error; original error will be thrown below
			}
			throw error;
		}
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

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.operations Custom BashOperations for remote execution
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; operations?: BashOperations },
	): Promise<BashResult> {
		this._bashAbortController = new AbortController();

		// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
		const prefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;
		const enableGitFilter = !options?.operations && !prefix && !shellPath;

		try {
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.sessionManager.getCwd(),
				options?.operations ?? createLocalBashOperations({ shellPath }),
				{
					onChunk,
					signal: this._bashAbortController.signal,
					enableGitFilter,
				},
			);

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this._bashAbortController = undefined;
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			// Queue for later - will be flushed on agent_end
			this._pendingBashMessages.push(bashMessage);
		} else {
			// Add to agent state immediately
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		this._bashAbortController?.abort();
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this._bashAbortController !== undefined;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		for (const bashMessage of this._pendingBashMessages) {
			// Add to agent state
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}

		this._pendingBashMessages = [];
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

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		const oldLeafId = this.sessionManager.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data - mutable so extensions can override
		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		// Set up abort controller for summarization
		this._branchSummaryAbortController = new AbortController();

		try {
			let extensionSummary: { summary: string; details?: unknown } | undefined;
			let fromExtension = false;

			// Emit session_before_tree event
			if (this._extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: this._branchSummaryAbortController.signal,
				})) as SessionBeforeTreeResult | undefined;

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				// Allow extensions to override instructions and label
				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			// Run default summarizer if needed
			let summaryText: string | undefined;
			let summaryDetails: unknown;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const model = this.model!;
				const { apiKey, headers } = await this._getRequiredRequestAuth(model);
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					model,
					apiKey,
					headers,
					signal: this._branchSummaryAbortController.signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
				});
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryDetails = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
			}

			// Determine the new leaf position based on target type
			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				// User message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = this._extractUserMessageText(targetEntry.message.content);
			} else if (targetEntry.type === "custom_message") {
				// Custom message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText =
					typeof targetEntry.content === "string"
						? targetEntry.content
						: targetEntry.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map((c) => c.text)
								.join("");
			} else {
				// Non-user message: leaf = selected node
				newLeafId = targetId;
			}

			// Switch leaf (with or without summary)
			// Summary is attached at the navigation target position (newLeafId), not the old branch
			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				// Create summary at target position (can be null for root)
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				// Attach label to the summary entry
				if (label) {
					this.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				// No summary, navigating to root - reset leaf
				this.sessionManager.resetLeaf();
			} else {
				// No summary, navigating to non-root
				this.sessionManager.branch(newLeafId);
			}

			// Attach label to target entry when not summarizing (no summary entry to label)
			if (label && !summaryText) {
				this.sessionManager.appendLabelChange(targetId, label);
			}

			// Update agent state
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;

			// Emit session_tree event
			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			// Emit to custom tools

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this._branchSummaryAbortController = undefined;
		}
	}

	/**
	 * Get all user messages from session for fork selector.
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = this._extractUserMessageText(entry.message.content);
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	private _extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
		}
		return "";
	}

	/**
	 * Get session statistics.
	 */
	getSessionStats(): SessionStats {
		const state = this.state;
		const userMessages = state.messages.filter((m) => m.role === "user").length;
		const assistantMessages = state.messages.filter((m) => m.role === "assistant").length;
		const toolResults = state.messages.filter((m) => m.role === "toolResult").length;

		let toolCalls = 0;
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const message of state.messages) {
			if (message.role === "assistant") {
				const assistantMsg = message as AssistantMessage;
				toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				totalInput += assistantMsg.usage.input;
				totalOutput += assistantMsg.usage.output;
				totalCacheRead += assistantMsg.usage.cacheRead;
				totalCacheWrite += assistantMsg.usage.cacheWrite;
				totalCost += assistantMsg.usage.cost.total;
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages: state.messages.length,
			tokens: {
				input: totalInput,
				output: totalOutput,
				cacheRead: totalCacheRead,
				cacheWrite: totalCacheWrite,
				total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
			},
			cost: totalCost,
			contextUsage: this.getContextUsage(),
		};
	}

	/**
	 * Cumulative usage (full breakdown) for this session's entire spawn subtree: its own
	 * assistant messages PLUS every `spawned_usage` report it has rolled up. Single source of
	 * truth for "how much did this session and everything it spawned spend" — used by print-mode
	 * to emit a child's total so a spawner can roll it up via {@link addSpawnedUsage}.
	 *
	 * Including the `spawned_usage` reports is what keeps the single-hop invariant intact: a child
	 * that itself spawned grandchildren must report own + sub-usage in one number, or the parent
	 * silently under-counts the grandchildren.
	 */
	getCumulativeUsage(): Usage {
		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let totalTokens = 0;
		let costInput = 0;
		let costOutput = 0;
		let costCacheRead = 0;
		let costCacheWrite = 0;
		let costTotal = 0;
		const add = (usage: Usage) => {
			input += usage.input;
			output += usage.output;
			cacheRead += usage.cacheRead;
			cacheWrite += usage.cacheWrite;
			totalTokens += usage.totalTokens;
			costInput += usage.cost.input;
			costOutput += usage.cost.output;
			costCacheRead += usage.cost.cacheRead;
			costCacheWrite += usage.cost.cacheWrite;
			costTotal += usage.cost.total;
		};
		for (const message of this.state.messages) {
			if (message.role !== "assistant") continue;
			const usage = (message as AssistantMessage).usage;
			if (!usage) continue;
			add(usage);
		}
		// Roll up usage this session attributed to its own spawned children (single-hop).
		for (const entry of this.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== SPAWNED_USAGE_CUSTOM_TYPE) continue;
			const data = entry.data as SpawnedUsageReport | undefined;
			if (data?.usage) add(data.usage);
		}
		return {
			input,
			output,
			cacheRead,
			cacheWrite,
			totalTokens,
			cost: {
				input: costInput,
				output: costOutput,
				cacheRead: costCacheRead,
				cacheWrite: costCacheWrite,
				total: costTotal,
			},
		};
	}

	/**
	 * Record usage spent by a spawned/subagent session so the footer can roll it into the
	 * displayed cost. Persisted as a `CustomEntry` (`customType: "spawned_usage"`, Model A) so
	 * it survives reload and is reconstructed exactly like main usage; a new/forked session
	 * starts fresh because it owns a new log file.
	 *
	 * Idempotent on `opts.reportId`: a re-report (retry, duplicate `agent_end`) with a
	 * previously-seen id is ignored, so cost cannot be double-counted. Honors the single-hop
	 * invariant documented on {@link SpawnedUsageReport}.
	 *
	 * @returns the id of the appended entry, or `undefined` if the report was a duplicate.
	 */
	addSpawnedUsage(
		usage: Usage,
		opts?: { label?: string; sourceSessionId?: string; reportId?: string },
	): string | undefined {
		const reportId = opts?.reportId;
		if (reportId) {
			for (const entry of this.sessionManager.getEntries()) {
				if (
					entry.type === "custom" &&
					entry.customType === SPAWNED_USAGE_CUSTOM_TYPE &&
					(entry.data as SpawnedUsageReport | undefined)?.reportId === reportId
				) {
					return undefined;
				}
			}
		}
		const report: SpawnedUsageReport = {
			usage,
			label: opts?.label,
			sourceSessionId: opts?.sourceSessionId,
			reportId,
		};
		return this.sessionManager.appendCustomEntry(SPAWNED_USAGE_CUSTOM_TYPE, report);
	}

	/**
	 * Aggregate all recorded spawned-usage reports (see {@link addSpawnedUsage}). Cached by the session
	 * entry count so the interactive footer (which calls this every render frame) is O(1) between turns
	 * instead of an O(N) scan on every keystroke (Bug #22). Recomputes only when entries change.
	 */
	getSpawnedUsage(): SpawnedUsageTotals {
		const entryCount = this.sessionManager.getEntryCount?.() ?? this.sessionManager.getEntries().length;
		if (this._spawnedUsageCache?.entryCount === entryCount) return this._spawnedUsageCache.totals;
		let cost = 0;
		let reports = 0;
		for (const entry of this.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== SPAWNED_USAGE_CUSTOM_TYPE) continue;
			const data = entry.data as SpawnedUsageReport | undefined;
			if (!data?.usage) continue;
			cost += data.usage.cost.total;
			reports += 1;
		}
		const totals: SpawnedUsageTotals = { cost, reports };
		this._spawnedUsageCache = { entryCount, totals };
		return totals;
	}

	getDailyUsageTotals(now = new Date()): DailyUsageTotals {
		const sessionDir = this.sessionManager.getSessionDir();
		const scope = this.sessionManager.usesDefaultSessionDir() ? getSessionsDir() : sessionDir;
		const nowMs = now.getTime();
		if (this._dailyUsageCache?.sessionDir === scope && this._dailyUsageCache.expiresAt > nowMs) {
			return this._dailyUsageCache.totals;
		}
		const window = getLocalDayWindow(now);
		const totals = this.sessionManager.usesDefaultSessionDir()
			? aggregateDailyUsageFromSessionRoot(scope, window)
			: aggregateDailyUsageFromSessionFiles(sessionDir, window);
		this._dailyUsageCache = { sessionDir: scope, expiresAt: nowMs + 10_000, totals };
		return totals;
	}

	getDailyUsageBreakdown(formatLabel?: (label: string) => string, now = new Date()): string {
		return formatDailyUsageBreakdown(this.getDailyUsageTotals(now), formatLabel);
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
		const snapshot = this.getGoalRuntimeSnapshot({ maxStallTurns: options.maxStallTurns });

		if (snapshot.continuation.action !== "continue") {
			return { submitted: false, snapshot };
		}

		const prompt = buildGoalContinuationPrompt({ snapshot, limits: options.promptLimits });
		await this.prompt(prompt.text, {
			expandPromptTemplates: false,
			processSlashCommands: false,
			autoContinueGoal: false,
		});

		return { submitted: true, snapshot, prompt };
	}

	async continueGoalLoop(options: GoalContinuationLoopOptions): Promise<GoalContinuationLoopResult> {
		let turnsSubmitted = 0;
		const now = options.now ?? Date.now;
		const maxWallClockMs =
			typeof options.maxWallClockMinutes === "number" && options.maxWallClockMinutes > 0
				? options.maxWallClockMinutes * 60_000
				: undefined;
		const startedAt = now();
		const hasReachedWallClockBudget = () => maxWallClockMs !== undefined && now() - startedAt >= maxWallClockMs;
		const snapshot = () => this.getGoalRuntimeSnapshot({ maxStallTurns: options.maxStallTurns });

		if (options.maxTurns <= 0) {
			return {
				turnsSubmitted: 0,
				stopReason: "max_turns_reached",
				finalSnapshot: snapshot(),
			};
		}

		if (hasReachedWallClockBudget()) {
			return { turnsSubmitted, stopReason: "wall_clock_budget_reached", finalSnapshot: snapshot() };
		}

		while (turnsSubmitted < options.maxTurns) {
			const beforeSnapshot = snapshot();
			if (beforeSnapshot.continuation.action !== "continue") {
				return { turnsSubmitted, stopReason: "continuation_not_allowed", finalSnapshot: beforeSnapshot };
			}

			const state = beforeSnapshot.goalState;
			const beforeKey = state
				? `${state.goalId}:${state.updatedAt}:${state.events.length}:${state.stallTurns}:${state.status}`
				: undefined;

			const result = await this.continueGoalOnce(options);
			if (result.submitted) {
				turnsSubmitted++;
			}

			if (hasReachedWallClockBudget()) {
				return { turnsSubmitted, stopReason: "wall_clock_budget_reached", finalSnapshot: snapshot() };
			}

			const afterSnapshot = snapshot();
			if (afterSnapshot.continuation.action !== "continue") {
				return { turnsSubmitted, stopReason: "continuation_not_allowed", finalSnapshot: afterSnapshot };
			}

			const afterState = afterSnapshot.goalState;
			const afterKey = afterState
				? `${afterState.goalId}:${afterState.updatedAt}:${afterState.events.length}:${afterState.stallTurns}:${afterState.status}`
				: undefined;

			if (beforeKey === afterKey) {
				return { turnsSubmitted, stopReason: "goal_state_not_advanced", finalSnapshot: afterSnapshot };
			}
		}

		return {
			turnsSubmitted,
			stopReason: "max_turns_reached",
			finalSnapshot: snapshot(),
		};
	}

	/**
	 * Run a one-shot LLM completion fully ISOLATED from the main session — the load-bearing
	 * primitive for the native reflection engine (adaptive-agent design §6c/§7).
	 *
	 * Isolation invariants (audited by codex): builds a fresh {@link Context} (no main history), runs
	 * with `tools: []`, sets `cacheRetention: "none"`, and passes **no `sessionId`** — so it cannot
	 * mutate `agent.state.messages`, cannot append session entries, cannot touch the tool registry,
	 * and cannot churn the main session's prompt cache. Mirrors `generateSummary()`'s mechanics.
	 *
	 * Returns the result even on an error/aborted stop reason (callers — e.g. a background reflection
	 * microtask — decide whether to act); it does not throw on a model-level error.
	 */
	async runIsolatedCompletion(opts: IsolatedCompletionOptions): Promise<IsolatedCompletionResult> {
		const model = opts.model ?? this.model;
		if (!model) {
			throw new Error("runIsolatedCompletion: no model available");
		}
		const thinkingLevel = opts.thinkingLevel ?? "off";

		// Fresh, isolated context: explicit messages, no tools, nothing from the main session.
		const context: Context = {
			systemPrompt: opts.systemPrompt,
			messages: opts.messages,
			tools: [],
		};

		// Isolate the prompt cache and DELIBERATELY omit sessionId so no session-aware caching/routing
		// can entangle this call with the main session.
		const options: SimpleStreamOptions = {
			maxTokens: opts.maxTokens,
			signal: opts.signal,
			cacheRetention: opts.cacheRetention ?? "none",
		};
		// pi-ai's `reasoning` option does not include "off" (that's the provider default already).
		if (thinkingLevel !== "off") {
			options.reasoning = thinkingLevel;
		}

		// When streamFn is the raw streamSimple (e.g. in tests), auth must be injected explicitly.
		// Throw only when auth genuinely fails — providers that authenticate without an API key
		// (OAuth, local no-key) legitimately return ok with an undefined apiKey.
		if (this._isRawStreamSimple(this.agent.streamFn)) {
			const auth = await this._modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) {
				throw new Error(auth.error);
			}
			options.apiKey = auth.apiKey;
			options.headers = auth.headers;
		}

		const stream = await this.agent.streamFn(model, context, options);
		const result = await stream.result();
		const text = result.content
			.filter((c): c is TextContent => c.type === "text")
			.map((c) => c.text)
			.join("");
		const usage: Usage = result.usage ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		return { text, usage, stopReason: result.stopReason };
	}

	/**
	 * Native end-of-loop reflection pass (R2). Demand-gates (zero-I/O), and when warranted runs the
	 * {@link ReflectionEngine} via an isolated completion ({@link runIsolatedCompletion}), applies the
	 * resulting memory writes through the bundled `memory` tool, and accounts the reflection's token
	 * cost via the cost-aggregation surface so it stays visible and net-negative-auditable.
	 *
	 * Returns `null` when the gate skips (or in a child session, which must not learn). The whole pass
	 * is best-effort: a model/parse error yields no writes, never throws into the caller.
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
		if (this._isChildSession || this._disposed) return null;
		const plan = decideDemand(input.signals);
		if (plan.act === "skip") return null;

		// Bug #21: tie this background pass to the session lifetime. Disposing the session aborts the
		// in-flight completion (input.signal can add a more specific abort).
		const signal = input.signal
			? AbortSignal.any([input.signal, this._reflectionAbort.signal])
			: this._reflectionAbort.signal;

		const complete = (systemPrompt: string, userPrompt: string) =>
			this.runIsolatedCompletion({
				systemPrompt,
				messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
				model: input.model,
				thinkingLevel: input.thinkingLevel ?? "low",
				maxTokens: plan.tokenBudget,
				signal,
				// The reflection system prompt is static (#33) — let the provider cache the prefix so
				// repeated passes only pay for the variable tail.
				cacheRetention: "short",
			});

		const result = await new ReflectionEngine().reflect({
			recentTurnText: input.recentTurnText,
			// Read memory FRESH (not the prefix-cache-frozen system-prompt block) so confront-before-write
			// sees writes made earlier this session.
			existingMemory: this._memory.getMemoryManager().buildSystemPromptBlockFresh() || "",
			plan,
			complete,
		});

		// Bug #21: if the session was disposed while the completion was in flight, do NOT write memory
		// or skills against the dead session.
		if (this._disposed) return result;

		// Learning apply policy: every durable write is converted to a proposal, decided by the
		// learning gate, and audited with a rollback plan. With the policy disabled (default) the
		// legacy direct-apply behavior is preserved — but now leaves audit records with rollback info.
		const policy = this.settingsManager.getLearningPolicySettings();
		// The audit id sequence counts STORED snapshots only: it reseeds from the stored count on
		// every pass, so advancing it for a no-op (which stores nothing) would make later passes
		// reuse ids — and rollback keys on the id, so a collision blocks or misdirects rollback.
		let auditSequence = getLearningAuditSnapshots(this.sessionManager.getEntries()).length;
		// G6 evidence strength: durable proposals accumulate observation counts across passes/sessions
		// so the gate can distinguish a one-off cue from a repeatedly-confirmed lesson. Built once per
		// pass; every increment is best-effort (store IO must never break reflection).
		const observationStore = ObservationStore.forAgentDir(this._agentDir);
		let writeIndex = 0;
		for (const write of result.writes) {
			writeIndex += 1;
			const proposalId = `${input.reportId ?? "reflection"}-w${writeIndex}`;
			const proposal = proposalFromReflectionWrite(write, proposalId);
			const rollback = rollbackPlanForReflectionWrite(write);
			let observations = 1;
			if (policy.enabled) {
				try {
					observations = observationStore.increment(observationKey(proposal.layer, proposal.summary));
				} catch {
					// A store read/write failure falls back to a fresh count of 1, which keeps the gate
					// proposal-first (never spuriously auto-applies) rather than crashing the pass.
					observations = 1;
				}
			}
			const decision: LearningDecision = policy.enabled
				? evaluateLearningDecision({
						proposal,
						confidence: policy.reflectionSourceConfidence,
						observations,
						// A replace/remove supersedes an existing durable fact — the reflection engine's
						// confront-before-write conflict signal — so it routes through approval instead of
						// silently overwriting prior memory. Additive writes contradict nothing.
						contradictions: contradictionsForReflectionWrite(write),
						settings: {
							enabled: true,
							autoApplyEnabled: policy.autoApplyEnabled,
							confidenceThreshold: policy.confidenceThreshold,
							minObservations: policy.minObservations,
							allowedAutoApplyLayers: policy.allowedAutoApplyLayers,
							requireRollbackPlan: policy.requireRollbackPlan,
							autoApplySupersessions: policy.autoApplySupersessions,
						},
					})
				: {
						kind: "apply",
						reasonCode: "learning_policy_disabled_legacy_apply",
						confidence: 0,
						summary: proposal.summary,
						requiresApproval: false,
					};

			this.saveLearningDecisionSnapshot(decision);
			// G3: learning-gate outcome. Codes/numbers only — never the proposal summary/memory text.
			this._emitAutonomyTelemetry({
				type: AUTONOMY_TELEMETRY_EVENT_TYPES.learningDecision,
				timestamp: new Date().toISOString(),
				payload: {
					kind: decision.kind,
					reasonCode: decision.reasonCode,
					layer: proposal.layer,
					confidence: decision.confidence,
					requiresApproval: decision.requiresApproval,
				},
			});
			// G8: a proposal that needs human sign-off is an approval REQUEST. Codes/layer only —
			// never the proposal summary/memory text (those live only in the audit snapshot).
			if (decision.requiresApproval) {
				this._emitAutonomyTelemetry({
					type: AUTONOMY_TELEMETRY_EVENT_TYPES.approvalRequest,
					timestamp: new Date().toISOString(),
					payload: {
						kind: decision.kind,
						reasonCode: decision.reasonCode,
						layer: proposal.layer,
					},
				});
			}
			// The gate's decision and the write's actual outcome are two different questions: the memory
			// tool can refuse a write (budget exceeded, drift, threat) via details.success:false without
			// throwing. Capture that outcome instead of assuming "decision.kind === apply" means it landed
			// — otherwise a refused write leaves a phantom "apply" audit whose rollback later fails
			// not-found (or, worse, misfires against whatever now occupies that text).
			const applied = decision.kind === "apply" ? await this._applyReflectionWrite(write, signal) : false;
			const writeFailed = decision.kind === "apply" && !applied;
			if (decision.kind !== "no-op") {
				auditSequence += 1;
				appendLearningAuditSnapshot(this.sessionManager, {
					id: `audit-${auditSequence}`,
					proposalId,
					layer: proposal.layer,
					action: writeFailed ? "apply_failed" : decision.kind === "apply" ? "apply" : "propose",
					summary: proposal.summary,
					reasonCode: writeFailed ? APPLY_WRITE_REFUSED_REASON_CODE : decision.reasonCode,
					decision,
					// No rollback plan on a failed apply — nothing durable landed, so there is nothing to undo.
					rollback: writeFailed ? undefined : rollback,
					createdAt: new Date().toISOString(),
				});
			}
		}

		// Account the reflection's spend so it surfaces in the footer roll-up (net-token visibility).
		// Idempotent on reportId so a retried/duplicated pass cannot double-count.
		if (result.usage.cost.total > 0 || result.usage.totalTokens > 0) {
			this.addSpawnedUsage(result.usage, { label: "reflection", reportId: input.reportId });
		}
		return result;
	}

	getLearningAuditRecords(): LearningAuditRecord[] {
		return getLearningAuditSnapshots(this.sessionManager.getEntries());
	}

	/**
	 * Roll back one applied durable learning change by executing the inverse operation recorded in
	 * its audit record (memory ops run through the same bundled memory-tool path as the original
	 * apply; promoted skills are archived). Appends a linked "rollback" audit record on success so
	 * the change history stays complete and a change cannot be rolled back twice.
	 */
	async rollbackLearningWrite(auditId: string): Promise<{ ok: boolean; reason: string }> {
		if (this._disposed) return { ok: false, reason: "session_disposed" };

		const audits = this.getLearningAuditRecords();
		const audit = audits.find((record) => record.id === auditId);
		if (!audit) return { ok: false, reason: "audit_not_found" };
		if (audit.action !== "apply") return { ok: false, reason: "not_an_applied_change" };
		if (audits.some((record) => record.action === "rollback" && record.rollbackOf === auditId)) {
			return { ok: false, reason: "already_rolled_back" };
		}
		const rollback = audit.rollback;
		if (!rollback) return { ok: false, reason: "no_rollback_plan" };

		// Every inverse must be VERIFIED-applied before the rollback audit is appended: a silently
		// failed inverse that still recorded "rollback" would permanently self-lock the change
		// behind already_rolled_back while the durable write is in fact still live.
		switch (rollback.kind) {
			case "memory_remove": {
				if (!rollback.target) return { ok: false, reason: "missing_rollback_target" };
				if (!(await this._applyReflectionWrite({ kind: "memory_remove", target: rollback.target }))) {
					return { ok: false, reason: "rollback_apply_failed" };
				}
				break;
			}
			case "memory_restore": {
				if (!rollback.target || rollback.previous === undefined) {
					return { ok: false, reason: "missing_rollback_target" };
				}
				const applied = await this._applyReflectionWrite({
					kind: "memory_replace",
					target: rollback.target,
					text: rollback.previous,
				});
				if (!applied) return { ok: false, reason: "rollback_apply_failed" };
				break;
			}
			case "memory_add": {
				if (rollback.previous === undefined) return { ok: false, reason: "missing_rollback_target" };
				const applied = await this._applyReflectionWrite({
					kind: "memory_add",
					section: "MEMORY",
					text: rollback.previous,
				});
				if (!applied) return { ok: false, reason: "rollback_apply_failed" };
				break;
			}
			case "archive_skill": {
				if (!rollback.target) return { ok: false, reason: "missing_rollback_target" };
				if (!this.archivePromotedSkill(rollback.target)) {
					return { ok: false, reason: "skill_archive_failed" };
				}
				break;
			}
		}

		appendLearningAuditSnapshot(this.sessionManager, {
			id: `${audit.id}-rollback`,
			proposalId: audit.proposalId,
			layer: audit.layer,
			action: "rollback",
			summary: `Rolled back: ${audit.summary}`,
			reasonCode: "user_requested_rollback",
			decision: audit.decision,
			rollbackOf: audit.id,
			createdAt: new Date().toISOString(),
		});
		return { ok: true, reason: "rollback_applied" };
	}

	/**
	 * Apply one reflection write through the bundled `memory` tool. `memory_replace`/`memory_remove`
	 * don't carry a target file, so we try MEMORY.md first and fall back to USER.md when the substring
	 * isn't found there. Never throws (reflection must never break a turn); returns whether the write
	 * actually applied so callers that MUST know — rollback's once-only accounting — can react instead
	 * of recording a success that never happened.
	 */
	private async _applyReflectionWrite(write: ReflectionWrite, signal?: AbortSignal): Promise<boolean> {
		// R7 memory-to-behavior: a recurring procedure is compiled into an executable skill file rather
		// than stored as a flat fact. Written under the agent skills dir so it loads like any user skill.
		if (write.kind === "promote_skill") {
			return this._promoteReflectionSkill(write.name, write.description, write.body);
		}

		type MemResult = { details?: { success?: boolean; error?: string } };
		type MemExec = (
			toolCallId: string,
			params: { action: string; target: string; content?: string; oldContent?: string },
			signal: AbortSignal | undefined,
			onUpdate: undefined,
			ctx: undefined,
		) => Promise<MemResult>;
		const memTool = this._memory
			.getMemoryManager()
			.getToolDefinitions()
			.find((t) => t.name === "memory");
		const exec = memTool?.execute as unknown as MemExec | undefined;
		if (!exec) return false;

		const run = (params: Parameters<MemExec>[1]) => exec("reflection", params, signal, undefined, undefined);

		if (write.kind === "memory_add") {
			try {
				const res = await run({
					action: "add",
					target: write.section === "USER" ? "user" : "memory",
					content: write.text,
				});
				return res?.details?.success === true;
			} catch {
				// best-effort; reflection writes must never throw into the turn loop
				return false;
			}
		}

		// replace / remove carry no target file — try MEMORY.md, then USER.md. The memory tool reports
		// outcomes via `details.success` (it catches its own errors rather than throwing). Only a
		// genuine "not found in the file" justifies trying the other file; a real failure for a file
		// (budget exceeded / drift) must NOT fall through and mutate the wrong target.
		for (const target of ["memory", "user"] as const) {
			try {
				const params =
					write.kind === "memory_replace"
						? { action: "replace", target, oldContent: write.target, content: write.text }
						: { action: "remove", target, oldContent: write.target };
				const res = await run(params);
				if (res?.details?.success === true) return true; // applied
				if (!/not found/i.test(String(res?.details?.error ?? ""))) return false; // real failure — don't misapply
				// substring simply absent from this file — try the next target
			} catch {
				// defensive: if the tool ever does throw, try the next target
			}
		}
		return false;
	}

	/**
	 * R7: write a reflection-promoted skill as `<agentDir>/skills/<name>/SKILL.md` so it loads like any
	 * user skill. Best-effort; never clobbers an existing (hand-authored) skill of the same name.
	 */
	private _promoteReflectionSkill(rawName: string, description: string, body: string): boolean {
		const name = rawName
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 64);
		if (!name || !body.trim()) return false;
		try {
			const dir = join(this._agentDir, "skills", name);
			const file = join(dir, "SKILL.md");
			if (existsSync(file)) return false; // do not overwrite an existing skill
			mkdirSync(dir, { recursive: true });
			const safeDescription = description.replace(/[\r\n]+/g, " ").trim();
			// `promoted: true` marks this as reflection-generated so the curator (#32) can lifecycle-manage
			// it (archive/consolidate) WITHOUT ever touching hand-authored user skills.
			const content = `---\nname: ${name}\ndescription: ${safeDescription}\npromoted: true\n---\n\n<!-- Auto-generated by the reflection engine (R7 memory-to-behavior). Review and refine. -->\n\n${body.trim()}\n`;
			writeFileSync(file, content, "utf-8");
			return true;
		} catch {
			// promotion must never break a turn
			return false;
		}
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this.model;
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		// After compaction, the last assistant usage reflects pre-compaction context size.
		// We can only trust usage from an assistant that responded after the latest compaction.
		// If no such assistant exists, context token count is unknown until the next LLM response.
		const branchEntries = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);

		if (latestCompaction) {
			// Check if there's a valid assistant usage after the compaction boundary
			const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
			let hasPostCompactionUsage = false;
			for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
				const entry = branchEntries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					const assistant = entry.message;
					if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
						const contextTokens = calculateContextTokens(assistant.usage);
						if (contextTokens > 0) {
							hasPostCompactionUsage = true;
						}
						break;
					}
				}
			}

			if (!hasPostCompactionUsage) {
				return { tokens: null, contextWindow, percent: null };
			}
		}

		const estimate = estimateContextTokens(this.messages);
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
		};
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string): Promise<string> {
		const themeName = this.settingsManager.getTheme();

		// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolDefinition: (name) => this.getToolDefinition(name),
			theme,
			cwd: this.sessionManager.getCwd(),
		});

		return await exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	exportToJsonl(outputPath?: string): string {
		const filePath = resolvePath(
			outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
			process.cwd(),
		);
		const dir = dirname(filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionManager.getSessionId(),
			timestamp: new Date().toISOString(),
			cwd: this.sessionManager.getCwd(),
		};

		const branchEntries = this.sessionManager.getBranch();
		const lines = [JSON.stringify(header)];

		// Re-chain parentIds to form a linear sequence
		let prevId: string | null = null;
		for (const entry of branchEntries) {
			const linear = { ...entry, parentId: prevId };
			lines.push(JSON.stringify(linear));
			prevId = entry.id;
		}

		writeFileSync(filePath, `${lines.join("\n")}\n`);
		return filePath;
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// Skip aborted messages with no content
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
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
