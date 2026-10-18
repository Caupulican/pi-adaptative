import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	Model,
	ModelServiceTier,
	TextContent,
	Usage,
} from "@caupulican/pi-ai";
import { modelsAreEqual } from "@caupulican/pi-ai/models";
import { cleanupSessionResources } from "@caupulican/pi-ai/session-resources";
import { getAgentDir, VERSION, VERSION_SOURCE_AVAILABLE } from "../config.ts";
import type { Agent } from "../kernel/agent.ts";
import {
	type CompactionResult,
	type CompactionSettings,
	hardCompactionTriggerTokens,
} from "../kernel/compaction/compaction.ts";
import type { AgentContext } from "../kernel/index.ts";
import { type CustomMessage, createCustomMessage } from "../kernel/messages.ts";
import { classifyFailure } from "../kernel/reliability/index.ts";
import { compactToolResultDetailsForRetention } from "../kernel/session/message-retention.ts";
import type { BranchSummaryEntry } from "../kernel/session/session-entries.ts";
import type { SessionManager, SessionRequestSnapshotInput } from "../kernel/session/session-manager.ts";
import { NATIVE_TOOL_PROTOCOL_RESIDUE_ERROR } from "../kernel/tool-protocol-residue.ts";
import type { AgentEvent, AgentMessage, AgentState, AgentTool, ThinkingLevel } from "../kernel/types.ts";
import {
	createVerificationDismissalDetails,
	VERIFICATION_DISMISSAL_CUSTOM_TYPE,
	VerificationObligationTracker,
	type VerificationObligationView,
} from "../kernel/verification-obligations.ts";
import { screenAcquisition } from "./acquisition/acquisition-boundary.ts";
import type { ExternalCapabilityAcquisitionGate } from "./acquisition/external-capability-acquisition-gate.ts";
import type { AdaptiveRuntimeReadiness } from "./adaptive/adaptive-runtime-readiness.ts";
import { resourceDir, stateFile } from "./agent-paths.ts";
import { createSessionBackgroundToolTasks } from "./agent-session-background-tasks.ts";
import {
	attachSessionAdaptiveRuntime,
	buildSessionContextCompositionReport,
	createSessionOperatorProjection,
	createSessionProjectRules,
	createSessionWorkerSupervision,
	offerCodexSubscriptionReset,
	runToolkitHit,
	type SessionAdaptiveRuntimeStack,
} from "./agent-session-composition.ts";
import {
	type EdgeGrantDetails,
	enforceSessionEdge,
	enforceSessionEdgeOperation,
	type SessionEdgeDeps,
} from "./agent-session-edge.ts";
import { handleRunawayStop, handleToolValidationEscalation, type SessionGuardDeps } from "./agent-session-guards.ts";
import { formatNoApiKeyFoundMessage } from "./auth-guidance.ts";
import type {
	CapabilityEnvelope,
	EvidenceBundle,
	GateOutcome,
	LearningDecision,
	RouteDecision,
	WorkerClaim,
	WorkerRequest,
} from "./autonomy/contracts.ts";
import type { EdgeClass, EdgeConfirmationHandler, EdgeGrantView } from "./autonomy/edge-policy.ts";
import type { ExecutionCharter } from "./autonomy/execution-charter.ts";
import { buildForegroundEnvelope } from "./autonomy/foreground-envelope.ts";
import { evaluateToolGate } from "./autonomy/gates.ts";
import type { LaneRecord } from "./autonomy/lane-tracker.ts";
import type { AutonomyDiagnosticSnapshot, AutonomyStatusSnapshot, GateOutcomeHistoryEntry } from "./autonomy/status.ts";
import type { AutonomyTelemetryEvent } from "./autonomy/telemetry-events.ts";
import { AutonomyTelemetry } from "./autonomy-telemetry.ts";
import { BackgroundLaneController } from "./background-lane-controller.ts";
import type { BackgroundToolTaskController } from "./background-tool-task-controller.ts";
import { BashExecutionController } from "./bash-execution-controller.ts";
import { type CapabilityTierPolicy, capabilityTierPolicy, resolveCapabilityTier } from "./capability-tier.ts";
import type { NativePiActivityPort } from "./collaboration/native-pi-activity.ts";
import { RETENTION_AUDIT_CUSTOM_TYPE } from "./compaction/evidence-retention-projection.ts";
import type { createRetentionDecisionEngine } from "./compaction/retention-decision-engine.ts";
import {
	createSelfCompactToolDefinition,
	SelfCompactionController,
	type SelfCompactionInfo,
	type SelfCompactionNowOutcome,
	type SelfCompactionView,
} from "./compaction/self-compaction-controller.ts";
import { type AutoCompactionReason, CompactionController, type IdlePreparationView } from "./compaction-controller.ts";
import { CompactionSupport } from "./compaction-support.ts";
import type { CurationTelemetrySnapshot } from "./context/brain-curator.ts";
import { cacheLaneKey, historyLineage } from "./context/cache-observation-recorder.ts";
import type { ArtifactStore } from "./context/context-artifacts.ts";
import type { ContextAuditReport } from "./context/context-audit.ts";
import { type ContextCompositionReport, formatContextCompositionDashboard } from "./context/context-composition.ts";
import type { ContextProjection } from "./context/context-projection.ts";
import type { EnforcePromptPolicyResult, PromptEnforcementReport } from "./context/context-prompt-enforcement.ts";
import type { PromptPolicyGcCorrelationReport, PromptPolicyShadowReport } from "./context/context-prompt-policy.ts";
import type { MemoryPromptInclusionReport, TranscriptHistoryStatus } from "./context/memory-diagnostics.ts";
import type { MemoryProvider as ContextMemoryProvider } from "./context/memory-provider-contract.ts";
import type { MemoryRetrievalReport } from "./context/memory-retrieval.ts";
import type { PathAliasTable } from "./context/path-alias-table.ts";
import { wrapToolWithPathAliasExpansion } from "./context/path-alias-tool-wrap.ts";
import { estimatePromptHeadroom } from "./context/prompt-headroom.ts";
import { PACKED_TOOL_OUTPUT_TOOLS } from "./context/tool-output-packer.ts";
import type { ContextGcReport, ContextGcResult } from "./context-gc.ts";
import { ContextPipeline, type ContextPolicyLane } from "./context-pipeline.ts";
import type { SessionCostSummary } from "./cost/cost-summary.ts";
import type { DailyUsageTotals } from "./cost/daily-usage.ts";
import type { CostGuardDecision, CostGuardSettings } from "./cost-guard.ts";
import { CostGuardController } from "./cost-guard-controller.ts";
import type { SemanticDecisionEngine } from "./decision/engine.ts";
import {
	appendWorkerClaimSnapshot,
	getWorkerClaimSnapshotForAttempt,
	getWorkerClaimSnapshots,
} from "./delegation/session-worker-claim.ts";
import type { WorkerResponseObservation } from "./delegation/worker-attempt-executor.ts";
import type { WorkerDelegationRequest } from "./delegation/worker-delegation-request.ts";
import { fanoutNoteForLane } from "./delegation/worker-fanout.ts";
import type { WorkerTerminalHandoffRecord } from "./delegation/worker-notification-coordinator.ts";
import { workerReportClaimText } from "./delegation/worker-report.ts";
import type { WorkerTerminalHandoff } from "./delegation/worker-terminal-handoff-coordinator.ts";
import { DurableCustomMessageTurnController } from "./durable-custom-message-turn-controller.ts";
import { ExtensionBindingController } from "./extension-binding-controller.ts";
import type { ContinuousChatAudit } from "./extensions/builtin.ts";
import type {
	CompactOptions,
	ContextUsage,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionErrorListener,
	ExtensionRunner,
	ExtensionUIContext,
	ReplacedSessionContext,
	SendUserMessageOptions,
	SessionStartEvent,
	ShutdownHandler,
	ToolDefinition,
	ToolInfo,
} from "./extensions/index.ts";
import type { MemoryProvider } from "./extensions/types.ts";
import { FailureCorpusRecorder } from "./failure-corpus.ts";
import { ForegroundLifecycleAdapter } from "./foreground-lifecycle-adapter.ts";
import { ForegroundRecoveryController, type ForegroundSubmissionLease } from "./foreground-recovery-controller.ts";
import { ForegroundTerminalHandoffController } from "./foreground-terminal-handoff-controller.ts";
import { type ChannelProvider, GatewayRegistry, type JobSchedulerProvider } from "./gateways/channel-provider.ts";
import { reportGithubOriginPinForSession } from "./github-origin-pin.ts";
import { isOwnIdleContinuationAdmission } from "./goals/goal-auto-continue-controller.ts";
import { recordObjectiveClarification } from "./goals/goal-clarification-log.ts";
import type { GoalCompletionOwnerDecisionInput } from "./goals/goal-completion-owner-decision.ts";
import { DEFAULT_GOAL_WORKER_WAIT_MS } from "./goals/goal-continuation-defaults.ts";
import type { GoalStateRevision } from "./goals/goal-lifecycle.ts";
import type { GoalRuntimeSnapshot, GoalRuntimeSnapshotSettings } from "./goals/goal-runtime-snapshot.ts";
import { GoalSessionController } from "./goals/goal-session-controller.ts";
import { type GoalState, isGoalExecutionActive } from "./goals/goal-state.ts";
import { hasGoalContinuationControl } from "./goals/goal-tool-names.ts";
import { recordAcceptedWorkerRequirementEvidence } from "./goals/worker-requirement-evidence.ts";
import { HostTurnReasoningController } from "./host-turn-reasoning.ts";
import { getResumableHumanInputSnapshot } from "./human-input.ts";
import { subscribeHumanInputActivity } from "./human-input-activity.ts";
import { HumanInputController } from "./human-input-controller.ts";
import {
	type AutoLearnProposalSet,
	type AutoLearnReportEntry,
	applyAutoLearnProposals as decideAutoLearnProposals,
} from "./learning/auto-learn-proposals.ts";
import { DURABLE_LEARNING_MEMORY_POLICY_VERSION, DurableLearningState } from "./learning/durable-learning-state.ts";
import type { LearningAuditRecord } from "./learning/learning-audit.ts";
import type { DemandSignals, ReflectionResult } from "./learning/reflection-engine.ts";
import { appendLearningDecisionSnapshot, getLearningDecisionSnapshots } from "./learning/session-learning-decision.ts";
import { type CurationProposals, SkillCurator } from "./learning/skill-curator.ts";
import { LocalPrefixWarmController } from "./local-prefix-warm-controller.ts";
import { LocalRuntimeController } from "./local-runtime-controller.ts";
import { ActiveBranchProbe } from "./memory/active-branch-probe.ts";
import {
	ContinuousChatPrefixSource,
	continuousChatPrefixOf,
	createContinuousChatCompactionAdapter,
} from "./memory/continuous-chat-compaction-adapter.ts";
import {
	CONTINUOUS_CHAT_WORK_REPORT_CUSTOM_TYPE,
	type ContinuousChatWorkReportEntry,
} from "./memory/continuous-chat-ingest.ts";
import {
	type ContinuousChatWire,
	continuousChatFrameMessages,
	renderContinuousChatTurnState,
	resolveContinuousChatTurnStart,
} from "./memory/continuous-chat-projection.ts";
import { readContinuousChatSettings, validateContinuousChatSummaryModel } from "./memory/continuous-chat-settings.ts";
import type { ManagedMemoryDriftEntry, ManagedMemoryTarget } from "./memory/providers/file-store.ts";
import { MemoryController } from "./memory-controller.ts";
import {
	deriveModelCapabilityProfile,
	evaluateLaneWorkerModelRefusal,
	filterToolNamesForCapability,
	type LaneWorkerRefusal,
	type ModelCapabilityProfile,
} from "./model-capability.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { resolveLaunchedChildModel } from "./model-resolver.ts";
import { AccountModelCatalog } from "./model-router/account-models.ts";
import {
	isModelInRouterPool,
	type RouterCandidatePool,
	type RouterPoolState,
	resolveRouterCandidatePool,
} from "./model-router/candidate-pool.ts";
import type { ModelPoolPolicy } from "./model-router/owner-model-policy.ts";
import type { LiveRoutePreview, RoutePreview } from "./model-router/route-preview.ts";
import { isLocalOrManagedRouterModel } from "./model-router/tool-escalation.ts";
import {
	type ForegroundRouteSnapshot,
	formatModelRouterModel,
	ModelRouterController,
} from "./model-router-controller.ts";
import { ModelSelectionController } from "./model-selection-controller.ts";
import { ModelAdaptationStore, type ModelToolProbe } from "./models/adaptation-store.ts";
import type { StoredFitnessReport } from "./models/fitness-store.ts";
import type { PrismLlamaCppRuntime } from "./models/llamacpp-runtime.ts";
import type { OllamaRuntime, TransformersRuntime } from "./models/local-runtime.ts";
import type { ExecutionLoopMode, ObjectiveExecutionController } from "./objective-execution/index.ts";
import { RULE_CONFLICT_NOTE } from "./objective-execution/local-commit-delivery.ts";
import { ObjectiveExecutionInterruptedError } from "./objective-execution/objective-execution-controller.ts";
import { ObjectiveMutationLedger } from "./objective-execution/objective-mutation-ledger.ts";
import type { ObjectiveRoute } from "./objective-execution/objective-route.ts";
import { type TrustedDeployAdapter, TrustedDeployAdapterRegistry } from "./objective-execution/release-delivery.ts";
import {
	RepositoryMutationObserver,
	type RepositoryWorkEvidenceJournal,
	type RepositoryWorkEvidenceScope,
} from "./objective-execution/repository-mutation-observer.ts";
import { IndependentObserverSet } from "./observer-dispatch.ts";
import type { CacheDecisionRow, DecisionLedgerStore } from "./operator-projection/decision-ledger-store.ts";
import type { DecisionStageSink } from "./operator-projection/decision-stage-log.ts";
import type { DeliveryState, SessionOperatorProjection } from "./operator-projection/session-operator-projection.ts";
import type { AdaptationProjection } from "./operator-projection/types.ts";
import {
	type OrchestrationModelUnusableCause,
	resolveConfiguredOrchestrationModel,
} from "./orchestration/model-binding.ts";
import { validateOrchestrationProfile } from "./orchestration/profile-registry.ts";
import { OwnerInputLedger, type OwnerInputOutcome } from "./owner-input-ledger.ts";
import {
	ownerSteerWake,
	type PendingInputHandle,
	PendingInputQueueController,
	type QueuedInput,
} from "./pending-input-queue-controller.ts";
import { appendPipelineRunSnapshot, getLatestPipelineRunSnapshot, type PipelineRun } from "./pipelines/index.ts";
import { ProfileFilterController } from "./profile-filter-controller.ts";
import { DurableOwnerRuleStore, type OwnerRulePolicy } from "./project-rules/durable-owner-rules.ts";
import { SessionProjectRules } from "./project-rules/session-project-rules.ts";
import type { RuleRepairWork } from "./project-rules/types.ts";
import { PromptSubmissionController } from "./prompt-submission-controller.ts";
import type { PromptTemplate } from "./prompt-templates.ts";
import { resolveProviderAccountKey } from "./provider-admission/account-key.ts";
import { engageEmergencyStop, liftEmergencyStop } from "./provider-admission/emergency-stop.ts";
import { openProviderAdmission } from "./provider-admission/gate.ts";
import { type ProviderAdmissionLedger, providerAdmissionDir } from "./provider-admission/ledger.ts";
import type { ProviderLimitStore } from "./provider-admission/limit-state.ts";
import { buildProviderLoadView, type ProviderLoadView } from "./provider-admission/load-view.ts";
import { ProviderRequestContextController } from "./provider-request-context-controller.ts";
import { ProviderRequestRuntimeController } from "./provider-request-runtime-controller.ts";
import { QueuedInputPersistenceController } from "./queued-input-persistence-controller.ts";
import { ReflectionController } from "./reflection-controller.ts";
import { ReflectionTurnLifecycle } from "./reflection-turn-lifecycle.ts";
import { assertReloadQuiescent } from "./reload-blockers.ts";
import {
	CONVERSATION_TALKER_CUSTOM_TYPE,
	type ConversationTalkerRecord,
	REPLY_ROUTE_CUSTOM_TYPE,
	type ReplyRouteRecord,
} from "./reply-route.ts";
import type { RequestAuth } from "./request-auth.ts";
import { LaneModelResolver } from "./research/lane-model-resolver.ts";
import type { ModelFitnessReport } from "./research/model-fitness.ts";
import {
	appendEvidenceBundleSnapshot,
	getEvidenceBundleSnapshots,
	getLatestEvidenceBundleSnapshot,
} from "./research/session-evidence-bundle.ts";
import { collectWorkspaceSources } from "./research/workspace-collector.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { RuntimeBuilder } from "./runtime-builder.ts";
import { RuntimeUpdateController } from "./runtime-update-controller.ts";
import type { CredentialManager } from "./secrets/credential-manager.ts";
import { SessionAnalytics } from "./session-analytics.ts";
import { SessionCacheController } from "./session-cache-controller.ts";
import { SessionEdgeIntentController } from "./session-edge-intent-controller.ts";
import { SessionImageStore } from "./session-image-store.ts";
import { isWorkerSession } from "./session-role.ts";
import { SessionSemanticPlaneController } from "./session-semantic-plane-controller.ts";
import { hasRunningBackgroundedToolCall, isSessionSettled } from "./session-settlement.ts";
import { CLOSING_RUN_SETTLE_MS, createSessionShutdownTracker, runSettlesWithin } from "./session-shutdown.ts";
import { getActiveSessionBranchEntries } from "./session-snapshot.ts";
import { buildSessionStreamFn, isRawStreamSimpleFn } from "./session-stream-chain.ts";
import { SessionTreeNavigator } from "./session-tree-navigator.ts";
import { SessionUnsettledLadderController } from "./session-unsettled-ladder-controller.ts";
import { deriveSessionWorkState, type SessionWorkState } from "./session-work-state.ts";
import type { MemorySystem, ResourceProfileFilterSettings, SettingsScope } from "./settings/settings-schema.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { resolveActiveSkillBodyByteLimit, SkillVaultController } from "./skill-vault.ts";
import { skillWorkPathsFromToolCall } from "./skill-work-paths.ts";
import { skillsForSessionRole, workerEligibleSkills } from "./skills.ts";
import type { SystemOneSteeringPlane } from "./steering/system-one-steering-plane.ts";
import type { WorkerSupervisionCoordinator } from "./supervision/worker-supervision-coordinator.ts";
import { accountPassBindings } from "./system-one/account-pass-wiring.ts";
import { collectWorkerReportClaimReceipts } from "./system-one/claim-delivery.ts";
import { formatClarificationQuestion } from "./system-one/clarification.ts";
import type { SystemOneController } from "./system-one/controller.ts";
import { prewarmOperationGate } from "./system-one/operation-gate-wiring.ts";
import {
	appendOwnerFollowUp,
	type OwnerQuestionConsult,
	ownerFollowUpPath,
} from "./system-one/owner-question-routing.ts";
import { changesPlan, reviewPlan } from "./system-one/plan-review.ts";
import type { SemanticUncertaintyPort } from "./system-one/semantic-doubts.ts";
import type { SemanticEvaluationRecord } from "./system-one/semantic-evaluation-ledger.ts";
import type { SemanticPlaneHealth } from "./system-one/semantic-plane-health.ts";
import type { toolResultEvidence } from "./system-one/unsettled-ladder.ts";
import type { SemanticVerificationObligationView } from "./system-one/verification-obligations.ts";
import { createSessionWorkerControl, type SystemOneWorkerControl } from "./system-one/worker-control.ts";
import { SystemPromptBuilder } from "./system-prompt-builder.ts";
import { appendTaskStepsStateSnapshot, getLatestTaskStepsStateSnapshot } from "./tasks/session-task-state.ts";
import { captureSessionTaskDirectoryContext } from "./tasks/task-directory-context.ts";
import type { TaskStepsState } from "./tasks/task-state.ts";
import { writeTerminalWarnings } from "./terminal-warnings.ts";
import {
	enforceExplicitOptionalToolRequest,
	OPTIONAL_TOOL_INTENT_CUSTOM_TYPE,
	optionalToolRequestAliases,
	readOptionalToolIntent,
} from "./tool-applicability-gate.ts";
import { ToolGateController } from "./tool-gate-controller.ts";
import { type ToolProbeReport, type ToolProbeResult, ToolProtocolController } from "./tool-protocol-controller.ts";
import { TOOL_RECOVERY_EVENT_LOG_FILE } from "./tool-recovery-log-records.ts";
import { ToolRecoveryLogger } from "./tool-recovery-logger.ts";
import { formatToolSelectionHints } from "./tool-selection/promotion.ts";
import { ToolPerformanceStore } from "./tool-selection/tool-performance-store.ts";
import { formatToolSelectionReport, ToolSelectionController } from "./tool-selection/tool-selection-controller.ts";
import { mutationScopeForWorktree } from "./tools/file-mutation-queue.ts";
import type { BashOperations, BashResult } from "./tools/schemas/bash.ts";
import { disposeShellExecutionSessionAndWait } from "./tools/shell-execution-session.ts";
import type { WaitStatusEvent } from "./util/wait.ts";
import { currentWorkUnit, openWorkUnit, WORKER_RECEIPTS_CUSTOM_TYPE } from "./work-units.ts";
import type { WorktreeSyncEnginePorts } from "./worktree-sync/runtime.ts";

// ============================================================================
// Stream-idle watchdog wiring
// ============================================================================

export * from "./agent-session-contracts.ts";

import {
	type AgentSessionConfig,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type ExtensionBindings,
	type GoalContinuationLoopOptions,
	type GoalContinuationLoopResult,
	type GoalContinuationOnceOptions,
	type GoalContinuationOnceResult,
	getStreamIdleOptionsOverride,
	type IsolatedCompletionOptions,
	type IsolatedCompletionResult,
	isInterruptedAssistantStopReason,
	type ModelCycleResult,
	type PromptOptions,
	type ResearchLaneRunOutcome,
	type SessionStats,
	type WorkerDelegationRunOutcome,
} from "./agent-session-contracts.ts";
import { type SessionSemanticUsageDelivery, sessionSemanticUsageOf } from "./cost/semantic-usage-delivery.ts";
import type { SpawnedUsageTotals } from "./cost/usage-records.ts";

