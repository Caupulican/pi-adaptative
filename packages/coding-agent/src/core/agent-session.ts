import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { type Agent, AgentBusyError } from "@caupulican/pi-agent-core/agent";
import type { CompactionResult, CompactionSettings } from "@caupulican/pi-agent-core/compaction/compaction";
import { compactToolResultDetailsForRetention } from "@caupulican/pi-agent-core/message-retention";
import { type CustomMessage, createCustomMessage } from "@caupulican/pi-agent-core/messages";
import {
	DEFAULT_STREAM_IDLE,
	type StreamIdleOptions,
	withStreamIdleWatchdog,
} from "@caupulican/pi-agent-core/reliability";
import type { BranchSummaryEntry, SessionManager } from "@caupulican/pi-agent-core/session";
import { NATIVE_TOOL_PROTOCOL_RESIDUE_ERROR } from "@caupulican/pi-agent-core/tool-protocol-residue";
import type {
	AgentContext,
	AgentEvent,
	AgentMessage,
	AgentRunawayStopInfo,
	AgentState,
	AgentTool,
	StreamFn,
	ThinkingLevel,
	ToolValidationEscalationEvent,
} from "@caupulican/pi-agent-core/types";
import {
	createVerificationObligationSnapshotDetails,
	VerificationObligationTracker,
} from "@caupulican/pi-agent-core/verification-obligations";
import type { Api, AssistantMessage, ImageContent, Message, Model, TextContent, Usage } from "@caupulican/pi-ai";
import { modelsAreEqual } from "@caupulican/pi-ai/models";
import { cleanupSessionResources } from "@caupulican/pi-ai/session-resources";
import { streamSimple } from "@caupulican/pi-ai/stream";
import { getAgentDir, VERSION, VERSION_SOURCE_AVAILABLE } from "../config.ts";
import { resourceDir, stateFile } from "./agent-paths.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import type {
	CapabilityEnvelope,
	EvidenceBundle,
	GateOutcome,
	LearningDecision,
	RouteDecision,
	WorkerClaim,
	WorkerRequest,
} from "./autonomy/contracts.ts";
import { buildForegroundEnvelope, formatForegroundEnvelopeObservation } from "./autonomy/foreground-envelope.ts";
import { evaluateToolGate } from "./autonomy/gates.ts";
import type { LaneRecord } from "./autonomy/lane-tracker.ts";
import type { AutonomyDiagnosticSnapshot, AutonomyStatusSnapshot, GateOutcomeHistoryEntry } from "./autonomy/status.ts";
import type { AutonomyTelemetryEvent } from "./autonomy/telemetry-events.ts";
import { AutonomyTelemetry } from "./autonomy-telemetry.ts";
import { BackgroundLaneController } from "./background-lane-controller.ts";
import {
	BACKGROUND_TOOL_TASK_CUSTOM_TYPE,
	BackgroundToolTaskController,
	loadBackgroundToolTaskRecordsNewestFirst,
} from "./background-tool-task-controller.ts";
import { BashExecutionController } from "./bash-execution-controller.ts";
import type { BashResult } from "./bash-executor.ts";
import { type AutoCompactionReason, CompactionController } from "./compaction-controller.ts";
import { CompactionSupport } from "./compaction-support.ts";
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
import type { PathAliasTable } from "./context/path-alias-table.ts";
import { wrapToolWithPathAliasExpansion } from "./context/path-alias-tool-wrap.ts";
import type { ContextGcReport } from "./context-gc.ts";
import { ContextPipeline } from "./context-pipeline.ts";
import type { SessionCostSummary } from "./cost/cost-summary.ts";
import type { DailyUsageTotals } from "./cost/daily-usage.ts";
import type { CostGuardDecision, CostGuardSettings } from "./cost-guard.ts";
import { CostGuardController } from "./cost-guard-controller.ts";
import {
	appendWorkerClaimSnapshot,
	getLatestWorkerClaimSnapshot,
	getWorkerClaimSnapshots,
} from "./delegation/session-worker-claim.ts";
import type { WorkerDelegationRequest } from "./delegation/worker-delegation-request.ts";
import { DurableCustomMessageTurnController } from "./durable-custom-message-turn-controller.ts";
import { ExtensionBindingController } from "./extension-binding-controller.ts";
import type {
	CompactOptions,
	ContextUsage,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionErrorListener,
	ExtensionRunner,
	ExtensionUIContext,
	ReplacedSessionContext,
	SessionStartEvent,
	ShutdownHandler,
	ToolDefinition,
	ToolInfo,
} from "./extensions/index.ts";
import { FailureCorpusRecorder } from "./failure-corpus.ts";
import { ForegroundLifecycleAdapter } from "./foreground-lifecycle-adapter.ts";
import { ForegroundRecoveryController, type ForegroundSubmissionLease } from "./foreground-recovery-controller.ts";
import { ForegroundTerminalHandoffController } from "./foreground-terminal-handoff-controller.ts";
import { type ChannelProvider, GatewayRegistry, type JobSchedulerProvider } from "./gateways/channel-provider.ts";
import type { GoalStateRevision } from "./goals/goal-lifecycle.ts";
import type { GoalRuntimeSnapshot, GoalRuntimeSnapshotSettings } from "./goals/goal-runtime-snapshot.ts";
import { GoalSessionController } from "./goals/goal-session-controller.ts";
import type { GoalState } from "./goals/goal-state.ts";
import { hasGoalContinuationControl } from "./goals/goal-tool-names.ts";
import { type ExplicitGoalStartAuthority, parseExplicitGoalStartAuthority } from "./goals/natural-language-goal.ts";
import { constrainStreamIdleToHttpTimeout } from "./http-dispatcher.ts";
import { HumanInputController } from "./human-input-controller.ts";
import { DURABLE_LEARNING_MEMORY_POLICY_VERSION, DurableLearningState } from "./learning/durable-learning-state.ts";
import type { LearningAuditRecord } from "./learning/learning-audit.ts";
import type { DemandSignals, ReflectionResult } from "./learning/reflection-engine.ts";
import { appendLearningDecisionSnapshot, getLearningDecisionSnapshots } from "./learning/session-learning-decision.ts";
import { type CurationProposals, SkillCurator } from "./learning/skill-curator.ts";
import { isWarmableLocalModel, LocalPrefixWarmController } from "./local-prefix-warm-controller.ts";
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
import type { OllamaRuntime, TransformersRuntime } from "./models/local-runtime.ts";
import {
	DEFAULT_ADAPTIVE_STREAM_IDLE_CEILING_MS,
	estimateContextPromptTokens,
	resolveAdaptiveStreamIdleOptions,
	withModelPerfProfile,
} from "./models/perf-profile.ts";
import { resolveConfiguredOrchestrationModel } from "./orchestration/model-binding.ts";
import { validateOrchestrationProfile } from "./orchestration/profile-registry.ts";
import { PendingInputQueueController } from "./pending-input-queue-controller.ts";
import {
	appendPipelineRunSnapshot,
	createActivePipelineContextMessage,
	getLatestPipelineRunSnapshot,
	type PipelineRun,
} from "./pipelines/index.ts";
import { ProfileFilterController } from "./profile-filter-controller.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import { ProviderRequestContextController } from "./provider-request-context-controller.ts";
import { ProviderRequestRuntimeController } from "./provider-request-runtime-controller.ts";
import { REFLECTION_TURN_TRIGGER_CUSTOM_TYPE, ReflectionController } from "./reflection-controller.ts";
import type { RequestAuth } from "./request-auth.ts";
import type { ModelFitnessReport } from "./research/model-fitness.ts";
import {
	appendEvidenceBundleSnapshot,
	getEvidenceBundleSnapshots,
	getLatestEvidenceBundleSnapshot,
} from "./research/session-evidence-bundle.ts";
import { collectWorkspaceSources } from "./research/workspace-collector.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { RuntimeBuilder } from "./runtime-builder.ts";
import type { CredentialManager } from "./secrets/credential-manager.ts";
import { SessionAnalytics } from "./session-analytics.ts";
import { SessionImageStore } from "./session-image-store.ts";
import { isWorkerSession } from "./session-role.ts";
import { hasRunningBackgroundedToolCall, isSessionSettled } from "./session-settlement.ts";
import { createSessionShutdownTracker } from "./session-shutdown.ts";
import { getActiveSessionBranchEntries } from "./session-snapshot.ts";
import { SessionTreeNavigator } from "./session-tree-navigator.ts";
import type { ResourceProfileFilterSettings, SettingsManager, SettingsScope } from "./settings-manager.ts";
import { resolveActiveSkillBodyByteLimit, SkillVaultController } from "./skill-vault.ts";
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
import { disposeShellExecutionSessionAndWait } from "./tools/shell-execution-session.ts";

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

export * from "./agent-session-contracts.ts";

import type {
	AgentSessionConfig,
	AgentSessionEvent,
	AgentSessionEventListener,
	ExtensionBindings,
	GoalContinuationLoopOptions,
	GoalContinuationLoopResult,
	GoalContinuationOnceOptions,
	GoalContinuationOnceResult,
	IsolatedCompletionOptions,
	IsolatedCompletionResult,
	ModelCycleResult,
	PromptOptions,
	ResearchLaneRunOutcome,
	RunawayStopRecord,
	SessionStats,
	SpawnedUsageTotals,
	ToolValidationEscalationRecord,
	WorkerDelegationRunOutcome,
} from "./agent-session-contracts.ts";
import {
	isInterruptedAssistantStopReason,
	RUNAWAY_STOP_CUSTOM_TYPE,
	TOOL_VALIDATION_ESCALATION_CUSTOM_TYPE,
} from "./agent-session-contracts.ts";

export type { ToolProbeReport, ToolProbeResult, ToolProbeVerdict } from "./tool-protocol-controller.ts";

