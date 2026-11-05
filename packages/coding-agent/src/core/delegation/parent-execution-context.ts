/**
 * The complete set of collaborators that worker execution needs from its parent session, and nothing else.
 *
 * `WorkerDelegationController` reads its parent only through this context (plus its bot-message directory factory),
 * and the lifecycle, notification and receipt plumbing that `BackgroundLaneController` assembles around it reads the
 * same members besides routine ownership. It has four parts: the environment it runs in, the policy and judges a
 * worker run consults, readers of live foreground state, and the port every write into the parent goes through. The
 * foreground composition is `AgentSession`'s background-lane wiring plus the transcript writes the background-lane
 * controller derives from the session's writer. Every member is a lazy closure over the live session, because the
 * session reloads its resources and builds several owners (memory, model router, tool performance) after
 * this wiring.
 */

import type { Api, AssistantMessage, Message, Model, Usage } from "@caupulican/pi-ai";
import type { AgentContextPlan, AgentContextWire, AgentMessage, AgentTool } from "../../kernel/index.ts";
import type { SessionManager } from "../../kernel/node.ts";
import type { SessionRequestSnapshotInput } from "../../kernel/session/session-manager.ts";
import type {
	AgentSessionEvent,
	IsolatedCompletionOptions,
	IsolatedCompletionResult,
} from "../agent-session-contracts.ts";
import type { CapabilityEnvelope, WorkerClaim, WorkerCommandReceipt, WorkerRequest } from "../autonomy/contracts.ts";
import type { EdgeGrantView } from "../autonomy/edge-policy.ts";
import type { SharedLaneToolOptions } from "../autonomy/lane-tool-surface.ts";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import type { AutonomyTelemetryEvent } from "../autonomy/telemetry-events.ts";
import type { ArtifactStore } from "../context/context-artifacts.ts";
import type { PathAliasTable } from "../context/path-alias-table.ts";
import type { RouteChoiceJudge } from "../expert-routing/system-one-choice.ts";
import type {
	HmoeIndependence,
	HmoePreference,
	HmoePreset,
	HmoeTeamStrategy,
	HmoeWeights,
} from "../expert-routing/vocabulary.ts";
import type { GoalState } from "../goals/goal-state.ts";
import type { KnowledgeGrant, KnowledgeGrantReference } from "../memory/knowledge-grant.ts";
import type { LaneMemoryCapacitySource, WorkerMemoryBroker } from "../memory/worker-memory-tools.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { RepositoryMutationObserver } from "../objective-execution/repository-mutation-observer.ts";
import type { OrchestrationProfile, OrchestrationThinkingLevel } from "../orchestration/contracts.ts";
import type { OrchestrationModelUnusableCause } from "../orchestration/model-binding.ts";
import type { PersistedSessionTaskProfileRecord } from "../orchestration/session-task-profile-store.ts";
import type {
	AttemptParentWrite,
	AttemptRuntimeState,
	TaskRuntimeProjection,
} from "../orchestration/task-runtime-state.ts";
import type { WorkerModelPinPolicy } from "../orchestration/worker-model-pins.ts";
import type { WorkerReceiptAnchor, WorkerReceiptOrigin } from "../orchestration/worker-receipt-origin.ts";
import type { ProfileRegistry } from "../profile-registry.ts";
import type { ResourceLoader } from "../resource-loader.ts";
import type { CredentialExposureBoundary } from "../secrets/credential-exposure-guard.ts";
import type {
	ModelCapabilitySettings,
	ModelFavorite,
	ModelRouterPoolPreference,
	ModelRouterSelectionMode,
	ResolvedEdgeSettings,
	ResolvedWorkerDelegationSettings,
	SystemOneSettings,
	ThinkingLevel,
	WorkerAccountRouting,
	WorkerThinkingPolicy,
} from "../settings/settings-schema.ts";
import type { WorkerProgressObservation } from "../supervision/worker-supervision-coordinator.ts";
import type { SystemOneProviderChoice } from "../system-one/access.ts";
import type { ToolkitScript } from "../toolkit/script-registry.ts";
import type { ReadOnlySkillBroker } from "../tools/skill.ts";
import type { SkillAuditToolOptions } from "../tools/skill-audit.ts";
import type { TimerSource } from "../util/timer-port.ts";
import type { WorkerResponseObservation, WorkerToolSelection } from "./worker-attempt-executor.ts";
import type { WorkerTerminalHandoffRecord } from "./worker-notification-coordinator.ts";
import type { WorkerTerminalHandoff } from "./worker-terminal-handoff-coordinator.ts";

