import { createHash } from "node:crypto";
import type {
	Agent,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	StreamIdleOptions,
	ThinkingLevel,
} from "@caupulican/pi-agent-core";
import type { CompactionResult, SessionManager } from "@caupulican/pi-agent-core/node";
import type { Api, CacheRetention, ImageContent, Message, Model, StopReason, Usage } from "@caupulican/pi-ai";
import type { LaneRecord, LaneTerminalStatus } from "./autonomy/lane-tracker.ts";
import type { BackgroundToolTaskLiveView } from "./background-tool-task-controller.ts";
import type { WorkerRunOutcome } from "./delegation/worker-runner.ts";
import type {
	ContextUsage,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionErrorListener,
	ExtensionRunner,
	ExtensionUIContext,
	InputSource,
	SessionStartEvent,
	ShutdownHandler,
	ToolDefinition,
} from "./extensions/index.ts";
import type { GoalContinuationPrompt } from "./goals/goal-continuation-prompt.ts";
import type { GoalRuntimeSnapshot } from "./goals/goal-runtime-snapshot.ts";
import type { ModelRegistry } from "./model-registry.ts";
import type { LocalRuntimeDeps } from "./models/local-runtime.ts";
import type { OrchestrationProfile } from "./orchestration/contracts.ts";
import type { ResearchRunResult } from "./research/research-runner.ts";
import type { collectWorkspaceSources } from "./research/workspace-collector.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import type { ResourceProfileFilterSettings, SettingsManager } from "./settings-manager.ts";
import type { ToolArgumentValidationStats } from "./tool-recovery-stats.ts";

export { type ParsedSkillBlock, parseSkillBlock } from "./skill-block.mjs";

/** Session-specific events that extend the core AgentEvent. */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" }>
	| { type: "agent_end"; messages: AgentMessage[]; willRetry: boolean }
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
	| { type: "background_tools"; tasks: readonly BackgroundToolTaskLiveView[] }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
			/** Benign no-op explanation when compaction did not produce a result. */
			skipReason?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	/** UI-only bracket around foreground routing/preparation. Always paired with `routing_end`. */
	| { type: "routing_start" }
	| { type: "routing_end" }
	| {
			type: "delegate_workers";
			active: number;
			queued: number;
			running: number;
			completedSinceFlush: number;
			failedSinceFlush: number;
			terminalSinceFlush: Array<{ laneId: string; status: LaneTerminalStatus; reasonCode?: string }>;
	  };

export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	/** User-level agent state directory for generated runtime artifacts. */
	agentDir?: string;
	/** Models available to the interactive model-cycle action. */
	scopedModels?: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;
	resourceLoader: ResourceLoader;
	/** SDK tools registered outside extensions. */
	customTools?: ToolDefinition[];
	modelRegistry: ModelRegistry;
	/** Initial active tool names before profile and UAC filtering. */
	initialActiveToolNames?: string[];
	/** Optional tool allowlist. */
	allowedToolNames?: string[];
	/** Optional tool denylist. */
	excludedToolNames?: string[];
	toolProfileFilter?: ResourceProfileFilterSettings;
	/** Preserve an explicit launch-time model across profile reloads. */
	isExplicitModel?: boolean;
	/** Preserve an explicit launch-time thinking level across profile reloads. */
	isExplicitThinking?: boolean;
	/** Child sessions receive the worker UAC and write ceilings. */
	isChildSession?: boolean;
	/** Alternate base tool instances for embedded/custom runtimes. */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Mutable bridge used by the agent loop to reach the current extension generation. */
	extensionRunnerRef?: { current?: ExtensionRunner };
	sessionStartEvent?: SessionStartEvent;
	/** Injectable pointer-first workspace collector; tests use this to avoid process execution. */
	collectWorkspaceSources?: typeof collectWorkspaceSources;
	/** Immutable owner-authored orchestration policy. */
	orchestrationProfile?: OrchestrationProfile;
	/** Injectable local-runtime I/O dependencies. */
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

export interface PromptOptions {
	/** Expand file prompt templates and skills. Defaults to true. */
	expandPromptTemplates?: boolean;
	/** Process slash commands before model submission. Defaults to `expandPromptTemplates`. */
	processSlashCommands?: boolean;
	images?: ImageContent[];
	/** Required queue behavior when a foreground turn is already streaming. */
	streamingBehavior?: "steer" | "followUp";
	source?: InputSource;
	/** Observe whether prompt preflight accepted the request. */
	preflightResult?: (success: boolean) => void;
	/** Permit idle goal continuation after this prompt settles. Defaults to true. */
	autoContinueGoal?: boolean;
	/** Hidden internal turn persisted as a typed context marker. */
	internalContextType?: string;
	/** Active goal whose autonomous foreground execution owns this internal turn's provider usage. */
	goalExecutionId?: string;
}

export interface ModelCycleResult {
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	/** Whether cycling was constrained to launch-scoped models. */
	isScoped: boolean;
}

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
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost: number;
	contextUsage?: ContextUsage;
	toolArgumentValidation: ToolArgumentValidationStats;
	compactionGates: CompactionGateStats;
}

