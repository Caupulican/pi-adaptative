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
import { basename, dirname, join } from "node:path";
import type {
	Agent,
	AgentContext,
	AgentEvent,
	AgentMessage,
	AgentState,
	AgentTool,
	ThinkingLevel,
} from "@caupulican/pi-agent-core";
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
import { sleep } from "../utils/sleep.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import type {
	CapabilityEnvelope,
	EvidenceBundle,
	GateOutcome,
	LearningDecision,
	ModelTier,
	RouteDecision,
	WorkerRequest,
	WorkerResult,
} from "./autonomy/contracts.ts";
import { buildForegroundEnvelope, formatForegroundEnvelopeObservation } from "./autonomy/foreground-envelope.ts";
import { evaluateToolGate } from "./autonomy/gates.ts";
import { type LaneRecord, LaneTracker } from "./autonomy/lane-tracker.ts";
import { appendLaneRecordSnapshot, getLaneRecordSnapshots } from "./autonomy/session-lane-record.ts";
import type {
	AutonomyDiagnosticSnapshot,
	AutonomyStatusSnapshot,
	DiagnosticEntry,
	GateOutcomeHistoryEntry,
} from "./autonomy/status.ts";
import { composeSubagentSystemPrompt } from "./autonomy/subagent-prompt.ts";
import {
	AUTONOMY_TELEMETRY_EVENT_TYPES,
	type AutonomyTelemetryEvent,
	redactTelemetryValue,
} from "./autonomy/telemetry-events.ts";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import {
	type CompactionResult,
	type CompactionSettings,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	estimateContextTokens,
	generateBranchSummary,
	prepareCompaction,
	shouldCompact,
} from "./compaction/index.ts";
// (module-scope helper for curation goal extraction defined below the imports)
import { BrainCurator, type CurationTelemetrySnapshot, preDigestConversationText } from "./context/brain-curator.ts";
import { type ArtifactStore, createFileArtifactStore } from "./context/context-artifacts.ts";
import { type ContextAuditReport, runContextAudit } from "./context/context-audit.ts";
import {
	buildContextCompositionReport,
	type ContextCompositionReport,
	formatContextCompositionDashboard,
} from "./context/context-composition.ts";
import { enforcePromptPolicy, type PromptEnforcementReport } from "./context/context-prompt-enforcement.ts";
import {
	correlateWithContextGc,
	type PromptPolicyGcCorrelationReport,
	type PromptPolicyShadowReport,
	planPromptPolicy,
} from "./context/context-prompt-policy.ts";
import {
	defaultMemoryPromptInclusionReport,
	type MemoryPromptInclusionReport,
	type MemoryRetrievalDiagnostics,
	sanitizeMemoryRetrievalReportForDiagnostics,
} from "./context/memory-diagnostics.ts";
import { buildMemoryPromptBlock } from "./context/memory-prompt-block.ts";
import {
	type MemoryProvider as ContextMemoryProvider,
	DEFAULT_LOCAL_MEMORY_EGRESS_POLICY,
} from "./context/memory-provider-contract.ts";
import { type MemoryRetrievalReport, retrieveMemoryForContext } from "./context/memory-retrieval.ts";
import { createOkfMemoryProvider } from "./context/okf-memory-provider.ts";
import { applyContextGc, type ContextGcReport } from "./context-gc.ts";
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
import { applyWorkerActions } from "./delegation/worker-actions.ts";
import { runWorker, type WorkerRunOutcome } from "./delegation/worker-runner.ts";
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
import { EffectivenessTracker } from "./memory/effectiveness-tracker.ts";
import { MemoryManager } from "./memory/memory-manager.ts";
import type { MemoryProvider } from "./memory/memory-provider.ts";
import { FileStoreProvider } from "./memory/providers/file-store.ts";
import { TranscriptRecallProvider } from "./memory/providers/transcript-recall.ts";
import { compactToolResultDetailsForRetention } from "./message-retention.ts";
import { type BashExecutionMessage, type CustomMessage, createCustomMessage } from "./messages.ts";
import {
	deriveModelCapabilityProfile,
	filterToolNamesForCapability,
	type ModelCapabilityProfile,
	scaleContinuationBudgetsForCapability,
} from "./model-capability.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { resolveCliModel, resolveProfileModelSettings } from "./model-resolver.ts";
import { collectModelRouterConfigDiagnostics } from "./model-router/config-diagnostics.ts";
import { classifyExecutorTurn } from "./model-router/executor-route.ts";
import { classifyModelRouterRoute, type ModelRouterIntent } from "./model-router/intent-classifier.ts";
import { ROUTE_JUDGE_MAX_OUTPUT_TOKENS, runRouteJudge } from "./model-router/route-judge.ts";
import {
	bufferModelRouterSessionCustomMessage,
	bufferModelRouterSessionMessage,
	createModelRouterSessionBuffer,
	flushModelRouterSessionBuffer,
	type ModelRouterSessionBuffer,
} from "./model-router/session-buffer.ts";
import {
	formatModelRouterStatus,
	getRecentModelRouterDecisions,
	MODEL_ROUTER_DECISION_CUSTOM_TYPE,
	type ModelRouterDecisionStatus,
} from "./model-router/status.ts";
import { shouldEscalateModelRouterTool } from "./model-router/tool-escalation.ts";
import { FitnessStore, type StoredFitnessReport } from "./models/fitness-store.ts";
import { OLLAMA_PROVIDER } from "./models/local-registration.ts";
import { type LocalRuntimeDeps, OllamaRuntime } from "./models/local-runtime.ts";
import type { NormalizedProfile } from "./profile-registry.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import { type ModelFitnessReport, runModelFitnessProbe } from "./research/model-fitness.ts";
import { type ResearchRunResult, runResearch } from "./research/research-runner.ts";
import {
	appendEvidenceBundleSnapshot,
	getEvidenceBundleSnapshots,
	getLatestEvidenceBundleSnapshot,
} from "./research/session-evidence-bundle.ts";
import { collectWorkspaceSources } from "./research/workspace-collector.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import { stripResourceProfileBlocks } from "./resource-profile-blocks.ts";
import { classifyToolTrust, UNTRUSTED_BOUNDARY_SYSTEM_RULE, wrapUntrustedText } from "./security/untrusted-boundary.ts";
import type { BranchSummaryEntry, CompactionEntry, SessionManager } from "./session-manager.ts";
import { CURRENT_SESSION_VERSION, getLatestCompactionEntry, type SessionHeader } from "./session-manager.ts";
import {
	matchesResourceProfilePattern,
	type ResourceProfileFilterSettings,
	type SettingsManager,
} from "./settings-manager.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "./system-prompt.ts";
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
	 * model router before a turn routed to a local model (see _ensureLocalModelReady). Unit tests
	 * inject fakes so they never hit a real network/process; production defaults to the real ones.
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

/** Latest user prompt text in the provider-visible array (curation goal line; bounded by caller). */
function latestUserPromptText(messages: AgentMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message || message.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		const text = message.content
			.filter((part): part is { type: "text"; text: string } => (part as { type?: string }).type === "text")
			.map((part) => part.text)
			.join("\n");
		if (text.length > 0) return text;
	}
	return "";
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

function formatModelRouterModel(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

function persistModelRouterDecision(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	decision: ModelRouterDecisionStatus,
): void {
	sessionManager.appendCustomEntry(MODEL_ROUTER_DECISION_CUSTOM_TYPE, decision);
}

/** Custom-entry type for G3 autonomy telemetry. Distinct from the router/lane record types so a
 * telemetry consumer can filter on it without decoding operational snapshots. */
const AUTONOMY_TELEMETRY_CUSTOM_TYPE = "autonomy-telemetry";

/** G8: bound on the in-memory gate-outcome history. Oldest entries evict once the cap is reached. */
const GATE_OUTCOME_HISTORY_LIMIT = 50;

/** User-facing router tiers in ascending order — "learning" is never selected for a user turn, so
 * it has no place in the escalation ladder (#27's _ensureRouteModelReady walks this forward only). */
const MODEL_ROUTER_TIER_ORDER: readonly ModelTier[] = ["cheap", "medium", "expensive"];

/** Read a packed grep/find tool result's `details.artifactId`, if present, without `any`. */
function extractArtifactId(message: AgentMessage | undefined): string | undefined {
	if (!message || message.role !== "toolResult") return undefined;
	const details = (message as { details?: unknown }).details;
	if (typeof details !== "object" || details === null) return undefined;
	const artifactId = (details as { artifactId?: unknown }).artifactId;
	return typeof artifactId === "string" ? artifactId : undefined;
}

/**
 * Text of the most recent user message, or "" if there is none (e.g. goal-continuation
 * turns with no new user input). An empty query degrades to zero memory-retrieval results
 * by construction (see memory-provider-contract.ts's score-on-empty-query-tokens rule) --
 * no special-casing needed here beyond returning "".
 */
function latestUserMessageText(messages: AgentMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		const parts: string[] = [];
		for (const part of message.content) {
			if (part.type === "text") parts.push(part.text);
		}
		return parts.join("\n");
	}
	return "";
}