/** The settings worker execution reads, declared here; the composition root passes the SettingsManager. */
export interface ParentExecutionSettingsSource {
	getCompactionSettings(): {
		enabled: boolean;
		reserveTokens: number;
		keepRecentTokens: number;
		triggerPercent: number;
	};
	getEdgeSettings(): ResolvedEdgeSettings;
	getMemoryRetrievalSettings(): {
		enabled: boolean;
		maxResults: number;
		includeInPrompt: boolean;
		allowExternalEgress: boolean;
	};
	getModelCapabilitySettings(): Required<ModelCapabilitySettings>;
	getModelFavorites(): ModelFavorite[];
	getModelRouterSettings(): {
		enabled: boolean;
		selectionMode: ModelRouterSelectionMode;
		poolPreference: ModelRouterPoolPreference;
		cheapModel?: string;
		mediumModel?: string;
		expensiveModel?: string;
		learningModel?: string;
		executorModel?: string;
		fitnessGate: boolean;
		cheapThinking?: ThinkingLevel;
		mediumThinking?: ThinkingLevel;
		expensiveThinking?: ThinkingLevel;
		executorThinking?: ThinkingLevel;
		hmoePreset?: HmoePreset;
		hmoeTeamStrategy?: HmoeTeamStrategy;
		hmoeIndependence?: HmoeIndependence;
		hmoePreference?: HmoePreference;
		hmoeWeights?: HmoeWeights;
	};
	getProfileRegistry(): ProfileRegistry;
	getProjectContextFiles(): "on-demand" | "off";
	getSystemOneSettings(): {
		enabled: boolean;
		provider: SystemOneProviderChoice;
		loopMode?: SystemOneSettings["loopMode"];
		completionProfile?: SystemOneSettings["completionProfile"];
	};
	getToolkitScripts(): ToolkitScript[];
	getWorkerAccountRouting(): WorkerAccountRouting;
	getWorkerDelegationSettings(): ResolvedWorkerDelegationSettings;
	getWorkerModelPinPolicy(): WorkerModelPinPolicy;
	getWorkerThinkingPolicy(): WorkerThinkingPolicy;
	isProjectTrusted(): boolean;
}

/** Where worker execution runs: identity, paths, settings, resources, clocks and the parent's stores. */
export interface ParentExecutionEnvironment {
	isDisposed(): boolean;
	getSessionId(): string;
	getCwd(): string;
	getAgentDir(): string;
	/** The parent's transcript, read-only to worker execution. */
	getSessionManager(): ParentSessionReader;
	getSettingsManager(): ParentExecutionSettingsSource;
	getResourceLoader(): ResourceLoader;
	getActiveOrchestrationProfile?(): OrchestrationProfile | undefined;
	getModelRegistry(): ModelRegistry;
	/** The session's timer source: the write-reservation release backoff and the worker retry ladder arm their alarms on its ports. */
	getTimers(): TimerSource;
	/** Parent session's canonical credential source; worker evidence and reviewer calls share it. */
	getCredentialExposureBoundary?(): CredentialExposureBoundary;
	/** Root's tool mechanics (output reduction, encodings, shell engine, packing), shared with every lane. */
	getSharedLaneToolOptions?(): SharedLaneToolOptions;
	/** Session-owned artifact store broker; worker adapters receive fresh retrieval tools only. */
	getArtifactStore?(): ArtifactStore;
	/** The session's context-GC store, where `artifact_retrieve context:<key>` originals live. */
	getContextGcStoreDir?(): string | undefined;
	/** Host-owned path alias table getter for expanding alias tokens in worker tool arguments. */
	getPathAliasTable?: () => PathAliasTable;
	/** Shared-worktree attempts are one root observation. Isolated git dirs stay private. */
	repositoryObserver?: RepositoryMutationObserver;
	getSessionCwd?(): string;
	getObjectiveId?(): string;
}