export const SPAWNED_USAGE_CUSTOM_TYPE = "spawned_usage";
export const RUNAWAY_STOP_CUSTOM_TYPE = "runaway_stop";
export const TOOL_VALIDATION_ESCALATION_CUSTOM_TYPE = "tool_validation_escalation";

export interface RunawayStopRecord {
	signature: string;
	repeats: number;
	model?: string;
	provider?: string;
	at: string;
}

export interface ToolValidationEscalationRecord {
	tool: string;
	signature: string;
	repeats: number;
	model: string;
	provider: string;
	at: string;
}

export interface SpawnedUsageReport {
	/** Cumulative child usage, including that child's already-rolled-up descendants. */
	usage: Usage;
	label?: string;
	sourceSessionId?: string;
	/** Stable idempotency identity for retry-safe ingestion. */
	reportId?: string;
}

export interface SpawnedUsageTotals {
	cost: number;
	reports: number;
}

export interface IsolatedCompletionOptions {
	systemPrompt: string;
	/** New child-owned prompt messages for this call; foreground session history is never inherited. */
	messages: Message[];
	/** Previously persisted child history. Omission preserves fresh one-shot behavior. */
	history?: Message[];
	model?: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	maxTokens?: number;
	/** Fresh child-owned tool instances. Omission preserves one-shot behavior. */
	tools?: AgentTool[];
	/** Explicit child-loop turn cap. */
	maxTurns?: number;
	/** Optional tool-free finalization prompt after the bounded tool loop. */
	finalTextPrompt?: string;
	/** Child-only capability/path gate. */
	beforeToolCall?: AgentLoopConfig["beforeToolCall"];
	/** Child-only result observer. */
	afterToolCall?: AgentLoopConfig["afterToolCall"];
	/**
	 * Durable child transcript sink. Message-end ordering means an assistant tool request is recorded
	 * before execution starts and each tool result is recorded before the next provider request.
	 * Throwing aborts the child loop; continuing without durable history would make replay unsafe.
	 */
	onMessage?: (message: Message) => Promise<void> | void;
	/** Durable mid-run steering inbox owned by the child conversation. */
	getSteeringMessages?: AgentLoopConfig["getSteeringMessages"];
	/** Durable post-turn follow-up inbox owned by the child conversation. */
	getFollowUpMessages?: AgentLoopConfig["getFollowUpMessages"];
	/** Child-owned provider projection, invoked before every request without mutating raw history. */
	transformContext?: AgentLoopConfig["transformContext"];
	/** Request-local budget/authority check, invoked immediately before every child provider transport. */
	requestPreflight?: AgentLoopConfig["requestPreflight"];
	signal?: AbortSignal;
	/** Required cache policy; isolated calls never inherit a provider default implicitly. */
	cacheRetention: CacheRetention;
	/** Stable namespace used to derive provider cache affinity. */
	laneKind?: string;
}

export const DEFAULT_ISOLATED_LANE_KIND = "isolated";

export function computeLaneAffinityKey(laneKind: string, model: Model<Api> | undefined, systemPrompt: string): string {
	const modelKey = model ? `${model.provider}/${model.id}` : "unknown-model";
	const digest = createHash("sha256")
		.update(["pi-lane-affinity-v1", laneKind, modelKey, systemPrompt].join("\u0000"))
		.digest("hex")
		.slice(0, 32);
	return `lane:${laneKind}:${digest}`;
}

export interface IsolatedCompletionResult {
	text: string;
	usage: Usage;
	stopReason: StopReason;
	/** Provider diagnostic for an error stop; lane owners classify it without parsing transcript history. */
	errorMessage?: string;
	/** Complete child-owned conversation; isolated calls never expose foreground history. */
	messages?: Message[];
}

export interface ResearchLaneRunOutcome {
	started: boolean;
	skipReason?: string;
	record?: LaneRecord;
	result?: ResearchRunResult;
}

export interface WorkerDelegationRunOutcome {
	started: boolean;
	skipReason?: string;
	record?: LaneRecord;
	outcome?: WorkerRunOutcome;
}

export interface GoalContinuationOnceOptions {
	/** Consecutive non-progress passes allowed before deterministic escalation; 0 disables the gate. */
	maxStallTurns: number;
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
	| "goal_budget_exhausted"
	| "already_continuing"
	| "session_disposed"
	| "goal_tool_unavailable"
	| "worker_in_flight";

export interface GoalContinuationLoopOptions extends GoalContinuationOnceOptions {
	/** Explicit per-invocation turn limit; 0 means unbounded. */
	maxTurns: number;
	/** Explicit per-invocation active-time limit; 0/undefined means unbounded. */
	maxWallClockMinutes?: number;
	/** Injectable monotonic-enough clock for deterministic tests. */
	now?: () => number;
}

export interface GoalContinuationLoopResult {
	turnsSubmitted: number;
	stopReason: GoalContinuationLoopStopReason;
	finalSnapshot: GoalRuntimeSnapshot;
}

/** Test-only stream watchdog override contract retained in the public session module. */
export type StreamIdleOptionsOverride = Partial<StreamIdleOptions> | undefined;
