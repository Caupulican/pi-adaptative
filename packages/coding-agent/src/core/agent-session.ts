import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type {
	Agent,
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentState,
	AgentTool,
	StreamFn,
	StreamIdleOptions,
	ThinkingLevel,
	ToolValidationEscalationEvent,
} from "@caupulican/pi-agent-core";
import {
	type CustomMessage,
	compactToolResultDetailsForRetention,
	createCustomMessage,
	DEFAULT_STREAM_IDLE,
	withStreamIdleWatchdog,
} from "@caupulican/pi-agent-core";
import type {
	BranchSummaryEntry,
	CompactionResult,
	CompactionSettings,
	SessionManager,
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
import { cleanupSessionResources, getSupportedThinkingLevels, modelsAreEqual, streamSimple } from "@caupulican/pi-ai";
import { getAgentDir } from "../config.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { resourceDir, stateFile } from "./agent-paths.ts";
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
import type { LaneRecord, LaneTerminalStatus } from "./autonomy/lane-tracker.ts";
import type { AutonomyDiagnosticSnapshot, AutonomyStatusSnapshot, GateOutcomeHistoryEntry } from "./autonomy/status.ts";
import type { AutonomyTelemetryEvent } from "./autonomy/telemetry-events.ts";
import { AutonomyTelemetry } from "./autonomy-telemetry.ts";
import { BackgroundLaneController } from "./background-lane-controller.ts";
import { BashExecutionController } from "./bash-execution-controller.ts";
import type { BashResult } from "./bash-executor.ts";
import { type AutoCompactionReason, CompactionController } from "./compaction-controller.ts";
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
import type { MemoryProvider as ContextMemoryProvider } from "./context/memory-provider-contract.ts";
import type { MemoryRetrievalReport } from "./context/memory-retrieval.ts";
import type { ContextGcReport } from "./context-gc.ts";
import { ContextPipeline } from "./context-pipeline.ts";
import type { SessionCostSummary } from "./cost/cost-summary.ts";
import type { DailyUsageTotals } from "./cost/daily-usage.ts";
import { type CostGuardDecision, downgradeReasoning, estimateTurnCostUsd, evaluateCostGuard } from "./cost-guard.ts";
import { appendWorkerResultSnapshot, getWorkerResultSnapshots } from "./delegation/session-worker-result.ts";
import type { WorkerDelegationRequest } from "./delegation/worker-delegation-request.ts";
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
import { FailureCorpusRecorder } from "./failure-corpus.ts";
import { ForegroundRecoveryController } from "./foreground-recovery-controller.ts";
import { type ChannelProvider, GatewayRegistry, type JobSchedulerProvider } from "./gateways/channel-provider.ts";
import { GoalLoopController } from "./goal-loop-controller.ts";
import type { GoalContinuationPrompt, GoalContinuationPromptLimits } from "./goals/goal-continuation-prompt.ts";
import {
	buildGoalRuntimeSnapshot,
	type GoalRuntimeSnapshot,
	type GoalRuntimeSnapshotSettings,
} from "./goals/goal-runtime-snapshot.ts";
import { applyGoalEvent, type GoalState } from "./goals/goal-state.ts";
import { appendGoalStateSnapshot, getLatestGoalStateSnapshot } from "./goals/session-goal-state.ts";
import { constrainStreamIdleToHttpTimeout } from "./http-dispatcher.ts";
import type { LearningAuditRecord } from "./learning/learning-audit.ts";
import type { DemandSignals, ReflectionResult } from "./learning/reflection-engine.ts";
import { appendLearningDecisionSnapshot, getLearningDecisionSnapshots } from "./learning/session-learning-decision.ts";
import { type CurationProposals, isPromotedFrontmatter, SkillCurator } from "./learning/skill-curator.ts";
import { LocalRuntimeController } from "./local-runtime-controller.ts";
import type { MemoryProvider } from "./memory/memory-provider.ts";
import { MemoryController } from "./memory-controller.ts";
import {
	deriveModelCapabilityProfile,
	evaluateLaneWorkerRefusal,
	filterToolNamesForCapability,
	type LaneWorkerRefusal,
	type ModelCapabilityProfile,
} from "./model-capability.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { isLocalOrManagedRouterModel } from "./model-router/tool-escalation.ts";
import { formatModelRouterModel, ModelRouterController } from "./model-router-controller.ts";
import { ModelSelectionController } from "./model-selection-controller.ts";
import { ModelAdaptationStore } from "./models/adaptation-store.ts";
import type { StoredFitnessReport } from "./models/fitness-store.ts";
import type { PrismLlamaCppRuntime } from "./models/llamacpp-runtime.ts";
import { HF_TRANSFORMERS_PROVIDER, OLLAMA_PROVIDER } from "./models/local-registration.ts";
import type { LocalRuntimeDeps, OllamaRuntime, TransformersRuntime } from "./models/local-runtime.ts";
import {
	DEFAULT_ADAPTIVE_STREAM_IDLE_CEILING_MS,
	estimateContextPromptTokens,
	resolveAdaptiveStreamIdleOptions,
	withModelPerfProfile,
} from "./models/perf-profile.ts";
import type { OrchestrationProfile } from "./orchestration/contracts.ts";
import { resolveConfiguredOrchestrationModel } from "./orchestration/model-binding.ts";
import { validateOrchestrationProfile } from "./orchestration/profile-registry.ts";
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
import { SessionAnalytics, type ToolArgumentValidationStats } from "./session-analytics.ts";
import { getActiveSessionBranchEntries } from "./session-snapshot.ts";
import { SessionTreeNavigator } from "./session-tree-navigator.ts";
import type { ResourceProfileFilterSettings, SettingsManager } from "./settings-manager.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { SystemPromptBuilder } from "./system-prompt-builder.ts";
import { appendTaskStepsStateSnapshot, getLatestTaskStepsStateSnapshot } from "./tasks/session-task-state.ts";
import { formatTaskStepsContext, type TaskStepsState } from "./tasks/task-state.ts";
import { ToolGateController } from "./tool-gate-controller.ts";
import { type ToolProbeReport, type ToolProbeResult, ToolProtocolController } from "./tool-protocol-controller.ts";
import { TOOL_RECOVERY_EVENT_LOG_FILE } from "./tool-recovery-log-records.ts";
import { ToolRecoveryLogger } from "./tool-recovery-logger.ts";
import { ToolPerformanceStore } from "./tool-selection/tool-performance-store.ts";
import { formatToolSelectionReport, ToolSelectionController } from "./tool-selection/tool-selection-controller.ts";
import type { BashOperations } from "./tools/bash.ts";
import { disposePersistentShellSession } from "./tools/shell-session.ts";

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
	| { type: "routing_end" }
	| {
			type: "delegate_workers";
			active: number;
			queued: number;
			running: number;
			completedSinceFlush: number;
			failedSinceFlush: number;
			terminalSinceFlush: Array<{
				laneId: string;
				status: LaneTerminalStatus;
				reasonCode?: string;
			}>;
	  };

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
	scopedModels?: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;
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
	/** Immutable owner-authored orchestration policy; dispatch cannot mutate it. */
	orchestrationProfile?: OrchestrationProfile;
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

export type { ToolProbeReport, ToolProbeResult, ToolProbeVerdict } from "./tool-protocol-controller.ts";

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

/** Session statistics for /session command */
export interface CompactionGateCheckStats {
	failures: number;
	minScore?: number;
	maxScore?: number;
	threshold?: number;
	comparator?: "minimum" | "maximum";
}

export interface CompactionGateStats {
	gateFailures: number;
	deterministicGapFills: number;
	compactionsWithGateFailures: number;
	checks: Record<string, CompactionGateCheckStats>;
}

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
	toolArgumentValidation: ToolArgumentValidationStats;
	compactionGates: CompactionGateStats;
}

/** customType for spawned-usage roll-up entries (Cost Aggregation, Model A). */
export const SPAWNED_USAGE_CUSTOM_TYPE = "spawned_usage";

/**
 * customType for a persisted runaway-loop-backstop entry: the agent loop stopped a turn stuck
 * repeating one identical tool-call signature. This is the session-log/telemetry sink for
 * {@link Agent.onRunawayStop} — see `_installAgentToolHooks`.
 */
export const RUNAWAY_STOP_CUSTOM_TYPE = "runaway_stop";

/** Payload persisted for a {@link RUNAWAY_STOP_CUSTOM_TYPE} entry. */
export interface RunawayStopRecord {
	signature: string;
	repeats: number;
	model?: string;
	provider?: string;
	at: string;
}

/**
 * customType for a persisted tool-validation-escalation entry: the agent loop bounced the same
 * tool-call validation failure enough times to escalate. This is the session-log/telemetry sink for
 * {@link Agent.onToolValidationEscalation} — see `_installAgentToolHooks`.
 */
export const TOOL_VALIDATION_ESCALATION_CUSTOM_TYPE = "tool_validation_escalation";

/** Payload persisted for a {@link TOOL_VALIDATION_ESCALATION_CUSTOM_TYPE} entry. */
export interface ToolValidationEscalationRecord {
	tool: string;
	signature: string;
	repeats: number;
	model: string;
	provider: string;
	at: string;
}

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
 * Options for {@link AgentSession.runIsolatedCompletion} — an LLM call fully isolated from the main
 * session. With no tools it is one-shot (reflection); lane callers may supply a bounded child loop.
 */