export type { ToolProbeReport, ToolProbeResult, ToolProbeVerdict } from "./tool-protocol-controller.ts";

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
	readonly agent: Agent;
	private readonly sessionManager: SessionManager;
	private readonly settingsManager: SettingsManager;
	public capabilityEnvelope?: CapabilityEnvelope;
	private readonly _cache: SessionCacheController;
	private readonly _semanticPlane: SessionSemanticPlaneController;
	private readonly _unsettledLadder: SessionUnsettledLadderController;
	private readonly _queuedInputPersistence: QueuedInputPersistenceController;
	private readonly _edgeIntent: SessionEdgeIntentController;
	private readonly _promptSubmission: PromptSubmissionController;

	private _scopedModels: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;
	/** The router's configured scope; undefined leaves available favorites unrestricted by a scope. */
	private _routerPool: RouterPoolState | undefined;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _unsubscribeSettingsChanges?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private readonly _onClosingWarnings: (warnings: readonly string[]) => void;
	private _extensionsChangedListeners: Array<() => void> = [];

	/** Steering/follow-up/extension-command queues (see pending-input-queue-controller.ts); assigned
	 * in the constructor body since it depends on `_skillVault` and `_goals` being ready. */
	private readonly _pendingQueue: PendingInputQueueController;
	/** Owner-input identities (minted at acceptance) and the one Delivered point: the input's user entry persisted. */
	private readonly _ownerInputs = new OwnerInputLedger((message) => this._foregroundLifecycle.warn(message));
	private _pendingNextTurnMessages: CustomMessage[] = [];
	/**
	 * The last tool set requested via setActiveToolsByName BEFORE model-capability filtering, so
	 * switching from a small-window model back to a large one restores the full requested set.
	 */
	private _requestedActiveToolNames: string[] | undefined;

	private _unboundToolGrantWarnings: string[] = [];
	/** Delegate provider-prompt-guideline bounding diagnostics (root-session delegate tool only). */
	private _delegatePromptGuidelineWarnings: string[] = [];

	private readonly _modelSelection: ModelSelectionController;
	private readonly _bash: BashExecutionController;
	private readonly _profileFilter: ProfileFilterController;
	private readonly _toolGate: ToolGateController;
	private readonly _mutationLedger = new ObjectiveMutationLedger();
	private readonly _repositoryObserver = new RepositoryMutationObserver(this._mutationLedger);
	private readonly _deployAdapters = new TrustedDeployAdapterRegistry();
	private readonly _toolSelection: ToolSelectionController;
	private readonly _toolPerformanceStore: ToolPerformanceStore;
	private readonly _modelAdaptationStore: ModelAdaptationStore;

	private _extensionRunner!: ExtensionRunner;
	private _turnIndex = 0;
	private _currentForegroundEnvelope?: CapabilityEnvelope;

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _cwd: string;
	/** Per-agent persistent shell session identity: stable across runtime reloads, disposed with the session. */
	private readonly _shellSessionKey = `agent:${randomUUID()}`;
	/** Lock scope of the worktree this session started in; shared with every session working there. */
	private _mutationScopeKey: string | undefined;
	private get mutationScope(): string {
		this._mutationScopeKey ??= mutationScopeForWorktree(this._cwd);
		return this._mutationScopeKey;
	}
	private _agentDir: string;
	private readonly _providerAdmissionLedger: ProviderAdmissionLedger;
	private readonly _providerLimitStore: ProviderLimitStore;
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
	/** The foreground prefix ICM compactions repeat: the last accepted request's system prompt and tools. */
	private readonly _continuousChatPrefix = new ContinuousChatPrefixSource();
	private readonly _compactionSupport: CompactionSupport;
	private readonly _compaction: CompactionController;
	private readonly _selfCompaction: SelfCompactionController;
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
	private readonly _gatewayRegistry = new GatewayRegistry({
		onDiagnostic: (message) => this._emit({ type: "warning", message }),
	});
	/** Usage/cost/stats accounting, /context estimate, and session export (see session-analytics.ts);
	 * owns the spawned-usage and daily-usage memo caches. */
	private readonly _analytics: SessionAnalytics;
	/** The session manager's usage owner: pending paid usage, admission confirmations, and the reviewer's sink. */
	private readonly _semanticUsage: SessionSemanticUsageDelivery;
	private readonly _treeNavigator: SessionTreeNavigator;
	private readonly _costGuard: CostGuardController;
	/** Host-turn reasoning policy (host-turn-reasoning.ts): the latest decision and this session's lowered count. */
	readonly hostTurnReasoning: HostTurnReasoningController;
	/** Per-turn model-router subsystem (see model-router-controller.ts); owns the transient route/intent,
	 * the cheap-turn session buffer, the escalation/retry flags, and the sticky last-decision/skip-reason
	 * used by the status report. Its parallel routed drive path delegates every turn back to
	 * {@link ForegroundRecoveryController.runAgentPrompt} so the drive loop stays host-side. */
	private readonly _modelRouter: ModelRouterController;
	private readonly _foregroundLifecycle: ForegroundLifecycleAdapter;
	private readonly _foregroundRecovery: ForegroundRecoveryController;
	private readonly _failureCorpus: FailureCorpusRecorder;
	private readonly _toolRecoveryLogger: ToolRecoveryLogger;
	private readonly _toolRecoveryEventLogPath: string;
	private readonly _skillVault: SkillVaultController;
	private _skillCuratorInstance?: SkillCurator;
	private _disposed = false;
	/** Set when the closing sequence released the internal agent consumer; a handler that was already running must not continue past it. */
	private _closingConsumerReleased = false;
	private _disposeCompletion: Promise<void> | undefined;
	private readonly _reflectionAbort = new AbortController();
	/** Advanced by every branch navigation: the context generation queued owner input is bound to. */
	private _branchGeneration = 0;
	/** Owns the lifetime of the one detached end-of-work reflection turn; see reflection-turn-lifecycle.ts. */
	private readonly _reflectionTurnLifecycle: ReflectionTurnLifecycle;
	/** Root-owned version transition state; construction performs no filesystem I/O. */
	private readonly _durableLearningState: DurableLearningState | undefined;
	/** Root current-turn reflection cue + explicit learning-apply/rollback compatibility path. */
	private readonly _reflection: ReflectionController;
	/** Durable goal lifecycle, accounting, and raw continuation loop. */
	private readonly _goals: GoalSessionController;
	private readonly _isChildSession: boolean;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private readonly _worktreeSyncEnginePorts?: WorktreeSyncEnginePorts;
	private readonly _shellOperations?: BashOperations;
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
	readonly runtimeUpdates: RuntimeUpdateController;

	/** Extension⇄session binding boundary (see extension-binding-controller.ts): `bindExtensions()`,
	 * extension resource discovery, and `bindExtensionCore`'s translation of session identity into
	 * the ExtensionRunner's core API. Owns the abort-handler/error-unsubscriber fields no other
	 * collaborator reads. */
	private readonly _extensionBinding: ExtensionBindingController;

	// Base system prompt (without extension appends) - used to apply fresh appends each turn.
	// The paired _baseSystemPromptOptions and their construction live in SystemPromptBuilder.
	private _baseSystemPrompt = "";
	private readonly _pathAliasWrappedTools = new WeakSet<AgentTool>();
	private _systemOneController?: SystemOneController;
	private readonly _accountModels: AccountModelCatalog;
	/** Providers whose usage-limit episode already told the owner about redeemable resets. */
	private readonly _subscriptionResetOffered = new Set<string>();
	private readonly _subscriptionResetChecking = new Set<string>();
	private _executionLoopMode?: ExecutionLoopMode;
	private _objectiveExecutionController?: ObjectiveExecutionController;
	private _steeringPlane?: SystemOneSteeringPlane;
	/** Each worker conversation's own context-policy state (audit memo, tool facts), by agent id. */
	private readonly _workerContextPolicyLanes = new Map<string, ContextPolicyLane>();
	private _adaptiveReadiness?: AdaptiveRuntimeReadiness;
	/** Durable owner development rules, restored from disk so they outlive compaction and restart. */
	private readonly _ownerRules: DurableOwnerRuleStore;
	/** Root semantic project rules, consulted at mutation acceptance, postflight and completion. */
	private readonly _projectRules: SessionProjectRules;
	/** Live worker supervision, bound to the real worker lifecycle and root worker control. */
	private readonly _workerSupervision: WorkerSupervisionCoordinator;
	/** The one live operator projection this session owns; the TUI reads it, never a literal. */
	private readonly _operatorProjection: SessionOperatorProjection;
	/** External-acquisition gate; its authority is the session's own ExecutionCharter. */
	private _acquisitionGate?: ExternalCapabilityAcquisitionGate;
	private _executionCharter?: ExecutionCharter;
	private _adaptationProjection?: AdaptationProjection;
	private _deliveryState: DeliveryState = "none";
	private _workerControl?: SystemOneWorkerControl;
	/** Admitted outward-facing tool calls still running; DELIVER ends when the last one ends. */
	private readonly _deliveryToolCalls = new Set<string>();
	private _operatorBlocker?: string;
	private _unsubscribeIdleOccupancy?: () => void;
	/** Woken when a condition that refuses the system switch lease (running lanes, tool tasks, reflection) may have cleared. */
	private readonly _systemSwitchAvailability = new IndependentObserverSet<() => void>();
	private _systemSwitchAvailabilityQueued = false;

	private readonly _agentDirForLedger: string;

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this._onClosingWarnings = config.onClosingWarnings ?? writeTerminalWarnings;
		this._systemOneController = config.systemOneController;
		// Without a checked catalog nothing is known up front, but a provider's refusal is still recorded.
		this._accountModels =
			config.accountModels ??
			new AccountModelCatalog({
				getModels: () => config.modelRegistry.getAll(),
				hasConfiguredAuth: (model) => config.modelRegistry.hasConfiguredAuth(model),
				getRequestAuth: async () => undefined,
			});
		this._executionLoopMode = config.executionLoopMode;
		this._objectiveExecutionController = config.objectiveExecutionController;
		this._steeringPlane = config.steeringPlane;
		this._agentDirForLedger = config.agentDir ?? getAgentDir();
		this._semanticPlane = new SessionSemanticPlaneController({
			agentDirForLedger: this._agentDirForLedger,
			isDisposed: () => this._disposed,
			getSessionManager: () => this.sessionManager,
			getSteeringPlane: () => this._steeringPlane,
		});
		this._semanticPlane.bindSemanticObserver(this._steeringPlane);
		this._systemOneController?.setEvaluationObserver(this._semanticPlane.health);
		this._systemOneController?.setAccountPassStore(
			accountPassBindings({
				getLedger: () => this.getDecisionLedger(),
				getSessionId: () => this.sessionManager.getSessionId(),
			}),
		);
		this._adaptiveReadiness = config.adaptiveReadiness;
		this._ownerRules = new DurableOwnerRuleStore({
			agentDir: config.agentDir ?? getAgentDir(),
			projectKey: config.cwd,
		});
		this._cache = new SessionCacheController({
			getSessionManager: () => this.sessionManager,
			getSessionId: () => this.sessionId,
			getCwd: () => this._cwd,
			getMessages: () => this.agent.state.messages,
			getForegroundLineage: () => this._foregroundLineage(),
			setMessages: (messages) => {
				this.agent.state.messages = messages;
			},
			getModel: () => this.model,
			getContextUsage: () => this.getContextUsage(),
			getDecisionLedger: () => this.getDecisionLedger(),
			advancePromptDate: () => this._systemPromptBuilder.advancePromptDate(),
			refreshBaseSystemPrompt: () => this._refreshBaseSystemPrompt(),
			resetSanitizerPrefixHorizon: () => this.agent.resetSanitizerPrefixHorizon(),
			previewWorkerModel: () => this._backgroundLanes.previewWorkerModel(),
			getGoalUserGoal: () => this._goals.getState()?.userGoal,
			executeObjectiveRootRoute: (route, signal) => this._goals.objectiveRootExecutor().execute(route, signal),
			runWorkerDelegationOnce: (request) => this.runWorkerDelegationOnce(request),
			sendNextTurnCustomMessage: (message) => this.sendCustomMessage(message, { deliverAs: "nextTurn" }),
			warn: (message) => this.emitHostWarning(message),
		});
		this._edgeIntent = new SessionEdgeIntentController({
			getSessionManager: () => this.sessionManager,
			getSettingsManager: () => this.settingsManager,
			getModelRegistry: () => this._modelRegistry,
			getCwd: () => this._cwd,
			getAgentDir: () => this._agentDir,
			isChildSession: () => this._isChildSession,
			isDisposed: () => this._disposed,
			getReflectionAbortSignal: () => this._reflectionAbort.signal,
			getSystemOneController: () => this._systemOneController,
			getSemanticDecisionEngine: () => this._semanticDecisionEngine(),
			getDecisionLedger: () => this.getDecisionLedger(),
			getCurrentSubmissionEpoch: () => this._foregroundRecovery.getCurrentSubmissionEpoch(),
			getLastUserRequest: () => this._promptSubmission?.lastUserRequest ?? "",
			getOwnerRulePolicies: () => this._ownerRules.list(),
			getProjectRules: () => this._projectRules,
			getWrittenMutationPaths: () => this._mutationLedger.writtenPaths(this.objectiveMutationId()),
			getAllTools: () => this.getAllTools(),
			getToolSourceInfo: (name) => this._runtimeBuilder.getToolSourceInfo(name),
			getRouterCandidatePool: () => this.getRouterCandidatePool(),
			withTaskDirectoryContext: (fn, signal, onUnavailable) =>
				this._runtimeBuilder.withTaskDirectoryContext(fn, signal, onUnavailable),
			noteSystemOneTaskDirectoryUnavailable: (err) => this._noteSystemOneTaskDirectoryUnavailable(err),
			pushPendingNextTurnMessage: (msg) => this._pendingNextTurnMessages.push(msg),
			setOperatorBlocker: (blocker) => {
				this._operatorBlocker = blocker;
			},
			emitWarning: (msg) => this._emit({ type: "warning", message: msg }),
		});
		this._unsettledLadder = new SessionUnsettledLadderController({
			getSessionManager: () => this.sessionManager,
			getAgentDir: () => this._agentDir,
			isChildSession: () => this._isChildSession,
			isHandoff: () => this._edgeIntent.handoff,
			getLastUserRequest: () => this._promptSubmission?.lastUserRequest ?? "",
			getMessages: () => this.agent.state.messages,
			findLastAssistantMessage: () => this._findLastAssistantMessage(),
			getSystemOneController: () => this._systemOneController,
			resolveExpensiveModel: () => this._modelRouter.resolveExpensiveModel(),
			runIsolatedCompletion: (opts) => this.runIsolatedCompletion(opts),
			settleLatestOwnerPolicy: (signal) => this._edgeIntent.ownerPolicy.settle("latest", signal),
			getGoalStateSnapshot: () => this.getGoalStateSnapshot(),
			getExtensionUIContext: () => this._extensionUIContext,
			getToolArtifactStore: () => this._pipeline.getToolArtifactStore(),
			getSessionImageStore: () => this._getSessionImageStore(),
			sendOwnerItemsMessage: (items, content, lease) =>
				this._sendCustomMessage(
					{ customType: "owner_items", content, display: true, details: { items } },
					undefined,
					lease,
				),
			emitWarning: (message) => this._emit({ type: "warning", message }),
		});
		this._queuedInputPersistence = new QueuedInputPersistenceController({
			getSessionManager: () => this.sessionManager,
			getPendingQueue: () => this._pendingQueue,
			getSessionImageStore: () => this._getSessionImageStore(),
			isDisposed: () => this._disposed,
			isStreaming: () => this.isStreaming,
			judgeOwnerRequest: (text, signal, acceptedOrder) =>
				this._edgeIntent.judgeOwnerRequest(text, signal, acceptedOrder),
			enqueueOwnerWords: (text, acceptedOrder, judgment) =>
				this._edgeIntent.enqueueOwnerWords(text, acceptedOrder, judgment),
			ownerInputs: this._ownerInputs,
			acceptQueuedOwnerWords: (kind, text) => this._promptSubmission.acceptQueuedOwnerWords(kind, text),
			emitQueueUpdate: () => this._emitQueueUpdate(),
			emitWarning: (message) => this._emit({ type: "warning", message }),
		});
		this._operatorProjection = createSessionOperatorProjection({
			sessionManager: config.sessionManager,
			settingsManager: config.settingsManager,
			ownerRules: this._ownerRules,
			getGoalStateSnapshot: () => this.getGoalStateSnapshot(),
			getLaneRecords: () => this._backgroundLanes.getLaneRecords(),
			getActiveVerificationIds: () => this._getActiveVerificationIds(),
			getAdaptationProjection: () => this._adaptationProjection,
			getDeliveryState: () => this._deliveryState,
			getContextUsage: () => this.getContextUsage(),
			getOperatorBlocker: () => this._operatorBlocker,
			getGoalRuntimeSnapshot: (settings) => this.getGoalRuntimeSnapshot(settings),
			getExecutionLoopMode: () => this._executionLoopMode,
			getLastObjectiveRoute: () => this._objectiveExecutionController?.getLastRoute(),
			getSessionWorkState: () => this.getSessionWorkState(),
			getStageSink: () => this._stageSinkForSession(),
		});
		this._workerSupervision = createSessionWorkerSupervision({
			sessionManager: config.sessionManager,
			cwd: config.cwd,
			getSteeringPlane: () => this._steeringPlane,
			systemOneWorkerControl: this.systemOneWorkerControl,
			emit: (event) => this._emit(event),
			getOperatorProjection: () => this._operatorProjection,
			getDecisionLedger: () => this.getDecisionLedger(),
			getTaskRuntimeSnapshot: () => this._backgroundLanes.getTaskRuntimeSnapshot(),
		});
		this._projectRules = createSessionProjectRules({
			cwd: config.cwd,
			resourceLoader: config.resourceLoader,
			ownerRules: this._ownerRules,
			getDecisionEngine: () => this._recordingSemanticEngine(),
			sessionManager: config.sessionManager,
			emit: (event) => this._emit(event),
			getSystemOneController: () => this._systemOneController,
			getOperatorProjection: () => this._operatorProjection,
		});
		// The provider stream chain (perf profile, idle watchdog, machine-wide admission) is built and
		// installed exactly once, here; see session-stream-chain.ts.
		const agentDir = config.agentDir ?? getAgentDir();
		// Perf samples (one per provider stream) are deferred; everything else persists at once.
		const modelAdaptationStore = ModelAdaptationStore.forAgentDir(agentDir, { deferPerfSamples: true });
		this._modelAdaptationStore = modelAdaptationStore;
		const previousResolveRequestReasoning = this.agent.resolveRequestReasoning?.bind(this.agent);
		this.agent.resolveRequestReasoning = (reasoning, request) => {
			const resolvedReasoning = previousResolveRequestReasoning
				? previousResolveRequestReasoning(reasoning, request)
				: reasoning;
			// The lane keeps the reasoning it last sent unless the owner changed it or the change is free; the
			// owner's cost ceiling applies after the gate and always passes. An isolated lane (a worker) reuses
			// this resolver on its own conversation, so its pin is its own, never the foreground's.
			const conversation =
				request.sessionId !== undefined && request.sessionId !== this.sessionId ? request.sessionId : undefined;
			const lane = cacheLaneKey(request.model.api, request.model.provider, request.model.id);
			const held = this._cache.custody.admitReasoning(
				conversation,
				lane,
				resolvedReasoning,
				this.hostTurnReasoning.resolveRequestReasoning(request.model, request.sourceMessages, resolvedReasoning),
				() => this._cache.laneCacheGone(request.model, conversation),
			) as typeof resolvedReasoning;
			this.hostTurnReasoning.noteSent(held);
			const final = this._costGuard.resolveRequestReasoning(request.model, request.context, held, request.maxTokens);
			if (final !== held)
				this._cache.custody.overrideReasoning(conversation, lane, final, "the cost ceiling downgraded the level");
			return final;
		};
		// `this.settingsManager` is assigned below; the chain closes over the config reference because
		// it must be installed before that assignment runs. See session-stream-chain.ts for the order
		// of the wrappers and why admission sits outside the watchdog.
		const providerAdmission = openProviderAdmission(agentDir, config.sessionManager.getSessionId(), config.timers);
		this._providerAdmissionLedger = providerAdmission.ledger;
		this._providerLimitStore = providerAdmission.limits;
		this.agent.streamFn = buildSessionStreamFn({
			baseStreamFn: this.agent.streamFn,
			settingsManager: config.settingsManager,
			sessionManager: config.sessionManager,
			modelAdaptationStore,
			providerAdmissionLedger: providerAdmission.ledger,
			providerLimitStore: providerAdmission.limits,
			// Read lazily per request: the foreground recovery that owns the exhaustions is built after this chain.
			modelExhaustion: (modelRef) => this._foregroundRecovery.modelExhaustion(modelRef),
			agentDir,
			authStorage: config.modelRegistry.authStorage,
			redactSensitiveText: (text, additionalValues) =>
				this._runtimeBuilder.credentialExposureBoundary.redactSensitiveText(text, additionalValues),
			createSensitiveTextRedactor: (additionalValues) => {
				const boundary = this._runtimeBuilder.credentialExposureBoundary;
				return (
					boundary.createSensitiveTextRedactor?.(additionalValues) ??
					((text: string) => boundary.redactSensitiveText(text, additionalValues))
				);
			},
			getSensitiveValues: () => this._runtimeBuilder.credentialExposureBoundary.getSensitiveValues?.() ?? [],
			onWait: (event) => this._emit({ type: "provider_admission_wait", ...event }),
			getRepetitionGuardRepeats: () => this.getCapabilityTierPolicy().repetitionGuardRepeats,
			getStreamIdleOptionsOverride,
		});
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
		// The router pool is separate state from the cycling list: an orchestration profile pins the
		// root model for cycling but never narrows the pool, so a profiled session still routes
		// across the operator's available favorites. An SDK caller that passes a scope
		// without an explicit pool means that scope as the pool.
		this._routerPool = config.routerPool
			? { source: config.routerPool.source, models: config.routerPool.models.map((scoped) => scoped.model) }
			: !config.orchestrationProfile && config.scopedModels
				? { source: "sdk_models", models: config.scopedModels.map((scoped) => scoped.model) }
				: undefined;
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._agentDir = agentDir;
		this._isChildSession = (config.isChildSession ?? process.env.PI_CHILD_SESSION === "1") || isWorkerSession();
		reportGithubOriginPinForSession(this._cwd, this._isChildSession, this.sessionManager);
		this._durableLearningState = this._isChildSession ? undefined : DurableLearningState.forAgentDir(agentDir);
		this._skillVault = new SkillVaultController({
			getSkills: () => skillsForSessionRole(this._resourceLoader.getActiveSkills()),
			getFullSkills: () => skillsForSessionRole(this._resourceLoader.getSkills().skills),
			refreshSkills: () => this._resourceLoader.refreshSkills?.(),
			getSkillDiagnostics: () => this._resourceLoader.getSkills().diagnostics.map((d) => `${d.path}: ${d.message}`),
			getMaxBodyBytes: () =>
				Math.min(
					resolveActiveSkillBodyByteLimit(this.model?.contextWindow),
					this.getCapabilityTierPolicy().skillBodyMaxBytes,
				),
			onSkillUsed: (skill) => {
				if (skill.promoted) this._skillCurator.recordUse(skill.name, Date.now());
			},
			getSessionManager: () => this.sessionManager,
		});
		this._toolProtocol = new ToolProtocolController({
			agent: this.agent,
			agentDir: this._agentDir,
			settingsManager: this.settingsManager,
			getModelRegistry: () => this._modelRegistry,
			adaptationStore: modelAdaptationStore,
			isRawStreamSimple: (fn) => isRawStreamSimpleFn(fn),
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
			isRuntimeDisabled: (runtime) => !this.settingsManager.isLocalRuntimeEnabled(runtime),
		});
		this._localPrefixWarm = new LocalPrefixWarmController({
			getStreamFn: () => this.agent.streamFn,
			getTools: () => this.agent.state.tools,
			getSystemPrompt: () => this._baseSystemPrompt,
			getRequestHooks: () => ({ onPayload: this.agent.onPayload, onResponse: this.agent.onResponse }),
			isRawStreamSimple: (streamFn) => isRawStreamSimpleFn(streamFn),
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
		this.hostTurnReasoning = new HostTurnReasoningController(() => this.settingsManager.getCheapTurnSettings());
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
			isHandoff: () => this._edgeIntent.handoff,
			isDisposed: () => this._disposed,
			isStreaming: () => this.isStreaming,
			getModel: () => this.model,
			getArtifactStore: () => this._getToolArtifactStore(),
			getImageStore: () => this._getSessionImageStore(),
			runAgentPrompt: (messages) => this._foregroundRecovery.runAgentPrompt(messages),
			recordObjectiveClarification: (objectiveId, event) => {
				recordObjectiveClarification(
					{
						getGoalState: () => this.getGoalStateSnapshot(),
						saveGoalState: (state, expected) => {
							this.saveGoalStateSnapshot(state, expected);
						},
					},
					objectiveId,
					event,
				);
			},
			recordOwnerFollowUp: (request, reason) =>
				appendOwnerFollowUp(ownerFollowUpPath(this._agentDir, this.sessionManager.getSessionId()), {
					question: formatClarificationQuestion(request.questions),
					reason,
					request: this._promptSubmission?.lastUserRequest ?? "",
					at: new Date().toISOString(),
				}),
		});
		this._goals = new GoalSessionController({
			getSessionManager: () => this.sessionManager,
			getModelProvider: () => this.model?.provider,
			getLaneRecords: () => this._backgroundLanes.getLaneRecords(),
			getTaskRuntimeSnapshot: () => this._backgroundLanes.getTaskRuntimeSnapshot(),
			getBackgroundToolTasks: () => this._backgroundToolTasks.list(),
			synchronizeGoalState: (state) => {
				// Owner items a paused goal held are posted when it leaves the pause; this never throws.
				this._unsettledLadder.noteGoalState(state);
				this._backgroundLanes.synchronizeGoalState(state);
			},
			scheduleGoalAutoContinueFromIdle: () => this._backgroundLanes.scheduleGoalAutoContinueFromIdle(),
			prompt: (text, options) => this.prompt(text, options),
			getForegroundSubmissionEpoch: () => this._foregroundRecovery.getCurrentSubmissionEpoch(),
			emitWarning: (message) => this._emit({ type: "warning", message }),
			resolveCompletionRejection: (input) => this._resolveGoalCompletionOwnerDecision(input),
			getExecutionLoopMode: () => this._executionLoopMode,
			getObjectiveExecutionController: () => this._objectiveExecutionController,
		});
		this._pendingQueue = new PendingInputQueueController({
			agent: this.agent,
			skillVault: this._skillVault,
			goals: this._goals,
			getExtensionRunner: () => this._extensionRunner,
			getPromptTemplates: () => this.promptTemplates,
			noteOwnerAuthoredMessage: (message, originalText) => this._reflection.markOwnerInput(message, originalText),
			getInputContext: () => ({
				sessionId: this.sessionManager.getSessionId(),
				branchGeneration: this._branchGeneration,
			}),
			// Navigation is the only owner that changes the branch an input was written against.
			isInputContextCurrent: (context) =>
				context.sessionId === this.sessionManager.getSessionId() &&
				context.branchGeneration === this._branchGeneration,
			onInputHeld: (input, reason) => this._queuedInputPersistence.noteHeldQueuedInput(input.text, reason),
			onInputCancelled: (input) => this._queuedInputPersistence.noteCancelledQueuedInput(input.text),
			record: this._queuedInputPersistence,
			ownerInputs: this._ownerInputs,
			onUndeliveredEchoWithdrawn: (message) => this._emit({ type: "user_message_withdrawn", message }),
		});
		// A queued message that asked for a goal starts it when it is delivered (its user entry persisted), never when a run
		// only read it: a message a routed turn dropped unpersisted starts nothing.
		this._ownerInputs.onDelivered(({ message }) =>
			this._goals.activateQueuedOwnerChatGoal(message, this.agent.state.messages),
		);
		this._queuedInputPersistence.restoreRecordedQueuedInput();
		this._backgroundLanes = new BackgroundLaneController({
			isDisposed: () => this._disposed,
			isChildSession: () => this._isChildSession,
			getSessionId: () => this.sessionId,
			getCwd: () => this._cwd,
			getAgentDir: () => this._agentDir,
			getSessionManager: () => this.sessionManager,
			getSettingsManager: () => this.settingsManager,
			getWorktreeSyncEnginePorts: () => this._worktreeSyncEnginePorts,
			getTimers: () => config.timers,
			getResourceLoader: () => this._resourceLoader,
			getActiveOrchestrationProfile: () => config.orchestrationProfile,
			getModelRegistry: () => this._modelRegistry,
			getCredentialExposureBoundary: () => this._runtimeBuilder.credentialExposureBoundary,
			// Workers pick only models that can take work: quota left and offered to the owner's account.
			isModelExhausted: (model) => this._isModelUnusable(model),
			modelUnusableCause: (model) => this._modelUnusableCause(model),
			getModel: () => this.model ?? undefined,
			getForegroundThinkingLevel: () => this.thinkingLevel,
			getRouteChoiceJudge: () => this._systemOneController,
			getForegroundToolNames: () => this.getActiveToolNames(),
			isDelegateToolActive: () => this.getActiveToolNames().includes("delegate"),
			// Live worker supervision: one observation per executed worker tool call, applied through
			// the root's existing worker-agent control surface.
			observeWorkerProgress: (observation, signal) => this._workerSupervision.observe(observation, signal),
			// Worker lanes pass the same cache guard; each worker conversation is its own lane.
			observeWorkerRequest: (agentId, snapshot, prefixTokens) => {
				this._cache.guardSurface(snapshot, `${this.sessionId}/worker:${agentId}`);
				if (prefixTokens === undefined) return;
				try {
					this.getDecisionLedger()?.recordWorkerPrefix({
						sessionId: `${this.sessionId}/worker:${agentId}`,
						lane: cacheLaneKey(snapshot.api, snapshot.provider, snapshot.modelId),
						observedAt: Date.now(),
						prefixTokens,
					});
				} catch {
					// Telemetry only.
				}
			},
			observeWorkerResponse: (message, observation) => this._cache.recordObservation(message, observation),
			getSharedLaneToolOptions: () => this._runtimeBuilder.getSharedLaneToolOptions(),
			admitWorkerEarlyCompaction: ({ agentId, model, contextTokens, messages }) =>
				this._cache.admitWorkerEarlyCompaction(agentId, model, contextTokens, messages),
			recordWorkerCompactionOutcome: ({ agentId, model, tokensBefore, tokensAfter, outputTokens }) => {
				// A compaction replaced the worker's history: its next request's break is sanctioned, as root's is.
				this._cache.custody.sanction("compaction", "a worker compaction replaced its history", {
					conversation: `${this.sessionId}/worker:${agentId}`,
				});
				try {
					this.getDecisionLedger()?.recordCompactionOutcome({
						sessionId: `${this.sessionId}/worker:${agentId}`,
						lane: cacheLaneKey(model.api, model.provider, model.id),
						observedAt: Date.now(),
						tokensBefore,
						tokensAfter,
						outputTokens,
					});
				} catch {
					// Telemetry only.
				}
			},
			// A worker learns tool choice on its own model into the same evidence store root learns in.
			createWorkerToolSelection: (model, tools) => {
				const modelRef = formatModelRouterModel(model);
				const selection = new ToolSelectionController({
					store: this._toolPerformanceStore,
					getModelRef: () => modelRef,
					getActiveTools: () =>
						tools.map((tool) => ({
							name: tool.name,
							description: tool.description,
							parameters: tool.parameters,
						})),
				});
				return {
					hints: () => formatToolSelectionHints(selection.getActiveHints()),
					begin: (toolCallId, toolName, args) => {
						selection.begin(toolCallId, toolName, args, { modelRef });
					},
					complete: (toolCallId, succeeded, content) => selection.complete(toolCallId, succeeded, content),
					discard: (toolCallId) => selection.discard(toolCallId),
				};
			},
			markModelExhausted: (model, retryAfterMs) =>
				this._foregroundRecovery.markModelExhausted(`${model.provider}/${model.id}`, retryAfterMs),
			// Worker conversations plan with root's own request-context controller, on their own lane: the
			// mechanics every agent needs, none of the head-only steps.
			planWorkerRequest: ({
				agentId,
				model,
				compactionTriggerTokens,
				messages,
				sentPrefixCount,
				toolNames,
				signal,
			}) => {
				const lane = {
					model,
					compactionTriggerTokens,
					custody: {
						conversation: `${this.sessionId}/worker:${agentId}`,
						lane: cacheLaneKey(model.api, model.provider, model.id),
					},
					conversation: `worker:${agentId}`,
				};
				let policyLane = this._workerContextPolicyLanes.get(agentId);
				if (!policyLane) {
					policyLane = { memo: new Map(), memoMessages: [], toolNames };
					this._workerContextPolicyLanes.set(agentId, policyLane);
				}
				policyLane.toolNames = toolNames;
				const contextPolicy = policyLane;
				return new ProviderRequestContextController({
					runContextAudit: (history) => this._pipeline.runContextAudit(history, contextPolicy),
					runPromptPolicyPlanning: (report) => this._pipeline.runPromptPolicyPlanning(report, contextPolicy),
					previewContextProjection: (history) => this._pipeline.previewContextProjection(history, contextPolicy),
					commitContextProjection: (projection) =>
						this._pipeline.commitContextProjection(projection, contextPolicy),
					runPromptEnforcement: (history, report, sourceMessages, frozenBelow, gcReport) =>
						this._pipeline.runPromptEnforcement(history, report, contextPolicy, {
							sourceMessages,
							frozenBelow,
							gcReport,
						}),
					applyContextGc: (history, writePayloads, frozenBelow) =>
						this._pipeline.applyContextGc(history, writePayloads, frozenBelow, lane),
					applyPathAliases: (history) => this._pipeline.applyPathAliases(history),
					getEdgeGrants: () => this.getEdgeGrants(),
				}).plan(messages, sentPrefixCount, signal);
			},
			isGoalToolActive: () => hasGoalContinuationControl(this.getActiveToolNames()),
			getEdgeGrants: () => this.getEdgeGrants(),
			settleOwnerPolicy: () => this._edgeIntent.ownerPolicy.settle("latest"),
			checkOperation: (tool, args, cwd) => this._edgeIntent.operationGate.check(tool, args, cwd, "worker"),
			localCommitBranch: () => this._edgeIntent.localCommitBranch(),
			getCapabilityEnvelope: () => this.capabilityEnvelope,
			getModelCapabilityProfile: () => this.getModelCapabilityProfile(),
			emit: (event) => this._emit(event),
			notifyWorkerTerminalHandoff: (records) => {
				for (const record of records) {
					this.reportOutboxWorkerTerminal(record);
				}
				return this._terminalHandoffs.notifyWorkers(records);
			},
			emitAutonomyTelemetry: (event) => this._emitAutonomyTelemetry(event),
			getGoalStateSnapshot: () => this.getGoalStateSnapshot(),
			getCurrentSubmissionEpoch: () => this._foregroundRecovery.getCurrentSubmissionEpoch(),
			getContinuousChatBirthView: () => this._memory.continuousChatHost()?.birthView(),
			getGoalRuntimeSnapshot: (settings) => this.getGoalRuntimeSnapshot(settings),
			markGoalToolUnavailable: () => this._goals.markToolUnavailable(),
			getEvidenceBundleSnapshot: () => this.getEvidenceBundleSnapshot(),
			saveEvidenceBundleSnapshot: (bundle) => this.saveEvidenceBundleSnapshot(bundle),
			saveWorkerClaimSnapshot: (claim, request, options) => this.saveWorkerClaimSnapshot(claim, request, options),
			reportWorkerTerminal: (handoff) => this.reportWorkerTerminal(handoff),
			recordUnsettledForOwner: (items) => this._deliverToOwner(items),
			notifyWorktreeLane: (text) => this._steerSessionNotice("worktree-sync-notice", text),
			notifyParentSession: (customType, text) => this._steerSessionNotice(customType, text),
			createLaneMemoryBroker: (capacity) => this._memory.createLaneMemoryBroker(capacity),
			getHandoffPersonaGuidance: () => this._memory.getHandoffPersonaGuidance(),
			getContextGcStoreDir: () => this._pipeline.contextGcStorageDir(),
			getArtifactStore: () => this._getToolArtifactStore(),
			// An in-process worker holds no effect grant: skills that declare one are neither listed nor readable.
			getSkillReadBroker: () => ({
				search: (query) => {
					const result = this._skillVault.search(query);
					const withheld = this._effectfulSkillNames();
					return { ...result, candidates: result.candidates.filter((candidate) => !withheld.has(candidate.name)) };
				},
				read: (name) =>
					this._effectfulSkillNames().has(name)
						? { ok: false, reason: "not_found", message: `No eligible skill named ${JSON.stringify(name)}.` }
						: this._skillVault.read(name),
			}),
			getSkillAuditSource: () => ({
				getSkills: () => workerEligibleSkills(this._skillVault.getSkillsSnapshot()),
				redactPath: (path: string) => `skill:${createHash("sha256").update(path).digest("hex").slice(0, 12)}`,
			}),
			addSpawnedUsage: (usage, opts) => this.addSpawnedUsage(usage, opts),
			runIsolatedCompletion: (opts) => this.runIsolatedCompletion(opts),
			// RAW loop, deliberately bypassing the public `continueGoalLoop` — that method now delegates
			// to this controller's own `continueGoalLoopExclusive` guard, so routing through it here would
			// recurse into the guard from inside itself instead of driving the actual continuation pass.
			continueGoalLoop: (options) => this._goals.continueLoop(options),
			// A running worker or background tool is the fact the goal loop reports as waiting.
			// Waiting for that occupancy here never observes it: the caller is what would release it.
			isForegroundBusy: () => this._isForegroundPhaseBusy(),
			waitForForegroundIdle: () => this._foregroundRecovery.waitForIdle(),
			collectWorkspaceSources: (args) => this._collectWorkspaceSources(args),
			getPathAliasTable: () => this._pipeline.peekPathAliasTable(),
			reviewNewCode: ({ toolName, args, cwd }) => this._unsettledLadder.codeDuplicates.review(toolName, args, cwd),
			reviewWorkerReport: async (input) => {
				const blockers = await this._unsettledLadder.answerClaims.workerReportBlockers(input);
				// An accepted report's receipts back the root's claims for the rest of the work unit.
				if (blockers.length === 0) {
					this.sessionManager.appendCustomEntry(
						WORKER_RECEIPTS_CUSTOM_TYPE,
						collectWorkerReportClaimReceipts(input),
					);
				}
				return blockers;
			},
			settleInconclusive: (input) => this._settleWorkerInconclusive(input),
			isModelAllowed: (model) =>
				this._edgeIntent.modelPolicy.allows(model) &&
				(!this.settingsManager.getModelRouterSettings().enabled ||
					isModelInRouterPool(this.getRouterCandidatePool(), model)),
			// Allocated from the policy-filtered pool, the same way a routed turn picks.
			allocateAllowedModel: () =>
				this._modelRouter.selectAutoTierModel("medium").chosen?.model ??
				this._modelRouter.selectAutoTierModel("expensive").chosen?.model ??
				this._modelRouter.selectAutoTierModel("cheap").chosen?.model,
			recordObjectiveMutation: (event) => {
				const objectiveId = this.objectiveMutationId();
				if (event.kind === "shell") this._mutationLedger.markShellUnsafe(objectiveId);
				else if (event.path) this._mutationLedger.recordOwnedWrite(objectiveId, event.cwd, event.path);
			},
			repositoryObserver: this._repositoryObserver,
			getSessionCwd: () => this._cwd,
			getObjectiveId: () => this.objectiveMutationId(),
		});
		const historyModels = new LaneModelResolver({
			getCwd: () => this._cwd,
			getModel: () => this.model ?? undefined,
			getModelRegistry: () => this._modelRegistry,
			getSettingsManager: () => this.settingsManager,
			isModelExhausted: (model) => this._isModelUnusable(model),
		});
		this._memory = new MemoryController({
			acquireSystemSwitchLease: (scope) => {
				if (
					this._disposed ||
					this._isChildSession ||
					this.isRetrying ||
					this._reflectionTurnLifecycle.inFlight ||
					!isSessionSettled(this, this._hasPendingIdleContinuation()) ||
					// Queued next-turn messages wait for a prompt, and a prompt runs under the lease. Only a switch waits on
					// them: a recovery holds the lease while it rebuilds, so no prompt can drain them mid-rebuild.
					(scope === "switch" && this._pendingNextTurnMessages.length > 0) ||
					this._backgroundLanes
						.getLaneRecords()
						.some((lane) => lane.status === "queued" || lane.status === "running") ||
					hasRunningBackgroundedToolCall(this._backgroundToolTasks.list())
				)
					return undefined;
				const lease = this._foregroundRecovery.tryAcquireSubmission();
				return lease ? () => this._foregroundRecovery.releaseSubmission(lease) : undefined;
			},
			subscribeSystemSwitchLeaseAvailability: (listener) => this._subscribeSystemSwitchAvailability(listener),
			getSettingsManager: () => this.settingsManager,
			getTurnIndex: () => this._turnIndex,
			getAgentDir: () => this._agentDir,
			getCwd: () => this._cwd,
			getSessionId: () => this.sessionManager.getSessionId(),
			getSessionFile: () => this.sessionManager.getSessionFile(),
			isChildSession: () => this._isChildSession,
			refreshToolRegistry: () => this._refreshToolRegistry(),
			getContextWindow: () => this.model?.contextWindow,
			getPromptHeadroom: (messages) =>
				estimatePromptHeadroom({
					model: this.model,
					systemPrompt: this.agent.state.systemPrompt,
					tools: this.agent.state.tools,
					textToolCallProtocol: this.agent.textToolCallProtocol,
					messages,
					compactionReserveTokens: this._getAdaptedCompactionSettings().reserveTokens,
					maxOutputTokens: Math.min(
						this.settingsManager.getMaxOutputTokens(),
						this.getCapabilityTierPolicy().maxOutputTokens,
					),
				}),
			getGoalState: () => this.getGoalStateSnapshot(),
			emitWarning: (message) => this._foregroundLifecycle.warn(message),
			admitUserPreference: (request) => this._reflection.admitUserPreference(request),
			subscribeEntriesPersisted: (listener) => this.sessionManager.onEntriesPersisted(listener),
			// ICM's project chat: each turn projects onto the provider runtime, and its compactions repeat the accepted prefix.
			providerRequest: {
				setPlanProjection: (projection) => this._providerRequestRuntime.setPlanProjection(projection),
			},
			continuousChat: {
				compaction: createContinuousChatCompactionAdapter({
					complete: (options) => this._reflection.runIsolatedCompletion(options),
					prefixHead: () => this._continuousChatPrefixHead(),
					summary: () =>
						validateContinuousChatSummaryModel(readContinuousChatSettings(this.settingsManager), {
							resolveModel: (reference) => historyModels.resolveModel(reference),
						}),
					recordUsage: (usage, call) => this._semanticUsage.recordHistoryUsage(usage, call),
					onModelFailure: (model, errorMessage) => {
						const message = errorMessage ?? "";
						const classified = classifyFailure({ message, provider: model.provider });
						if (classified.reason === "billing_or_quota") {
							this._foregroundRecovery.markModelExhausted(
								`${model.provider}/${model.id}`,
								classified.retryAfterMs,
							);
						} else if (classified.reason === "model_unsupported") {
							this._accountModels.markRefused(model, message || "model not supported");
						}
					},
				}),
				prefixHead: () => this._continuousChatPrefixHead(),
				resetCompactionPrefix: () => this._continuousChatPrefix.reset(),
				resolveWorker: (name) => this._backgroundLanes.openWorkerTranscript(name),
				readEntry: (entryId) => this.sessionManager.getEntry(entryId),
				entryIds: () => this.sessionManager.getEntries().map((entry) => entry.id),
				isEntryPersisted: (entryId) => this.sessionManager.isEntryPersisted(entryId),
			},
			hierarchy: {
				// The configured summary model resolves through the one lane-model boundary: configured and
				// authenticated models only, no second router and no credential client.
				summarizer: {
					resolveModel: (reference) => historyModels.resolveModel(reference),
					runIsolatedCompletion: (opts) => this.runIsolatedCompletion(opts),
					recordHistoryUsage: (usage, call) => this._semanticUsage.recordHistoryUsage(usage, call),
				},
				activeBranch: new ActiveBranchProbe(this.sessionManager),
				// The judge that admits model summaries is the session's one recording System One engine, so its
				// usage reaches the session ledger and its judgments the Jev ledger like every other evaluation.
				getAdmissionEngine: () => this._recordingSemanticEngine(),
				recordUsage: (receipt) => {
					// Admission keeps its receipt until this confirms the identical row; a pending one stays owed.
					const outcome = this._semanticUsage.confirm(receipt);
					if (outcome.kind !== "physically_recorded") throw new Error(outcome.cause);
				},
				time: config.timers.port("history"),
				isForegroundBusy: () => this._foregroundRecovery.isBusy,
				subscribeForegroundActivity: (listener) => this._foregroundRecovery.subscribeActivity(listener),
			},
		});
		this._compactionSupport = new CompactionSupport({
			getModel: () => this.model,
			getSettingsManager: () => this.settingsManager,
			getModelRegistry: () => this._modelRegistry,
			isRawStream: () => isRawStreamSimpleFn(this.agent.streamFn),
			getRequiredRequestAuth: (model) => this._getRequiredRequestAuth(model),
			isModelExhausted: (ref) => {
				const [provider, ...id] = ref.split("/");
				const model = provider ? this._modelRegistry.find(provider, id.join("/")) : undefined;
				return model ? this._isModelUnusable(model) : this._foregroundRecovery.isModelExhausted(ref);
			},
			getStoredFitnessReport: (ref) => this.getStoredFitnessReports().find((entry) => entry.model === ref)?.report,
			// Live context (under ICM, the running turn's own messages) is an over-estimate of the span to
			// summarize (includes the kept tail) — conservative in the safe direction for the summarizer capacity check.
			estimateSummarizationInputTokens: () => this._compaction.estimateSummarizationInputTokens(),
			emitWarning: (message) => this._emit({ type: "warning", message }),
			// Route a managed-local summarizer through the same readiness/residency gate every
			// other isolated consumer uses, so compact() never calls a local model that was never
			// confirmed up, installed, or resident (no-op for cloud models).
			ensureModelReady: (model) => this._localRuntimeController.ensureIsolatedModelReady(model),
		});
		this._pipeline = new ContextPipeline({
			getTurnIndex: () => this._turnIndex,
			isPathAliasingEnabled: () => this.getCapabilityTierPolicy().pathAliasing,
			getSessionManager: () => this.sessionManager,
			getSettingsManager: () => this.settingsManager,
			getModelRegistry: () => this._modelRegistry,
			getModel: () => this.model,
			getCompactionTriggerTokens: () => this._hardCompactionTriggerTokens(),
			estimateLineageRemainingRequests: () =>
				this._cache.knowledge.lineage(this.sessionId, this._foregroundLineage(), Date.now()),
			recordCacheDecision: (decision) => this._recordCacheDecision(decision),
			sanctionCacheBreak: (kind, reason, target) => {
				const model = this.model;
				this._cache.custody.sanction(
					kind,
					reason,
					target ?? (model ? { lane: cacheLaneKey(model.api, model.provider, model.id) } : {}),
				);
			},
			getAgentDir: () => this._agentDir,
			getCwd: () => this._cwd,
			getActiveToolNames: () => this.getActiveToolNames(),
			isDisposed: () => this._disposed,
			getMemoryManager: () => this._memory.getMemoryManager(),
			addSpawnedUsage: (usage, opts) => this.addSpawnedUsage(usage, opts),
			runIsolatedCompletion: (opts) => this.runIsolatedCompletion(opts),
		});
		this._backgroundToolTasks = createSessionBackgroundToolTasks({
			timers: config.timers.port("background-tool-task"),
			getSessionManager: () => this.sessionManager,
			getGoalId: () => this._goals.getOwnershipGoalId(),
			getCurrentSubmissionEpoch: () => this._foregroundRecovery.getCurrentSubmissionEpoch(),
			isForegroundWait: (tool, args) => this.getToolDefinition(tool)?.foregroundWait?.(args as never) === true,
			getArtifactStore: () => this._getToolArtifactStore(),
			getMutationScope: () => this.mutationScope,
			getMutationAnnouncer: () => this._shellSessionKey,
			notifyTerminal: (records, wakeParent) => this._terminalHandoffs.notifyTools(records, wakeParent),
			emit: (event) => this._emit(event),
			onRunningTasksChanged: () => this._notifySystemSwitchAvailability(),
			addSpawnedUsage: (usage, opts) => this.addSpawnedUsage(usage, opts),
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
			getContinuousChatWire: () => this._continuousChatWire(),
			getContinuousChatTurn: () => this._memory.continuousChatHost()?.turns.current(),
			commitPendingTurnMessages: () => this._foregroundLifecycle.commitRoutedPromptPrefix(),
			getCompactionModelSetting: () => this.settingsManager.getCompactionModel(),
			getRequestAuth: (model) => this._compactionSupport.getRequestAuth(model),
			resolveModelAndAuth: (compactionModel, sessionModel) =>
				this._compactionSupport.resolveModelAndAuth(compactionModel, sessionModel),
			resolveModel: (sessionModel) => this._compactionSupport.resolveModel(sessionModel),
			getSelectionReason: () => this._compactionSupport.getLastSelectionReason(),
			resolveThinkingLevel: (compactionModel, sessionModel) =>
				this._compactionSupport.resolveThinkingLevel(this.thinkingLevel, compactionModel, sessionModel),
			describeSummarizer: () => this._describeCompactionSummarizer(),
			getExtensionRunner: () => this._extensionRunner,
			isRawStream: () => isRawStreamSimpleFn(this.agent.streamFn),
			disconnectAgent: () => this._disconnectFromAgent(),
			// A compaction that was running when the session closed must not re-attach the internal consumer the closing sequence
			// is releasing (or has released): its own control flow stays live, only the reattachment is fenced at the lifetime.
			reconnectAgent: () => {
				if (!this._disposed) this._reconnectToAgent();
			},
			abortForeground: () => this.abort("compaction"),
			emit: (event) => this._emit(event),
			estimateCurrentContextTokens: (messages) => this._pipeline.estimateCurrentContextTokens(messages),
			buildPreDigest: () => this._buildCompactionPreDigest(),
			getMemoryPreCompressInsight: () => this._memory.onPreCompress(),
			decorateCompactionDetails: (details) => this._decorateCompactionDetails(details),
			getActiveTask: () => {
				const goal = this.getGoalStateSnapshot();
				return goal && isGoalExecutionActive(goal.status) ? goal.userGoal : undefined;
			},
			refreshAfterCompaction: () => this._refreshAfterCompaction(),
			getFailureCorpus: () => this._failureCorpus,
			measureLiveContextTokens: () => this._measureLiveContextTokensForCompaction(),
			runAutoCompaction: (reason, willRetry) => this._runAutoCompaction(reason, willRetry),
			compactWithRetry: (run, signal, provider) => this._compactWithRetry(run, signal, provider),
			onCompactionSettled: () => {
				this._foregroundRecovery?.wakeIdleWaiters();
				if (this._selfCompaction?.state().status === "compacted") this._selfCompaction.schedule();
			},
			// Evidence-preserving compaction runs on the session's own semantic engine. Without one
			// the planner is never consulted and compaction behaves exactly as it did before.
			getRetentionDecisionEngine: () => this._semanticDecisionEngine(),
			getRetentionPins: () => ({
				unresolvedProofObligations: this._getActiveVerificationIds(),
			}),
			// Large elided evidence becomes a referenced context artifact rather than being discarded.
			getRetentionArtifactStore: () => {
				const store = this._getToolArtifactStore();
				if (!store) return undefined;
				return {
					saveArtifact: (name: string, content: string) =>
						store.write({
							kind: "tool_output",
							content,
							toolName: name,
							createdAtTurn: this.sessionManager.getEntries().length,
							reproducible: false,
						}).ref.id,
				};
			},
			persistRetentionAudit: (audit) => {
				this.sessionManager.appendCustomEntry(RETENTION_AUDIT_CUSTOM_TYPE, audit);
				this._operatorProjection.eventBridge.recordCompactionResult(audit.summaryEvent);
			},
			getLastSentRequest: () => this._cache.lastSentRequest,
			getCacheEconomics: (model, now) => {
				const lane = cacheLaneKey(model.api, model.provider, model.id);
				const lastResponseAt = this._cache.knowledge.lastResponseAt(this.sessionId, lane);
				const retained =
					lastResponseAt === undefined
						? undefined
						: this._cache.knowledge.retainedAfter(lane, Math.max(0, now - lastResponseAt), now);
				const lineage = this._cache.knowledge.lineage(this.sessionId, this._foregroundLineage(), now);
				const outcome = this._cache.knowledge.compactionOutcome(lane, now);
				return {
					retainedAt: (gapMs) => this._cache.knowledge.retainedAfter(lane, gapMs, now),
					returnGapsMs: (holder) => this._cache.knowledge.returnGaps(holder, now),
					gapResolutionMs: this._cache.knowledge.gapResolution(lane, now),
					...(retained ? { retained } : {}),
					// Without a lineage that long on record, the lineage's own elapsed requests stand in.
					...(lineage ? { remainingRequests: lineage.remaining ?? lineage.elapsed } : {}),
					...(outcome ? { outcome } : {}),
				};
			},
			recordCacheDecision: (decision) => this._recordCacheDecision(decision),
			recordCompactionOutcome: ({ model, tokensBefore, tokensAfter, outputTokens }) => {
				try {
					this.getDecisionLedger()?.recordCompactionOutcome({
						sessionId: this.sessionId,
						lane: cacheLaneKey(model.api, model.provider, model.id),
						observedAt: Date.now(),
						tokensBefore,
						tokensAfter,
						outputTokens,
					});
				} catch {
					// Telemetry only.
				}
			},
		});
		this._selfCompaction = new SelfCompactionController({
			getSessionManager: () => this.sessionManager,
			getSettings: () => this.settingsManager.getSelfCompactionSettings(),
			getContextUsage: () => this.getContextUsage(),
			getCachedTokens: () => {
				const messages = this.agent.state.messages;
				for (let index = messages.length - 1; index >= 0; index--) {
					const message = messages[index]!;
					if (
						message.role === "assistant" &&
						message.usage &&
						message.stopReason !== "error" &&
						message.stopReason !== "aborted"
					) {
						return message.usage.cacheRead;
					}
				}
				return null;
			},
			getHardTriggerTokens: () => this._hardCompactionTriggerTokens(),
			getEarlyTriggerTokens: () => this._earlyCompactionTriggerTokens(),
			hasCompactableHistory: () => this._compaction.hasCompactableHistory(),
			releasesAtTurnEnd: () => this._isContinuousChatRoot(),
			turnReleaseFloorTokens: () => this._compaction.turnRequestFloorTokens(),
			compact: (customInstructions) => this.compact(customInstructions),
			deliverNote: (message) => this.sendCustomMessage(message, { triggerTurn: true }),
			askForHandoff: (message) => this.sendCustomMessage(message, { triggerTurn: true }),
			continueFromHandoff: () =>
				this._durableCustomMessageTurns.continue(async () => {
					let messages = this.agent.state.messages;
					while (
						messages.at(-1)?.role === "assistant" &&
						(messages.at(-1) as AssistantMessage).stopReason === "error"
					) {
						messages = messages.slice(0, -1);
					}
					if (messages !== this.agent.state.messages) this.agent.state.messages = messages;
				}, this._goals.getOwnershipGoalId()),
			isForegroundBusy: () => this._isForegroundPhaseBusy(),
			waitForForegroundIdle: () => this._foregroundRecovery.waitForIdle(),
			isDisposed: () => this._disposed,
			isAwaitingOwner: () => getResumableHumanInputSnapshot(this.sessionManager)?.status === "pending",
			onHandoffSettled: () => this._scheduleIdleWork(undefined, false),
			warn: (message) => this._emit({ type: "warning", message }),
		});
		const providerRequestContext = new ProviderRequestContextController({
			// A side trip reads its small brief, never the transcript (see ModelRouterController.projectTurnContext).
			transformBase: async (messages) => this._modelRouter.projectTurnContext(messages),
			transformExtensions: this._memory.createContextProjection(() => this._extensionRunner),
			runContextAudit: (messages) => this._runContextAudit(messages),
			runPromptPolicyPlanning: (report) => this._runPromptPolicyPlanning(report),
			previewContextProjection: (messages) => this._pipeline.previewContextProjection(messages),
			commitContextProjection: (projection) => this._pipeline.commitContextProjection(projection),
			runMemoryRetrieval: (messages) => this._memory.runMemoryRetrieval(messages),
			applyContextGc: (messages, writePayloads, frozenBelow) =>
				this._applyContextGc(messages, writePayloads, frozenBelow),
			correlatePromptPolicyWithContextGc: (report) => this._correlatePromptPolicyWithContextGc(report),
			runPromptEnforcement: (messages, report, sourceMessages, frozenBelow, gcReport) =>
				this._runPromptEnforcement(messages, report, sourceMessages, frozenBelow, gcReport),
			enqueueRelevanceCuration: (messages, report) => this._enqueueRelevanceCuration(messages, report),
			maybeDrainBrainCuration: () => this._maybeDrainBrainCuration(),
			appendMemoryEvidence: (messages, report) => this._memory.appendPromptMemory(messages, report),
			previewReflectionCue: () => this._reflection.previewCurrentTurnCue(),
			previewTaskDirectoryContext: () => captureSessionTaskDirectoryContext(this.sessionManager),
			previewTaskAutomationContext: () => this._runtimeBuilder.previewTaskAutomationContext(),
			previewSelfCompactionGuidance: () => ({
				content: this._selfCompaction.guidance(),
				cleared: this._selfCompaction.guidanceClearedText(),
			}),
			getGoalState: () => this.getGoalStateSnapshot(),
			skillVault: this._skillVault,
			getRoutedGoalContext: () => this._goals.getRoutedGoalContext(),
			getEdgeGrants: () => this.getEdgeGrants(),
			applyPathAliases: (messages) => this._pipeline.applyPathAliases(messages),
		});
		this._providerRequestRuntime = new ProviderRequestRuntimeController({
			agent: this.agent,
			compaction: this._compaction,
			context: providerRequestContext,
			admitGoalRequest: () => this._goals.admitProviderRequest(),
			maxOutputTokens: () =>
				Math.min(this.settingsManager.getMaxOutputTokens(), this.getCapabilityTierPolicy().maxOutputTokens),
			shouldStopGoalExecutionAfterTurn: () => this._goals.hasExecutionLeaseCrossedBudgetLimit(),
			shouldStopForRuntimeUpdate: () => this.runtimeUpdates.shouldStopAfterTurn(),
		});
		this.runtimeUpdates = new RuntimeUpdateController({
			sessionManager: this.sessionManager,
			getMessages: () => this.agent.state.messages,
			isRoot: () => !this._isChildSession,
			onStopped: () => this._goals.markTerminalToolFailureBlocked("runtime_update"),
			resume: (prepare) => this._durableCustomMessageTurns.continue(prepare, this._goals.getOwnershipGoalId()),
			reload: async (path) => {
				await (path ? this._runtimeBuilder.reloadExtension(path) : this._runtimeBuilder.reload());
				this._notifyExtensionsChanged();
			},
			appendNotice: (content) =>
				this._sendCustomMessage(
					{ customType: "runtime-update-notice", content, display: true },
					undefined,
					this._promptSubmission.foregroundPromptLease,
				),
		});
		this._toolRecoveryLogger = new ToolRecoveryLogger({
			enabled: toolRepairSettings.logging,
			sessionId: this.sessionManager.getSessionId(),
			eventLogPath: this._toolRecoveryEventLogPath,
			failureCorpusPath,
		});
		this._foregroundRecovery = new ForegroundRecoveryController({
			agent: this.agent,
			timers: config.timers,
			chatTurns: () => this._memory.continuousChatHost()?.turns,
			applyFailoverModel: (failed, hop) => {
				// Same rule as an unsupported model: a routed turn's model stays inside that turn.
				if (this._modelRouter.isRoutedTurnOn(failed))
					return this._modelRouter.replaceRefusedRoutedModel(failed, hop);
				this.agent.state.model = hop;
				this.sessionManager.appendModelChange(hop.provider, hop.id);
				this._moveTalker(hop, `${failed.provider}/${failed.id} out of quota`);
				return hop;
			},
			resolveFallbackModel: (failed) =>
				this._modelRouter.resolveQuotaFallbackModel(failed, {
					hasImages: false,
					contextTokens: this.getContextUsage()?.tokens ?? 0,
				}),
			modelRegistry: this._modelRegistry,
			settingsManager: this.settingsManager,
			failureCorpus: this._failureCorpus,
			getContextWindow: () => this.model?.contextWindow ?? 0,
			exhaustedStoreDir: join(providerAdmissionDir(this._agentDir), "exhausted"),
			emit: (event) => {
				// Retry lifecycle events are persisted before they reach the UI so a retried-and-
				// recovered provider failure leaves a session record a census can count.
				if (event.type === "auto_retry_start" || event.type === "auto_retry_end") {
					this._foregroundLifecycle.recordRetryEvent(event);
				}
				this._emit(event);
			},
			checkCompaction: (message) => this._checkCompaction(message),
			replaceUnsupportedModel: (message) => this._replaceUnsupportedModel(message),
			onUsageLimitReached: (message) => void this._offerSubscriptionReset(message),
			onSuccessfulAssistant: () => this._compaction.resetOverflowRecovery(),
			settleRuntimeUpdate: (signal) => this.runtimeUpdates.settle(signal),
			holdUndeliveredQueue: () => {
				this._pendingQueue.holdUndelivered();
				this._emitQueueUpdate();
			},
			onSubmissionReleased: (lease) => this._goals.endSubmissionExecution(lease.epoch),
			// Compaction rewrites the history a turn runs on, so it occupies the foreground. A tree navigation's rewrite is
			// owned by the controller itself (`beginHistoryRewrite`), which also keeps it exclusive with a running turn.
			isCompacting: () => this._compaction.isRunning(),
			isExtendedBusy: () => {
				return (
					(this._systemOneController?.isEvaluating ?? false) ||
					this._semanticPlane.health.getHealth(true).state === "evaluating"
				);
			},
			hasPendingIdleContinuation: () =>
				!isOwnIdleContinuationAdmission() && this._backgroundLanes.hasPendingIdleContinuation(),
			prepareRun: async () => {
				this.agent.state.systemPrompt = this._systemPromptBuilder.enforceSystemPromptBudget(this.systemPrompt);
				await this._toolProtocol.ensureActiveModelProtocol();
			},
			afterRun: async () => {
				if (!isInterruptedAssistantStopReason(this._findLastAssistantMessage()?.stopReason)) {
					this._selfCompaction.schedule();
				}
				this._toolProtocol.restoreWithheldTools();
				this._flushPendingBashMessages();
				await this._drainQueuedExtensionCommands();
			},
		});
		this._pendingQueue.bindForeground(this._foregroundRecovery);
		const wakeIdleOccupancy = (): void => this._foregroundRecovery.wakeIdleWaiters();
		const unsubscribeSemantic = this._semanticPlane.health.subscribe((record) => {
			// The evaluator answered: owner words a failed settle kept are read again at the next settle.
			if (record.outcome === "ok") this._edgeIntent.ownerPolicy.wake();
			wakeIdleOccupancy();
		});
		const unsubscribeContinuation = this._subscribeIdleContinuationActivity(wakeIdleOccupancy);
		const unsubscribeOwnerAnswers = subscribeHumanInputActivity(this.sessionManager, (activity) => {
			if (activity.phase === "settled") this._selfCompaction.schedule();
		});
		// A queued worker that contended with the foreground model is held until the foreground goes
		// idle. Every foreground turn driver (prompt, custom-message and handoff turns, goal and
		// continuation runs) releases its submission lease when it ends, so that release is the idle
		// event; the end of `prompt()` is only one of the paths that reach it.
		const unsubscribeQueuedWorkers = this._foregroundRecovery.subscribeActivity(() => {
			if (!this._isForegroundPhaseBusy()) this._backgroundLanes.drainQueuedWorkerDelegations();
		});
		this._systemOneController?.setEvaluationIdleListener(wakeIdleOccupancy);
		this._unsubscribeIdleOccupancy = () => {
			unsubscribeSemantic();
			unsubscribeContinuation();
			unsubscribeOwnerAnswers();
			unsubscribeQueuedWorkers();
			this._systemOneController?.setEvaluationIdleListener(undefined);
		};
		this._durableCustomMessageTurns = new DurableCustomMessageTurnController({
			foreground: this._foregroundRecovery,
			goals: this._goals,
			enqueueSteeringMessage: (message) => this.agent.steer(message),
			// Wake turns relay worker results: their answer's claims are checked like any other answer's.
			afterTurn: async (turnOpening, lease) => {
				const correction = await this._claimCorrection(turnOpening);
				if (correction)
					await this._foregroundRecovery.runAgentPrompt(
						createCustomMessage("claim_delivery", correction, true, undefined, new Date().toISOString()),
						lease,
					);
				await this._flushOwnerItems(lease);
			},
		});
		this._terminalHandoffs = new ForegroundTerminalHandoffController({
			foreground: this._foregroundRecovery,
			isDisposed: () => this._disposed,
			getGoalStateSnapshot: () => this.getGoalStateSnapshot(),
			getTaskRuntimeSnapshot: () => this._backgroundLanes.getTaskRuntimeSnapshot(),
			getWorkerClaimSnapshot: (laneId, attemptId) =>
				attemptId === undefined
					? undefined
					: getWorkerClaimSnapshotForAttempt(
							getActiveSessionBranchEntries(this.sessionManager),
							laneId,
							attemptId,
						),
			// Exact attempt only: a record without its attempt has no proof, so it never reads its lane's latest result.
			getWorkerResult: (_laneId, attemptId) =>
				attemptId === undefined ? undefined : this._backgroundLanes.getWorkerAttemptResult(attemptId),
			getWorkerFanoutNote: (laneId) => fanoutNoteForLane(this._backgroundLanes.getWorkerFanoutGroups(), laneId),
			startCustomMessageTurn: (message, lease, goalId) =>
				this._durableCustomMessageTurns.start(message, lease, goalId),
			enqueueCustomMessageTurn: (message) => this._durableCustomMessageTurns.enqueue(message),
			flushOwnerItems: (lease) => this._flushOwnerItems(lease),
			sendCustomMessage: (message, options, lease) => this._sendCustomMessage(message, options, lease),
			warn: (message) => this._emit({ type: "warning", message }),
		});
		this._modelRouter = new ModelRouterController({
			getAgent: () => this.agent,
			getModel: () => this.model ?? undefined,
			getSettingsManager: () => this.settingsManager,
			getSessionManager: () => this.sessionManager,
			appendSessionMessageBatch: (batch) => this._foregroundLifecycle.appendMessageBatch(batch),
			returnUnpersistedInput: (messages) => {
				if (this._pendingQueue.returnUnpersisted(messages)) this._emitQueueUpdate();
			},
			getModelRegistry: () => this._modelRegistry,
			isModelExhausted: (model) => this._foregroundRecovery.isModelExhausted(`${model.provider}/${model.id}`),
			getFailoverStatus: () => this._foregroundRecovery.getFailoverStatus(),
			getAgentDir: () => this._agentDir,
			getReflectionSignal: () => this._reflectionAbort.signal,
			getBaseSystemPrompt: () => this._baseSystemPrompt,
			runAgentPrompt: (messages, signal) =>
				this._foregroundRecovery.runAgentPrompt(messages, this._promptSubmission.foregroundPromptLease, signal),
			runAgentContinuation: (signal) =>
				this._foregroundRecovery.runAgentContinuation(this._promptSubmission.foregroundPromptLease, signal),
			buildSystemPromptForToolNames: (toolNames) => this._buildSystemPromptForToolNames(toolNames),
			refreshCurrentModelFromRegistry: () => this._refreshCurrentModelFromRegistry(),
			runIsolatedCompletion: (opts) => this.runIsolatedCompletion(opts),
			addSpawnedUsage: (usage, opts) => this.addSpawnedUsage(usage, opts),
			emit: (event) => this._emit(event),
			emitAutonomyTelemetry: (event) => this._emitAutonomyTelemetry(event),
			resolveLaneModel: (pattern) => this._backgroundLanes.resolveLaneModel(pattern),
			getToolProbeVerdict: (model) => this._toolProtocol.getToolProbeVerdict(model),
			// Live available favorites, narrowed by any Models configuration, CLI/SDK scope or selector edit.
			getCandidatePool: () => {
				const pool = this.getRouterCandidatePool();
				return { ...pool, models: this._edgeIntent.modelPolicy.allowed(pool.models) };
			},
			isModelAllowed: (model) => this._edgeIntent.modelPolicy.allows(model),
			getAccountModels: () => this._accountModels,
			getRouteJudge: () => this._systemOneController,
			isUsingSubscription: (model) => this._modelRegistry.isUsingSubscription(model),
		});
		this._foregroundLifecycle = new ForegroundLifecycleAdapter(
			this.agent,
			this.sessionManager,
			this._modelRouter,
			() => this.mutationScope,
			() => this._shellSessionKey,
			this._providerLimitStore,
			// Every persisted message, single or batched (a routed turn's flush included), passes here: the one Delivered point.
			(message, entryId) => {
				this._reflection.noteOwnerInputPersisted(message, entryId);
				this._ownerInputs.notePersisted(message, entryId);
			},
			() =>
				this._eventListeners.length > 0 ? (message: string) => this._emit({ type: "warning", message }) : undefined,
			({ requestId, model, context, sourceContext }) => {
				this._cache.lastSentRequest = { model, context, sourceMessages: sourceContext.messages };
				this._continuousChatPrefix.record({ systemPrompt: context.systemPrompt ?? "", tools: context.tools ?? [] });
				// A surface the loop changed on purpose (a safety removal) is mandatory: sanctioned for this request.
				if (sourceContext.surfaceChange) {
					this._cache.custody.sanction("safety_removal", sourceContext.surfaceChange, {
						lane: cacheLaneKey(model.api, model.provider, model.id),
					});
				}
				this._guardCacheSurface();
				this._toolSelection.observeProviderRequest(
					requestId,
					formatModelRouterModel(model),
					context.systemPrompt ?? "",
				);
			},
			(calls, signal) => {
				if (this.settingsManager.getEdgeSettings().mode === "yolo") return undefined;
				// The first tool call starts the owner-words classification, which then runs while the call's
				// arguments finish; the gate is pre-warmed once the grants it reads are known.
				if (this._edgeIntent.ownerPolicy.size === 0)
					return prewarmOperationGate(this._edgeIntent.operationGate, calls, this._cwd, signal);
				void this._edgeIntent.ownerPolicy
					.settle("latest", signal)
					.then(() => prewarmOperationGate(this._edgeIntent.operationGate, calls, this._cwd, signal))
					.catch(() => undefined);
				return undefined;
			},
		);
		this._foregroundLifecycle.start();
		this._reflection = new ReflectionController({
			getModel: () => this.model,
			getAgent: () => this.agent,
			isRawStreamSimple: () => isRawStreamSimpleFn(this.agent.streamFn),
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
		this._reflectionTurnLifecycle = new ReflectionTurnLifecycle({
			prompt: (text, options) => this.prompt(text, options),
			beginDueReflectionTurn: () => this._reflection.beginDueReflectionTurn(),
			endReflectionTurn: () => this._reflection.endReflectionTurn(),
			onTurnSettled: () => this._notifySystemSwitchAvailability(),
			abortAgent: () => this.agent.abort("reflection"),
			getLastAssistantStopReason: () => this._findLastAssistantMessage()?.stopReason,
			hasOpenWork: () => this._hasOpenWork(),
			isDisposed: () => this._disposed,
			warn: (message) => this._emit({ type: "warning", message }),
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
		this._worktreeSyncEnginePorts = config.worktreeSyncEnginePorts;
		this._shellOperations = config.shellOperations;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };
		this._runtimeBuilder = new RuntimeBuilder({
			getAgent: () => this.agent,
			getCwd: () => this._cwd,
			getShellSessionKey: () => this._shellSessionKey,
			getCapabilityTierPolicy: () => this.getCapabilityTierPolicy(),
			getAgentDir: () => this._agentDir,
			getSessionManager: () => this.sessionManager,
			getSemanticUsage: () => this._semanticUsage,
			getSettingsManager: () => this.settingsManager,
			integrationBranch: () => this._edgeIntent.localCommitBranch() || undefined,
			getModelRegistry: () => this._modelRegistry,
			getPeerReviewModels: () => this.getRouterCandidatePool().models,
			isModelExhausted: (model) => this._isModelUnusable(model),
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
			getRuntimeUpdateTool: () => (this._isChildSession ? undefined : this.runtimeUpdates.createTool()),
			getSelfCompactTool: () =>
				this._isChildSession ? undefined : createSelfCompactToolDefinition(() => this._selfCompaction),
			getBaseToolsOverride: () => this._baseToolsOverride,
			getShellOperations: () => this._shellOperations,
			getWorktreeSyncEnginePorts: () => this._worktreeSyncEnginePorts,
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
			getContextGcStoreDir: () => this._pipeline.contextGcStorageDir(),
			getDecisionLedger: () => this.getDecisionLedger(),
			getToolTaskDependencies: () => ({
				list: () => this._backgroundToolTasks.list(),
				cancel: (taskId) => this._backgroundToolTasks.cancel(taskId),
				// An owner steer ends the wait so the model reads it at once instead of after the bound.
				wait: (taskId, signal, timeoutMs) => {
					const report = (event: WaitStatusEvent) => this._emit(event);
					const steer = { mode: "end", wake: ownerSteerWake(this.sessionManager.getSessionId(), report) } as const;
					return this._backgroundToolTasks.wait(taskId, { signal, timeoutMs, steer, report });
				},
			}),
			getSessionImageStore: () => this._getSessionImageStore(),
			getMemoryManager: () => this._memory.getMemoryManager(),
			getMemoryAuditDiagnostics: () => this._memory.getMemoryAuditDiagnostics(),
			getSelfCompactionView: () => this._selfCompaction.view(),
			getContinuousChatAudit: () => this._continuousChatAudit(),
			clearPendingMemoryProviders: () => this._memory.clearPendingProviders(),
			createMemoryReloadSnapshot: () => this._memory.createReloadSnapshot(),
			restoreMemoryReloadSnapshot: (snapshot) => this._memory.restoreReloadSnapshot(snapshot),
			initializeMemory: () => this._memory.initialize(),
			getGoalStateSnapshot: () => this.getGoalStateSnapshot(),
			saveGoalStateSnapshot: (state, expected) => this.saveGoalStateSnapshot(state, expected),
			getActiveVerificationIds: () => this._getActiveVerificationIds(),
			deliverToOwner: (items) => {
				this._deliverToOwner(items);
			},
			getSystemOneController: () => this._systemOneController,
			getSemanticUncertainties: () => (this._isChildSession ? undefined : this.getSemanticUncertainties()),
			getSteeringPlane: () => this._steeringPlane,
			getSemanticDecisionEngine: () => this._semanticDecisionEngine(),
			askQuestionRouting: () => ({
				isHandoff: () => this._edgeIntent.handoff,
				getRequestText: () => this._promptSubmission?.lastUserRequest ?? "",
				consultStrongerModel: (input) => this._consultStrongerModel(input),
				recordOwnerFollowUp: (entry) => {
					const path = appendOwnerFollowUp(ownerFollowUpPath(this._agentDir, this.sessionManager.getSessionId()), {
						...entry,
						at: new Date().toISOString(),
					});
					return path;
				},
			}),
			getAdaptiveReadiness: () => this._adaptiveReadiness,
			grantEdgeFromInstructions: (grant) => this.grantEdge(grant.class, "instructions", grant),
			enforceEdgeOperation: (op, signal) => enforceSessionEdgeOperation(this._edgeDeps(), op, undefined, signal),
			authorizeGoalStartFromTool: (input) => this._goals.authorizeStartFromTool(input),
			getTaskStepsStateSnapshot: () => this.getTaskStepsStateSnapshot(),
			saveTaskStepsStateSnapshot: (state) => this.saveTaskStepsStateSnapshot(state),
			getPipelineRunSnapshot: () => this.getPipelineRunSnapshot(),
			savePipelineRunSnapshot: (run) => this.savePipelineRunSnapshot(run),
			getContextGcReport: (messages) => this.getContextGcReport(messages),
			startWorkerDelegation: (request, signal) => this._backgroundLanes.startWorkerDelegation(request, signal),
			describeWorkerGrant: (laneId) => this._backgroundLanes.describeWorkerGrant(laneId),
			workerAgentControl: this._backgroundLanes,
			getOrchestrationProfileCatalog: () => this._backgroundLanes.getOrchestrationProfileCatalog(),
			getWorkerLaneRecords: () => this._backgroundLanes.getLaneRecords(),
			getTaskRuntimeSnapshot: () => this._backgroundLanes.getTaskRuntimeSnapshot(),
			onWorkerReviewAcknowledged: () => this.recordAcceptedWorkerEvidence(),
			getWorkerClaimSnapshots: () => this.getWorkerClaimSnapshots(),
			getWorkerClaimSnapshot: (taskId, attemptId) =>
				getWorkerClaimSnapshotForAttempt(getActiveSessionBranchEntries(this.sessionManager), taskId, attemptId),
			getWorkerResult: (attemptId) => this._backgroundLanes.getWorkerAttemptResult(attemptId),
			resolveManagedLaneId: (id) => this._backgroundLanes.resolveManagedLaneId(id),
			runWorkerDelegationOnce: (request) => this.runWorkerDelegationOnce(request),
			runModelFitness: (args) => this.runModelFitness(args),
			resolveCurationModelIfFit: () => this._resolveCurationModelIfFit(),
			runIsolatedCompletion: (opts) => this.runIsolatedCompletion(opts),
			addSpawnedUsage: (usage, opts) => this.addSpawnedUsage(usage, opts),
			getLaneWorkerRefusal: (selection) => this.getLaunchedWorkerLaneRefusal(selection),
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
			getHandoffPersonaGuidance: () => this._memory.getHandoffPersonaGuidance(),
			isForegroundBusy: () => this.getSessionWorkState().busy,
			getPendingMessageCount: () => this.deliverablePendingMessageCount,
			isStreaming: () => this.isStreaming,
			isCompacting: () => this.isCompacting,
			getContextUsage: () => this.getContextUsage(),
			compactForExtension: (options) => this.compactForExtension(options),
			reload: () => this.reload(),
			abort: () => this.abort("extension"),
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
		// The usage owner is shared with the reviewer through the session manager. It is bound to this session's
		// warnings only now: warnings raised while it recovered are buffered until the foreground lifecycle exists.
		this._semanticUsage = sessionSemanticUsageOf(this.sessionManager);
		this._semanticUsage.bindDiagnostics((message) => this.emitHostWarning(message));
		this._analytics = new SessionAnalytics({
			getState: () => this.state,
			getMessages: () => this.messages,
			getModel: () => this.model,
			getSessionManager: () => this.sessionManager,
			getPendingSemanticUsage: () => this._semanticUsage.pendingProjection(),
			getSettingsManager: () => this.settingsManager,
			getToolDefinition: (name) => this.getToolDefinition(name),
			getToolRecoveryEventLogPath: () => this._toolRecoveryEventLogPath,
			getAgentDir: () => this._agentDir,
			getContinuousChatTurnStartIndex: (messages) => {
				if (!this._isContinuousChatRoot()) return undefined;
				const turn = this._memory.continuousChatHost()?.turns.current();
				if (turn === undefined) return undefined;
				const start = resolveContinuousChatTurnStart(turn, messages);
				return "error" in start ? undefined : start.index;
			},
		});
		const previousToolArgumentValidation = this.agent.onToolArgumentValidation;
		this.agent.onToolArgumentValidation = (event) => {
			const taggedEvent = this._toolProtocol.tagAdaptationRuleTeaching(event);
			if (taggedEvent.outcome === "repaired" || taggedEvent.outcome === "bounced") {
				this._toolSelection.recordValidation(
					taggedEvent.tool,
					taggedEvent.outcome,
					taggedEvent.provider && taggedEvent.model ? `${taggedEvent.provider}/${taggedEvent.model}` : "unknown",
				);
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
			addSpawnedUsage: (usage, options) => this.addSpawnedUsage(usage, options),
			getModel: () => this.model,
			getExtensionRunner: () => this._extensionRunner,
			getRequiredRequestAuth: (model) => this._getRequiredRequestAuth(model),
			getSettingsManager: () => this.settingsManager,
			getAgent: () => this.agent,
			// The navigation's history rewrite occupies the foreground and excludes a running turn, at the run owner.
			beginHistoryRewrite: () => this._foregroundRecovery.beginHistoryRewrite(),
			onBranchChanged: () => {
				this._branchGeneration++;
				// Owner input accepted on the old branch is held in full, never delivered on the new one.
				this._pendingQueue.reconcileContext();
				this._emitQueueUpdate();
				this._reflection.invalidateCurrentTurnCueStateCache({ releaseActiveClaim: true });
				this._selfCompaction.resetBranchState();
				this._selfCompaction.schedule();
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
			getShellOperations: () => this._shellOperations,
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
		// Write-behind: an observation per tool call is advisory statistics, not worth a durable
		// transaction each (14% of host CPU over 1,500 turns); batches flush on idle, cap, dispose, exit.
		this._toolPerformanceStore = ToolPerformanceStore.forAgentDir(this._agentDir, { writeBehind: {} });
		this._toolSelection = new ToolSelectionController({
			store: this._toolPerformanceStore,
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
				return evaluateToolGate({ toolName, args: {}, cwd: this._cwd, envelope }).outcome === "allow";
			},
		});
		this._toolGate = new ToolGateController({
			settleOwnerPolicy: (signal) => this._edgeIntent.ownerPolicy.settle("latest", signal),
			getExecutionMode: () => this.settingsManager.getEdgeSettings().mode,
			gateSelfCompaction: (toolName, assistantMessage) =>
				this._selfCompaction.gateToolCall(toolName, assistantMessage),
			getMutationScope: () => this.mutationScope,
			getMutationAnnouncer: () => this._shellSessionKey,
			noteMutatingCall: (toolName, assistantMessage) => {
				// The enforced work boundary: the first call that may change the world with no work declared
				// (a goal being worked declares its own unit) opens one unit until the owner speaks again.
				const goal = this._goals.getState();
				const activeGoalId = goal && isGoalExecutionActive(goal.status) ? goal.goalId : undefined;
				if (currentWorkUnit(this.sessionManager, activeGoalId)) return;
				const assistantMessageEntryId = this._foregroundLifecycle.getPersistedMessageEntryId(assistantMessage);
				if (!assistantMessageEntryId) {
					throw new Error("Cannot open a work unit before its mutating assistant message is persisted.");
				}
				openWorkUnit(
					this.sessionManager,
					{ kind: "enforced", reason: `first mutating call: ${toolName}` },
					assistantMessageEntryId,
				);
			},
			maybeEscalateToolCall: (toolName, args) => this._modelRouter.maybeEscalateToolCall(toolName, args),
			isToolReadOnly: (toolName) => this.agent.state.tools.find((tool) => tool.name === toolName)?.readOnly,
			getCwd: () => this._cwd,
			getCapabilityEnvelope: () => this.capabilityEnvelope,
			recordGateOutcome: (outcome) => this._recordGateOutcome(outcome),
			getExtensionRunner: () => this._extensionRunner,
			checkToolApplicability: (toolName, args) => {
				const source = this._runtimeBuilder.getToolSourceInfo(toolName);
				const aliases = optionalToolRequestAliases(toolName, source, () => {
					const verification = this.runtimeUpdates.getExtensionVerificationTarget();
					return verification
						? { toolName: verification.toolName, path: resolve(this._cwd, verification.extensionPath) }
						: undefined;
				});
				return aliases
					? enforceExplicitOptionalToolRequest({
							toolName,
							sourcePath: source?.path ?? "",
							intent: readOptionalToolIntent(
								this.sessionManager.getLatestCustomEntryOnBranch(OPTIONAL_TOOL_INTENT_CUSTOM_TYPE)?.data,
							),
							args,
						})
					: undefined;
			},
			getToolSelectionController: () => this._toolSelection,
			checkEdge: (tool, args, cwd, signal) => enforceSessionEdge(this._edgeDeps(), tool, args, cwd, signal),
			checkOperation: (tool, args, cwd, signal) =>
				this._edgeIntent.operationGate.check(tool, args, cwd ?? this._cwd, "root", signal),
			localCommitBranch: () => this._edgeIntent.localCommitBranch(),
			// An admitted outward-facing operation (publish to a remote or a registry) is the delivery
			// step the projection reports as DELIVER until that call ends.
			noteEdgeOperations: (toolCallId, classes) => {
				if (!classes.some((edgeClass) => edgeClass === "git.publish" || edgeClass === "package.publish")) return;
				this._deliveryToolCalls.add(toolCallId);
				this.setDeliveryState("in_progress");
			},
			checkDirectScriptExecution: (toolName, args, cwd) =>
				this._runtimeBuilder.checkDirectScriptExecution(toolName, args, cwd),
			checkExternalAcquisition: (toolName, args, signal) =>
				screenAcquisition(
					{
						getGate: () => this._acquisitionGate,
						getObjectiveId: () => this._executionCharter?.objective_id ?? this.sessionManager.getSessionId(),
						getRequest: () => this._promptSubmission?.lastUserRequest ?? "",
						onDecision: (decision) => {
							if (!decision.summaryEvent) return;
							this._emit({ type: "warning", message: decision.summaryEvent });
							this._operatorProjection.eventBridge.recordAcquisitionEvent(
								decision.denied ? "deny" : "rewrite_safe_route",
								decision.summaryEvent,
							);
						},
					},
					toolName,
					args,
					signal,
				),
			getSystemOneController: () => this._systemOneController,
			reviewNewCode: ({ toolName, args, cwd }) => this._unsettledLadder.codeDuplicates.review(toolName, args, cwd),
			reviewPlan: ({ toolName, args }) => this._reviewPublishedPlan(toolName, args),
			validateMutationAcceptance: async ({ changedFiles }) => {
				if (this._edgeIntent.ruleAuthority === "user") return { blocked: false };
				const result = await this._projectRules.validateMutation(
					{ changedFiles },
					{ record: this._edgeIntent.ruleAuthority !== "ask" },
				);
				if (!SessionProjectRules.blocks(result)) return { blocked: false };
				if (this._edgeIntent.ruleAuthority === "ask") {
					return { blocked: true, explanation: RULE_CONFLICT_NOTE };
				}
				return {
					blocked: true,
					explanation: result.violations[0]?.explanation,
					repairId: result.repairWork?.repair_id,
				};
			},
			noteOwnedWrites: (paths, cwd) => {
				const objectiveId = this.objectiveMutationId();
				for (const filePath of paths) this._mutationLedger.recordOwnedWrite(objectiveId, cwd, filePath);
			},
			noteShellMutation: () => {
				this._mutationLedger.markShellUnsafe(this.objectiveMutationId());
			},
			repositoryObserver: this._repositoryObserver,
			getObjectiveId: () => this.objectiveMutationId(),
			deliveryActive: () =>
				Boolean(
					this._executionCharter?.git.commit ||
						this._executionCharter?.git.push ||
						this._executionCharter?.git.create_tag,
				),
			hostRepositoryEffect: (toolName) => this._runtimeBuilder.getToolDefinition(toolName)?.repositoryEffect,
		});
		this._promptSubmission = new PromptSubmissionController({
			agent: this.agent,
			sessionManager: this.sessionManager,
			pendingQueue: this._pendingQueue,
			ownerInputs: this._ownerInputs,
			compaction: this._compaction,
			ownerRules: this._ownerRules,
			backgroundLanes: this._backgroundLanes,
			reflectionTurnLifecycle: this._reflectionTurnLifecycle,
			foregroundRecovery: this._foregroundRecovery,
			toolProtocol: this._toolProtocol,
			localPrefixWarm: this._localPrefixWarm,
			goals: this._goals,
			costGuard: this._costGuard,
			reflection: this._reflection,
			earlyDisplayedUserMessages: this._earlyDisplayedUserMessages,
			ownerPolicy: this._edgeIntent.ownerPolicy,
			enqueueOwnerWords: (text, acceptedOrder, judgment, signal) =>
				this._edgeIntent.enqueueOwnerWords(text, acceptedOrder, judgment, signal),
			registerOwnerWords: (acceptedOrder, text) => this._edgeIntent.registerOwnerWords(acceptedOrder, text),
			releaseOwnerWords: (acceptedOrder) => this._edgeIntent.releaseOwnerWords(acceptedOrder),
			accountModels: this._accountModels,
			custody: this._cache.custody,
			localRuntimeController: this._localRuntimeController,
			modelRegistry: this._modelRegistry,
			memory: this._memory,
			pendingNextTurnMessages: this._pendingNextTurnMessages,
			systemPromptBuilder: this._systemPromptBuilder,
			runtimeBuilder: this._runtimeBuilder,
			modelRouter: this._modelRouter,
			sessionSettlementState: this,
			getExtensionRunner: () => this._extensionRunner,
			getBaseSystemPrompt: () => this._baseSystemPrompt,
			getSessionWorkState: () => this.getSessionWorkState(),
			emitQueueUpdate: () => this._emitQueueUpdate(),
			judgeQueuedOwnerRequest: (request, signal, acceptedOrder) =>
				this._edgeIntent.judgeOwnerRequest(request, signal, acceptedOrder),
			getOperatorBlocker: () => this._operatorBlocker,
			setOperatorBlocker: (blocker) => {
				this._operatorBlocker = blocker;
			},
			holdUndeliveredQueue: () => {
				this._pendingQueue.holdUndelivered();
				this._emitQueueUpdate();
			},
			isStreaming: () => this.isStreaming,
			getPromptTemplates: () => this.promptTemplates,
			isDisposed: () => this._disposed,
			getAdaptiveReadiness: () => this._adaptiveReadiness,
			flushPendingBashMessages: () => this._flushPendingBashMessages(),
			emit: (event) => this._emit(event),
			leaveUnavailableSessionModel: () => this._leaveUnavailableSessionModel(),
			getContextUsage: () => this.getContextUsage(),
			sideTripApproves: (model, text) => this._sideTripApproves(model, text),
			ensureRouteModelReady: (routeInfo) => this._ensureRouteModelReady(routeInfo),
			adoptTalker: (model, decision) => this._adoptTalker(model, decision),
			getModel: () => this.model,
			checkContextWindowUsageWarning: () => this._checkContextWindowUsageWarning(),
			findLastAssistantMessage: () => this._findLastAssistantMessage(),
			checkCompaction: (lastAssistant, continueAfter) => this._checkCompaction(lastAssistant, continueAfter),
			getTaskStepsStateSnapshot: () => this.getTaskStepsStateSnapshot(),
			getMemorySystem: () => this.settingsManager.getMemorySystem(),
			getAgentDir: () => this._agentDir,
			getCwd: () => this._cwd,
			getPipelineRunSnapshot: () => this.getPipelineRunSnapshot(),
			isSystemPromptCold: (routedTurnModel) => this._cache.isSystemPromptCold(routedTurnModel),
			atColdMoment: (reason) => this._cache.atColdMoment(reason),
			noteSystemOneTaskDirectoryUnavailable: (error) => this._noteSystemOneTaskDirectoryUnavailable(error),
			getSystemOneController: () => this._systemOneController,
			enableCapabilitiesAuthorizedByUser: (userRequest, signal, trustedOwner, acceptedOrder) =>
				this._enableCapabilitiesAuthorizedByUser(userRequest, signal, trustedOwner, acceptedOrder),
			announceOwnerFollowUpsWhenPresent: () => this._announceOwnerFollowUpsWhenPresent(),
			runToolkitHit: (scriptName, messages, signal) => this._runToolkitHit(scriptName, messages, signal),
			claimCorrection: (turnOpening) => this._claimCorrection(turnOpening),
			flushOwnerItems: (lease) => this._flushOwnerItems(lease),
			scheduleIdleWork: (options, afterPrompt) => this._scheduleIdleWork(options, afterPrompt),
			hasPendingIdleContinuation: () => this._backgroundLanes.hasPendingIdleContinuation(),
			checkOrphanedObjectiveWatchdog: () => this.checkOrphanedObjectiveWatchdog(),
		});

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._providerRequestRuntime.install();
		this._providerRequestRuntime.installTurnRefresh(
			() => this._createAgentContextSnapshot(),
			() => this._terminalHandoffs.flushProviderBoundary(),
		);

		this._runtimeBuilder.buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
		this._unsubscribeSettingsChanges = this.settingsManager.subscribeChanges(() => {
			this._compaction.reconcileIdlePreparationSettings();
			this._refreshBaseSystemPrompt();
		});
		this._localPrefixWarm.schedule(this.agent.state.model);
	}

	/** The session's canonical host-only credential source and redactor. */
	get credentialExposureBoundary(): RuntimeBuilder["credentialExposureBoundary"] {
		return this._runtimeBuilder.credentialExposureBoundary;
	}

	/** Reconcile both session-owned model views after an interactive credential change. */
	async refreshModelsAfterAuthChange(provider: string): Promise<void> {
		this._modelRegistry.refresh();
		await this._accountModels.refreshAfterAuthChange(provider);
	}

	/** System One semantic control plane controller, if active for this session. */
	get systemOneController(): SystemOneController | undefined {
		return this._systemOneController;
	}

	/** Execution loop mode for this session. */
	get executionLoopMode(): ExecutionLoopMode | undefined {
		return this._executionLoopMode;
	}

	/** Objective execution controller, if active for this session. */
	get objectiveExecutionController(): ObjectiveExecutionController | undefined {
		return this._objectiveExecutionController;
	}

	/** Operator or trusted plugin registration. Repository scripts are not adapters. */
	registerTrustedDeployAdapter(adapter: TrustedDeployAdapter): void {
		this._deployAdapters.register(adapter);
	}

	private objectiveMutationId(): string {
		return this._executionCharter?.objective_id ?? this.sessionId;
	}

	/** System One steering plane driving semantic validation and certification. */
	get steeringPlane(): SystemOneSteeringPlane | undefined {
		return this._steeringPlane;
	}

	/** Diagnostic readiness gate for adaptive runtime components. */
	get adaptiveReadiness(): AdaptiveRuntimeReadiness | undefined {
		return this._adaptiveReadiness;
	}

	/**
	 * The one way this session hands its semantic decision engine to anything: the plane's engine
	 * wrapped so every evaluation it runs is recorded. Every in-session consumer goes through here,
	 * so the POV bar's Jev indicator reports the whole plane's work and not one subsystem's.
	 * Memoized per underlying engine so collaborators wired once keep a stable engine identity.
	 */
	private _recordingSemanticEngine(): SemanticDecisionEngine | undefined {
		return this._semanticPlane.recordingSemanticEngine();
	}

	/** The recorded engine in the retention planner's batched-question shape. */
	private _semanticDecisionEngine(): ReturnType<typeof createRetentionDecisionEngine> | undefined {
		return this._semanticPlane.semanticDecisionEngine();
	}

	/**
	 * The decision ledger, opened lazily. A ledger that cannot open (read-only state dir, driver
	 * missing) is reported once and the session runs with process-local records rather than failing.
	 */
	getDecisionLedger(): DecisionLedgerStore | undefined {
		return this._semanticPlane.getDecisionLedger();
	}

	/** Why the ledger is unavailable, when it is. */
	getDecisionLedgerFailure(): string | undefined {
		return this._semanticPlane.getDecisionLedgerFailure();
	}

	/** The stage-log sink bound to the current session id; rebound when the session changes. */
	private _stageSinkForSession(): { readonly key: string; readonly sink: DecisionStageSink } | undefined {
		return this._semanticPlane.stageSinkForSession();
	}

	/** Binds the one evaluation sink onto a steering plane; both plane assignments go through here. */
	private _bindSemanticObserver(plane: SystemOneSteeringPlane | undefined): void {
		this._semanticPlane.bindSemanticObserver(plane);
	}

	/** Recent Jev evaluations: what was judged, when, and what it decided. */
	getSemanticEvaluations(): readonly SemanticEvaluationRecord[] {
		return this._semanticPlane.getSemanticEvaluations();
	}

	/** Subscribes to settled Jev evaluations (the Execution pane's Jev previews). */
	onSemanticEvaluation(listener: (record: SemanticEvaluationRecord) => void): () => void {
		return this._semanticPlane.onSemanticEvaluation(listener);
	}

	/** Observed health of this session's semantic plane. */
	getSemanticPlaneHealth(): SemanticPlaneHealth {
		return this._semanticPlane.getSemanticPlaneHealth();
	}

	/** Live semantic uncertainty decisions, scoped to this root session by the health recorder. */
	getSemanticUncertainties(): SemanticUncertaintyPort {
		return this._semanticPlane.getSemanticUncertainties();
	}

	/** Live foreground routing truth (root vs active model, route source) for the operator POV. */
	getForegroundRouteSnapshot(): ForegroundRouteSnapshot {
		return this._modelRouter.getForegroundRouteSnapshot();
	}

	/** The router's candidate pool as the operator configured it, with its provenance. */
	getRouterCandidatePool(): RouterCandidatePool {
		return resolveRouterCandidatePool(this._routerPool, this._modelRegistry, {
			favorites: this.settingsManager.getModelFavorites(),
			isRuntimeDisabled: (r) => !this.settingsManager.isLocalRuntimeEnabled(r),
		});
	}

	/** Account-advertised speed tiers, with bundled capabilities before account discovery. */
	getFastModeServiceTiers(model: Model<Api>): readonly ModelServiceTier[] | undefined {
		return this._accountModels.serviceTiers(model);
	}

	/** The persisted `/toolprobe` record for a model, or undefined when never probed. */
	getToolProbeRecord(model: Model<Api>): ModelToolProbe | undefined {
		return this._toolProtocol.getToolProbe(model);
	}

	/** Deterministic route preview for an example task: no provider call, no session mutation. */
	previewRoute(prompt: string): RoutePreview {
		return this._modelRouter.previewRoute(prompt);
	}

	/** Live route preview (judge/H-MoE may run) on explicit operator request; no session mutation. */
	previewRouteLive(prompt: string): Promise<LiveRoutePreview> {
		return this._modelRouter.previewRouteLive(prompt);
	}

	/** The live operator projection owned by this session. */
	get operatorProjection(): SessionOperatorProjection {
		return this._operatorProjection;
	}

	/** Records adaptive work in flight so the projection can report the ADAPT phase truthfully. */
	setAdaptationProjection(adaptation: AdaptationProjection | undefined): void {
		const previous = this._adaptationProjection;
		this._adaptationProjection = adaptation;
		if (adaptation) {
			const firstSight = adaptation.label !== previous?.label;
			const activated = adaptation.state === "active" && previous?.state !== "active";
			if (adaptation.kind === "capability" && (firstSight || activated)) {
				this._operatorProjection.eventBridge.recordCapabilityMilestone(
					adaptation.label,
					adaptation.state === "active" ? "activated" : "synthesized",
				);
			} else if (adaptation.kind === "specialist" && firstSight) {
				this._operatorProjection.eventBridge.recordSpecialistMilestone(adaptation.label, "created");
			}
		}
		this._operatorProjection.refresh();
	}

	/** Records that an authorized outward-facing delivery step is running. */
	setDeliveryState(state: DeliveryState): void {
		this._deliveryState = state;
		this._operatorProjection.refresh();
	}

	/** Records a blocking condition the operator has to resolve, or clears it. */
	setOperatorBlocker(blocker: string | undefined): void {
		this._operatorBlocker = blocker;
		this._operatorProjection.refresh();
	}

	/** System One's cancel and steer levers over workers, through the root's worker control surface. */
	get systemOneWorkerControl(): SystemOneWorkerControl {
		this._workerControl ??= createSessionWorkerControl({
			cancelWorkerAgent: (agentId, reason) => {
				this._backgroundLanes.cancelWorkerAgent(agentId, reason);
			},
			followUpWorkerAgent: (agentId, message) =>
				this._backgroundLanes.followUpSessionRootWorkerAgent(agentId, message),
			interruptWorkerAgent: (agentId) =>
				this._backgroundLanes.interruptWorkerAgent(agentId, undefined, { force: true }),
			queueWorkerAgentMessage: (agentId, message) => {
				this._backgroundLanes.sendSessionRootWorkerAgentMessage(agentId, message);
			},
			resumeWorkerAgent: (agentId) => this._backgroundLanes.resumeWorkerAgent(agentId),
			recordDirective: (agentId, directive) =>
				this._operatorProjection.eventBridge.recordSupervisorIntervention(agentId, directive),
			emitWarning: (message) => this._emit({ type: "warning", message }),
		});
		return this._workerControl;
	}

	/**
	 * The objective loop's wait: every captured running attempt, in-process or managed, until one of
	 * them leaves "running", the goal's worker-wait bound elapses, the loop is cancelled or the session
	 * is disposed. Only a captured terminal is observed; the loop re-reads readiness after a terminal or
	 * the bound, and stops on disposal.
	 */
	private async _waitForObjectiveWorkers(context: unknown, signal?: AbortSignal): Promise<void> {
		const attempts =
			context &&
			typeof context === "object" &&
			Array.isArray((context as { inFlightAttempts?: unknown }).inFlightAttempts)
				? ((context as { inFlightAttempts: readonly { attemptId: string }[] }).inFlightAttempts ?? [])
				: [];
		if (!attempts.length) return;
		const outcome = await this._backgroundLanes.waitForRunningAttempts(
			attempts.map((attempt) => attempt.attemptId),
			{ timeoutMs: DEFAULT_GOAL_WORKER_WAIT_MS, ...(signal ? { signal } : {}) },
		);
		// A disposed session ends the loop, whichever event settled the wait first.
		if (outcome.kind === "disposed" || this._disposed)
			throw new ObjectiveExecutionInterruptedError("session_disposed");
	}

	/** The session's compiled ExecutionCharter, once the adaptive runtime bound one. */
	get executionCharter(): ExecutionCharter | undefined {
		return this._executionCharter;
	}

	/** External-acquisition gate bound to the real execution boundary. */
	get acquisitionGate(): ExternalCapabilityAcquisitionGate | undefined {
		return this._acquisitionGate;
	}

	/**
	 * Loads or reloads a single extension by path through the live extension runtime.
	 * This is the owner that makes `extension` an activatable capability kind (ACT-009).
	 */
	async reloadExtension(extensionPath: string): Promise<void> {
		await this._runtimeBuilder.reloadExtension(extensionPath);
		this._notifyExtensionsChanged();
	}

	/** Live worker supervision bound to the real worker lifecycle. */
	get workerSupervision(): WorkerSupervisionCoordinator {
		return this._workerSupervision;
	}

	/** Root semantic project rules: mutation acceptance, task postflight and completion. */
	get projectRules(): SessionProjectRules {
		return this._projectRules;
	}

	/** Durable RepairWork queued by a blocking project-rule violation. */
	getQueuedRuleRepairWork(): readonly RuleRepairWork[] {
		return this._projectRules.getQueuedRepairWork();
	}

	/** Durable owner development rules in force for this project. */
	getOwnerRulePolicies(): readonly OwnerRulePolicy[] {
		return this._ownerRules.list();
	}

	/** The owner rules block every worker, specialist and capability-builder mission carries. */
	renderOwnerRulesForMission(): string {
		return this._edgeIntent.renderOwnerRulesForMission();
	}

	/** Branch bound by a local-commit classification, or undefined when that rule is off. */
	localCommitBranch(): string | undefined {
		return this._edgeIntent.localCommitBranch();
	}

	/** Skill vault controller managing active and cached skills. */
	get skillVault(): SkillVaultController {
		return this._skillVault;
	}

	/** Background lane controller managing worker and research lanes. */
	get backgroundLanes(): BackgroundLaneController {
		return this._backgroundLanes;
	}

	/**
	 * Attach assembled adaptive runtime stack components to this live session.
	 */
	attachAdaptiveRuntime(stack: SessionAdaptiveRuntimeStack): void {
		attachSessionAdaptiveRuntime(
			{
				cwd: this._cwd,
				sessionManager: this.sessionManager,
				settingsManager: this.settingsManager,
				modelRouter: this._modelRouter,
				getSteeringPlane: () => this._steeringPlane,
				setSteeringPlane: (plane) => {
					this._steeringPlane = plane;
				},
				bindSemanticObserver: (plane) => this._bindSemanticObserver(plane),
				getExecutionCharter: () => this._executionCharter,
				setExecutionCharter: (charter) => {
					this._executionCharter = charter;
				},
				mutationLedger: this._mutationLedger,
				getSemanticDecisionEngine: () => this._semanticDecisionEngine(),
				getEdgeGrants: () => this.getEdgeGrants(),
				emit: (event) => this._emit(event),
				setAcquisitionGate: (gate) => {
					this._acquisitionGate = gate;
				},
				setAdaptiveReadiness: (readiness) => {
					this._adaptiveReadiness = readiness;
				},
				setObjectiveExecutionController: (controller) => {
					this._objectiveExecutionController = controller;
				},
				setOperatorBlocker: (blocker) => this.setOperatorBlocker(blocker),
				getOperatorBlocker: () => this._operatorBlocker,
				getDecisionLedger: () => this.getDecisionLedger(),
				backgroundLanes: this._backgroundLanes,
				goals: this._goals,
				chooseObjectiveExecutor: (route) => this._chooseObjectiveExecutor(route),
				retrieveForObjective: (route, signal) => this._retrieveForObjective(route, signal),
				waitForObjectiveWorkers: (context, signal) => this._waitForObjectiveWorkers(context, signal),
				workerSupervision: this._workerSupervision,
				objectiveMutationId: () => this.objectiveMutationId(),
				repositoryObserver: this._repositoryObserver,
				runtimeBuilder: this._runtimeBuilder,
				getGoalStateSnapshot: () => this.getGoalStateSnapshot(),
				saveGoalStateSnapshot: (state, expected) => this.saveGoalStateSnapshot(state, expected),
				getLocalCommitBranch: () => this.localCommitBranch(),
				getRuleAuthority: () => this._edgeIntent.ruleAuthority,
				deployAdapters: this._deployAdapters,
				getSystemOneController: () => this._systemOneController,
				getExecutionLoopMode: () => this._executionLoopMode,
				setAdaptationProjection: (adaptation) => this.setAdaptationProjection(adaptation),
			},
			stack,
		);
	}

	/**
	 * The owner redeemed a subscription usage reset for `provider`: its recorded exhaustions and usage
	 * window limits no longer hold, so routing, workers and admission use it again at once instead of
	 * waiting out the reset time recorded before the redemption.
	 */
	noteSubscriptionUsageReset(provider: string): void {
		this._foregroundRecovery.clearProviderExhaustion(provider);
		this._providerLimitStore.clear(resolveProviderAccountKey(this._modelRegistry.authStorage, provider), [
			"usage_window",
			"rate_limit",
		]);
		this._subscriptionResetOffered.delete(provider);
	}

	/**
	 * Codex answered that the subscription's usage limit is reached: say whether the account holds a
	 * usage reset it can redeem (`/usage`); once told, not again this session until a reset is redeemed.
	 */
	private async _offerSubscriptionReset(message: AssistantMessage): Promise<void> {
		return offerCodexSubscriptionReset(
			{
				subscriptionResetOffered: this._subscriptionResetOffered,
				subscriptionResetChecking: this._subscriptionResetChecking,
				modelRegistry: this._modelRegistry,
				emit: (event) => this._emit(event),
			},
			message,
		);
	}

	/**
	 * System One checks a plan the model just published or changed, against the owner's request: a
	 * decisive gap steers the model in the same result; an unsettled one is shown to the operator.
	 */
	private async _reviewPublishedPlan(toolName: string, args: unknown): Promise<string | undefined> {
		if (!changesPlan(toolName, args)) return undefined;
		const steps = (this.getTaskStepsStateSnapshot()?.steps ?? [])
			.filter((step) => step.status !== "cancelled")
			.map((step) => step.content);
		const review = await reviewPlan(this._semanticDecisionEngine(), {
			request: this._promptSubmission.lastUserRequest,
			steps,
		});
		if (review.doubt) this._emit({ type: "warning", message: `${review.doubt}.` });
		return review.steer;
	}

	/** Names of the skills that declare an effect: an in-process worker is never offered them. */
	private _effectfulSkillNames(): Set<string> {
		const snapshot = this._skillVault.getSkillsSnapshot();
		const eligible = new Set(workerEligibleSkills(snapshot).map((skill) => skill.name));
		return new Set(snapshot.map((skill) => skill.name).filter((name) => !eligible.has(name)));
	}

	/** Why a model cannot take work now: its quota is exhausted, or the owner's account does not offer it. */
	private _modelUnusableCause(model: Model<Api>): OrchestrationModelUnusableCause | undefined {
		if (this._foregroundRecovery.isModelExhausted(`${model.provider}/${model.id}`)) return "model_quota_exhausted";
		return this._accountModels.unavailableCause(model);
	}

	private _isModelUnusable(model: Model<Api>): boolean {
		return this._modelUnusableCause(model) !== undefined;
	}

	/**
	 * A provider refused the model for the owner's account: it is never routed to again this session,
	 * and the turn moves to the model that replaces it. Returns the replacement's ref, or undefined.
	 */
	private async _replaceUnsupportedModel(message: AssistantMessage): Promise<string | undefined> {
		const refused = this._modelRegistry.find(message.provider, message.model) ?? this.model;
		if (!refused) return undefined;
		this._accountModels.markRefused(refused, message.errorMessage ?? "model not supported");
		const from = `${refused.provider}/${refused.id}`;
		// A routed turn's model is the turn's, never the session's: its replacement stays inside the
		// routed turn, whose end restores the owner's model; the session model is never changed from here.
		if (this._modelRouter.isRoutedTurnOn(refused)) {
			const routed = this._modelRouter.replaceRefusedRoutedModel(
				refused,
				this._accountModels.accountDefault(refused.provider),
			);
			if (!routed) {
				this._emit({
					type: "warning",
					message: `${from} is not available on this account, and no usable model can take this routed turn over.`,
				});
				return undefined;
			}
			const to = `${routed.provider}/${routed.id}`;
			this._emit({
				type: "warning",
				message: `${from} is not available on this account; this turn continues on ${to}.`,
			});
			return to;
		}
		return this._leaveUnavailableSessionModel();
	}

	/**
	 * The session's model is not offered to the owner's account: this session moves to the
	 * provider's own default for the account (the owner's saved default is left alone), with a
	 * warning naming both. Returns the replacement's ref, or undefined when there is nothing to leave
	 * or nothing to move to.
	 */
	private async _leaveUnavailableSessionModel(): Promise<string | undefined> {
		const current = this.model;
		if (!current || this._accountModels.availability(current) !== "unavailable") return undefined;
		const from = `${current.provider}/${current.id}`;
		const why = this._accountModels.unavailableReason(current) ?? "unavailable";
		const replacement = this._accountModels.accountDefault(current.provider);
		if (!replacement) {
			// Only a fetched listing can say the account offers nothing else: without one, no alternative could be chosen at all.
			this._emit({
				type: "warning",
				message: this._accountModels.hasListing(current.provider)
					? `${from} is not available on this account (${why}), and the account offers no other ${current.provider} model pi knows.`
					: `${from} is not available on this account (${why}), and no ${current.provider} account model listing is available to choose a replacement from.`,
			});
			return undefined;
		}
		await this._switchSessionModel(replacement, { persistSettings: false });
		this._moveTalker(replacement, `${from} unavailable on this account`);
		const to = `${replacement.provider}/${replacement.id}`;
		this._emit({
			type: "warning",
			message: `${from} is not available on this account (${why}); this session continues on ${to}.`,
		});
		return to;
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
			return {
				apiKey: result.apiKey,
				headers,
				credentialHeaders: result.credentialHeaders,
				providerAccountKey: result.providerAccountKey,
			};
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

	/**
	 * One bounded diagnostic clause for compaction retry warnings: which summarizer selection won
	 * (and why) plus the input-size estimate the capacity check consumed — the two facts every
	 * gate-failure post-mortem has needed (2026-07-06 field incidents).
	 */
	private _describeCompactionSummarizer(): string {
		const reason = this._compactionSupport.getLastSelectionReason() ?? "unresolved";
		const estimate = this._compaction.estimateSummarizationInputTokens();
		return `summarizer: ${reason}, ~${Math.ceil(estimate / 1000)}k est input`;
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

	/** Operator view of past-session history recall (coverage, latest retrieval, prompt admission). */
	getTranscriptHistoryStatus(): TranscriptHistoryStatus {
		return this._memory.getTranscriptHistoryStatus();
	}

	/** Managed memory files against their managed revisions (operator recovery view). */
	memoryDriftReport(): Promise<ManagedMemoryDriftEntry[]> {
		return this._memory.memoryDriftReport();
	}

	/** Operator authority: adopt the on-disk memory file as the managed revision. */
	memoryAcceptDrift(target: ManagedMemoryTarget): Promise<{ ok: boolean; message: string }> {
		return this._memory.memoryAcceptDrift(target);
	}

	/** Operator authority: restore the last managed content of a memory file. */
	memoryRestoreManaged(target: ManagedMemoryTarget): Promise<{ ok: boolean; message: string }> {
		return this._memory.memoryRestoreManaged(target);
	}

	/** Operator authority: repair an unknown permanent forget state (a damaged, rolled-back or missing file). */
	repairHistoryForgetState(): Promise<{ ok: boolean; message: string }> {
		return this._memory.repairHistoryForgetState();
	}

	/** Operator authority: forget one session's derived history summaries; the canonical session is untouched. */
	forgetHistorySession(sessionId: string): Promise<{ ok: boolean; message: string }> {
		return this._memory.forgetHistorySession(sessionId);
	}

	/** Every active verification obligation with what the operator can read about it. */
	getVerificationObligations(): VerificationObligationView[] {
		return new VerificationObligationTracker(this.agent.state.messages).getActiveObligations();
	}

	/** Bind the branch-scoped durable repository outcome journal after session construction. */
	setWorkEvidenceJournal(journal: RepositoryWorkEvidenceJournal): void {
		this._repositoryObserver.setWorkEvidenceJournal(journal);
	}

	/** Replay this objective's pending host journal handoffs before new repository work is admitted. */
	recoverGoalWorkEvidence(): Promise<void> {
		return this._repositoryObserver.recoverWorkEvidence(this.objectiveMutationId());
	}

	/** Repository scope and mutations for the current objective, resolved through its authoritative id. */
	getGoalWorkEvidence(): readonly RepositoryWorkEvidenceScope[] {
		return this._repositoryObserver.getWorkEvidence(this.objectiveMutationId());
	}

	/** Mandatory System One findings for projections that display them separately from advisory doubts. */
	getSemanticVerificationObligations(): readonly SemanticVerificationObligationView[] {
		return this._systemOneController?.verification.status().obligations ?? [];
	}

	/**
	 * The operator resolves obligations by their own authority (`/verify dismiss`). The record is a
	 * user-plane custom message the tracker honours; it is never a passing test, so goal evidence
	 * that needs a real receipt still needs one. Returns the ids actually dismissed.
	 */
	async dismissVerificationObligations(ids: readonly string[], note?: string): Promise<string[]> {
		const active = new Set(this._getActiveVerificationIds());
		const targets = ids.filter((id) => active.has(id));
		const details = createVerificationDismissalDetails(targets, note);
		if (!details) return [];
		const dismissed = details.piVerificationDismissal.ids;
		const reason = note?.trim() ? ` — ${note.trim()}` : "";
		await this.sendCustomMessage(
			{
				customType: VERIFICATION_DISMISSAL_CUSTOM_TYPE,
				content: `Operator dismissed verification obligation${dismissed.length > 1 ? "s" : ""}: ${dismissed.join(", ")}${reason}`,
				display: true,
				details,
			},
			{},
		);
		return [...dismissed];
	}

	// ---- The edge (agent-session-edge.ts owns the logic; this coordinator supplies the session) ----

	private _edgeDeps(): SessionEdgeDeps {
		return this._edgeIntent.edgeDeps();
	}

	/** The interactive host answers ungranted edge operations; a child or headless session cannot ask. */
	setEdgeConfirmation(handler: EdgeConfirmationHandler | undefined): void {
		this._edgeIntent.setEdgeConfirmation(handler);
	}

	getEdgeGrants(): EdgeGrantView[] {
		return this._edgeIntent.getEdgeGrants();
	}

	/**
	 * AGENTS.md and standing user-rule lines for one System One classification.
	 */
	private writtenRuleText(): string {
		return this._edgeIntent.writtenRuleText();
	}

	/**
	 * System One classifies the request. A hard yes enables edge capabilities that are still off.
	 * The user is above AGENTS.md: an explicit override follows the request, a contradiction asks.
	 * Returns the one line the model should see, and nothing when there is nothing to say.
	 */
	private async _enableCapabilitiesAuthorizedByUser(
		request: string,
		signal?: AbortSignal,
		trustedOwner = true,
		acceptedOrder?: number,
	): Promise<string | undefined> {
		return this._edgeIntent.enableCapabilitiesAuthorizedByUser(request, signal, trustedOwner, acceptedOrder);
	}

	/** The owner's current model pool policy. */
	getModelPolicy(): ModelPoolPolicy {
		return this._edgeIntent.getModelPolicy();
	}

	/** Whether the owner's model policy allows allocating this model. */
	isModelAllowed(model: Model<Api>): boolean {
		return this._edgeIntent.isModelAllowed(model);
	}

	grantEdge(edgeClass: EdgeClass, source: "operator" | "instructions", details: EdgeGrantDetails = {}): void {
		this._edgeIntent.grantEdge(edgeClass, source, details);
	}

	revokeEdge(edgeClass: EdgeClass): boolean {
		return this._edgeIntent.revokeEdge(edgeClass);
	}

	getSkillVault(): SkillVaultController {
		return this._skillVault;
	}

	/** Preserve active verification identities and setup-repair proof inside the compaction checkpoint. */
	private _decorateCompactionDetails(details: unknown): unknown {
		const snapshot = new VerificationObligationTracker(this.agent.state.messages).createSnapshotDetails();
		const selfCompaction = this._selfCompaction.state();
		const handoff =
			selfCompaction.status === "pending" && selfCompaction.request
				? { selfCompaction: { handoffId: selfCompaction.request.id } }
				: undefined;
		if (!snapshot && !handoff) return details;
		const base = !details || typeof details !== "object" || Array.isArray(details) ? {} : details;
		return { ...base, ...snapshot, ...handoff };
	}

	private _scheduleIdleWork(options: PromptOptions | undefined, allowHandoff: boolean): void {
		this._backgroundLanes.drainQueuedWorkerDelegations();
		const interrupted = isInterruptedAssistantStopReason(this._findLastAssistantMessage()?.stopReason);
		const handoff = allowHandoff && !interrupted && this._selfCompaction.schedule();
		if (!interrupted && !handoff) this._backgroundLanes.scheduleGoalAutoContinueFromIdle(options);
		this._backgroundLanes.scheduleResearchLaneFromIdle();
	}

	private _subscribeIdleContinuationActivity(listener: () => void): () => void {
		const offLanes = this._backgroundLanes.subscribeIdleContinuationActivity(listener);
		const offHandoff = this._selfCompaction.subscribeActivity(listener);
		return () => {
			offLanes();
			offHandoff();
		};
	}

	/**
	 * Wakes the waiters of a refused system switch lease. The conditions that refuse it and clear outside a foreground
	 * submission (a running tool task, the detached reflection turn) report here. Coalesced to one pass after the change,
	 * so the pass reads the state the change left behind.
	 */
	private _notifySystemSwitchAvailability(): void {
		if (this._systemSwitchAvailabilityQueued) return;
		this._systemSwitchAvailabilityQueued = true;
		queueMicrotask(() => {
			this._systemSwitchAvailabilityQueued = false;
			this._systemSwitchAvailability.notify(
				(listener) => listener(),
				() => this._emit({ type: "warning", message: "System switch availability observer failed." }),
			);
		});
	}

	/**
	 * The waiter's signal for a refused system switch lease. Foreground activity covers every submission and compaction
	 * end, and the pending-input drain and the retry (both inside a submission) end before its release. Running lanes
	 * are observed only while the waiter is subscribed, so an idle session pays nothing for them.
	 */
	private _subscribeSystemSwitchAvailability(listener: () => void): () => void {
		const offForeground = this._foregroundRecovery.subscribeActivity(listener);
		const offSignals = this._systemSwitchAvailability.subscribe(listener);
		const offLanes = this._backgroundLanes.subscribeLaneRecords(() => listener());
		return () => {
			offForeground();
			offSignals();
			offLanes();
		};
	}

	private _hasPendingIdleContinuation(): boolean {
		return this._backgroundLanes.hasPendingIdleContinuation() || this._selfCompaction.hasPendingContinuation();
	}

	private _hardCompactionTriggerTokens(): number | undefined {
		const model = this.model;
		const settings = this._getAdaptedCompactionSettings();
		if (!model?.contextWindow || !settings.enabled) return undefined;
		return hardCompactionTriggerTokens(model.contextWindow, settings, model.autoCompactionTriggerTokens);
	}

	private _earlyCompactionTriggerTokens(): number | undefined {
		const model = this.model;
		const settings = this._getAdaptedCompactionSettings();
		const percent = settings.triggerPercent ?? 0;
		if (!model?.contextWindow || !settings.enabled || !(percent > 0 && percent < 1)) return undefined;
		return Math.floor(model.contextWindow * percent);
	}

	private _isForegroundPhaseBusy(): boolean {
		const phase = this.getSessionWorkState().phase;
		return (
			phase === "foreground_preparing" ||
			phase === "llm_streaming" ||
			phase === "retrying" ||
			phase === "compacting" ||
			phase === "system_one_evaluating"
		);
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

	private _imageStoreCache: { key: string; store: SessionImageStore } | undefined;

	/** The session's image store, built once per (session, cwd, directory) so queue changes do not rebuild it. */
	private _getSessionImageStore(): SessionImageStore | undefined {
		const directory = this.settingsManager.getClipboardImageDirectory();
		if (!this.sessionManager.isPersisted() && !directory) return undefined;
		const key = JSON.stringify([this.sessionId, this._cwd, this._agentDir, directory ?? null]);
		if (this._imageStoreCache?.key === key) return this._imageStoreCache.store;
		const store = new SessionImageStore({
			agentDir: this._agentDir,
			cwd: this._cwd,
			sessionId: this.sessionId,
			directory,
		});
		this._imageStoreCache = { key, store };
		return store;
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

	/** Read-only latest accepted provider-context projection, or a pure preview for explicit messages. */
	getContextProjection(messages?: readonly AgentMessage[]): ContextProjection {
		return this._pipeline.getContextProjection(messages);
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
		sourceMessages: AgentMessage[],
		frozenBelow: number,
		gcReport: ContextGcReport,
	): EnforcePromptPolicyResult {
		return this._pipeline.runPromptEnforcement(messages, shadowReport, undefined, {
			sourceMessages,
			frozenBelow,
			gcReport,
		});
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
	/**
	 * One cache observation per provider response (see CacheObservationRecorder), joined to the request
	 * snapshot that opened it, so the cache-survival estimator can learn each lane's cache lifetime.
	 * Best effort: a ledger that cannot be written never affects the turn.
	 */
	private _recordCacheObservation(message: AssistantMessage, conversation?: WorkerResponseObservation): void {
		this._cache.recordObservation(message, conversation);
	}

	private _guardCacheSurface(snapshot?: SessionRequestSnapshotInput, conversation?: string): void {
		this._cache.guardSurface(snapshot, conversation);
	}

	private _recordCacheDecision(decision: Omit<CacheDecisionRow, "sessionId" | "cwd">): void {
		this._cache.recordDecision(decision);
	}

	private _refreshAfterCompaction(): void {
		// A cheap routed turn's buffered messages are live but not in the session yet: the rebuild cannot see them, and
		// the compaction did not summarize them, so they follow the rebuilt history as the newest messages.
		const pending = this._modelRouter.pendingSessionMessages(this.agent.state.messages);
		this._cache.refreshAfterCompaction();
		if (pending.length > 0) this.agent.state.messages = [...this.agent.state.messages, ...pending];
	}

	/**
	 * Takes the warnings this session raised while no subscriber was attached, once. A discarded candidate has no subscriber,
	 * so its host takes them to deliver on the session that survives.
	 */
	takeUndeliveredWarnings(): string[] {
		return this._foregroundLifecycle.drainWarnings();
	}

	/**
	 * Surface one bounded host warning to the session's subscribers (a UI shows it; it never changes the run).
	 * One raised before anyone subscribes is kept for the first subscriber.
	 */
	emitHostWarning(message: string): void {
		this._foregroundLifecycle.warn(message);
	}

	/**
	 * The live path-alias table, for expanding aliases back to real paths on any surface a person
	 * reads (see context/path-alias-display.ts). Aliases are a wire-format token optimization; the
	 * operator always sees their own paths.
	 */
	peekPathAliasTable(): PathAliasTable {
		return this._pipeline.peekPathAliasTable();
	}

	/**
	 * Context composition dashboard data: decomposes the per-request payload (system prompt, tool
	 * schemas, extension contributions, message classes incl. GC/policy stubs and recall pages)
	 * plus background spend, so users can see exactly what their integrations cost per request.
	 * Read-only: uses the GC report path (writePayloads=false), never mutates anything.
	 */
	getContextCompositionReport(): ContextCompositionReport {
		return buildSessionContextCompositionReport({
			agent: this.agent,
			model: this.model,
			systemPrompt: this.systemPrompt,
			unboundToolGrantWarnings: this._unboundToolGrantWarnings,
			delegatePromptGuidelineWarnings: this._delegatePromptGuidelineWarnings,
			skillVault: this._skillVault,
			resourceLoader: this._resourceLoader,
			profileFilter: this._profileFilter,
			settingsManager: this.settingsManager,
			applyContextGc: (rawMessages, writePayloads, sentPrefixCount) =>
				this._applyContextGc(rawMessages, writePayloads, sentPrefixCount),
			getContextUsage: () => this.getContextUsage(),
			getPromptEnforcementReport: () => this.getPromptEnforcementReport(),
			getContextCurationStatus: () => this.getContextCurationStatus(),
			getSpawnedUsage: () => this.getSpawnedUsage(),
			getMemoryPromptInclusionReport: () => this.getMemoryPromptInclusionReport(),
			getCurrentForegroundEnvelope: () => this._currentForegroundEnvelope,
			buildForegroundEnvelopeFromState: () => this._buildForegroundEnvelopeFromState(),
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

	/** Read-only inspection of the latest memory-retrieval report, for tests/debugging. */
	getMemoryRetrievalReport(): MemoryRetrievalReport {
		return this._memory.getMemoryRetrievalReport();
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
	): ContextGcResult {
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
		this.agent.toolConcurrency = this.settingsManager.getToolExecutionSettings().concurrency;
		this.agent.handoffToolCall = (context) =>
			this.getActiveToolNames().includes("tool_task") ? this._backgroundToolTasks.handoff(context) : undefined;
		this.agent.subscribeToolCallHandoffRequest = (toolCallId, request) =>
			this._backgroundToolTasks.subscribeHandoffRequest(toolCallId, request);
		this.agent.isBackgroundRequested = (tool, args) =>
			this.getToolDefinition(tool)?.backgroundRequested?.(args as never) === true;
		this.agent.onRunawayStop = (info) => handleRunawayStop(this._guardDeps(), info);
		this.agent.onToolValidationEscalation = (event) => handleToolValidationEscalation(this._guardDeps(), event);
		this.agent.toolFailureProtocolProse = this.getCapabilityTierPolicy().protocolProse;
		this.agent.maxRepeatedFailures = this.getCapabilityTierPolicy().repetitionGuardRepeats;
	}

	/** Guard handlers live in agent-session-guards.ts; the coordinator only supplies their dependencies. */
	private _guardDeps(): SessionGuardDeps {
		return {
			getModel: () => this.model,
			formatModel: (model) => formatModelRouterModel(model),
			appendCustomEntry: (customType, record) => this.sessionManager.appendCustomEntry(customType, record),
			recoverGoalFromHarnessGuard: (info) => this._goals.recoverFromHarnessGuard(info),
			setCapabilityTierDemotion: (modelKey, demotion) => {
				this._modelAdaptationStore.setCapabilityTier(modelKey, demotion);
			},
			refreshCapabilityTierPolicy: () => {
				this.agent.toolFailureProtocolProse = this.getCapabilityTierPolicy().protocolProse;
				this.agent.maxRepeatedFailures = this.getCapabilityTierPolicy().repetitionGuardRepeats;
			},
			sendNextTurnMessage: (customType, content, details) => {
				void this.sendCustomMessage({ customType, content, display: false, details }, { deliverAs: "nextTurn" });
			},
			emitWarning: (message) => this._emit({ type: "warning", message }),
			findModel: (provider, modelId) => this._modelRegistry.find(provider, modelId),
			isLocalOrManagedModel: (model) => isLocalOrManagedRouterModel(model),
			maybeAutoProbe: (model) => this._toolProtocol.maybeAutoProbe(model),
			requestValidationFailureEscalation: () => this._modelRouter.requestValidationFailureEscalation(),
		};
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit an event to all listeners */
	/** Steer a displayed custom notice to this session's model (may trigger a turn); a delivery failure is a visible warning. */
	private _steerSessionNotice(customType: string, text: string): void {
		void this.sendCustomMessage(
			{ customType, content: text, display: true },
			{ triggerTurn: true, deliverAs: "steer" },
		).catch((error: unknown) => {
			this._emit({
				type: "warning",
				message: `${customType}: failed to notify session: ${error instanceof Error ? error.message : String(error)}`,
			});
		});
	}

	private _emit(event: AgentSessionEvent): void {
		if (event.type === "warning" && this._eventListeners.length === 0) {
			this._holdUnlistenedWarning(event.message);
			return;
		}
		for (const listener of [...this._eventListeners]) {
			try {
				// Public listeners are observers. Freeze this emission's generation and invoke it
				// synchronously to preserve ordering, but contain both synchronous failures and rejected
				// thenables so one observer cannot alter sibling delivery or reject the session operation.
				const result = listener(event) as unknown;
				if (result !== null && (typeof result === "object" || typeof result === "function") && "then" in result) {
					void Promise.resolve(result).catch(() => {});
				}
			} catch {
				// Listener failures must not affect session event dispatch or operation completion.
			}
		}
	}

	/** Holds a warning no listener takes, bounded like `emitHostWarning` bounds its message. */
	private _holdUnlistenedWarning(message: string): void {
		this._foregroundLifecycle.hold(message);
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
		if (event.type === "agent_end") this.runtimeUpdates.noteRunEnd(this.agent.signal);
		// A run read a queued input: it leaves the visible queue BEFORE listeners see the message (the UI sees the updated
		// queue), matched by the identity the message carries. It is delivered when its user entry is persisted, not here.
		if (event.type === "message_start" && event.message.role === "user") {
			this._compaction.resetOverflowRecovery();
			if (this._pendingQueue.noteRead(event.message)) this._emitQueueUpdate();
			this._goals.noteUserMessageRead();
		}
		if (event.type === "turn_end" || event.type === "tool_execution_start" || event.type === "tool_execution_end") {
			this._skillVault.noteActivity();
		}
		if (event.type === "tool_execution_start") {
			this._skillVault.noteWorkPaths(
				skillWorkPathsFromToolCall(event.toolName, event.args, this._pipeline.peekPathAliasTable(), this._cwd),
			);
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

		// Emit to extensions first. Extension delivery ended with `session_shutdown` (their cleanup runs there and the runner is
		// invalidated), so a closing session's remaining agent events are settled internally only: persistence and memory sync.
		if (!this._disposed) await this._emitExtensionEvent(event);
		// A handler that was already awaiting an extension when the closing sequence gave up on it (the bounded settle) resumes
		// into owners that are being or have been closed: it stops here instead of writing to them. The loss was disclosed.
		if (this._closingConsumerReleased) return;

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
			if (this._modelRouter.captureSessionMessage(event.message, event.origin)) {
				// buffered by the router; persistence is deferred to the routed-turn flush
			} else if (event.message.role === "custom") {
				this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
					event.message,
				);
				this._durableCustomMessageTurns.notePersisted(event.message);
				messagePersisted = true;
			} else if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// The append is the Delivered point of an owner input this message carries (the ledger hears it there).
				this._foregroundLifecycle.appendMessage(event.message, event.origin);
				messagePersisted = true;
			}
			// Track the response for ordered retry/failover/compaction handling after agent_end.
			if (event.message.role === "assistant") {
				const assistantMsg = event.message as AssistantMessage;
				this._recordCacheObservation(assistantMsg);
				// The session lane's stream closed: it idles until its next request (a tool run or the owner).
				const sessionModel = this.model;
				if (
					sessionModel &&
					assistantMsg.stopReason !== "error" &&
					assistantMsg.stopReason !== "aborted" &&
					assistantMsg.provider === sessionModel.provider &&
					assistantMsg.model === sessionModel.id
				) {
					this._compaction.onLaneIdle(assistantMsg);
				}
				// A reply a routed model wrote keeps its route, so a reloaded conversation names the same author.
				const route = this._modelRouter.getForegroundRouteSnapshot();
				if (route.switched) {
					const record: ReplyRouteRecord = { timestamp: assistantMsg.timestamp, route };
					this.sessionManager.appendCustomEntry(REPLY_ROUTE_CUSTOM_TYPE, record);
				}
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
			// The end-of-run cleanups are independent: one that fails (a fenced session file refusing a write) must not skip the
			// others, which release leases and flush handoffs. Every step runs, and every cause is kept.
			const failures: unknown[] = [];
			const settle = (step: () => void): void => {
				try {
					step();
				} catch (error: unknown) {
					failures.push(error);
				}
			};
			// Settle the exact cue-bearing run before completed-turn analysis can queue a later cue.
			settle(() => this._reflection.finishCurrentTurnCue(event.messages, { willRetry }));
			if (!willRetry)
				settle(() => {
					const reflectionTurn = this._reflection.analyzeCompletedTurn(event.messages);
					// The shared projection excludes raw tool-result payloads and bounds both roles before any
					// deterministic memory sync. No reflection provider request is scheduled at this boundary.
					this._memory.scheduleTurnSync(reflectionTurn.userText, reflectionTurn.assistantText);
					if (reflectionTurn.trigger !== "none") this._reflection.queueCurrentTurnCue(reflectionTurn.trigger);
				});
			// Error/abort turns bypass the normal steering boundary, and a completion can arrive after the
			// final normal poll. agent_end is the fallback before foreground recovery decides whether queued
			// steering requires one continuation; turn_end is intentionally not a flush.
			settle(() => this._terminalHandoffs.flushProviderBoundary());
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) {
				throw new AggregateError(
					failures,
					failures[0] instanceof Error ? failures[0].message : "The end-of-run cleanup failed.",
				);
			}
		}
	};

	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		return this._foregroundRecovery.willRetryAfterAgentEnd(event);
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
			if (this._deliveryToolCalls.delete(event.toolCallId) && this._deliveryToolCalls.size === 0) {
				this.setDeliveryState("none");
			}
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
	 * Called after successful load/unload operations. Freeze the generation so listener-owned rebinds
	 * cannot skip an existing observer or pull a newly registered observer into the current transition.
	 */
	private _notifyExtensionsChanged(): void {
		for (const listener of [...this._extensionsChangedListeners]) {
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
		// The first releases are required ones: a failure in any of them is kept for `disposeAndWait()` and never skips the releases below.
		trackRequired(async () => {
			this._compaction.cancelIdlePreparation();
		});
		// Queued input not yet handed to the agent belongs to this session and is never handed on after it.
		trackRequired(async () => {
			this._pendingQueue.close();
		});
		// Every in-flight admission entry this session still owns is released; a sibling process
		// would otherwise count it until the heartbeat went stale.
		trackRequired(async () => {
			this._providerAdmissionLedger.releaseAll();
		});

		safely(() => this._backgroundLanes.clearGoalAutoContinueTimer());
		safely(() => this._backgroundLanes.clearResearchLaneTimer());
		safely(() => this._unsubscribeIdleOccupancy?.());
		this._unsubscribeIdleOccupancy = undefined;
		safely(() => this._foregroundRecovery.shutdown());
		safely(() => this._durableCustomMessageTurns.shutdown());
		safely(() => this.abortRetry());
		safely(() => this.abortCompaction());
		try {
			this._compaction.close();
		} catch (error: unknown) {
			// Closing the compaction owner failed (typically its durable end record could not be written to a fenced or closed session
			// file): disclosed at close, never dropped.
			this._holdUnlistenedWarning(
				`Closing the running compaction failed at quit: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		safely(() => this.abortBranchSummary());
		safely(() => this.abortBash());
		safely(() => this._skillVault.unload());
		safely(() => this._unsubscribeSettingsChanges?.());
		this._unsubscribeSettingsChanges = undefined;
		trackRequired(() => disposeShellExecutionSessionAndWait(this._shellSessionKey));
		safely(() => this._localPrefixWarm.cancel());
		safely(() => this.agent.abort("session dispose"));
		// A submission still preparing or finishing (owner-policy classification, postflight) has no run for the agent abort to reach:
		// cancelling the submission itself keeps a closing session from starting paid System One work after the quit.
		safely(() => this._promptSubmission.abortSubmission("session dispose"));
		track(() => this._gatewayRegistry.stop());
		trackRequired(() => this._backgroundToolTasks.shutdown());
		track(() => this._runtimeBuilder.dispose());
		safely(() => this._localRuntimeController.dispose());
		safely(() => this._reflection.dispose());
		safely(() => this._reflectionAbort.abort());
		trackRequired(() => this._backgroundLanes.abortInFlightLanes());
		safely(() => this._providerRequestRuntime.dispose());
		safely(() => {
			this.agent.afterToolCall = undefined;
			this.agent.handoffToolCall = undefined;
			this.agent.subscribeToolCallHandoffRequest = undefined;
		});
		safely(() => this._extensionRunner.invalidate());
		safely(() => this._toolPerformanceStore.close());
		safely(() => this._modelAdaptationStore.close());
		// The decision ledger holds an open SQLite handle under the agent directory; Windows refuses to
		// remove that directory while it is open, and the rows are already durable. A close failure is a
		// required release failure: it rejects `disposeAndWait()` instead of being discarded.
		trackRequired(async () => {
			this._semanticPlane.closeDecisionLedger();
		});
		track(() => this._resourceLoader.dispose?.() ?? Promise.resolve());
		this._eventListeners = [];
		// Ordered, not parallel, and that ordering is the point. The lifecycle abort unwinds any in-flight
		// reflection turn; awaiting it here means its `agent_end` — and the memory turn-sync that boundary
		// schedules — have both happened BEFORE `_memory.shutdown()` captures the lifecycle tail it
		// flushes. Tracked concurrently (as this was), the shutdown would capture that tail first and the
		// reflection turn would append a write nothing awaits: work landing in the agent dir after
		// `disposeAndWait()` has already returned.
		// The abort precedes the settle, and is the lifecycle's rather than `agent.abort()` above, because
		// a reflection turn still in its own preflight has no run for an agent-level abort to reach: that
		// abort is a no-op, the settle then waits out a full provider turn, and it executes against
		// infrastructure this method has already torn down.
		track(async () => {
			try {
				this._reflectionTurnLifecycle.abort();
				// The aborted run still emits its trailing events (its partial message, then agent_end), which this session persists
				// and syncs to memory. They are handled before the internal subscription is released; the listeners are already gone.
				try {
					if (!(await runSettlesWithin(this.agent.waitForIdle(), CLOSING_RUN_SETTLE_MS))) {
						this._holdUnlistenedWarning(
							`A run did not settle within ${CLOSING_RUN_SETTLE_MS / 1000}s of quit; its final message may not have been persisted.`,
						);
					}
				} finally {
					safely(() => this._disconnectFromAgent());
					this._closingConsumerReleased = true;
				}
				// The reflection turn awaits its own prompt, which an abort-ignoring provider can hold open: it gets the same bound, so a
				// stuck turn cannot keep the memory shutdown, the owner's dispose and the closing disclosure from ever running.
				if (!(await runSettlesWithin(this.settleReflectionTurn(), CLOSING_RUN_SETTLE_MS))) {
					this._holdUnlistenedWarning(
						`A reflection turn did not settle within ${CLOSING_RUN_SETTLE_MS / 1000}s of quit; its work may not have been persisted.`,
					);
				}
				// A compaction that was running at the quit (a manual one held by an extension's `session_before_compact` handler, or an
				// automatic one) gets the same bound: it ends cancelled before the session reports closed, or the timeout is disclosed.
				if (!(await runSettlesWithin(this._compaction.settled(), CLOSING_RUN_SETTLE_MS))) {
					this._holdUnlistenedWarning(
						`A compaction did not settle within ${CLOSING_RUN_SETTLE_MS / 1000}s of quit; its result is discarded.`,
					);
				}
				await this._memory.shutdown();
			} finally {
				// After memory: a history summary still in flight records its spend through this owner. The listeners are already
				// dropped, so a handoff raised here is held by the session; the runtime that ends it takes the held warnings.
				safely(() => this._semanticUsage.dispose());
			}
		});
		track(() => this._toolRecoveryLogger.shutdown());
		safely(() => cleanupSessionResources(this.sessionId));
		// Final sweep for any grep/find artifact already released (reference count zero) but
		// not yet reclaimed -- e.g. a release whose cleanup() call failed transiently. This is
		// conservative: it never releases a still-referenced artifact, so a session that ends
		// before context-gc ever evicts a result (too short to cross preserveRecentMessages)
		// correctly leaves that artifact in place, resolvable if the same session is resumed
		// later. It does not sweep OTHER sessions' artifact directories. Its failures are
		// required release failures and reject `disposeAndWait()`; they are not discarded.
		trackRequired(async () => {
			this._pipeline.cleanupToolArtifactStoreOnDispose();
		});
		this._workerContextPolicyLanes.clear();
		this._disposeCompletion = finish();
	}

	/**
	 * Disposes the session and waits for its shutdown. The warnings it still holds then go to its closing sink, unless the owner
	 * takes them itself: a runtime does, through takeUndeliveredWarnings, and passes `drainClosingWarnings: false`.
	 */
	async disposeAndWait(options?: { readonly drainClosingWarnings?: boolean }): Promise<void> {
		this.dispose();
		try {
			await this._disposeCompletion;
		} finally {
			if (options?.drainClosingWarnings !== false) {
				const warnings = this.takeUndeliveredWarnings();
				if (warnings.length > 0) this._onClosingWarnings(warnings);
			}
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

	/** A submission is preparing its turn (routing, System One classification): no response streams yet. */
	get isPreparingSubmission(): boolean {
		return this._promptSubmission.isPreparingSubmission;
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

	/** Effective cwd inside an admitted task workflow; startup cwd outside one. */
	get taskCwd(): string {
		return this._runtimeBuilder.taskCwd;
	}

	private _noteSystemOneTaskDirectoryUnavailable(error: unknown): void {
		// A verification that meets its task directory already released by a closing session is not a directory to repair: the session
		// is ending and the verification is not run. Say that, and keep the repair advice for a live session.
		if (this._disposed) {
			this._emit({
				type: "warning",
				message: "System One verification was not run because the session was closing; no judgment was recorded.",
			});
			return;
		}
		const reason = (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]+/gu, " ").slice(0, 240);
		this._emit({
			type: "warning",
			message: `System One verification was deferred because the active task directory is unavailable (${reason}). Repair it with task_directory; no judgment was recorded.`,
		});
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
	get nativeActivity(): NativePiActivityPort {
		return {
			foreground: this._foregroundRecovery,
			isSettled: () => isSessionSettled(this, this._hasPendingIdleContinuation()),
			subscribePendingContinuation: (listener) => this._subscribeIdleContinuationActivity(listener),
		};
	}

	/**
	 * Activate registered tools through model/provider availability and rebuild the prompt.
	 * Retain the unfiltered request so model changes can restore it. Artifact-producing tools
	 * activate their registered artifact_retrieve companion through this same public boundary;
	 * other tools require the explicit/default request. Registry presence already encodes grants.
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
		if (!this._isChildSession && requested.includes("memory")) {
			requested.push("zoom", "date");
		}
		const capabilityFiltered = filterToolNamesForCapability(requested, this.getModelCapabilityProfile(), this.model);

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
			validToolNames.some((name) => PACKED_TOOL_OUTPUT_TOOLS.has(name)) ||
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
		this._backgroundLanes.reconcileGoalContinuationToolAvailability(
			() => this._goals.resumeGoalToolAvailable() !== undefined,
		);

		this._checkContextWindowUsageWarning();
	}

	/** Request immediate transfer of one or all currently-running foreground tool calls. */
	backgroundRunningToolCalls(toolCallId?: string): number {
		if (!this.getActiveToolNames().includes("tool_task")) return 0;
		return this._backgroundToolTasks.requestHandoff(toolCallId);
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return this._compaction.isRunning() || this._treeNavigator.isRunning();
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

	getForegroundActivity(): { sessionId: string; epoch?: number; busy: boolean } {
		return this._foregroundRecovery.getActivitySnapshot(this.sessionManager.getSessionId());
	}

	getSessionWorkState(): SessionWorkState {
		const activity = this.getForegroundActivity();
		const hasRunningWorker = this._backgroundLanes
			.getLaneRecords()
			.some((lane) => lane.status === "queued" || lane.status === "running");
		const hasRunningTool = hasRunningBackgroundedToolCall(this._backgroundToolTasks.list());
		const hasPendingContinuation = this._hasPendingIdleContinuation();
		const goalSnapshot = this.getGoalStateSnapshot();
		const isBlocked = goalSnapshot?.status === "blocked";
		const isDone = goalSnapshot?.status === "completed";

		const isAwaitingUser = getResumableHumanInputSnapshot(this.sessionManager)?.status === "pending";
		const isObjectiveActive = goalSnapshot ? isGoalExecutionActive(goalSnapshot.status) : false;
		const hasActiveExecutionOrOwner =
			this.isStreaming ||
			this.isCompacting ||
			this.isRetrying ||
			this._foregroundRecovery.isRunActive ||
			activity.epoch !== undefined ||
			(this._systemOneController?.isEvaluating ?? false) ||
			this._semanticPlane.health.getHealth(true).state === "evaluating" ||
			hasRunningWorker ||
			hasRunningTool ||
			hasPendingContinuation ||
			isAwaitingUser;

		const livenessFault = Boolean(isObjectiveActive && !hasActiveExecutionOrOwner);

		return deriveSessionWorkState({
			isStreaming: this.isStreaming,
			isCompacting: this.isCompacting,
			isRetrying: this.isRetrying,
			hasSubmissionLease: activity.epoch !== undefined,
			isRunActive: this._foregroundRecovery.isRunActive,
			isSystemOneEvaluating: this._systemOneController?.isEvaluating ?? false,
			isSemanticEvaluating: this._semanticPlane.health.getHealth(true).state === "evaluating",
			hasRunningWorker,
			hasRunningTool,
			hasPendingContinuation,
			isAwaitingUser,
			isBlocked,
			isDone,
			livenessFault,
			epoch: activity.epoch,
			sessionId: this.sessionManager.getSessionId(),
			objectiveId: goalSnapshot?.goalId,
		});
	}

	/**
	 * Watchdog for orphaned objectives (F2 / OC-03):
	 * Detects an active objective with no owner, worker, evaluation, or continuation.
	 * Bounded recovery schedules an idle continuation pass; otherwise transitions to blocked.
	 */
	checkOrphanedObjectiveWatchdog(): boolean {
		const workState = this.getSessionWorkState();
		if (!workState.livenessFault) return false;

		// Bounded recovery: try scheduling continuation from idle
		if (!isInterruptedAssistantStopReason(this._findLastAssistantMessage()?.stopReason)) {
			this._backgroundLanes.scheduleGoalAutoContinueFromIdle();
			if (this._backgroundLanes.hasPendingIdleContinuation()) {
				return false;
			}
		}

		// Recovery exhausted or not allowed: block explicitly
		return this._goals.markLivenessFaultBlocked(
			workState.faultReason ?? "Liveness fault: objective has no active owner, worker, evaluation, or continuation",
		);
	}

	subscribeForegroundActivity(listener: () => void): () => void {
		return this._foregroundRecovery.subscribeActivity(listener);
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }> {
		return this._scopedModels;
	}

	/** Update scoped models for cycling. The router pool is separate state (see setRouterPool). */
	setScopedModels(scopedModels: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>): void {
		this._scopedModels = scopedModels;
	}

	/** Replace the router's scope; undefined restores all available favorites. */
	setRouterPool(pool: RouterPoolState | undefined): void {
		this._routerPool = pool;
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
	/**
	 * The opening's route becomes the conversation's talker: the session model (a recorded model change,
	 * so later turns and a resume run on it with no swap) at the judged thinking level, with the reason
	 * recorded as the conversation route.
	 */
	private async _adoptTalker(model: Model<Api>, decision: RouteDecision): Promise<void> {
		const current = this.model;
		if (!current || current.provider !== model.provider || current.id !== model.id) {
			await this._modelSelection.setModel(model, { persistSettings: false });
		}
		if (decision.thinkingLevel) {
			this._modelSelection.setThinkingLevel(decision.thinkingLevel as ThinkingLevel, { persistSettings: false });
		}
		this._recordTalker(model, decision.reasons);
		this._modelRouter.recordOpeningRoute(decision, model);
	}

	/**
	 * A hard failure (quota, an account that no longer offers the model) carries a chosen talker to the
	 * model the session moved to; before the opening there is no talker to carry.
	 */
	private _moveTalker(model: Model<Api>, reason: string): void {
		if (this.sessionManager.getLatestCustomEntryOnBranch(CONVERSATION_TALKER_CUSTOM_TYPE) === undefined) return;
		this._recordTalker(model, [reason]);
	}

	/** The conversation's talker from now on: later owner messages run on it with no route judged. */
	private _recordTalker(model: Model<Api>, reasons: readonly string[]): void {
		const record: ConversationTalkerRecord = {
			model: formatModelRouterModel(model),
			thinkingLevel: this.agent.state.thinkingLevel,
			reasons: [...reasons],
			decidedAt: Date.now(),
		};
		this.sessionManager.appendCustomEntry(CONVERSATION_TALKER_CUSTOM_TYPE, record);
	}

	/**
	 * A small message's side trip pays for itself when writing its brief on the side-trip model costs less
	 * than the talker reading its warm prefix to answer (`switchCostUsd`); a price-free side-trip model
	 * always does. Without prices on either side there is no evidence, and the talker answers.
	 */
	private _sideTripApproves(model: Model<Api>, text: string): boolean {
		return this._cache.sideTripApproves(model, text);
	}

	private _chooseObjectiveExecutor(route: ObjectiveRoute): "root" | "worker" {
		return this._cache.chooseObjectiveExecutor(route);
	}

	private _claimCorrection(turnOpening: AgentMessage): Promise<string | undefined> {
		return this._unsettledLadder.claimCorrection(turnOpening);
	}

	private async _runToolkitHit(
		scriptName: string,
		turnMessages: readonly AgentMessage[],
		signal?: AbortSignal,
	): Promise<void> {
		return runToolkitHit(
			{
				agent: this.agent,
				persistMessage: (message) => this._foregroundLifecycle.appendMessage(message),
				bash: this._bash,
				emit: (event) => this._emit(event),
			},
			scriptName,
			turnMessages,
			signal,
		);
	}

	/**
	 * The objective loop's retrieve route: the talker reads on its warm prefix, or minions (read-only
	 * workers, no forked turns) each gather one question on a small brief (`priceExecutor` decides, as
	 * for any route the root may take). Only accepted reports reach the talker, as one bounded evidence
	 * record on its next turn.
	 */
	private async _retrieveForObjective(route: ObjectiveRoute, signal?: AbortSignal): Promise<"root" | "worker"> {
		return this._cache.retrieveForObjective(route, signal);
	}

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
		return this._promptSubmission.prompt(text, options);
	}

	/** Await the detached end-of-work reflection turn, if one is running; see ReflectionTurnLifecycle. */
	async settleReflectionTurn(): Promise<void> {
		await this._reflectionTurnLifecycle.settle();
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async steer(text: string, images?: ImageContent[]): Promise<OwnerInputOutcome> {
		return this._queuedInputPersistence.admitQueuedOwnerInput("steer", text, images);
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async followUp(text: string, images?: ImageContent[]): Promise<OwnerInputOutcome> {
		return this._queuedInputPersistence.admitQueuedOwnerInput("followUp", text, images);
	}

	/**
	 * Keep owner input that cannot be submitted yet (the interactive queue while compaction runs) as held pending input:
	 * shown, takeable and recorded, so a restart restores it held. `prompt()` with `heldInput` sends it; `existing` is
	 * returned while it is still kept.
	 */
	keepQueuedInput(kind: "steer" | "followUp", text: string, images?: ImageContent[], existing?: PendingInputHandle) {
		return this._queuedInputPersistence.keepQueuedInput(kind, text, images, existing);
	}

	/**
	 * The one-time notice for input restored on resume. `editor` (the interactive default) tells the user to take
	 * the held input back into the editor; `headless` is for hosts with no editor, where the input stays held.
	 */
	takeRestoredQueuedInputNotice(surface: "editor" | "headless" = "editor"): string | undefined {
		return this._queuedInputPersistence.takeRestoredQueuedInputNotice(surface);
	}

	/** Surface held restored input as a session warning for hosts with no editor (print, JSON, RPC), so it is never silent. */
	announceRestoredQueuedInput(): void {
		this._queuedInputPersistence.announceRestoredQueuedInput();
	}

	private async _drainQueuedExtensionCommands(): Promise<void> {
		return this._queuedInputPersistence.drainQueuedExtensionCommands();
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
		} else if (
			this.getSessionWorkState().phase !== "continuation_armed" &&
			this.getSessionWorkState().busy &&
			!this._foregroundRecovery.ownsSubmission(submissionLease)
		) {
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
				appMessage,
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
		options?: SendUserMessageOptions,
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
		// The sender hears exactly one acceptance verdict: the prompt's own preflight verdict, or a
		// refusal when the submission ended (returned or threw) without reaching one.
		let verdictGiven = false;
		const giveVerdict = (accepted: boolean): void => {
			if (verdictGiven) return;
			verdictGiven = true;
			options?.onAccepted?.(accepted);
		};
		try {
			await this.prompt(text, {
				expandPromptTemplates: false,
				processSlashCommands: options?.processSlashCommands ?? false,
				streamingBehavior: options?.deliverAs,
				images,
				source: "extension",
				...(options?.origin ? { origin: options.origin } : {}),
				preflightResult: giveVerdict,
			});
		} finally {
			giveVerdict(false);
		}
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

	/** Take every queued input with its images and every queued extension command, emptying the queues. */
	takeAllQueuedInput(): { steering: QueuedInput[]; followUp: QueuedInput[]; commands: string[] } {
		const result = this._pendingQueue.takeAll();
		this._emitQueueUpdate();
		return result;
	}

	/** Take queued steering and follow-up messages (text and images) to send them another way. */
	takeQueuedMessages(): { steering: QueuedInput[]; followUp: QueuedInput[] } {
		const result = this._pendingQueue.takeMessages();
		this._emitQueueUpdate();
		return result;
	}

	/** Number of pending messages (includes steering, follow-up, and queued extension commands) */
	get pendingMessageCount(): number {
		return this._pendingQueue.count;
	}

	/** Pending messages a run will still deliver itself: `pendingMessageCount` minus held input awaiting the owner. */
	get deliverablePendingMessageCount(): number {
		return this._pendingQueue.deliverableCount;
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
	 * Abort current operation and wait for agent to become idle. The reason is required and names the
	 * abort in the persisted aborted message; use a short, stable, lower-case label.
	 */
	async abort(reason: string): Promise<void> {
		this._edgeIntent.abortOptionalIntent();
		// The interrupt cancels queued input whose admission is still undecided; admitted input stays queued.
		this._pendingQueue.cancelAwaiting();
		this._emitQueueUpdate();
		// A submission still preparing has no run to abort: cancel the submission itself.
		if (!this.agent.state.isStreaming) this._promptSubmission.abortSubmission(reason);
		this.runtimeUpdates.cancel();
		this.abortRetry();
		this.agent.abort(reason);
		await this.agent.waitForIdle();
	}

	/** What the session lane's idle compaction preparation is doing, for the Decision graph. */
	getIdlePreparationView(): IdlePreparationView | undefined {
		return this._compaction.getIdlePreparationView();
	}

	/**
	 * Resolve once no foreground submission holds the lease: the agent run has ended AND the prompt
	 * that owned it has finished its tail. `abort()` alone returns at the first of those; a caller
	 * that wants to submit a new root prompt right after an abort waits for the second.
	 */
	waitForForegroundIdle(): Promise<void> {
		return this._foregroundRecovery.waitForIdle();
	}

	/**
	 * Readonly settlement snapshot of the resources this session owns, read from each owner's own fields. It never recovers,
	 * admits, loads or resets anything, so it stays valid after disposal.
	 */
	getResourceSnapshot(): {
		readonly foregroundRecovery: ReturnType<ForegroundRecoveryController["getResourceSnapshot"]>;
		readonly terminalHandoffs: ReturnType<ForegroundTerminalHandoffController["getResourceSnapshot"]>;
		readonly backgroundToolTasks: ReturnType<BackgroundToolTaskController["getResourceSnapshot"]>;
		readonly eventListeners: number;
		readonly workers: ReturnType<BackgroundLaneController["getWorkerResourceSnapshot"]>;
	} {
		return {
			foregroundRecovery: this._foregroundRecovery.getResourceSnapshot(),
			terminalHandoffs: this._terminalHandoffs.getResourceSnapshot(),
			backgroundToolTasks: this._backgroundToolTasks.getResourceSnapshot(),
			eventListeners: this._eventListeners.length,
			workers: this._backgroundLanes.getWorkerResourceSnapshot(),
		};
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	/**
	 * An explicit model selection (`/model`, a model cycle, RPC, an extension): the selected model becomes
	 * the conversation's talker, so the opening route never replaces it.
	 */
	async setModel(model: Model<Api>, options: { persistSettings?: boolean } = {}): Promise<void> {
		await this._switchSessionModel(model, options);
		this._recordTalker(model, ["model selected"]);
	}

	private async _switchSessionModel(model: Model<Api>, options: { persistSettings?: boolean }): Promise<void> {
		this._compaction.cancelIdlePreparation();
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
		if (result?.model) this._recordTalker(result.model, ["model selected"]);
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
		this._treeNavigator.abort();
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

	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: Accessed by unit tests for compaction model resolution
	private _resolveCompactionModel(sessionModel: Model<Api>): Model<Api> {
		return this._compactionSupport.resolveModel(sessionModel);
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

	/** Whether auto-compaction is enabled: the effective setting compaction runs with, not only the stored flag. */
	get autoCompactionEnabled(): boolean {
		return this._getAdaptedCompactionSettings().enabled;
	}

	/**
	 * The ICM projection that owns this session's provider wire: the chat, or the fail-closed block while the chat is
	 * unavailable. Read from the projection memory installed, never from the selected setting, which leads it while a
	 * memory-mode change applies. A child session has no project chat (an activation failure installs the block without
	 * checking for one), so its wire is always its own history and its compaction stays session-wide.
	 */
	private _continuousChatWire(): ContinuousChatWire | undefined {
		return this._isChildSession ? undefined : this._memory.continuousChatWire();
	}

	/** Whether an ICM projection, the chat or its block, owns this session's provider wire. */
	private _isContinuousChatRoot(): boolean {
		return this._continuousChatWire() !== undefined;
	}

	/**
	 * The lineage the foreground's requests are made on. Under ICM a turn's requests carry only its frame and its own
	 * messages, so a turn is its own lineage until it applies a compaction, then that checkpoint's (the latest the rebuilt
	 * history holds). Between ICM turns no request is sent and the history's own lineage stands.
	 */
	private _foregroundLineage(): string {
		const turn = this._isContinuousChatRoot() ? this._memory.continuousChatHost()?.turns.current() : undefined;
		return turn === undefined || turn.latestCompaction !== undefined
			? historyLineage(this.agent.state.messages)
			: `icm-turn@${turn.startedAt}`;
	}

	/**
	 * Under ICM, what the running turn's requests carry for the context audit: its frame (chat view, live state) and the
	 * session entry its own messages begin at (the summary of a compaction it applied, or its first own message). While
	 * the chat is unavailable, no request is sent at all, and the audit says why.
	 */
	private _continuousChatAudit(): ContinuousChatAudit | undefined {
		const wire = this._continuousChatWire();
		if (wire === undefined) return undefined;
		if (wire.kind === "blocked") return { turn: undefined, blockedReason: wire.reason };
		const turn = this._memory.continuousChatHost()?.turns.current();
		if (turn === undefined) return { turn: undefined };
		const frame = continuousChatFrameMessages(turn, renderContinuousChatTurnState(turn));
		const messages = this.agent.state.messages;
		const resolved = resolveContinuousChatTurnStart(turn, messages);
		if ("error" in resolved) return { turn: { turnId: turn.turnId, frame, start: { unresolved: resolved.error } } };
		const first = messages[resolved.index];
		const entryId =
			first === undefined
				? undefined
				: first.role === "compactionSummary"
					? first.compactionEntryId
					: this.sessionManager.getMessageEntryId(first);
		return {
			turn: {
				turnId: turn.turnId,
				frame,
				start:
					entryId !== undefined
						? { entryId }
						: {
								unresolved:
									first === undefined
										? "the turn has no message of its own yet"
										: "the turn's first message is not persisted in the session yet",
							},
			},
		};
	}

	/** SDK startup and extension rebinding activate the selected provider generation. */
	initializeMemory(): Promise<void> {
		return this._memory.initialize();
	}

	getMemorySystem(): MemorySystem {
		return this.settingsManager.getMemorySystem();
	}

	setMemorySystem(system: MemorySystem): Promise<{ ok: boolean; message: string }> {
		return this._memory.setMemorySystem(system);
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
		assertReloadQuiescent(this._agentDir, this.isStreaming, this.isCompacting, "reload");
		this._foregroundLifecycle.reload();
		this._reflection.invalidateCurrentTurnCueStateCache();
		this.agent.state.messages = this.sessionManager.buildSessionContext().messages;
		// Extension/settings reload: guarded (see extension-binding-controller.ts) to never overlap
		// compaction, so this is always a genuine resync, never compaction's own within-lineage pack.
		this.agent.resetSanitizerPrefixHorizon();
		this._compaction.cancelIdlePreparation();
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

	/**
	 * Warm this session's shell so the first command does not pay its startup. A long-lived mode
	 * (interactive, RPC) calls this once the session is running; a short-lived or embedded caller
	 * that may never run a command leaves it alone.
	 */
	prewarmShell(): Promise<void> {
		return this._bash.prewarmShell();
	}

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
		const prev = this.getTaskStepsStateSnapshot();
		this._runtimeBuilder.assertTaskStepsTransition(prev?.steps, state.steps);
		return appendTaskStepsStateSnapshot(this.sessionManager, state);
	}

	/** Retrieve the latest valid native task-step state from the active session log. */
	getTaskStepsStateSnapshot(): TaskStepsState | undefined {
		return getLatestTaskStepsStateSnapshot(this.sessionManager);
	}

	/** An active goal or an in-progress task step: work the operator is still waiting on. */
	private _hasOpenWork(): boolean {
		const goal = this.getGoalStateSnapshot();
		if (goal && isGoalExecutionActive(goal.status)) return true;
		return this.getTaskStepsStateSnapshot()?.steps.some((step) => step.status === "in_progress") ?? false;
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

	onLaneRecordsChanged(listener: (records: readonly LaneRecord[]) => void): () => void {
		return this._backgroundLanes.subscribeLaneRecords(listener);
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

	/**
	 * A taken terminal handoff, as the project chat's `[name]` report. The text is the attempt's persisted claim; the chat
	 * keys the report by that attempt, so a redelivered handoff logs nothing twice.
	 */
	private reportWorkerTerminal(handoff: Readonly<WorkerTerminalHandoff>): void {
		this.persistWorkerTerminalReport(handoff.childAgentId, {
			laneId: handoff.record.laneId,
			attemptId: handoff.terminalAttemptId,
			status: handoff.record.status,
			...(handoff.record.completedAt ? { completedAt: handoff.record.completedAt } : {}),
			...(handoff.record.reasonCode ? { reasonCode: handoff.record.reasonCode } : {}),
		});
	}

	/** A managed or parentless terminal the outbox delivers, reported under the name its worker has. */
	private reportOutboxWorkerTerminal(record: WorkerTerminalHandoffRecord): void {
		this.persistWorkerTerminalReport(this._backgroundLanes.workerAgentIdForRecord(record), record);
	}

	/**
	 * The one owner of the project chat's `[name]` worker reports. Every accepted terminal reaches it once: the parent
	 * handoff, a managed (tmux) lane, and a terminal with no parent. The text is the attempt's persisted claim, or the
	 * terminal status when no claim exists. A worker's private steps are never logged. The chat keys the report by its
	 * attempt, or by the lane generation when no attempt is known, so a redelivered terminal logs nothing twice.
	 */
	private persistWorkerTerminalReport(
		name: string,
		terminal: { laneId: string; attemptId?: string; status: string; completedAt?: string; reasonCode?: string },
	): void {
		// Every entry, not the active branch: the attempt's terminal is this process's, whichever branch is active now.
		const entries = this.sessionManager.getEntries();
		const claim =
			terminal.attemptId === undefined
				? undefined
				: getWorkerClaimSnapshots(entries).find((candidate) => candidate.terminalAttemptId === terminal.attemptId);
		const claimId = terminal.attemptId ?? `lane:${terminal.laneId}:${terminal.completedAt ?? ""}:${terminal.status}`;
		if (
			entries.some(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === CONTINUOUS_CHAT_WORK_REPORT_CUSTOM_TYPE &&
					(entry.data as { claimId?: unknown } | undefined)?.claimId === claimId,
			)
		) {
			return;
		}
		const reason = terminal.reasonCode ? ` (${terminal.reasonCode})` : "";
		const report: ContinuousChatWorkReportEntry = {
			version: 1,
			name,
			claimId,
			text: claim ? workerReportClaimText(claim) : `Terminal status ${terminal.status}${reason}.`,
			timestamp: Date.now(),
		};
		this.sessionManager.appendCustomEntry(CONTINUOUS_CHAT_WORK_REPORT_CUSTOM_TYPE, report);
	}

	/** The prefix a chat compaction repeats: the accepted request's, or the agent's current one before any request. */
	private _continuousChatPrefixHead() {
		return this._continuousChatPrefix.resolve(() => continuousChatPrefixOf(this.agent.state));
	}

	saveWorkerClaimSnapshot(claim: WorkerClaim, request?: WorkerRequest, options?: { cwd?: string }): string {
		const entryId = appendWorkerClaimSnapshot(this.sessionManager, claim, request, options);
		this.recordAcceptedWorkerEvidence();
		return entryId;
	}

	/**
	 * Makes accepted worker proof citable by the goal's completion account. It runs after every claim save and
	 * every review acknowledgement (a claim flagged for review only becomes covered once acknowledged). It never
	 * satisfies a requirement, and a failure here must not report a saved claim as unsaved.
	 */
	recordAcceptedWorkerEvidence(): void {
		try {
			recordAcceptedWorkerRequirementEvidence({
				getGoalState: () => this._goals.getState(),
				saveGoalState: (state, expected) => this._goals.saveState(state, expected),
				getTaskRuntimeSnapshot: () => this._backgroundLanes.getTaskRuntimeSnapshot(),
				getWorkerClaimSnapshots: () => this.getWorkerClaimSnapshots(),
			});
		} catch (error) {
			this._emit({
				type: "warning",
				message: `Worker evidence for the goal was not recorded: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
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
	 * The evidence-driven tier inside the capability class (see capability-tier.ts): the class says
	 * what a model can carry, the tier says which defaults it has earned. Read from the adaptation
	 * store so a demotion recorded by an earlier session still applies.
	 */
	getCapabilityTierPolicy(): CapabilityTierPolicy {
		const demotion = this.model
			? this._modelAdaptationStore.get(formatModelRouterModel(this.model)).capabilityTier
			: undefined;
		return capabilityTierPolicy(
			resolveCapabilityTier({ capabilityClass: this.getModelCapabilityProfile().class, demotion }),
		);
	}

	/**
	 * Whether the CURRENT session model may drive a lane worker. This is the authoritative check a
	 * launched worker runs on the model it actually resolved; see {@link laneWorkerRefusalFor}.
	 */
	getLaneWorkerRefusal(): LaneWorkerRefusal | undefined {
		return this.laneWorkerRefusalFor(this.model);
	}

	/**
	 * Parent-side pre-launch check for a child `pi` process: the model the CHILD will resolve (its
	 * explicit selection, else its own startup resolution), never this session's model.
	 */
	async getLaunchedWorkerLaneRefusal(
		selection: { provider?: string; model?: string } = {},
	): Promise<LaneWorkerRefusal | undefined> {
		const child = await resolveLaunchedChildModel({
			cliProvider: selection.provider,
			cliModel: selection.model,
			enabledModels: this.settingsManager.getEnabledModels(),
			defaultProvider: this.settingsManager.getDefaultProvider(),
			defaultModelId: this.settingsManager.getDefaultModel(),
			modelRegistry: this._modelRegistry,
		});
		return child ? this.laneWorkerRefusalFor(child) : { reason: "model_unresolved", capabilityClass: "chat" };
	}

	/**
	 * Lane-worker eligibility of `model` (see `evaluateLaneWorkerModelRefusal` in model-capability.ts):
	 * full capability class, a DECLARED (not registry-defaulted) context window, and a native tool-call
	 * path that is declared or probe-proven and not demoted -- the transport facts come from the single
	 * `resolveModelToolProtocol` resolver. Unknown metadata or a missing model refuses. `undefined`
	 * means eligible.
	 */
	private laneWorkerRefusalFor(model: Model<Api> | undefined): LaneWorkerRefusal | undefined {
		if (!model) return { reason: "model_unresolved", capabilityClass: "chat" };
		return evaluateLaneWorkerModelRefusal({
			model,
			capabilityMode: this.settingsManager.getModelCapabilitySettings().mode,
			toolProtocol: this._resolveModelToolProtocol(model),
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
	 * A stronger model settles a handed-off owner question only on a basis the owner's request states,
	 * and System One checks that basis before the agent may use the answer.
	 */
	private async _consultStrongerModel(input: {
		question: string;
		request: string;
		signal?: AbortSignal;
	}): Promise<OwnerQuestionConsult | undefined> {
		return this._unsettledLadder.consultStrongerModel(input);
	}

	/**
	 * A worker's inconclusive findings on the ladder. What stays open goes to the owner: under a handoff
	 * it is written to the follow-up document so the run moves on around it; with the owner in the
	 * loop the parent is told to ask them.
	 */
	private async _settleWorkerInconclusive(input: {
		items: readonly string[];
		messages: Parameters<typeof toolResultEvidence>[0];
		signal?: AbortSignal;
	}): Promise<{ settled: readonly string[]; unsettled: readonly string[]; ownerFollowUp?: string }> {
		return this._unsettledLadder.settleWorkerInconclusive(input);
	}

	private _announceOwnerFollowUpsWhenPresent(): void {
		this._unsettledLadder.announceOwnerFollowUpsWhenPresent();
	}

	/** One owner-completion boundary shared by the goal tool and objective-primary loop. */
	private _resolveGoalCompletionOwnerDecision(input: GoalCompletionOwnerDecisionInput, signal?: AbortSignal) {
		return this._unsettledLadder.resolveGoalCompletionOwnerDecision(input, signal);
	}

	/**
	 * Items nothing could settle go to the owner by the host, never by trusting a model to relay them:
	 * written to the follow-up document under a handoff, and posted to the owner when the turn ends.
	 */
	private _deliverToOwner(items: readonly string[]): string | undefined {
		return this._unsettledLadder.deliverToOwner(items);
	}

	/** Post this turn's unsettled items to the owner as one displayed message, then clear them. */
	private async _flushOwnerItems(lease: ForegroundSubmissionLease | undefined): Promise<void> {
		return this._unsettledLadder.flushOwnerItems(lease);
	}

	/** Machine-wide provider load: in-flight requests, recorded limits, provider windows, the stop. */
	getProviderLoadView(): ProviderLoadView {
		return buildProviderLoadView({
			agentDir: this._agentDir,
			ledger: this._providerAdmissionLedger,
			limits: this._providerLimitStore,
			configuredLimits: this.settingsManager.getProviderAdmissionSettings().limits,
		});
	}

	/** Engage or lift the machine-wide emergency stop (`<agentDir>/ESTOP`). Returns true when the state changed. */
	setEmergencyStop(engaged: boolean, reason?: string): boolean {
		if (engaged) {
			engageEmergencyStop(this._agentDir, reason);
			return true;
		}
		return liftEmergencyStop(this._agentDir);
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
		/** True only when every turn in this pass explicitly asked Pi to remember durable information. */
		explicitUserMemoryInstruction?: boolean;
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

	/**
	 * Decide and apply a background learner's returned proposals under this session's autonomy mode
	 * and autoLearn eligibility. The learner process wrote nothing; every entry gets a report row.
	 */
	applyAutoLearnProposals(set: AutoLearnProposalSet, runId: string): Promise<AutoLearnReportEntry[]> {
		return decideAutoLearnProposals(set, runId, {
			settingsManager: this.settingsManager,
			skillVault: this._skillVault,
			applyWrites: (rawWrites, id) => this._reflection.applyLearnerWrites(rawWrites, { runId: id }),
		});
	}

	getSelfCompactionView(): SelfCompactionView {
		return this._selfCompaction.view();
	}

	resumeSelfCompaction(): boolean {
		return this._selfCompaction.schedule();
	}

	waitForSelfCompactionHandoff(): Promise<void> {
		return this._selfCompaction.whenSettled();
	}

	getSelfCompactionInfo(): SelfCompactionInfo {
		return this._selfCompaction.info();
	}

	selfCompactNow(): Promise<SelfCompactionNowOutcome> {
		return this._selfCompaction.compactNow();
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

	/** Owner control-plane access for the native /secrets TUI. Never exposed as an agent tool. */
	get credentialManager(): CredentialManager {
		return this._runtimeBuilder.credentialManager;
	}
}
