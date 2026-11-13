import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { Api, AssistantMessage, ImageContent, Model, TextContent, Usage } from "@caupulican/pi-ai";
import { modelsAreEqual } from "@caupulican/pi-ai/models";
import { cleanupSessionResources } from "@caupulican/pi-ai/session-resources";
import { getAgentDir, VERSION, VERSION_SOURCE_AVAILABLE } from "../config.ts";
import type { Agent } from "../kernel/agent.ts";
import type { CompactionResult, CompactionSettings } from "../kernel/compaction/compaction.ts";
import { messageRevision } from "../kernel/message-revision.ts";
import type { CustomMessage } from "../kernel/messages.ts";
import { classifyFailure } from "../kernel/reliability/index.ts";
import type { SessionManager, SessionRequestSnapshotInput } from "../kernel/session/session-manager.ts";
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
import { readAgentIdentity } from "./agent-identity.ts";
import { continuousChatSpendFile, resourceDir, stateFile } from "./agent-paths.ts";
import {
	type AgentSessionAgentHookPorts,
	installSessionRequestHooks,
	installSessionToolArgumentHook,
} from "./agent-session-agent-hooks.ts";
import { createSessionBackgroundToolTasks } from "./agent-session-background-tasks.ts";
import {
	attachSessionAdaptiveRuntime,
	buildSessionContextCompositionReport,
	createGoalProofWrites,
	createLessonRoutePort,
	createSessionOperatorProjection,
	createSessionProjectRules,
	createSessionProviderRequestContext,
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
import { AgentSessionEvents } from "./agent-session-events.ts";
import { handleRunawayStop, handleToolValidationEscalation, type SessionGuardDeps } from "./agent-session-guards.ts";
import { AgentSessionMessageDelivery } from "./agent-session-message-delivery.ts";
import { AgentSessionModelAccess } from "./agent-session-model-access.ts";
import { AgentSessionToolActivation } from "./agent-session-tool-activation.ts";
import { AgentSessionWorkState } from "./agent-session-work-state.ts";
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
import { BackgroundLaneController, type SessionChannelsView } from "./background-lane-controller.ts";
import type { BackgroundToolTaskController } from "./background-tool-task-controller.ts";
import { BashExecutionController } from "./bash-execution-controller.ts";
import { type CapabilityTierPolicy, capabilityTierPolicy, resolveCapabilityTier } from "./capability-tier.ts";
import { DEFAULT_OWNER_QUOTA_MAX_USED_PERCENT } from "./channels/channel-policy.ts";
import type { NativePiActivityPort } from "./collaboration/native-pi-activity.ts";
import { RETENTION_AUDIT_CUSTOM_TYPE } from "./compaction/evidence-retention-projection.ts";
import type { createRetentionDecisionEngine } from "./compaction/retention-decision-engine.ts";
import {
	createSelfCompactToolDefinition,
	latestCachedReadTokens,
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
import type { PromptEnforcementReport } from "./context/context-prompt-enforcement.ts";
import type { PromptPolicyGcCorrelationReport, PromptPolicyShadowReport } from "./context/context-prompt-policy.ts";
import {
	knowledgeCollectionNotice,
	type MemoryPromptInclusionReport,
	type TranscriptHistoryStatus,
} from "./context/memory-diagnostics.ts";
import type { MemoryProvider as ContextMemoryProvider } from "./context/memory-provider-contract.ts";
import type { MemoryRetrievalReport } from "./context/memory-retrieval.ts";
import type { PathAliasTable } from "./context/path-alias-table.ts";
import { estimatePromptHeadroom } from "./context/prompt-headroom.ts";
import type { ContextGcReport } from "./context-gc.ts";
import { ContextPipeline } from "./context-pipeline.ts";
import type { SessionCostSummary, SessionTaskAndModelSummary } from "./cost/cost-summary.ts";
import type { DailyUsageTotals } from "./cost/daily-usage.ts";
import type { CostGuardDecision, CostGuardSettings } from "./cost-guard.ts";
import { CostGuardController } from "./cost-guard-controller.ts";
import type { ManagedLaneView } from "./delegation/managed-lane-views.ts";
import type {
	PersistentBotRecord,
	PersistentBotView,
	PersistentTeamRecord,
	UpsertPersistentBotInput,
	UpsertPersistentTeamInput,
} from "./delegation/persistent-bot-team-store.ts";
import {
	appendWorkerClaimSnapshot,
	getWorkerClaimSnapshotForAttempt,
	getWorkerClaimSnapshots,
} from "./delegation/session-worker-claim.ts";
import type { WorkerResponseObservation } from "./delegation/worker-attempt-executor.ts";
import type { WorkerDelegationRequest } from "./delegation/worker-delegation-request.ts";
import { createWorkerEdgePolicy } from "./delegation/worker-edge-policy.ts";
import type { WorkerTerminalHandoffRecord } from "./delegation/worker-notification-coordinator.ts";
import { createWorkerRequestPlanner } from "./delegation/worker-request-planner.ts";
import { createWorkerSettlementPolicy } from "./delegation/worker-settlement-policy.ts";
import { createWorkerSkillAccess } from "./delegation/worker-skill-access.ts";
import type { WorkerTerminalHandoff } from "./delegation/worker-terminal-handoff-coordinator.ts";
import { DurableCustomMessageTurnController } from "./durable-custom-message-turn-controller.ts";
import type { PeerReviewController } from "./expert-routing/peer-review.ts";
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
import type { ChannelProvider, JobSchedulerProvider } from "./gateways/channel-provider.ts";
import { reportGithubOriginPinForSession } from "./github-origin-pin.ts";
import { isOwnIdleContinuationAdmission } from "./goals/goal-auto-continue-controller.ts";
import { recordObjectiveClarification } from "./goals/goal-clarification-log.ts";
import type { GoalCompletionOwnerDecisionInput } from "./goals/goal-completion-owner-decision.ts";
import type { GoalStateRevision } from "./goals/goal-lifecycle.ts";
import type { GoalRuntimeSnapshot, GoalRuntimeSnapshotSettings } from "./goals/goal-runtime-snapshot.ts";
import { GoalSessionController } from "./goals/goal-session-controller.ts";
import { type GoalState, isGoalExecutionActive } from "./goals/goal-state.ts";
import { hasGoalContinuationControl } from "./goals/goal-tool-names.ts";
import { HarnessNoticeController } from "./harness-notice.ts";
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
	type ContinuousChatWire,
	continuousChatTurnAudit,
	resolveContinuousChatTurnStart,
} from "./memory/continuous-chat-projection.ts";
import { readContinuousChatSettings, validateContinuousChatSummaryModel } from "./memory/continuous-chat-settings.ts";
import { ContinuousChatSpendMeter } from "./memory/continuous-chat-spend.ts";
import { knowledgeSessionHooks } from "./memory/knowledge-announcement.ts";
import { MemoryController, type MemoryOperatorPort } from "./memory-controller.ts";
import {
	deriveModelCapabilityProfile,
	evaluateLaneWorkerModelRefusal,
	type LaneWorkerRefusal,
	type ModelCapabilityProfile,
} from "./model-capability.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { resolveLaunchedChildModel } from "./model-resolver.ts";
import { AccountModelCatalog } from "./model-router/account-models.ts";
import {
	type RouterCandidatePool,
	type RouterPoolState,
	resolveRouterCandidatePool,
	workerModelAllocator,
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
import { resolveConfiguredOrchestrationModel } from "./orchestration/model-binding.ts";
import { validateOrchestrationProfile } from "./orchestration/profile-registry.ts";
import { claimSessionBundleLease } from "./orchestration/session-bundle-lifecycle.ts";
import { OwnerChannelSession } from "./owner-channel-session.ts";
import type { ReturnBriefController } from "./owner-decisions/return-brief-controller.ts";
import { OwnerInputLedger, type OwnerInputOutcome } from "./owner-input-ledger.ts";
import { createOwnerInputPublicationObserver } from "./owner-input-publication-observer.ts";
import {
	ownerSteerWake,
	type PendingInputHandle,
	PendingInputQueueController,
	type QueuedInput,
} from "./pending-input-queue-controller.ts";
import { appendPipelineRunSnapshot, getLatestPipelineRunSnapshot, type PipelineRun } from "./pipelines/index.ts";
import { createProactivityToolDefinition } from "./proactivity/proactivity-tool.ts";
import { ProfileFilterController } from "./profile-filter-controller.ts";
import { DurableOwnerRuleStore, type OwnerRulePolicy } from "./project-rules/durable-owner-rules.ts";
import type { SessionProjectRules } from "./project-rules/session-project-rules.ts";
import type { RuleRepairWork } from "./project-rules/types.ts";
import { PromptSubmissionController } from "./prompt-submission-controller.ts";
import type { PromptTemplate } from "./prompt-templates.ts";
import { resolveProviderAccountKey } from "./provider-admission/account-key.ts";
import { engageEmergencyStop, liftEmergencyStop } from "./provider-admission/emergency-stop.ts";
import { openProviderAdmission } from "./provider-admission/gate.ts";
import { type ProviderAdmissionLedger, providerAdmissionDir } from "./provider-admission/ledger.ts";
import type { ProviderLimitStore } from "./provider-admission/limit-state.ts";
import { buildProviderLoadView, type ProviderLoadView } from "./provider-admission/load-view.ts";
import {
	openSubscriptionAllowance,
	type SubscriptionAllowancePort,
} from "./provider-admission/subscription-allowance.ts";
import { ProviderRequestRuntimeController } from "./provider-request-runtime-controller.ts";
import { QueuedInputPersistenceController } from "./queued-input-persistence-controller.ts";
import { ReflectionController } from "./reflection-controller.ts";
import { ReflectionTurnLifecycle } from "./reflection-turn-lifecycle.ts";
import { LaneModelResolver } from "./research/lane-model-resolver.ts";
import type { ModelFitnessReport } from "./research/model-fitness.ts";
import {
	appendEvidenceBundleSnapshot,
	getEvidenceBundleSnapshots,
	getLatestEvidenceBundleSnapshot,
} from "./research/session-evidence-bundle.ts";
import { collectWorkspaceSources } from "./research/workspace-collector.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { RuleHookDelivery } from "./rule-hooks/rule-hook-delivery.ts";
import { RuntimeBuilder, type RuntimeReloadOptions } from "./runtime-builder.ts";
import {
	type RuntimeMutationHandoff,
	type RuntimeWorkLease,
	runtimeGenerationAdmission,
} from "./runtime-generation-admission.ts";
import { RuntimeUpdateController } from "./runtime-update-controller.ts";
import type { CredentialManager } from "./secrets/credential-manager.ts";
import { SessionAnalytics } from "./session-analytics.ts";
import { SessionCacheController } from "./session-cache-controller.ts";
import { SessionEdgeIntentController } from "./session-edge-intent-controller.ts";
import { SessionImageStore } from "./session-image-store.ts";
import { isWorkerSession } from "./session-role.ts";
import { SessionRuntimeAdmissionController } from "./session-runtime-admission-controller.ts";
import { SessionSemanticPlaneController } from "./session-semantic-plane-controller.ts";
import { hasRunningBackgroundedToolCall, isSessionSettled } from "./session-settlement.ts";
import { createSessionShutdownTracker, settleClosingSessionMemory } from "./session-shutdown.ts";
import { getActiveSessionBranchEntries } from "./session-snapshot.ts";
import { buildSessionStreamFn, isRawStreamSimpleFn } from "./session-stream-chain.ts";
import { SessionSystemPromptController } from "./session-system-prompt-controller.ts";
import { SessionTreeNavigator, type TreeNavigationResult } from "./session-tree-navigator.ts";
import { SessionUnsettledLadderController } from "./session-unsettled-ladder-controller.ts";
import type { SessionWorkState } from "./session-work-state.ts";
import type { MemorySystem, ResourceProfileFilterSettings, SettingsScope } from "./settings/settings-schema.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { resolveActiveSkillBodyByteLimit, SkillVaultController } from "./skill-vault.ts";
import { skillsForSessionRole } from "./skills.ts";
import { SoulController } from "./soul/soul-controller.ts";
import type { SystemOneSteeringPlane } from "./steering/system-one-steering-plane.ts";
import type { WorkerSupervisionCoordinator } from "./supervision/worker-supervision-coordinator.ts";
import { formatClarificationQuestion } from "./system-one/clarification.ts";
import type { SystemOneController } from "./system-one/controller.ts";
import {
	appendOwnerFollowUp,
	type OwnerQuestionConsult,
	ownerFollowUpPath,
} from "./system-one/owner-question-routing.ts";
import { changesPlan, reviewPlan } from "./system-one/plan-review.ts";
import type { SemanticUncertaintyPort } from "./system-one/semantic-doubts.ts";
import type { SemanticEvaluationRecord } from "./system-one/semantic-evaluation-ledger.ts";
import type { SemanticPlaneHealth } from "./system-one/semantic-plane-health.ts";
import type { SemanticVerificationObligationView } from "./system-one/verification-obligations.ts";
import { createSessionWorkerControl, type SystemOneWorkerControl } from "./system-one/worker-control.ts";
import { SystemPromptBuilder } from "./system-prompt-builder.ts";
import { appendTaskStepsStateSnapshot, getLatestTaskStepsStateSnapshot } from "./tasks/session-task-state.ts";
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
import { ToolPerformanceStore } from "./tool-selection/tool-performance-store.ts";
import {
	createWorkerToolSelection,
	formatToolSelectionReport,
	ToolSelectionController,
} from "./tool-selection/tool-selection-controller.ts";
import { mutationScopeForWorktree } from "./tools/file-mutation-queue.ts";
import type { BashOperations, BashResult } from "./tools/schemas/bash.ts";
import { disposeShellExecutionSessionAndWait } from "./tools/shell-execution-session.ts";
import { checkedExtensionMessage } from "./turn-origin.ts";
import type { TimerPort } from "./util/timer-port.ts";
import type { WaitStatusEvent } from "./util/wait.ts";
import { currentWorkUnit, openWorkUnit } from "./work-units.ts";
import type { WorktreeSyncEnginePorts } from "./worktree-sync/runtime.ts";

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
	type SessionStats,
	type WorkerDelegationRunOutcome,
} from "./agent-session-contracts.ts";
import { type SessionSemanticUsageDelivery, sessionSemanticUsageOf } from "./cost/semantic-usage-delivery.ts";
import type { SpawnedUsageTotals } from "./cost/usage-records.ts";

export type { ToolProbeReport, ToolProbeResult, ToolProbeVerdict } from "./tool-protocol-controller.ts";

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

	private _unsubscribeAgent?: () => void;
	private _unsubscribeSettingsChanges?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private readonly _onClosingWarnings: (warnings: readonly string[]) => void;
	private _extensionsChangedListeners: Array<() => void> = [];

	/** Steering/follow-up/extension-command queues (see pending-input-queue-controller.ts); assigned
	 * in the constructor body since it depends on `_skillVault` and `_goals` being ready. */
	private readonly _pendingQueue: PendingInputQueueController;
	/** Owner-input identities (minted at acceptance) and the one Delivered point: the input's user entry persisted. */
	private readonly _ownerReturnBrief: ReturnBriefController;
	private readonly _ownerInputs = new OwnerInputLedger((message) => this._foregroundLifecycle.warn(message));
	/** The owner's words from a verified owner channel: their delivery and the held drafts' control (the channels core's). */
	readonly ownerChannel = new OwnerChannelSession(
		this,
		() => this._foregroundRecovery,
		(reason) => this._promptSubmission.abortSubmission(reason),
		() => this.sessionManager,
		() => this._disposed,
		(maxUsedPercent) => this._subscriptionAllowance.read(maxUsedPercent),
		() => this._ownerReturnBrief.queue(),
	);
	/** The usage the running model's subscription reports, read for the owner channel's dollar bounds (`OwnerChannelDelivery.quotaAllowance`). */
	private _subscriptionAllowance!: SubscriptionAllowancePort;
	private _pendingNextTurnMessages: CustomMessage[] = [];
	/**
	 * The last tool set requested via setActiveToolsByName BEFORE model-capability filtering, so
	 * switching from a small-window model back to a large one restores the full requested set.
	 */
	private _requestedActiveToolNames: string[] | undefined;

	private _unboundToolGrantWarnings: string[] = [];

	private readonly _modelSelection: ModelSelectionController;
	private readonly _bash: BashExecutionController;
	private readonly _profileFilter: ProfileFilterController;
	private readonly _toolGate: ToolGateController;
	private readonly _ruleHooks = new RuleHookDelivery({
		getMessages: () => this._memory.requestHistory(this.agent.state.messages),
		isRootSession: () => !this._isChildSession,
		isToolActive: (name) => this.getActiveToolNames().includes(name),
	});
	private readonly _mutationLedger = new ObjectiveMutationLedger();
	private readonly _repositoryObserver = new RepositoryMutationObserver(this._mutationLedger);
	private readonly _deployAdapters = new TrustedDeployAdapterRegistry();
	private readonly _toolSelection: ToolSelectionController;
	private readonly _toolPerformanceStore: ToolPerformanceStore;
	private readonly _modelAdaptationStore: ModelAdaptationStore;

	private _extensionRunner!: ExtensionRunner;
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
	/** The owner's session-scoped system prompt override (`/sysprompt`). */
	readonly ownerSystemPrompt: SessionSystemPromptController;
	/** The agent-soul file: the root agent's write gate, and the owner's edit, review and history. */
	readonly soul: SoulController;
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
	private readonly _harnessNotices: HarnessNoticeController;
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
	/** Usage/cost/stats accounting, /context estimate, and session export (see session-analytics.ts);
	 * owns the spawned-usage and daily-usage memo caches. */
	private readonly _analytics: SessionAnalytics;
	readonly spawnedUsageReceipts: ReturnType<SessionAnalytics["createSpawnedUsageReceiptPort"]>;
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
	private readonly _runtimeAdmission: SessionRuntimeAdmissionController;
	private readonly _runtimeMutationWaitClock: TimerPort;
	private _closingRuntimeWaitOnly = false;
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
	/** The proof this session records on its goal from its workers: accepted claim evidence and the host's own checks. */
	private readonly goalProof = createGoalProofWrites({
		getGoalState: () => this._goals.getState(),
		saveGoalState: (state, expected) => this._goals.saveState(state, expected),
		getTaskRuntimeSnapshot: () => this._backgroundLanes.getTaskRuntimeSnapshot(),
		getWorkerClaimSnapshots: () => this.getWorkerClaimSnapshots(),
		warn: (message) => this._emit({ type: "warning", message }),
	});
	// Coordinator slices (agent-session-*.ts): each owns one responsibility and reads its owners through lazy ports.
	private readonly _agentEvents = new AgentSessionEvents({
		agent: () => this.agent,
		cwd: () => this._cwd,
		sessionManager: () => this.sessionManager,
		runtimeUpdates: () => this.runtimeUpdates,
		model: () => this.model,
		pendingQueue: () => this._pendingQueue,
		goals: () => this._goals,
		skillVault: () => this._skillVault,
		toolRecoveryLogger: () => this._toolRecoveryLogger,
		modelRouter: () => this._modelRouter,
		compaction: () => this._compaction,
		terminalHandoffs: () => this._terminalHandoffs,
		foregroundLifecycle: () => this._foregroundLifecycle,
		durableCustomMessageTurns: () => this._durableCustomMessageTurns,
		memory: () => this._memory,
		reflection: () => this._reflection,
		pipeline: () => this._pipeline,
		foregroundRecovery: () => this._foregroundRecovery,
		toolSelection: () => this._toolSelection,
		deliveryToolCalls: () => this._deliveryToolCalls,
		earlyDisplayedUserMessages: () => this._earlyDisplayedUserMessages,
		closingConsumerReleased: () => this._closingConsumerReleased,
		disposed: () => this._disposed,
		extensionRunner: () => this._extensionRunner,
		isClosingRuntimeWaitOnly: () => this._closingRuntimeWaitOnly,
		getListeners: () => this._eventListeners,
		holdUnlistenedWarning: (message) => this._holdUnlistenedWarning(message),
		emitQueueUpdate: () => this._emitQueueUpdate(),
		setDeliveryState: (state) => this.setDeliveryState(state),
		refreshForegroundEnvelope: () => this._refreshForegroundEnvelope(),
		recordCacheObservation: (message) => this._recordCacheObservation(message),
	});
	private readonly _modelAccess = new AgentSessionModelAccess({
		foregroundRecovery: () => this._foregroundRecovery,
		accountModels: () => this._accountModels,
		modelRegistry: () => this._modelRegistry,
		modelRouter: () => this._modelRouter,
		modelSelection: () => this._modelSelection,
		sessionManager: () => this.sessionManager,
		agent: () => this.agent,
		model: () => this.model,
		emit: (event) => this._emit(event),
		switchSessionModel: (model, options) => this._switchSessionModel(model, options),
		extensionRunner: () => this._extensionRunner,
	});
	private readonly _toolActivation = new AgentSessionToolActivation({
		runtimeAdmission: () => this._runtimeAdmission,
		isChildSession: () => this._isChildSession,
		getModelCapabilityProfile: () => this.getModelCapabilityProfile(),
		model: () => this.model,
		runtimeBuilder: () => this._runtimeBuilder,
		agent: () => this.agent,
		pipeline: () => this._pipeline,
		pathAliasWrappedTools: () => this._pathAliasWrappedTools,
		cwd: () => this._cwd,
		systemPromptBuilder: () => this._systemPromptBuilder,
		backgroundLanes: () => this._backgroundLanes,
		goals: () => this._goals,
		checkContextWindowUsageWarning: () => this._checkContextWindowUsageWarning(),
		setBaseSystemPrompt: (prompt) => {
			this._baseSystemPrompt = prompt;
		},
		setRequestedActiveToolNames: (names) => {
			this._requestedActiveToolNames = names;
		},
	});
	private readonly _messageDelivery = new AgentSessionMessageDelivery({
		runtimeAdmission: () => this._runtimeAdmission,
		foregroundRecovery: () => this._foregroundRecovery,
		foregroundLifecycle: () => this._foregroundLifecycle,
		backgroundToolTasks: () => this._backgroundToolTasks,
		agent: () => this.agent,
		pendingNextTurnMessages: () => this._pendingNextTurnMessages,
		getSessionWorkState: () => this.getSessionWorkState(),
		sendCustomMessage: (message, options) => this.sendCustomMessage(message, options),
		emit: (event) => this._emit(event),
		promptWithRuntimeLease: (text, options, runtimeLease) =>
			this._promptWithRuntimeLease(text, options, runtimeLease),
	});
	private readonly _workState = new AgentSessionWorkState({
		getForegroundActivity: () => this.getForegroundActivity(),
		backgroundLanes: () => this._backgroundLanes,
		backgroundToolTasks: () => this._backgroundToolTasks,
		hasPendingIdleContinuation: () => this._hasPendingIdleContinuation(),
		getGoalStateSnapshot: () => this.getGoalStateSnapshot(),
		isStreaming: () => this.isStreaming,
		isCompacting: () => this.isCompacting,
		isRetrying: () => this.isRetrying,
		foregroundRecovery: () => this._foregroundRecovery,
		semanticPlane: () => this._semanticPlane,
		sessionManager: () => this.sessionManager,
		findLastAssistantMessage: () => this._findLastAssistantMessage(),
		goals: () => this._goals,
		isDisposed: () => this._disposed,
	});
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
	private readonly _accountModels: AccountModelCatalog;
	/** Providers whose usage-limit episode already told the owner about redeemable resets. */
	private readonly _subscriptionResetOffered = new Set<string>();
	private readonly _subscriptionResetChecking = new Set<string>();
	private _executionLoopMode?: ExecutionLoopMode;
	private _objectiveExecutionController?: ObjectiveExecutionController;
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
		const bundleLease = claimSessionBundleLease(
			config.bundleLease,
			config.agentDir ?? getAgentDir(),
			config.sessionManager.getSessionId(),
			config.sessionManager.isPersisted(),
		);
		this.agent = config.agent;
		this.settingsManager = config.settingsManager;
		this._onClosingWarnings = config.onClosingWarnings ?? writeTerminalWarnings;
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
		this._agentDirForLedger = config.agentDir ?? getAgentDir();
		this._semanticPlane = new SessionSemanticPlaneController({
			agentDirForLedger: this._agentDirForLedger,
			isDisposed: () => this._disposed,
			getSessionManager: () => this.sessionManager,
			getSystemOneSettings: () => this.settingsManager.getSystemOneSettings(),
			source: config.systemOne,
			controller: config.systemOneController,
			steeringPlane: config.steeringPlane,
		});
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
			getGoalState: () => this._goals.getState(),
			executeObjectiveRootRoute: (route, signal) => this._goals.objectiveRootExecutor().execute(route, signal),
			runWorkerDelegationOnce: (request) => this.runWorkerDelegationOnce(request),
			sendNextTurnCustomMessage: (message, assertCurrent) =>
				this._messageDelivery.deliverCustomMessageWithLease(
					message,
					{ deliverAs: "nextTurn" },
					undefined,
					assertCurrent,
				),
			warn: (message) => this.emitHostWarning(message),
		});
		this._edgeIntent = new SessionEdgeIntentController({
			getSessionManager: () => this.sessionManager,
			getSettingsManager: () => this.settingsManager,
			getModelRegistry: () => this._modelRegistry,
			getCwd: () => this._cwd,
			getAgentDir: () => this._agentDir,
			isChildSession: () => this._isChildSession,
			isDelegateToolActive: () => this.getActiveToolNames().includes("delegate"),
			isDisposed: () => this._disposed,
			getReflectionAbortSignal: () => this._reflectionAbort.signal,
			getSystemOneController: () => this._semanticPlane.controller,
			systemOne: this._semanticPlane,
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
			noteSystemOneTaskDirectoryUnavailable: (err) => this._agentEvents.noteSystemOneTaskDirectoryUnavailable(err),
			pushPendingNextTurnMessage: (msg) => this._pendingNextTurnMessages.push(msg),
			setOperatorBlocker: (blocker) => {
				this._operatorBlocker = blocker;
			},
			emitWarning: (msg) => this._emit({ type: "warning", message: msg }),
			getForegroundRun: () => this._foregroundRecovery,
			observeHarnessNotice: (kind, read) => this._harnessNotices.observe(kind, read),
			ownerChannel: this.ownerChannel,
			holdsAgainAtExecution: (call) => this._runtimeBuilder.holdsAgainAtExecution(call),
		});
		this._unsettledLadder = new SessionUnsettledLadderController({
			getSessionManager: () => this.sessionManager,
			getAgentDir: () => this._agentDir,
			isChildSession: () => this._isChildSession,
			isHandoff: () => this._edgeIntent.handoff,
			getLastUserRequest: () => this._promptSubmission?.lastUserRequest ?? "",
			getMessages: () => this.agent.state.messages,
			findLastAssistantMessage: () => this._findLastAssistantMessage(),
			getSystemOneController: () => this._semanticPlane.controller,
			resolveExpensiveModel: () => this._modelRouter.resolveExpensiveModel(),
			runIsolatedCompletion: (opts) => this.runIsolatedCompletion(opts),
			settleLatestOwnerPolicy: (signal) => this._edgeIntent.ownerPolicy.settle("latest", signal),
			getGoalStateSnapshot: () => this.getGoalStateSnapshot(),
			getLaneRecords: () => this._backgroundLanes.getLaneRecords(),
			getExtensionUIContext: () => this._extensionUIContext,
			getToolArtifactStore: () => this._pipeline.getToolArtifactStore(),
			codeDuplicateFileLister: config.codeDuplicateFileLister,
			getSessionImageStore: () => this._getSessionImageStore(),
			sendOwnerItemsMessage: (items, content, lease) =>
				this._messageDelivery.deliverCustomMessage(
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
			judgeOwnerRequest: (words, signal, acceptedOrder) =>
				this._edgeIntent.judgeOwnerRequest(words, signal, acceptedOrder),
			enqueueOwnerWords: (words, acceptedOrder, judgment) =>
				this._edgeIntent.enqueueOwnerWords(words, acceptedOrder, judgment),
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
			getActiveVerificationIds: () => this.getVerificationObligations().map((obligation) => obligation.id),
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
			getSteeringPlane: () => this._semanticPlane.steeringPlane,
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
			systemOne: this._semanticPlane,
			sessionManager: config.sessionManager,
			emit: (event) => this._emit(event),
			getSystemOneController: () => this._semanticPlane.controller,
			getOperatorProjection: () => this._operatorProjection,
		});
		// The provider stream chain (perf profile, idle watchdog, machine-wide admission) is built and
		// installed exactly once, here; see session-stream-chain.ts.
		const agentDir = config.agentDir ?? getAgentDir();
		// Perf samples (one per provider stream) are deferred; everything else persists at once.
		const modelAdaptationStore = ModelAdaptationStore.forAgentDir(agentDir, { deferPerfSamples: true });
		this._modelAdaptationStore = modelAdaptationStore;
		const agentHookPorts: AgentSessionAgentHookPorts = {
			cache: () => this._cache,
			costGuard: () => this._costGuard,
			hostTurnReasoning: () => this.hostTurnReasoning,
			sessionId: () => this.sessionId,
			toolProtocol: () => this._toolProtocol,
			toolSelection: () => this._toolSelection,
			toolRecoveryLogger: () => this._toolRecoveryLogger,
			analytics: () => this._analytics,
		};
		installSessionRequestHooks(this.agent, agentHookPorts);
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
		// The router pool is separate from the cycling list: an orchestration profile pins the root model for cycling but
		// never narrows the pool. An SDK caller that passes a scope without an explicit pool means that scope as the pool.
		this._routerPool = config.routerPool
			? { source: config.routerPool.source, models: config.routerPool.models.map((scoped) => scoped.model) }
			: !config.orchestrationProfile && config.scopedModels
				? { source: "sdk_models", models: config.scopedModels.map((scoped) => scoped.model) }
				: undefined;
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._agentDir = agentDir;
		this._runtimeAdmission = new SessionRuntimeAdmissionController(
			runtimeGenerationAdmission(agentDir),
			(event) => this._emit(event),
			bundleLease,
		);
		this._runtimeMutationWaitClock = config.timers.port("foreground");
		this._isChildSession = (config.isChildSession ?? process.env.PI_CHILD_SESSION === "1") || isWorkerSession();
		const pinHost = { isDisposed: () => this._disposed, warn: (message: string) => this.emitHostWarning(message) };
		void reportGithubOriginPinForSession(this._cwd, this._isChildSession, this.sessionManager, pinHost);
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
			appendPolicyEntry: (customType, data) => this.sessionManager.appendCustomEntry(customType, data),
		});
		this._toolProtocol = new ToolProtocolController({
			agent: this.agent,
			agentDir: this._agentDir,
			settingsManager: this.settingsManager,
			getModelRegistry: () => this._modelRegistry,
			adaptationStore: modelAdaptationStore,
			isRawStreamSimple: (fn) => isRawStreamSimpleFn(fn),
			getRequiredRequestAuth: (model) => this._modelAccess.getRequiredRequestAuth(model),
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
			getRequiredRequestAuth: (model) => this._modelAccess.getRequiredRequestAuth(model),
			getRequestAuthResolver: () => this.agent.resolveProviderRequestAuth,
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
			// Self-gated by kill switch and evidence thresholds inside getActiveHints(): a plain always-on pass-through.
			getToolSelectionHints: () => this._toolSelection.getActiveHints(),
			getSystemPromptOverride: () => this.ownerSystemPrompt.get(),
			getAgentIdentity: () => config.agentIdentity ?? readAgentIdentity(this._agentDir),
			promptClock: config.timers.port("system-prompt"),
		});
		this.ownerSystemPrompt = new SessionSystemPromptController({
			builder: this._systemPromptBuilder,
			getSessionManager: () => this.sessionManager,
			isStreaming: () => this.isStreaming,
			getActiveToolNames: () => this.getActiveToolNames(),
			getModel: () => this.model,
			getCustody: () => this._cache.custody,
			getPrompts: () => ({ base: this._baseSystemPrompt, live: this.agent.state.systemPrompt }),
			installPrompt: (prompt) => {
				this._baseSystemPrompt = prompt;
				this.agent.state.systemPrompt = prompt;
			},
			getRunOrigin: () => this._foregroundRecovery.turnOrigin.origin(),
		});
		this.soul = new SoulController({
			agentDir: this._agentDir,
			systemOne: this._semanticPlane,
			emitWarning: (message) => this._emit({ type: "warning", message }),
			observeHarnessNotice: (kind, read) => this._harnessNotices.observe(kind, read),
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
		this._subscriptionAllowance = openSubscriptionAllowance(config, () => this.model);
		this.hostTurnReasoning = new HostTurnReasoningController(() => this.settingsManager.getCheapTurnSettings());
		this._costGuard = new CostGuardController({
			getSettings: () => this.settingsManager.getCostGuardSettings(),
			getCompactionReserveTokens: () => this.settingsManager.getCompactionReserveTokens(),
			getSpawnedUsageCost: () => this.getSpawnedUsage().cost,
			// A subscription costs no marginal dollars while the account has allowance (or reports none); past it, extra usage is money.
			isUnmeteredSubscription: (model) =>
				this._modelRegistry.isUsingSubscription(model) &&
				this._subscriptionAllowance.read(DEFAULT_OWNER_QUOTA_MAX_USED_PERCENT, model).kind !== "exhausted",
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
			runAgentPrompt: (messages, signal) => this._foregroundRecovery.runAgentPrompt(messages, undefined, signal),
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
			timers: config.timers,
			getModelProvider: () => this.model?.provider,
			getLaneRecords: () => this._backgroundLanes.getLaneRecords(),
			getTaskRuntimeSnapshot: () => this._backgroundLanes.getTaskRuntimeSnapshot(),
			getBackgroundToolTasks: () => this._backgroundToolTasks.list(),
			getOwnerEvidence: () => this._reflection.ownerEvidence,
			synchronizeGoalState: (state) => {
				this._unsettledLadder.noteGoalState(state); // owner items a paused goal held post on resume; never throws
				this._backgroundLanes.synchronizeGoalState(state);
				this._emit({ type: "goal_state_changed", state });
			},
			scheduleGoalAutoContinueFromIdle: () => this._backgroundLanes.scheduleGoalAutoContinueFromIdle(),
			describeAutoContinue: (snapshot) => this._backgroundLanes.describeGoalAutoContinue(snapshot),
			getAutoContinueHold: () => this._backgroundLanes.goalAutoContinueHold(),
			prompt: (text, options) => this.prompt(text, options),
			getForegroundSubmissionEpoch: () => this._foregroundRecovery.getCurrentSubmissionEpoch(),
			emitWarning: (message) => this._emit({ type: "warning", message }),
			resolveCompletionRejection: (input) => this._resolveGoalCompletionOwnerDecision(input),
			getExecutionLoopMode: () => this._executionLoopMode,
			getObjectiveExecutionController: () => this._objectiveExecutionController,
		});
		this._pendingQueue = new PendingInputQueueController({
			reloadRuntime: (authority) => this._reloadWithAuthority(authority),
			agent: this.agent,
			skillVault: this._skillVault,
			goals: this._goals,
			getExtensionRunner: () => this._extensionRunner,
			getPromptTemplates: () => this.promptTemplates,
			noteOwnerAuthoredMessage: (message, text, pasted) => this._reflection.markOwnerInput(message, text, pasted),
			authorizeParentNoteOwner: (inputId) => {
				const epoch = this._foregroundRecovery.getCurrentSubmissionEpoch();
				if (epoch === undefined) throw new Error("Parent note admission requires a foreground owner.");
				this.sessionManager.authorizeParentNoteOwner(inputId, epoch);
			},
			getInputContext: () => ({
				sessionId: this.sessionManager.getSessionId(),
				sessionFile: this.sessionManager.getSessionFile(),
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
		// A queued message's goal starts when its user entry persists (with that entry's owner source), never on a mere read.
		this._ownerInputs.onDelivered((delivery) =>
			this._goals.activateQueuedOwnerChatGoal(delivery, this.agent.state.messages),
		);
		this._queuedInputPersistence.restoreRecordedQueuedInput();
		this._harnessNotices = new HarnessNoticeController({
			getSessionManager: () => this.sessionManager,
			isChildSession: () => this._isChildSession,
			deliver: (input) => this._durableCustomMessageTurns.deliverParentInput(input),
			warn: (message) => this._emit({ type: "warning", message }),
		});
		this._backgroundLanes = new BackgroundLaneController({
			refreshToolRegistry: () => this._runtimeBuilder.refreshToolRegistry(),
			isDisposed: () => this._disposed,
			isChildSession: () => this._isChildSession,
			observeHarnessNotice: (kind, read, onLost) => this._harnessNotices.observe(kind, read, onLost),
			getSessionId: () => this.sessionId,
			getCwd: () => this._cwd,
			getAgentDir: () => this._agentDir,
			getSessionManager: () => this.sessionManager,
			getSettingsManager: () => this.settingsManager,
			getWorktreeSyncEnginePorts: () => this._worktreeSyncEnginePorts,
			getTimers: () => config.timers,
			readMachine: config.machineFacts,
			getResourceLoader: () => this._resourceLoader,
			getActiveOrchestrationProfile: () => config.orchestrationProfile,
			getModelRegistry: () => this._modelRegistry,
			getCredentialExposureBoundary: () => this._runtimeBuilder.credentialExposureBoundary,
			// Workers pick only models that can take work: quota left and offered to the owner's account.
			isModelExhausted: (model) => this._modelAccess.isUnusable(model),
			modelUnusableCause: (model) => this._modelAccess.unusableCause(model),
			getModel: () => this.model ?? undefined,
			getForegroundThinkingLevel: () => this.thinkingLevel,
			systemOne: this._semanticPlane,
			getRouteChoiceJudge: () => this._semanticPlane.controller,
			isSystemOneEnabled: () => this.systemOneEnabled,
			getForegroundToolNames: () => this.getActiveToolNames(),
			isDelegateToolActive: () => this.getActiveToolNames().includes("delegate"),
			// Live worker supervision: one observation per executed worker tool call, applied through
			// the root's existing worker-agent control surface.
			observeWorkerProgress: (observation, signal) => this._workerSupervision.observe(observation, signal),
			// Worker conversations plan with root's own context pipeline on their own lane and pass the same cache guard.
			...createWorkerRequestPlanner({
				getPipeline: () => this._pipeline,
				guard: this._cache.guard,
				getEdgeGrants: () => this.getEdgeGrants(),
			}),
			getSharedLaneToolOptions: () => this._runtimeBuilder.getSharedLaneToolOptions(),
			// A worker learns tool choice on its own model into the same evidence store root learns in.
			createWorkerToolSelection: (model, tools) =>
				createWorkerToolSelection(this._toolPerformanceStore, formatModelRouterModel(model), tools),
			markModelExhausted: (model, retryAfterMs) =>
				this._foregroundRecovery.markModelExhausted(`${model.provider}/${model.id}`, retryAfterMs),
			isGoalToolActive: () => hasGoalContinuationControl(this.getActiveToolNames()),
			getRunTurnOrigin: () => this._foregroundRecovery.turnOrigin.origin(),
			getToolManifests: () => this._foregroundRecovery.toolManifests,
			...createWorkerEdgePolicy({
				...this._edgeIntent.workerEdgeSource(),
				isAllocatable: workerModelAllocator({
					getSessionModel: () => this.model,
					isRouterEnabled: () => this.settingsManager.getModelRouterSettings().enabled,
					getPool: () => this.getRouterCandidatePool(),
				}),
			}),
			getCapabilityEnvelope: () => this.capabilityEnvelope,
			getModelCapabilityProfile: () => this.getModelCapabilityProfile(),
			emit: (event) => this._emit(event),
			notifyWorkerTerminalHandoff: (records) => {
				for (const record of records) {
					this.reportOutboxWorkerTerminal(record);
				}
				return this._terminalHandoffs.notifyWorkers(records);
			},
			canRunRoutines: () => !this._isChildSession,
			deliverParentInput: (input) => this._durableCustomMessageTurns.deliverParentInput(input),
			sendUserMessage: (text, options) => this.sendUserMessage(text, options),
			ownerChannel: this.ownerChannel,
			getToolInvocationKey: (callId, toolName) => this._foregroundLifecycle.getStartedToolKey(callId, toolName),
			admitNestedToolCall: (parentId, call, signal) => this._toolGate.admitNested(parentId, call, signal),
			getOwnerEvidence: () => this._reflection.ownerEvidence,
			emitAutonomyTelemetry: (event) => this._emitAutonomyTelemetry(event),
			getGoalStateSnapshot: () => this.getGoalStateSnapshot(),
			getCurrentSubmissionEpoch: () => this._foregroundRecovery.getCurrentSubmissionEpoch(),
			getContinuousChatBirthView: () => this._memory.continuousChatHost()?.birthView(),
			getGoalRuntimeSnapshot: (settings) => this.getGoalRuntimeSnapshot(settings),
			markGoalToolUnavailable: () => this._goals.markToolUnavailable(),
			getEvidenceBundleSnapshot: () => this.getEvidenceBundleSnapshot(),
			saveEvidenceBundleSnapshot: (bundle) => this.saveEvidenceBundleSnapshot(bundle),
			saveWorkerClaimSnapshot: (claim, request, options) => this.saveWorkerClaimSnapshot(claim, request, options),
			recordRequirementCheckProof: (attemptId, requirementId, result) =>
				this.goalProof.recordRequirementCheckProof(attemptId, requirementId, result),
			reportWorkerTerminal: (handoff) => this.reportWorkerTerminal(handoff),
			recordUnsettledForOwner: (items) => this._unsettledLadder.queueWorkerUnsettled(items),
			deliverNotes: (input, options) => this._durableCustomMessageTurns.deliverParentInput(input, options),
			captureReviewContext: (maxChars) => this._memory.captureReviewContext(maxChars),
			aggregateUsageWindow: (window) => this._analytics.aggregateUsageWindow(window),
			subscribeForegroundActivity: (listener) => this._foregroundRecovery.subscribeActivity(listener),
			notifyParentSession: (customType, text, origin) =>
				this._messageDelivery.steerSessionNotice(customType, text, origin?.parentWriteId),
			createLaneMemoryBroker: (capacity, references) => this._memory.createLaneMemoryBroker(capacity, references),
			captureKnowledgeGrant: (references) => this._memory.captureKnowledgeGrant(references),
			getHandoffPersonaGuidance: () => this._memory.getHandoffPersonaGuidance(),
			getContextGcStoreDir: () => this._pipeline.contextGcStorageDir(),
			getArtifactStore: () => this._getToolArtifactStore(),
			...createWorkerSkillAccess(this._skillVault),
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
			...createWorkerSettlementPolicy(this._unsettledLadder.judges, (items) =>
				this._unsettledLadder.queueWorkerUnsettled(items),
			),
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
			isModelExhausted: (model) => this._modelAccess.isUnusable(model),
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
			isThirdPartyRun: () => this._foregroundRecovery.turnOrigin.authority() === "third-party",
			getTurnIndex: () => this._agentEvents.turnIndex,
			getAgentDir: () => this._agentDir,
			getCwd: () => this._cwd,
			getSessionId: () => this.sessionManager.getSessionId(),
			getSessionFile: () => this.sessionManager.getSessionFile(),
			isChildSession: () => this._isChildSession,
			refreshToolRegistry: () => this._runtimeBuilder.refreshToolRegistry(),
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
			onActivation: (event) => this._emit({ type: "memory_activation", ...event }),
			getUserPreferenceLearning: () => this._reflection.userPreferenceLearning,
			knowledge: () =>
				this._reflection.createKnowledgeHost({
					engine: () => this._semanticPlane.recordingSemanticEngine(),
					models: historyModels,
					time: config.timers.port("knowledge-collection"),
					isForegroundBusy: () => this._foregroundRecovery.isBusy,
					subscribeForegroundActivity: (listener) => this._foregroundRecovery.subscribeActivity(listener),
					maxEstimatedUsd: () => this.capabilityEnvelope?.maxEstimatedUsd,
					...knowledgeSessionHooks(this.settingsManager, this._emit.bind(this), this._cwd, () =>
						this._observeKnowledgeCollection(),
					),
				}),
			subscribeEntriesPersisted: (listener) => this.sessionManager.onEntriesPersisted(listener),
			// ICM's project chat: each turn projects onto the provider runtime, and its compactions repeat the accepted prefix.
			providerRequest: {
				setPlanProjection: (projection) => this._providerRequestRuntime.setPlanProjection(projection),
			},
			continuousChat: {
				compaction: createContinuousChatCompactionAdapter({
					usage: () => this._semanticUsage,
					complete: (options) => this._reflection.runIsolatedCompletion(options),
					prefixHead: () => this._continuousChatPrefixHead(),
					spend: new ContinuousChatSpendMeter(
						continuousChatSpendFile(this._agentDir),
						() => readContinuousChatSettings(this.settingsManager).maxUsdPerDay,
						config.timers.port("continuous-chat"),
					),
					summary: () =>
						validateContinuousChatSummaryModel(readContinuousChatSettings(this.settingsManager), {
							resolveModel: (reference) => historyModels.resolveModel(reference),
						}),
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
				getParentInputConsumptionSource: () => this.sessionManager.getParentInputConsumptionSource(),
				entryIds: () => this.sessionManager.getEntries().map((entry) => entry.id),
				isEntryPersisted: (entryId) => this.sessionManager.isEntryPersisted(entryId),
				timers: config.timers.port("continuous-chat"),
				// The signal `runIsolatedCompletion` admits every compaction under; dispose aborts it before the chat stops.
				closing: this._reflectionAbort.signal,
			},
			hierarchy: {
				// The configured summary model resolves through the one lane-model boundary: configured and
				// authenticated models only, no second router and no credential client.
				summarizer: {
					captureUsageOrigin: () => this._semanticUsage.captureOrigin(),
					resolveModel: (reference) => historyModels.resolveModel(reference),
					runIsolatedCompletion: (opts) => this.runIsolatedCompletion(opts),
					recordHistoryUsage: (usage, call) => this._semanticUsage.recordHistoryUsage(usage, call),
				},
				activeBranch: new ActiveBranchProbe(this.sessionManager),
				// The judge that admits model summaries is the session's one recording System One engine, so its
				// usage reaches the session ledger and its judgments the Jev ledger like every other evaluation.
				getAdmissionEngine: () => this._semanticPlane.recordingSemanticEngine(),
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
			getRequiredRequestAuth: (model) => this._modelAccess.getRequiredRequestAuth(model),
			getRequestAuthResolver: () => this.agent.resolveProviderRequestAuth,
			isModelExhausted: (ref) => {
				const [provider, ...id] = ref.split("/");
				const model = provider ? this._modelRegistry.find(provider, id.join("/")) : undefined;
				return model ? this._modelAccess.isUnusable(model) : this._foregroundRecovery.isModelExhausted(ref);
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
			getTurnIndex: () => this._agentEvents.turnIndex,
			isPathAliasingEnabled: () => this.getCapabilityTierPolicy().pathAliasing,
			getSessionManager: () => this.sessionManager,
			getSettingsManager: () => this.settingsManager,
			getModelRegistry: () => this._modelRegistry,
			getModel: () => this.model,
			getCompactionTriggerTokens: () => this._compactionSupport.getHardTriggerTokens(),
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
			maxRetainedTerminalTasks: config.maxRetainedTerminalTasks,
			getSessionManager: () => this.sessionManager,
			getGoalId: () => this._goals.getBackgroundToolTaskGoalId(),
			getCurrentSubmissionEpoch: () => this._foregroundRecovery.getCurrentSubmissionEpoch(),
			isForegroundWait: (tool, args) => this.getToolDefinition(tool)?.foregroundWait?.(args as never) === true,
			// Task images are retrievable through tool_task itself; text handles need artifact_retrieve.
			getArtifactStore: () => this._getToolArtifactStore(),
			canRetrieveTextArtifacts: () => this._runtimeBuilder.getRegisteredTool("artifact_retrieve") !== undefined,
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
			captureUsageOrigin: () => this._semanticUsage.captureOrigin(),
			recordMaintenanceUsage: (component, route, origin) =>
				this._semanticUsage.recordMaintenanceUsage(component, route, origin),
			runtimeAdmission: runtimeGenerationAdmission(this._agentDir),
			agent: this.agent,
			sessionManager: this.sessionManager,
			settingsManager: this.settingsManager,
			getModel: () => this.model,
			getAdaptedSettings: (model) => this._getAdaptedCompactionSettings(model),
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
			assertCanStartManualCompaction: () => this._foregroundRecovery.assertCanStartManualCompaction(),
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
			measureLiveContextTokens: () => this._compaction.measureLiveContextTokens(),
			runAutoCompaction: (reason, willRetry) => this._runAutoCompaction(reason, willRetry),
			compactWithRetry: (run, signal, provider) => this._compaction.compactWithRetry(run, signal, provider),
			retryTimers: config.timers.port("compaction-retry"),
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
			getCacheEconomics: (model, now) => this._cache.compactionEconomics(model, now),
			recordCacheDecision: (decision) => this._recordCacheDecision(decision),
			recordCompactionOutcome: (outcome) => this._cache.recordCompactionOutcome(outcome),
		});
		this._selfCompaction = new SelfCompactionController({
			getSessionManager: () => this.sessionManager,
			getSettings: () => this.settingsManager.getSelfCompactionSettings(),
			getContextUsage: () => this.getContextUsage(),
			getCachedTokens: () => latestCachedReadTokens(this.agent.state.messages),
			getHardTriggerTokens: () => this._compactionSupport.getHardTriggerTokens(),
			getEarlyTriggerTokens: () => this._compactionSupport.getEarlyTriggerTokens(),
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
		const { controller: providerRequestContext, returnBrief } = createSessionProviderRequestContext({
			sessionManager: this.sessionManager,
			memory: this._memory,
			pipeline: this._pipeline,
			selfCompaction: this._selfCompaction,
			skillVault: this._skillVault,
			goals: this._goals,
			edgeIntent: this._edgeIntent,
			ownerInputs: this._ownerInputs,
			modelRouter: () => this._modelRouter,
			reflection: () => this._reflection,
			runtimeBuilder: () => this._runtimeBuilder,
			extensionRunner: () => this._extensionRunner,
			getGoalState: () => this.getGoalStateSnapshot(),
			agentDir: () => this._agentDir,
			cwd: () => this._cwd,
			taskProjection: () => this._backgroundLanes.getTaskRuntimeSnapshot(),
			foreground: () => this._foregroundRecovery,
			warn: (message) => this._foregroundLifecycle.warn(message),
		});
		this._ownerReturnBrief = returnBrief;
		this._providerRequestRuntime = new ProviderRequestRuntimeController({
			agent: this.agent,
			compaction: this._compaction,
			context: providerRequestContext,
			parentInputs: this.sessionManager,
			getSubmissionEpoch: () => this._foregroundRecovery.getCurrentSubmissionEpoch(),
			admitGoalRequest: () => this._goals.admitProviderRequest(),
			maxOutputTokens: () =>
				Math.min(this.settingsManager.getMaxOutputTokens(), this.getCapabilityTierPolicy().maxOutputTokens),
			shouldStopGoalExecutionAfterTurn: () => this._goals.hasExecutionLeaseCrossedBudgetLimit(),
			shouldStopForRuntimeUpdate: () => this.runtimeUpdates.shouldStopAfterTurn(),
		});
		this.runtimeUpdates = new RuntimeUpdateController({
			sessionManager: this.sessionManager,
			acquireUpdateQuiescence: async (signal) => this._memory.continuousChatHost()?.runtime.pauseAndDrain(signal),
			getMessages: () => this.agent.state.messages,
			isRoot: () => !this._isChildSession,
			onStopped: () => this._goals.markTerminalToolFailureBlocked("runtime_update"),
			resume: (prepare) => this._durableCustomMessageTurns.continue(prepare, this._goals.getOwnershipGoalId()),
			reload: async (path, ownerHandoff) => {
				await this._compaction.cancelIdlePreparationAndWait();
				await (path
					? this._runtimeBuilder.reloadExtension(path, { ownerHandoff })
					: this._runtimeBuilder.reload({ ownerHandoff }));
				this._notifyExtensionsChanged();
			},
			appendNotice: (content) =>
				this._messageDelivery.deliverCustomMessage(
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
			timers: config.timers.port("tool-recovery-log"),
		});
		this._foregroundRecovery = new ForegroundRecoveryController({
			runtimeAdmission: runtimeGenerationAdmission(this._agentDir),
			agent: this.agent,
			timers: config.timers,
			chatTurns: () => this._memory.continuousChatHost()?.turns,
			applyFailoverModel: (failed, hop) => {
				// Same rule as an unsupported model: a routed turn's model stays inside that turn.
				if (this._modelRouter.isRoutedTurnOn(failed))
					return this._modelRouter.replaceRefusedRoutedModel(failed, hop);
				this.agent.state.model = hop;
				this.sessionManager.appendModelChange(hop.provider, hop.id);
				this._modelAccess.moveTalker(hop, `${failed.provider}/${failed.id} out of quota`);
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
			getBranchEntries: () => this.sessionManager.getBranch(),
			emit: (event) => {
				// Retry lifecycle events are persisted before they reach the UI so a retried-and-
				// recovered provider failure leaves a session record a census can count.
				if (event.type === "auto_retry_start" || event.type === "auto_retry_end") {
					this._foregroundLifecycle.recordRetryEvent(event);
				}
				this._emit(event);
			},
			checkCompaction: (message) => this._checkCompaction(message),
			replaceUnsupportedModel: (message) => this._modelAccess.replaceUnsupportedModel(message),
			onUsageLimitReached: (message) => void this._offerSubscriptionReset(message),
			onSuccessfulAssistant: () => this._compaction.resetOverflowRecovery(),
			settleRuntimeUpdate: (signal, beginRuntimeHandoff) => this.runtimeUpdates.settle(signal, beginRuntimeHandoff),
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
					(this._semanticPlane.controller?.isEvaluating ?? false) ||
					this._semanticPlane.health.hasForegroundEvaluations()
				);
			},
			hasPendingIdleContinuation: () =>
				!isOwnIdleContinuationAdmission() && this._backgroundLanes.hasPendingIdleContinuation(),
			prepareRun: async () => {
				this.agent.state.systemPrompt = this._systemPromptBuilder.enforceSystemPromptBudget(this.systemPrompt);
				await this._toolProtocol.ensureActiveModelProtocol();
			},
			afterRun: async (beginRuntimeHandoff, signal) => {
				// The submission is over, including a retry its last agent_end predicted and nothing started (an abort during the
				// backoff, a runtime stop): a later wake-started run must not read this run's owner words as its own request.
				this._reflection.ownerEvidence.endOwnerTurn();
				if (!signal.aborted && !isInterruptedAssistantStopReason(this._findLastAssistantMessage()?.stopReason)) {
					this._selfCompaction.schedule();
				}
				this._toolProtocol.restoreWithheldTools();
				this._bash.flushPendingBashMessages();
				await this._drainQueuedExtensionCommands(beginRuntimeHandoff);
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
			if (this._isForegroundPhaseBusy()) return;
			this._backgroundLanes.drainQueuedWorkerDelegations();
			this._observeKnowledgeCollection(); // model, judge and memory activation change without a collector signal
		});
		this._semanticPlane.setEvaluationIdleListener(wakeIdleOccupancy);
		this._unsubscribeIdleOccupancy = () => {
			unsubscribeSemantic();
			unsubscribeContinuation();
			unsubscribeOwnerAnswers();
			unsubscribeQueuedWorkers();
			this._semanticPlane.setEvaluationIdleListener(undefined);
		};
		this._durableCustomMessageTurns = new DurableCustomMessageTurnController({
			foreground: this._foregroundRecovery,
			goals: this._goals,
			parentInput: {
				getSessionManager: () => this.sessionManager,
				getAgent: () => this.agent,
				prepareHistory: () => this._foregroundLifecycle.repair(),
				holdLateWork: (work) => this._runtimeAdmission.holdBundleUntil(work),
				onAccepted: (message) => {
					this._emit({ type: "message_start", message });
					this._emit({ type: "message_end", message });
				},
				warn: (message) => this._emit({ type: "warning", message }),
			},
			steering: () => this.agent,
			appendMessage: (message, lease) =>
				this._foregroundLifecycle.commitCustomPrompt(message, this._handleAgentEvent, () => {
					if (this._disposed || !this._foregroundRecovery.ownsSubmission(lease))
						throw new Error("Custom-message persistence requires its live foreground submission.");
				}),
			claimCorrection: (opening) => this._unsettledLadder.claimCorrection(opening),
			flushOwnerItems: (lease) => this._flushOwnerItems(lease),
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
			getWorkerFanoutGroups: () => this._backgroundLanes.getWorkerFanoutGroups(),
			getWorkerBot: (laneId) => this._backgroundLanes.botOfRuntime(laneId),
			startCustomMessageTurn: (message, lease, goalId) =>
				this._durableCustomMessageTurns.start(message, lease, goalId),
			enqueueCustomMessageTurn: (message) => this._durableCustomMessageTurns.enqueue(message),
			flushOwnerItems: (lease) => this._flushOwnerItems(lease),
			sendCustomMessage: (message, options, lease) =>
				this._messageDelivery.deliverCustomMessage(message, options, lease),
			warn: (message) => this._emit({ type: "warning", message }),
			interposeWorkerDelivery: config.workerTerminalDelivery,
		});
		this._modelRouter = new ModelRouterController({
			getAgent: () => this.agent,
			getModel: () => this.model ?? undefined,
			getSettingsManager: () => this.settingsManager,
			getSessionManager: () => this.sessionManager,
			appendSessionMessageBatch: (batch, attempt) => this._foregroundLifecycle.appendMessageBatch(batch, attempt),
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
			buildSystemPromptForToolNames: (toolNames) =>
				this._systemPromptBuilder.buildSystemPromptForToolNames(toolNames),
			noteRoutedToolOmissions: (withheld) => this._runtimeBuilder.noteRoutedCapabilityOmissions(withheld),
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
			getRouteJudge: () => this._semanticPlane.controller,
			isUsingSubscription: (model) => this._modelRegistry.isUsingSubscription(model),
		});
		const ownerInputPublications = createOwnerInputPublicationObserver({
			inputs: this._ownerInputs,
			noteEvidence: (message, entryId) => this._reflection.noteOwnerInputPersisted(message, entryId),
			protectRecovery: (sessionFile) => this._queuedInputPersistence.noteUncertainHistory(sessionFile),
			queueChanged: () => this._emitQueueUpdate(),
		});
		this._foregroundLifecycle = new ForegroundLifecycleAdapter(
			this.agent,
			this.sessionManager,
			this._modelRouter,
			() => this.mutationScope,
			() => this._shellSessionKey,
			this._providerLimitStore,
			// Every persisted message, single or batched (a routed turn's flush included), passes here: the one Delivered point.
			ownerInputPublications.persisted,
			() =>
				this._eventListeners.length > 0 ? (message: string) => this._emit({ type: "warning", message }) : undefined,
			({ requestId, model, context, sourceContext }, deliveredNoteIds) => {
				this._durableCustomMessageTurns.displayParentNotes(deliveredNoteIds);
				this._cache.lastSentRequest = { model, context, sourceMessages: sourceContext.messages };
				this._continuousChatPrefix.record(context, model);
				// A surface the loop changed on purpose (a safety removal) is mandatory: sanctioned for this request.
				if (sourceContext.surfaceChange) {
					this._cache.custody.sanction("safety_removal", sourceContext.surfaceChange, {
						lane: cacheLaneKey(model.api, model.provider, model.id),
					});
				}
				this.ownerSystemPrompt.observeRequest(context.systemPrompt ?? "", model);
				this._foregroundRecovery.toolManifests.offerRoot(sourceContext.tools, this._runtimeBuilder);
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
				if (this._edgeIntent.ownerPolicy.size === 0) return this._edgeIntent.prewarmOperations(calls, signal);
				void this._edgeIntent.ownerPolicy
					.settle("latest", signal)
					.then(() => this._edgeIntent.prewarmOperations(calls, signal))
					.catch(() => undefined);
				return undefined;
			},
			ownerInputPublications.uncertain,
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
			getContextGeneration: () => this._branchGeneration,
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
			archivePromotedSkill: (name, expectedDigest) => this.archivePromotedSkill(name, expectedDigest),
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
		// The store's record-write retry waits on the session's own worktree-sync clock unless the host supplies one.
		this._worktreeSyncEnginePorts = {
			...config.worktreeSyncEnginePorts,
			atomicWrite: { timers: config.timers.port("worktree-sync"), ...config.worktreeSyncEnginePorts?.atomicWrite },
		};
		this._shellOperations = config.shellOperations;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };
		this._runtimeBuilder = new RuntimeBuilder({
			systemOne: this._semanticPlane,
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
			getPeerReviewModels: (selectedRef) =>
				this._edgeIntent.modelPolicy.allowed(this.getRouterCandidatePool(selectedRef).models),
			isModelExhausted: (model) => this._modelAccess.isUnusable(model),
			getResourceLoader: () => this._resourceLoader,
			getSkillVault: () => this._skillVault,
			getExtensionRunner: () => this._extensionRunner,
			setExtensionRunner: (runner) => {
				this._extensionRunner = runner;
				if (this._extensionRunnerRef) this._extensionRunnerRef.current = runner;
			},
			getBaseSystemPrompt: () => this._baseSystemPrompt,
			setBaseSystemPrompt: (prompt) => {
				this._baseSystemPrompt = prompt;
			},
			getCustomTools: () => this._customTools,
			getRuntimeUpdateTool: () => (this._isChildSession ? undefined : this.runtimeUpdates.createTool()),
			getSelfCompactTool: () =>
				this._isChildSession ? undefined : createSelfCompactToolDefinition(() => this._selfCompaction),
			getProactivityTool: () =>
				this._isChildSession ? undefined : createProactivityToolDefinition(() => this.settingsManager),
			getBackgroundLaneTools: () => this._backgroundLanes.createBackgroundLaneTools(),
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
			getPrivatePathScope: () => config.privatePathScope,
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
			createProfileFilterReloadSnapshot: () => this._profileFilter.createReloadSnapshot(),
			restoreProfileFilterReloadSnapshot: (snapshot) => this._profileFilter.restoreReloadSnapshot(snapshot),
			getActiveToolNames: () => this.getActiveToolNames(),
			setActiveToolsByName: (toolNames, assertCurrent) =>
				this._toolActivation.applyActiveTools(toolNames, assertCurrent),
			normalizePromptSnippet: (text) => this._systemPromptBuilder.normalizePromptSnippet(text),
			normalizePromptGuidelines: (guidelines) => this._systemPromptBuilder.normalizePromptGuidelines(guidelines),
			bindExtensionCore: (runner) => this._extensionBinding.bindExtensionCore(runner),
			applyExtensionBindings: (runner) => this._extensionBinding.applyExtensionBindings(runner),
			extendResourcesFromExtensions: (reason) => this._extensionBinding.extendResourcesFromExtensions(reason),
			reapplyActiveProfileModelSettings: (assertCurrent) =>
				this._profileFilter.reapplyActiveProfileModelSettings(assertCurrent),
			notifyExtensionsChanged: () => this._notifyExtensionsChanged(),
			getToolArtifactStore: () => this._getToolArtifactStore(),
			getContextGcStoreDir: () => this._pipeline.contextGcStorageDir(),
			getDecisionLedger: () => this.getDecisionLedger(),
			admitNestedToolCall: (parentToolCallId, call, signal) =>
				this._toolGate.admitNested(parentToolCallId, call, signal),
			getToolTaskDependencies: () => ({
				list: () => this._backgroundToolTasks.list(),
				readImage: (taskId, imageIndex) => this._backgroundToolTasks.readImage(taskId, imageIndex),
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
			getGoalAutoContinueNote: () => this._goals.autoContinueNote(),
			goalClock: config.timers.port("goal-continuation"),
			getActiveVerificationIds: () => this._getActiveVerificationIds(),
			getCompletionRuleRefusal: (toolCallId) => this._ruleHooks.refusalFor("noticed-items", toolCallId),
			deliverToOwner: (items) => {
				this._unsettledLadder.deliverToOwner(items);
			},
			getSystemOneController: () => this._semanticPlane.controller,
			getSemanticUncertainties: () => (this._isChildSession ? undefined : this.getSemanticUncertainties()),
			getSteeringPlane: () => this._semanticPlane.steeringPlane,
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
			onWorkerReviewAcknowledged: () => {
				this.recordAcceptedWorkerEvidence();
				this._backgroundLanes.signalWorkerReceiptDelivery();
			},
			getWorkerClaimSnapshots: () => this.getWorkerClaimSnapshots(),
			getWorkerClaimSnapshot: (taskId, attemptId) =>
				getWorkerClaimSnapshotForAttempt(getActiveSessionBranchEntries(this.sessionManager), taskId, attemptId),
			getWorkerResult: (attemptId) => this._backgroundLanes.getWorkerAttemptResult(attemptId),
			resolveManagedLaneId: (id) => this._backgroundLanes.resolveManagedLaneId(id),
			runWorkerDelegationOnce: (request) => this.runWorkerDelegationOnce(request),
			runModelFitness: (args) => this.runModelFitness(args),
			resolveCurationModelIfFit: () => this._pipeline.resolveCurationModelIfFit(),
			runIsolatedCompletion: (opts) => this.runIsolatedCompletion(opts),
			addSpawnedUsage: (usage, opts) => this.addSpawnedUsage(usage, opts),
			getLaneWorkerRefusal: (selection) => this.getLaunchedWorkerLaneRefusal(selection),
			createAgentContextSnapshot: () => this.agent.createContextSnapshot(),
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
			getAgentDir: () => this._agentDir,
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
			setActiveToolsByName: (toolNames, assertCurrent) =>
				this._toolActivation.applyActiveTools(toolNames, assertCurrent),
			refreshToolRegistry: () => this._runtimeBuilder.refreshToolRegistry(),
			rebuildSystemPrompt: (toolNames) => this._systemPromptBuilder.rebuildSystemPrompt(toolNames),
			setBaseSystemPrompt: (prompt) => {
				this._baseSystemPrompt = prompt;
			},
			getPromptTemplates: () => this.promptTemplates,
			getThinkingLevel: () => this.thinkingLevel,
			setThinkingLevel: (level, assertCurrent) => this._setThinkingLevel(level, {}, assertCurrent),
			setModel: (model, assertCurrent) => this._setModel(model, {}, assertCurrent),
			sendCustomMessage: (message, options, runtimeLease) =>
				this._messageDelivery.deliverCustomMessageWithLease(message, options, runtimeLease),
			sendUserMessage: (content, options, runtimeLease) =>
				this._messageDelivery.deliverUserMessageWithLease(content, options, runtimeLease),
			setSessionName: (name, assertCurrent) => this._setSessionName(name, assertCurrent),
			registerMemoryProvider: (provider, assertCurrent) => this._registerMemoryProvider(provider, assertCurrent),
			registerContextMemoryProvider: (provider, assertCurrent) =>
				this._registerContextMemoryProvider(provider, assertCurrent),
			addSpawnedUsage: (usage, opts) => this.addSpawnedUsage(usage, opts),
			recordManagedLane: (event) => this._backgroundLanes.recordManagedLane(event),
			handoffKnowledge: this._backgroundLanes.handoffKnowledge(this._memory),
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
			getGoalState: () => this.getGoalStateSnapshot(),
			getTaskState: () => this.getTaskStepsStateSnapshot(),
			isStreaming: () => this.isStreaming,
			onDailyUsageUpdated: () => this._emit({ type: "usage_updated" }),
			isDisposed: () => this._disposed,
			onDailyUsageError: (error) => this.emitHostWarning(`Daily usage refresh failed: ${String(error)}`),
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
		this.spawnedUsageReceipts = this._analytics.createSpawnedUsageReceiptPort(() => !this._disposed);
		installSessionToolArgumentHook(this.agent, agentHookPorts);
		this._treeNavigator = new SessionTreeNavigator({
			captureUsageOrigin: () => this._semanticUsage.captureOrigin(),
			recordMaintenanceUsage: (component, route, origin) =>
				this._semanticUsage.recordMaintenanceUsage(component, route, origin),
			getSessionManager: () => this.sessionManager,
			addSpawnedUsage: (usage, options) => this.addSpawnedUsage(usage, options),
			getModel: () => this.model,
			getExtensionRunner: () => this._extensionRunner,
			getRequiredRequestAuth: (model) => this._modelAccess.getRequiredRequestAuth(model),
			getSettingsManager: () => this.settingsManager,
			getAgent: () => this.agent,
			// The navigation's history rewrite occupies the foreground and excludes a running turn, at the run owner.
			beginHistoryRewrite: () => this._foregroundRecovery.beginHistoryRewrite(),
			summaryRetryTimers: config.timers.port("branch-summary-retry"),
			onBranchChanged: () => {
				void this._humanInput.invalidate("session branch changed");
				this._branchGeneration++;
				this._backgroundLanes.signalWorkerReceiptDelivery();
				// Owner input accepted on the old branch is held in full, never delivered on the new one.
				this._pendingQueue.reconcileContext();
				this._emitQueueUpdate();
				this._reflection.invalidateCurrentTurnCueStateCache({ releaseActiveClaim: true });
				this._selfCompaction.resetBranchState();
				this.ownerSystemPrompt.branchChanged();
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
			setActiveToolsByName: (names, assertCurrent) => this._toolActivation.applyActiveTools(names, assertCurrent),
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
			setThinkingLevel: (level, assertCurrent) =>
				this._setThinkingLevel(level, { persistSettings: false }, assertCurrent),
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
				return evaluateToolGate({ toolName, cwd: this._cwd, envelope }).outcome === "allow";
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
			ruleHooks: this._ruleHooks,
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
			checkEdge: (...call) => enforceSessionEdge(this._edgeDeps(), ...call),
			...this._edgeIntent.rootCallChecks(),
			localCommitBranch: () => this._edgeIntent.localCommitBranch(),
			// An admitted outward-facing operation (publish to a remote or a registry) is the delivery
			// step the projection reports as DELIVER until that call ends or the gate releases it.
			noteEdgeOperations: (toolCallId, classes) => {
				if (!classes.some((edgeClass) => edgeClass === "git.publish" || edgeClass === "package.publish")) return;
				const calls = this._deliveryToolCalls.add(toolCallId);
				this.setDeliveryState("in_progress");
				return () => {
					if (calls.delete(toolCallId) && calls.size === 0) this.setDeliveryState("none");
				};
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
			getSystemOneController: () => this._semanticPlane.controller,
			reviewNewCode: ({ toolName, args, cwd }) => this._unsettledLadder.codeDuplicates.review(toolName, args, cwd),
			reviewPlan: ({ toolName, args }) => this._reviewPublishedPlan(toolName, args),
			validateMutationAcceptance: (input) =>
				this._projectRules.acceptMutation(input, this._edgeIntent.ruleAuthority),
			soulGate: this._isChildSession ? undefined : this.soul,
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
			toolCallFacts: (toolName, args) => this._backgroundLanes.toolCallFacts(toolName, args),
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
			enqueueOwnerWords: (words, acceptedOrder, judgment, signal) =>
				this._edgeIntent.enqueueOwnerWords(words, acceptedOrder, judgment, signal),
			registerOwnerWords: (acceptedOrder, words) => this._edgeIntent.registerOwnerWords(acceptedOrder, words),
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
			judgeQueuedOwnerRequest: (words, signal, acceptedOrder) =>
				this._edgeIntent.judgeOwnerRequest(words, signal, acceptedOrder),
			getSemanticDecisionEngine: () => this._semanticDecisionEngine(),
			sendCustomMessage: (message, options) => this.sendCustomMessage(message, options),
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
			flushPendingBashMessages: () => this._bash.flushPendingBashMessages(),
			emit: (event) => this._emit(event),
			leaveUnavailableSessionModel: () => this._modelAccess.leaveUnavailableSessionModel(),
			getContextUsage: () => this.getContextUsage(),
			sideTripApproves: (model, text) => this._sideTripApproves(model, text),
			ensureRouteModelReady: (routeInfo) => this._ensureRouteModelReady(routeInfo),
			adoptTalker: (model, decision) => this._modelAccess.adoptTalker(model, decision),
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
			noteSystemOneTaskDirectoryUnavailable: (error) =>
				this._agentEvents.noteSystemOneTaskDirectoryUnavailable(error),
			getSystemOneController: () => this._semanticPlane.controller,
			announceOwnerFollowUpsWhenPresent: () => this._announceOwnerFollowUpsWhenPresent(),
			runToolkitHit: (scriptName, messages, signal) => this._runToolkitHit(scriptName, messages, signal),
			claimCorrection: (turnOpening) => this._unsettledLadder.claimCorrection(turnOpening),
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
			() => this._terminalHandoffs.flushProviderBoundary(),
			() => this._durableCustomMessageTurns.flushParentSteers(),
		);

		this._runtimeBuilder.buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
		this._unsubscribeSettingsChanges = this.settingsManager.subscribeChanges(() => {
			this._compaction.reconcileIdlePreparationSettings();
			this._refreshBaseSystemPrompt();
			this._observeKnowledgeCollection();
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
	get systemOneEnabled(): boolean {
		return this._semanticPlane.enabled;
	}

	get systemOneController(): SystemOneController | undefined {
		return this._semanticPlane.controller;
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
		return this._semanticPlane.steeringPlane;
	}

	/** Diagnostic readiness gate for adaptive runtime components. */
	get adaptiveReadiness(): AdaptiveRuntimeReadiness | undefined {
		return this._adaptiveReadiness;
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
	getRouterCandidatePool(selectedAdvisorRef?: string): RouterCandidatePool {
		return resolveRouterCandidatePool(this._routerPool, this._modelRegistry, {
			favorites: this.settingsManager.getModelFavorites(),
			selectedAdvisorRef,
			isRuntimeDisabled: (r) => !this.settingsManager.isLocalRuntimeEnabled(r),
		});
	}

	/** Account-advertised speed tiers and the tier the catalog applies when none is saved, with bundled capabilities before discovery. */
	getFastModeCatalog(model: Model<Api>) {
		return this._accountModels.speedCatalog(model);
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
				getSteeringPlane: () => this._semanticPlane.steeringPlane,
				setSteeringPlane: (plane) => {
					this._semanticPlane.steeringPlane = plane;
				},
				bindSemanticObserver: (plane) => this._semanticPlane.bindSemanticObserver(plane),
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
				waitForObjectiveWorkers: (context, signal) => this._workState.waitForObjectiveWorkers(context, signal),
				workerSupervision: this._workerSupervision,
				objectiveMutationId: () => this.objectiveMutationId(),
				repositoryObserver: this._repositoryObserver,
				runtimeBuilder: this._runtimeBuilder,
				getGoalStateSnapshot: () => this.getGoalStateSnapshot(),
				saveGoalStateSnapshot: (state, expected) => this.saveGoalStateSnapshot(state, expected),
				getLocalCommitBranch: () => this.localCommitBranch(),
				getRuleAuthority: () => this._edgeIntent.ruleAuthority,
				deployAdapters: this._deployAdapters,
				getSystemOneController: () => this._semanticPlane.controller,
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
		this._runtimeAdmission.mutateResources("cost guard settings", () => {
			this.settingsManager.setCostGuardSettings(settings, scope);
			this._costGuard.invalidateDecision();
			if (this._currentForegroundEnvelope) this._refreshForegroundEnvelope();
		});
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
	archivePromotedSkill(name: string, expectedDigest?: string): boolean {
		const archived = this._skillCurator.archiveSkill(name, expectedDigest);
		if (archived) this._resourceLoader.refreshSkills?.();
		return archived;
	}

	/** Restore a previously-archived promoted skill. Returns true if moved back. */
	restorePromotedSkill(name: string): boolean {
		const restored = this._skillCurator.restoreSkill(name);
		if (restored) this._resourceLoader.refreshSkills?.();
		return restored;
	}

	/** Reconstruct trusted active verification IDs at the goal-execution boundary. */
	private _getActiveVerificationIds(): readonly string[] {
		return new VerificationObligationTracker(this.agent.state.messages).getActiveIds();
	}

	/** Operator view of past-session history recall (coverage, latest retrieval, prompt admission). */
	getTranscriptHistoryStatus(): TranscriptHistoryStatus {
		return this._memory.getTranscriptHistoryStatus();
	}

	/** The operator's `/memory` authority: managed-file drift, history forgetting and knowledge-collection status. */
	get memoryOperator(): MemoryOperatorPort {
		return this._memory;
	}

	/**
	 * The owner's confirmation on their own screen, the same bound UI a tool reaches through `ctx.ui.confirm`; undefined
	 * exactly when no UI is bound (`ctx.hasUI` false), so an owner command that needs confirmation refuses.
	 */
	get ownerConfirm(): ExtensionUIContext["confirm"] | undefined {
		const runner = this._extensionRunner;
		if (!runner.hasUI()) return undefined;
		const ui = runner.getUIContext();
		return (title, message, options) => ui.confirm(title, message, options);
	}
	private obligationProjection?: {
		messages: readonly AgentMessage[];
		revision: number;
		values: VerificationObligationView[];
	};
	getVerificationObligations(): VerificationObligationView[] {
		const messages = this.agent.state.messages;
		const revision = messageRevision(messages);
		const cached = this.obligationProjection;
		if (revision !== undefined && cached?.messages === messages && cached.revision === revision)
			return cached.values.map((value) => ({ ...value }));
		const values = new VerificationObligationTracker(messages).getActiveObligations();
		this.obligationProjection = revision === undefined ? undefined : { messages, revision, values };
		return values.map((value) => ({ ...value }));
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
		return this._semanticPlane.controller?.verification.status().obligations ?? [];
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

	/** The open semantic verification findings, for the owner's `/verification` command. */
	listVerificationFindings(): readonly SemanticVerificationObligationView[] {
		return this._semanticPlane.listVerificationFindings();
	}

	/** The owner's decision to close findings (ids, or every one) without proof; no tool reaches it. */
	waiveVerificationFindings(
		ids: readonly string[] | "all",
		note: string,
	): readonly SemanticVerificationObligationView[] {
		return this._semanticPlane.controller?.verification.waive(ids, note) ?? [];
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

	/** Automatic knowledge collection, as the owner is told about it: read on the signals its own collector reads. */
	private _observeKnowledgeCollection(): void {
		this._harnessNotices.observe("knowledge-collection", () =>
			knowledgeCollectionNotice(this._memory.getKnowledgeCollectionStatus(), this.settingsManager),
		);
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

	private _isForegroundPhaseBusy(): boolean {
		return this._foregroundRecovery.isForegroundOccupied;
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

	/** Read-only inspection of the context audit (delegates to {@link ContextPipeline.getContextAuditReport}). */
	getContextAuditReport(messages?: AgentMessage[]): ContextAuditReport {
		return this._pipeline.getContextAuditReport(messages);
	}

	/** Read-only latest accepted provider-context projection, or a pure preview for explicit messages. */
	getContextProjection(messages?: readonly AgentMessage[]): ContextProjection {
		return this._pipeline.getContextProjection(messages);
	}

	/** Read-only inspection of the shadow policy plan (delegates to {@link ContextPipeline.getPromptPolicyReport}). */
	getPromptPolicyReport(messages?: AgentMessage[]): PromptPolicyShadowReport {
		return this._pipeline.getPromptPolicyReport(messages);
	}

	/** Read-only inspection of the latest shadow-plan/legacy-gc correlation, for tests/debugging. */
	getPromptPolicyGcCorrelation(): PromptPolicyGcCorrelationReport {
		return this._pipeline.getPromptPolicyGcCorrelation();
	}

	/** Compaction call-site delegation to {@link ContextPipeline.buildCompactionPreDigest}. */
	private _buildCompactionPreDigest(): ((text: string, signal?: AbortSignal) => Promise<string>) | undefined {
		return this._pipeline.buildCompactionPreDigest((type, data) => this.sessionManager.appendCustomEntry(type, data));
	}

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
	 * Context composition dashboard data: decomposes the per-request payload (system prompt, tool schemas, extension
	 * contributions, message classes incl. GC/policy stubs and recall pages) plus background spend, so users can see
	 * what their integrations cost per request. Read-only: uses the GC report path (writePayloads=false).
	 */
	getContextCompositionReport(): ContextCompositionReport {
		return buildSessionContextCompositionReport({
			agent: this.agent,
			model: this.model,
			systemPrompt: this.systemPrompt,
			unboundToolGrantWarnings: this._unboundToolGrantWarnings,
			skillVault: this._skillVault,
			resourceLoader: this._resourceLoader,
			profileFilter: this._profileFilter,
			settingsManager: this.settingsManager,
			applyContextGc: (rawMessages, writePayloads, sentPrefixCount) =>
				this._pipeline.applyContextGc(rawMessages, writePayloads, sentPrefixCount),
			getContextUsage: () => this.getContextUsage(),
			getPromptEnforcementReport: () => this.getPromptEnforcementReport(),
			getContextCurationStatus: () => this.getContextCurationStatus(),
			getSpawnedUsage: () => this.getSpawnedUsage(),
			continuousChat: () => ({ wire: this._continuousChatWire(), host: this._memory.continuousChatHost() }),
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

	private _emit(event: AgentSessionEvent): void {
		this._agentEvents.emit(event);
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
	private _handleAgentEvent = (event: AgentEvent): Promise<void> => this._agentEvents.handleAgentEvent(event);

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
		const { completion, safely, trackRequired, finish } = createSessionShutdownTracker();
		this._disposeCompletion = completion.then(() => this._runtimeAdmission.releaseBundle());
		void this._disposeCompletion.catch(() => undefined);
		this._disposed = true;
		this._ownerReturnBrief.dispose();
		trackRequired(() => this._analytics.dispose());
		const humanInputPreparation = this._humanInput.invalidate("session dispose");
		this._runtimeBuilder.closeMutationAdmission();
		this._runtimeAdmission.close();
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
		safely(() => this.soul.close());
		safely(() => this._harnessNotices.close());
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
		safely(() => this.agent.abort("session dispose"));
		// Preparing/postflight submissions and reflection preflight have no agent run to abort.
		safely(() => this._promptSubmission.abortSubmission("session dispose"));
		safely(() => this._promptSubmission.ownerGoalIntent.abort());
		safely(() => this._reflectionTurnLifecycle.abort());
		safely(() => this._reflectionAbort.abort());
		safely(() => this._unsubscribeSettingsChanges?.());
		this._unsubscribeSettingsChanges = undefined;
		safely(() => this._localPrefixWarm.cancel());
		// Existing close-time user events end here; only the physical mutation join remains visible.
		this._closingRuntimeWaitOnly = true;
		// Enroll this whole phase now. Its own tracker joins resources added after physical mutation
		// settlement; the outer tracker is never extended after finish captures its work.
		trackRequired(async () => {
			await humanInputPreparation;
			if (this._runtimeBuilder.hasPendingMutation) {
				await this._runtimeBuilder.settleMutations((event) => this._emit(event), this._runtimeMutationWaitClock);
			}
			await this._durableCustomMessageTurns.closeParentInputsBefore(() => this._disposeRuntimeDependencies());
		});
		void finish();
	}

	private _disposeRuntimeDependencies(): Promise<void> {
		const { safely, track, trackRequired, finish } = createSessionShutdownTracker();
		safely(() => this._skillVault.unload());
		trackRequired(() => disposeShellExecutionSessionAndWait(this._shellSessionKey));
		track(() => this._backgroundLanes.channels.stop());
		trackRequired(() => this._backgroundToolTasks.shutdown());
		track(() => this._runtimeBuilder.dispose());
		safely(() => this._localRuntimeController.dispose());
		safely(() => this._reflection.dispose());
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
		trackRequired(() =>
			settleClosingSessionMemory({
				waitForAgentIdle: () => this.agent.waitForIdle(),
				settleReflectionTurn: () => this.settleReflectionTurn(),
				settleCompaction: () => this._compaction.settled(),
				settleOwnerGoalIntent: () => this._promptSubmission.ownerGoalIntent.settle(),
				settleRoutineIntake: () => this._backgroundLanes.settleRoutineIntake(),
				releaseAgentConsumer: () => {
					safely(() => this._disconnectFromAgent());
					this._closingConsumerReleased = true;
				},
				shutdownMemory: () => this._memory.shutdown(),
				disposeSemanticUsage: () => safely(() => this._semanticUsage.dispose()),
				holdWarning: (message) => this._holdUnlistenedWarning(message),
				holdLateWork: (work) => this._runtimeAdmission.holdBundleUntil(work),
			}),
		);
		track(() => this._toolRecoveryLogger.shutdown());
		safely(() => cleanupSessionResources(this.sessionId));
		// Final sweep of grep/find artifacts already released (reference count zero) but not yet reclaimed, e.g. after a
		// transient cleanup() failure. It never releases a still-referenced artifact (a short session leaves its artifact
		// resolvable on resume) and never touches OTHER sessions' directories. Failures reject `disposeAndWait()`.
		trackRequired(async () => {
			this._pipeline.cleanupToolArtifactStoreOnDispose();
		});
		trackRequired(async () => this._pipeline.clearWorkerContextPolicyLanes());
		return finish();
	}

	/**
	 * Disposes the session and waits for its shutdown. The warnings it still holds then go to its closing sink, unless the owner
	 * takes them itself: a runtime does, through takeUndeliveredWarnings, and passes `drainClosingWarnings: false`.
	 */
	async disposeAndWait(options?: { readonly drainClosingWarnings?: boolean }): Promise<void> {
		this._runtimeBuilder.assertCanAwaitDisposal();
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

	// ---- Read-only State Access ----

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

	/** Foreground preparation or settlement holds the submission while no response streams. */
	get isPreparingSubmission(): boolean {
		return (
			this._promptSubmission.isPreparingSubmission ||
			(!this.isStreaming && this._foregroundRecovery.getCurrentSubmissionEpoch() !== undefined)
		);
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

	/** Build a foreground {@link CapabilityEnvelope} from the live session state (active tools, cwd, cost ceiling). */
	private _buildForegroundEnvelopeFromState(): CapabilityEnvelope {
		return buildForegroundEnvelope({
			turnIndex: this._agentEvents.turnIndex,
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

	getPeerReviewController(): PeerReviewController | undefined {
		return this._runtimeBuilder.getPeerReviewController();
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
		this._toolActivation.applyActiveTools(toolNames);
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
		return this._workState.getSessionWorkState();
	}

	/**
	 * Watchdog for orphaned objectives (F2 / OC-03):
	 * Detects an active objective with no owner, worker, evaluation, or continuation.
	 * Bounded recovery schedules an idle continuation pass; otherwise transitions to blocked.
	 */
	checkOrphanedObjectiveWatchdog(): boolean {
		return this._workState.checkOrphanedObjectiveWatchdog();
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

	// System-prompt construction lives in SystemPromptBuilder (see system-prompt-builder.ts).
	private _refreshBaseSystemPrompt(): void {
		const previousBaseSystemPrompt = this._baseSystemPrompt;
		this._baseSystemPrompt = this._systemPromptBuilder.rebuildSystemPrompt(this.getActiveToolNames());
		if (this.agent.state.systemPrompt === previousBaseSystemPrompt) {
			this.agent.state.systemPrompt = this._baseSystemPrompt;
		}
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
		return this._promptWithRuntimeLease(text, options);
	}

	private async _promptWithRuntimeLease(
		text: string,
		options?: PromptOptions,
		runtimeLease?: RuntimeWorkLease,
	): Promise<void> {
		return this._runtimeAdmission.run(
			"foreground",
			"prompt submission",
			(reader) => this._promptSubmission.prompt(text, options, reader),
			options?.signal,
			runtimeLease,
		);
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
		return this._runtimeAdmission.run("owner-input", "steer", () =>
			this._queuedInputPersistence.admitQueuedOwnerInput("steer", text, images),
		);
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async followUp(text: string, images?: ImageContent[]): Promise<OwnerInputOutcome> {
		return this._runtimeAdmission.run("owner-input", "followUp", () =>
			this._queuedInputPersistence.admitQueuedOwnerInput("followUp", text, images),
		);
	}

	/**
	 * Keep owner input that cannot be submitted yet (the interactive queue while compaction runs) as held pending input:
	 * shown, takeable and recorded with the ranges of it the owner pasted, so a restart restores it held. `prompt()` with
	 * `heldInput` sends it; `existing` is returned while it is still kept.
	 */
	keepQueuedInput(
		kind: "steer" | "followUp",
		text: string,
		images?: ImageContent[],
		existing?: PendingInputHandle,
		pasted?: QueuedInput["pasted"],
	) {
		return this._queuedInputPersistence.keepQueuedInput(kind, text, images, existing, pasted);
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

	private async _drainQueuedExtensionCommands(beginRuntimeHandoff?: () => RuntimeMutationHandoff): Promise<void> {
		return this._queuedInputPersistence.drainQueuedExtensionCommands(beginRuntimeHandoff);
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
		return this._messageDelivery.deliverCustomMessageWithLease(message, options);
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
		return this._messageDelivery.deliverUserMessageWithLease(content, options);
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
		this._humanInput.interrupt(reason);
		this._edgeIntent.abortOptionalIntent();
		// The interrupt cancels queued input whose admission is still undecided; admitted input stays queued.
		this._pendingQueue.cancelAwaiting();
		this._emitQueueUpdate();
		// Cancel the entire submission, including preparation, recovery and postflight around a live run.
		this._promptSubmission.abortSubmission(reason);
		this._foregroundRecovery.abortSubmission(reason);
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
	 * Resolve once the foreground is idle: no submission holds the lease (the agent run has ended AND the
	 * prompt that owned it has finished its tail), no retry, compaction or history rewrite is active, no
	 * System One or semantic evaluation is running, and no idle continuation is armed. `abort()` alone
	 * returns at the first of those; a caller that wants to submit a new root prompt right after an abort
	 * waits for the rest. An armed goal wake counts as busy: wait for its arm, not for idle, to observe it.
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
		return this._setModel(model, options);
	}

	private async _setModel(
		model: Model<Api>,
		options: { persistSettings?: boolean },
		assertCurrent?: () => void,
	): Promise<void> {
		const reader = assertCurrent ? undefined : await this._runtimeAdmission.admit("model", "model selection");
		const validate = assertCurrent ?? (() => reader!.assertCurrent());
		try {
			validate();
			await this._switchSessionModel(model, options, validate);
			validate();
			this._modelAccess.recordTalker(model, ["model selected"]);
		} finally {
			reader?.release();
		}
	}

	private async _switchSessionModel(
		model: Model<Api>,
		options: { persistSettings?: boolean },
		assertCurrent?: () => void,
	): Promise<void> {
		this._compaction.cancelIdlePreparation();
		await this._modelSelection.setModel(model, options, assertCurrent);
		this._localPrefixWarm.schedule(this.agent.state.model);
	}

	/** Re-resolve startup profile model/thinking after allowed extension providers are bound. */
	async reapplyActiveProfileModelSettings(): Promise<void> {
		const reader = await this._runtimeAdmission.admit("model", "profile model selection");
		try {
			const previousModel = this.model;
			await this._profileFilter.reapplyActiveProfileModelSettings();
			const activeToolNames = this._requestedActiveToolNames ?? this.getActiveToolNames();
			this._runtimeBuilder.refreshToolRegistry({ activeToolNames, includeAllExtensionTools: true });
			if (!modelsAreEqual(previousModel, this.model)) {
				this._localPrefixWarm.schedule(this.model);
			}
		} finally {
			reader.release();
		}
	}

	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		const reader = await this._runtimeAdmission.admit("model", "model cycle");
		try {
			const result = await this._modelSelection.cycleModel(direction);
			if (result?.model) this._modelAccess.recordTalker(result.model, ["model selected"]);
			this._localPrefixWarm.schedule(result?.model);
			return result;
		} finally {
			reader.release();
		}
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	setThinkingLevel(level: ThinkingLevel, options: { persistSettings?: boolean } = {}): void {
		this._setThinkingLevel(level, options);
	}

	private _setThinkingLevel(
		level: ThinkingLevel,
		options: { persistSettings?: boolean },
		assertCurrent?: () => void,
	): void {
		this._runtimeAdmission.mutateResources(
			"thinking level",
			() => this._modelSelection.setThinkingLevel(level, options),
			assertCurrent,
		);
	}

	cycleThinkingLevel(): ThinkingLevel | undefined {
		return this._runtimeAdmission.mutateResources("thinking level", () => this._modelSelection.cycleThinkingLevel());
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
		this._runtimeAdmission.mutateResources("steering mode", () => {
			this.agent.steeringMode = mode;
			this.settingsManager.setSteeringMode(mode);
		});
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this._runtimeAdmission.mutateResources("follow-up mode", () => {
			this.agent.followUpMode = mode;
			this.settingsManager.setFollowUpMode(mode);
		});
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
		return this._runtimeAdmission.run("compaction", "manual compaction", () =>
			this._compaction.compact(customInstructions),
		);
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

	/** Cancel in-progress compaction (manual or auto). */
	abortCompaction(): void {
		this._compaction.abort();
	}

	/** Cancel in-progress branch summarization. */
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
	private _getAdaptedCompactionSettings(model?: Model<Api>): CompactionSettings {
		return this._compactionSupport.getAdaptedSettings(model);
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

	/**
	 * Internal: Run auto-compaction with events.
	 */
	private _runAutoCompaction(reason: AutoCompactionReason, willRetry: boolean): Promise<boolean> {
		return this._compaction.runAuto(reason, willRetry);
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this._runtimeAdmission.mutateResources("compaction settings", () => {
			this.settingsManager.setCompactionEnabled(enabled);
		});
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
		const messages = this.agent.state.messages;
		return {
			turn: continuousChatTurnAudit(turn, messages, (message) => this.sessionManager.getMessageEntryId(message)),
		};
	}

	/** SDK startup and extension rebinding activate the selected provider generation. */
	async initializeMemory(): Promise<void> {
		return this._runtimeAdmission.run("resource", "memory initialization", () => this._memory.initialize());
	}

	startBackgroundInputs(): void {
		if (this._isChildSession) return;
		this._durableCustomMessageTurns.startParentInputs();
		this._backgroundLanes.startSessionInputs();
	}

	getMemorySystem(): MemorySystem {
		return this.settingsManager.getMemorySystem();
	}

	setMemorySystem(system: MemorySystem): Promise<{ ok: boolean; message: string }> {
		return this._memory.setMemorySystem(system);
	}

	/** Public entry point delegating to {@link ExtensionBindingController.bindExtensions}. */
	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		return this._runtimeAdmission.run("resource", "extension binding", () =>
			this._extensionBinding.bindExtensions(bindings),
		);
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
		this._registerMemoryProvider(provider);
	}

	private _registerMemoryProvider(provider: MemoryProvider, assertCurrent?: () => void): void {
		this._runtimeAdmission.mutateResources(
			"memory provider registration",
			() => this._memory.registerMemoryProvider(provider),
			assertCurrent,
		);
	}

	registerContextMemoryProvider(provider: ContextMemoryProvider): void {
		this._registerContextMemoryProvider(provider);
	}

	private _registerContextMemoryProvider(provider: ContextMemoryProvider, assertCurrent?: () => void): void {
		this._runtimeAdmission.mutateResources(
			"context memory provider registration",
			() => this._memory.registerContextMemoryProvider(provider),
			assertCurrent,
		);
	}

	/** Registered channels: registration for a deployment wrapper and their read-only states; the session starts them. */
	get channels(): SessionChannelsView {
		return this._backgroundLanes.channels;
	}

	/** Register a deployment-supplied transport channel; it starts only under its `channels.<name>` policy. */
	registerChannelProvider(provider: ChannelProvider): void {
		this._backgroundLanes.channels.registerChannel(provider);
	}

	/** Register a deployment-supplied job scheduler (cron). */
	registerJobScheduler(provider: JobSchedulerProvider): void {
		this._backgroundLanes.channels.registerScheduler(provider);
	}

	async reload(): Promise<void> {
		return this._reloadWithAuthority();
	}

	private async _reloadWithAuthority(options?: RuntimeReloadOptions): Promise<void> {
		await this._compaction.cancelIdlePreparationAndWait();
		return this._runtimeBuilder.reload({
			...options,
			beforeReload: () => {
				options?.beforeReload?.();
				this._foregroundLifecycle.reload();
				this._reflection.invalidateCurrentTurnCueStateCache();
				this.agent.state.messages = this.sessionManager.buildSessionContext().messages;
				this.agent.resetSanitizerPrefixHorizon();
				this._compaction.cancelIdlePreparation();
			},
		});
	}

	/**
	 * Unload a single extension without full reload.
	 * Runs the extension's session_shutdown lifecycle, unregisters its providers,
	 * disposes its event subscriptions, and rebuilds the runtime.
	 * Falls back to full reload on error.
	 */
	async unloadExtensionLive(extensionPath: string): Promise<void> {
		await this._compaction.cancelIdlePreparationAndWait();
		return this._runtimeBuilder.unloadExtensionLive(extensionPath);
	}

	/**
	 * Load a single extension without full reload.
	 * Loads the extension with fresh import, rebuilds the runtime,
	 * and runs the extension's session_start lifecycle.
	 * Falls back to full reload on error.
	 */
	async loadExtensionLive(extensionPath: string): Promise<void> {
		await this._compaction.cancelIdlePreparationAndWait();
		return this._runtimeBuilder.loadExtensionLive(extensionPath);
	}

	/**
	 * Reconcile loaded extensions with the active profile.
	 * Loads extensions that should be enabled but aren't, and unloads extensions that shouldn't be.
	 * Falls back to full reload if any individual load/unload fails.
	 */
	async reconcileLoadedExtensions(): Promise<void> {
		await this._compaction.cancelIdlePreparationAndWait();
		return this._runtimeBuilder.reconcileLoadedExtensions();
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/** Cancel in-progress retry. */
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

	/** Toggle auto-retry setting. */
	setAutoRetryEnabled(enabled: boolean): void {
		this._runtimeAdmission.mutateResources("retry settings", () => {
			this.settingsManager.setRetryEnabled(enabled);
		});
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/** Warm this session's shell so the first command does not pay startup. */
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

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string): void {
		this._setSessionName(name);
	}

	private _setSessionName(name: string, assertCurrent?: () => void): void {
		this._runtimeAdmission.mutateResources(
			"session name",
			() => {
				this.sessionManager.appendSessionInfo(name);
				this._emit({ type: "session_info_changed", name: this.sessionManager.getSessionName() });
			},
			assertCurrent,
		);
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<TreeNavigationResult> {
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

	getTaskAndModelMetrics(nowMs = Date.now()): SessionTaskAndModelSummary {
		return this._analytics.getTaskAndModelMetrics({ nowMs });
	}

	getDailyUsageBreakdown(formatLabel?: (label: string) => string, now = new Date()): string {
		return this._analytics.getDailyUsageBreakdown(formatLabel, now);
	}

	/** Save a snapshot of the goal state to the session log. */
	saveGoalStateSnapshot(state: GoalState, expected?: GoalStateRevision): string {
		return this._goals.saveState(state, expected);
	}

	/** Persist a branch-scoped tombstone and stop goal-owned execution without resurrecting old state. */
	clearGoalStateSnapshot(state: GoalState, now: string): string {
		return this._goals.clearState(state, now);
	}

	/** Retrieve the latest valid goal state snapshot from the session log. */
	getGoalStateSnapshot(): GoalState | undefined {
		return this._goals.getState();
	}

	/** Persist one submitted continuation pass's turn and active-wall-clock telemetry. */
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

	/** Save a snapshot of the evidence bundle to the session log. */
	saveEvidenceBundleSnapshot(bundle: EvidenceBundle): string {
		return appendEvidenceBundleSnapshot(this.sessionManager, bundle);
	}

	/** Retrieve the latest valid evidence bundle snapshot from the active branch. */
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
			...(handoff.record.reasonDetail ? { reasonDetail: handoff.record.reasonDetail } : {}),
		});
	}

	/** A managed or parentless terminal the outbox delivers, reported under the name its worker has. */
	private reportOutboxWorkerTerminal(record: WorkerTerminalHandoffRecord): void {
		this.persistWorkerTerminalReport(this._backgroundLanes.workerAgentIdForRecord(record), record);
	}

	/**
	 * The one owner of the project chat's `[name]` worker reports. Every accepted terminal reaches it once: the parent
	 * handoff, a managed (herdr) lane, and a terminal with no parent. The text is the attempt's persisted claim, or the
	 * terminal status when no claim exists. A worker's private steps are never logged. The chat keys the report by its
	 * attempt, or by the lane generation when no attempt is known, so a redelivered terminal logs nothing twice.
	 */
	private persistWorkerTerminalReport(
		name: string,
		terminal: {
			laneId: string;
			attemptId?: string;
			status: string;
			completedAt?: string;
			reasonCode?: string;
			reasonDetail?: string;
		},
	): void {
		this._backgroundLanes.persistWorkerTerminalReport(name, terminal);
	}

	/** The prefix a chat compaction repeats: the accepted request's, or the agent's current one before any request. */
	private _continuousChatPrefixHead() {
		return this._continuousChatPrefix.resolve(() => continuousChatPrefixOf(this.agent.state));
	}

	saveWorkerClaimSnapshot(
		claim: WorkerClaim,
		request?: WorkerRequest,
		options?: { cwd?: string; parentWriteId?: string },
	): string {
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
		this.goalProof.recordAcceptedWorkerEvidence();
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

	/** The single lane-aware goal-continuation snapshot: the goal loop and the idle scheduler both read live lane state here. */
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

	/** Parent-side pre-launch check for child pi process. */
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

	/** Lane-worker eligibility of model. */
	private laneWorkerRefusalFor(model: Model<Api> | undefined): LaneWorkerRefusal | undefined {
		if (!model) return { reason: "model_unresolved", capabilityClass: "chat" };
		return evaluateLaneWorkerModelRefusal({
			model,
			capabilityMode: this.settingsManager.getModelCapabilitySettings().mode,
			toolProtocol: this._resolveModelToolProtocol(model),
		});
	}

	/** Run one durable worker-agent turn. */
	async runWorkerDelegationOnce(request: WorkerDelegationRequest): Promise<WorkerDelegationRunOutcome> {
		return this._backgroundLanes.runWorkerDelegationOnce(request);
	}

	/** Probe a candidate model against the subagent contracts. */
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

	/** Public entry point for both autosteer and manual continuation. */
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

	private _announceOwnerFollowUpsWhenPresent(): void {
		this._unsettledLadder.announceOwnerFollowUpsWhenPresent();
	}

	/** One owner-completion boundary shared by the goal tool and objective-primary loop. */
	private _resolveGoalCompletionOwnerDecision(input: GoalCompletionOwnerDecisionInput, signal?: AbortSignal) {
		return this._unsettledLadder.resolveGoalCompletionOwnerDecision(input, signal);
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

	/** Explicit compatibility/application reflection pass. */
	async runReflectionPass(input: Parameters<ReflectionController["runReflectionPass"]>[0]) {
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
			context: this._reflection.captureLearningContext(),
			settingsManager: this.settingsManager,
			skillVault: this._skillVault,
			applyWrites: (rawWrites, id, guard) => this._reflection.applyLearnerWrites(rawWrites, { runId: id, guard }),
			routeLesson: createLessonRoutePort({
				agentDir: () => this._agentDir,
				engine: () => this._semanticPlane.recordingSemanticEngine(),
			}),
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

	getLastAssistantText(): string | undefined {
		return this._analytics.getLastAssistantText();
	}

	public getAutonomyStatusSnapshot(): AutonomyStatusSnapshot {
		return this._autonomyTelemetry.getStatusSnapshot();
	}

	/** Read-only effectiveness/autonomy diagnostic snapshot. */
	public getAutonomyDiagnosticSnapshot(options?: { maxEntriesPerFamily?: number }): AutonomyDiagnosticSnapshot {
		return this._autonomyTelemetry.getDiagnosticSnapshot(options);
	}

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(checkedExtensionMessage(message), options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	/** Owner control-plane access for the native /secrets TUI. Never exposed as an agent tool. */
	get credentialManager(): CredentialManager {
		return this._runtimeBuilder.credentialManager;
	}

	get modelRegistry(): ModelRegistry {
		return this._modelRegistry;
	}
	listPersistentBots(defaultModelRef?: string, teamId?: string): PersistentBotView[] {
		return this._backgroundLanes.listPersistentBots(defaultModelRef, teamId);
	}
	listManagedLanes(): ManagedLaneView[] {
		return this._backgroundLanes.listManagedLanes();
	}
	listPersistentTeams(): PersistentTeamRecord[] {
		return this._backgroundLanes.listPersistentTeams();
	}
	getPersistentTeam(teamId: string): PersistentTeamRecord | undefined {
		return this._backgroundLanes.getPersistentTeam(teamId);
	}
	upsertPersistentBot(input: UpsertPersistentBotInput): PersistentBotRecord {
		return this._backgroundLanes.upsertPersistentBot(input);
	}
	retirePersistentBot(agentId: string): { retired: boolean; detail: string } {
		return this._backgroundLanes.retirePersistentBot(agentId);
	}
	stopPersistentBot(agentId: string): { stopped: boolean; detail: string } {
		return this._backgroundLanes.stopPersistentBot(agentId);
	}
	upsertPersistentTeam(input: UpsertPersistentTeamInput): PersistentTeamRecord {
		return this._backgroundLanes.upsertPersistentTeam(input);
	}
	setPersistentTeamMembers(teamId: string, memberAgentIds: readonly string[]): PersistentTeamRecord {
		return this._backgroundLanes.setPersistentTeamMembers(teamId, memberAgentIds);
	}
	deletePersistentTeam(teamId: string): boolean {
		return this._backgroundLanes.deletePersistentTeam(teamId);
	}
	readBotChatMessages(agentId: string, teamId?: string): AgentMessage[] {
		return this._backgroundLanes.readBotChatMessages(agentId, teamId);
	}
	readTeamChatMessages(teamId: string): AgentMessage[] {
		return this._backgroundLanes.readTeamChatMessages(teamId);
	}
	subscribeOrchestrationStore(listener: () => void): () => void {
		return this._backgroundLanes.subscribeOrchestrationStore(listener);
	}
	subscribeBotTeamUpdates(listener: Parameters<BackgroundLaneController["subscribeBotTeamUpdates"]>[0]): () => void {
		return this._backgroundLanes.subscribeBotTeamUpdates(listener);
	}
	resolveModelSpec(rawModel?: string) {
		return this._backgroundLanes.resolveModelSpec(rawModel);
	}
	getRootModelLabel(): string {
		return this._backgroundLanes.getRootModelLabel();
	}
	getRootStatusLabel(): string {
		return this.isStreaming ? "streaming" : "idle";
	}
	sendSessionRootWorkerAgentMessage(agentId: string, message: string) {
		return this._backgroundLanes.sendSessionRootWorkerAgentMessage(agentId, message);
	}
	followUpSessionRootWorkerAgent(agentId: string, message: string) {
		return this._backgroundLanes.followUpSessionRootWorkerAgent(agentId, message);
	}
	sendOperatorMessageToBot(
		agentId: string,
		message: string,
		options?: Parameters<BackgroundLaneController["sendOperatorMessageToBot"]>[2],
	) {
		return this._backgroundLanes.sendOperatorMessageToBot(agentId, message, options);
	}
	sendOperatorMessageToTeam(teamId: string, message: string) {
		return this._backgroundLanes.sendOperatorMessageToTeam(teamId, message);
	}
	getBotTeamStore() {
		return this._backgroundLanes.getBotTeamStore();
	}
	tickPersistentRoutines(routineId?: string) {
		return this._backgroundLanes.tickPersistentRoutines(routineId);
	}
	getPersistentBotDaemonStatus() {
		return this._backgroundLanes.getPersistentBotDaemonStatus();
	}
	/** Read-only snapshot of the session's automatic work (`core/autonomy-status`): builds no owner, writes nothing. */
	autonomyStatus() {
		return this._backgroundLanes
			.readAutonomyStatus(this._foregroundRecovery, this._harnessNotices, this._memory)
			.then((status) => this._ownerReturnBrief.withOwnerDecisions(status));
	}
	startPersistentBotDaemon() {
		return this._backgroundLanes.startPersistentBotDaemon();
	}
	stopPersistentBotDaemon() {
		return this._backgroundLanes.stopPersistentBotDaemon();
	}
}