export interface IsolatedCompletionOptions {
	/** System prompt for the isolated call. */
	systemPrompt: string;
	/** The isolated conversation (e.g. the reflection prompt). NOT the main session history. */
	messages: Message[];
	/** Model to use. Defaults to the session model; callers should pass a cheap model. */
	model?: Model<Api>;
	/** Thinking level. Defaults to "off" to keep the call cheap. */
	thinkingLevel?: ThinkingLevel;
	/** Output token cap. */
	maxTokens?: number;
	/** Fresh tools owned by the isolated child. Omitted/empty preserves one-shot behavior. */
	tools?: AgentTool[];
	/** Maximum assistant turns for a tool-enabled child loop. Ignored by one-shot calls. */
	maxTurns?: number;
	/**
	 * Optional tool-free finalization prompt. When the bounded child loop exhausts its turns on an
	 * assistant tool-call message with no text, one final provider call receives the gathered transcript
	 * plus this prompt so useful work is not discarded solely for lacking a terminal summary.
	 */
	finalTextPrompt?: string;
	/** Child-only capability/path gate. Never inherited from the foreground session. */
	beforeToolCall?: AgentLoopConfig["beforeToolCall"];
	/** Child-only result observer (for example, successful scoped-write accounting). */
	afterToolCall?: AgentLoopConfig["afterToolCall"];
	/** Abort signal. */
	signal?: AbortSignal;
	/**
	 * Prompt-cache retention for this isolated call. REQUIRED — the provider-level default is
	 * `"short"`, the opposite of this primitive's old implicit default, so a caller that forgot to
	 * set it would silently pay full input price forever. Pass `"none"` explicitly to preserve full
	 * isolation (no caching); callers whose `systemPrompt` is STATIC across calls (e.g. reflection,
	 * #33) should pass `"short"`/`"long"` so the provider reuses the cached prefix and bills only the
	 * variable tail.
	 */
	cacheRetention: CacheRetention;
	/**
	 * Lane/caller kind (e.g. `"reflection"`, `"research"`, `"worker"`, `"fitness"`) used to derive this
	 * call's synthetic cache-affinity key (see {@link computeLaneAffinityKey}). Omitted callers fall
	 * back to {@link DEFAULT_ISOLATED_LANE_KIND} — still a stable, namespaced key, just not
	 * lane-differentiated. Never the real session id.
	 */
	laneKind?: string;
}

/** Fallback {@link IsolatedCompletionOptions.laneKind} for callers that do not tag their lane. */
export const DEFAULT_ISOLATED_LANE_KIND = "isolated";

/**
 * Derive a STABLE synthetic cache-affinity key for an isolated completion lane. Isolated calls
 * deliberately never carry the real session id (see reflection-controller.ts's isolation invariants —
 * an isolated call must not entangle with the main session), which today also means every isolated
 * call looks like a brand-new, uncorrelated session to providers with session-affinity headers /
 * `prompt_cache_key` (anthropic.ts's `x-session-affinity`, openai-responses.ts /
 * openai-completions.ts's `prompt_cache_key`), defeating their cache routing.
 *
 * This key is deterministic per `(laneKind, model, systemPrompt)` — the SAME lane calling the SAME
 * model with the SAME (static) system prompt always gets the SAME key, so repeat calls route to the
 * same cache-warm backend — while remaining fully synthetic: it is a salted hash, namespaced with a
 * `lane:` prefix, and never derived from or equal to the real session id.
 */