interface ForegroundPromptSubmission {
	lease?: ForegroundSubmissionLease;
}

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
	private _unsubscribeSettingsChanges?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _extensionsChangedListeners: Array<() => void> = [];

	/** Steering/follow-up/extension-command queues (see pending-input-queue-controller.ts); assigned
	 * in the constructor body since it depends on `_skillVault` and `_goals` being ready. */
	private readonly _pendingQueue: PendingInputQueueController;
	private _pendingNextTurnMessages: CustomMessage[] = [];
	private _streamingPromptSubmissionTail: Promise<void> = Promise.resolve();
	/**
	 * The last tool set requested via setActiveToolsByName BEFORE model-capability filtering, so
	 * switching from a small-window model back to a large one restores the full requested set.
	 */
	private _requestedActiveToolNames: string[] | undefined;

	private _unboundToolGrantWarnings: string[] = [];
	/** Delegate provider-prompt-guideline bounding diagnostics (root-session delegate tool only). */
	private _delegatePromptGuidelineWarnings: string[] = [];

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
	private readonly _localPrefixWarm: LocalPrefixWarmController;
	private readonly _toolProtocol: ToolProtocolController;
	/** Assembles the session's base system prompt from live session state (see
	 * system-prompt-builder.ts); owns the paired _baseSystemPromptOptions. */
	private readonly _systemPromptBuilder: SystemPromptBuilder;
	/** Autonomy telemetry sink + status/diagnostic snapshots (see autonomy-telemetry.ts); owns
	 * the latest gate outcome and the bounded gate-outcome history. */
	private readonly _autonomyTelemetry: AutonomyTelemetry;
	/** Goal auto-continue + research lane + recursive worker-agent orchestration + model-fitness probe (see
	 * background-lane-controller.ts); owns the lane timers/guards, the last research-lane skip
	 * reason, the live LaneTracker, and the in-flight research/worker abort controllers. */
	private readonly _backgroundLanes: BackgroundLaneController;
	/** Session-local ownership of tool calls transferred after the foreground latency budget. */
	private readonly _backgroundToolTasks: BackgroundToolTaskController;
	private readonly _terminalHandoffs: ForegroundTerminalHandoffController;
	private readonly _durableCustomMessageTurns: DurableCustomMessageTurnController;
	private readonly _humanInput: HumanInputController;
	/** Plug-and-play memory subsystem (see memory-controller.ts); owns the OKF retrieval provider, the
	 * latest retrieval/prompt-inclusion reports, the reload-safe MemoryManager, the recall
	 * effectiveness tracker, and the extension-contributed pending providers. */
	private readonly _memory: MemoryController;
	private readonly _compactionSupport: CompactionSupport;
	private readonly _compaction: CompactionController;
	/** Provider request hook generation, replay-safe planning, admission, and lifecycle commit. */
	private readonly _providerRequestRuntime: ProviderRequestRuntimeController;
	/** Per-turn context-shaping subsystem (see context-pipeline.ts); owns the latest
	 * audit/policy/correlation/enforcement/gc reports, the brain-curation sidecar + its skip reasons,
	 * and the tool-output artifact store. Invoked stage-by-stage by provider-request planning. */
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
	private readonly _costGuard: CostGuardController;
	/** Per-turn model-router subsystem (see model-router-controller.ts); owns the transient route/intent,
	 * the cheap-turn session buffer, the escalation/retry flags, and the sticky last-decision/skip-reason
	 * used by the status report. Its parallel routed drive path delegates every turn back to
	 * {@link ForegroundRecoveryController.runAgentPrompt} so the drive loop stays host-side. */
	private readonly _modelRouter: ModelRouterController;
	private readonly _foregroundLifecycle: ForegroundLifecycleAdapter;
	private readonly _foregroundRecovery: ForegroundRecoveryController;
	/** Submission authority inherited by every routed retry within the current prompt lifecycle. */
	private _foregroundPromptLease: ForegroundSubmissionLease | undefined;
	private readonly _failureCorpus: FailureCorpusRecorder;
	private readonly _toolRecoveryLogger: ToolRecoveryLogger;
	private readonly _toolRecoveryEventLogPath: string;
	private readonly _skillVault: SkillVaultController;
	private _skillCuratorInstance?: SkillCurator;
	private _disposed = false;
	private _disposeCompletion: Promise<void> | undefined;
	private readonly _reflectionAbort = new AbortController();
	/** Root-owned version transition state; construction performs no filesystem I/O. */
	private readonly _durableLearningState: DurableLearningState | undefined;
	/** Root current-turn reflection cue + explicit learning-apply/rollback compatibility path. */
	private readonly _reflection: ReflectionController;
	/** Durable goal lifecycle, accounting, and raw continuation loop. */
	private readonly _goals: GoalSessionController;
	private readonly _isChildSession: boolean;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _sessionStartEvent: SessionStartEvent;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionMode: ExtensionContext["mode"] = "print";
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;

	private _modelRegistry: ModelRegistry;

	/** Tool-registry assembly + the self-modification-safe extension reload (see runtime-builder.ts);
	 * owns the base/wrapped tool definitions, the live tool registry, and the per-tool prompt
	 * snippet/guideline maps. The reload snapshot spans host/agent state reached through its deps. */
	private readonly _runtimeBuilder: RuntimeBuilder;

	/** Extension⇄session binding boundary (see extension-binding-controller.ts): `bindExtensions()`,
	 * extension resource discovery, and `bindExtensionCore`'s translation of session identity into
	 * the ExtensionRunner's core API. Owns the abort-handler/error-unsubscriber fields no other
	 * collaborator reads. */
	private readonly _extensionBinding: ExtensionBindingController;

	// Base system prompt (without extension appends) - used to apply fresh appends each turn.
	// The paired _baseSystemPromptOptions and their construction live in SystemPromptBuilder.
	private _baseSystemPrompt = "";
	private readonly _pathAliasWrappedTools = new WeakSet<AgentTool>();

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
			return this._costGuard.resolveRequestReasoning(
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
					localClass: isWarmableLocalModel(model),
					provider: model.provider,
					ceilingMs: httpBounded.adaptiveCeilingMs ?? DEFAULT_ADAPTIVE_STREAM_IDLE_CEILING_MS,
				});
				return { ...httpBounded.options, ...adaptive };
			}),
			baseStreamFn === streamSimple,
		);
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this.agent.state.messages = this.sessionManager.buildSessionContext().messages;
		// Initial load: `config.agent` may be a reused Agent instance carrying a stale sanitizer mark
		// from a different lineage. See Agent.resetSanitizerPrefixHorizon's doc comment.
		this.agent.resetSanitizerPrefixHorizon();
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
		this._isChildSession = (config.isChildSession ?? process.env.PI_CHILD_SESSION === "1") || isWorkerSession();
		this._durableLearningState = this._isChildSession ? undefined : DurableLearningState.forAgentDir(agentDir);
		this._skillVault = new SkillVaultController({
			getSkills: () => this._resourceLoader.getActiveSkills(),
			getMaxBodyBytes: () => resolveActiveSkillBodyByteLimit(this.model?.contextWindow),
			onSkillUsed: (skill) => {
				if (skill.promoted) this._skillCurator.recordUse(skill.name, Date.now());
			},
		});
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
			buildToolFreeSystemPrompt: (suffix) =>
				this._systemPromptBuilder.enforceSystemPromptBudget(
					`${this._systemPromptBuilder.buildSystemPromptForToolNames([])}\n\n${suffix}`,
				),
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
		this._localPrefixWarm = new LocalPrefixWarmController({
			getStreamFn: () => this.agent.streamFn,
			getTools: () => this.agent.state.tools,
			getSystemPrompt: () => this._baseSystemPrompt,
			getRequestHooks: () => ({ onPayload: this.agent.onPayload, onResponse: this.agent.onResponse }),
			isRawStreamSimple: (streamFn) => this._isRawStreamSimple(streamFn),
			getRequiredRequestAuth: (model) => this._getRequiredRequestAuth(model),
			ensureManagedModelReady: (model) => this._localRuntimeController.ensureIsolatedModelReady(model),
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
			getModelCapabilityProfile: () => this.getModelCapabilityProfile(),
			isChildSession: () => this._isChildSession,
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
			getSessionWorkerClaimHistory: () => getWorkerClaimSnapshots(this.sessionManager.getEntries()),
			getSessionLearningDecisionHistory: () => getLearningDecisionSnapshots(this.sessionManager.getEntries()),
			getLearningAuditRecords: () => this.getLearningAuditRecords(),
		});
		this._modelRegistry = config.modelRegistry;
		this._costGuard = new CostGuardController({
			getSettings: () => this.settingsManager.getCostGuardSettings(),
			getCompactionReserveTokens: () => this.settingsManager.getCompactionReserveTokens(),
			getSpawnedUsageCost: () => this.getSpawnedUsage().cost,
			isUnmeteredSubscription: (model) =>
				model.provider === "openai-codex" && this._modelRegistry.isUsingOAuth(model),
		});
		this._humanInput = new HumanInputController({
			getSessionManager: () => this.sessionManager,
			getUIContext: () => this._extensionUIContext,
			isDisposed: () => this._disposed,
			isStreaming: () => this.isStreaming,
			getModel: () => this.model,
			getArtifactStore: () => this._getToolArtifactStore(),
			getImageStore: () => this._getSessionImageStore(),
			runAgentPrompt: (messages) => this._foregroundRecovery.runAgentPrompt(messages),
		});
		this._goals = new GoalSessionController({
			getSessionManager: () => this.sessionManager,
			getModelProvider: () => this.model?.provider,
			getLaneRecords: () => this._backgroundLanes.getLaneRecords(),
			getTaskRuntimeSnapshot: () => this._backgroundLanes.getTaskRuntimeSnapshot(),
			getBackgroundToolTasks: () => this._backgroundToolTasks.list(),
			synchronizeGoalState: (state) => this._backgroundLanes.synchronizeGoalState(state),
			scheduleGoalAutoContinueFromIdle: () => this._backgroundLanes.scheduleGoalAutoContinueFromIdle(),
			prompt: (text, options) => this.prompt(text, options),
			emitWarning: (message) => this._emit({ type: "warning", message }),
		});
		this._pendingQueue = new PendingInputQueueController({
			agent: this.agent,
			skillVault: this._skillVault,
			goals: this._goals,
			getExtensionRunner: () => this._extensionRunner,
			getPromptTemplates: () => this.promptTemplates,
		});
		this._backgroundLanes = new BackgroundLaneController({
			isDisposed: () => this._disposed,
			isChildSession: () => this._isChildSession,
			getSessionId: () => this.sessionId,
			getCwd: () => this._cwd,
			getAgentDir: () => this._agentDir,
			getSessionManager: () => this.sessionManager,
			getSettingsManager: () => this.settingsManager,
			getResourceLoader: () => this._resourceLoader,
			getActiveOrchestrationProfile: () => config.orchestrationProfile,
			getModelRegistry: () => this._modelRegistry,
			isModelExhausted: (model) => this._foregroundRecovery.isModelExhausted(`${model.provider}/${model.id}`),
			getModel: () => this.model ?? undefined,
			getForegroundThinkingLevel: () => this.thinkingLevel,
			getForegroundToolNames: () => this.getActiveToolNames(),
			isDelegateToolActive: () => this.getActiveToolNames().includes("delegate"),
			isGoalToolActive: () => hasGoalContinuationControl(this.getActiveToolNames()),
			getCapabilityEnvelope: () => this.capabilityEnvelope,
			getModelCapabilityProfile: () => this.getModelCapabilityProfile(),
			emit: (event) => this._emit(event),
			notifyWorkerTerminalHandoff: (records) => this._terminalHandoffs.notifyWorkers(records),
			emitAutonomyTelemetry: (event) => this._emitAutonomyTelemetry(event),
			getGoalStateSnapshot: () => this.getGoalStateSnapshot(),
			getCurrentSubmissionEpoch: () => this._foregroundRecovery.getCurrentSubmissionEpoch(),
			getGoalRuntimeSnapshot: (settings) => this.getGoalRuntimeSnapshot(settings),
			markGoalToolUnavailable: () => this._goals.markToolUnavailable(),
			getEvidenceBundleSnapshot: () => this.getEvidenceBundleSnapshot(),
			saveEvidenceBundleSnapshot: (bundle) => this.saveEvidenceBundleSnapshot(bundle),
			saveWorkerClaimSnapshot: (claim, request) => this.saveWorkerClaimSnapshot(claim, request),
			readMemoryForLane: (query) => this._memory.readMemoryForLane(query),
			getArtifactStore: () => this._getToolArtifactStore(),
			getSkillReadBroker: () => ({
				search: (query) => this._skillVault.search(query),
				read: (name) => this._skillVault.read(name),
			}),
			getSkillAuditSource: () => ({
				getSkills: () => this._skillVault.getSkillsSnapshot(),
				redactPath: (path: string) => `skill:${createHash("sha256").update(path).digest("hex").slice(0, 12)}`,
			}),
			addSpawnedUsage: (usage, opts) => this.addSpawnedUsage(usage, opts),
			runIsolatedCompletion: (opts) => this.runIsolatedCompletion(opts),
			// RAW loop, deliberately bypassing the public `continueGoalLoop` — that method now delegates
			// to this controller's own `continueGoalLoopExclusive` guard, so routing through it here would
			// recurse into the guard from inside itself instead of driving the actual continuation pass.
			continueGoalLoop: (options) => this._goals.continueLoop(options),
			isForegroundBusy: () => this._foregroundRecovery.isBusy,
			waitForForegroundIdle: () => this._foregroundRecovery.waitForIdle(),
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
		this._backgroundToolTasks = new BackgroundToolTaskController({
			getSessionId: () => this.sessionManager.getSessionId(),
			getGoalId: () => this._goals.getOwnershipGoalId(),
			getCurrentSubmissionEpoch: () => this._foregroundRecovery.getCurrentSubmissionEpoch(),
			getSessionLineageIds: () => this.sessionManager.getSessionLineageIds(),
			getArtifactStore: () => this._getToolArtifactStore(),
			loadPersistedRecordsNewestFirst: () => loadBackgroundToolTaskRecordsNewestFirst(this.sessionManager),
			persist: (record) => this.sessionManager.appendCustomEntry(BACKGROUND_TOOL_TASK_CUSTOM_TYPE, record),
			notifyTerminal: (records, options) => this._terminalHandoffs.notifyTools(records, options.wakeParent),
			onLiveTasksChanged: (tasks) => this._emit({ type: "background_tools", tasks }),
			recordUsage: (taskId, usage) => {
				this.addSpawnedUsage(usage, {
					label: "background-tool",
					sourceSessionId: this.sessionManager.getSessionId(),
					reportId: `background-tool:${this.sessionManager.getSessionId()}:${taskId}`,
				});
			},
			onError: (message, error) =>
				this._emit({
					type: "warning",
					message: `${message}: ${error instanceof Error ? error.message : String(error)}`,
				}),
		});
		const failureCorpusPath = stateFile(this._agentDir, "failure-corpus.jsonl");
		this._toolRecoveryEventLogPath = stateFile(this._agentDir, TOOL_RECOVERY_EVENT_LOG_FILE);
		const toolRepairSettings = this._toolProtocol.getRepairSettings();
		this._failureCorpus = new FailureCorpusRecorder({ filePath: failureCorpusPath });
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
			getMemoryPreCompressInsight: () => this._memory.onPreCompress(),
			decorateCompactionDetails: (details) => this._decorateCompactionDetails(details),
			refreshAfterCompaction: () => this._refreshAfterCompaction(),
			getFailureCorpus: () => this._failureCorpus,
			measureLiveContextTokens: () => this._measureLiveContextTokensForCompaction(),
			runAutoCompaction: (reason, willRetry) => this._runAutoCompaction(reason, willRetry),
			compactWithRetry: (run, signal, provider) => this._compactWithRetry(run, signal, provider),
			onCompactionSettled: () => this._foregroundRecovery?.wakeIdleWaiters(),
		});
		const providerRequestContext = new ProviderRequestContextController({
			transformExtensions: async (messages) => {
				const runner = this._extensionRunner;
				const projection = runner.hasHandlers("context")
					? await runner.emitContext(messages)
					: { messages, transientMessages: [] };
				return { ...projection, isCurrent: () => this._extensionRunner === runner };
			},
			runContextAudit: (messages) => this._runContextAudit(messages),
			runPromptPolicyPlanning: (report) => this._runPromptPolicyPlanning(report),
			runMemoryRetrieval: (messages) => this._runMemoryRetrieval(messages),
			applyContextGc: (messages, writePayloads, frozenBelow) =>
				this._applyContextGc(messages, writePayloads, frozenBelow),
			correlatePromptPolicyWithContextGc: (report) => this._correlatePromptPolicyWithContextGc(report),
			runPromptEnforcement: (messages, report) => this._runPromptEnforcement(messages, report),
			enqueueRelevanceCuration: (messages, report) => this._enqueueRelevanceCuration(messages, report),
			maybeDrainBrainCuration: () => this._maybeDrainBrainCuration(),
			appendMemoryEvidence: (messages, report) => this._maybeAppendMemoryEvidenceBlock(messages, report),
			previewReflectionCue: () => this._reflection.previewCurrentTurnCue(),
			getGoalState: () => this.getGoalStateSnapshot(),
			skillVault: this._skillVault,
			applyPathAliases: (messages) => this._pipeline.applyPathAliases(messages),
		});
		this._providerRequestRuntime = new ProviderRequestRuntimeController({
			agent: this.agent,
			compaction: this._compaction,
			context: providerRequestContext,
			admitGoalRequest: () => this._goals.admitProviderRequest(),
			shouldStopGoalExecutionAfterTurn: () => this._goals.hasExecutionLeaseCrossedBudgetLimit(),
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
			isCompacting: () => this._compaction.isCompacting,
			prepareRun: async () => {
				this.agent.state.systemPrompt = this._systemPromptBuilder.enforceSystemPromptBudget(this.systemPrompt);
				await this._toolProtocol.ensureActiveModelProtocol();
			},
			afterRun: async () => {
				this._toolProtocol.restoreWithheldTools();
				this._flushPendingBashMessages();
				await this._drainQueuedExtensionCommands();
			},
		});
		this._durableCustomMessageTurns = new DurableCustomMessageTurnController({
			foreground: this._foregroundRecovery,
			goals: this._goals,
			enqueueSteeringMessage: (message) => this.agent.steer(message),
		});
		this._terminalHandoffs = new ForegroundTerminalHandoffController({
			foreground: this._foregroundRecovery,
			isDisposed: () => this._disposed,
			getGoalStateSnapshot: () => this.getGoalStateSnapshot(),
			getWorkerClaimSnapshot: (laneId) =>
				getLatestWorkerClaimSnapshot(getActiveSessionBranchEntries(this.sessionManager), laneId),
			getWorkerResult: (laneId) => this._backgroundLanes.getWorkerResult(laneId),
			startCustomMessageTurn: (message, lease, goalId) =>
				this._durableCustomMessageTurns.start(message, lease, goalId),
			enqueueCustomMessageTurn: (message) => this._durableCustomMessageTurns.enqueue(message),
			sendCustomMessage: (message, options, lease) => this._sendCustomMessage(message, options, lease),
			warn: (message) => this._emit({ type: "warning", message }),
		});
		this._modelRouter = new ModelRouterController({
			getAgent: () => this.agent,
			getModel: () => this.model ?? undefined,
			getSettingsManager: () => this.settingsManager,
			getSessionManager: () => this.sessionManager,
			appendSessionMessageBatch: (batch) => this._foregroundLifecycle.appendMessageBatch(batch),
			getModelRegistry: () => this._modelRegistry,
			isModelExhausted: (model) => this._foregroundRecovery.isModelExhausted(`${model.provider}/${model.id}`),
			getFailoverStatus: () => ({
				...this._foregroundRecovery.getFailoverStatus(),
				failureStats: this._failureCorpus.stats(),
			}),
			getAgentDir: () => this._agentDir,
			getReflectionSignal: () => this._reflectionAbort.signal,
			getBaseSystemPrompt: () => this._baseSystemPrompt,
			runAgentPrompt: (messages) => this._foregroundRecovery.runAgentPrompt(messages, this._foregroundPromptLease),
			runAgentContinuation: () => this._foregroundRecovery.runAgentContinuation(this._foregroundPromptLease),
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
		this._foregroundLifecycle = new ForegroundLifecycleAdapter(this.agent, this.sessionManager, this._modelRouter);
		this._foregroundLifecycle.start();
		this._reflection = new ReflectionController({
			getModel: () => this.model,
			getAgent: () => this.agent,
			isRawStreamSimple: () => this._isRawStreamSimple(this.agent.streamFn),
			getModelRegistry: () => this._modelRegistry,
			getMemoryManager: () => this._memory.getMemoryManager(),
			getFreshOkfMemoryForReflection: () => this._memory.getFreshOkfMemoryForReflection(),
			applyStructuredReflectionWrite: (write, signal) => this._memory.applyStructuredReflectionWrite(write, signal),
			rollbackStructuredReflectionWrite: this._memory.rollbackStructuredReflectionWrite.bind(this._memory),
			getSettingsManager: () => this.settingsManager,
			getSessionManager: () => this.sessionManager,
			getAgentDir: () => this._agentDir,
			getDurableLearningState: () => this._durableLearningState,
			getRuntimeVersion: () => (VERSION_SOURCE_AVAILABLE ? VERSION : undefined),
			getMemoryPolicyVersion: () => DURABLE_LEARNING_MEMORY_POLICY_VERSION,
			warn: (message) => this._emit({ type: "warning", message }),
			getCwd: () => this._cwd,
			getSkillsForAudit: () => this._resourceLoader.getActiveSkills(),
			isChildSession: () => this._isChildSession,
			isDisposed: () => this._disposed,
			getReflectionSignal: () => this._reflectionAbort.signal,
			resolveTextToolCallProtocol: (model) => this._resolveModelToolProtocol(model).protocol,
			archivePromotedSkill: (name) => this.archivePromotedSkill(name),
			refreshLiveSkills: () => this._resourceLoader.refreshSkills?.(),
			emitAutonomyTelemetry: (event) => this._emitAutonomyTelemetry(event),
			ensureModelReady: (model) => this._localRuntimeController.ensureIsolatedModelReady(model),
			addSpawnedUsage: (usage, opts) => this.addSpawnedUsage(usage, opts),
			saveLearningDecisionSnapshot: (decision) => this.saveLearningDecisionSnapshot(decision),
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
			getSkillVault: () => this._skillVault,
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
			isExtensionPathAllowed: (path, authority, baseDir) =>
				this._profileFilter.isExtensionPathAllowed(path, authority, baseDir),
			filterExtensionsForRuntime: (extensions, explicitLiveExtensionPaths) =>
				this._profileFilter.filterExtensionsForRuntime(extensions, explicitLiveExtensionPaths),
			getCapabilityEnvelope: () => this.capabilityEnvelope,
			setUnboundToolGrantWarnings: (warnings) => {
				this._unboundToolGrantWarnings = warnings;
			},
			getUnboundToolGrantWarnings: () => this._unboundToolGrantWarnings,
			setDelegatePromptGuidelineWarnings: (warnings) => {
				this._delegatePromptGuidelineWarnings = warnings;
			},
			createProfileFilterReloadSnapshot: () => this._profileFilter.createReloadSnapshot(),
			restoreProfileFilterReloadSnapshot: (snapshot) => this._profileFilter.restoreReloadSnapshot(snapshot),
			getActiveToolNames: () => this.getActiveToolNames(),
			setActiveToolsByName: (toolNames) => this.setActiveToolsByName(toolNames),
			normalizePromptSnippet: (text) => this._normalizePromptSnippet(text),
			normalizePromptGuidelines: (guidelines) => this._normalizePromptGuidelines(guidelines),
			bindExtensionCore: (runner) => this._extensionBinding.bindExtensionCore(runner),
			applyExtensionBindings: (runner) => this._extensionBinding.applyExtensionBindings(runner),
			extendResourcesFromExtensions: (reason) => this._extensionBinding.extendResourcesFromExtensions(reason),
			reapplyActiveProfileModelSettings: () => this._profileFilter.reapplyActiveProfileModelSettings(),
			notifyExtensionsChanged: () => this._notifyExtensionsChanged(),
			getToolArtifactStore: () => this._getToolArtifactStore(),
			getToolTaskDependencies: () => this._backgroundToolTasks,
			getSessionImageStore: () => this._getSessionImageStore(),
			getMemoryManager: () => this._memory.getMemoryManager(),
			getMemoryAuditDiagnostics: () => this._memory.getMemoryAuditDiagnostics(),
			clearPendingMemoryProviders: () => this._memory.clearPendingProviders(),
			createMemoryReloadSnapshot: () => this._memory.createReloadSnapshot(),
			restoreMemoryReloadSnapshot: (snapshot) => this._memory.restoreReloadSnapshot(snapshot),
			initializeMemory: () => this._memory.initialize(),
			getGoalStateSnapshot: () => this.getGoalStateSnapshot(),
			saveGoalStateSnapshot: (state) => this.saveGoalStateSnapshot(state),
			getActiveVerificationIds: () => this._getActiveVerificationIds(),
			authorizeGoalStartFromTool: (input) => this._goals.authorizeStartFromTool(input),
			getTaskStepsStateSnapshot: () => this.getTaskStepsStateSnapshot(),
			saveTaskStepsStateSnapshot: (state) => this.saveTaskStepsStateSnapshot(state),
			getPipelineRunSnapshot: () => this.getPipelineRunSnapshot(),
			savePipelineRunSnapshot: (run) => this.savePipelineRunSnapshot(run),
			getContextGcReport: (messages) => this.getContextGcReport(messages),
			startWorkerDelegation: (request) => this._backgroundLanes.startWorkerDelegation(request),
			workerAgentControl: this._backgroundLanes,
			getOrchestrationProfileCatalog: () => this._backgroundLanes.getOrchestrationProfileCatalog(),
			getWorkerLaneRecords: () => this._backgroundLanes.getLaneRecords(),
			getWorkerClaimSnapshots: () => this.getWorkerClaimSnapshots(),
			getWorkerResult: (laneId) => this._backgroundLanes.getWorkerResult(laneId),
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
		this._extensionBinding = new ExtensionBindingController({
			getAgent: () => this.agent,
			getExtensionRunner: () => this._extensionRunner,
			getSessionStartEvent: () => this._sessionStartEvent,
			getCwd: () => this._cwd,
			getResourceLoader: () => this._resourceLoader,
			getSessionManager: () => this.sessionManager,
			getSettingsManager: () => this.settingsManager,
			getModelRegistry: () => this._modelRegistry,
			getModel: () => this.model,
			getActiveToolNames: () => this.getActiveToolNames(),
			getAllTools: () => this.getAllTools(),
			setActiveToolsByName: (toolNames) => this.setActiveToolsByName(toolNames),
			refreshToolRegistry: () => this._refreshToolRegistry(),
			rebuildSystemPrompt: (toolNames) => this._rebuildSystemPrompt(toolNames),
			setBaseSystemPrompt: (prompt) => {
				this._baseSystemPrompt = prompt;
			},
			getPromptTemplates: () => this.promptTemplates,
			getThinkingLevel: () => this.thinkingLevel,
			setThinkingLevel: (level) => this.setThinkingLevel(level),
			setModel: (model) => this.setModel(model),
			sendCustomMessage: (message, options) => this.sendCustomMessage(message, options),
			sendUserMessage: (content, options) => this.sendUserMessage(content, options),
			setSessionName: (name) => this.setSessionName(name),
			registerMemoryProvider: (provider) => this.registerMemoryProvider(provider),
			registerContextMemoryProvider: (provider) => this.registerContextMemoryProvider(provider),
			addSpawnedUsage: (usage, opts) => this.addSpawnedUsage(usage, opts),
			recordManagedLane: (event) => this._backgroundLanes.recordManagedLane(event),
			isForegroundBusy: () => this._foregroundRecovery.isBusy,
			getPendingMessageCount: () => this.pendingMessageCount,
			isStreaming: () => this.isStreaming,
			isCompacting: () => this.isCompacting,
			getContextUsage: () => this.getContextUsage(),
			compactForExtension: (options) => this.compactForExtension(options),
			reload: () => this.reload(),
			abort: () => this.abort(),
			getSystemPrompt: () => this.systemPrompt,
			getExtensionCommandContextActions: () => this._extensionCommandContextActions,
			refreshCurrentModelFromRegistry: () => this._refreshCurrentModelFromRegistry(),
			initializeMemory: () => this._memory.initialize(),
			getExtensionUIContext: () => this._extensionUIContext,
			setExtensionUIContext: (uiContext) => {
				this._extensionUIContext = uiContext;
			},
			getExtensionMode: () => this._extensionMode,
			setExtensionMode: (mode) => {
				this._extensionMode = mode;
			},
			setExtensionCommandContextActions: (actions) => {
				this._extensionCommandContextActions = actions;
			},
			getExtensionShutdownHandler: () => this._extensionShutdownHandler,
			setExtensionShutdownHandler: (handler) => {
				this._extensionShutdownHandler = handler;
			},
			getExtensionErrorListener: () => this._extensionErrorListener,
			setExtensionErrorListener: (listener) => {
				this._extensionErrorListener = listener;
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
			getAgentDir: () => this._agentDir,
		});
		const previousToolArgumentValidation = this.agent.onToolArgumentValidation;
		this.agent.onToolArgumentValidation = (event) => {
			const taggedEvent = this._toolProtocol.tagAdaptationRuleTeaching(event);
			if (taggedEvent.outcome === "repaired" || taggedEvent.outcome === "bounced") {
				this._toolSelection.recordValidation(taggedEvent.tool, taggedEvent.outcome);
			}
			previousToolArgumentValidation?.(taggedEvent);
			// Protocol health and adaptation are deterministic runtime behavior, not optional recovery
			// logging. Keep them outside the analytics logger's enabled/disabled result.
			this._toolProtocol.handleValidationOutcome(taggedEvent);
			this._toolProtocol.handleAdaptationTelemetry(taggedEvent);
			const logRecord = this._toolRecoveryLogger.recordToolArgumentValidation(taggedEvent);
			if (!logRecord) return;
			this._analytics.recordToolArgumentValidation(logRecord);
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
			getEnvironment: (cwd) => this._runtimeBuilder.credentialManager.getEnvironmentForCwd(cwd) ?? {},
			redactSensitiveText: (text) => this._runtimeBuilder.credentialManager.redactSensitiveText(text),
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
		this._providerRequestRuntime.install();
		this._installAgentTurnRefresh();

		this._runtimeBuilder.buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
		this._unsubscribeSettingsChanges = this.settingsManager.subscribeChanges(() => {
			this._refreshBaseSystemPrompt();
		});
		this._localPrefixWarm.schedule(this.agent.state.model);
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

	private async _getRequiredRequestAuth(model: Model<Api>): Promise<RequestAuth> {
		const result = await this._modelRegistry.getApiKeyAndHeaders(model);
		if (!result.ok) {
			if (result.error.startsWith("No API key found")) {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw new Error(result.error);
		}
		if (this._modelRegistry.canUseResolvedRequestAuth(model, result)) {
			const headers: Record<string, string> = { ...result.headers };
			await this._extensionRunner.emitBeforeProviderHeaders({
				provider: model.provider,
				model: model.id,
				headers,
			});
			return { apiKey: result.apiKey, headers };
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

	/** Latest cost-guard decision (for the host footer/UI to surface a warning). Undefined if disabled. */
	getLastCostGuardDecision(): CostGuardDecision | undefined {
		return this._costGuard.getLastDecision();
	}

	/** Apply an explicit guard choice and invalidate all prior decision/envelope projections immediately. */
	setCostGuardSettings(settings: CostGuardSettings, scope: SettingsScope = "global"): void {
		this.settingsManager.setCostGuardSettings(settings, scope);
		this._costGuard.invalidateDecision();
		if (this._currentForegroundEnvelope) this._refreshForegroundEnvelope();
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
		const archived = this._skillCurator.archiveSkill(name);
		if (archived) this._resourceLoader.refreshSkills?.();
		return archived;
	}

	/** Restore a previously-archived promoted skill. Returns true if moved back. */
	restorePromotedSkill(name: string): boolean {
		const restored = this._skillCurator.restoreSkill(name);
		if (restored) this._resourceLoader.refreshSkills?.();
		return restored;
	}

	private _installAgentTurnRefresh(): void {
		const previousPrepareNextTurn = this.agent.prepareNextTurn?.bind(this.agent);
		const previousBeforeSteeringPoll = this.agent.beforeSteeringPoll?.bind(this.agent);
		this.agent.beforeSteeringPoll = async (signal) => {
			await previousBeforeSteeringPoll?.(signal);
			// This is later than async turn preparation and the graceful-stop check, making it the
			// authoritative last-moment inbox refresh before the queue is drained.
			this._terminalHandoffs.flushProviderBoundary();
		};
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

	/** Reconstruct trusted active verification IDs at the goal-execution boundary. */
	private _getActiveVerificationIds(): readonly string[] {
		return new VerificationObligationTracker(this.agent.state.messages).getActiveIds();
	}

	/** Preserve validated active verification IDs inside the compaction checkpoint. */
	private _decorateCompactionDetails(details: unknown): unknown {
		const snapshot = createVerificationObligationSnapshotDetails(this._getActiveVerificationIds());
		if (!snapshot) return details;
		if (!details || typeof details !== "object" || Array.isArray(details)) return snapshot;
		return { ...details, ...snapshot };
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

	private _getSessionImageStore(): SessionImageStore | undefined {
		const directory = this.settingsManager.getClipboardImageDirectory();
		if (!this.sessionManager.isPersisted() && !directory) return undefined;
		return new SessionImageStore({
			agentDir: this._agentDir,
			cwd: this._cwd,
			sessionId: this.sessionId,
			directory,
		});
	}

	/**
	 * Provider-plan hot-path delegation to {@link ContextPipeline.runContextAudit}. Kept as a
	 * one-line method so the request context controller owns pass ordering.
	 */
	private _runContextAudit(messages: AgentMessage[]): ContextAuditReport {
		return this._pipeline.runContextAudit(messages);
	}

	/** Read-only inspection of the context audit (delegates to {@link ContextPipeline.getContextAuditReport}). */
	getContextAuditReport(messages?: AgentMessage[]): ContextAuditReport {
		return this._pipeline.getContextAuditReport(messages);
	}

	/**
	 * Provider-plan hot-path delegation to {@link ContextPipeline.runPromptPolicyPlanning}. Kept as a
	 * one-line method so the request context controller owns pass ordering.
	 */
	private _runPromptPolicyPlanning(auditReport: ContextAuditReport): PromptPolicyShadowReport {
		return this._pipeline.runPromptPolicyPlanning(auditReport);
	}

	/** Read-only inspection of the shadow policy plan (delegates to {@link ContextPipeline.getPromptPolicyReport}). */
	getPromptPolicyReport(messages?: AgentMessage[]): PromptPolicyShadowReport {
		return this._pipeline.getPromptPolicyReport(messages);
	}

	/**
	 * Provider-plan commit delegation to {@link ContextPipeline.correlatePromptPolicyWithContextGc}.
	 * Kept as a one-line method so the request context controller owns pass ordering.
	 */
	private _correlatePromptPolicyWithContextGc(gcReport: ContextGcReport): void {
		this._pipeline.correlatePromptPolicyWithContextGc(gcReport);
	}

	/** Read-only inspection of the latest shadow-plan/legacy-gc correlation, for tests/debugging. */
	getPromptPolicyGcCorrelation(): PromptPolicyGcCorrelationReport {
		return this._pipeline.getPromptPolicyGcCorrelation();
	}

	/**
	 * Provider-plan hot-path delegation to {@link ContextPipeline.runPromptEnforcement}. Kept as a
	 * one-line method so the request context controller owns pass ordering.
	 */
	private _runPromptEnforcement(
		messages: AgentMessage[],
		shadowReport: PromptPolicyShadowReport,
	): { messages: AgentMessage[]; report: PromptEnforcementReport } {
		return this._pipeline.runPromptEnforcement(messages, shadowReport);
	}

	/**
	 * Provider-plan commit delegation to {@link ContextPipeline.enqueueRelevanceCuration}. Kept as a
	 * one-line method so the request context controller owns pass ordering.
	 */
	private _enqueueRelevanceCuration(messages: AgentMessage[], shadowReport: PromptPolicyShadowReport): void {
		this._pipeline.enqueueRelevanceCuration(messages, shadowReport);
	}

	/** Reflex/curation call-site delegation to {@link ContextPipeline.resolveCurationModelIfFit}. */
	private _resolveCurationModelIfFit(): Model<Api> | undefined {
		return this._pipeline.resolveCurationModelIfFit();
	}

	/**
	 * Provider-plan commit delegation to {@link ContextPipeline.maybeDrainBrainCuration}. Kept as a
	 * one-line method so the request context controller owns pass ordering.
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
	/**
	 * The live path-alias table, for expanding aliases back to real paths on any surface a person
	 * reads (see context/path-alias-display.ts). Aliases are a wire-format token optimization; the
	 * operator always sees their own paths.
	 */
	peekPathAliasTable(): PathAliasTable {
		return this._pipeline.peekPathAliasTable();
	}

	getContextCompositionReport(): ContextCompositionReport {
		const rawMessages = this.agent.state.messages.slice();
		// Dashboard/diagnostic view, not a live provider request: the send-time `sentPrefixCount`
		// mark lives inside the agent-core loop for the duration of one active plan() call and is
		// not readable from here, so this shows full packing potential (0 = no freeze) rather than a
		// stale or guessed mark.
		const gcResult = this._applyContextGc(rawMessages, false, 0);
		const requestMessages = gcResult.messages;
		const requestSystemPrompt = this._skillVault.previewRequestSystemPrompt(this.systemPrompt);
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
			systemPrompt: requestSystemPrompt ?? "",
			tools: this.agent.state.tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				providerDescription: tool.providerDescription,
				parameters: tool.parameters,
				source: extensionToolNames.has(tool.name) ? ("extension" as const) : ("built-in" as const),
			})),
			extensions: extensions.map((extension) => ({
				name: basename(extension.path),
				path: extension.path,
				toolNames: [...extension.tools.keys()],
				commandCount: extension.commands.size,
			})),
			messages: requestMessages,
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
				...this._delegatePromptGuidelineWarnings,
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
			this._toolSelection.formatTimingReport(),
		].join("\n\n");
	}

	async flushToolRecoveryLogsForTests(): Promise<void> {
		await this._toolRecoveryLogger.drain();
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
	 * Provider-plan hot-path delegation to {@link MemoryController.runMemoryRetrieval}. Kept as a
	 * one-line method so the request context controller owns pass ordering.
	 */
	private _runMemoryRetrieval(messages: AgentMessage[]): Promise<MemoryRetrievalReport> {
		return this._memory.runMemoryRetrieval(messages);
	}

	/** Read-only inspection of the latest memory-retrieval report, for tests/debugging. */
	getMemoryRetrievalReport(): MemoryRetrievalReport {
		return this._memory.getMemoryRetrievalReport();
	}

	/**
	 * Provider-plan hot-path delegation to {@link MemoryController.maybeAppendMemoryEvidenceBlock}.
	 * Kept as a one-line method so the request context controller owns pass ordering.
	 */
	private _maybeAppendMemoryEvidenceBlock(messages: AgentMessage[], report: MemoryRetrievalReport): AgentMessage[] {
		return this._memory.maybeAppendMemoryEvidenceBlock(messages, report);
	}

	/** Read-only inspection of the latest memory-prompt-inclusion decision, for tests/debugging and context_audit. */
	getMemoryPromptInclusionReport(): MemoryPromptInclusionReport {
		return this._memory.getMemoryPromptInclusionReport();
	}

	/**
	 * Provider-plan hot-path delegation to {@link ContextPipeline.applyContextGc}. Kept as a
	 * one-line method so the request context controller owns pass ordering;
	 * also serves the composition dashboard and {@link getContextGcReport} read-only paths.
	 */
	private _applyContextGc(
		messages: AgentMessage[],
		writePayloads: boolean,
		/** Already-sent boundary packing must not rewrite below. See {@link ContextPipeline.applyContextGc}. */
		frozenBelow: number,
	): { messages: AgentMessage[]; report: ContextGcReport } {
		return this._pipeline.applyContextGc(messages, writePayloads, frozenBelow);
	}

	/** Read-only inspection of the latest context-gc report (delegates to {@link ContextPipeline.getContextGcReport}). */
	getContextGcReport(messages?: AgentMessage[]): ContextGcReport {
		return this._pipeline.getContextGcReport(messages);
	}

	private _installAgentToolHooks(): void {
		this.agent.beforeToolCall = this._toolGate.beforeToolCall;
		this.agent.afterToolCall = this._toolGate.afterToolCall;
		this.agent.backgroundToolCallAfterMs = this.settingsManager.getBackgroundToolSettings().callAfterMs;
		this.agent.handoffToolCall = (context) =>
			this.getActiveToolNames().includes("tool_task") ? this._backgroundToolTasks.handoff(context) : undefined;
		this.agent.subscribeToolCallHandoffRequest = (toolCallId, request) =>
			this._backgroundToolTasks.subscribeHandoffRequest(toolCallId, request);
		this.agent.onRunawayStop = (info) => this._handleRunawayStop(info);
		this.agent.onToolValidationEscalation = (event) => this._handleToolValidationEscalation(event);
	}

	/** Persist the guard evidence, retain active work, and force the next pass onto a recovery path. */
	private _handleRunawayStop(info: AgentRunawayStopInfo): void {
		const goalRecovered = this._goals.recoverFromHarnessGuard(info);
		const record: RunawayStopRecord = {
			reason: info.reason,
			signature: info.signature,
			repeats: info.repeats,
			model: this.model?.id,
			provider: this.model?.provider,
			at: new Date().toISOString(),
		};
		this.sessionManager.appendCustomEntry(RUNAWAY_STOP_CUSTOM_TYPE, record);
		if (goalRecovered) {
			void this.sendCustomMessage(
				{
					customType: "runaway-recovery",
					content:
						info.reason === "stagnant_tool_cycle"
							? "A bounded harness guard ended an unchanged tool-result cycle, but the durable goal remains active and must continue automatically. Reuse the latest returned state; do not call the same status/read cycle again. Execute an available state-changing or finalization action, wait once on the true dependency, or record a concrete blocker."
							: "A bounded harness guard ended the previous agent loop, but the durable goal remains active and must continue automatically. Do not repeat the same failed operation unchanged. Inspect the recorded failure, change tool or approach, and keep working unless evidence proves a true owner/approval boundary.",
					display: false,
					details: info,
				},
				{ deliverAs: "nextTurn" },
			);
		}
		const cause =
			info.reason === "provider_turn_limit"
				? `the configured provider-turn limit of ${info.repeats} requests was reached`
				: info.reason === "stagnant_tool_cycle"
					? `the same tool-call cycle returned identical results ${info.repeats} times`
					: `the model repeated the same tool call ${info.repeats} times in a row without making progress`;
		this._emit({
			type: "warning",
			message: `Bounded guard ended this run: ${cause}.${goalRecovered ? " The active goal remains scheduled; the next pass must use a different approach." : ""}`,
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
		for (const listener of this._eventListeners) {
			try {
				// Public listeners are observers. Invoke them synchronously to preserve existing ordering,
				// but contain both synchronous failures and rejected thenables so one observer cannot
				// reject the session operation or prevent later observers from receiving the event.
				const result = listener(event) as unknown;
				if (result !== null && (typeof result === "object" || typeof result === "function") && "then" in result) {
					void Promise.resolve(result).catch(() => {});
				}
			} catch {
				// Listener failures must not affect session event dispatch or operation completion.
			}
		}
	}

	private _emitQueueUpdate(): void {
		this._emit({ type: "queue_update", ...this._pendingQueue.snapshot() });
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
			if (messageText && this._pendingQueue.removeIfPending(messageText) !== undefined) {
				this._emitQueueUpdate();
			}
			this._goals.activateQueuedOwnerChatGoal(event.message, this.agent.state.messages);
		}
		if (event.type === "turn_end" || event.type === "tool_execution_start" || event.type === "tool_execution_end") {
			this._skillVault.noteActivity();
		}
		if (event.type === "tool_execution_end" && event.isError) {
			this._toolRecoveryLogger.recordToolExecutionFailure({
				provider: this.model?.provider,
				model: this.model?.id,
				tool: event.toolName,
				details: event.result.details,
			});
			if (event.result.terminate === true) {
				this._goals.markTerminalToolFailureBlocked(event.toolName);
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

		if (event.type === "message_end") {
			compactToolResultDetailsForRetention(event.message);
			let messagePersisted = false;
			if (this._modelRouter.captureSessionMessage(event.message)) {
				// buffered by the router; persistence is deferred to the routed-turn flush
			} else if (event.message.role === "custom") {
				this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
				);
				this._durableCustomMessageTurns.notePersisted(event.message);
				messagePersisted = true;
			} else if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				this._foregroundLifecycle.appendMessage(event.message);
				messagePersisted = true;
			}
			// Track the response for ordered retry/failover/compaction handling after agent_end.
			if (event.message.role === "assistant") {
				const assistantMsg = event.message as AssistantMessage;
				this._foregroundLifecycle.recordTransportTelemetry(assistantMsg);
				this._goals.recordExecutionUsage(assistantMsg);
				if (messagePersisted) {
					this._pipeline.observeProviderUsage(this.agent.state.messages, assistantMsg);
				}
				if (assistantMsg.errorMessage?.startsWith(`${NATIVE_TOOL_PROTOCOL_RESIDUE_ERROR}:`)) {
					this._goals.markProtocolFailureBlocked(assistantMsg.errorMessage);
				}
				this._foregroundRecovery.observeAssistant(assistantMsg);
			}
		}
		if (event.type === "agent_end") {
			const willRetry = this._willRetryAfterAgentEnd(event);
			// Settle the exact cue-bearing run before completed-turn analysis can queue a later cue.
			this._reflection.finishCurrentTurnCue(event.messages, { willRetry });
			if (!willRetry) {
				const reflectionTurn = this._reflection.analyzeCompletedTurn(event.messages);
				// The shared projection excludes raw tool-result payloads and bounds both roles before any
				// deterministic memory sync. No reflection provider request is scheduled at this boundary.
				this._memory.scheduleTurnSync(reflectionTurn.userText, reflectionTurn.assistantText);
				if (reflectionTurn.trigger !== "none") this._reflection.queueCurrentTurnCue(reflectionTurn.trigger);
				this._goals.endQueuedOwnerChatGoalExecution();
			}
		}
		// Error/abort turns bypass the normal steering boundary, and a completion can arrive after the
		// final normal poll. agent_end is the fallback before foreground recovery decides whether queued
		// steering requires one continuation; turn_end is intentionally not a flush.
		if (event.type === "agent_end") {
			this._terminalHandoffs.flushProviderBoundary();
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
			await this._extensionRunner.emit({
				type: "agent_end",
				messages: event.messages,
				willRetry: this._willRetryAfterAgentEnd(event),
			});
		} else if (event.type === "turn_start") {
			this._toolSelection.startTurn();
			this._refreshForegroundEnvelope();
			await this._extensionRunner.emit({
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			});
		} else if (event.type === "turn_end") {
			await this._extensionRunner.emit({
				type: "turn_end",
				turnIndex: this._turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			});
			this._turnIndex++;
		} else if (event.type === "message_start") {
			await this._extensionRunner.emit({ type: "message_start", message: event.message });
		} else if (event.type === "message_update") {
			await this._extensionRunner.emit({
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			});
		} else if (event.type === "message_end") {
			const replacement = await this._extensionRunner.emitMessageEnd({
				type: "message_end",
				message: event.message,
			});
			if (replacement) {
				this._replaceMessageInPlace(event.message, replacement);
			}
		} else if (event.type === "tool_execution_start") {
			await this._extensionRunner.emit({
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			});
		} else if (event.type === "tool_execution_update") {
			await this._extensionRunner.emit({
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			});
		} else if (event.type === "tool_execution_end") {
			await this._extensionRunner.emit({
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			});
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);
		this._foregroundLifecycle.emitPendingWarnings((message) => this._emit({ type: "warning", message }));

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
		if (this._disposed) return;
		this._disposed = true;
		const { safely, track, trackRequired, finish } = createSessionShutdownTracker();

		safely(() => this._backgroundLanes.clearGoalAutoContinueTimer());
		safely(() => this._backgroundLanes.clearResearchLaneTimer());
		safely(() => this._foregroundRecovery.shutdown());
		safely(() => this._durableCustomMessageTurns.shutdown());
		safely(() => this.abortRetry());
		safely(() => this.abortCompaction());
		safely(() => this.abortBranchSummary());
		safely(() => this.abortBash());
		safely(() => this._skillVault.unload());
		safely(() => this._unsubscribeSettingsChanges?.());
		this._unsubscribeSettingsChanges = undefined;
		trackRequired(() => disposeShellExecutionSessionAndWait(this._shellSessionKey));
		safely(() => this._localPrefixWarm.cancel());
		safely(() => this.agent.abort());
		track(() => this._gatewayRegistry.stop());
		track(() => this._backgroundToolTasks.shutdown());
		track(() => this._runtimeBuilder.dispose());
		safely(() => this._reflection.dispose());
		safely(() => this._reflectionAbort.abort());
		safely(() => this._backgroundLanes.abortInFlightLanes());
		safely(() => this._providerRequestRuntime.dispose());
		safely(() => {
			this.agent.afterToolCall = undefined;
			this.agent.handoffToolCall = undefined;
			this.agent.subscribeToolCallHandoffRequest = undefined;
		});
		safely(() => this._extensionRunner.invalidate());
		track(() => this._resourceLoader.dispose?.() ?? Promise.resolve());
		safely(() => this._disconnectFromAgent());
		this._eventListeners = [];
		track(() => this._memory.shutdown());
		track(() => this._toolRecoveryLogger.shutdown());
		safely(() => cleanupSessionResources(this.sessionId));
		// Best-effort final sweep for any grep/find artifact already released (reference
		// count zero) but not yet reclaimed -- e.g. a release whose cleanup() call failed
		// transiently. This is conservative: it never releases a still-referenced
		// artifact, so a session that ends before context-gc ever evicts a result (too
		// short to cross preserveRecentMessages) correctly leaves that artifact in place,
		// resolvable if the same session is resumed later. It does not sweep OTHER
		// sessions' artifact directories.
		safely(() => this._pipeline.cleanupToolArtifactStoreOnDispose());
		this._disposeCompletion = finish();
	}

	/** Dispose synchronously-visible state, then await all session-owned asynchronous shutdowns. */
	async disposeAndWait(): Promise<void> {
		this.dispose();
		await this._disposeCompletion;
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
			maxTurnUsd: this._costGuard.getEnabledMaxTurnUsd(),
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
	 * (grep, find, run_toolkit_script, or ask_question) ends up in the resulting active set and artifact_retrieve
	 * is registered (i.e. not excluded/
	 * blocked/outside an allowlist -- the registry itself is built with that same filter,
	 * so registry presence already tracks "allowed"). This is enforced here, not just in
	 * the settings/profile refresh flow, because this method is a public, extension-
	 * exposed activation path (`setActiveTools`) on its own: without this, grep/find could
	 * end up active while still being handed an artifact store (gated on "allowed" in
	 * `_buildRuntime`) with no active tool able to resolve the resulting
	 * "Full output: artifact tool-output:<id>" handle.
	 * Other tools, including tool_task, activate only when explicitly requested (or present in the
	 * shared default request) and after surviving model-capability filtering.
	 */
	setActiveToolsByName(toolNames: string[]): void {
		// Model capability: small-window models get a reduced tool surface derived from the model's
		// own metadata. The unfiltered request is remembered so a later switch to a larger model
		// restores it (the filter is re-applied on every model change).
		this._requestedActiveToolNames = [...toolNames];
		const requested = [...toolNames];
		if (requested.includes("skill")) {
			requested.push("skillify", "skill_audit");
		}
		const capabilityFiltered = filterToolNamesForCapability(requested, this.getModelCapabilityProfile());

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
			validToolNames.includes("run_toolkit_script") ||
			validToolNames.includes("ask_question")
		) {
			addIfRegistered("artifact_retrieve");
		}
		this.agent.state.tools = tools.map((tool) =>
			wrapToolWithPathAliasExpansion(
				tool,
				() => this._pipeline.peekPathAliasTable(),
				this._pathAliasWrappedTools,
				() => this._cwd,
			),
		);

		// Rebuild base system prompt with new tool set
		this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
		this.agent.state.systemPrompt = this._baseSystemPrompt;

		this._checkContextWindowUsageWarning();
	}

	/** Request immediate transfer of one or all currently-running foreground tool calls. */
	backgroundRunningToolCalls(toolCallId?: string): number {
		if (!this.getActiveToolNames().includes("tool_task")) return 0;
		return this._backgroundToolTasks.requestHandoff(toolCallId);
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

	/**
	 * Re-enter an interrupted ask_question call from its durable request snapshot. Pending requests
	 * are presented again; already-checkpointed answers are replayed without asking twice. The
	 * original toolCallId is preserved so provider tool-call ordering remains valid on /resume.
	 */
	async resumePendingHumanInput(): Promise<boolean> {
		return this._humanInput.resumePending();
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

		const submissionLease = this._foregroundRecovery.tryAcquireSubmission();
		if (!submissionLease && this._foregroundRecovery.isBusy && options?.streamingBehavior) {
			const run = this._streamingPromptSubmissionTail.then(
				() => this._runPromptSubmission(text, options),
				() => this._runPromptSubmission(text, options),
			);
			this._streamingPromptSubmissionTail = run.catch(() => {});
			return run;
		}
		return this._runPromptSubmission(text, options, submissionLease);
	}

	private async _runPromptSubmission(
		text: string,
		options?: PromptOptions,
		initialSubmissionLease?: ForegroundSubmissionLease,
	): Promise<void> {
		const submission: ForegroundPromptSubmission = { lease: initialSubmissionLease };
		if (submission.lease) this._foregroundPromptLease = submission.lease;
		try {
			await this._promptUnserialized(text, options, submission);
		} finally {
			if (submission.lease) {
				if (this._foregroundPromptLease === submission.lease) this._foregroundPromptLease = undefined;
				this._foregroundRecovery.releaseSubmission(submission.lease);
			}
		}
		// After the lease is released, never before: the reflection turn is an ordinary submission and
		// would deadlock against the lease this one still holds inside the try above.
		await this._maybeRunDueReflectionTurn(options);
	}

	/**
	 * Spend the ONE extra provider turn a completed unit of work may buy on reflection.
	 *
	 * The turn is bought only by evidence (see `ReflectionController.beginDueReflectionTurn`), so a run
	 * with nothing durable to record costs exactly zero extra calls. It is fired here rather than at
	 * `agent_end` because it is a real turn on this session's own history and tools — that is what lets
	 * the model actually write to memory or promote a skill — and a turn cannot start while the run that
	 * ended is still holding the foreground submission lease.
	 *
	 * Never fires from an internal-context turn, which is what bounds the whole mechanism to one extra
	 * turn: the reflection turn is itself internal, so its completion cannot buy another.
	 */
	private async _maybeRunDueReflectionTurn(options?: PromptOptions): Promise<void> {
		if (options?.internalContextType || this._disposed) return;
		// An aborted run is the user asking for LESS work, not more; reflection waits for a turn that
		// actually finished. The cue stays due and merges with whatever the next completed turn adds.
		if (isInterruptedAssistantStopReason(this._findLastAssistantMessage()?.stopReason)) return;
		const reflectionPrompt = this._reflection.beginDueReflectionTurn();
		if (!reflectionPrompt) return;
		try {
			await this.prompt(reflectionPrompt, {
				expandPromptTemplates: false,
				processSlashCommands: false,
				autoContinueGoal: false,
				internalContextType: REFLECTION_TURN_TRIGGER_CUSTOM_TYPE,
			});
		} catch (error) {
			// Reported, not swallowed: a reflection turn that cannot run (no model, auth revoked mid-run,
			// provider outage) is a real failure worth surfacing, but it must not fail the user's own
			// completed turn behind it — that turn's work already succeeded.
			this._emit({
				type: "warning",
				message: `Reflection turn failed: ${error instanceof Error ? error.message : String(error)}`,
			});
		} finally {
			this._reflection.endReflectionTurn();
		}
	}

	private async _promptUnserialized(
		text: string,
		options: PromptOptions | undefined,
		submission: ForegroundPromptSubmission,
	): Promise<void> {
		this._toolProtocol.applyRepairLayerSettings();
		this._localPrefixWarm.cancel();
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
		let promptMessage: AgentMessage | undefined;
		let routingStarted = false;
		let pendingNextTurnCount = 0;
		// Effectiveness feedback: remember the recall page + the query so we can score, after the
		// response, whether the agent actually used the recalled context.
		let injectedRecall = "";
		let recallQuery = "";
		let admittedGoalId = options?.goalExecutionId;
		let goalToolStartAuthority: ExplicitGoalStartAuthority | undefined;

		try {
			// Handle extension commands first. Programmatic extension messages may opt
			// into command handling; if the agent is currently streaming, queue the
			// command for the end of the run instead of sending it to the model.
			if (processSlashCommands && text.startsWith("/")) {
				if (this.isStreaming && options?.source === "extension" && options?.streamingBehavior) {
					const commandName = this._pendingQueue.parseCommandName(text);
					if (this._extensionRunner.getCommand(commandName)) {
						this._pendingQueue.queueExtensionCommand(text);
						this._emitQueueUpdate();
						preflightResult?.(true);
						return;
					}
				}
				const handled = await this._pendingQueue.tryExecuteExtensionCommand(text);
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
				expandedText = this._pendingQueue.expandSkillCommand(expandedText);
				expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
			}

			if (!options?.internalContextType) goalToolStartAuthority = parseExplicitGoalStartAuthority(expandedText);

			// If streaming — or waiting out a retry backoff, which is still an active
			// operation — queue via steer() or followUp() instead of starting a
			// concurrent run that would race the pending retry continuation.
			if (!submission.lease) {
				submission.lease = this._foregroundRecovery.tryAcquireSubmission();
			}
			if (!submission.lease) {
				if (!options?.streamingBehavior) {
					throw new AgentBusyError(
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				}
				if (options.streamingBehavior === "followUp") {
					this._pendingQueue.queueFollowUp(expandedText, currentImages, goalToolStartAuthority);
				} else {
					this._pendingQueue.queueSteer(expandedText, currentImages, goalToolStartAuthority);
				}
				this._emitQueueUpdate();
				preflightResult?.(true);
				return;
			}
			this._foregroundPromptLease = submission.lease;

			if (!options?.internalContextType) {
				const recoveredGoalId = this._goals.resumeSystemBlockedGoal();
				const startedGoalId = this._goals.startOwnerChatGoal(expandedText, this.agent.state.messages);
				admittedGoalId = startedGoalId ?? recoveredGoalId ?? admittedGoalId;
			}

			// Queued steer/follow-up messages remain in the active turn; only a new submission resets the
			// cost controller's spawned-usage baseline shared by every round trip in this turn.
			this._costGuard.beginForegroundTurn();

			// Flush any pending bash messages before the new prompt
			this._flushPendingBashMessages();

			// Build the user message now — before the router judge — and paint it to the UI
			// immediately via a synthetic message_start. The judge is a real bounded LLM completion
			// (seconds), not a regex; awaiting it first made the prompt appear to hang. The
			// authoritative message_start emitted later for this SAME object is suppressed in
			// _handleAgentEvent (see _earlyDisplayedUserMessages) so it is still shown exactly once.
			if (options?.internalContextType) {
				if (currentImages && currentImages.length > 0) {
					throw new Error("Internal context turns do not accept image attachments.");
				}
				promptMessage = createCustomMessage(
					options.internalContextType,
					expandedText,
					false,
					undefined,
					new Date().toISOString(),
				);
			} else {
				const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
				if (currentImages) userContent.push(...currentImages);
				userMessage = {
					role: "user",
					content: userContent,
					timestamp: Date.now(),
				};
				promptMessage = userMessage;
				this._earlyDisplayedUserMessages.add(userMessage);
				this._emit({ type: "message_start", message: userMessage });
			}

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
			if (currentImages && currentImages.length > 0 && !requestModel.input.includes("image")) {
				throw new Error(
					`Model "${requestModel.provider}/${requestModel.id}" does not accept image input. Select an image-capable model or route the inspection to a vision worker.`,
				);
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

			// Every custom context message built below anchors to this same turn-owning timestamp
			// instead of its own fresh Date.now()/toISOString() read. Each is built once per turn and
			// then persists verbatim in durable history for every later request, so a fresh wall-clock
			// read here would just be noise; anchoring to the triggering message's own timestamp keeps
			// it a real, meaningful instant (this turn's start) without inventing a second one.
			const turnTimestamp = new Date(promptMessage.timestamp).toISOString();

			// Cross-session similarity recall. For a substantive turn, ask the memory providers to
			// prefetch a relevant <memory_context> page from past sessions and prepend it as data ahead of
			// the user message. Best-effort and gated: trivial turns are skipped, and providers return ""
			// (no page) when nothing is relevant — so it stays net-negative and the GC packs stale pages.
			if (!options?.internalContextType && this._memory.shouldAttemptRecall(expandedText)) {
				try {
					const recall = await this._memory.prefetchRecall(expandedText);
					if (recall) {
						injectedRecall = recall;
						recallQuery = expandedText;
						// Inject as a GC-managed custom context message (role "custom", customType
						// "memory_context"), NOT a persisted user message: the semantic-memory context-GC packs
						// stale recall pages so they don't accumulate forever, and the transcript index
						// only re-reads user/assistant text so recalled snippets can't recirculate.
						messages.push(createCustomMessage("memory_context", recall, false, undefined, turnTimestamp));
					}
				} catch {
					// recall must never break a turn
				}
			}

			// Queue one durable logical cue. ProviderRequestContextController owns its transient preview
			// and accepted-plan commit, so it never enters or needs cleanup from agent history.
			if (!options?.internalContextType) this._reflection.queueExternalRootTurnCue();

			// Add user message (built earlier, before the router judge, so it could be painted
			// immediately — see the early message_start emit above).
			messages.push(promptMessage);

			// Inject any pending "nextTurn" messages as context alongside the user message
			pendingNextTurnCount = this._pendingNextTurnMessages.length;
			for (const msg of this._pendingNextTurnMessages.slice(0, pendingNextTurnCount)) {
				messages.push(msg);
			}

			// Unlike memory_context/pipeline_context above, task_steps state is cheap to compute (a
			// snapshot read + pure string format, no recall/search) and is exactly what an internal
			// continuation turn most needs to see: which step it is mid-way through. It must NOT be
			// gated on internalContextType the way those are -- see the turn-economics B6 investigation
			// and compact-goal-context.ts's doc comment for the B1-shaped defect this closes (a
			// continuation used to have no way to see current step state short of a voluntary,
			// instruction-driven tool call).
			const taskStepsState = this.getTaskStepsStateSnapshot();
			const taskStepsContext = taskStepsState ? formatTaskStepsContext(taskStepsState, 12) : undefined;
			if (taskStepsState && taskStepsContext) {
				messages.push(
					createCustomMessage(
						"task_steps_context",
						taskStepsContext,
						false,
						{ revision: taskStepsState.revision },
						turnTimestamp,
					),
				);
			}

			const pipelineContextMessage = options?.internalContextType
				? undefined
				: createActivePipelineContextMessage({
						options: { agentPipelinesDir: resourceDir("pipelines", this._agentDir), cwd: this._cwd },
						snapshot: this.getPipelineRunSnapshot(),
						onError: (message) => this._emit({ type: "warning", message }),
						timestamp: turnTimestamp,
					});
			if (pipelineContextMessage) messages.push(pipelineContextMessage);

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
			// The turn never reached the foreground run, so the authoritative message_start that would
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
		const goalExecutionLease = this._goals.beginExecution(admittedGoalId, {
			adoptNewGoal: goalToolStartAuthority !== undefined,
			provisionalTokenBudget: goalToolStartAuthority?.tokenBudget,
		});
		this._goals.setStartAuthority(goalToolStartAuthority);
		try {
			this._toolProtocol.resetTurnState();
			await this._modelRouter.runRoutedTurn(messages, routedTurnModel, routedTurnRouteDecision);
			this._toolProtocol.recordParseOutcomeFromLastAssistant();
		} finally {
			this._goals.endQueuedOwnerChatGoalExecution();
			this._goals.setStartAuthority(undefined);
			this._goals.endExecution(goalExecutionLease);
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
		if (!isInterruptedAssistantStopReason(this._findLastAssistantMessage()?.stopReason)) {
			this._backgroundLanes.scheduleGoalAutoContinueFromIdle(options);
		}
		this._backgroundLanes.scheduleResearchLaneFromIdle();

		// Extension-only, and read after the lanes are scheduled so an armed continuation is visible.
		if (isSessionSettled(this, this._backgroundLanes.hasPendingIdleContinuation())) {
			await this._extensionRunner.emit({ type: "agent_settled" });
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
		this._pendingQueue.queueSteer(this._pendingQueue.prepareQueuedMessageText(text), images);
		this._emitQueueUpdate();
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		this._pendingQueue.queueFollowUp(this._pendingQueue.prepareQueuedMessageText(text), images);
		this._emitQueueUpdate();
	}

	// Steering/follow-up/extension-command queue mechanics (parsing, skill-command expansion,
	// draining) live in PendingInputQueueController (pending-input-queue-controller.ts). This
	// coordinator still owns the isStreaming-gated drain loop below and every _emitQueueUpdate()
	// call, since those depend on coordinator-wide state the controller intentionally doesn't have.

	private async _drainQueuedExtensionCommands(): Promise<void> {
		while (this._pendingQueue.getCommands().length > 0 && !this.isStreaming) {
			const commandText = this._pendingQueue.shiftCommand()!;
			this._emitQueueUpdate();
			await this._pendingQueue.tryExecuteExtensionCommand(commandText);
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
		if (options?.deliverAs === "nextTurn") {
			return this._sendCustomMessage(message, options);
		}
		const submissionLease = this._foregroundRecovery.tryAcquireSubmission();
		if (!submissionLease) {
			return this._sendCustomMessage(message, options);
		}
		try {
			await this._sendCustomMessage(message, options, submissionLease);
		} finally {
			this._foregroundRecovery.releaseSubmission(submissionLease);
		}
	}

	private async _sendCustomMessage<T>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" } | undefined,
		submissionLease?: ForegroundSubmissionLease,
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
		} else if (this._foregroundRecovery.isBusy && !this._foregroundRecovery.ownsSubmission(submissionLease)) {
			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this.agent.steer(appMessage);
			}
		} else if (options?.triggerTurn) {
			await this._foregroundRecovery.runAgentPrompt(appMessage, submissionLease);
		} else if (hasRunningBackgroundedToolCall(this._backgroundToolTasks.list())) {
			// Queue rather than splice while a backgrounded call is outstanding, exactly like the
			// isBusy branch above -- see hasRunningBackgroundedToolCall for why lease ownership is not
			// sufficient here. Scoped to the no-trigger case; triggerTurn:true is handled above.
			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this.agent.steer(appMessage);
			}
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
		const result = this._pendingQueue.clear();
		this._emitQueueUpdate();
		return result;
	}

	/** Number of pending messages (includes steering, follow-up, and queued extension commands) */
	get pendingMessageCount(): number {
		return this._pendingQueue.count;
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly string[] {
		return this._pendingQueue.getSteering();
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly string[] {
		return this._pendingQueue.getFollowUp();
	}

	/** Get pending extension commands (read-only). */
	getQueuedExtensionCommands(): readonly string[] {
		return this._pendingQueue.getCommands();
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
		this._localPrefixWarm.schedule(this.agent.state.model);
	}

	/** Re-resolve startup profile model/thinking after allowed extension providers are bound. */
	async reapplyActiveProfileModelSettings(): Promise<void> {
		const previousModel = this.model;
		await this._profileFilter.reapplyActiveProfileModelSettings();
		const activeToolNames = this._requestedActiveToolNames ?? this.getActiveToolNames();
		this._refreshToolRegistry({ activeToolNames, includeAllExtensionTools: true });
		if (!modelsAreEqual(previousModel, this.model)) {
			this._localPrefixWarm.schedule(this.model);
		}
	}

	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		const result = await this._modelSelection.cycleModel(direction);
		this._localPrefixWarm.schedule(result?.model);
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

	/** Start extension-requested compaction without blocking its event or shortcut handler. */
	compactForExtension(options?: CompactOptions): void {
		void (async () => {
			try {
				const result = await this.compact(options?.customInstructions);
				options?.onComplete?.(result);
			} catch (error) {
				const err = error instanceof Error ? error : new Error(String(error));
				options?.onError?.(err);
			}
		})();
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

	/**
	 * Activate bundled memory providers (file-store + transcript recall) so the `memory` tool can
	 * register. SDK create calls this before returning; {@link bindExtensions} re-runs it after
	 * extensions have registered additional providers. Profile and orchestration grants still decide
	 * whether the tool activates.
	 */
	initializeMemory(): Promise<void> {
		return this._memory.initialize();
	}

	/** Public entry point delegating to {@link ExtensionBindingController.bindExtensions}. */
	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		return this._extensionBinding.bindExtensions(bindings);
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
		this._foregroundLifecycle.reload();
		this._reflection.invalidateCurrentTurnCueStateCache();
		this.agent.state.messages = this.sessionManager.buildSessionContext().messages;
		// Extension/settings reload: guarded (see extension-binding-controller.ts) to never overlap
		// compaction, so this is always a genuine resync, never compaction's own within-lineage pack.
		this.agent.resetSanitizerPrefixHorizon();
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
		const result = await this._treeNavigator.navigateTree(targetId, options);
		this._reflection.invalidateCurrentTurnCueStateCache({ releaseActiveClaim: !result.cancelled });
		return result;
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
	saveGoalStateSnapshot(state: GoalState, expected?: GoalStateRevision): string {
		return this._goals.saveState(state, expected);
	}

	/** Persist a branch-scoped tombstone and stop goal-owned execution without resurrecting old state. */
	clearGoalStateSnapshot(state: GoalState, now: string): string {
		return this._goals.clearState(state, now);
	}

	/**
	 * Retrieve the latest valid goal state snapshot from the session log.
	 */
	getGoalStateSnapshot(): GoalState | undefined {
		return this._goals.getState();
	}

	/**
	 * Persist one submitted continuation pass's turn and active-wall-clock telemetry. Provider usage
	 * is charged separately at every assistant-response boundary under an identity-bound goal lease.
	 * A no-op when no goal state exists.
	 */
	recordGoalContinuationPass(pass: { turns: number; wallClockMs: number }): void {
		this._goals.recordContinuationTelemetry(pass);
	}

	/** Restore runtime intent, automatically reopening only goals stopped by bounded system guards. */
	restoreGoalRuntimeAfterResume(): boolean {
		return this._goals.restoreAfterResume();
	}

	/** Save native task-step state to the active session log. */
	saveTaskStepsStateSnapshot(state: TaskStepsState): string {
		return appendTaskStepsStateSnapshot(this.sessionManager, state);
	}

	/** Retrieve the latest valid native task-step state from the active session log. */
	getTaskStepsStateSnapshot(): TaskStepsState | undefined {
		return getLatestTaskStepsStateSnapshot(this.sessionManager);
	}

	/** Save the active ICM pipeline run pointer to the session log. */
	savePipelineRunSnapshot(run: PipelineRun): string {
		return appendPipelineRunSnapshot(this.sessionManager, run);
	}

	/** Latest valid pipeline run snapshot on the active branch. */
	getPipelineRunSnapshot(): PipelineRun | undefined {
		return getLatestPipelineRunSnapshot(this.sessionManager);
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

	saveWorkerClaimSnapshot(claim: WorkerClaim, request?: WorkerRequest): string {
		return appendWorkerClaimSnapshot(this.sessionManager, claim, request);
	}

	getWorkerClaimSnapshots(): WorkerClaim[] {
		return getWorkerClaimSnapshots(getActiveSessionBranchEntries(this.sessionManager));
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
		return this._goals.getRuntimeSnapshot(settings);
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
	 * Run one durable worker-agent turn. Delegates to {@link BackgroundLaneController};
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
		return this._goals.continueOnce(options);
	}

	/**
	 * Public entry point for BOTH idle autosteer and manual (`/goal start`, `/goal-continue`)
	 * continuation. Delegates to {@link BackgroundLaneController.continueGoalLoopExclusive}, the
	 * single-flight guard that prevents two goal loops from racing to submit prompts through the
	 * same session (which throws "Agent is already processing" from the second submission). Do not
	 * call `this._goals.continueLoop` directly from here — that bypasses the guard.
	 */
	async continueGoalLoop(options: GoalContinuationLoopOptions): Promise<GoalContinuationLoopResult> {
		return this._backgroundLanes.continueGoalLoopExclusive(options);
	}

	/** Run one explicit isolated completion for bounded host-owned consumers. */
	async runIsolatedCompletion(opts: IsolatedCompletionOptions): Promise<IsolatedCompletionResult> {
		return this._reflection.runIsolatedCompletion(opts);
	}

	/**
	 * Explicit compatibility/application reflection pass. Automatic reflection never calls this
	 * method; it returns null when the demand gate skips or in a child session.
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

	/** Owner control-plane access for the native /secrets TUI. Never exposed as an agent tool. */
	get credentialManager(): CredentialManager {
		return this._runtimeBuilder.credentialManager;
	}
}