function emptyMemoryRetrievalReport(maxResults: number): MemoryRetrievalReport {
	return { request: { query: "", maxResults }, providerReports: [], results: [], contextItems: [] };
}

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
	/** Pending idle timer that starts bounded goal continuation after the session becomes idle. */
	private _goalAutoContinueTimer: ReturnType<typeof setTimeout> | undefined;
	/** Guards bounded idle autosteer so continuation prompts do not recursively trigger themselves. */
	private _isGoalAutoContinuing = false;
	/** Pending idle timer that starts an autonomous research pass after the session becomes idle. */
	private _researchLaneTimer: ReturnType<typeof setTimeout> | undefined;
	/** Single-flight guard: at most one research pass runs at a time per session. */
	private _isResearchLaneRunning = false;
	/** Why the last idle research-lane evaluation skipped, for /autonomy diagnostics. */
	private _lastResearchLaneSkipReason: string | undefined;
	/** Live lane registry — the real source for AutonomyStatusSnapshot.activeLaneCount. */
	private readonly _laneTracker = new LaneTracker();
	/** Session-lifetime abort for in-flight research passes (same pattern as _reflectionAbort). */
	private readonly _researchLaneAbort = new AbortController();
	/** Session-lifetime abort for in-flight delegated workers. */
	private readonly _workerDelegationAbort = new AbortController();
	/**
	 * The last tool set requested via setActiveToolsByName BEFORE model-capability filtering, so
	 * switching from a small-window model back to a large one restores the full requested set.
	 */
	private _requestedActiveToolNames: string[] | undefined;

	// Compaction/context hygiene state
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	private _overflowRecoveryAttempted = false;
	private _latestContextGcReport: ContextGcReport | undefined = undefined;
	/** Brain-curation sidecar (design: brain-context-curation-design.md). Inert unless the
	 * contextPolicy.curation setting is enabled AND the model passes the digest fitness gate. */
	private readonly _brainCurator = new BrainCurator();
	private _lastCurationSkipReason: string | undefined = undefined;
	private _inertExtensionWarnings: string[] = [];
	/** Extensions the active resource profile removed from the runtime set (surfaced in /context). */
	private _profileDeniedExtensionCount = 0;
	private _lastPreDigestSkipReason: string | undefined = undefined;
	private _unboundToolGrantWarnings: string[] = [];
	private _toolArtifactStore: ArtifactStore | undefined = undefined;
	private _latestContextAuditReport: ContextAuditReport | undefined = undefined;
	private _latestPromptPolicyReport: PromptPolicyShadowReport | undefined = undefined;
	private _latestPromptPolicyGcCorrelation: PromptPolicyGcCorrelationReport | undefined = undefined;
	private _latestPromptEnforcementReport: PromptEnforcementReport | undefined = undefined;
	private _memoryOkfProvider: ContextMemoryProvider | undefined = undefined;
	private _latestMemoryRetrievalReport: MemoryRetrievalReport | undefined = undefined;
	private _latestMemoryPromptInclusionReport: MemoryPromptInclusionReport | undefined = undefined;

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// Retry state
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;

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
	private _localRuntimeDeps?: LocalRuntimeDeps;
	/** Lazy, cached by baseUrl so the router path and any other caller share one instance per server. */
	private _localRuntimes = new Map<string, OllamaRuntime>();
	/** Server URLs confirmed reachable THIS session — skips the health-check round trip on every
	 * local-routed turn once warm. Keyed the same way as _localRuntimes. */
	private _localRuntimeConfirmedUp = new Set<string>();
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	private _allowedToolNames?: Set<string>;
	private _excludedToolNames?: Set<string>;
	private _toolProfileFilter?: Required<ResourceProfileFilterSettings>;
	private readonly _isExplicitModel: boolean;
	private readonly _isExplicitThinking: boolean;
	/** Plug-and-play memory subsystem. Recreated on each (re)initialize so reload is safe. */
	private _memoryManager: MemoryManager = new MemoryManager();
	/** R4: tracks whether injected recall is actually used, to adapt the recall gate. */
	private readonly _effectivenessTracker = new EffectivenessTracker();
	/** R8: registry for deployment-supplied gateway channels + schedulers (lifecycle driven by the host runner). */
	private readonly _gatewayRegistry = new GatewayRegistry();
	/** Cache for getSpawnedUsage(), keyed by session entry count (Bug #22 — avoid O(N) per render frame). */
	private _spawnedUsageCache?: { entryCount: number; totals: SpawnedUsageTotals };
	private _dailyUsageCache?: { sessionDir: string; expiresAt: number; totals: DailyUsageTotals };
	/** Latest proactive cost-guard decision (#34), for the host UI to surface. Undefined when disabled. */
	private _lastCostGuardDecision?: CostGuardDecision;
	/** One-shot latch so the cost guard downgrades reasoning once per over-threshold episode, not every call. */
	private _costGuardDowngraded = false;
	/** Active model-router intent for the current transient routed turn, if any. */
	private _activeModelRouterIntent?: ModelRouterIntent;
	private _activeModelRouterRoute?: RouteDecision;
	private _modelRouterSessionBuffer?: ModelRouterSessionBuffer;
	private _modelRouterEscalationRequested = false;
	private _isModelRouterRetry = false;
	private _lastModelRouterDecision?: ModelRouterDecisionStatus;
	private _lastAutonomyGateOutcome?: GateOutcome;
	/** G8: bounded (cap {@link GATE_OUTCOME_HISTORY_LIMIT}) history of gate outcomes; tail is latest. */
	private readonly _gateOutcomeHistory: GateOutcomeHistoryEntry[] = [];
	private _lastModelRouterSkipReason?: string;
	private _lastModelRouterIntent?: ModelRouterIntent;
	/** Lazily-built skill curator (#32) over `<agentDir>/skills`. */
	private _skillCuratorInstance?: SkillCurator;
	/** Set on dispose so in-flight background reflection bails instead of writing to a dead session (Bug #21). */
	private _disposed = false;
	/** Aborts in-flight background reflection completions on dispose (Bug #21). */
	private readonly _reflectionAbort = new AbortController();
	private readonly _isChildSession: boolean;
	/** Memory providers registered by extensions via pi.registerMemoryProvider, applied on (re)init. */
	private _pendingMemoryProviders: MemoryProvider[] = [];
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

	// Base system prompt (without extension appends) - used to apply fresh appends each turn
	private _baseSystemPrompt = "";
	private _baseSystemPromptOptions!: BuildSystemPromptOptions;

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._scopedModels = config.scopedModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._agentDir = config.agentDir ?? getAgentDir();
		this._collectWorkspaceSources = config.collectWorkspaceSources ?? collectWorkspaceSources;
		this._localRuntimeDeps = config.localRuntimeDeps;
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
		if (this.agent.streamFn === streamSimple) {
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

	private _contextGcStorageDir(): string {
		return join(this._agentDir, "context-gc", this.sessionManager.getSessionId());
	}

	private _toolArtifactsDir(): string {
		return join(this._agentDir, "context-artifacts", this.sessionManager.getSessionId());
	}

	/**
	 * Session-scoped, filesystem-backed artifact store for first-capture-then-bound tool
	 * output (grep/find only, for now -- see tool-output-artifacts.md). Lazily created and
	 * cached so every tool construction in this session shares one store instance.
	 *
	 * `packToolOutput()` registers a reference (the packing tool call's id) at pack time
	 * and fails closed, so packed artifacts are never prematurely collected.
	 * `_releaseGcPackedArtifactReferences()` (called from `_applyContextGc()`) releases
	 * that reference once context-gc packs the result out of live context, and
	 * opportunistically reclaims now-unreferenced artifacts via `cleanup()`.
	 * Remaining carry-forward gap: cleanup() now also runs at dispose(), but only reclaims
	 * already-released (zero-reference) artifacts. A session that ends before context-gc
	 * ever evicts a result never releases that reference, so its artifact stays on disk by
	 * design (resolvable on resume). Reclaiming those requires an explicit cross-session
	 * expiry/liveness policy, not just a sweep.
	 */
	private _getToolArtifactStore(): ArtifactStore {
		this._toolArtifactStore ??= createFileArtifactStore({ baseDir: this._toolArtifactsDir() });
		return this._toolArtifactStore;
	}

	/**
	 * Fixed path for this slice's local Pi OKF memory documents, shared across sessions
	 * under this agentDir (not session-scoped, unlike tool-artifacts/context-gc, since OKF
	 * memory represents durable cross-session knowledge, not a per-session capture). Not
	 * yet user-configurable -- see the memory-retrieval settings doc comment.
	 */
	private _memoryOkfDir(): string {
		return join(this._agentDir, "okf-memory");
	}

	/**
	 * Session-scoped, read-only local OKF memory provider. Lazily created ONLY when memory
	 * retrieval is enabled (see `_runMemoryRetrieval`) -- never force-created, so a session
	 * with the setting off never touches `_memoryOkfDir()` at all (no directory access, no
	 * creation; `createOkfMemoryProvider` itself never writes/mkdirs either way).
	 */
	private _getMemoryOkfProvider(): ContextMemoryProvider {
		this._memoryOkfProvider ??= createOkfMemoryProvider({ rootDir: this._memoryOkfDir() });
		return this._memoryOkfProvider;
	}

	/**
	 * One pass over the current branch, mapping each toolResult's toolCallId to its
	 * persisted session-entry id. Rebuilt every audit pass (O(branch) per turn), so this is
	 * O(n^2) over a long session. Fine at current scale; after the artifact-read fix this is
	 * the next per-turn audit cost to optimize if it ever matters (e.g. cache/incrementally
	 * update instead of a full rebuild).
	 */
	private _buildSessionEntryIdLookup(): (toolCallId: string) => string | undefined {
		const map = new Map<string, string>();
		for (const entry of this.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "toolResult") {
				map.set(entry.message.toolCallId, entry.id);
			}
		}
		return (toolCallId: string) => map.get(toolCallId);
	}

	/**
	 * Phase 1 observe-only audit pass (see context/context-audit.ts): converts live
	 * toolResult messages into ContextItems and runs the existing retention/hard-constraint
	 * evaluators over them, storing the latest deterministic report for tests/debugging.
	 * Read-only with respect to messages, the transcript, and artifact references -- uses
	 * `_toolArtifactStore` (the field), not `_getToolArtifactStore()` (the getter), so a
	 * session that never packed anything doesn't force-create a store/dir just to audit.
	 * Never throws into a live turn: any failure degrades to an empty report.
	 */
	private _runContextAudit(messages: AgentMessage[]): ContextAuditReport {
		try {
			const report = runContextAudit(messages, {
				turnIndex: this._turnIndex,
				artifactStore: this._toolArtifactStore,
				sessionEntryIdForToolCallId: this._buildSessionEntryIdLookup(),
			});
			this._latestContextAuditReport = report;
			return report;
		} catch {
			const report: ContextAuditReport = { turnIndex: this._turnIndex, items: [] };
			this._latestContextAuditReport = report;
			return report;
		}
	}

	/**
	 * Read-only inspection of the context audit. With `messages`, recomputes fresh against
	 * the given array (still no mutation of messages/transcript/artifact refs); without,
	 * returns the last report computed during a real transform pass.
	 */
	getContextAuditReport(messages?: AgentMessage[]): ContextAuditReport {
		if (messages) return this._runContextAudit(messages);
		return this._latestContextAuditReport ?? { turnIndex: this._turnIndex, items: [] };
	}

	/**
	 * Observe-first shadow/planning pass (see context/context-prompt-policy.ts): re-shapes
	 * the audit report into a per-item policy plan whose `appliedAction` is always
	 * "keep_raw" -- this never enforces anything, it only records what the policy engine
	 * would say. Never throws into a live turn: any failure degrades to an empty report.
	 */
	private _runPromptPolicyPlanning(auditReport: ContextAuditReport): PromptPolicyShadowReport {
		try {
			const report = planPromptPolicy(auditReport);
			this._latestPromptPolicyReport = report;
			return report;
		} catch {
			const report: PromptPolicyShadowReport = { turnIndex: this._turnIndex, items: [] };
			this._latestPromptPolicyReport = report;
			return report;
		}
	}

	/**
	 * Read-only inspection of the shadow policy plan. With `messages`, recomputes fresh
	 * (audit + plan) against the given array; without, returns the last plan computed
	 * during a real transform pass. Never mutates messages/transcript/artifact refs.
	 */
	getPromptPolicyReport(messages?: AgentMessage[]): PromptPolicyShadowReport {
		if (messages) return this._runPromptPolicyPlanning(this._runContextAudit(messages));
		return this._latestPromptPolicyReport ?? { turnIndex: this._turnIndex, items: [] };
	}

	/**
	 * Report-only correlation between the shadow plan just computed this turn and what the
	 * legacy context-gc pass actually packed. Runs after `_applyContextGc()` has already
	 * produced its report; never influences context-gc itself. Never throws into a live
	 * turn: any failure degrades to an empty correlation.
	 */
	private _correlatePromptPolicyWithContextGc(gcReport: ContextGcReport): void {
		const shadowReport = this._latestPromptPolicyReport ?? { turnIndex: this._turnIndex, items: [] };
		try {
			this._latestPromptPolicyGcCorrelation = correlateWithContextGc(shadowReport, gcReport);
		} catch {
			this._latestPromptPolicyGcCorrelation = { turnIndex: this._turnIndex, entries: [] };
		}
	}

	/** Read-only inspection of the latest shadow-plan/legacy-gc correlation, for tests/debugging. */
	getPromptPolicyGcCorrelation(): PromptPolicyGcCorrelationReport {
		return this._latestPromptPolicyGcCorrelation ?? { turnIndex: this._turnIndex, entries: [] };
	}

	/**
	 * First enforcement pilot (see context/context-prompt-enforcement.ts): opt-in,
	 * default-disabled stub-in-place of stale artifact-backed tool_output results in the
	 * provider-visible message array only. Runs on `messages` AFTER context-gc has already
	 * produced its own result, so legacy context-gc's own packing/reporting is completely
	 * unaffected by this pass -- it only ever acts on messages gc left untouched this turn.
	 * Never throws into a live turn: any failure degrades to returning `messages` unchanged.
	 */
	private _runPromptEnforcement(
		messages: AgentMessage[],
		shadowReport: PromptPolicyShadowReport,
	): { messages: AgentMessage[]; report: PromptEnforcementReport } {
		try {
			const persistedSettings = this.settingsManager.getContextPromptEnforcementSettings();
			const curationEnabled = this.settingsManager.getContextCurationSettings().enabled;
			const settings = {
				...persistedSettings,
				// Runtime fact, never assumed: artifact_retrieve is a companion affordance
				// (auto-activated alongside grep/find), not a default/global tool, so active
				// tools can differ turn to turn -- see context-prompt-enforcement.ts's doc
				// comment on why this is checked separately from hasAvailableRetrievalPath.
				retrievalToolAvailable: this.getActiveToolNames().includes("artifact_retrieve"),
				brainRelevance: curationEnabled ? (itemId: string) => this._brainCurator.getRelevance(itemId) : undefined,
			};
			const result = enforcePromptPolicy(messages, shadowReport, settings);
			this._latestPromptEnforcementReport = result.report;
			return result;
		} catch {
			const report: PromptEnforcementReport = { turnIndex: this._turnIndex, items: [] };
			this._latestPromptEnforcementReport = report;
			return { messages, report };
		}
	}

	/**
	 * Enqueue relevance-scoring jobs for stale, artifact-backed tool outputs the enforcement
	 * pilot could act on. Pure queueing — the verdicts only ever take effect through the
	 * asymmetric advisory lever inside enforcePromptPolicy. Never throws into a turn.
	 */
	private _enqueueRelevanceCuration(messages: AgentMessage[], shadowReport: PromptPolicyShadowReport): void {
		try {
			const settings = this.settingsManager.getContextCurationSettings();
			if (!settings.enabled) return;
			const goal = latestUserPromptText(messages).slice(0, 400);
			for (const item of shadowReport.items) {
				if (!item.hasAvailableRetrievalPath) continue;
				const message = messages[item.messageIndex];
				if (!message || message.role !== "toolResult" || message.toolCallId !== item.toolCallId) continue;
				if (message.isError) continue;
				const details = message.details as
					| { contextGc?: { packed?: unknown }; promptPolicy?: { enforced?: unknown } }
					| undefined;
				if (details?.contextGc?.packed === true || details?.promptPolicy?.enforced === true) continue;
				const text = message.content
					.filter((part): part is { type: "text"; text: string } => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				if (text.length === 0) continue;
				this._brainCurator.enqueue({ kind: "relevance", key: item.itemId, content: text.slice(0, 4000), goal });
			}
		} catch {
			// curation is a sidecar; it must never disrupt a turn
		}
	}

	/**
	 * Drain gate: settings on, model configured+authed, and the model has PASSED the digest
	 * fitness probe on THIS host (design: unfit or unprobed models are refused with a visible
	 * reason, never silently degraded). Fire-and-forget; never throws into a turn.
	 */
	/**
	 * Resolve the curation model IFF every gate passes: setting enabled, model configured,
	 * resolvable+authed, and digest-fitness-proven on THIS host (canonical "provider/id" ref —
	 * runModelFitness stores reports under it, while settings.model may be a bare id or pattern).
	 * Sets _lastCurationSkipReason on refusal; never throws.
	 */
	private _resolveCurationModelIfFit(): Model<Api> | undefined {
		const settings = this.settingsManager.getContextCurationSettings();
		if (!settings.enabled) {
			// Never surface a stale refusal reason for a feature the user has since disabled.
			this._lastCurationSkipReason = undefined;
			return undefined;
		}
		if (!settings.model) {
			this._lastCurationSkipReason = "curation_model_unset";
			return undefined;
		}
		const resolved = resolveCliModel({ cliModel: settings.model, modelRegistry: this._modelRegistry });
		if (!resolved.model || !this._modelRegistry.hasConfiguredAuth(resolved.model)) {
			this._lastCurationSkipReason = "curation_model_unresolved";
			return undefined;
		}
		const canonicalRef = `${resolved.model.provider}/${resolved.model.id}`;
		const fitness = FitnessStore.forAgentDir(this._agentDir)
			.getForHost()
			.find((entry) => entry.model === canonicalRef);
		const digestScore = fitness?.report.digest;
		if (!digestScore) {
			this._lastCurationSkipReason = "curation_model_unprobed";
			return undefined;
		}
		if (digestScore.succeeded < Math.ceil(digestScore.total * (2 / 3))) {
			this._lastCurationSkipReason = "curation_model_digest_unfit";
			return undefined;
		}
		this._lastCurationSkipReason = undefined;
		return resolved.model;
	}

	private _maybeDrainBrainCuration(): void {
		try {
			if (!this._brainCurator.hasWork() || this._brainCurator.isDraining) return;
			const model = this._resolveCurationModelIfFit();
			if (!model) return;
			const settings = this.settingsManager.getContextCurationSettings();
			void this._drainBrainCuration(model, settings.maxJobsPerTurn);
		} catch {
			// curation is a sidecar; it must never disrupt a turn
		}
	}

	/**
	 * Compaction pre-digest gate (design surface 3): everything the drain gate requires PLUS a
	 * RUNTIME reliability proof — the curator must have run >=5 jobs on this session with a parse
	 * failure rate <=5% before it is trusted to pre-digest compaction input. Returns undefined
	 * (verbatim compaction, byte-for-byte today's behavior) whenever any gate refuses.
	 */
	private _buildCompactionPreDigest(): ((text: string, signal?: AbortSignal) => Promise<string>) | undefined {
		try {
			const model = this._resolveCurationModelIfFit();
			if (!model) return undefined;
			const telemetry = this._brainCurator.telemetry();
			if (telemetry.jobsRun < 5 || telemetry.parseFailures / telemetry.jobsRun > 0.05) {
				this._lastPreDigestSkipReason = "curation_predigest_reliability_unproven";
				return undefined;
			}
			this._lastPreDigestSkipReason = undefined;
			return async (text, signal) => {
				const result = await preDigestConversationText({
					text,
					signal,
					complete: async ({ systemPrompt, userPrompt, signal: chunkSignal }) => {
						const completion = await this.runIsolatedCompletion({
							systemPrompt,
							messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
							model,
							thinkingLevel: "off",
							maxTokens: 512,
							signal: chunkSignal,
							cacheRetention: "short",
						});
						return {
							text: completion.text,
							costUsd: completion.usage.cost.total,
							stopReason: String(completion.stopReason),
						};
					},
				});
				if (!this._disposed && result.totalChunks > 0) {
					this.sessionManager.appendCustomEntry("brain-curation-predigest", {
						version: 1,
						totalChunks: result.totalChunks,
						digested: result.digested,
						failed: result.failed,
						charsBefore: text.length,
						charsAfter: result.text.length,
					});
				}
				return result.text;
			};
		} catch {
			return undefined;
		}
	}

	private async _drainBrainCuration(model: Model<Api>, maxJobs: number): Promise<void> {
		try {
			// ACCUMULATE across all drained jobs (the drain runs the completer once PER job) —
			// keeping only the last job's usage would under-report every multi-job drain.
			let spentUsage: AssistantMessage["usage"] | undefined;
			const results = await this._brainCurator.drain({
				maxJobs,
				complete: async ({ systemPrompt, userPrompt, signal }) => {
					const completion = await this.runIsolatedCompletion({
						systemPrompt,
						messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
						model,
						thinkingLevel: "off",
						maxTokens: 256,
						signal,
						// Both curation system prompts are static — the provider can cache the prefix.
						cacheRetention: "short",
					});
					const usage = completion.usage;
					if (!spentUsage) {
						spentUsage = structuredClone(usage);
					} else {
						spentUsage.input += usage.input;
						spentUsage.output += usage.output;
						spentUsage.cacheRead += usage.cacheRead;
						spentUsage.cacheWrite += usage.cacheWrite;
						spentUsage.totalTokens += usage.totalTokens;
						spentUsage.cost.input += usage.cost.input;
						spentUsage.cost.output += usage.cost.output;
						spentUsage.cost.cacheRead += usage.cost.cacheRead;
						spentUsage.cost.cacheWrite += usage.cost.cacheWrite;
						spentUsage.cost.total += usage.cost.total;
					}
					return {
						text: completion.text,
						costUsd: completion.usage.cost.total,
						stopReason: String(completion.stopReason),
					};
				},
			});
			// Honest accounting even for free local models: token visibility is the contract.
			if (spentUsage && (spentUsage.cost.total > 0 || spentUsage.totalTokens > 0)) {
				this.addSpawnedUsage(spentUsage, { label: "context-curator" });
			}
			if (this._disposed || results.length === 0) return;
			this.sessionManager.appendCustomEntry("brain-curation", {
				version: 1,
				results: results.map((result) => ({
					key: result.key,
					kind: result.kind,
					ok: result.ok,
					ms: result.ms,
					...(result.digest !== undefined ? { digest: result.digest } : {}),
					...(result.relevant !== undefined ? { relevant: result.relevant, confidence: result.confidence } : {}),
				})),
				telemetry: this._brainCurator.telemetry(),
			});
		} catch {
			// curation is a sidecar; it must never disrupt a turn
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
	getContextCurationStatus(): {
		enabled: boolean;
		model?: string;
		telemetry: CurationTelemetrySnapshot;
		lastSkipReason?: string;
		lastPreDigestSkipReason?: string;
	} {
		const settings = this.settingsManager.getContextCurationSettings();
		return {
			enabled: settings.enabled,
			model: settings.model,
			telemetry: this._brainCurator.telemetry(),
			lastSkipReason: this._lastCurationSkipReason,
			lastPreDigestSkipReason: this._lastPreDigestSkipReason,
		};
	}

	/** Read-only inspection of the latest prompt-enforcement report, for tests/debugging. */
	getPromptEnforcementReport(): PromptEnforcementReport {
		return this._latestPromptEnforcementReport ?? { turnIndex: this._turnIndex, items: [] };
	}

	/**
	 * Observe-only local memory retrieval (see context/memory-retrieval.ts and
	 * context/okf-memory-provider.ts): default disabled, opt-in setting. When disabled,
	 * never constructs the OKF provider (no directory access under `_memoryOkfDir()` at
	 * all) and returns an empty report -- fully fail-closed. When enabled, queries the
	 * local, read-only OKF provider with the latest user message text (empty if there is
	 * none, e.g. a goal-continuation turn -- degrades to zero results by construction, see
	 * `latestUserMessageText`'s doc comment) under `DEFAULT_LOCAL_MEMORY_EGRESS_POLICY`.
	 * Retrieved items are only ever stored in the report; nothing here touches `messages`,
	 * the transcript, or the provider-visible prompt. Never throws into a live turn: any
	 * failure (including a provider search error) degrades to an empty report.
	 */
	private async _runMemoryRetrieval(messages: AgentMessage[]): Promise<MemoryRetrievalReport> {
		try {
			const settings = this.settingsManager.getMemoryRetrievalSettings();
			if (!settings.enabled) {
				const report = emptyMemoryRetrievalReport(settings.maxResults);
				this._latestMemoryRetrievalReport = report;
				return report;
			}
			const report = await retrieveMemoryForContext(
				[this._getMemoryOkfProvider()],
				{ query: latestUserMessageText(messages), maxResults: settings.maxResults },
				{
					createdAtTurn: this._turnIndex,
					maxResults: settings.maxResults,
					defaultLocalPolicy: DEFAULT_LOCAL_MEMORY_EGRESS_POLICY,
				},
			);
			this._latestMemoryRetrievalReport = report;
			return report;
		} catch {
			const report = emptyMemoryRetrievalReport(0);
			this._latestMemoryRetrievalReport = report;
			return report;
		}
	}

	/** Read-only inspection of the latest memory-retrieval report, for tests/debugging. */
	getMemoryRetrievalReport(): MemoryRetrievalReport {
		return this._latestMemoryRetrievalReport ?? emptyMemoryRetrievalReport(0);
	}

	/**
	 * Bounded prompt-surfacing pilot for local memory evidence (see
	 * context/memory-prompt-block.ts): opt-in, default disabled, and gated on TWO settings
	 * (`enabled` AND `includeInPrompt`) plus a non-empty `report.contextItems` -- the first
	 * two are belt-and-suspenders on top of the fact that `_runMemoryRetrieval` already
	 * leaves `contextItems` empty whenever `enabled` is false, regardless of
	 * `includeInPrompt`. Reuses the `report` this pass's `_runMemoryRetrieval` call already
	 * computed -- never re-queries the provider here.
	 *
	 * Appends exactly one ephemeral `custom`/"memory_evidence" message wrapped by
	 * `wrapUntrustedText` (the same nonce-fenced boundary + always-on system-prompt rule
	 * used for other untrusted content) to the END of `messages`. This is purely additive
	 * (never mutates an existing message) and purely transient: `messages` here is the
	 * array about to be sent to the provider, not `this.agent.state.messages` or anything
	 * persisted via `sessionManager` -- so the injected message can never reach the
	 * transcript, regardless of how many times this pass runs.
	 *
	 * Also records a `MemoryPromptInclusionReport` (context/memory-diagnostics.ts) at each
	 * branch below, for context_audit's diagnostic surface only -- this is pure bookkeeping
	 * alongside the existing branches, not a new branch/condition: the messages returned
	 * are unchanged by this recording.
	 */
	private _maybeAppendMemoryEvidenceBlock(messages: AgentMessage[], report: MemoryRetrievalReport): AgentMessage[] {
		try {
			const settings = this.settingsManager.getMemoryRetrievalSettings();
			const base = {
				enabled: settings.enabled,
				includeInPrompt: settings.includeInPrompt,
				selectedItemCount: report.contextItems.length,
			};
			if (!settings.enabled) {
				this._latestMemoryPromptInclusionReport = {
					...base,
					status: "disabled",
					includedCount: 0,
					omittedCount: 0,
					blockChars: 0,
				};
				return messages;
			}
			if (!settings.includeInPrompt) {
				this._latestMemoryPromptInclusionReport = {
					...base,
					status: "include_disabled",
					includedCount: 0,
					omittedCount: 0,
					blockChars: 0,
				};
				return messages;
			}
			if (report.contextItems.length === 0) {
				this._latestMemoryPromptInclusionReport = {
					...base,
					status: "no_results",
					includedCount: 0,
					omittedCount: 0,
					blockChars: 0,
				};
				return messages;
			}

			const block = buildMemoryPromptBlock(report.contextItems);
			if (!block.text) {
				this._latestMemoryPromptInclusionReport = {
					...base,
					status: "empty_block",
					includedCount: block.includedCount,
					omittedCount: block.omittedCount,
					blockChars: 0,
				};
				return messages;
			}

			const wrapped = wrapUntrustedText(block.text, "memory:pi-okf");
			const evidenceMessage: CustomMessage = {
				role: "custom",
				customType: "memory_evidence",
				content: [{ type: "text", text: wrapped }],
				display: false,
				timestamp: Date.now(),
			};
			this._latestMemoryPromptInclusionReport = {
				...base,
				status: "included",
				includedCount: block.includedCount,
				omittedCount: block.omittedCount,
				blockChars: wrapped.length,
				sourceLabel: "memory:pi-okf",
			};
			return [...messages, evidenceMessage];
		} catch {
			// `base` may not exist yet if the throw happened before it was computed (e.g.
			// settings access or `report.contextItems` itself threw), so this branch cannot
			// rely on it -- fall back to safe, fixed defaults rather than risk referencing
			// a partially-evaluated value.
			this._latestMemoryPromptInclusionReport = {
				enabled: false,
				includeInPrompt: false,
				selectedItemCount: 0,
				status: "failed",
				includedCount: 0,
				omittedCount: 0,
				blockChars: 0,
			};
			return messages;
		}
	}

	/** Read-only inspection of the latest memory-prompt-inclusion decision, for tests/debugging and context_audit. */
	getMemoryPromptInclusionReport(): MemoryPromptInclusionReport {
		return this._latestMemoryPromptInclusionReport ?? defaultMemoryPromptInclusionReport();
	}

	/**
	 * Combines the already-stored, no-arg latest reports (never re-queries the provider or
	 * touches the OKF directory) into the safe, allow-list-projected shape context_audit
	 * exposes. See context/memory-diagnostics.ts for why this projection is allow-list
	 * based rather than a spread-then-delete of the raw report.
	 */
	private _getMemoryAuditDiagnostics(): {
		retrieval: MemoryRetrievalDiagnostics;
		promptInclusion: MemoryPromptInclusionReport;
	} {
		const settings = this.settingsManager.getMemoryRetrievalSettings();
		return {
			retrieval: sanitizeMemoryRetrievalReportForDiagnostics(this.getMemoryRetrievalReport(), settings),
			promptInclusion: this.getMemoryPromptInclusionReport(),
		};
	}

	private _applyContextGc(
		messages: AgentMessage[],
		writePayloads: boolean,
	): { messages: AgentMessage[]; report: ContextGcReport } {
		try {
			const settings = this.settingsManager.getContextGcSettings();
			// Merge the ACTIVE memory providers' own page markers (e.g. transcript-recall's
			// "<memory_context") into the semantic-memory marker list. The settings default is
			// provider-agnostic and non-empty, so without this merge the recall pages the bundled
			// default provider actually emits are never recognized as semantic-memory pages and
			// accumulate raw for the life of the session — the exact growth Bug #7 GC exists to stop.
			const providerMarkers = this._memoryManager.getContextMarkers();
			const curationSettings = this.settingsManager.getContextCurationSettings();
			const result = applyContextGc(messages, {
				...settings,
				semanticMemory: {
					...settings.semanticMemory,
					markers: [...new Set([...settings.semanticMemory.markers, ...providerMarkers])],
				},
				cwd: this._cwd,
				storageDir: this._contextGcStorageDir(),
				writePayloads,
				curation: curationSettings.enabled
					? {
							resolveDigest: (digestKey) => {
								const digest = this._brainCurator.getDigest(digestKey);
								// Count serves on the REAL per-turn pass only, never the report path.
								if (digest !== undefined && writePayloads) this._brainCurator.noteDigestServed();
								return digest;
							},
							// Only the real per-turn pass enqueues work; the read-only report path
							// (writePayloads=false) stays side-effect free.
							onPacked: writePayloads
								? (record, originalText) => {
										this._brainCurator.enqueue({
											kind: "stub_digest",
											key: record.key ?? record.toolCallId,
											content: originalText,
										});
									}
								: undefined,
						}
					: undefined,
			});
			this._latestContextGcReport = result.report;
			// Only release/reclaim on the real per-turn pass (writePayloads=true), never on
			// the read-only status-report path (getContextGcReport with writePayloads=false),
			// so merely inspecting the report can't have side effects.
			if (writePayloads && result.report.packedCount > 0) {
				this._releaseGcPackedArtifactReferences(messages, result.report);
			}
			return result;
		} catch {
			const report: ContextGcReport = {
				enabled: false,
				packedCount: 0,
				originalTokens: 0,
				packedTokens: 0,
				savedTokens: 0,
				records: [],
			};
			this._latestContextGcReport = report;
			return { messages, report };
		}
	}

	/**
	 * Reference-release + cleanup lifecycle: once context-gc has packed a grep/find tool
	 * result out of the live prompt (the message is no longer current/active working
	 * context -- see contracts-and-retention.md's "ephemeral"/"expired" retention
	 * classes), release the pack-time reference `packToolOutput()` registered for it, and
	 * opportunistically reclaim now-unreferenced artifacts. This is the other half of the
	 * D2b-1 gate: artifacts were being registered but never released, so they accumulated
	 * for the life of the session.
	 *
	 * `record.toolCallId` (from context-gc's packed record) is exactly the holder id
	 * `packToolOutput()` used when it called `addReference()` -- both trace back to the
	 * same tool call's id -- so no separate bookkeeping is needed to find it.
	 */
	private _releaseGcPackedArtifactReferences(messages: AgentMessage[], report: ContextGcReport): void {
		const store = this._toolArtifactStore;
		if (!store) return; // no store was ever constructed, so nothing could have been packed to one

		let releasedAny = false;
		for (const record of report.records) {
			if (record.toolName !== "grep" && record.toolName !== "find") continue;
			const artifactId = extractArtifactId(messages[record.messageIndex]);
			if (!artifactId) continue;
			if (store.removeReference(artifactId, record.toolCallId)) releasedAny = true;
		}
		// Cleanup only runs immediately after a release actually happened in this pass, so
		// a long session doesn't re-scan the artifact directory on every turn once nothing
		// new became eligible for release.
		if (releasedAny) store.cleanup();
	}

	getContextGcReport(messages?: AgentMessage[]): ContextGcReport {
		if (messages) return this._applyContextGc(messages, false).report;
		return (
			this._latestContextGcReport ?? {
				enabled: this.settingsManager.getContextGcSettings().enabled,
				packedCount: 0,
				originalTokens: 0,
				packedTokens: 0,
				savedTokens: 0,
				records: [],
			}
		);
	}

	private _estimateCurrentContextTokens(messages: AgentMessage[]): number {
		const estimate = estimateContextTokens(messages);
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		if (estimate.lastUsageIndex === null || !compactionEntry) {
			return estimate.tokens;
		}
		const usageMessage = messages[estimate.lastUsageIndex];
		if (usageMessage?.role !== "assistant") {
			return estimate.tokens;
		}
		const usageTimestamp = (usageMessage as AssistantMessage).timestamp;
		const compactionTimestamp = new Date(compactionEntry.timestamp).getTime();
		if (usageTimestamp <= compactionTimestamp) {
			return estimate.trailingTokens;
		}
		return estimate.tokens;
	}

	private _installAgentToolHooks(): void {
		this.agent.beforeToolCall = async ({ toolCall, args }) => {
			if (
				this._activeModelRouterRoute &&
				shouldEscalateModelRouterTool({
					tier: this._activeModelRouterRoute.tier,
					toolName: toolCall.name,
					args,
					reasonCode: this._activeModelRouterRoute.reasonCode,
				})
			) {
				this._modelRouterEscalationRequested = true;
				this.agent.abort();
				return {
					block: true,
					reason:
						"Model router escalation required: a cheap research turn attempted a mutating tool. Retry the turn on the configured expensive model.",
				};
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
			this._isModelRouterRetry &&
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
			const modelRouterBuffer = this._modelRouterSessionBuffer;
			if (modelRouterBuffer && event.message.role === "custom") {
				bufferModelRouterSessionCustomMessage(modelRouterBuffer, event.message);
			} else if (
				modelRouterBuffer &&
				(event.message.role === "user" || event.message.role === "assistant" || event.message.role === "toolResult")
			) {
				bufferModelRouterSessionMessage(modelRouterBuffer, event.message as Message);
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
				if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {
					this._emit({
						type: "auto_retry_end",
						success: true,
						attempt: this._retryAttempt,
					});
					this._retryAttempt = 0;
				}
			}
		}
	};

	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled || this._retryAttempt >= settings.maxRetries) {
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
			this._clearGoalAutoContinueTimer();
			this._clearResearchLaneTimer();
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
			this._researchLaneAbort.abort();
			this._workerDelegationAbort.abort();
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
		void this._memoryManager.shutdownAll().catch(() => {});
		cleanupSessionResources(this.sessionId);
		// Best-effort final sweep for any grep/find artifact already released (reference
		// count zero) but not yet reclaimed -- e.g. a release whose cleanup() call failed
		// transiently. This is conservative: it never releases a still-referenced
		// artifact, so a session that ends before context-gc ever evicts a result (too
		// short to cross preserveRecentMessages) correctly leaves that artifact in place,
		// resolvable if the same session is resumed later. It does not sweep OTHER
		// sessions' artifact directories.
		try {
			this._toolArtifactStore?.cleanup();
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
		return this._retryAttempt;
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

	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}

	/**
	 * R6: the active profile's situational soul, wrapped so the model reads it as its identity for this
	 * situation. Empty when no active profile defines a soul.
	 */
	private _buildSituationSoulPrompt(): string | undefined {
		const soul = this.settingsManager.getActiveProfileSoul();
		if (!soul) return undefined;
		return `<situation_soul>\n${soul}\n</situation_soul>`;
	}

	private _buildSelfModificationPrompt(): string | undefined {
		const settings = this.settingsManager.getSelfModificationSettings();
		if (!settings.enabled) {
			return undefined;
		}

		// Resolve from an ordered candidate list first (portable WSL/Termux switching
		// from settings alone), then fall back to the legacy single sourcePath.
		const rawCandidates = [
			...(Array.isArray(settings.sourcePaths) ? settings.sourcePaths : []),
			...(settings.sourcePath ? [settings.sourcePath] : []),
		]
			.map((candidate) => candidate?.trim())
			.filter((candidate): candidate is string => Boolean(candidate));

		if (rawCandidates.length === 0) {
			return `Pi self-modification guardrails (local setting active, source missing):
- Self-modification is enabled, but no \`selfModification.sourcePaths\`/\`selfModification.sourcePath\` value is set.
- Do not modify Pi core or runtime output. Ask the user to set \`selfModification.sourcePaths\` to the pi-adaptative source checkout before proceeding.`;
		}

		const resolvedCandidates = rawCandidates.map((candidate) => resolvePath(candidate, this._cwd, { trim: true }));
		const sourcePath =
			resolvedCandidates.find(
				(candidate) => existsSync(candidate) && existsSync(resolvePath("package.json", candidate)),
			) ?? resolvedCandidates[0];
		const sourceLooksValid = existsSync(sourcePath) && existsSync(resolvePath("package.json", sourcePath));
		const sourceStatus = sourceLooksValid
			? sourcePath
			: `${sourcePath} (missing or not a source checkout; ask the user to correct \`selfModification.sourcePaths\` before editing)`;
		const autonomy = this.settingsManager.getAutonomySettings();
		const settingsGate =
			autonomy.mode === "full"
				? "In autonomy.mode=full, autonomy/autoLearn setting tuning is covered by the standing autonomy grant; ask before changing credentials, provider auth, package sources, or unrelated preferences."
				: "Ask for explicit approval before changing global settings.";
		return `Pi self-modification guardrails (local setting active):
- Authorized pi-adaptative source path: ${sourceStatus}
- Only modify Pi core/harness source under the authorized source path; never patch installed node_modules or generated runtime output as the source of truth.
- Before changing Pi itself, restate the objective and scope, inspect relevant source/docs/examples, and make the smallest auditable change.
- Preserve user changes: check git status before and after, avoid unrelated edits, and do not overwrite concurrent work.
- Validate with focused tests and broader checks proportional to risk before claiming success.
- Reload/restart/renew only after source changes are saved and auditable.
- ${settingsGate}
- Always ask for explicit approval before publishing, pushing, tagging, or releasing.`;
	}

	private _buildAutonomyPrompt(): string | undefined {
		const autoLearn = this.settingsManager.getAutoLearnSettings();
		const autonomy = this.settingsManager.getAutonomySettings();
		if (!autoLearn.enabled && autonomy.mode !== "full") {
			return undefined;
		}

		const reflection = autoLearn.reflectionReview ?? autonomy.mode !== "off";
		const model = autoLearn.model?.trim() || "active";
		if (autonomy.mode === "full") {
			return `Pi autonomy policy (mode full, standing autonomy):
- Setting-authorized background learners may run after long sessions or corrective/complex turns using model ${model}; they may act without asking first inside this standing grant.
- Standing grant: write high-confidence durable memory, create/patch user/project skills, create/patch small user/project extensions/tools, tune autonomy/autoLearn settings, edit the authorized selfModification.sourcePath, run validation, and leave audit/rollback evidence.
- Hard stops still require explicit foreground approval: publish/npm release, git push, tag creation, credential/provider-auth changes, destructive user-data deletion, network-exposed services, or expanding authority beyond this policy.
- Treat current-turn evidence as a cue, not proof; prefer deterministic or longitudinal corroboration for durable behavior changes.
- Active-task work remains primary: autonomy runs must not interrupt user-visible execution or claim task completion without evidence.`;
		}
		return `Pi autonomy policy (mode ${autonomy.mode}):
- Setting-authorized background learners may run after long sessions${reflection ? " or corrective/complex turns" : ""} using model ${model}.
- Background learning may query durable memory and run bounded learning tools.
- Auto-apply is limited to high-confidence durable memory when explicitly configured; tooling, skill, prompt, extension, settings, and core-source changes stay proposal/approval-gated.
- Treat current-turn evidence as a cue, not proof; prefer longitudinal corroboration before changing durable behavior.
- Active-task work remains primary: learning runs must not interrupt user-visible execution or claim task completion.`;
	}

	private _buildSystemPromptOptionsForToolNames(toolNames: string[]): BuildSystemPromptOptions {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		for (const name of validToolNames) {
			const snippet = this._toolPromptSnippets.get(name);
			if (snippet) {
				toolSnippets[name] = snippet;
			}

			const toolGuidelines = this._toolPromptGuidelines.get(name);
			if (toolGuidelines) {
				promptGuidelines.push(...toolGuidelines);
			}
		}

		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
		const appendSystemPromptParts = [
			// R6: situational soul — the active profile's identity prefix, switched atomically with the
			// profile's capabilities/model. Most prominent, so it comes first.
			this._buildSituationSoulPrompt(),
			// Always-on untrusted-content boundary contract (gives the <untrusted_content> fences meaning).
			UNTRUSTED_BOUNDARY_SYSTEM_RULE,
			this._buildSelfModificationPrompt(),
			this._buildAutonomyPrompt(),
			// Memory subsystem: static, frozen-per-session block (e.g. file-store MEMORY.md/USER.md).
			this._memoryManager.buildSystemPromptBlock() || undefined,
			...loaderAppendSystemPrompt,
		].filter((part): part is string => Boolean(part));
		const appendSystemPrompt = appendSystemPromptParts.length > 0 ? appendSystemPromptParts.join("\n\n") : undefined;
		// Only surface skills the active profile permits — the agent must not be told about (or able
		// to invoke) a skill its profile blocks.
		const loadedSkills = this._resourceLoader.getActiveSkills();
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;

		return {
			cwd: this._cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			selectedTools: validToolNames,
			toolSnippets,
			promptGuidelines,
			extensions: [...this._extensionRunner.activeExtensions],
		};
	}

	private _rebuildSystemPrompt(toolNames: string[]): string {
		this._baseSystemPromptOptions = this._buildSystemPromptOptionsForToolNames(toolNames);
		return buildSystemPrompt(this._baseSystemPromptOptions);
	}

	/**
	 * Build a system prompt for a specific tool surface WITHOUT touching the session's base prompt
	 * state. Used for a router-swapped turn (G4): the routed model runs against a filtered tool set,
	 * so it must also receive a system prompt whose tool guidelines/snippets match that filtered
	 * surface — but the change is per-turn, so it must not mutate `_baseSystemPromptOptions` (which
	 * later turns and extension events read).
	 */
	private _buildSystemPromptForToolNames(toolNames: string[]): string {
		return buildSystemPrompt(this._buildSystemPromptOptionsForToolNames(toolNames));
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

	private _isModelAvailableAndAuthed(pattern: string): boolean {
		const resolved = resolveCliModel({ cliModel: pattern, modelRegistry: this._modelRegistry });
		if (!resolved.model) return false;
		return this._modelRegistry.hasConfiguredAuth(resolved.model);
	}

	private _resolveExecutorRoute(
		prompt: string,
		executorPattern: string | undefined,
	): { decision: RouteDecision; model: Model<Api> } | undefined {
		if (!executorPattern) return undefined;
		try {
			const verdict = classifyExecutorTurn(prompt, this.settingsManager.getToolkitScripts());
			if (!verdict.execute) return undefined;
			const resolved = resolveCliModel({ cliModel: executorPattern, modelRegistry: this._modelRegistry });
			if (!resolved.model || !this._modelRegistry.hasConfiguredAuth(resolved.model)) return undefined;
			// Fitness gate: the executor must have PROVEN tool-calling on this host (same
			// canonical-ref discipline as the curation gate).
			const canonicalRef = `${resolved.model.provider}/${resolved.model.id}`;
			const fitness = FitnessStore.forAgentDir(this._agentDir)
				.getForHost()
				.find((entry) => entry.model === canonicalRef);
			const toolCall = fitness?.report.toolCall;
			if (!toolCall || toolCall.succeeded < Math.ceil(toolCall.total * (2 / 3))) return undefined;
			this._lastModelRouterIntent = "research";
			return {
				decision: {
					tier: "cheap",
					risk: "scoped-write",
					confidence: 1,
					reasonCode: "executor_direct",
					reasons: [`Executor lane: Level-0 direct hit on toolkit script "${verdict.scriptName}"`],
				},
				model: resolved.model,
			};
		} catch {
			return undefined;
		}
	}

	/** True if a run_toolkit_script tool result since `fromIndex` actually EXECUTED (not error/ambiguous). */
	private _executorTurnExecutedScript(fromIndex: number): boolean {
		for (const message of this.agent.state.messages.slice(fromIndex)) {
			if ((message as { role?: string }).role !== "toolResult") continue;
			if ((message as { toolName?: string }).toolName !== "run_toolkit_script") continue;
			if ((message as { isError?: boolean }).isError === true) continue;
			const outcome = (message as { details?: { outcome?: unknown } }).details?.outcome;
			if (outcome === "executed") return true;
		}
		return false;
	}

	/** Ask the reflex brain to refine the last user request into an explicit toolkit instruction. */
	private async _buildExecutorRefinedPrompt(messages: AgentMessage | AgentMessage[]): Promise<string | undefined> {
		try {
			const model = this._resolveCurationModelIfFit();
			if (!model) return undefined;
			const list = Array.isArray(messages) ? messages : [messages];
			const request = latestUserPromptText(list.filter((m): m is AgentMessage => true));
			if (!request) return undefined;
			const scripts = this.settingsManager.getToolkitScripts();
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
				this.addSpawnedUsage(completion.usage, { label: "executor-brain-warmup" });
			}
			const plan = parseReflexPlan(completion.text);
			if (!plan || plan.script === "none") return undefined;
			const argHint = plan.args.length > 0 ? ` with args ${JSON.stringify(plan.args)}` : "";
			return `Run the toolkit script "${plan.script}"${argHint} using run_toolkit_script, then report its result exactly.`;
		} catch {
			return undefined;
		}
	}

	/**
	 * Shared {@link OllamaRuntime} for a given server, lazily created and cached by baseUrl so every
	 * caller — the router's readiness gate below and any host UI's own model-lifecycle commands
	 * (e.g. `/models`) — sees and can stop the SAME pi-managed process instead of each tracking its
	 * own untracked child.
	 */
	getLocalRuntime(baseUrl?: string): OllamaRuntime {
		const key = baseUrl ?? "default";
		let runtime = this._localRuntimes.get(key);
		if (!runtime) {
			runtime = new OllamaRuntime({ agentDir: this._agentDir, baseUrl, deps: this._localRuntimeDeps });
			this._localRuntimes.set(key, runtime);
		}
		return runtime;
	}

	/** models.json registers a local model's baseUrl as `<server>/v1` (OpenAI-compat); the runtime's
	 * own health/boot endpoints are on the Ollama-native server root. */
	private _deriveOllamaServerUrl(modelBaseUrl: string): string {
		return modelBaseUrl.replace(/\/v1\/?$/, "");
	}

	/**
	 * If the last assistant message in this session was an error from THIS exact local server, a
	 * cached "confirmed up" flag would be stale (the server may have died mid-session) — drop it so
	 * the next ensure-check is a real one instead of trusting stale state.
	 */
	private _invalidateLocalRuntimeIfLastCallFailed(model: Model<Api>, serverUrl: string): void {
		const lastAssistant = this._findLastAssistantMessage();
		if (
			lastAssistant?.stopReason === "error" &&
			lastAssistant.provider === OLLAMA_PROVIDER &&
			lastAssistant.model === model.id
		) {
			this._localRuntimeConfirmedUp.delete(serverUrl);
		}
	}

	/**
	 * Ensure a routed model is actually reachable before the turn calls it. No-op (and free) for any
	 * non-local model — this only ever does network/process work for the `ollama` provider. Caches a
	 * "confirmed up this session" flag per server so a steady-state session pays the health-check
	 * round trip once, not on every turn; invalidated above when a prior local call actually failed,
	 * so a server that died mid-session gets re-detected rather than trusted forever. Boots via
	 * `startReuseExisting()` — never owned storage — so the turn sees the user's OWN pulled models,
	 * the same server `/models` commands and the user's own `ollama` CLI already talk to. Never
	 * installs anything itself (installGuide is GUIDE MODE: printed, never executed).
	 */
	private async _ensureLocalModelReady(
		model: Model<Api>,
	): Promise<{ ready: boolean; reason: string; installGuide?: string[] }> {
		if (model.provider !== OLLAMA_PROVIDER) {
			return { ready: true, reason: "not_local" };
		}
		const serverUrl = this._deriveOllamaServerUrl(model.baseUrl);
		this._invalidateLocalRuntimeIfLastCallFailed(model, serverUrl);
		if (this._localRuntimeConfirmedUp.has(serverUrl)) {
			return { ready: true, reason: "confirmed_up_cached" };
		}
		const runtime = this.getLocalRuntime(serverUrl);
		const status = await runtime.detect();
		if (status.serverUp) {
			this._localRuntimeConfirmedUp.add(serverUrl);
			return { ready: true, reason: "already_running" };
		}
		if (!status.binaryPath) {
			return { ready: false, reason: "binary_missing", installGuide: runtime.installGuide() };
		}
		const started = await runtime.startReuseExisting();
		if (started.started) {
			this._localRuntimeConfirmedUp.add(serverUrl);
		}
		return { ready: started.started, reason: started.reason };
	}

	/**
	 * Router-swap gate (#27): a turn routed to a local model (any tier, including an executor-direct
	 * route — both carry tier "cheap") must not dead-end the turn just because ollama isn't up.
	 * Never a SILENT swap: every fallback is announced in a warning that states (i) the local model
	 * was unavailable and WHY — binary missing surfaces the install guide inline; any other reason
	 * gets a "check that ollama is running" hint — and (ii) which tier is now handling the turn, so
	 * the cost shift is never a surprise. Escalates cheap -> medium -> expensive, skipping any
	 * unconfigured intermediate tier, reusing the router's own existing "model unavailable"
	 * resolution (_resolveConfiguredTierModel) rather than inventing a new fallback mechanism.
	 * Escalation is bounded: tier strictly increases each hop, so it terminates within two hops.
	 *
	 * Seam for a future interactive consent-gate (deferred — pending the managed-install-vs-guide
	 * decision, see #31): this is the one place that already knows both WHY the local model failed
	 * and WHETHER a fallback exists, so a future "install it now?" prompt slots in right here, before
	 * the warning/escalation below runs.
	 */
	private async _ensureRouteModelReady(
		resolved: { decision: RouteDecision; model: Model<Api> } | undefined,
	): Promise<{ decision: RouteDecision; model: Model<Api> } | undefined> {
		let current = resolved;
		while (current && current.model.provider === OLLAMA_PROVIDER) {
			const readiness = await this._ensureLocalModelReady(current.model);
			if (readiness.ready) return current;

			// Walk the remaining tiers in order (never back down to cheap) and take the first one that
			// actually resolves — an unconfigured intermediate tier (e.g. no mediumModel set) must be
			// skipped, not treated as "no fallback available".
			const startIndex = MODEL_ROUTER_TIER_ORDER.indexOf(current.decision.tier);
			let escalated: { tier: "medium" | "expensive"; model: Model<Api> } | undefined;
			for (let i = startIndex + 1; startIndex !== -1 && i < MODEL_ROUTER_TIER_ORDER.length; i++) {
				const tier = MODEL_ROUTER_TIER_ORDER[i] as "medium" | "expensive";
				const model = this._resolveConfiguredTierModel(tier);
				if (model) {
					escalated = { tier, model };
					break;
				}
			}

			const modelLabel = formatModelRouterModel(current.model);
			const whyText = readiness.installGuide
				? ["the ollama binary is not installed.", ...readiness.installGuide].join("\n")
				: `its server is not reachable (${readiness.reason}) — check that ollama is running.`;
			const fallbackText = escalated
				? `Falling back to the ${escalated.tier} tier for this turn.`
				: "No other tier is configured — falling back to the session's default model.";
			this._emit({
				type: "warning",
				message: `Local model "${modelLabel}" is unavailable: ${whyText}\n${fallbackText}`,
			});

			if (!escalated) return undefined; // no higher tier resolves — caller falls back to the session default
			current = {
				model: escalated.model,
				decision: {
					...current.decision,
					tier: escalated.tier,
					fallbackFrom: current.decision.tier,
					reasonCode: "local_model_not_ready_fallback",
					reasons: [
						...current.decision.reasons,
						`Local model not ready (${readiness.reason}); escalated to ${escalated.tier}`,
					],
					model: formatModelRouterModel(escalated.model),
				},
			};
		}
		return current;
	}

	private _resolveModelRouterTurnRoute(prompt: string): { decision: RouteDecision; model: Model<Api> } | undefined {
		const settings = this.settingsManager.getModelRouterSettings();
		if (!settings.enabled) {
			this._lastModelRouterSkipReason = "disabled";
			return undefined;
		}

		// G16 executor lane: a Level-0 DIRECT toolkit hit on a command-shaped prompt routes the
		// whole turn to the configured local executor (tool-call-fitness-gated) instead of
		// spending the frontier model on a one-tool reflex. Ambiguity never routes here — it
		// stays with the big model and the reflex brain. Deterministic, so the judge is skipped.
		const executorRoute = this._resolveExecutorRoute(prompt, settings.executorModel);
		if (executorRoute) return executorRoute;

		const decision = classifyModelRouterRoute(prompt);
		this._lastModelRouterIntent = decision.tier === "cheap" ? "research" : "modify";

		// Learning tier must not be selected for normal user prompts
		if (decision.tier === "learning") {
			this._lastModelRouterSkipReason = "learning tier not supported for user prompts";
			return undefined;
		}

		const modelPattern =
			settings[
				decision.tier === "cheap" ? "cheapModel" : decision.tier === "medium" ? "mediumModel" : "expensiveModel"
			];
		const label =
			decision.tier === "cheap" ? "cheap model" : decision.tier === "medium" ? "medium model" : "expensive model";

		if (decision.tier === "medium" && (!modelPattern || !this._isModelAvailableAndAuthed(modelPattern))) {
			const expensivePattern = settings.expensiveModel;
			if (expensivePattern && this._isModelAvailableAndAuthed(expensivePattern)) {
				const resolvedExpensive = resolveCliModel({
					cliModel: expensivePattern,
					modelRegistry: this._modelRegistry,
				});
				if (resolvedExpensive.model) {
					decision.fallbackFrom = "medium";
					decision.tier = "expensive";
					decision.reasonCode = "medium_unavailable_fallback_expensive";
					decision.reasons = [...decision.reasons, "Medium model is unavailable, falling back to expensive model"];
					decision.model = formatModelRouterModel(resolvedExpensive.model);
					this._lastModelRouterSkipReason = undefined;
					return { decision, model: resolvedExpensive.model };
				}
			}
			this._lastModelRouterSkipReason = "medium model and expensive fallback are unavailable";
			return undefined;
		}

		if (!modelPattern) {
			this._lastModelRouterSkipReason = `${label} unset`;
			return undefined;
		}

		const resolved = resolveCliModel({ cliModel: modelPattern, modelRegistry: this._modelRegistry });
		if (!resolved.model) {
			this._lastModelRouterSkipReason = `${label} unresolved: ${modelPattern}`;
			return undefined;
		}

		const resolvedName = formatModelRouterModel(resolved.model);
		if (!this._modelRegistry.hasConfiguredAuth(resolved.model)) {
			this._lastModelRouterSkipReason = `${label} missing auth: ${resolvedName}`;
			return undefined;
		}

		this._lastModelRouterSkipReason = undefined;
		decision.model = resolvedName;
		return { decision, model: resolved.model };
	}

	private _resolveModelRouterModelForIntent(intent: ModelRouterIntent): Model<Api> | undefined {
		const settings = this.settingsManager.getModelRouterSettings();
		const modelPattern = intent === "research" ? settings.cheapModel : settings.expensiveModel;
		if (!modelPattern) return undefined;
		const resolved = resolveCliModel({ cliModel: modelPattern, modelRegistry: this._modelRegistry });
		if (!resolved.model) return undefined;
		if (!this._modelRegistry.hasConfiguredAuth(resolved.model)) return undefined;
		return resolved.model;
	}

	private _resolveConfiguredTierModel(tier: "cheap" | "medium" | "expensive"): Model<Api> | undefined {
		const settings = this.settingsManager.getModelRouterSettings();
		const pattern =
			tier === "cheap" ? settings.cheapModel : tier === "medium" ? settings.mediumModel : settings.expensiveModel;
		if (!pattern) return undefined;
		const resolved = resolveCliModel({ cliModel: pattern, modelRegistry: this._modelRegistry });
		if (!resolved.model) return undefined;
		if (!this._modelRegistry.hasConfiguredAuth(resolved.model)) return undefined;
		return resolved.model;
	}

	/**
	 * Router resolution with the routing judge (auto-on with the router): the regex classifier's
	 * decision is the baseline; when a judge model resolves (judgeModel, else mediumModel), one
	 * bounded, tool-less completion may move the tier between cheap/medium/expensive — never to
	 * learning. Core rule encoded in the judge prompt: planning is never cheap unless genuinely
	 * trivial. Every fallback stays visible in the decision reasons, and judge spend reports
	 * through spawned-usage accounting.
	 */
	private async _resolveModelRouterTurnRouteJudged(
		prompt: string,
		options?: { skipJudge?: boolean },
	): Promise<{ decision: RouteDecision; model: Model<Api> } | undefined> {
		const baseline = this._resolveModelRouterTurnRoute(prompt);
		if (!baseline) return undefined;
		if (options?.skipJudge) return baseline;
		// Deterministic executor routes need no judge (Level-0 already decided).
		if (baseline.decision.reasonCode === "executor_direct") return baseline;

		const settings = this.settingsManager.getModelRouterSettings();
		if (!settings.judgeEnabled) return baseline;
		const judgePattern = settings.judgeModel ?? settings.mediumModel;
		if (!judgePattern) return baseline;
		const judgeModel = this._resolveLaneModel(judgePattern);
		if (!judgeModel) return baseline;

		let spentUsage: Usage | undefined;
		const judged = await runRouteJudge({
			prompt,
			baseline: baseline.decision,
			signal: this._reflectionAbort.signal,
			complete: async ({ systemPrompt, userPrompt, signal }) => {
				const completion = await this.runIsolatedCompletion({
					systemPrompt,
					messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
					model: judgeModel,
					// Per-tier thinking (R1): judgeThinking overrides the judge's own completion; unset
					// keeps today's "off" (the judge is a cheap classification call by default).
					thinkingLevel: settings.judgeThinking ?? "off",
					maxTokens: ROUTE_JUDGE_MAX_OUTPUT_TOKENS,
					signal,
					// The judge system prompt is static — the provider can cache the prefix.
					cacheRetention: "short",
				});
				spentUsage = completion.usage;
				return {
					text: completion.text,
					costUsd: completion.usage.cost.total,
					stopReason: String(completion.stopReason),
				};
			},
		});
		if (spentUsage && (spentUsage.cost.total > 0 || spentUsage.totalTokens > 0)) {
			this.addSpawnedUsage(spentUsage, { label: "router-judge" });
		}

		if (!judged.verdict || judged.decision.tier === baseline.decision.tier) {
			// Same tier (or judge fell back): keep the baseline model, carry the annotated decision.
			return { decision: judged.decision, model: baseline.model };
		}

		const judgedTier = judged.decision.tier;
		if (judgedTier !== "cheap" && judgedTier !== "medium" && judgedTier !== "expensive") {
			return { decision: baseline.decision, model: baseline.model };
		}
		const judgedModel = this._resolveConfiguredTierModel(judgedTier);
		if (!judgedModel) {
			return {
				decision: {
					...baseline.decision,
					reasons: [
						...baseline.decision.reasons,
						`Route judge chose ${judgedTier} but no model resolves for that tier; baseline kept`,
					],
				},
				model: baseline.model,
			};
		}
		return { decision: { ...judged.decision, model: formatModelRouterModel(judgedModel) }, model: judgedModel };
	}

	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: test seam
	private _resolveModelRouterTurnModel(prompt: string): Model<Api> | undefined {
		const resolved = this._resolveModelRouterTurnRoute(prompt);
		return resolved?.model;
	}

	getModelRouterStatus(formatLabel?: (label: string) => string): string {
		const recentDecisions = getRecentModelRouterDecisions(this.sessionManager.getEntries());
		const lastDecision = this._lastModelRouterDecision ?? recentDecisions.at(-1);
		const historicalDecisions = this._lastModelRouterDecision ? recentDecisions : recentDecisions.slice(0, -1);
		const settings = this.settingsManager.getModelRouterSettings();
		const lines = [
			formatModelRouterStatus(
				settings,
				lastDecision,
				formatLabel,
				historicalDecisions,
				this._lastModelRouterSkipReason,
				this._lastModelRouterIntent ?? lastDecision?.intent,
			),
		];
		const diagnostics = collectModelRouterConfigDiagnostics(settings, this._modelRegistry);
		if (diagnostics.length > 0) {
			lines.push(formatLabel ? formatLabel("Config diagnostics:") : "Config diagnostics:");
			for (const diagnostic of diagnostics) {
				lines.push(`- ${diagnostic}`);
			}
		}
		return lines.join("\n");
	}

	private async _runAgentPromptWithModelRouter(
		messages: AgentMessage | AgentMessage[],
		routedModel: Model<Api> | undefined,
		routeDecision: RouteDecision | undefined,
		persistDecision = true,
	): Promise<void> {
		if (!routedModel) {
			await this._runAgentPrompt(messages);
			return;
		}

		const previousModel = this.agent.state.model;
		const previousThinkingLevel = this.agent.state.thinkingLevel;
		const previousTurnTools = this.agent.state.tools;
		const previousSystemPrompt = this.agent.state.systemPrompt;
		// G4 swap bookkeeping (Bug G): the exact references the swap below assigns, so the finally can
		// restore ONLY what IT put there — never assigned when no swap happens (e.g. a full-class
		// routed profile).
		let swappedTools: typeof previousTurnTools | undefined;
		let swappedSystemPrompt: typeof previousSystemPrompt | undefined;
		const previousActiveModelRouterIntent = this._activeModelRouterIntent;
		const previousActiveModelRouterRoute = this._activeModelRouterRoute;
		const previousModelRouterSessionBuffer = this._modelRouterSessionBuffer;
		const previousModelRouterEscalationRequested = this._modelRouterEscalationRequested;
		const bufferRoutedTurn = routeDecision?.tier === "cheap";
		const originalHistoryLength = this.agent.state.messages.length;
		let retryModel: Model<Api> | undefined;
		let completedDecision: ModelRouterDecisionStatus | undefined = routeDecision
			? {
					route: routeDecision,
					routedModel: formatModelRouterModel(routedModel),
					outcome: "routed",
					intent: routeDecision.tier === "cheap" ? "research" : "modify",
				}
			: undefined;
		let thrownError: unknown;
		if (routeDecision) {
			this._lastModelRouterDecision = completedDecision;
		}
		this._activeModelRouterIntent = routeDecision
			? routeDecision.tier === "cheap"
				? "research"
				: "modify"
			: undefined;
		this._activeModelRouterRoute = routeDecision;
		if (bufferRoutedTurn) {
			this._modelRouterSessionBuffer = createModelRouterSessionBuffer();
			this._modelRouterEscalationRequested = false;
		}
		if (!modelsAreEqual(this.model, routedModel)) {
			this.agent.state.model = routedModel;
			// Per-tier thinking (R1): a configured tier/executor thinking level overrides the inherited
			// session thinking for THIS routed turn only; unset falls back to exactly today's
			// inherit-and-clamp behavior. Executor routes carry tier "cheap" too, so reasonCode is
			// checked first — otherwise an executor turn would silently pick up cheapThinking instead.
			// The judge's own completion has a separate knob (judgeThinking) applied at its call site.
			const routerThinkingSettings = this.settingsManager.getModelRouterSettings();
			const configuredThinking = !routeDecision
				? undefined
				: routeDecision.reasonCode === "executor_direct"
					? routerThinkingSettings.executorThinking
					: routeDecision.tier === "cheap"
						? routerThinkingSettings.cheapThinking
						: routeDecision.tier === "medium"
							? routerThinkingSettings.mediumThinking
							: routeDecision.tier === "expensive"
								? routerThinkingSettings.expensiveThinking
								: undefined;
			this.agent.state.thinkingLevel = clampThinkingLevel(
				routedModel,
				configuredThinking ?? previousThinkingLevel,
			) as ThinkingLevel;
			// G4: capability tool-filtering follows the ROUTED model for the turn. Without this a
			// cheap/local routed model inherits the session model's full tool surface — schemas it
			// pays for on every request and may not be able to drive at all.
			const routedProfile = deriveModelCapabilityProfile({
				contextWindow: routedModel.contextWindow,
				mode: this.settingsManager.getModelCapabilitySettings().mode,
			});
			if (routedProfile.class !== "full") {
				const allowed = new Set(
					filterToolNamesForCapability(
						previousTurnTools.map((tool) => tool.name),
						routedProfile,
					),
				);
				swappedTools = previousTurnTools.filter((tool) => allowed.has(tool.name));
				this.agent.state.tools = swappedTools;
				// G4: the system prompt follows the ROUTED model's filtered surface too — otherwise the
				// cheap/local model is billed for (and told about) tool guidelines/snippets it can't call.
				// Per-turn only; restored in the finally. A live extension override of the prompt is left
				// alone (only shed when we're on the base prompt).
				if (this.agent.state.systemPrompt === this._baseSystemPrompt) {
					swappedSystemPrompt = this._buildSystemPromptForToolNames(
						this.agent.state.tools.map((tool) => tool.name),
					);
					this.agent.state.systemPrompt = swappedSystemPrompt;
				}
			}
		}
		try {
			await this._runAgentPrompt(messages);
			// Speculative muscle-retry (G16 refinement): an executor-routed turn is a bet that the
			// small model can run the toolkit command directly. If it ends WITHOUT a successful
			// run_toolkit_script execution, retry ONCE on the same executor with the brain's
			// refined instruction injected — the brain warms while the muscle tries, so the retry
			// pays only when the muscle actually missed.
			if (
				routeDecision?.reasonCode === "executor_direct" &&
				!this._isModelRouterRetry &&
				!this._executorTurnExecutedScript(originalHistoryLength)
			) {
				const refined = await this._buildExecutorRefinedPrompt(messages);
				if (refined) {
					this.agent.state.messages.splice(originalHistoryLength);
					await this._runAgentPrompt([
						{ role: "user", content: [{ type: "text", text: refined }], timestamp: Date.now() },
					]);
					completedDecision = {
						route: {
							...routeDecision,
							reasonCode: "executor_speculative_retry",
							reasons: [
								...routeDecision.reasons,
								"Executor missed on first try; retried with brain-refined instruction",
							],
						},
						routedModel: formatModelRouterModel(routedModel),
						outcome: "routed",
						intent: "research",
					};
					this._lastModelRouterDecision = completedDecision;
				} else {
					// The muscle missed AND the reflex brain could not refine the request into a toolkit
					// instruction (no fit brain model, or no confident plan). There is deliberately NO
					// frontier fallback here, so surface the miss instead of letting it stand silently —
					// otherwise the routed turn just ends with an unrun command and no explanation.
					this._emit({
						type: "warning",
						message:
							"Executor lane: the toolkit command did not run and the reflex brain could not refine it into an explicit instruction; leaving the turn as-is (no automatic escalation).",
					});
				}
			}
			if (bufferRoutedTurn && this._modelRouterEscalationRequested) {
				this.agent.state.messages.splice(originalHistoryLength);
				retryModel = this._resolveModelRouterModelForIntent("modify") ?? previousModel;
				completedDecision = {
					route: routeDecision!,
					routedModel: formatModelRouterModel(routedModel),
					outcome: "escalated",
					retryModel: formatModelRouterModel(retryModel),
					intent: routeDecision!.tier === "cheap" ? "research" : "modify",
				};
				this._lastModelRouterDecision = completedDecision;
			} else if (bufferRoutedTurn && this._modelRouterSessionBuffer) {
				flushModelRouterSessionBuffer(
					this._modelRouterSessionBuffer,
					(message) => {
						this.sessionManager.appendMessage(message);
					},
					(customType, content, display, details) => {
						this.sessionManager.appendCustomMessageEntry(customType, content, display, details);
					},
				);
			}
		} catch (error) {
			thrownError = error;
			if (completedDecision) {
				completedDecision = { ...completedDecision, outcome: "failed" };
				this._lastModelRouterDecision = completedDecision;
			}
		} finally {
			// Restore the pre-route model ONLY if the routed model is still in place: a command
			// handler may have legitimately changed the session model mid-turn (setModel or a
			// provider re-registration), and clobbering that would silently undo the change.
			if (modelsAreEqual(this.agent.state.model, routedModel)) {
				this.agent.state.model = previousModel;
				this.agent.state.thinkingLevel = previousThinkingLevel;
				// Symmetric restore (Bug G): undo tools/systemPrompt only if each is STILL the exact
				// reference/string the G4 swap above assigned (never assigned at all when the routed
				// profile was full-class — then there is nothing to restore either). An extension calling
				// setActiveToolsByName mid-turn reassigns both to its own values without touching the
				// model — the model guard above still passes, but that live change is legitimate and must
				// survive rather than being silently reverted to the stale pre-turn snapshot.
				if (swappedTools !== undefined && this.agent.state.tools === swappedTools) {
					this.agent.state.tools = previousTurnTools;
				}
				if (swappedSystemPrompt !== undefined && this.agent.state.systemPrompt === swappedSystemPrompt) {
					this.agent.state.systemPrompt = previousSystemPrompt;
				}
				// The registry may have changed mid-turn (command-time registerProvider): re-resolve
				// the restored model so a provider override is not dropped with the routed model.
				this._refreshCurrentModelFromRegistry();
			}
			this._activeModelRouterIntent = previousActiveModelRouterIntent;
			this._activeModelRouterRoute = previousActiveModelRouterRoute;
			this._modelRouterSessionBuffer = previousModelRouterSessionBuffer;
			this._modelRouterEscalationRequested = previousModelRouterEscalationRequested;
		}

		if (retryModel && !thrownError) {
			const previousIsModelRouterRetry = this._isModelRouterRetry;
			try {
				this._isModelRouterRetry = true;
				const retryDecision: RouteDecision = {
					tier: "expensive",
					risk: "high-impact",
					confidence: 1.0,
					reasonCode: "cheap_mutating_tool_escalation",
					reasons: ["Cheap research turn attempted a mutating tool and escalated"],
					fallbackFrom: "cheap",
					model: formatModelRouterModel(retryModel),
				};
				await this._runAgentPromptWithModelRouter(messages, retryModel, retryDecision, false);
				this._lastModelRouterDecision = completedDecision;
			} catch (error) {
				thrownError = error;
				if (completedDecision) {
					completedDecision = { ...completedDecision, outcome: "failed" };
					this._lastModelRouterDecision = completedDecision;
				}
			} finally {
				this._isModelRouterRetry = previousIsModelRouterRetry;
			}
		}

		if (persistDecision && completedDecision) {
			persistModelRouterDecision(this.sessionManager, completedDecision);
			// G3: one route event per user-facing routed turn (the escalation retry runs with
			// persistDecision=false, so it does not double-emit). Codes/numbers only — no prompt text.
			this._emitAutonomyTelemetry({
				type: AUTONOMY_TELEMETRY_EVENT_TYPES.routeDecision,
				timestamp: new Date().toISOString(),
				payload: {
					tier: completedDecision.route.tier,
					risk: completedDecision.route.risk,
					reasonCode: completedDecision.route.reasonCode,
					confidence: completedDecision.route.confidence,
					outcome: completedDecision.outcome,
				},
			});
		}

		if (thrownError) {
			throw thrownError;
		}
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

		if (msg.stopReason === "error" && this._retryAttempt > 0) {
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: msg.errorMessage,
			});
			this._retryAttempt = 0;
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
			this._clearGoalAutoContinueTimer();
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

	/**
	 * Zero-I/O gate for cross-session recall (R3): skip trivial turns (short acks, slash commands) so
	 * recall only runs when it could plausibly help. The provider's similarity cutoff is the real
	 * filter — this just avoids the index query on turns that obviously don't warrant it.
	 */
	private _shouldAttemptRecall(text: string): boolean {
		const t = text.trim();
		if (t.length < 12 || t.startsWith("/")) return false;
		const words = t.split(/\s+/).filter((w) => w.length >= 3);
		// R4 adaptive gate: if recall has rarely been used lately (enough samples to trust the signal),
		// raise the bar so we only recall on clearly substantial turns — and relax it again once recall
		// starts paying off. Never fully disabled, so the loop can recover.
		const recallRarelyUseful =
			this._effectivenessTracker.sampleCount >= 5 && this._effectivenessTracker.usefulLately() < 0.15;
		return words.length >= (recallRarelyUseful ? 6 : 3);
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

			const resolvedRouteInfo = await this._resolveModelRouterTurnRouteJudged(expandedText, {
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
			if (this._shouldAttemptRecall(expandedText)) {
				try {
					const recall = await this._memoryManager.prefetch(expandedText);
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
				this._baseSystemPromptOptions,
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
		await this._runAgentPromptWithModelRouter(messages, routedTurnModel, routedTurnRouteDecision);

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
				this._effectivenessTracker.recordRecallOutcome(injectedRecall, recallQuery, responseText);
			}
		}

		this._scheduleGoalAutoContinueFromIdle(options);
		this._scheduleResearchLaneFromIdle();
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
			if (this.agent.streamFn === streamSimple) {
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
		await this._initializeMemory();
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

	/**
	 * (Re)build the memory subsystem: a fresh MemoryManager (reload-safe), register the bundled
	 * file-store + any extension-contributed providers, initialize, then surface the memory tools and
	 * the frozen system-prompt block. Best-effort: never throws into the session lifecycle.
	 */
	private async _initializeMemory(): Promise<void> {
		try {
			// Release the previous generation's providers (locks/handles) before recreating, so a
			// reload does not orphan the old MemoryManager. No-op on first init / for file-store.
			await this._memoryManager.shutdownAll().catch(() => {});
			const manager = new MemoryManager();
			manager.registerProvider(new FileStoreProvider());
			// Bundled read-only cross-session recall (R3): indexes past-session transcripts and answers
			// prefetch() with a <memory_context> page. Never writes.
			manager.registerProvider(new TranscriptRecallProvider());
			for (const provider of this._pendingMemoryProviders) {
				try {
					manager.registerProvider(provider);
				} catch {
					// Duplicate name or reserved-tool collision — skip this provider, keep the rest.
				}
			}
			this._memoryManager = manager;
			await manager.initializeAll(this.sessionManager.getSessionId(), {
				agentDir: this._agentDir,
				cwd: this._cwd,
				isChildSession: this._isChildSession,
			});
			// Surface memory tools + the frozen memory block now that providers are initialized.
			// _refreshToolRegistry() ends in setActiveToolsByName(), which rebuilds AND assigns the
			// system prompt (including the memory block), so no explicit _rebuildSystemPrompt is needed.
			this._refreshToolRegistry();
		} catch (error) {
			console.error("Memory subsystem init failed:", error instanceof Error ? error.message : String(error));
		}
	}

	/** Register a memory provider contributed by an extension; applied on the next memory (re)init. */
	registerMemoryProvider(provider: MemoryProvider): void {
		if (!this._pendingMemoryProviders.some((p) => p.name === provider.name)) {
			this._pendingMemoryProviders.push(provider);
		}
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
			...this._memoryManager.getToolDefinitions().map((definition) => ({
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
				() => this._getMemoryAuditDiagnostics(),
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
				this._pendingMemoryProviders = [];
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
			await this._initializeMemory();
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

	private _isNonRetryableProviderLimitError(errorMessage: string): boolean {
		return /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i.test(
			errorMessage,
		);
	}

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		if (message.stopReason !== "error" || !message.errorMessage) return false;

		// Context overflow is handled by compaction, not retry
		const contextWindow = this.model?.contextWindow ?? 0;
		if (isContextOverflow(message, contextWindow)) return false;

		const err = message.errorMessage;
		if (this._isNonRetryableProviderLimitError(err)) return false;
		// Match: overloaded_error, provider returned error, rate limit, 429, 500, 502, 503, 504, service unavailable, network/connection errors (including connection lost), WebSocket transport closes/errors, fetch failed, premature stream endings, HTTP/2 closed before response, terminated, retry delay exceeded
		return /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i.test(
			err,
		);
	}

	/**
	 * Prepare a retryable error for continuation with exponential backoff.
	 * @returns true if the caller should continue the agent, false otherwise
	 */
	private async _prepareRetry(message: AssistantMessage): Promise<boolean> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			return false;
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			// Preserve the completed attempt count so post-run handling can emit the final failure.
			this._retryAttempt--;
			return false;
		}

		const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);

		// The retry window counts as active work from the instant listeners hear
		// about it: isRetrying must already be true inside auto_retry_start handlers
		// so prompts arriving there queue as steering instead of racing the retry.
		this._retryAbortController = new AbortController();

		this._emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		// Remove error message from agent state (keep in session for history)
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}

		// Wait with exponential backoff (abortable)
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			// Aborted during sleep - emit end event so UI can clean up
			const attempt = this._retryAttempt;
			this._retryAttempt = 0;
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			return false;
		} finally {
			this._retryAbortController = undefined;
		}

		return true;
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this._retryAbortController?.abort();
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retryAbortController !== undefined;
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
		return this._laneTracker.getRecords();
	}

	/**
	 * G3: bounded autonomy-telemetry sink. Passes the whole event through {@link redactTelemetryValue}
	 * (the taxonomy's redaction contract) before storing it, so a secret that leaked into a payload
	 * field never lands in the session log. Observe-only: a failure here can never surface into the
	 * turn it is measuring, so the whole body is swallowed. Payloads MUST stay small (ids, codes,
	 * numbers) — never prompt/summary text; callers own that discipline.
	 */
	private _emitAutonomyTelemetry(event: AutonomyTelemetryEvent): void {
		try {
			const redacted = redactTelemetryValue(event) as Record<string, unknown>;
			this.sessionManager.appendCustomEntry(AUTONOMY_TELEMETRY_CUSTOM_TYPE, { version: 1, ...redacted });
		} catch {
			// Telemetry is best-effort: swallow so a sink failure cannot break the observed turn.
		}
	}

	/**
	 * G8: single sink for a gate outcome. Keeps the latest-outcome getter behavior identical (the
	 * full {@link GateOutcome} still lands in `_lastAutonomyGateOutcome`), and additionally appends a
	 * bounded codes-only entry to {@link _gateOutcomeHistory} (oldest evicted at
	 * {@link GATE_OUTCOME_HISTORY_LIMIT}) and emits the `gate_outcome` telemetry event. The history
	 * tail therefore always mirrors the latest outcome. Only called with an active envelope.
	 */
	private _recordGateOutcome(outcome: GateOutcome): void {
		this._lastAutonomyGateOutcome = outcome;
		const at = new Date().toISOString();
		this._gateOutcomeHistory.push({
			outcome: outcome.outcome,
			gate: outcome.gate,
			reasonCode: outcome.reasonCode,
			at,
		});
		while (this._gateOutcomeHistory.length > GATE_OUTCOME_HISTORY_LIMIT) {
			this._gateOutcomeHistory.shift();
		}
		// G8: gate outcome event. Codes/ids only — never the gate's human-facing message.
		this._emitAutonomyTelemetry({
			type: AUTONOMY_TELEMETRY_EVENT_TYPES.gateOutcome,
			timestamp: at,
			payload: {
				outcome: outcome.outcome,
				gate: outcome.gate,
				reasonCode: outcome.reasonCode,
			},
		});
	}

	/** G8: copies of the bounded gate-outcome history, oldest first, latest last. */
	getGateOutcomeHistory(): GateOutcomeHistoryEntry[] {
		return this._gateOutcomeHistory.map((entry) => ({ ...entry }));
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

	private _clearGoalAutoContinueTimer(): void {
		if (this._goalAutoContinueTimer !== undefined) {
			clearTimeout(this._goalAutoContinueTimer);
			this._goalAutoContinueTimer = undefined;
		}
	}

	private _scheduleGoalAutoContinueFromIdle(options?: PromptOptions): void {
		if (options?.autoContinueGoal === false || this._isGoalAutoContinuing || this._disposed) return;

		// Small-window models cannot afford multi-thousand-token continuation prompts per idle turn.
		if (!this.getModelCapabilityProfile().backgroundLanesEnabled) return;

		const { maxStallTurns, goalAutoContinue, goalAutoContinueDelayMs } = this.settingsManager.getAutonomySettings();
		if (!goalAutoContinue) return;

		const snapshot = this.getGoalRuntimeSnapshot({ maxStallTurns });
		if (snapshot.continuation.action !== "continue") return;

		this._clearGoalAutoContinueTimer();
		this._goalAutoContinueTimer = setTimeout(() => {
			this._goalAutoContinueTimer = undefined;
			void this._runScheduledGoalAutoContinue();
		}, goalAutoContinueDelayMs);

		const timer = this._goalAutoContinueTimer;
		if (typeof timer === "object" && timer && "unref" in timer) {
			const { unref } = timer as { unref?: () => void };
			unref?.call(timer);
		}
	}

	private async _runScheduledGoalAutoContinue(): Promise<void> {
		if (this._isGoalAutoContinuing || this._disposed) return;

		const { maxStallTurns, goalContinueTurns, goalContinueMaxWallClockMinutes, goalAutoContinue } =
			this.settingsManager.getAutonomySettings();
		if (!goalAutoContinue) return;

		const snapshot = this.getGoalRuntimeSnapshot({ maxStallTurns });
		if (snapshot.continuation.action !== "continue") return;

		// Lean-window models (16-32k) keep autosteer but at a reduced budget; full passes through.
		const scaled = scaleContinuationBudgetsForCapability(this.getModelCapabilityProfile(), {
			maxTurns: goalContinueTurns,
			maxWallClockMinutes: goalContinueMaxWallClockMinutes,
		});

		this._isGoalAutoContinuing = true;
		try {
			await this.continueGoalLoop({
				maxTurns: scaled.maxTurns,
				maxStallTurns,
				maxWallClockMinutes: scaled.maxWallClockMinutes,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this._emit({ type: "warning", message: `Goal auto-continuation failed: ${message}` });
		} finally {
			this._isGoalAutoContinuing = false;
		}
	}

	private _clearResearchLaneTimer(): void {
		if (this._researchLaneTimer !== undefined) {
			clearTimeout(this._researchLaneTimer);
			this._researchLaneTimer = undefined;
		}
	}

	/**
	 * Derive the research demand from durable goal state: an active goal with open requirements,
	 * deduplicated against the latest persisted bundle so the same requirement set is never
	 * researched twice (the query is deterministic, so dedupe survives session reload).
	 */
	private _buildResearchLaneDemand(): { query: string; context: string; goalId: string } | undefined {
		const goal = this.getGoalStateSnapshot();
		if (!goal || goal.status !== "active") {
			this._lastResearchLaneSkipReason = "no_active_goal";
			return undefined;
		}
		const open = goal.requirements.filter((requirement) => requirement.status === "open");
		if (open.length === 0) {
			this._lastResearchLaneSkipReason = "no_open_requirements";
			return undefined;
		}
		const query = `goal:${goal.goalId} requirements:${open
			.map((requirement) => requirement.id)
			.sort()
			.join(",")}`;
		if (this.getEvidenceBundleSnapshot()?.query === query) {
			this._lastResearchLaneSkipReason = "recent_evidence_sufficient";
			return undefined;
		}
		const context = [
			`Goal: ${goal.userGoal}`,
			"Open requirements:",
			...open.slice(0, 20).map((requirement) => `- ${requirement.text}`),
		].join("\n");
		return { query, context, goalId: goal.goalId };
	}

	/**
	 * Idle trigger for the autonomous research lane (mirrors {@link _scheduleGoalAutoContinueFromIdle}).
	 * All skips are recorded in `_lastResearchLaneSkipReason` and surfaced via diagnostics — the lane
	 * informs, it never prompts or blocks the foreground.
	 */
	private _scheduleResearchLaneFromIdle(): void {
		if (this._isResearchLaneRunning || this._disposed || this._isChildSession) return;

		if (!this.getModelCapabilityProfile().backgroundLanesEnabled) {
			this._lastResearchLaneSkipReason = "model_context_too_small";
			return;
		}

		const research = this.settingsManager.getResearchLaneSettings();
		if (!research.enabled) {
			this._lastResearchLaneSkipReason = "research_lane_disabled";
			return;
		}
		const { mode } = this.settingsManager.getAutonomySettings();
		if (mode === "off") {
			this._lastResearchLaneSkipReason = "autonomy_mode_off";
			return;
		}
		const priorRuns = getLaneRecordSnapshots(this.sessionManager.getEntries()).filter(
			(record) => record.type === "research",
		).length;
		if (priorRuns >= research.maxRunsPerSession) {
			this._lastResearchLaneSkipReason = "max_runs_reached";
			return;
		}
		if (!this._buildResearchLaneDemand()) return;

		this._clearResearchLaneTimer();
		this._researchLaneTimer = setTimeout(() => {
			this._researchLaneTimer = undefined;
			void this._runScheduledResearchLane();
		}, research.idleDelayMs);

		const timer = this._researchLaneTimer;
		if (typeof timer === "object" && timer && "unref" in timer) {
			const { unref } = timer as { unref?: () => void };
			unref?.call(timer);
		}
	}

	private async _runScheduledResearchLane(): Promise<void> {
		if (this._isResearchLaneRunning || this._disposed) return;

		const research = this.settingsManager.getResearchLaneSettings();
		const { mode } = this.settingsManager.getAutonomySettings();
		if (!research.enabled || mode === "off") return;

		try {
			await this.runResearchLaneOnce();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this._emit({ type: "warning", message: `Research lane failed: ${message}` });
		}
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

	/** Capability profile for a specific lane model (lane budgets scale to the lane model's window). */
	private _laneCapabilityProfile(model: Model<Api>): ModelCapabilityProfile {
		return deriveModelCapabilityProfile({
			contextWindow: model.contextWindow,
			mode: this.settingsManager.getModelCapabilitySettings().mode,
		});
	}

	/**
	 * Resolve the model for a background lane. Lanes are shipped BY this session, so they inherit
	 * the session's own model unless a lane-specific model is explicitly configured — a single-model
	 * setup (e.g. one local open model) runs its lanes on that same model. An explicitly configured
	 * pattern that cannot resolve/authenticate is a visible skip, not a silent fallback.
	 */
	private _resolveLaneModel(configuredPattern: string | undefined): Model<Api> | undefined {
		if (configuredPattern) {
			const resolved = resolveCliModel({ cliModel: configuredPattern, modelRegistry: this._modelRegistry });
			if (resolved.model && this._modelRegistry.hasConfiguredAuth(resolved.model)) {
				return resolved.model;
			}
			return undefined;
		}
		return this.model ?? undefined;
	}

	/**
	 * Resolve what a lane ships with. Precedence: explicit lane model setting, then the lane
	 * profile's model (a shipped profile with a model MUST be obeyed — unresolvable is a visible
	 * skip, never a fallback), then generic inheritance of the session model.
	 */
	private _resolveLaneShipment(
		laneSettings: { model?: string; profile?: string },
		missingModelReason: string,
	): { ok: true; model: Model<Api>; laneProfile?: NormalizedProfile } | { ok: false; skipReason: string } {
		let laneProfile: NormalizedProfile | undefined;
		if (laneSettings.profile) {
			laneProfile = this.settingsManager.getProfileRegistry().getProfile(laneSettings.profile);
			if (!laneProfile) {
				return { ok: false, skipReason: "lane_profile_not_found" };
			}
		}

		let model: Model<Api> | undefined;
		if (laneSettings.model) {
			model = this._resolveLaneModel(laneSettings.model);
			if (!model) return { ok: false, skipReason: missingModelReason };
		} else if (laneProfile?.model) {
			model = this._resolveLaneModel(laneProfile.model);
			if (!model) return { ok: false, skipReason: "no_lane_profile_model" };
		} else {
			model = this.model ?? undefined;
			if (!model) return { ok: false, skipReason: missingModelReason };
		}
		return { ok: true, model, laneProfile };
	}

	/** UAC tool grants from a shipped lane profile, recorded on the lane envelope. */
	private _laneProfileToolGrants(
		laneProfile?: NormalizedProfile,
	): Pick<CapabilityEnvelope, "allowedTools" | "deniedTools"> {
		const toolsFilter = laneProfile?.resources.tools;
		return {
			...(toolsFilter?.allow && toolsFilter.allow.length > 0 ? { allowedTools: [...toolsFilter.allow] } : {}),
			...(toolsFilter?.block && toolsFilter.block.length > 0 ? { deniedTools: [...toolsFilter.block] } : {}),
		};
	}

	/** Stripped research envelope — never the foreground/architect envelope. */
	private _buildResearchLaneEnvelope(maxUsd: number, laneProfile?: NormalizedProfile): CapabilityEnvelope {
		return {
			id: `research-${this.sessionId}-${Date.now()}`,
			profileId: laneProfile?.name,
			capabilities: ["research", "read_files", "memory_read"],
			...this._laneProfileToolGrants(laneProfile),
			maxEstimatedUsd: Math.min(maxUsd, this.capabilityEnvelope?.maxEstimatedUsd ?? Number.POSITIVE_INFINITY),
			createdAt: new Date().toISOString(),
		};
	}

	/**
	 * Run one bounded, read-only research pass and persist its results: evidence bundle snapshot,
	 * terminal lane record, and spawned-usage cost report (single-hop invariant, idempotent on the
	 * lane's reportId). Explicit calls (e.g. `/autonomy research`) express user intent and bypass the
	 * enabled/mode/dedupe gates the idle scheduler enforces; budget and capability gates always apply.
	 */
	async runResearchLaneOnce(request?: {
		query?: string;
		context?: string;
		goalId?: string;
	}): Promise<ResearchLaneRunOutcome> {
		if (this._isResearchLaneRunning) {
			return { started: false, skipReason: "research_lane_already_running" };
		}
		if (this._disposed) {
			return { started: false, skipReason: "session_disposed" };
		}

		const settings = this.settingsManager.getResearchLaneSettings();
		const demand = request?.query
			? { query: request.query, context: request.context ?? "", goalId: request.goalId }
			: this._buildResearchLaneDemand();
		if (!demand) {
			return { started: false, skipReason: this._lastResearchLaneSkipReason ?? "no_research_demand" };
		}

		const shipment = this._resolveLaneShipment(settings, "no_research_model");
		if (!shipment.ok) {
			this._lastResearchLaneSkipReason = shipment.skipReason;
			return { started: false, skipReason: shipment.skipReason };
		}
		const { model, laneProfile } = shipment;

		this._isResearchLaneRunning = true;
		this._laneTracker.ensureCounterAtLeast(getLaneRecordSnapshots(this.sessionManager.getEntries()).length + 1);
		const startedRecord = this._laneTracker.start({ type: "research", goalId: demand.goalId });
		try {
			let spentUsage: Usage | undefined;
			// Best-effort, pointer-first workspace evidence. Derives search terms from the goal/requirement
			// text (not the identity-key query) and is bounded + silent-on-failure: [] == today's behavior.
			const workspaceSources = await this._collectWorkspaceSources({
				query: `${demand.context}\n${demand.query}`,
				cwd: this._cwd,
				maxSources: settings.maxSources,
			});
			const result = await runResearch({
				query: demand.query,
				context: demand.context,
				sources: workspaceSources,
				envelope: this._buildResearchLaneEnvelope(settings.maxUsd, laneProfile),
				maxUsd: settings.maxUsd,
				maxSources: settings.maxSources,
				maxFindings: settings.maxFindings,
				maxWallClockMs: settings.maxWallClockMs,
				signal: this._researchLaneAbort.signal,
				complete: async ({ systemPrompt, userPrompt, signal }) => {
					const completion = await this.runIsolatedCompletion({
						// Level-0 core always survives; profile soul and role prompt are the replaceable
						// layers; a settings-provided prompt replaces everything above the core.
						systemPrompt: composeSubagentSystemPrompt({
							soul: laneProfile?.soul,
							rolePrompt: systemPrompt,
							override: settings.systemPrompt,
						}),
						messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
						model,
						thinkingLevel: laneProfile?.thinking ?? "off",
						maxTokens: this._laneCapabilityProfile(model).laneMaxOutputTokens,
						signal,
						// Core/soul/role are all static per configuration — the provider can cache the prefix.
						cacheRetention: "short",
					});
					spentUsage = completion.usage;
					return {
						text: completion.text,
						costUsd: completion.usage.cost.total,
						stopReason: String(completion.stopReason),
					};
				},
			});

			// Bug #21 pattern: if the session was disposed while the completion was in flight, do NOT
			// persist evidence/records/usage against the dead session.
			if (this._disposed) {
				const record = this._laneTracker.complete(startedRecord.laneId, {
					status: "canceled",
					reasonCode: "session_disposed",
				});
				return { started: true, record, result };
			}

			let evidenceEntryId: string | undefined;
			if (result.bundle) {
				evidenceEntryId = this.saveEvidenceBundleSnapshot(result.bundle);
			}
			if (spentUsage && (spentUsage.cost.total > 0 || spentUsage.totalTokens > 0)) {
				this.addSpawnedUsage(spentUsage, {
					label: "research-lane",
					reportId: `research:${this.sessionId}:${startedRecord.laneId}`,
				});
			}

			const record = this._laneTracker.complete(startedRecord.laneId, {
				status: result.status,
				reasonCode: result.reasonCode,
				costUsd: result.costUsd,
				evidenceEntryId,
			});
			if (record) {
				appendLaneRecordSnapshot(this.sessionManager, record);
				// G3: a research lane's product is an evidence bundle, so its terminal record maps to
				// the evidence_bundle event. Lane outcome only (status/reasonCode/cost) — no findings text.
				this._emitAutonomyTelemetry({
					type: AUTONOMY_TELEMETRY_EVENT_TYPES.evidenceBundle,
					timestamp: new Date().toISOString(),
					payload: {
						laneId: record.laneId,
						laneType: record.type,
						status: record.status,
						reasonCode: record.reasonCode ?? null,
						costUsd: record.costUsd ?? null,
						hasEvidence: record.evidenceEntryId !== undefined,
					},
				});
			}
			return { started: true, record, result };
		} catch (error) {
			const record = this._laneTracker.complete(startedRecord.laneId, {
				status: "failed",
				reasonCode: "research_lane_error",
			});
			if (record && !this._disposed) {
				appendLaneRecordSnapshot(this.sessionManager, record);
				this._emitAutonomyTelemetry({
					type: AUTONOMY_TELEMETRY_EVENT_TYPES.evidenceBundle,
					timestamp: new Date().toISOString(),
					payload: {
						laneId: record.laneId,
						laneType: record.type,
						status: record.status,
						reasonCode: record.reasonCode ?? null,
						costUsd: record.costUsd ?? null,
						hasEvidence: record.evidenceEntryId !== undefined,
					},
				});
			}
			const message = error instanceof Error ? error.message : String(error);
			this._emit({ type: "warning", message: `Research lane failed: ${message}` });
			return { started: true, record };
		} finally {
			this._isResearchLaneRunning = false;
		}
	}

	/**
	 * Run one bounded scout-worker delegation: build a WorkerRequest with a stripped read-only
	 * envelope, execute it as an isolated completion on a cheap lane, validate the result via
	 * {@link validateWorkerResult} before acceptance, and persist result + lane record + spawned
	 * usage (idempotent per-lane reportId). Consumed by the `delegate` tool.
	 */
	async runWorkerDelegationOnce(request: {
		instructions: string;
		/** Model-provided replacement for the worker role prompt (the level-0 core always remains). */
		systemPrompt?: string;
	}): Promise<WorkerDelegationRunOutcome> {
		const delegationSettings = this.settingsManager.getWorkerDelegationSettings();
		if (this._laneTracker.getActiveCount("worker") >= delegationSettings.maxConcurrent) {
			return { started: false, skipReason: "worker_delegation_already_running" };
		}
		if (this._disposed) {
			return { started: false, skipReason: "session_disposed" };
		}
		const instructions = request.instructions.trim();
		if (instructions.length === 0) {
			return { started: false, skipReason: "missing_instructions" };
		}

		const settings = delegationSettings;
		if (!settings.enabled) {
			return { started: false, skipReason: "worker_delegation_disabled" };
		}

		const shipment = this._resolveLaneShipment(settings, "no_worker_model");
		if (!shipment.ok) {
			return { started: false, skipReason: shipment.skipReason };
		}
		const { model, laneProfile } = shipment;

		this._laneTracker.ensureCounterAtLeast(getLaneRecordSnapshots(this.sessionManager.getEntries()).length + 1);
		const startedRecord = this._laneTracker.start({ type: "worker" });
		const maxUsd = Math.min(settings.maxUsd, this.capabilityEnvelope?.maxEstimatedUsd ?? Number.POSITIVE_INFINITY);
		const workerRequest: WorkerRequest = {
			id: startedRecord.laneId,
			instructions,
			route: {
				tier: "cheap",
				risk: "read-only",
				confidence: 1,
				reasonCode: "scout_worker",
				reasons: ["Read-only scout delegation"],
			},
			envelope: {
				id: `worker-${this.sessionId}-${startedRecord.laneId}`,
				profileId: laneProfile?.name,
				// write_files requires BOTH the opt-in AND an explicit non-empty path scope —
				// an unscoped write grant is refused here, not discovered at validation time.
				capabilities:
					settings.writeEnabled && settings.writePaths.length > 0 ? ["read_files", "write_files"] : ["read_files"],
				...(settings.writeEnabled && settings.writePaths.length > 0
					? { allowedPaths: [...settings.writePaths] }
					: {}),
				...this._laneProfileToolGrants(laneProfile),
				maxEstimatedUsd: maxUsd,
				createdAt: new Date().toISOString(),
			},
			maxEstimatedUsd: maxUsd,
			createdAt: new Date().toISOString(),
		};
		// G8: worker delegation START. Routing/scope codes + budget only — never the instructions text.
		this._emitAutonomyTelemetry({
			type: AUTONOMY_TELEMETRY_EVENT_TYPES.workerRequest,
			timestamp: new Date().toISOString(),
			payload: {
				id: workerRequest.id,
				tier: workerRequest.route.tier,
				capabilities: [...workerRequest.envelope.capabilities],
				maxEstimatedUsd: workerRequest.maxEstimatedUsd ?? null,
			},
		});
		const usageReportId = `worker:${this.sessionId}:${startedRecord.laneId}`;

		try {
			let spentUsage: Usage | undefined;
			const outcome = await runWorker({
				request: workerRequest,
				maxUsd,
				maxWallClockMs: settings.maxWallClockMs,
				usageReportId,
				signal: this._workerDelegationAbort.signal,
				// Parent validation must use the same relative-path baseline the runner reports in.
				cwd: this._cwd,
				// Write lane (G2): runner-side action application through the envelope path scope.
				applyActions: workerRequest.envelope.capabilities.includes("write_files")
					? (actions) => applyWorkerActions({ actions, envelope: workerRequest.envelope, cwd: this._cwd })
					: undefined,
				complete: async ({ systemPrompt, userPrompt, signal }) => {
					const completion = await this.runIsolatedCompletion({
						// Level-0 core always survives. A model-provided prompt (delegate tool) is the most
						// specific override, then the settings-level prompt, then profile soul + role prompt.
						systemPrompt: composeSubagentSystemPrompt({
							soul: laneProfile?.soul,
							rolePrompt: systemPrompt,
							override: request.systemPrompt ?? settings.systemPrompt,
						}),
						messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
						model,
						thinkingLevel: laneProfile?.thinking ?? "off",
						maxTokens: this._laneCapabilityProfile(model).laneMaxOutputTokens,
						signal,
						// Core/soul/role are all static per configuration — the provider can cache the prefix.
						cacheRetention: "short",
					});
					spentUsage = completion.usage;
					return {
						text: completion.text,
						costUsd: completion.usage.cost.total,
						stopReason: String(completion.stopReason),
					};
				},
			});

			// Bug #21 pattern: never persist against a disposed session.
			if (this._disposed) {
				const record = this._laneTracker.complete(startedRecord.laneId, {
					status: "canceled",
					reasonCode: "session_disposed",
				});
				return { started: true, record, outcome };
			}

			this.saveWorkerResultSnapshot(outcome.result, workerRequest);
			if (spentUsage && (spentUsage.cost.total > 0 || spentUsage.totalTokens > 0)) {
				this.addSpawnedUsage(spentUsage, { label: "worker-delegation", reportId: usageReportId });
			}

			const record = this._laneTracker.complete(startedRecord.laneId, {
				status: outcome.laneStatus,
				reasonCode: outcome.reasonCode,
				costUsd: outcome.costUsd,
			});
			if (record) {
				appendLaneRecordSnapshot(this.sessionManager, record);
				// G3: worker lane terminal record -> worker_result event. Lane outcome only
				// (status/reasonCode/cost) — never the worker's summary/changed-file text.
				this._emitAutonomyTelemetry({
					type: AUTONOMY_TELEMETRY_EVENT_TYPES.workerResult,
					timestamp: new Date().toISOString(),
					payload: {
						laneId: record.laneId,
						laneType: record.type,
						status: record.status,
						reasonCode: record.reasonCode ?? null,
						costUsd: record.costUsd ?? null,
					},
				});
			}
			return { started: true, record, outcome };
		} catch (error) {
			const record = this._laneTracker.complete(startedRecord.laneId, {
				status: "failed",
				reasonCode: "worker_delegation_error",
			});
			if (record && !this._disposed) {
				appendLaneRecordSnapshot(this.sessionManager, record);
				this._emitAutonomyTelemetry({
					type: AUTONOMY_TELEMETRY_EVENT_TYPES.workerResult,
					timestamp: new Date().toISOString(),
					payload: {
						laneId: record.laneId,
						laneType: record.type,
						status: record.status,
						reasonCode: record.reasonCode ?? null,
						costUsd: record.costUsd ?? null,
					},
				});
			}
			const message = error instanceof Error ? error.message : String(error);
			this._emit({ type: "warning", message: `Worker delegation failed: ${message}` });
			return { started: true, record };
		} finally {
		}
	}

	/**
	 * Probe a candidate model against the subagent contracts (research/worker/judge/search/
	 * tool-call surfaces) via {@link runModelFitnessProbe}. The model must resolve and
	 * authenticate; every probe call runs as an isolated completion on that model, and probe
	 * spend is reported through spawned-usage accounting.
	 */
	async runModelFitness(args: {
		model: string;
		trials?: number;
	}): Promise<{ started: true; model: string; report: ModelFitnessReport } | { started: false; skipReason: string }> {
		if (this._disposed) return { started: false, skipReason: "session_disposed" };
		const resolved = this._resolveLaneModel(args.model.trim() || undefined);
		if (!resolved) return { started: false, skipReason: "model_unresolved_or_unauthenticated" };
		const capability = this._laneCapabilityProfile(resolved);

		const spent: Usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const report = await runModelFitnessProbe({
			trials: args.trials,
			signal: this._researchLaneAbort.signal,
			complete: async ({ systemPrompt, userPrompt, signal }) => {
				const callStarted = Date.now();
				const completion = await this.runIsolatedCompletion({
					systemPrompt,
					messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
					model: resolved,
					thinkingLevel: "off",
					maxTokens: capability.laneMaxOutputTokens,
					signal,
					cacheRetention: "short",
				});
				const callMs = Date.now() - callStarted;
				spent.input += completion.usage.input;
				spent.output += completion.usage.output;
				spent.cacheRead += completion.usage.cacheRead;
				spent.cacheWrite += completion.usage.cacheWrite;
				spent.totalTokens += completion.usage.totalTokens;
				spent.cost.input += completion.usage.cost.input;
				spent.cost.output += completion.usage.cost.output;
				spent.cost.cacheRead += completion.usage.cost.cacheRead;
				spent.cost.cacheWrite += completion.usage.cost.cacheWrite;
				spent.cost.total += completion.usage.cost.total;
				return {
					text: completion.text,
					costUsd: completion.usage.cost.total,
					stopReason: String(completion.stopReason),
					// Wall-clock fallback for tok/s: providers don't expose pure eval time, so the
					// measured call time stands in — slightly conservative (includes network/queue).
					outputTokens: completion.usage.output,
					evalMs: callMs,
				};
			},
		});
		if (!this._disposed && (spent.cost.total > 0 || spent.totalTokens > 0)) {
			this.addSpawnedUsage(spent, { label: "model-fitness" });
		}
		const modelRef = `${resolved.provider}/${resolved.id}`;
		// Fitness is a property of a model ON a host — persist the report host-keyed so role
		// assignments stay per-machine (a model can await better hardware without being forgotten).
		// Best-effort: a disk problem must not fail the probe itself.
		try {
			if (!this._disposed) {
				FitnessStore.forAgentDir(this._agentDir).save(modelRef, report);
			}
		} catch {
			// best-effort persistence
		}
		return { started: true, model: modelRef, report };
	}

	/** Fitness reports persisted for THIS host (measured evidence for architect/profile decisions). */
	getStoredFitnessReports(): StoredFitnessReport[] {
		try {
			return FitnessStore.forAgentDir(this._agentDir).getForHost();
		} catch {
			return [];
		}
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
		if (this.agent.streamFn === streamSimple) {
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
			existingMemory: this._memoryManager.buildSystemPromptBlockFresh() || "",
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
		const memTool = this._memoryManager.getToolDefinitions().find((t) => t.name === "memory");
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
		const snapshot: AutonomyStatusSnapshot = {};

		if (this._lastModelRouterDecision?.route) {
			snapshot.latestRoute = {
				tier: this._lastModelRouterDecision.route.tier,
				reasonCode: this._lastModelRouterDecision.route.reasonCode,
				risk: this._lastModelRouterDecision.route.risk,
			};
		}

		if (this._lastAutonomyGateOutcome) {
			snapshot.latestGate = {
				outcome: this._lastAutonomyGateOutcome.outcome,
				gate: this._lastAutonomyGateOutcome.gate,
				reasonCode: this._lastAutonomyGateOutcome.reasonCode,
			};
		}

		const currentCost = this.getSessionStats().cost;
		if (currentCost > 0) {
			snapshot.currentCostUsd = currentCost;
		}

		const spawnedCost = this.getSpawnedUsage().cost;
		if (spawnedCost > 0) {
			snapshot.spawnedCostUsd = spawnedCost;
		}

		const dailyCost = this.getDailyUsageTotals?.()?.totalCost;
		if (dailyCost !== undefined && dailyCost > 0) {
			snapshot.dailyCostUsd = dailyCost;
		}

		const goal = this.getGoalStateSnapshot();
		if (goal) {
			snapshot.activeGoal = {
				goalId: goal.goalId,
				status: goal.status,
				openRequirements: goal.requirements.filter((requirement) => requirement.status === "open").length,
				stallTurns: goal.stallTurns,
			};
		}

		// Real live count from the lane tracker — never inferred from historical snapshots. Absent
		// while zero, matching the presence-means-signal convention of the sibling fields.
		const activeLaneCount = this._laneTracker.getActiveCount();
		if (activeLaneCount > 0) {
			snapshot.activeLaneCount = activeLaneCount;
		}

		return snapshot;
	}

	/**
	 * Aggregate an effectiveness/autonomy dashboard: what Pi has actually been doing (recent
	 * route choices, latest gate outcome, cost, and any research/delegation/learning/goal
	 * activity). Read-only — combines existing session-log getters, never mutates state or
	 * recomputes a route/gate decision.
	 */
	public getAutonomyDiagnosticSnapshot(options?: { maxEntriesPerFamily?: number }): AutonomyDiagnosticSnapshot {
		const maxEntriesPerFamily = options?.maxEntriesPerFamily ?? 10;
		const snapshot: AutonomyDiagnosticSnapshot = {};
		const goal = this.getGoalStateSnapshot();

		const recentDecisions = getRecentModelRouterDecisions(this.sessionManager.getEntries(), maxEntriesPerFamily);
		if (recentDecisions.length > 0) {
			snapshot.routes = recentDecisions.map(
				(decision): DiagnosticEntry => ({
					title: decision.route.tier,
					summary: decision.routedModel,
					reasonCode: decision.route.reasonCode,
					metadata: { risk: decision.route.risk, outcome: decision.outcome, intent: decision.intent },
				}),
			);
		}

		if (this._lastAutonomyGateOutcome) {
			const gate = this._lastAutonomyGateOutcome;
			snapshot.gates = [
				{
					title: gate.gate,
					summary: gate.message,
					reasonCode: gate.reasonCode,
					metadata: { outcome: gate.outcome, reversible: gate.reversible },
				},
			];
		}

		const costs: DiagnosticEntry[] = [];
		const currentCostForDiagnostics = this.getSessionStats().cost;
		if (currentCostForDiagnostics > 0) {
			costs.push({ title: "current", summary: `$${currentCostForDiagnostics.toFixed(4)}` });
		}
		const spawnedCost = this.getSpawnedUsage().cost;
		if (spawnedCost > 0) costs.push({ title: "spawned", summary: `$${spawnedCost.toFixed(4)}` });
		const dailyCostForDiagnostics = this.getDailyUsageTotals?.()?.totalCost;
		if (dailyCostForDiagnostics !== undefined && dailyCostForDiagnostics > 0) {
			costs.push({ title: "daily", summary: `$${dailyCostForDiagnostics.toFixed(4)}` });
		}
		if (costs.length > 0) snapshot.costs = costs;

		const researchEntries: DiagnosticEntry[] = [];
		const researchLaneRecords = getLaneRecordSnapshots(this.sessionManager.getEntries()).filter(
			(record) => record.type === "research",
		);
		for (const record of researchLaneRecords.slice(-maxEntriesPerFamily)) {
			researchEntries.push({
				title: `Lane ${record.laneId} (${record.status})`,
				reasonCode: record.reasonCode,
				metadata: {
					costUsd: record.costUsd,
					startedAt: record.startedAt,
					completedAt: record.completedAt,
					goalId: record.goalId,
				},
			});
		}
		for (const bundle of this.getEvidenceBundleSnapshots().slice(-maxEntriesPerFamily)) {
			researchEntries.push({
				title: `Research: ${bundle.query}`,
				metadata: { sourceCount: bundle.sources.length, findingCount: bundle.findings.length },
			});
		}
		if (this._lastResearchLaneSkipReason) {
			researchEntries.push({ title: "Last skip", reasonCode: this._lastResearchLaneSkipReason });
		}
		if (researchEntries.length > 0) {
			snapshot.research = researchEntries;
		}

		const delegationEntries: DiagnosticEntry[] = [];
		const workerLaneRecords = getLaneRecordSnapshots(this.sessionManager.getEntries()).filter(
			(record) => record.type === "worker",
		);
		for (const record of workerLaneRecords.slice(-maxEntriesPerFamily)) {
			delegationEntries.push({
				title: `Lane ${record.laneId} (${record.status})`,
				reasonCode: record.reasonCode,
				metadata: { costUsd: record.costUsd, startedAt: record.startedAt, completedAt: record.completedAt },
			});
		}
		const workerResults = this.getWorkerResultSnapshots();
		for (const result of workerResults.slice(-maxEntriesPerFamily)) {
			delegationEntries.push({
				title: `Worker ${result.requestId} (${result.status})`,
				summary: result.summary,
				metadata: {
					changedFileCount: result.changedFiles.length,
					blockerCount: result.blockers?.length ?? 0,
					usageReportId: result.usageReportId,
				},
			});
		}
		if (delegationEntries.length > 0) {
			snapshot.delegation = delegationEntries;
		}

		const learningEntries: DiagnosticEntry[] = [];
		const learningDecisions = this.getLearningDecisionSnapshots();
		for (const decision of learningDecisions.slice(-maxEntriesPerFamily)) {
			learningEntries.push({
				title: `Learning (${decision.kind})`,
				summary: decision.summary,
				reasonCode: decision.reasonCode,
				metadata: { confidence: decision.confidence, requiresApproval: decision.requiresApproval },
			});
		}
		for (const audit of this.getLearningAuditRecords().slice(-maxEntriesPerFamily)) {
			learningEntries.push({
				title: `Audit ${audit.id} (${audit.action})`,
				summary: audit.summary,
				reasonCode: audit.reasonCode,
				metadata: { layer: audit.layer, proposalId: audit.proposalId, rollbackOf: audit.rollbackOf },
			});
		}
		if (learningEntries.length > 0) {
			snapshot.learning = learningEntries;
		}

		if (goal) {
			snapshot.goals = [
				{
					title: `Goal ${goal.goalId}`,
					summary: goal.userGoal,
					reasonCode: goal.status,
					metadata: {
						openRequirementCount: goal.requirements.filter((requirement) => requirement.status === "open").length,
						stallTurns: goal.stallTurns,
						blockedReason: goal.blockedReason,
					},
				},
			];
		}

		return snapshot;
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