export function computeLaneAffinityKey(laneKind: string, model: Model<Api> | undefined, systemPrompt: string): string {
	const modelKey = model ? `${model.provider}/${model.id}` : "unknown-model";
	// NUL-separated fields: laneKind/modelKey are drawn from small caller-controlled vocabularies
	// that never contain a raw NUL, so this cannot field-collide the way a plain colon/space join could.
	const digest = createHash("sha256")
		.update(["pi-lane-affinity-v1", laneKind, modelKey, systemPrompt].join("\u0000"))
		.digest("hex")
		.slice(0, 32);
	return `lane:${laneKind}:${digest}`;
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
	| "goal_state_not_advanced"
	| "goal_budget_exhausted"
	// Skip outcomes from the BackgroundLaneController single-flight guard (`continueGoalLoopExclusive`):
	// the loop never ran a pass because another goal loop already owned the mutex, or the session was
	// disposed before this request could start. `turnsSubmitted` is always 0 for both.
	| "already_continuing"
	| "session_disposed"
	// Capability-adaptive skip: the session's ACTIVE tool surface lacks the `goal` tool (lean
	// capability blocklist, worker role ceiling, --tools/profile exclusion), so continuation
	// prompts cannot be executed by this session -- driving them anyway would enforce complex
	// agentic work on a surface that cannot perform it. Covers idle autosteer AND manual
	// /goal continuation (both funnel through the same single-flight guard). `turnsSubmitted` 0.
	| "goal_tool_unavailable"
	// A worker is dispatched (queued/running) against an open requirement this goal owns — the
	// loop paused WITHOUT submitting a pass (never reaches `goal_state_not_advanced`) and will resume
	// on its own once the worker terminates. Distinct from `continuation_not_allowed` (which reads as
	// a terminal refusal needing a human/new decision) — this is a benign, self-resolving wait.
	| "worker_in_flight";

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

	private _scopedModels: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _extensionsChangedListeners: Array<() => void> = [];

	private _steeringMessages: string[] = [];
	private _followUpMessages: string[] = [];
	private _queuedExtensionCommands: string[] = [];
	private _pendingNextTurnMessages: CustomMessage[] = [];
	private _streamingPromptSubmissionTail: Promise<void> = Promise.resolve();
	/**
	 * The last tool set requested via setActiveToolsByName BEFORE model-capability filtering, so
	 * switching from a small-window model back to a large one restores the full requested set.
	 */
	private _requestedActiveToolNames: string[] | undefined;

	private _unboundToolGrantWarnings: string[] = [];

	private _branchSummaryAbortController: AbortController | undefined = undefined;

	private readonly _modelSelection: ModelSelectionController;
	private readonly _bash: BashExecutionController;
	private readonly _profileFilter: ProfileFilterController;
	private readonly _toolGate: ToolGateController;
	private readonly _toolSelection: ToolSelectionController;

	private _extensionRunner!: ExtensionRunner;
	private _turnIndex = 0;
	private _currentForegroundEnvelope?: CapabilityEnvelope;

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _cwd: string;
	/** Per-agent persistent shell session identity: stable across runtime reloads, disposed with the session. */
	private readonly _shellSessionKey = `agent:${randomUUID()}`;
	private _agentDir: string;
	private _collectWorkspaceSources: typeof collectWorkspaceSources;
	private readonly _localRuntimeController: LocalRuntimeController;
	private readonly _toolProtocol: ToolProtocolController;
	private _prefixWarmer:
		| { modelKey: string; controller: AbortController; timer: NodeJS.Timeout | undefined }
		| undefined;
	private readonly _completedPrefixWarms = new Set<string>();
	/** Assembles the session's base system prompt from live session state (see
	 * system-prompt-builder.ts); owns the paired _baseSystemPromptOptions. */
	private readonly _systemPromptBuilder: SystemPromptBuilder;
	/** Autonomy telemetry sink + status/diagnostic snapshots (see autonomy-telemetry.ts); owns
	 * the latest gate outcome and the bounded gate-outcome history. */
	private readonly _autonomyTelemetry: AutonomyTelemetry;
	/** Goal auto-continue + research lane + profile-bound worker delegation + model-fitness probe (see
	 * background-lane-controller.ts); owns the lane timers/guards, the last research-lane skip
	 * reason, the live LaneTracker, and the in-flight research/worker abort controllers. */
	private readonly _backgroundLanes: BackgroundLaneController;
	/** Plug-and-play memory subsystem (see memory-controller.ts); owns the OKF retrieval provider, the
	 * latest retrieval/prompt-inclusion reports, the reload-safe MemoryManager, the recall
	 * effectiveness tracker, and the extension-contributed pending providers. */
	private readonly _memory: MemoryController;
	private readonly _compactionSupport: CompactionSupport;
	private readonly _compaction: CompactionController;
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
	private readonly _gatewayRegistry = new GatewayRegistry();
	/** Usage/cost/stats accounting, /context estimate, and session export (see session-analytics.ts);
	 * owns the spawned-usage and daily-usage memo caches. */
	private readonly _analytics: SessionAnalytics;
	private readonly _treeNavigator: SessionTreeNavigator;
	private _lastCostGuardDecision?: CostGuardDecision;
	/**
	 * `getSpawnedUsage().cost` snapshotted at the start of the CURRENT foreground prompt cycle (see
	 * `_promptUnserialized`), so the cost guard can attribute only background/spawned spend since THIS
	 * turn began, not the session's entire lifetime spend. Reset on every new user prompt; every
	 * round-trip within the same turn (tool-call iterations) shares this one baseline.
	 */
	private _costGuardTurnBaselineUsd = 0;
	/** Per-turn model-router subsystem (see model-router-controller.ts); owns the transient route/intent,
	 * the cheap-turn session buffer, the escalation/retry flags, and the sticky last-decision/skip-reason
	 * used by the status report. Its parallel routed drive path delegates every turn back to
	 * {@link _runAgentPrompt} so the drive loop stays host-side. */
	private readonly _modelRouter: ModelRouterController;
	private readonly _foregroundRecovery: ForegroundRecoveryController;
	private readonly _failureCorpus: FailureCorpusRecorder;
	private readonly _toolRecoveryLogger: ToolRecoveryLogger;
	private readonly _toolRecoveryEventLogPath: string;
	private _skillCuratorInstance?: SkillCurator;
	private _disposed = false;
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
		// ForegroundRecoveryController routes into the existing auto-retry path. Wrapped exactly once, here.
		// The wrapper reports the stall immediately and aborts the inner request; releasing the
		// inner pump relies on the provider ending its stream after abort (real providers do — see
		// withStreamIdleWatchdog's contract), so no extra drain is added at this wiring site.
		// Wrapping also breaks the `streamFn === streamSimple` identity the auth-injection checks
		// use, so the wrapper carries a rawness marker that _isRawStreamSimple reads.
		const agentDir = config.agentDir ?? getAgentDir();
		const modelAdaptationStore = ModelAdaptationStore.forAgentDir(agentDir);
		const baseStreamFn = this.agent.streamFn;
		const previousResolveRequestReasoning = this.agent.resolveRequestReasoning?.bind(this.agent);
		this.agent.resolveRequestReasoning = (reasoning, request) => {
			const resolvedReasoning = previousResolveRequestReasoning
				? previousResolveRequestReasoning(reasoning, request)
				: reasoning;
			return this._resolveCostGuardRequestReasoning(
				request.model,
				request.context,
				resolvedReasoning,
				request.maxTokens,
			);
		};
		const profiledStreamFn = withModelPerfProfile(baseStreamFn, {
			modelKey: (model) => formatModelRouterModel(model),
			recordSample: (modelKey, sample) => {
				modelAdaptationStore.recordPerfSample(modelKey, sample);
			},
		});
		// `this.settingsManager` is assigned below; the resolver closes over the config reference
		// because the wrapper must be installed before that assignment runs.
		const stallSettingsSource = config.settingsManager;
		this.agent.streamFn = tagRawness(
			withStreamIdleWatchdog(profiledStreamFn, (model, context) => {
				const configured = {
					...stallSettingsSource.getStreamStallSettings(),
					...streamIdleOptionsOverride,
				};
				const httpIdleTimeoutMs = stallSettingsSource.getHttpIdleTimeoutMs();
				const httpBounded = constrainStreamIdleToHttpTimeout(
					{ ...DEFAULT_STREAM_IDLE, ...configured },
					httpIdleTimeoutMs,
				);
				const profile = modelAdaptationStore.get(formatModelRouterModel(model)).perf;
				const adaptive = resolveAdaptiveStreamIdleOptions({
					base: httpBounded.options,
					profile,
					promptTokens: estimateContextPromptTokens(context),
					localClass: this._isWarmableLocalModel(model),
					ceilingMs: httpBounded.adaptiveCeilingMs ?? DEFAULT_ADAPTIVE_STREAM_IDLE_CEILING_MS,
				});
				return { ...httpBounded.options, ...adaptive };
			}),
			baseStreamFn === streamSimple,
		);
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		if (config.orchestrationProfile) {
			validateOrchestrationProfile(config.orchestrationProfile);
			const resolved = resolveConfiguredOrchestrationModel(config.orchestrationProfile, config.modelRegistry);
			if (!resolved) {
				throw new TypeError(
					`Orchestration profile '${config.orchestrationProfile.profileId}' has no configured, authenticated model that supports its exact thinking level.`,
				);
			}
			if (!this.agent.state.model || !modelsAreEqual(this.agent.state.model, resolved.model)) {
				this.sessionManager.appendModelChange(resolved.model.provider, resolved.model.id);
			}
			if (this.agent.state.thinkingLevel !== resolved.binding.thinkingLevel) {
				this.sessionManager.appendThinkingLevelChange(resolved.binding.thinkingLevel as ThinkingLevel);
			}
			this.agent.state.model = resolved.model;
			this.agent.state.thinkingLevel = resolved.binding.thinkingLevel as ThinkingLevel;
			this.settingsManager.setRuntimeResourceProfiles([...config.orchestrationProfile.resourceProfileNames]);
		}
		this._scopedModels = config.orchestrationProfile
			? [{ model: this.agent.state.model, thinkingLevel: this.agent.state.thinkingLevel }]
			: (config.scopedModels ?? []);
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._agentDir = agentDir;
		this._toolProtocol = new ToolProtocolController({
			agent: this.agent,
			agentDir: this._agentDir,
			settingsManager: this.settingsManager,
			getModelRegistry: () => this._modelRegistry,
			adaptationStore: modelAdaptationStore,
			isRawStreamSimple: (fn) => this._isRawStreamSimple(fn),
			getRequiredRequestAuth: (model) => this._getRequiredRequestAuth(model),
			addSpawnedUsage: (usage, opts) => this.addSpawnedUsage(usage, opts),
			emitWarning: (message) => this._emit({ type: "warning", message }),
			sendCorrectiveSteer: (message) =>
				this.sendCustomMessage(
					{ customType: "text-protocol-corrective-steer", content: message, display: false },
					{ deliverAs: "nextTurn" },
				),
			findLastAssistantMessage: () => this._findLastAssistantMessage(),
			isDisposed: () => this._disposed,
			probeForAuto: (model) => this._probeToolCallingForModel(model),
		});
		this.agent.onTextToolProtocolParse = (event) => this._toolProtocol.handleTextProtocolParse(event);
		this._toolProtocol.applyRepairLayerSettings();
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
			getModelAdaptationRules: () => this._toolProtocol.getAdaptationRulesForPrompt(),
			getActiveExtensions: () => this._extensionRunner.activeExtensions,
			getContextWindow: () => this.model?.contextWindow,
			getThinkingLevel: () => this.thinkingLevel,
			// The evidence-gated tool-selection hint block — self-gated by kill switch/evidence
			// thresholds inside getActiveHints() itself, so this is a plain always-on pass-through.
			getToolSelectionHints: () => this._toolSelection.getActiveHints(),
		});
		this._autonomyTelemetry = new AutonomyTelemetry({
			getSessionManager: () => this.sessionManager,
			getLastModelRouterDecision: () => this._modelRouter.getLastDecision(),
			getLastResearchLaneSkipReason: () => this._backgroundLanes.getLastResearchLaneSkipReason(),
			getCostSummary: () => this.getCostSummary(),
			getGoalStateSnapshot: () => this.getGoalStateSnapshot(),
			getActiveLaneCount: () => this._backgroundLanes.getActiveLaneCount(),
			getSessionEvidenceBundleHistory: () => getEvidenceBundleSnapshots(this.sessionManager.getEntries()),
			getSessionWorkerResultHistory: () => getWorkerResultSnapshots(this.sessionManager.getEntries()),
			getSessionLearningDecisionHistory: () => getLearningDecisionSnapshots(this.sessionManager.getEntries()),
			getLearningAuditRecords: () => this.getLearningAuditRecords(),
		});
		this._modelRegistry = config.modelRegistry;
		this._backgroundLanes = new BackgroundLaneController({
			isDisposed: () => this._disposed,
			isChildSession: () => this._isChildSession,
			getSessionId: () => this.sessionId,
			getCwd: () => this._cwd,
			getAgentDir: () => this._agentDir,
			getSessionManager: () => this.sessionManager,
			getSettingsManager: () => this.settingsManager,
			getActiveOrchestrationProfile: () => config.orchestrationProfile,
			getModelRegistry: () => this._modelRegistry,
			isModelExhausted: (model) => this._foregroundRecovery.isModelExhausted(`${model.provider}/${model.id}`),
			getModel: () => this.model ?? undefined,
			isDelegateToolActive: () => this.getActiveToolNames().includes("delegate"),
			isGoalToolActive: () => this.getActiveToolNames().includes("goal"),
			getCapabilityEnvelope: () => this.capabilityEnvelope,
			getModelCapabilityProfile: () => this.getModelCapabilityProfile(),
			emit: (event) => this._emit(event),
			notifyWorkerTerminalHandoff: (records) => this._notifyWorkerTerminalHandoff(records),
			emitAutonomyTelemetry: (event) => this._emitAutonomyTelemetry(event),
			getGoalStateSnapshot: () => this.getGoalStateSnapshot(),
			getGoalRuntimeSnapshot: (settings) => this.getGoalRuntimeSnapshot(settings),
			getEvidenceBundleSnapshot: () => this.getEvidenceBundleSnapshot(),
			saveEvidenceBundleSnapshot: (bundle) => this.saveEvidenceBundleSnapshot(bundle),
			saveWorkerResultSnapshot: (result, request) => this.saveWorkerResultSnapshot(result, request),
			readMemoryForLane: (query) => this._memory.readMemoryForLane(query),
			addSpawnedUsage: (usage, opts) => this.addSpawnedUsage(usage, opts),
			runIsolatedCompletion: (opts) => this.runIsolatedCompletion(opts),
			// RAW loop, deliberately bypassing the public `continueGoalLoop` — that method now delegates
			// to this controller's own `continueGoalLoopExclusive` guard, so routing through it here would
			// recurse into the guard from inside itself instead of driving the actual continuation pass.
			continueGoalLoop: (options) => this._goalContinuation.continueGoalLoop(options),
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
			getContextWindow: () => this.model?.contextWindow,
			getGoalState: () => this.getGoalStateSnapshot(),
		});
		this._compactionSupport = new CompactionSupport({
			getModel: () => this.model,
			getSettingsManager: () => this.settingsManager,
			getModelRegistry: () => this._modelRegistry,
			isRawStream: () => this._isRawStreamSimple(this.agent.streamFn),
			getRequiredRequestAuth: (model) => this._getRequiredRequestAuth(model),
			isModelExhausted: (ref) => this._foregroundRecovery.isModelExhausted(ref),
			getStoredFitnessReport: (ref) => this.getStoredFitnessReports().find((entry) => entry.model === ref)?.report,
			// Live context is an over-estimate of the span to summarize (includes the kept tail) —
			// conservative in the safe direction for the summarizer capacity check.
			estimateSummarizationInputTokens: () => this._pipeline.estimateCurrentContextTokens(this.agent.state.messages),
			emitWarning: (message) => this._emit({ type: "warning", message }),
			// Route a managed-local summarizer through the same readiness/residency gate every
			// other isolated consumer uses, so compact() never calls a local model that was never
			// confirmed up, installed, or resident (no-op for cloud models).
			ensureModelReady: (model) => this._localRuntimeController.ensureIsolatedModelReady(model),
		});
		this._pipeline = new ContextPipeline({
			getTurnIndex: () => this._turnIndex,
			getSessionManager: () => this.sessionManager,
			getSettingsManager: () => this.settingsManager,
			getModelRegistry: () => this._modelRegistry,
			getModel: () => this.model,
			getAgentDir: () => this._agentDir,
			getCwd: () => this._cwd,
			getActiveToolNames: () => this.getActiveToolNames(),
			isDisposed: () => this._disposed,
			getMemoryManager: () => this._memory.getMemoryManager(),
			addSpawnedUsage: (usage, opts) => this.addSpawnedUsage(usage, opts),
			runIsolatedCompletion: (opts) => this.runIsolatedCompletion(opts),
		});
		const failureCorpusPath = stateFile(this._agentDir, "failure-corpus.jsonl");
		this._toolRecoveryEventLogPath = stateFile(this._agentDir, TOOL_RECOVERY_EVENT_LOG_FILE);
		const toolRepairSettings = this._toolProtocol.getRepairSettings();
		this._failureCorpus = new FailureCorpusRecorder({
			filePath: failureCorpusPath,
		});
		this._compaction = new CompactionController({
			agent: this.agent,
			sessionManager: this.sessionManager,
			settingsManager: this.settingsManager,
			getModel: () => this.model,
			getAdaptedSettings: () => this._getAdaptedCompactionSettings(),
			getRequestAuth: (model) => this._getCompactionRequestAuth(model),
			resolveModelAndAuth: (compactionModel, sessionModel) =>
				this._resolveCompactionModelAndAuth(compactionModel, sessionModel),
			resolveModel: (sessionModel) => this._resolveCompactionModel(sessionModel),
			getSelectionReason: () => this._getLastCompactionSelectionReason(),
			resolveThinkingLevel: (compactionModel, sessionModel) =>
				this._resolveCompactionThinkingLevel(compactionModel, sessionModel),
			describeSummarizer: () => this._describeCompactionSummarizer(),
			getExtensionRunner: () => this._extensionRunner,
			isRawStream: () => this._isRawStreamSimple(this.agent.streamFn),
			disconnectAgent: () => this._disconnectFromAgent(),
			reconnectAgent: () => this._reconnectToAgent(),
			abortForeground: () => this.abort(),
			emit: (event) => this._emit(event),
			estimateCurrentContextTokens: (messages) => this._pipeline.estimateCurrentContextTokens(messages),
			buildPreDigest: () => this._buildCompactionPreDigest(),
			refreshAfterCompaction: () => this._refreshAfterCompaction(),
			getFailureCorpus: () => this._failureCorpus,
			measureLiveContextTokens: () => this._measureLiveContextTokensForCompaction(),
			runAutoCompaction: (reason, willRetry) => this._runAutoCompaction(reason, willRetry),
			compactWithRetry: (run, signal, provider) => this._compactWithRetry(run, signal, provider),
		});
		this._toolRecoveryLogger = new ToolRecoveryLogger({
			enabled: toolRepairSettings.logging,
			sessionId: this.sessionManager.getSessionId(),
			eventLogPath: this._toolRecoveryEventLogPath,
			failureCorpusPath,
		});
		this._foregroundRecovery = new ForegroundRecoveryController({
			agent: this.agent,
			modelRegistry: this._modelRegistry,
			settingsManager: this.settingsManager,
			failureCorpus: this._failureCorpus,
			getContextWindow: () => this.model?.contextWindow ?? 0,
			emit: (event) => this._emit(event),
			checkCompaction: (message) => this._checkCompaction(message),
			onSuccessfulAssistant: () => this._compaction.resetOverflowRecovery(),
		});
		this._modelRouter = new ModelRouterController({
			getAgent: () => this.agent,
			getModel: () => this.model ?? undefined,
			getSettingsManager: () => this.settingsManager,
			getSessionManager: () => this.sessionManager,
			getModelRegistry: () => this._modelRegistry,
			isModelExhausted: (model) => this._foregroundRecovery.isModelExhausted(`${model.provider}/${model.id}`),
			getFailoverStatus: () => ({
				...this._foregroundRecovery.getFailoverStatus(),
				failureStats: this._failureCorpus.stats(),
			}),
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
			getToolProbeVerdict: (model) => this._toolProtocol.getToolProbeVerdict(model),
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
			resolveTextToolCallProtocol: (model) => this._resolveModelToolProtocol(model).protocol,
			archivePromotedSkill: (name) => this.archivePromotedSkill(name),
			emitAutonomyTelemetry: (event) => this._emitAutonomyTelemetry(event),
			ensureModelReady: (model) => this._localRuntimeController.ensureIsolatedModelReady(model),
			addSpawnedUsage: (usage, opts) => this.addSpawnedUsage(usage, opts),
			saveLearningDecisionSnapshot: (decision) => this.saveLearningDecisionSnapshot(decision),
		});
		this._goalContinuation = new GoalLoopController({
			getGoalRuntimeSnapshot: (settings) => this.getGoalRuntimeSnapshot(settings),
			prompt: (text, options) => this.prompt(text, options),
			recordGoalContinuationPass: (pass) => this.recordGoalContinuationPass(pass),
		});
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.orchestrationProfile
			? [...config.orchestrationProfile.toolNames]
			: config.initialActiveToolNames;
		this._allowedToolNames = config.orchestrationProfile
			? new Set(config.orchestrationProfile.toolNames)
			: config.allowedToolNames
				? new Set(config.allowedToolNames)
				: undefined;
		this._excludedToolNames = config.orchestrationProfile
			? undefined
			: config.excludedToolNames
				? new Set(config.excludedToolNames)
				: undefined;
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
			getShellSessionKey: () => this._shellSessionKey,
			getAgentDir: () => this._agentDir,
			getSessionManager: () => this.sessionManager,
			getSettingsManager: () => this.settingsManager,
			getModelRegistry: () => this._modelRegistry,
			isModelExhausted: (model) => this._foregroundRecovery.isModelExhausted(`${model.provider}/${model.id}`),
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
			getOrchestrationProfile: () => config.orchestrationProfile,
			getExcludedToolNames: () => this._excludedToolNames,
			deriveToolProfileFilter: () => this._profileFilter.deriveToolProfileFilter(),
			isToolOrCommandAllowedByProfile: (name) => this._profileFilter.isToolOrCommandAllowedByProfile(name),
			filterExtensionsForRuntime: (extensions) => this._profileFilter.filterExtensionsForRuntime(extensions),
			setUnboundToolGrantWarnings: (warnings) => {
				this._unboundToolGrantWarnings = warnings;
			},
			getUnboundToolGrantWarnings: () => this._unboundToolGrantWarnings,
			createProfileFilterReloadSnapshot: () => this._profileFilter.createReloadSnapshot(),
			restoreProfileFilterReloadSnapshot: (snapshot) => this._profileFilter.restoreReloadSnapshot(snapshot),
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
			createMemoryReloadSnapshot: () => this._memory.createReloadSnapshot(),
			restoreMemoryReloadSnapshot: (snapshot) => this._memory.restoreReloadSnapshot(snapshot),
			initializeMemory: () => this._memory.initialize(),
			getGoalStateSnapshot: () => this.getGoalStateSnapshot(),
			saveGoalStateSnapshot: (state) => this.saveGoalStateSnapshot(state),
			getTaskStepsStateSnapshot: () => this.getTaskStepsStateSnapshot(),
			saveTaskStepsStateSnapshot: (state) => this.saveTaskStepsStateSnapshot(state),
			getContextGcReport: (messages) => this.getContextGcReport(messages),
			startWorkerDelegation: (request) => this._backgroundLanes.startWorkerDelegation(request),
			getOrchestrationProfileCatalog: () => this._backgroundLanes.getOrchestrationProfileCatalog(),
			getWorkerLaneRecords: () => this._backgroundLanes.getLaneRecords(),
			getWorkerResultSnapshots: () => this.getWorkerResultSnapshots(),
			resolveManagedLaneId: (id) => this._backgroundLanes.resolveManagedLaneId(id),
			runWorkerDelegationOnce: (request) => this.runWorkerDelegationOnce(request),
			runModelFitness: (args) => this.runModelFitness(args),
			resolveCurationModelIfFit: () => this._resolveCurationModelIfFit(),
			runIsolatedCompletion: (opts) => this.runIsolatedCompletion(opts),
			addSpawnedUsage: (usage, opts) => this.addSpawnedUsage(usage, opts),
			getLaneWorkerRefusal: () => this.getLaneWorkerRefusal(),
			createAgentContextSnapshot: () => this._createAgentContextSnapshot(),
			getContextUsage: () => this.getContextUsage(),
			isStreaming: () => this.isStreaming,
			isCompacting: () => this.isCompacting,
			getExtensionUIContext: () => this._extensionUIContext,
			getExtensionCommandContextActions: () => this._extensionCommandContextActions,
			getExtensionShutdownHandler: () => this._extensionShutdownHandler,
			getExtensionErrorListener: () => this._extensionErrorListener,
			// Stop any pi-spawned local runtime the just-committed reload no longer routes to.
			reconcileLocalRuntimes: () => {
				this._localRuntimeController.reconcile(this._collectEligibleLocalModelsForReconcile());
			},
		});
		this._analytics = new SessionAnalytics({
			getState: () => this.state,
			getMessages: () => this.messages,
			getModel: () => this.model,
			getSessionManager: () => this.sessionManager,
			getSettingsManager: () => this.settingsManager,
			getToolDefinition: (name) => this.getToolDefinition(name),
			getToolRecoveryEventLogPath: () => this._toolRecoveryEventLogPath,
		});
		const previousToolArgumentValidation = this.agent.onToolArgumentValidation;
		this.agent.onToolArgumentValidation = (event) => {
			const taggedEvent = this._toolProtocol.tagAdaptationRuleTeaching(event);
			if (taggedEvent.outcome === "repaired" || taggedEvent.outcome === "bounced") {
				this._toolSelection.recordValidation(taggedEvent.tool, taggedEvent.outcome);
			}
			previousToolArgumentValidation?.(taggedEvent);
			const logRecord = this._toolRecoveryLogger.recordToolArgumentValidation(taggedEvent);
			if (!logRecord) return;
			this._analytics.recordToolArgumentValidation(logRecord);
			this._toolProtocol.handleValidationOutcome(taggedEvent);
			this._toolProtocol.handleAdaptationTelemetry(taggedEvent);
		};
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
			refreshBaseSystemPrompt: () => this._refreshBaseSystemPrompt(),
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
			getShellSessionKey: () => this._shellSessionKey,
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
			setThinkingLevel: (level) => this.setThinkingLevel(level, { persistSettings: false }),
		});
		this._toolSelection = new ToolSelectionController({
			store: ToolPerformanceStore.forAgentDir(this._agentDir),
			getModelRef: () => {
				const model = this.model;
				return model ? formatModelRouterModel(model) : "unknown";
			},
			getActiveTools: () => {
				const activeNames = new Set(this.getActiveToolNames());
				return this.getAllTools()
					.filter((tool) => activeNames.has(tool.name))
					.map((tool) => ({
						name: tool.name,
						description: tool.description,
						parameters: tool.parameters,
					}));
			},
			isCandidateAllowed: (toolName) => {
				const envelope = this.capabilityEnvelope;
				if (!envelope) return true;
				return (
					evaluateToolGate({
						toolName,
						args: {},
						cwd: this._cwd,
						envelope,
					}).outcome === "allow"
				);
			},
		});
		this._toolGate = new ToolGateController({
			maybeEscalateToolCall: (toolName, args) => this._modelRouter.maybeEscalateToolCall(toolName, args),
			getCwd: () => this._cwd,
			getCapabilityEnvelope: () => this.capabilityEnvelope,
			recordGateOutcome: (outcome) => this._recordGateOutcome(outcome),
			getExtensionRunner: () => this._extensionRunner,
			getToolSelectionController: () => this._toolSelection,
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
		this._scheduleLocalPrefixWarm(this.agent.state.model, "session-start");
	}

	/** Model registry for API key resolution and model discovery */
	get modelRegistry(): ModelRegistry {
		return this._modelRegistry;
	}

	private _scheduleLocalPrefixWarm(model: Model<Api> | undefined, _reason: "session-start" | "selection"): void {
		if (!model || !this._isWarmableLocalModel(model)) return;
		const modelKey = formatModelRouterModel(model);
		if (this._completedPrefixWarms.has(modelKey) || this._prefixWarmer?.modelKey === modelKey) return;
		this._cancelPrefixWarm();
		const controller = new AbortController();
		const timer = setTimeout(() => {
			const warmer = this._prefixWarmer;
			if (!warmer || warmer.controller !== controller || controller.signal.aborted) return;
			warmer.timer = undefined;
			void this._runLocalPrefixWarm(model, modelKey, controller);
		}, 0);
		timer.unref?.();
		this._prefixWarmer = { modelKey, controller, timer };
	}

	private _cancelPrefixWarm(): void {
		const warmer = this._prefixWarmer;
		if (!warmer) return;
		if (warmer.timer) clearTimeout(warmer.timer);
		warmer.controller.abort(new Error("prefix warmer preempted"));
		this._prefixWarmer = undefined;
	}

	private async _runLocalPrefixWarm(model: Model<Api>, modelKey: string, controller: AbortController): Promise<void> {
		try {
			const options: SimpleStreamOptions = {
				maxTokens: 1,
				signal: controller.signal,
				onPayload: this.agent.onPayload,
				onResponse: this.agent.onResponse,
			};
			if (this._isRawStreamSimple(this.agent.streamFn)) {
				const auth = await this._getRequiredRequestAuth(model);
				options.apiKey = auth.apiKey;
				options.headers = auth.headers;
			}
			if (controller.signal.aborted) return;
			if (model.provider === OLLAMA_PROVIDER || model.provider === HF_TRANSFORMERS_PROVIDER) {
				await this._localRuntimeController.ensureIsolatedModelReady(model);
			}
			if (controller.signal.aborted) return;
			const stream = await this.agent.streamFn(
				model,
				{
					systemPrompt: this._baseSystemPrompt,
					tools: this.agent.state.tools,
					messages: [],
				},
				options,
			);
			await stream.result();
			if (!controller.signal.aborted) this._completedPrefixWarms.add(modelKey);
		} catch {
			// Best-effort cache warm only; a miss must never affect the real turn.
		} finally {
			if (this._prefixWarmer?.controller === controller) this._prefixWarmer = undefined;
		}
	}

	private _isWarmableLocalModel(model: Model<Api>): boolean {
		if (model.api !== "openai-completions") return false;
		try {
			const hostname = new URL(model.baseUrl).hostname.toLowerCase();
			return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
		} catch {
			return false;
		}
	}

	/**
	 * True when the session's stream fn is the raw `streamSimple` provider entry (directly, or as the
	 * base wrapped by the idle watchdog at construction). Callers use this to decide whether request
	 * auth must be injected explicitly — see {@link RAW_STREAM_MARKER}.
	 */
	private _isRawStreamSimple(fn: StreamFn): boolean {
		return fn === streamSimple || (fn as { [RAW_STREAM_MARKER]?: boolean })[RAW_STREAM_MARKER] === true;
	}

	private async _getRequiredRequestAuth(model: Model<Api>): Promise<{
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

	// Summarizer model/thinking selection, request auth (with session-model fallback), and
	// window-adapted settings live in CompactionSupport (see compaction-support.ts).
	private _getCompactionRequestAuth(model: Model<Api>): Promise<{
		apiKey?: string;
		headers?: Record<string, string>;
	}> {
		return this._compactionSupport.getRequestAuth(model);
	}

	private _resolveCompactionModelAndAuth(
		compactionModel: Model<Api>,
		sessionModel: Model<Api>,
	): Promise<{ model: Model<Api>; apiKey?: string; headers?: Record<string, string>; failure?: string }> {
		return this._compactionSupport.resolveModelAndAuth(compactionModel, sessionModel);
	}

	private _resolveCompactionModel(sessionModel: Model<Api>): Model<Api> {
		return this._compactionSupport.resolveModel(sessionModel);
	}

	/**
	 * One bounded diagnostic clause for compaction retry warnings: which summarizer selection won
	 * (and why) plus the input-size estimate the capacity check consumed — the two facts every
	 * gate-failure post-mortem has needed (2026-07-06 field incidents).
	 */
	private _describeCompactionSummarizer(): string {
		const reason = this._compactionSupport.getLastSelectionReason() ?? "unresolved";
		const estimate = this._pipeline.estimateCurrentContextTokens(this.agent.state.messages);
		return `summarizer: ${reason}, ~${Math.ceil(estimate / 1000)}k est input`;
	}

	private _getLastCompactionSelectionReason(): string | undefined {
		return this._compactionSupport.getLastSelectionReason();
	}

	private _resolveCompactionThinkingLevel(
		compactionModel: Model<Api>,
		sessionModel: Model<Api>,
	): ThinkingLevel | undefined {
		return this._compactionSupport.resolveThinkingLevel(this.thinkingLevel, compactionModel, sessionModel);
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
				if (
					!this.isCompacting &&
					(await this._compaction.maybeCompactBeforeContextTransform(
						authoritativeMessages,
						(messages) => this._applyContextGc(messages, false).messages,
					))
				) {
					currentMessages = this.agent.state.messages.slice();
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
			return gcMessages;
		};
	}

	/**
	 * Resolve the foreground request's cost policy after routing/context conversion, when the actual
	 * model, full system prompt, converted messages, and tool schemas are known. The guard is a
	 * projection threshold rather than a hard output cap: warning mode never reduces capability, while
	 * opt-in downgrade changes only this request's reasoning effort. Best-effort: never throws.
	 *
	 * The ceiling is turn-cumulative: the next foreground call's projection is folded together with
	 * background/research/worker/reflection spend recorded SINCE THIS TURN BEGAN — {@link getSpawnedUsage}'s
	 * already-recorded rollup (the same read-side-deduped total the footer's SUBAGENTS line uses) minus the
	 * baseline snapshotted before a new turn enters routing in `_promptUnserialized`
	 * ({@link _costGuardTurnBaselineUsd}) — so a
	 * turn that is cheap in the foreground but has spent heavily via background lanes THIS turn still trips
	 * the warning, while a prior turn's background spend does not keep every later turn's guard stuck
	 * "over". A background lane that finishes mid-turn is attributed to whichever turn it completes in.
	 * Per-lane dollar caps (research/worker `maxUsd`) are separate and untouched by this guard.
	 */
	private _resolveCostGuardRequestReasoning(
		model: Model<Api>,
		context: Context,
		reasoning: SimpleStreamOptions["reasoning"],
		requestMaxTokens: number | undefined,
	): SimpleStreamOptions["reasoning"] {
		try {
			const guard = this.settingsManager.getCostGuardSettings();
			const isChatGptSubscription = model.provider === "openai-codex" && this._modelRegistry.isUsingOAuth(model);
			if (guard.maxTurnUsd <= 0 || !model.cost || isChatGptSubscription) {
				this._lastCostGuardDecision = undefined;
				return reasoning;
			}
			const inputTokens = estimateContextPromptTokens(context);
			// Use an explicit request cap when present; otherwise project against the session response
			// reserve instead of a frontier model's theoretical 128K output maximum.
			const maxOutputTokens = Math.min(
				model.maxTokens ?? 4096,
				requestMaxTokens ?? this.settingsManager.getCompactionReserveTokens(),
			);
			const estUsd = estimateTurnCostUsd({
				inputTokens,
				maxOutputTokens,
				cost: model.cost,
				longContextPricing: model.longContextPricing,
			});
			// Only spend recorded SINCE this turn's baseline counts -- never negative (a dedup/rollup
			// correction could otherwise move the total backward transiently).
			const cumulativeBackgroundUsd = Math.max(0, this.getSpawnedUsage().cost - this._costGuardTurnBaselineUsd);
			const decision = evaluateCostGuard(
				estUsd,
				{ maxTurnUsd: guard.maxTurnUsd, action: guard.action },
				cumulativeBackgroundUsd,
			);
			this._lastCostGuardDecision = decision;
			if (!decision.over || guard.action !== "downgrade" || reasoning === undefined) return reasoning;
			const next = downgradeReasoning(reasoning, getSupportedThinkingLevels(model), model.thinkingLevelMap);
			return next as NonNullable<SimpleStreamOptions["reasoning"]>;
		} catch {
			// cost guard must never disrupt a turn
			return reasoning;
		}
	}

	/** Latest cost-guard decision (for the host footer/UI to surface a warning). Undefined if disabled. */
	getLastCostGuardDecision(): CostGuardDecision | undefined {
		return this._lastCostGuardDecision;
	}

	private get _skillCurator(): SkillCurator {
		if (!this._skillCuratorInstance) {
			this._skillCuratorInstance = new SkillCurator(resourceDir("skills", this._agentDir));
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

	/** Compatibility seam retained for focused auto-probe regressions. */
	private _probeToolCallingForModel(model: Model<Api>): Promise<ToolProbeResult> {
		return this._toolProtocol.probeToolCallingForModel(model);
	}

	/** Compatibility seam retained for focused protocol-selection doctrine regressions. */
	private _resolveModelToolProtocol(model: Model<Api>) {
		return this._toolProtocol.resolveModelToolProtocol(model);
	}

	async probeToolCalling(target?: string): Promise<ToolProbeReport> {
		return this._toolProtocol.probeToolCalling(target);
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

	/** Drop provider-owned request/continuation caches whose prefix was invalidated by compaction. */
	private _refreshAfterCompaction(): void {
		this.agent.state.messages = this.sessionManager.buildSessionContext().messages;
		try {
			cleanupSessionResources(this.sessionId);
		} catch {
			// Provider cache cleanup is best-effort and must not turn an applied compaction into a failure.
		}
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
				// Auto-built per-turn foreground envelope (observe-only; not enforced). Falls back to a
				// live preview when no turn has run yet so /context always shows the current scope.
				formatForegroundEnvelopeObservation(
					this._currentForegroundEnvelope ?? this._buildForegroundEnvelopeFromState(),
				),
				// A user disable always beats a profile grant — surface the conflict.
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

	formatToolRepairHealthReport(): string {
		return [
			this._toolProtocol.formatRepairHealth(this._toolRecoveryLogger.getStats()),
			formatToolSelectionReport(this._toolSelection.getReport()),
		].join("\n\n");
	}

	async flushToolRecoveryLogsForTests(timeoutMs = 1000): Promise<void> {
		await this._toolRecoveryLogger.flush(timeoutMs);
	}

	removeToolRepairRule(model: string, mode: string): boolean {
		return this._toolProtocol.removeRepairRule(model, mode);
	}

	resetToolProtocolCalibration(model: string): boolean {
		return this._toolProtocol.resetProtocolCalibration(model);
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

	private _installAgentToolHooks(): void {
		this.agent.beforeToolCall = this._toolGate.beforeToolCall;
		this.agent.afterToolCall = this._toolGate.afterToolCall;
		this.agent.onRunawayStop = (info) => this._handleRunawayStop(info);
		this.agent.onToolValidationEscalation = (event) => this._handleToolValidationEscalation(event);
	}

	/**
	 * The runaway-loop backstop ({@link Agent.maxStallTurns}) stopped a turn stuck repeating one
	 * identical tool-call signature. Previously silent — this is the first host handler. Records a
	 * session-log/telemetry entry (see {@link RUNAWAY_STOP_CUSTOM_TYPE}) and surfaces a user-visible
	 * warning through the same event the context-window/compaction backstops use.
	 */
	private _handleRunawayStop(info: { signature: string; repeats: number }): void {
		const record: RunawayStopRecord = {
			signature: info.signature,
			repeats: info.repeats,
			model: this.model?.id,
			provider: this.model?.provider,
			at: new Date().toISOString(),
		};
		this.sessionManager.appendCustomEntry(RUNAWAY_STOP_CUSTOM_TYPE, record);
		this._emit({
			type: "warning",
			message: `Stopped: the model repeated the same tool call ${info.repeats} times in a row without making progress. Review the last tool result and steer or retry with a different approach.`,
		});
	}

	/**
	 * Evidence-gated native→phone auto-probe for a LOCAL/MANAGED model (never cloud — see
	 * {@link isLocalOrManagedRouterModel}) that just crossed the tool-argument-validation escalation
	 * threshold — repeated identical validation failures with no successful native call in between,
	 * which is exactly the graded evidence {@link Agent.onToolValidationEscalation} already requires
	 * before firing. Runs the SAME probe `/toolprobe` uses ({@link _probeToolCallingForModel}: native
	 * trials first, so a model that can actually tool-call natively still resolves to verdict
	 * "native" and is never phoned) entirely OFF the hot path — fired here but never awaited by the
	 * caller, so a slow or failing probe can never block or throw the user's in-flight turn.
	 * Anti-loop: skipped when this session already auto-probed this model, or a fresh persisted
	 * verdict already exists (enforced by {@link ToolProtocolController}) — otherwise a model that keeps
	 * failing validation every turn would re-fire the (multi-completion) probe every single turn.
	 */
	private _maybeAutoProbeOnValidationEscalation(model: Model<Api>): void {
		this._toolProtocol.maybeAutoProbe(model);
	}

	/**
	 * A repeated identical tool-argument-validation failure crossed the escalation threshold
	 * ({@link Agent.toolValidationEscalationThreshold}) — the graded evidence the capability-gate
	 * spine acts on. Always records a session-log/telemetry entry (see {@link
	 * TOOL_VALIDATION_ESCALATION_CUSTOM_TYPE}), then branches on the failing model's class:
	 * - LOCAL/MANAGED ({@link isLocalOrManagedRouterModel}, never cloud): the failure is evidence the
	 *   model may lack native tool-calling, so it fires the evidence-gated native→phone auto-probe
	 *   off the hot path ({@link _maybeAutoProbeOnValidationEscalation}). Escalating a local model's
	 *   ROUTER TIER on a tool-call failure would not fix a capability problem, so this branch never
	 *   touches the model router.
	 * - CLOUD (known tool-capable): the failure is evidence the routed tier is too weak for this
	 *   request, so it escalates via {@link ModelRouterController.requestValidationFailureEscalation}
	 *   — de-conflated from the beforeToolCall mutation gate ({@link
	 *   ModelRouterController.maybeEscalateToolCall}/`shouldEscalateModelRouterTool`): repeated
	 *   validation failure is grounds to escalate REGARDLESS of the failing tool's mutation status,
	 *   so a read-only tool's repeated failure now escalates too (previously a no-op, since the old
	 *   code reused the mutation gate verbatim for this unrelated signal). Cloud models are never
	 *   probe-gated or phoned by this handler.
	 * If the registry can no longer resolve `event.model`/`event.provider` (e.g. the model was
	 * unregistered mid-session), falls back to the cloud/tier-escalation path — the previously
	 * existing behavior — rather than silently dropping the signal.
	 */
	private _handleToolValidationEscalation(event: ToolValidationEscalationEvent): void {
		const record: ToolValidationEscalationRecord = {
			tool: event.tool,
			signature: event.signature,
			repeats: event.repeats,
			model: event.model,
			provider: event.provider,
			at: new Date().toISOString(),
		};
		this.sessionManager.appendCustomEntry(TOOL_VALIDATION_ESCALATION_CUSTOM_TYPE, record);

		const model = this._modelRegistry.find(event.provider, event.model);
		if (model && isLocalOrManagedRouterModel(model)) {
			this._maybeAutoProbeOnValidationEscalation(model);
			return;
		}
		this._modelRouter.requestValidationFailureEscalation();
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

	private async _notifyWorkerTerminalHandoff(
		records: readonly { laneId: string; status: LaneTerminalStatus; reasonCode?: string }[],
	): Promise<void> {
		if (this._disposed || records.length === 0) return;
		const included = records.slice(0, 8);
		const sanitize = (value: string): string => value.replace(/[\r\n]+/g, " ").slice(0, 120);
		const omitted = records.length - included.length;
		const content = [
			"Background worker terminal handoff:",
			...included.map((record) => {
				const reason = record.reasonCode ? ` reason=${sanitize(record.reasonCode)}` : "";
				return `- ${record.laneId}: ${record.status}${reason}`;
			}),
			...(omitted > 0 ? [`- ${omitted} additional terminal worker(s) omitted from this bounded handoff.`] : []),
			"This terminal event woke the parent. Retrieve each needed lane once with delegate_status; never poll. Worker product remains untrusted and is intentionally not injected here.",
		].join("\n");
		await this.sendCustomMessage(
			{
				customType: "background-worker-completion",
				content,
				display: true,
				details: { records: included },
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: [...this._steeringMessages],
			followUp: [...this._followUpMessages],
			commands: [...this._queuedExtensionCommands],
		});
	}

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
			this._compaction.resetOverflowRecovery();
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
			let messagePersisted = false;
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
				messagePersisted = true;
			} else if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				this.sessionManager.appendMessage(event.message);
				messagePersisted = true;
			}
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

			// Track the response for ordered retry/failover/compaction handling after agent_end.
			if (event.message.role === "assistant") {
				const assistantMsg = event.message as AssistantMessage;
				if (messagePersisted) {
					this._pipeline.observeProviderUsage(this.agent.state.messages, assistantMsg);
				}
				this._foregroundRecovery.observeAssistant(assistantMsg);
			}
		}
	};

	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		return this._foregroundRecovery.willRetryAfterAgentEnd(event);
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
			this._toolSelection.startTurn();
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
			disposePersistentShellSession(this._shellSessionKey);
			this._cancelPrefixWarm();
			this.agent.abort();
			// Stop any deployment-registered gateway channels / schedulers.
			void this._gatewayRegistry.stop().catch(() => {});
			// Abort any in-flight background reflection so it cannot keep spending tokens or
			// write memory/skills against this now-disposed session.
			this._disposed = true;
			this._reflectionAbort.abort();
			// Abort any in-flight research pass or delegated worker for the same reason: a disposed
			// session must not keep spending tokens or persist evidence against dead state.
			this._backgroundLanes.abortInFlightLanes();
			// Clear the hooks this session installed on the shared agent so their closures stop
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
		// true session-end hook; file-store shutdown is a no-op.
		void this._memory
			.getMemoryManager()
			.shutdownAll()
			.catch(() => {});
		void this._toolRecoveryLogger.shutdown().catch(() => {});
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
	get model(): Model<Api> | undefined {
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
		return this._foregroundRecovery.attempt;
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/** Build a foreground {@link CapabilityEnvelope} from the live session state (active tools, cwd, cost ceiling). */
	private _buildForegroundEnvelopeFromState(): CapabilityEnvelope {
		return buildForegroundEnvelope({
			turnIndex: this._turnIndex,
			activeToolNames: this.getActiveToolNames(),
			cwd: this._cwd,
			maxTurnUsd: this.settingsManager.getCostGuardSettings().maxTurnUsd,
		});
	}

	/**
	 * (Re)build the foreground envelope for the current turn. Visibility only -- the foreground
	 * envelope is NOT enforced this round. Best-effort: never throws into the turn.
	 */
	private _refreshForegroundEnvelope(): void {
		try {
			this._currentForegroundEnvelope = this._buildForegroundEnvelopeFromState();
		} catch {
			// Visibility only: a failure to build the envelope must never disturb the turn.
		}
	}

	/** The auto-constructed foreground envelope for the current/most-recent turn (visibility only). */
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
	 * artifact_retrieve is auto-activated as a companion whenever an artifact-producing tool
	 * (grep, find, or run_toolkit_script) ends up in the resulting active set and artifact_retrieve
	 * is registered (i.e. not excluded/
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
		if (
			validToolNames.includes("grep") ||
			validToolNames.includes("find") ||
			validToolNames.includes("run_toolkit_script")
		) {
			addIfRegistered("artifact_retrieve");
		}
		if (validToolNames.includes("delegate")) {
			addIfRegistered("delegate_status");
		}

		this.agent.state.tools = tools;

		// Rebuild base system prompt with new tool set
		this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
		this.agent.state.systemPrompt = this._baseSystemPrompt;

		this._checkContextWindowUsageWarning();
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return this._compaction.isRunning() || this._branchSummaryAbortController !== undefined;
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
	get scopedModels(): ReadonlyArray<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }> {
		return this._scopedModels;
	}

	/** Update scoped models for cycling */
	setScopedModels(scopedModels: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>): void {
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

	private _refreshBaseSystemPrompt(): void {
		const previousBaseSystemPrompt = this._baseSystemPrompt;
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		if (this.agent.state.systemPrompt === previousBaseSystemPrompt) {
			this.agent.state.systemPrompt = this._baseSystemPrompt;
		}
	}

	/**
	 * Build a system prompt for a specific tool surface WITHOUT touching the session's base prompt
	 * state (used by the router's model swap; see {@link SystemPromptBuilder.buildSystemPromptForToolNames}).
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
			await this._toolProtocol.ensureActiveModelProtocol();
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

	getTransformersRuntime(modelId: string, baseUrl?: string): TransformersRuntime {
		return this._localRuntimeController.getTransformersRuntime(modelId, baseUrl);
	}

	/** Shared {@link PrismLlamaCppRuntime} for pi's own managed prism install — see
	 * {@link LocalRuntimeController.getPrismLlamaCppRuntime}. Delegates so `/models` and the
	 * readiness gate share the SAME cached instance, same contract as getLocalRuntime above. */
	getPrismLlamaCppRuntime(): PrismLlamaCppRuntime {
		return this._localRuntimeController.getPrismLlamaCppRuntime();
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

	/**
	 * Every local model the CURRENT (post-reload) configuration could still route a turn to —
	 * the foreground model plus any router tier (cheap/medium/expensive) that still resolves to a
	 * real, authed, non-exhausted model. Fed to {@link LocalRuntimeController.reconcile} via the
	 * `reconcileLocalRuntimes` hook above, ONLY after a reload generation has fully committed, so a
	 * local model dropped from the live configuration has its pi-spawned runtime stopped instead of
	 * leaking a child process, while one still referenced here is left untouched. Read-only — never
	 * used for routing itself.
	 */
	private _collectEligibleLocalModelsForReconcile(): Model<Api>[] {
		const models: Model<Api>[] = [];
		const foregroundModel = this.agent.state.model;
		if (foregroundModel) models.push(foregroundModel);
		for (const tier of ["cheap", "medium", "expensive"] as const) {
			const resolved = this._modelRouter.resolveConfiguredTierModel(tier);
			if (resolved) models.push(resolved);
		}
		return models;
	}

	getModelRouterStatus(formatLabel?: (label: string) => string): string {
		return this._modelRouter.getStatus(formatLabel);
	}

	private async _handlePostAgentRun(): Promise<boolean> {
		return this._foregroundRecovery.handlePostAgentRun();
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
		this._toolProtocol.applyRepairLayerSettings();
		this._cancelPrefixWarm();
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
		let routingStarted = false;
		let pendingNextTurnCount = 0;
		// Effectiveness feedback: remember the recall page + the query so we can score, after the
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

			// This submission is starting a new foreground turn. Queued steer/follow-up messages above
			// remain part of the already-active turn and must not erase its spawned-cost baseline.
			this._costGuardTurnBaselineUsd = this.getSpawnedUsage().cost;

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
			routingStarted = true;
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
			// A manual/default local model has no RouteDecision, so the router readiness gate above is
			// intentionally a no-op. It still needs the same managed-runtime boot/residency guarantee.
			if (!resolvedRouteInfo) {
				await this._localRuntimeController.ensureForegroundModelReady(requestModel);
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

			// Cross-session similarity recall. For a substantive turn, ask the memory providers to
			// prefetch a relevant <memory_context> page from past sessions and prepend it as data ahead of
			// the user message. Best-effort and gated: trivial turns are skipped, and providers return ""
			// (no page) when nothing is relevant — so it stays net-negative and the GC packs stale pages.
			if (this._memory.shouldAttemptRecall(expandedText)) {
				try {
					const recall = await this._memory.prefetchRecall(expandedText);
					if (recall) {
						injectedRecall = recall;
						recallQuery = expandedText;
						// Inject as a GC-managed custom context message (role "custom", customType
						// "memory_context"), NOT a persisted user message: the semantic-memory context-GC packs
						// stale recall pages so they don't accumulate forever, and the transcript index
						// only re-reads user/assistant text so recalled snippets can't recirculate.
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
			pendingNextTurnCount = this._pendingNextTurnMessages.length;
			for (const msg of this._pendingNextTurnMessages.slice(0, pendingNextTurnCount)) {
				messages.push(msg);
			}

			const taskStepsState = this.getTaskStepsStateSnapshot();
			const taskStepsContext = taskStepsState ? formatTaskStepsContext(taskStepsState) : undefined;
			if (taskStepsState && taskStepsContext) {
				messages.push(
					createCustomMessage(
						"task_steps_context",
						taskStepsContext,
						false,
						{ revision: taskStepsState.revision },
						new Date().toISOString(),
					),
				);
			}

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
			// Commit consumption only after all fallible preflight hooks have succeeded. Messages added
			// while the hook was running remain queued for the following turn.
			this._pendingNextTurnMessages.splice(0, pendingNextTurnCount);
		} catch (error) {
			// The turn never reached _runAgentPrompt, so the authoritative message_start that would
			// normally consume this entry (see _handleAgentEvent) never fires — un-register it here
			// instead of leaking the reference.
			if (userMessage) {
				this._earlyDisplayedUserMessages.delete(userMessage);
			}
			// The routing/prep phase (routing_start above) failed before ever reaching the turn — end
			// it here, or the UI's "working" indicator for it spins forever with nothing behind it.
			if (routingStarted) this._emit({ type: "routing_end" });
			preflightResult?.(false);
			throw error;
		}

		// The routing/prep phase is over — either we're about to hand off into the turn (which emits
		// its own agent_start/streaming events right after), or messages is unexpectedly unset and we
		// bail below. Either way nothing is left "routing" past this point.
		if (routingStarted) this._emit({ type: "routing_end" });

		if (!messages) {
			return;
		}

		preflightResult?.(true);
		try {
			this._toolProtocol.resetTurnState();
			await this._modelRouter.runRoutedTurn(messages, routedTurnModel, routedTurnRouteDecision);
			this._toolProtocol.recordParseOutcomeFromLastAssistant();
		} finally {
			// Normally consumed by the authoritative message_start. If execution failed before that
			// event, do not retain the early-painted message identity indefinitely.
			if (userMessage) this._earlyDisplayedUserMessages.delete(userMessage);
		}

		// Score whether the agent actually used the recalled context, so the recall gate can adapt.
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

		this._backgroundLanes.drainQueuedWorkerDelegations();
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

	async setModel(model: Model<Api>, options: { persistSettings?: boolean } = {}): Promise<void> {
		await this._modelSelection.setModel(model, options);
		this._scheduleLocalPrefixWarm(this.agent.state.model, "selection");
	}

	/** Re-resolve startup profile model/thinking after allowed extension providers are bound. */
	async reapplyActiveProfileModelSettings(): Promise<void> {
		const previousModel = this.model;
		await this._profileFilter.reapplyActiveProfileModelSettings();
		const activeToolNames = this._requestedActiveToolNames ?? this.getActiveToolNames();
		this._refreshToolRegistry({ activeToolNames, includeAllExtensionTools: true });
		if (!modelsAreEqual(previousModel, this.model)) {
			this._scheduleLocalPrefixWarm(this.model, "selection");
		}
	}

	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		const result = await this._modelSelection.cycleModel(direction);
		this._scheduleLocalPrefixWarm(result?.model, "selection");
		return result;
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
		return this._compaction.compact(customInstructions);
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abortCompaction(): void {
		this._compaction.abort();
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
		this._compaction.checkContextWindowUsageWarning();
	}

	private _checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<boolean> {
		return this._compaction.check(assistantMessage, skipAbortedCheck);
	}

	private _measureLiveContextTokensForCompaction(): number {
		return this._compaction.measureLiveContextTokens();
	}

	/**
	 * Internal: Run auto-compaction with events.
	 */
	private _runAutoCompaction(reason: AutoCompactionReason, willRetry: boolean): Promise<boolean> {
		return this._compaction.runAuto(reason, willRetry);
	}

	/**
	 * Run one compaction attempt, retrying retryable provider failures (stream stalls,
	 * 429/5xx, network drops) with the session's retry policy. The reliability kernel
	 * classifies a stall as retryable by design (see withStreamIdleWatchdog); without this
	 * loop a single transient killed the whole compaction while ordinary turns survived the
	 * same failure via auto-retry. Caller aborts are never retried; sleepAbortable rejects
	 * with the abort reason if the signal fires mid-backoff.
	 */
	private _compactWithRetry(
		run: () => Promise<CompactionResult>,
		signal: AbortSignal,
		provider?: string,
	): Promise<CompactionResult> {
		return this._compaction.compactWithRetry(run, signal, provider);
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
				registerContextMemoryProvider: (provider) => this.registerContextMemoryProvider(provider),
				reportSpawnedUsage: (usage, opts) => {
					this.addSpawnedUsage(usage, opts);
				},
				reportManagedLane: (event) => {
					this._backgroundLanes.recordManagedLane(event);
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

	registerContextMemoryProvider(provider: ContextMemoryProvider): void {
		this._memory.registerContextMemoryProvider(provider);
	}

	/** The gateway/scheduler registry. A deployment runner registers providers and drives start/stop. */
	get gateways(): GatewayRegistry {
		return this._gatewayRegistry;
	}

	/** Register a deployment-supplied transport channel (gateway). */
	registerChannelProvider(provider: ChannelProvider): void {
		this._gatewayRegistry.registerChannel(provider);
	}

	/** Register a deployment-supplied job scheduler (cron). */
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
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this._foregroundRecovery.abortRetry();
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._foregroundRecovery.isRetrying;
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

	getCostSummary(now = new Date()): SessionCostSummary {
		return this._analytics.getCostSummary(now);
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
		const entryId = appendGoalStateSnapshot(this.sessionManager, state);
		try {
			this._backgroundLanes.synchronizeGoalState(state);
		} catch (error) {
			this._emit({
				type: "warning",
				message: `Goal state persisted but durable worker reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
		return entryId;
	}

	/**
	 * Retrieve the latest valid goal state snapshot from the session log.
	 */
	getGoalStateSnapshot(): GoalState | undefined {
		return getLatestGoalStateSnapshot(this.sessionManager);
	}

	/**
	 * Persist one submitted continuation pass's turn/wall-clock/spend contribution onto the active
	 * goal's durable cumulative budget (see `GoalState.continuationTurnsUsed` et al.). This is the
	 * "persistence dep" `GoalLoopController` calls once per pass actually submitted — it, not the
	 * loop controller, is where USD gets attributed: it reads the session's OWN cumulative model
	 * spend (`getCostSummary().ownCost` — deliberately excludes worker/subagent spend, which is
	 * tracked and budgeted separately) and threads that single absolute reading into a
	 * `record_continuation_budget` event; the pure reducer in `goal-state.ts` derives the delta.
	 * A no-op when no goal state exists (defensive — in practice this is only ever called right
	 * after a pass the loop already confirmed was submitted against an active goal).
	 */
	recordGoalContinuationPass(pass: { turns: number; wallClockMs: number }): void {
		const state = this.getGoalStateSnapshot();
		if (!state) return;
		const sessionCostUsd = this.getCostSummary().ownCost;
		const updated = applyGoalEvent(state, {
			type: "record_continuation_budget",
			turns: pass.turns,
			wallClockMs: pass.wallClockMs,
			sessionCostUsd,
			now: new Date().toISOString(),
		});
		this.saveGoalStateSnapshot(updated);
	}

	/** Save native task-step state to the active session log. */
	saveTaskStepsStateSnapshot(state: TaskStepsState): string {
		return appendTaskStepsStateSnapshot(this.sessionManager, state);
	}

	/** Retrieve the latest valid native task-step state from the active session log. */
	getTaskStepsStateSnapshot(): TaskStepsState | undefined {
		return getLatestTaskStepsStateSnapshot(this.sessionManager);
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
	 * Retrieve the latest valid evidence bundle snapshot from the active branch.
	 */
	getEvidenceBundleSnapshot(): EvidenceBundle | undefined {
		return getLatestEvidenceBundleSnapshot(getActiveSessionBranchEntries(this.sessionManager));
	}

	/** Retrieve all valid evidence bundle snapshots from the active branch. */
	getEvidenceBundleSnapshots(): EvidenceBundle[] {
		return getEvidenceBundleSnapshots(getActiveSessionBranchEntries(this.sessionManager));
	}

	/** Live lane records tracked by this process (running and terminal). */
	getLaneRecords(): LaneRecord[] {
		return this._backgroundLanes.getLaneRecords();
	}

	// Autonomy telemetry + gate-outcome history live in AutonomyTelemetry (see
	// autonomy-telemetry.ts). These stubs keep the god file's internal call surface stable while the
	// sink logic and the owned gate-outcome fields live there.
	private _emitAutonomyTelemetry(event: AutonomyTelemetryEvent): void {
		this._autonomyTelemetry.emitTelemetry(event);
	}

	private _recordGateOutcome(outcome: GateOutcome): void {
		this._autonomyTelemetry.recordGateOutcome(outcome);
	}

	/** Copies of the bounded gate-outcome history, oldest first, latest last. */
	getGateOutcomeHistory(): GateOutcomeHistoryEntry[] {
		return this._autonomyTelemetry.getGateOutcomeHistory();
	}

	saveWorkerResultSnapshot(result: WorkerResult, request?: WorkerRequest): string {
		return appendWorkerResultSnapshot(this.sessionManager, result, request);
	}

	getWorkerResultSnapshots(): WorkerResult[] {
		return getWorkerResultSnapshots(getActiveSessionBranchEntries(this.sessionManager));
	}

	saveLearningDecisionSnapshot(decision: LearningDecision): string {
		return appendLearningDecisionSnapshot(this.sessionManager, decision);
	}

	getLearningDecisionSnapshots(): LearningDecision[] {
		return getLearningDecisionSnapshots(getActiveSessionBranchEntries(this.sessionManager));
	}

	/**
	 * The single injection point that makes the goal-continuation snapshot lane-aware:
	 * `laneRecords` feeds BOTH `evaluateGoalContinuation`'s "waiting" branch (a worker dispatched
	 * against an open requirement) and the per-goal worker-spend overlay — read fresh here so BOTH the
	 * goal loop (`GoalLoopController`) and the idle scheduler (`BackgroundLaneController`) see the
	 * same live lane state, since both reach this same method.
	 */
	getGoalRuntimeSnapshot(settings: GoalRuntimeSnapshotSettings): GoalRuntimeSnapshot {
		return buildGoalRuntimeSnapshot({
			sessionManager: this.sessionManager,
			settings,
			laneRecords: this._backgroundLanes.getLaneRecords(),
			taskRuntime: this._backgroundLanes.getTaskRuntimeSnapshot(),
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
	 * Whether the CURRENT session model may drive a worktree-sync lane worker (see
	 * `evaluateLaneWorkerRefusal` in model-capability.ts): full capability class, a DECLARED
	 * (registry) context window, an ADVERTISED native tool-call path (`Model.textToolCallProtocol`
	 * unset/false -- `true` means phone-only), and no graded `/toolprobe` demotion to
	 * "text-protocol"/"none" on record. An unprobed model (no verdict on record yet) is eligible on
	 * its advertised support alone. `undefined` means eligible.
	 */
	getLaneWorkerRefusal(): LaneWorkerRefusal | undefined {
		const profile = this.getModelCapabilityProfile();
		const model = this.model;
		const verdict = model ? this._toolProtocol.getToolProbeVerdict(model) : undefined;
		return evaluateLaneWorkerRefusal({
			capabilityClass: profile.class,
			contextWindow: profile.contextWindow,
			toolCallingAdvertised: model?.textToolCallProtocol !== true,
			toolCallingDemoted: verdict === "text-protocol" || verdict === "none",
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
	 * Run one bounded profile-bound worker delegation. Delegates to {@link BackgroundLaneController};
	 * consumed by the `delegate` tool.
	 */
	async runWorkerDelegationOnce(request: WorkerDelegationRequest): Promise<WorkerDelegationRunOutcome> {
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

	/**
	 * Public entry point for BOTH idle autosteer and manual (`/goal start`, `/goal-continue`)
	 * continuation. Delegates to {@link BackgroundLaneController.continueGoalLoopExclusive}, the
	 * single-flight guard that prevents two goal loops from racing to submit prompts through the
	 * same session (which throws "Agent is already processing" from the second submission). Do not
	 * call `this._goalContinuation.continueGoalLoop` directly from here — that bypasses the guard.
	 */
	async continueGoalLoop(options: GoalContinuationLoopOptions): Promise<GoalContinuationLoopResult> {
		return this._backgroundLanes.continueGoalLoopExclusive(options);
	}

	/**
	 * Run a one-shot LLM completion fully ISOLATED from the main session — the load-bearing primitive
	 * for native reflection (see reflection-controller.ts for the isolation invariants).
	 */
	async runIsolatedCompletion(opts: IsolatedCompletionOptions): Promise<IsolatedCompletionResult> {
		return this._reflection.runIsolatedCompletion(opts);
	}

	/**
	 * Native end-of-loop reflection pass. Delegates to {@link ReflectionController}; returns null
	 * when the demand gate skips or in a child session.
	 */
	async runReflectionPass(input: {
		signals: DemandSignals;
		recentTurnText: string;
		model?: Model<Api>;
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