/** The decisions a worker run consults: model availability, System One judges, context planning, memory, skills, edges. */
export interface ParentExecutionPolicy {
	modelUnusableCause(model: Model<Api>): OrchestrationModelUnusableCause | undefined;
	/** The session's existing System One owner; admission never creates a separate reviewer. */
	getRouteChoiceJudge?(): RouteChoiceJudge | undefined;
	isSystemOneEnabled?(): boolean;
	/**
	 * Plan a worker request's context with root's request-context controller on the worker's lane:
	 * context GC priced on the worker's model and retention trigger, path aliases, the authority context.
	 */
	planWorkerRequest?(input: {
		agentId: string;
		model: Model<Api>;
		compactionTriggerTokens: number | undefined;
		messages: AgentMessage[];
		sentPrefixCount: number;
		/** The worker's own tool surface: what its lane's context policy can rely on (a retrieval tool). */
		toolNames: readonly string[];
		signal?: AbortSignal;
		/** What the request carries to the model outside `messages` (`AgentContextPlanRequest.wire`). */
		wire?: AgentContextWire;
	}): Promise<AgentContextPlan>;
	/** The cache guard for worker lanes: each accepted worker provider request, as its recorded snapshot. */
	observeWorkerRequest?(agentId: string, snapshot: SessionRequestSnapshotInput, prefixTokens?: number): void;
	/** Each worker provider response, as a cache observation on the worker conversation's own history. */
	observeWorkerResponse?(message: AssistantMessage, observation: WorkerResponseObservation): void;
	/** Tool selection for a worker's model and tools, sharing root's evidence store. */
	createWorkerToolSelection?(model: Model<Api>, tools: readonly AgentTool[]): WorkerToolSelection;
	/**
	 * Whether an early compaction of a worker conversation pays for itself now: the same priced verdict
	 * root's session lane decides with, on the worker conversation's own cache facts.
	 */
	admitWorkerEarlyCompaction?(input: {
		agentId: string;
		model: Model<Api>;
		contextTokens: number;
		messages: readonly AgentMessage[];
	}): boolean;
	/** A worker compaction's measured effect on its lane, recorded where root records its own. */
	recordWorkerCompactionOutcome?(input: {
		agentId: string;
		model: Model<Api>;
		tokensBefore: number;
		tokensAfter: number;
		outputTokens: number;
	}): void;
	/** Record a model a worker ran out of quota, where root's billing failover records its own. */
	markModelExhausted?(model: Model<Api>, retryAfterMs?: number): void;
	/**
	 * A fresh read-only memory port for one lane; the handles it admits never reach another lane. Reads are
	 * sized against `capacity`: the receiving lane's own request, never the root model's.
	 */
	createLaneMemoryBroker(
		capacity: LaneMemoryCapacitySource,
		knowledgeReferences?: () => readonly KnowledgeGrantReference[],
	): WorkerMemoryBroker;
	/** Validate root-selected canonical versions without transferring owner-wide memory authority. */
	captureKnowledgeGrant?(references: readonly KnowledgeGrantReference[]): KnowledgeGrant;
	/** Bounded applicable owner working preferences for a handoff, or undefined when there are none. */
	getHandoffPersonaGuidance?(): string | undefined;
	/** Host-owned read-only skill broker; no SkillVaultController crosses this boundary. */
	getSkillReadBroker?(): ReadOnlySkillBroker;
	/** Host-owned skill metadata source for read-only audit; paths are redacted before projection. */
	getSkillAuditSource?(): Pick<SkillAuditToolOptions, "getSkills"> &
		Required<Pick<SkillAuditToolOptions, "redactPath">>;
	runIsolatedCompletion(opts: IsolatedCompletionOptions): Promise<IsolatedCompletionResult>;
	/** Parent admitted edge grants for worker edge authorization without interactive prompts. */
	getEdgeGrants?(): readonly EdgeGrantView[];
	/** Settles the owner's queued words before a worker call reads the parent's grants or delivery limit. */
	settleOwnerPolicy?(): Promise<void>;
	/** System One's operation gate for a worker's call the deterministic gates cannot decide (refused unless granted). */
	checkOperation?(toolName: string, args: unknown, cwd: string): Promise<{ block: true; reason: string } | undefined>;
	/** Set when the parent task is bound to local commits. Workers refuse git push on this branch. */
	localCommitBranch?(): string | undefined;
	/**
	 * The parent's semantic duplicate review of code a worker's edit or write added. Its note is appended
	 * to that tool result so the worker reuses existing logic, exactly as the root's own edits are steered.
	 */
	reviewNewCode?(input: { toolName: string; args: unknown; cwd: string }): Promise<string | undefined>;
	/**
	 * Blockers for a worker's report from its own transcript: claims the transcript's tool results
	 * contradict, and a verifier's acceptance its own transcript does not back. Any blocker makes the
	 * claim need parent review instead of being accepted.
	 */
	reviewWorkerReport?(input: {
		summary: string;
		messages: readonly Message[];
		verifierVerdict?: "accepted" | "rejected";
		hostVerifiedChecks?: readonly WorkerCommandReceipt[];
	}): Promise<readonly string[]>;
	/**
	 * The unsettled-item ladder for a worker's `inconclusive` findings: System One, then a stronger
	 * model with System One, over the worker's own transcript. What stays open is returned for the
	 * owner, and under a handoff is already written to the owner's follow-up document.
	 */
	settleInconclusive?(input: {
		items: readonly string[];
		messages: readonly Message[];
		signal?: AbortSignal;
		/** The worker attempt the findings came from: what stays open is that attempt's parent write. */
		attemptId?: string;
	}): Promise<{ settled: readonly string[]; unsettled: readonly string[]; ownerFollowUp?: string }>;
	/**
	 * Present on a host that runs only part of its parent's work (a parent opened away runs only its routine runs):
	 * restart recovery, verification dispatch, recovered terminals and mailbox adoption act only on the attempts this
	 * admits, and every other attempt stays durable for the parent. Absent, the host runs all of its parent's work.
	 */
	runsAttempt?(attempt: AttemptRuntimeState, snapshot: TaskRuntimeProjection): boolean;
	/**
	 * Present on a host that bounds one run's whole spend: every attempt of the run (subject, retries and verifier) that
	 * returns the same `runId` shares one cost budget of `maxCostUsd`, checked before each provider request on top of
	 * the attempt's own agent tree budget. Absent, or undefined for an attempt, only the agent tree budget applies.
	 */
	runCostBound?(
		attempt: AttemptRuntimeState,
		snapshot: TaskRuntimeProjection,
	): { readonly runId: string; readonly maxCostUsd: number } | undefined;
	/** The owner's live model policy; a worker bound to a model it disallows is reallocated. */
	isModelAllowed?(model: Model<Api>): boolean;
	/** The best model the policy allows, for a worker whose own binding it disallows. */
	allocateAllowedModel?(): Model<Api> | undefined;
}

/** Live foreground state a worker run reads: the session model, its tool surface, its envelope and its turn. */
export interface ForegroundStateReaders {
	getModel(): Model<Api> | undefined;
	getForegroundThinkingLevel?(): OrchestrationThinkingLevel;
	getForegroundToolNames?(): readonly string[];
	isDelegateToolActive(): boolean;
	getCapabilityEnvelope(): CapabilityEnvelope | undefined;
	/** Live worker supervision hook; one observation per executed worker tool call. */
	observeWorkerProgress?(observation: WorkerProgressObservation, signal?: AbortSignal): Promise<unknown> | unknown;
	getGoalStateSnapshot(): GoalState | undefined;
	/** Current foreground submission epoch, or undefined when none is held. Read once, at genuine
	 * lane-creation time in `prepareWorkerAttempt`, to stamp the new lane's owner epoch via
	 * `WorkerNotificationCoordinator.noteAttemptOwnerEpoch` -- see that method's doc comment. */
	getCurrentSubmissionEpoch?(): number | undefined;
	/**
	 * The project chat's view a worker is born with, before its task: the delegating turn's pinned view, or the latest
	 * turn's when none runs. Undefined while no ICM chat runs.
	 */
	getContinuousChatBirthView?(): { view: string; timestamp: number } | undefined;
}

/** What worker execution reads from the parent transcript; every write goes through {@link ParentWritePort}. */
export type ParentSessionReader = Pick<
	SessionManager,
	"getBranch" | "getEntries" | "getEntry" | "getLeafId" | "buildSessionContext" | "getSessionLineageIds"
>;

/**
 * Names the attempt a parent write belongs to, so a host that does not own the parent transcript records it on that
 * attempt. `parentWriteId` is set only by the parent's import of such a record and is stored with the entry it
 * appends, which is how a repeated import finds that the write already landed.
 */
export interface ParentWriteOrigin {
	attemptId?: string;
	parentWriteId?: string;
}

/**
 * A recorded write the parent imports: `imported` once its entry is physically persisted, `pending` while it may still
 * land, `refused` (reported once) when this parent can never land it.
 */
export type ParentWriteImport = "imported" | "pending" | "refused";

/**
 * Every write worker execution makes into its parent. The foreground port appends to the parent transcript at once,
 * exactly as the session always has. A host that does not own the parent transcript records each transcript write on
 * its attempt instead (`attempt.parent_write_recorded`), and the parent imports those records on open.
 */
export interface ParentWritePort {
	emit(event: AgentSessionEvent): void;
	/** Steer a notice to the owning parent session (a custom message that may trigger a turn). */
	notifyParentSession?(customType: string, text: string, origin?: ParentWriteOrigin): void;
	notifyWorkerTerminalHandoff(records: readonly WorkerTerminalHandoffRecord[]): Promise<void>;
	emitAutonomyTelemetry(event: AutonomyTelemetryEvent): void;
	/**
	 * `options.cwd` is the directory the claim's relative `changedFiles` resolve against (the worker's own
	 * execution directory); the parent-review marker is re-derived against it, so a worker in a task directory or a
	 * worktree lane is judged against its own scope and not the process's.
	 */
	saveWorkerClaimSnapshot(
		claim: WorkerClaim,
		request?: WorkerRequest,
		options?: { cwd?: string } & ParentWriteOrigin,
	): void;
	/**
	 * A terminal handoff the parent has taken: the project chat logs the attempt's claim once, as its `[name]` report.
	 * A failed write is returned, never thrown, so the handoff stays retained and is offered again.
	 */
	reportWorkerTerminal?(handoff: Readonly<WorkerTerminalHandoff>): { ok: true } | { ok: false; reason: string };
	/** The compatibility lane-record projection of a published terminal. */
	appendLaneRecordSnapshot(record: LaneRecord): void;
	/** A session task profile, created only by the root's delegate tool. */
	appendSessionTaskProfile(record: PersistedSessionTaskProfileRecord): void;
	/**
	 * The lineage a parentless worker's receipts publish under, captured before admission can await. An empty branch
	 * gets an explicit anchor entry; a dispatch whose origin is already pinned (a saved intent) never calls this.
	 */
	captureReceiptOrigin(assertOuterCurrent?: () => void, anchor?: WorkerReceiptAnchor): WorkerReceiptOrigin;
	/**
	 * Present only on the host that owns the parent transcript: import one write another host recorded on `attemptId`,
	 * exactly once. It runs before that attempt's terminal is published here, so the published terminal reads the
	 * imported claim. It never throws: a failure is reported once and the write stays `pending`, and a write this parent
	 * can never land is reported once and `refused`, so it cannot hold its attempt's terminal.
	 */
	importParentWrite?(attemptId: string, write: AttemptParentWrite): ParentWriteImport;
	/**
	 * Findings a worker could not settle, kept by the parent for the owner's review at its next turn boundary. A host
	 * without the parent's owner queue records them for the parent to import; it never drops them.
	 */
	recordUnsettledForOwner(items: readonly string[], origin?: ParentWriteOrigin): string | undefined;
	addSpawnedUsage(
		usage: Usage,
		opts: { label?: string; sourceSessionId?: string; reportId: string },
	): string | undefined;
	/** Parent objective mutation ledger. Workers do not keep a second ownership record. */
	recordObjectiveMutation?(event: {
		readonly kind: "owned_write" | "shell";
		readonly path?: string;
		readonly cwd: string;
	}): void;
}

export interface ParentExecutionContext
	extends ParentExecutionEnvironment,
		ParentExecutionPolicy,
		ForegroundStateReaders,
		ParentWritePort {}
