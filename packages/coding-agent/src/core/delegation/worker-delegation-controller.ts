import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type { Api, Model, Usage } from "@caupulican/pi-ai";
import { getProcessWorkRun } from "../agent-paths.ts";
import type {
	AgentSessionEvent,
	IsolatedCompletionOptions,
	IsolatedCompletionResult,
	WorkerDelegationRunOutcome,
} from "../agent-session-contracts.ts";
import type { CapabilityEnvelope, WorkerClaim, WorkerRequest } from "../autonomy/contracts.ts";
import { getPrivateLaneDeniedPaths } from "../autonomy/lane-private-paths.ts";
import { createLaneToolSurface } from "../autonomy/lane-tool-surface.ts";
import { isLaneTerminalStatus, type LaneRecord, type LaneTerminalStatus } from "../autonomy/lane-tracker.ts";
import { appendLaneRecordSnapshot } from "../autonomy/session-lane-record.ts";
import { AUTONOMY_TELEMETRY_EVENT_TYPES, type AutonomyTelemetryEvent } from "../autonomy/telemetry-events.ts";
import { STABLE_SHELL_TOOL_NAME } from "../default-tool-surface.ts";
import type { GoalState } from "../goals/goal-state.ts";
import { deriveModelCapabilityProfile, type ModelCapabilityProfile } from "../model-capability.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { isLoopbackModelEndpoint } from "../models/model-endpoint.ts";
import { providerUsageFromAttemptUsage } from "../orchestration/attempt-usage.ts";
import {
	type AttemptUsageSnapshot,
	type ExecutionGrant,
	MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH,
	type OrchestrationProfile,
	type ResourcePointer,
	type WorkerExecutionContract,
} from "../orchestration/contracts.ts";
import type { StartedDelegationAttempt } from "../orchestration/delegation-ledger.ts";
import { SessionTaskProfileStore } from "../orchestration/session-task-profile-store.ts";
import {
	type TaskProfileCreateInput,
	type TaskProfileCreateResult,
	type TaskProfileInspection,
	TaskProfileWriter,
} from "../orchestration/task-profile-writer.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import type { WorkerContextForkReference } from "../orchestration/worker-context-fork-reference.ts";
import {
	createWorkerExecutionContract,
	verifierWorkerExecutionContract,
} from "../orchestration/worker-execution-contract.ts";
import { registerInFlightWork } from "../reload-blockers.ts";
import type { ResourceLoader } from "../resource-loader.ts";
import type { ResolvedWorkerDelegationSettings, SettingsManager } from "../settings-manager.ts";
import { createDelegateToolDefinition } from "../tools/delegate.ts";
import { disposePersistentShellSession } from "../tools/shell-session.ts";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import { selectSanitizedContextFork } from "./sanitized-context-fork.ts";
import { applyWorkerActions } from "./worker-actions.ts";
import type { WorkerAgentControlPort } from "./worker-agent-control.ts";
import { WorkerAgentControlCoordinator } from "./worker-agent-control-coordinator.ts";
import { createWorkerAttemptExecutor } from "./worker-attempt-executor.ts";
import { resolveWorkerAuthority } from "./worker-authority-resolver.ts";
import { WorkerContextForkStore, WorkerContextForkStoreError } from "./worker-context-fork-store.ts";
import { resolveWorkerContextInheritanceMode } from "./worker-context-inheritance-policy.ts";
import {
	type WorkerConversation,
	type WorkerConversationRetentionPolicy,
	WorkerConversationStore,
} from "./worker-conversation-store.ts";
import { parseWorkerDelegationAuthorityRequest, type WorkerDelegationRequest } from "./worker-delegation-request.ts";
import { type WorkerDispatchAdmission, WorkerDispatchScheduler } from "./worker-dispatch-scheduler.ts";
import {
	buildWorkerExecutionPlan,
	compileWorkerExecutionGrant,
	narrowWorkerExecutionPlan,
	type WorkerExecutionPlan,
	workerExecutionAuthorityFromPlan,
} from "./worker-execution-policy.ts";
import {
	DEFAULT_WORKER_FLEET_LIMITS,
	evaluateNewWorkerAdmission,
	pendingVerifierSubjectTaskIds,
} from "./worker-fleet-limits.ts";
import type { PendingVerificationRecovery, WorkerLifecycle } from "./worker-lifecycle.ts";
import type { WorkerNotificationCoordinator } from "./worker-notification-coordinator.ts";
import { createLocalWorkerProcessOwnerId } from "./worker-process-owner.ts";
import { type ResolvedWorkerProfile, WorkerProfileResolver } from "./worker-profile-resolver.ts";
import { WorkerRecoveryCoordinator, type WorkerRecoveryDispatchResult } from "./worker-recovery-coordinator.ts";
import { selectWorkerResourcePointers } from "./worker-resource-catalog.ts";
import { materializeWorkerResourceBundle } from "./worker-resource-materializer.ts";
import { finalizeWorkerClaim } from "./worker-terminal-finalizer.ts";
import {
	type WorkerTerminalHandoff,
	WorkerTerminalHandoffCoordinator,
	type WorkerTerminalHandoffDelivery,
} from "./worker-terminal-handoff-coordinator.ts";
import { collectWorkerTreeBudgetSeeds, WorkerTreeBudgetCoordinator } from "./worker-tree-budget-coordinator.ts";
import { WorkerWriteReservationCoordinator } from "./worker-write-reservation-coordinator.ts";

export function isLocalExecutionModel(model: Pick<Model<Api>, "provider" | "baseUrl">): boolean {
	if (model.provider === "ollama" || model.provider === "transformers" || model.provider === "llama-cpp") {
		return true;
	}
	return isLoopbackModelEndpoint(model.baseUrl);
}

function workerConversationRetentionPolicy(
	model: Model<Api>,
	settingsManager: SettingsManager,
): WorkerConversationRetentionPolicy | undefined {
	const settings = settingsManager.getCompactionSettings();
	const contextWindow = Math.floor(model.contextWindow ?? 0);
	if (!settings.enabled || contextWindow < 4) return undefined;
	const reserveTokens = Math.min(settings.reserveTokens, Math.floor(contextWindow * 0.25));
	const reserveTrigger = contextWindow - reserveTokens;
	const fractionalTrigger =
		settings.triggerPercent > 0 && settings.triggerPercent < 1
			? Math.floor(contextWindow * settings.triggerPercent)
			: reserveTrigger;
	const modelTrigger =
		model.autoCompactionTriggerTokens && model.autoCompactionTriggerTokens > 0
			? Math.floor(model.autoCompactionTriggerTokens)
			: reserveTrigger;
	const maxContextTokens = Math.min(reserveTrigger, fractionalTrigger, modelTrigger);
	if (maxContextTokens < 2) return undefined;
	return {
		maxContextTokens,
		keepRecentTokens: Math.max(
			1,
			Math.min(settings.keepRecentTokens, Math.floor(contextWindow * 0.5), maxContextTokens - 1),
		),
	};
}

export interface WorkerDelegationControllerDeps {
	isDisposed(): boolean;
	getSessionId(): string;
	getCwd(): string;
	getAgentDir(): string;
	getSessionManager(): SessionManager;
	getSettingsManager(): SettingsManager;
	getResourceLoader(): ResourceLoader;
	getActiveOrchestrationProfile?(): OrchestrationProfile | undefined;
	getModelRegistry(): ModelRegistry;
	isModelExhausted(model: Model<Api>): boolean;
	getModel(): Model<Api> | undefined;
	isDelegateToolActive(): boolean;
	getCapabilityEnvelope(): CapabilityEnvelope | undefined;
	emit(event: AgentSessionEvent): void;
	notifyWorkerTerminalHandoff(
		records: readonly { laneId: string; status: LaneTerminalStatus; reasonCode?: string }[],
	): Promise<void>;
	emitAutonomyTelemetry(event: AutonomyTelemetryEvent): void;
	getGoalStateSnapshot(): GoalState | undefined;
	saveWorkerClaimSnapshot(claim: WorkerClaim, request?: WorkerRequest): string;
	queueWorkerHumanInput(request: { workerRequestId: string; message: string; blockers: readonly string[] }): void;
	readMemoryForLane(query: string): Promise<string>;
	addSpawnedUsage(
		usage: Usage,
		opts: { label?: string; sourceSessionId?: string; reportId: string },
	): string | undefined;
	runIsolatedCompletion(opts: IsolatedCompletionOptions): Promise<IsolatedCompletionResult>;
}

type WorkerAdmission =
	| {
			ok: true;
			instructions: string;
			settings: ResolvedWorkerDelegationSettings;
			shipment: ResolvedWorkerProfile;
			verifierShipment?: ResolvedWorkerProfile;
			/** Exact pointer selection persisted when this request is admitted. */
			resourcePointerIds: readonly string[];
			executionContract: WorkerExecutionContract;
			executionPlan: WorkerExecutionPlan;
	  }
	| { ok: false; skipReason: string };

interface PreparedWorkerAttempt {
	executionPlan: WorkerExecutionPlan;
	lifecycle: WorkerLifecycle;
	record: LaneRecord;
	attempt?: AttemptRuntimeState;
}

interface PreparedWorkerAgent {
	conversation: WorkerConversation;
	resources: readonly ResourcePointer[];
	resourceSystemPrompt: string;
}

type QueuedWorkerAttemptOutcome = { started: false; skipReason: string } | { started: true; record: LaneRecord };

interface WorkerContextForkSource {
	model: { provider: string; model: string };
	messages: readonly AgentMessage[];
}

function workerContextModelIdentity(modelRef: string | undefined): { provider: string; model: string } {
	if (!modelRef) throw new Error("Worker parent resume model is missing.");
	const separator = modelRef.indexOf("/");
	if (separator <= 0 || separator === modelRef.length - 1) {
		throw new Error("Worker parent resume model is invalid.");
	}
	return { provider: modelRef.slice(0, separator), model: modelRef.slice(separator + 1) };
}

export class WorkerDelegationController {
	private readonly deps: WorkerDelegationControllerDeps;
	private readonly workerAbort = new AbortController();
	private readonly lifecycle: WorkerLifecycle;
	private profileResolver: WorkerProfileResolver | undefined;
	private taskProfileStore: SessionTaskProfileStore | undefined;
	private taskProfileWriter: TaskProfileWriter | undefined;
	private readonly recovery: WorkerRecoveryCoordinator;
	private readonly notifications: WorkerNotificationCoordinator;
	private readonly scheduler: WorkerDispatchScheduler;
	private readonly laneAbortControllers = new Map<string, AbortController>();
	private readonly shellSessionKeys = new Set<string>();
	/** Sole logical-agent control/mailbox owner; execution only calls its narrow delivery hooks. */
	private readonly agentControl: WorkerAgentControlCoordinator;
	private readonly publishedTerminalAttemptIds = new Set<string>();
	private readonly yieldedCapacityAttemptIds = new Map<string, number>();
	private readonly conversations = new WorkerConversationStore();
	private readonly contextForks: WorkerContextForkStore;
	private readonly terminalHandoffs: WorkerTerminalHandoffCoordinator;
	private readonly treeBudgets = new WorkerTreeBudgetCoordinator();
	private readonly writeReservations: WorkerWriteReservationCoordinator;
	private readonly inFlightLedgers = new Map<
		string,
		{
			changedFiles: Set<string>;
			getUsage: () => AttemptUsageSnapshot;
			request: WorkerRequest;
			handle: StartedDelegationAttempt;
		}
	>();

	constructor(
		deps: WorkerDelegationControllerDeps,
		notifications: WorkerNotificationCoordinator,
		lifecycle: WorkerLifecycle,
	) {
		this.deps = deps;
		this.notifications = notifications;
		this.lifecycle = lifecycle;
		this.contextForks = new WorkerContextForkStore({
			agentDir: this.deps.getAgentDir(),
			parentSessionId: this.deps.getSessionId(),
		});
		this.scheduler = new WorkerDispatchScheduler({
			agentDir: this.deps.getAgentDir?.() ?? "",
			isDisposed: () => this.deps.isDisposed(),
			admit: (request, record) => this.workerDispatchAdmission(request, record),
			getRecord: (laneId) => this.getWorkerLifecycle().getRecord(laneId),
			run: (request, record) => this.runOnce(request, undefined, record),
			cancel: (laneId, reasonCode) => this.cancelScheduledWorker(laneId, reasonCode),
			warn: (message) => this.safeWarn(message),
		});
		this.recovery = new WorkerRecoveryCoordinator({
			lifecycle: this.lifecycle,
			scheduler: this.scheduler,
			recoverWriteReservations: () => this.writeReservations.recoverProvenStale(),
			publishTerminalRecord: (record) => this.publishTerminalRecord(record),
			publishTerminalRecords: (records) => this.publishRecoveredTerminalRecords(records),
			dispatchVerification: (recovery) => this.dispatchRecoveredVerification(recovery),
			recoverTaskBearingMailboxTurns: () => this.agentControl.reconcileTaskBearingMailboxTurns(),
			recoverSessionRootReplies: () => this.agentControl.reconcileSessionRootReplies(),
			retryReady: () => {
				if (this.deps.isDisposed()) return;
				this.scheduler.drain();
				this.terminalHandoffs.signal();
				this.notifications.statusChanged();
			},
			warn: (message) => this.safeWarn(message),
		});
		this.agentControl = new WorkerAgentControlCoordinator({
			agentDir: this.deps.getAgentDir(),
			parentSessionId: this.deps.getSessionId(),
			processOwnerId: createLocalWorkerProcessOwnerId(process.pid, randomUUID()),
			isControlAvailable: () => this.deps.isDelegateToolActive(),
			getLifecycle: () => this.getWorkerLifecycle(),
			recoveredRequest: (attempt) => this.recovery.recoveredRequest(attempt),
			run: (request, record) => this.runOnce(request, undefined, record),
			scheduler: this.scheduler,
			statusChanged: () => {
				this.terminalHandoffs.signal();
				this.notifications.statusChanged();
			},
			abortLane: (laneId, reasonCode) => this.laneAbortControllers.get(laneId)?.abort(reasonCode),
			cancelLane: (laneId, reasonCode) => {
				this.scheduler.dropQueued(laneId);
				this.writeReservations.release(laneId);
				const terminal = this.getWorkerLifecycle().cancel(laneId, reasonCode);
				if (terminal) this.publishTerminalRecord(terminal);
				if (terminal && !this.deps.isDisposed()) this.scheduler.drain();
				return terminal;
			},
			taskStartHeadroomSkipReason: (agent) => {
				const contract = this.lifecycle.getLatestAgentAttempt(agent.agentId)?.dispatch.executionContract;
				return contract
					? this.workerProjectionHeadroomSkipReason(contract)
					: "orchestration_execution_contract_missing";
			},
			yieldCapacity: (callerAgentId, targetAgentId) => this.yieldWorkerCapacity(callerAgentId, targetAgentId),
			warn: (message) => this.safeWarn(message),
		});
		this.terminalHandoffs = new WorkerTerminalHandoffCoordinator({
			deliver: (handoff) => this.deliverTerminalHandoff(handoff),
			onDeliveryError: (handoff, error) => {
				this.safeWarn(
					`Worker terminal handoff for ${handoff.record.laneId} failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			},
		});
		this.agentControl.reconcileSessionRootReplies();
		this.writeReservations = new WorkerWriteReservationCoordinator({
			agentDir: this.deps.getAgentDir(),
			getCwd: () => this.deps.getCwd(),
			getParentSessionId: () => this.deps.getSessionId(),
			ownerId: this.agentControl.getProcessOwnerId(),
			drainQueuedWorkers: () => {
				if (!this.deps.isDisposed()) this.scheduler.drain(true);
			},
			warn: (message) => this.safeWarn(message),
		});
	}

	private safeWarn(message: string): void {
		try {
			this.deps.emit({ type: "warning", message });
		} catch {
			// Disposal and recovery diagnostics must never throw.
		}
	}

	private cancelScheduledWorker(laneId: string, reasonCode: string): void {
		try {
			this.writeReservations.release(laneId);
		} catch (error) {
			this.safeWarn(
				`Failed to release worker ${laneId} before cancellation: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw error;
		}
		let terminal: LaneRecord | undefined;
		try {
			terminal = this.getWorkerLifecycle().cancel(laneId, reasonCode);
		} catch (error) {
			this.safeWarn(
				`Failed to cancel durable worker ${laneId}: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw error;
		}
		if (!terminal) return;
		try {
			this.publishTerminalRecord(terminal);
		} catch (error) {
			// The durable cancellation is authoritative. Publication remains recoverable from its
			// pending notification and must not make the scheduler requeue a terminal attempt.
			this.safeWarn(
				`Failed to publish canceled worker ${laneId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/** Narrow model-facing control port. It owns control state; this controller only composes it. */
	getAgentControl(): WorkerAgentControlPort {
		return this.agentControl;
	}

	/** The coordinator's process identity is also the durable execution lease owner. */
	getAgentControlProcessOwnerId(): string {
		return this.agentControl.getProcessOwnerId();
	}

	recordTerminal(record: LaneRecord): void {
		if (record.status === "queued" || record.status === "running") return;
		if (record.type === "worker") {
			const notification = this.lifecycle.getTerminalNotification(record.laneId);
			if (notification?.status === "delivered") return;
			if (notification) {
				this.notifications.recordTerminal(record, notification.notificationId);
				return;
			}
		}
		this.notifications.recordTerminal(record);
	}

	getRecords(): LaneRecord[] {
		if (this.deps.isDelegateToolActive?.()) this.recovery.recover();
		return this.lifecycle.getRecords();
	}

	/** Process-local worker records for the shared terminal notifier; never triggers durable recovery. */
	getLoadedRecords(): LaneRecord[] {
		return this.lifecycle.getRecords();
	}

	markNotificationsDelivered(notificationIds: readonly string[]): void {
		this.lifecycle.markNotificationsDelivered(notificationIds);
	}

	abort(): void {
		this.runTeardownStep("abort worker execution", () => this.workerAbort.abort());
		// Bound attempts have an authoritative transcript and agent identity. A normal owner-session
		// shutdown is an execution interruption, not an explicit worker cancellation: fence it into
		// suspended state before the abort continuation can observe the signal.
		const suspendedAttemptIds = new Set<string>();
		try {
			for (const attemptId of this.lifecycle.suspendBoundInProcessAttemptsForRestart(
				this.agentControl.getProcessOwnerId(),
			)) {
				suspendedAttemptIds.add(attemptId);
			}
		} catch (error) {
			this.safeWarn(
				`Failed to persist worker restart suspension during teardown: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		let records: LaneRecord[] = [];
		try {
			records = this.lifecycle.getRecords();
		} catch (error) {
			this.safeWarn(
				`Failed to inspect durable worker records during teardown: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		for (const record of records) {
			if (record.status !== "queued" && record.status !== "running") continue;
			const ledger = this.inFlightLedgers.get(record.laneId);
			if (ledger && suspendedAttemptIds.has(ledger.handle.attemptId)) {
				this.inFlightLedgers.delete(record.laneId);
				continue;
			}
			if (!ledger) {
				try {
					const canceled = this.lifecycle.cancel(record.laneId, "session_disposed");
					if (canceled) {
						this.publishTerminalRecord(canceled);
					}
				} catch (error) {
					this.safeWarn(
						`Failed to cancel durable queued worker ${record.laneId}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				continue;
			}
			this.inFlightLedgers.delete(record.laneId);
			try {
				const usage = ledger.getUsage();
				const reportedUsage = providerUsageFromAttemptUsage(usage);
				const reportId = `worker:${this.deps.getSessionId()}:${record.laneId}`;
				const claim: WorkerClaim = {
					requestId: ledger.request.id,
					status: "cancelled",
					summary: "canceled on session dispose",
					changedFiles: [...ledger.changedFiles],
					usageReportId: reportId,
					createdAt: new Date().toISOString(),
				};
				const canceled = finalizeWorkerClaim(this.getWorkerLifecycle(), {
					handle: ledger.handle,
					claim,
					accepted: false,
					costUsd: usage.costUsd,
					cwd: this.deps.getCwd(),
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					totalTokens: reportedUsage.totalTokens,
					wallClockMs: usage.activeWallClockMs,
					toolCalls: usage.toolCalls,
					reasonCode: "session_disposed",
				}).record;
				this.publishTerminalRecord(canceled);
				// The terminal result and owner usage report share the same fenced cumulative snapshot.
				this.deps.saveWorkerClaimSnapshot(claim, ledger.request);
				if (reportedUsage.cost.total > 0 || reportedUsage.totalTokens > 0) {
					this.deps.addSpawnedUsage(reportedUsage, { label: "worker-delegation", reportId });
				}
			} catch (error) {
				this.safeWarn(
					`Failed to persist canceled worker claim ${record.laneId}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		this.inFlightLedgers.clear();

		this.runTeardownStep("cancel queued worker dispatches", () => this.scheduler.cancelQueued());
		this.runTeardownStep("dispose worker recovery", () => this.recovery.dispose());
		this.runTeardownStep("dispose worker terminal handoffs", () => this.terminalHandoffs.dispose());
		this.runTeardownStep("dispose worker write reservations", () => this.writeReservations.dispose());
		for (const shellSessionKey of this.shellSessionKeys) {
			this.runTeardownStep(`dispose worker shell ${shellSessionKey}`, () =>
				disposePersistentShellSession(shellSessionKey),
			);
		}
		this.shellSessionKeys.clear();
	}

	private runTeardownStep(label: string, step: () => void): void {
		try {
			step();
		} catch (error) {
			this.safeWarn(`Failed to ${label}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private getWorkerLifecycle(): WorkerLifecycle {
		return this.lifecycle;
	}

	private getWorkerProfileResolver(): WorkerProfileResolver {
		if (this.profileResolver) return this.profileResolver;
		this.profileResolver = new WorkerProfileResolver({
			agentDir: this.deps.getAgentDir(),
			cwd: this.deps.getCwd(),
			getSettingsManager: () => this.deps.getSettingsManager(),
			getResourceLoader: () => this.deps.getResourceLoader(),
			getModelRegistry: () => this.deps.getModelRegistry(),
			isModelExhausted: (model) => this.deps.isModelExhausted(model),
			getTaskProfileStore: () => this.getTaskProfileStore(),
			onDiagnostic: (message) => this.safeWarn(message),
		});
		return this.profileResolver;
	}

	private getTaskProfileStore(): SessionTaskProfileStore {
		this.taskProfileStore ??= new SessionTaskProfileStore(this.deps.getSessionManager());
		return this.taskProfileStore;
	}

	private getTaskProfileWriter(): TaskProfileWriter {
		this.taskProfileWriter ??= new TaskProfileWriter({
			agentDir: this.deps.getAgentDir(),
			cwd: this.deps.getCwd(),
			store: this.getTaskProfileStore(),
			getSettingsManager: () => this.deps.getSettingsManager(),
			getModelRegistry: () => this.deps.getModelRegistry(),
			isModelExhausted: (provider, modelId) => {
				const model = this.deps.getModelRegistry().find(provider, modelId);
				return !model || this.deps.isModelExhausted(model);
			},
			getActiveOrchestrationProfile: () => this.deps.getActiveOrchestrationProfile?.(),
		});
		return this.taskProfileWriter;
	}

	/** Read-only durable worker projection. Undefined means the delegate capability never loaded. */
	getTaskRuntimeSnapshot(): TaskRuntimeProjection | undefined {
		return this.lifecycle.getTaskRuntimeSnapshot();
	}

	/** Reconcile the session goal into an already-loaded worker runtime without defeating lazy UAC. */
	synchronizeGoalState(goal: GoalState): void {
		this.publishGoalTerminalRecords(this.lifecycle.synchronizeGoalState(goal));
		if (goal.status === "active" && !this.deps.isDisposed()) this.scheduler.drain();
	}

	private publishGoalTerminalRecords(records: readonly LaneRecord[]): void {
		for (const record of records) {
			this.scheduler.dropQueued(record.laneId);
			this.laneAbortControllers.get(record.laneId)?.abort("goal_terminal");
			this.publishTerminalRecord(record);
		}
		if (records.length > 0 && !this.deps.isDisposed()) this.scheduler.drain();
	}

	private dispatchRecoveredVerification(
		recovery: Extract<PendingVerificationRecovery, { action: "dispatch" }>,
	): WorkerRecoveryDispatchResult {
		const legacyImplementation = recovery.verifierExecutionContract
			? undefined
			: this.resolveWorkerAdmission({
					instructions: recovery.summary,
					profileId: recovery.implementationProfileId,
				});
		const verifierProfileId =
			recovery.verifierExecutionContract?.worker.profile.profileId ??
			(legacyImplementation?.ok ? legacyImplementation.verifierShipment?.profile.profileId : undefined);
		return verifierProfileId
			? this.startInternal(
					this.buildVerifierRequest({
						subjectTaskId: recovery.subjectTaskId,
						verifierProfileId,
						summary: recovery.summary,
						artifactUris: recovery.artifactUris,
					}),
					recovery.verifierExecutionContract,
				)
			: { started: false, skipReason: "independent_verifier_unavailable" };
	}

	private laneCapabilityProfile(model: Model<Api>): ModelCapabilityProfile {
		return deriveModelCapabilityProfile({
			contextWindow: model.contextWindow,
			mode: this.deps.getSettingsManager().getModelCapabilitySettings().mode,
		});
	}

	getProfileCatalog(): Array<{ profileId: string; role: string; description: string }> {
		return this.getWorkerProfileResolver().catalog();
	}

	inspectTaskProfileOptions(): TaskProfileInspection {
		return this.getTaskProfileWriter().inspectTaskProfileOptions();
	}

	createTaskProfile(input: TaskProfileCreateInput): TaskProfileCreateResult {
		return this.getTaskProfileWriter().createTaskProfile(input);
	}

	private resolveWorkerShipment(
		request: WorkerDelegationRequest,
		settings: ResolvedWorkerDelegationSettings,
	): { ok: true; shipment: ResolvedWorkerProfile } | { ok: false; skipReason: string } {
		const resolved = this.getWorkerProfileResolver().resolve(request, settings.orchestrationProfile);
		return resolved.ok ? { ok: true, shipment: resolved.resolved } : { ok: false, skipReason: resolved.reason };
	}

	private resolveRequiredVerifier(
		profile: OrchestrationProfile,
	): { ok: true; shipment?: ResolvedWorkerProfile } | { ok: false; skipReason: string } {
		if (!profile.requireIndependentVerification) return { ok: true };
		const resolved = this.getWorkerProfileResolver().resolveVerifier(profile);
		if (!resolved.ok) return { ok: false, skipReason: `independent_verifier_unavailable:${resolved.reason}` };
		// Fresh verifier profiles pass through the same shipment admission owner as fresh workers.
		// Recovery-pinned verifier contracts bypass this path and preserve their immutable grant.
		const admitted = resolveWorkerAuthority({
			base: resolved.resolved,
			modelRegistry: this.deps.getModelRegistry(),
			isModelExhausted: (model) => this.deps.isModelExhausted(model),
		});
		return admitted.ok
			? { ok: true, shipment: admitted.shipment }
			: { ok: false, skipReason: `independent_verifier_unavailable:${admitted.reason}` };
	}

	/**
	 * A descendant may select a different routing profile, but that preset cannot introduce context
	 * its ancestor never admitted. Pointer ids alone are insufficient authority: retain only pointers
	 * whose complete immutable metadata matches the ancestral contract, and require exact soul text.
	 */
	private narrowWorkerShipmentContext(
		shipment: ResolvedWorkerProfile,
		boundary: WorkerExecutionContract["worker"],
	): { ok: true; shipment: ResolvedWorkerProfile } | { ok: false; skipReason: string } {
		const boundaryPointers = new Map(boundary.resourcePointers.map((pointer) => [pointer.id, pointer]));
		const resourcePointers: ResourcePointer[] = [];
		for (const pointer of shipment.resourcePointers) {
			const inherited = boundaryPointers.get(pointer.id);
			if (!inherited || !isDeepStrictEqual(inherited, pointer)) {
				return { ok: false, skipReason: "orchestration_context_authority_exceeded" };
			}
			resourcePointers.push(structuredClone(inherited));
		}
		if (shipment.soul !== undefined && shipment.soul !== boundary.soul) {
			return { ok: false, skipReason: "orchestration_context_authority_exceeded" };
		}
		return {
			ok: true,
			shipment: {
				...shipment,
				resourcePointers,
				...(shipment.soul ? { soul: shipment.soul } : {}),
			},
		};
	}

	private hasExactRecursiveCycle(parentAgentId: string, instructions: string, profileId: string): boolean {
		const normalizedInstructions = instructions.trim();
		const visited = new Set<string>();
		let current = this.lifecycle.getAgent(parentAgentId);
		while (current) {
			if (visited.has(current.agentId)) return true;
			visited.add(current.agentId);
			const attempt = this.lifecycle.getLatestAgentAttempt(current.agentId);
			if (
				attempt?.dispatch.instructions.trim() === normalizedInstructions &&
				attempt.dispatch.profileId === profileId
			) {
				return true;
			}
			current = current.parentAgentId ? this.lifecycle.getAgent(current.parentAgentId) : undefined;
		}
		return false;
	}

	/** Reject a new logical identity before creating its task, transcript, agent, or queue entry. */
	private newWorkerFleetSkipReason(request: WorkerDelegationRequest, requiredAgentSlots = 1): string | undefined {
		const decision = evaluateNewWorkerAdmission(
			this.lifecycle.getTaskRuntimeSnapshot().agents,
			request.parentAgentId,
			DEFAULT_WORKER_FLEET_LIMITS,
			requiredAgentSlots,
		);
		return decision.ok ? undefined : decision.reasonCode;
	}

	private requiredAgentSlotsForAdmission(
		request: WorkerDelegationRequest,
		admission: Extract<WorkerAdmission, { ok: true }>,
	): number {
		const pendingVerifierSubjects = pendingVerifierSubjectTaskIds(this.lifecycle.getTaskRuntimeSnapshot());
		if (request.verificationOfTaskId) pendingVerifierSubjects.delete(request.verificationOfTaskId);
		return 1 + pendingVerifierSubjects.size + (admission.verifierShipment ? 1 : 0);
	}

	/** Single admission contract shared by enqueue, scheduler revalidation, and execution. */
	private resolveWorkerAdmission(
		request: WorkerDelegationRequest,
		pinnedContract?: WorkerExecutionContract,
	): WorkerAdmission {
		if (this.deps.isDisposed()) return { ok: false, skipReason: "session_disposed" };
		const instructions = request.instructions.trim();
		if (!instructions) return { ok: false, skipReason: "missing_instructions" };
		if (!this.deps.isDelegateToolActive()) return { ok: false, skipReason: "delegate_tool_inactive" };
		const settings = this.deps.getSettingsManager().getWorkerDelegationSettings();
		if (!settings.enabled) return { ok: false, skipReason: "worker_delegation_disabled" };
		const parentAgent = request.parentAgentId ? this.lifecycle.getAgent(request.parentAgentId) : undefined;
		if (request.parentAgentId && !parentAgent) {
			return { ok: false, skipReason: "orchestration_parent_agent_unknown" };
		}
		const parentAttempt = parentAgent ? this.lifecycle.getLatestAgentAttempt(parentAgent.agentId) : undefined;
		const parentContract = parentAttempt?.dispatch.executionContract;
		if (parentAgent && !parentContract) {
			return { ok: false, skipReason: "orchestration_parent_authority_missing" };
		}
		if (pinnedContract && request.profileId && request.profileId !== pinnedContract.worker.profile.profileId) {
			return { ok: false, skipReason: "orchestration_execution_contract_mismatch" };
		}
		let authority = request.authority;
		if (!pinnedContract && authority) {
			try {
				authority = parseWorkerDelegationAuthorityRequest(authority);
			} catch (error) {
				return {
					ok: false,
					skipReason: `orchestration_authority_invalid:${error instanceof Error ? error.message : String(error)}`,
				};
			}
		}
		let baseShipment: ResolvedWorkerProfile | undefined;
		if (pinnedContract) {
			const pinned = this.getWorkerProfileResolver().resolveContract(pinnedContract.worker);
			if (!pinned.ok) return { ok: false, skipReason: pinned.reason };
			baseShipment = pinned.resolved;
		} else if (!request.profileId && parentContract) {
			const inherited = this.getWorkerProfileResolver().resolveContract(parentContract.worker);
			if (!inherited.ok) return { ok: false, skipReason: inherited.reason };
			baseShipment = inherited.resolved;
		} else if (request.profileId || settings.orchestrationProfile) {
			const configured = this.resolveWorkerShipment(request, settings);
			if (!configured.ok) return configured;
			baseShipment = configured.shipment;
		}
		const adaptive = pinnedContract
			? { ok: true as const, shipment: baseShipment! }
			: resolveWorkerAuthority({
					authority,
					...(baseShipment ? { base: baseShipment } : {}),
					...(this.deps.getModel() ? { foregroundModel: this.deps.getModel() } : {}),
					modelRegistry: this.deps.getModelRegistry(),
					isModelExhausted: (model) => this.deps.isModelExhausted(model),
				});
		if (!adaptive.ok) return { ok: false, skipReason: adaptive.reason };
		let shipment = adaptive.shipment;
		if (parentContract) {
			const narrowed = this.narrowWorkerShipmentContext(shipment, parentContract.worker);
			if (!narrowed.ok) return narrowed;
			shipment = narrowed.shipment;
		}
		if (parentAgent && this.hasExactRecursiveCycle(parentAgent.agentId, instructions, shipment.profile.profileId)) {
			return { ok: false, skipReason: "recursive_delegation_cycle" };
		}
		if (request.verificationOfTaskId && shipment.profile.role !== "verifier") {
			return { ok: false, skipReason: "verification_profile_role_mismatch" };
		}
		if (!request.verificationOfTaskId && shipment.profile.role === "verifier") {
			return { ok: false, skipReason: "verifier_profile_requires_runtime_dispatch" };
		}
		let verifierShipment: ResolvedWorkerProfile | undefined;
		if (pinnedContract?.verifier) {
			const verifier = this.getWorkerProfileResolver().resolveContract(pinnedContract.verifier);
			if (!verifier.ok) {
				return { ok: false, skipReason: `independent_verifier_unavailable:${verifier.reason}` };
			}
			verifierShipment = verifier.resolved;
		} else {
			const verifier = this.resolveRequiredVerifier(shipment.profile);
			if (!verifier.ok) return verifier;
			verifierShipment = verifier.shipment;
		}
		if (verifierShipment && parentContract) {
			const verifierBoundary = parentContract.verifier ?? parentContract.worker;
			const narrowed = this.narrowWorkerShipmentContext(verifierShipment, verifierBoundary);
			if (!narrowed.ok) return narrowed;
			verifierShipment = narrowed.shipment;
		}
		if (!this.laneCapabilityProfile(shipment.model).backgroundLanesEnabled) {
			return { ok: false, skipReason: "model_delegation_unsupported" };
		}
		// The model-facing delegate surface cannot name profile resources. An absent or empty
		// runtime selection therefore means "use the owner-admitted profile set", not "drop it".
		// Non-empty task metadata is an exact narrowing and remains fail-closed for unknown or
		// duplicate ids before any durable task or provider request is created.
		const requestedResourcePointerIds = request.taskContext?.resourcePointerIds ?? [];
		const selectedResources = selectWorkerResourcePointers(
			shipment.resourcePointers,
			requestedResourcePointerIds.length > 0
				? requestedResourcePointerIds
				: shipment.resourcePointers.map((pointer) => pointer.id),
		);
		if (!selectedResources.ok) return { ok: false, skipReason: selectedResources.reason };
		const currentExecutionPlan = this.buildWorkerExecutionPlan(
			shipment.profile,
			settings,
			adaptive.requestedReadPaths,
			adaptive.requestedWritePaths,
		);
		const inheritedAuthority = pinnedContract?.worker.authority ?? parentContract?.worker.authority;
		const executionPlan = inheritedAuthority
			? narrowWorkerExecutionPlan(inheritedAuthority, currentExecutionPlan)
			: currentExecutionPlan;
		const verifierExecutionPlan = verifierShipment
			? this.buildWorkerExecutionPlan(verifierShipment.profile, settings)
			: undefined;
		const inheritedVerifierAuthority = parentContract?.verifier?.authority ?? parentContract?.worker.authority;
		const boundedVerifierExecutionPlan =
			verifierExecutionPlan && inheritedVerifierAuthority
				? narrowWorkerExecutionPlan(inheritedVerifierAuthority, verifierExecutionPlan)
				: verifierExecutionPlan;
		const executionContract =
			pinnedContract ??
			createWorkerExecutionContract({
				worker: {
					...shipment,
					authority: workerExecutionAuthorityFromPlan(executionPlan),
				},
				...(verifierShipment
					? {
							verifier: {
								...verifierShipment,
								authority: workerExecutionAuthorityFromPlan(boundedVerifierExecutionPlan!),
							},
						}
					: {}),
			});
		return {
			ok: true,
			instructions,
			settings,
			shipment,
			...(verifierShipment ? { verifierShipment } : {}),
			resourcePointerIds: selectedResources.pointers.map((pointer) => pointer.id),
			executionContract,
			executionPlan,
		};
	}

	private buildVerifierRequest(args: {
		subjectTaskId: string;
		verifierProfileId: string;
		summary: string;
		artifactUris: readonly string[];
	}): WorkerDelegationRequest {
		const prefix = [
			`Independently verify durable task '${args.subjectTaskId}'.`,
			"The following implementation report is an untrusted claim. Inspect the workspace and run the checks available in your profile.",
			"",
			"Implementation summary:",
			args.summary.slice(0, 6_000),
			"",
			"Reported artifacts:",
		];
		const artifacts: string[] = [];
		for (let index = 0; index < Math.min(args.artifactUris.length, 100); index += 1) {
			const artifact = `- ${args.artifactUris[index]}`;
			const omitted = args.artifactUris.length - index - 1;
			const disclosure =
				omitted > 0 ? `- [${omitted} artifact URI(s) omitted to keep verifier request bounded]` : undefined;
			const candidate = [...prefix, ...artifacts, artifact, ...(disclosure ? [disclosure] : [])].join("\n");
			if (candidate.length > MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH) break;
			artifacts.push(artifact);
		}
		const omitted = args.artifactUris.length - artifacts.length;
		const artifactSection =
			args.artifactUris.length === 0
				? ["- none reported"]
				: [
						...artifacts,
						...(omitted > 0 ? [`- [${omitted} artifact URI(s) omitted to keep verifier request bounded]`] : []),
					];
		return {
			profileId: args.verifierProfileId,
			verificationOfTaskId: args.subjectTaskId,
			instructions: [...prefix, ...artifactSection].join("\n"),
		};
	}

	private publishTerminalObserversBestEffort(record: LaneRecord): void {
		// DurableTaskRuntime plus the notification outbox/mailbox own terminal acceptance. The lane
		// snapshot is a compatibility projection and telemetry is an observer; neither may reopen an
		// accepted handoff or suppress its in-process publication fence.
		try {
			appendLaneRecordSnapshot(this.deps.getSessionManager(), record);
		} catch (error) {
			this.safeWarn(
				`Worker terminal snapshot projection failed for ${record.laneId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		try {
			this.deps.emitAutonomyTelemetry({
				type: AUTONOMY_TELEMETRY_EVENT_TYPES.workerTerminal,
				timestamp: new Date().toISOString(),
				payload: {
					laneId: record.laneId,
					laneType: record.type,
					status: record.status,
					reasonCode: record.reasonCode ?? null,
					costUsd: record.costUsd ?? null,
				},
			});
		} catch (error) {
			this.safeWarn(
				`Worker terminal telemetry observer failed for ${record.laneId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private deliverTerminalHandoff(handoff: Readonly<WorkerTerminalHandoff>): WorkerTerminalHandoffDelivery {
		const delivery = this.agentControl.deliverWorkerTerminalHandoff(handoff);
		if (!delivery.accepted) {
			this.safeWarn(
				`Worker terminal handoff for ${handoff.record.laneId} was not accepted${delivery.skipReason ? `: ${delivery.skipReason}` : "."}`,
			);
			return "retained";
		}
		const notification = this.lifecycle.getTerminalNotification(handoff.record.laneId);
		if (notification?.status === "pending") {
			this.lifecycle.markNotificationsDelivered([notification.notificationId]);
		}
		this.publishedTerminalAttemptIds.add(handoff.terminalAttemptId);
		this.publishTerminalObserversBestEffort(handoff.record);
		try {
			this.notifications.statusChanged();
		} catch (error) {
			this.safeWarn(
				`Worker terminal status observer failed for ${handoff.record.laneId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		try {
			this.agentControl.signalStateChanged();
		} catch (error) {
			this.safeWarn(
				`Worker terminal state observer failed for ${handoff.record.laneId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return "delivered";
	}

	private publishRecoveredTerminalRecords(records: readonly LaneRecord[]): void {
		const handoffs: WorkerTerminalHandoff[] = [];
		const directRecords: LaneRecord[] = [];
		for (const record of records) {
			this.recovery.clearScheduledRetry(record.laneId);
			const attempt = this.lifecycle.getActiveAttempt(record.laneId);
			if (attempt && this.publishedTerminalAttemptIds.has(attempt.attemptId)) continue;
			const childAgentId = attempt?.agentId ?? attempt?.dispatch.logicalLaneId ?? record.laneId;
			const parentAgentId = this.lifecycle.getAgent(childAgentId)?.parentAgentId ?? attempt?.dispatch.parentAgentId;
			if (attempt && parentAgentId) {
				handoffs.push({
					terminalAttemptId: attempt.attemptId,
					parentAgentId,
					childAgentId,
					record,
				});
			} else {
				directRecords.push(record);
			}
		}
		if (handoffs.length > 0) {
			try {
				this.terminalHandoffs.rehydrate(handoffs);
			} catch (error) {
				this.safeWarn(
					`Worker terminal handoff recovery batch was retained durably but not adopted: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		for (const record of directRecords) this.publishTerminalRecord(record);
	}

	private publishTerminalRecord(record: LaneRecord): void {
		if (!isLaneTerminalStatus(record.status)) return;
		this.recovery.clearScheduledRetry(record.laneId);
		const attempt = this.lifecycle.getActiveAttempt(record.laneId);
		const attemptId = attempt?.attemptId;
		if (attemptId && this.publishedTerminalAttemptIds.has(attemptId)) return;
		const childAgentId = attempt?.agentId ?? attempt?.dispatch.logicalLaneId ?? record.laneId;
		const parentAgentId = this.lifecycle.getAgent(childAgentId)?.parentAgentId ?? attempt?.dispatch.parentAgentId;
		if (attemptId && parentAgentId) {
			try {
				this.terminalHandoffs.retain({
					parentAgentId,
					childAgentId,
					terminalAttemptId: attemptId,
					record,
				});
				this.terminalHandoffs.signal();
			} catch (error) {
				this.safeWarn(
					`Worker terminal handoff retention for ${record.laneId} failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return;
		}
		this.recordTerminal(record);
		if (attemptId) {
			this.publishedTerminalAttemptIds.add(attemptId);
		}
		this.publishTerminalObserversBestEffort(record);
		this.agentControl.signalStateChanged();
	}

	/**
	 * A pre-execution denial still owns a prepared durable lane. Publish its terminal projection at
	 * this boundary: immediate callers have no scheduler promise to observe and must not wait for a
	 * future recovery read to receive the handoff. Repeated late cancellation paths are inert via
	 * the attempt-id publication fence above.
	 */
	private cancelAndPublish(lifecycle: WorkerLifecycle, laneId: string, reasonCode: string): LaneRecord | undefined {
		const record = lifecycle.cancel(laneId, reasonCode);
		if (record) this.publishTerminalRecord(record);
		if (record && !this.deps.isDisposed()) this.scheduler.drain();
		return record;
	}

	private hasWorkerCapacity(settings: ResolvedWorkerDelegationSettings): boolean {
		const snapshot = this.getWorkerLifecycle().getTaskRuntimeSnapshot();
		let yielded = 0;
		for (const attemptId of this.yieldedCapacityAttemptIds.keys()) {
			const status = snapshot.attempts[attemptId]?.status;
			if (status === "leased" || status === "running") yielded += 1;
			else this.yieldedCapacityAttemptIds.delete(attemptId);
		}
		return Math.max(0, this.getWorkerLifecycle().getRunningCount() - yielded) < settings.maxConcurrent;
	}

	private yieldWorkerCapacity(callerAgentId: string, targetAgentId: string): () => void {
		const caller = this.lifecycle.getAgent(callerAgentId);
		const target = this.lifecycle.getAgent(targetAgentId);
		if (!caller || !target || caller.rootAgentId !== target.rootAgentId) return () => undefined;
		const attempt = this.lifecycle.getLatestAgentAttempt(caller.agentId);
		if (!attempt || (attempt.status !== "leased" && attempt.status !== "running")) return () => undefined;
		this.yieldedCapacityAttemptIds.set(
			attempt.attemptId,
			(this.yieldedCapacityAttemptIds.get(attempt.attemptId) ?? 0) + 1,
		);
		this.scheduler.drain();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const leases = this.yieldedCapacityAttemptIds.get(attempt.attemptId);
			if (leases === undefined) return;
			if (leases > 1) {
				this.yieldedCapacityAttemptIds.set(attempt.attemptId, leases - 1);
				return;
			}
			this.yieldedCapacityAttemptIds.delete(attempt.attemptId);
			if (!this.deps.isDisposed()) this.scheduler.drain();
		};
	}

	private workerDispatchAdmission(request: WorkerDelegationRequest, record: LaneRecord): WorkerDispatchAdmission {
		if (this.recovery.deferRetryIfNeeded(record, request)) return { action: "wait" };
		const lifecycle = this.getWorkerLifecycle();
		const attempt = lifecycle.getActiveAttempt(record.laneId);
		if (!attempt) return { action: "cancel", reasonCode: "orchestration_attempt_missing" };
		if (attempt.status === "queued" || attempt.status === "suspended") {
			const readiness = lifecycle.getAttemptDispatchReadiness(attempt.attemptId);
			if (readiness.state === "waiting") {
				return {
					action: "wait",
					reason: readiness.reasonCode === "objective_paused" ? "objective" : "dependencies",
				};
			}
			if (readiness.state === "blocked") return { action: "cancel", reasonCode: readiness.reasonCode };
		}
		const contract = attempt.dispatch.executionContract;
		const admission = this.resolveWorkerAdmission(request, contract);
		if (!admission.ok) return { action: "cancel", reasonCode: admission.skipReason };
		if (!this.hasWorkerCapacity(admission.settings)) return { action: "wait", reason: "capacity" };
		const reservation = this.writeReservations.acquire(record.laneId, attempt, admission.executionPlan);
		if (reservation.kind === "denied") return { action: "cancel", reasonCode: reservation.reasonCode };
		return reservation.kind === "granted" ? { action: "start" } : { action: "wait", reason: "write_reservation" };
	}

	private workerProjectionHeadroomSkipReason(
		contract: WorkerExecutionContract,
		verificationOfTaskId?: string,
	): string | undefined {
		const pendingVerifierSubjects = pendingVerifierSubjectTaskIds(this.lifecycle.getTaskRuntimeSnapshot());
		if (verificationOfTaskId) pendingVerifierSubjects.delete(verificationOfTaskId);
		const slots = 1 + pendingVerifierSubjects.size + (contract.verifier ? 1 : 0);
		try {
			this.lifecycle.ledger.runtime.assertProjectionHeadroom({ tasks: slots, attempts: slots });
			return undefined;
		} catch {
			return "orchestration_projection_capacity_exhausted";
		}
	}

	private workerQueueReservationSkipReason(
		request: WorkerDelegationRequest,
		requestQueueSlots: 0 | 1,
		unpersistedVerifierSlots: 0 | 1,
	): string | undefined {
		const pendingVerifierSubjects = pendingVerifierSubjectTaskIds(this.lifecycle.getTaskRuntimeSnapshot());
		if (request.verificationOfTaskId) pendingVerifierSubjects.delete(request.verificationOfTaskId);
		const remainingQueueSlots = DEFAULT_WORKER_FLEET_LIMITS.maxQueuedDispatches - this.scheduler.queuedCount;
		return requestQueueSlots + pendingVerifierSubjects.size + unpersistedVerifierSlots > remainingQueueSlots
			? "worker_dispatch_queue_full"
			: undefined;
	}

	private workerContextParentModel(request: WorkerDelegationRequest): { provider: string; model: string } {
		if (request.parentAgentId) {
			const parent = this.lifecycle.getAgent(request.parentAgentId);
			if (!parent) throw new Error("Worker parent logical agent is missing.");
			return workerContextModelIdentity(parent.resumeContext.modelRef);
		}
		const parent = this.deps.getModel();
		if (!parent) throw new Error("Foreground parent model is missing.");
		return { provider: parent.provider, model: parent.id };
	}

	private workerContextForkSource(request: WorkerDelegationRequest): WorkerContextForkSource {
		const model = this.workerContextParentModel(request);
		if (!request.parentAgentId) {
			return { model, messages: this.deps.getSessionManager().buildSessionContext().messages };
		}
		const parent = this.lifecycle.getAgent(request.parentAgentId);
		if (!parent) throw new Error("Worker parent logical agent is missing.");
		const conversation = this.conversations.open({
			agentDir: this.deps.getAgentDir(),
			resumeContext: parent.resumeContext,
			expectedLogicalAgentId: parent.agentId,
		});
		return { model, messages: conversation.getProviderContext().messages };
	}

	private workerContextForkMode(
		request: WorkerDelegationRequest,
		contract: WorkerExecutionContract,
	): ReturnType<typeof resolveWorkerContextInheritanceMode> {
		if (request.verificationOfTaskId) return { kind: "none" };
		return resolveWorkerContextInheritanceMode({
			parent: this.workerContextParentModel(request),
			worker: {
				provider: contract.worker.modelBinding.provider,
				model: contract.worker.modelBinding.modelId,
			},
			...(request.forkTurns !== undefined ? { mode: request.forkTurns } : {}),
		});
	}

	private workerContextForkAdmissionSkipReason(
		request: WorkerDelegationRequest,
		contract: WorkerExecutionContract,
	): string | undefined {
		try {
			this.workerContextForkMode(request, contract);
			return undefined;
		} catch {
			return "worker_context_inheritance_denied";
		}
	}

	/** One admission owner for every newly generated logical worker identity. */
	private admitNewWorkerRequest(
		request: WorkerDelegationRequest,
		pinnedContract?: WorkerExecutionContract,
	): WorkerAdmission {
		const fleetSkipReason = this.newWorkerFleetSkipReason(request);
		if (fleetSkipReason) return { ok: false, skipReason: fleetSkipReason };
		const admission = this.resolveWorkerAdmission(request, pinnedContract);
		if (!admission.ok) return admission;
		const contextForkSkipReason = this.workerContextForkAdmissionSkipReason(request, admission.executionContract);
		if (contextForkSkipReason) return { ok: false, skipReason: contextForkSkipReason };
		if (!request.verificationOfTaskId) this.recovery.recover();
		const headroomSkipReason = this.newWorkerFleetSkipReason(
			request,
			this.requiredAgentSlotsForAdmission(request, admission),
		);
		if (headroomSkipReason) return { ok: false, skipReason: headroomSkipReason };
		const projectionHeadroomSkipReason = this.workerProjectionHeadroomSkipReason(
			admission.executionContract,
			request.verificationOfTaskId,
		);
		if (projectionHeadroomSkipReason) return { ok: false, skipReason: projectionHeadroomSkipReason };
		const queueReservationSkipReason = this.workerQueueReservationSkipReason(
			request,
			0,
			admission.verifierShipment ? 1 : 0,
		);
		return queueReservationSkipReason ? { ok: false, skipReason: queueReservationSkipReason } : admission;
	}

	private durableWorkerContextForkReferences(): WorkerContextForkReference[] {
		const references: WorkerContextForkReference[] = [];
		for (const attempt of Object.values(this.lifecycle.getTaskRuntimeSnapshot().attempts)) {
			if (attempt.dispatch.birthContextForkReference) {
				references.push(attempt.dispatch.birthContextForkReference);
			}
		}
		return references;
	}

	private buildWorkerExecutionPlan(
		profile: OrchestrationProfile,
		settings: ResolvedWorkerDelegationSettings,
		requestedReadPaths?: readonly string[],
		requestedWritePaths?: readonly string[],
	): WorkerExecutionPlan {
		return buildWorkerExecutionPlan({
			profile,
			settings,
			cwd: this.deps.getCwd(),
			deniedPaths: getPrivateLaneDeniedPaths(this.deps.getCwd(), this.deps.getAgentDir()),
			foregroundMaxCostUsd: this.deps.getCapabilityEnvelope()?.maxEstimatedUsd,
			memoryEnabled: this.deps.getSettingsManager().getMemoryRetrievalSettings().enabled,
			...(requestedReadPaths ? { requestedReadPaths } : {}),
			...(requestedWritePaths ? { requestedWritePaths } : {}),
		});
	}

	/** One durable preparation path for queued, immediate, and recovered execution. */
	private prepareWorkerAttempt(
		request: WorkerDelegationRequest,
		admission: Extract<WorkerAdmission, { ok: true }>,
		existingRecord?: LaneRecord,
	): PreparedWorkerAttempt {
		const lifecycle = this.getWorkerLifecycle();
		if (existingRecord) {
			return {
				executionPlan: admission.executionPlan,
				lifecycle,
				record: existingRecord,
				attempt: lifecycle.getActiveAttempt(existingRecord.laneId),
			};
		}
		const goal = this.deps.getGoalStateSnapshot();
		const mode = this.workerContextForkMode(request, admission.executionContract);
		const messages =
			mode.kind === "none" ? [] : selectSanitizedContextFork(this.workerContextForkSource(request).messages, mode);
		for (let allocation = 0; allocation < DEFAULT_WORKER_FLEET_LIMITS.maxAgentsPerSession; allocation++) {
			const laneId = lifecycle.getNextAvailableLaneIdCandidate();
			let proposedReference: WorkerContextForkReference | undefined;
			try {
				const captured = this.contextForks.captureAndPrepare({
					logicalAgentId: laneId,
					messages,
					readDurableReferences: () => this.durableWorkerContextForkReferences(),
					isLogicalIdentityClaimed: () => {
						const snapshot = lifecycle.getTaskRuntimeSnapshot();
						return (
							snapshot.tasks[laneId]?.attemptIds.some(
								(attemptId) => snapshot.attempts[attemptId] !== undefined,
							) ?? false
						);
					},
					prepare: (birthContextForkReference) => {
						proposedReference = birthContextForkReference;
						return lifecycle.prepare(
							{
								instructions: admission.instructions,
								...(request.parentAgentId ? { parentAgentId: request.parentAgentId } : {}),
								birthContextForkReference,
								executionContract: admission.executionContract,
								requiredCapabilities: admission.executionPlan.requiredCapabilities,
								...(request.verificationOfTaskId ? { verificationOfTaskId: request.verificationOfTaskId } : {}),
								taskContext: {
									requirementIds: request.taskContext?.requirementIds ?? [],
									dependsOnTaskIds: request.taskContext?.dependsOnTaskIds ?? [],
									acceptanceCriterionIds: request.taskContext?.acceptanceCriterionIds ?? [],
									resourcePointerIds: admission.resourcePointerIds,
								},
								...(goal ? { goal } : {}),
							},
							laneId,
						);
					},
				});
				return { executionPlan: admission.executionPlan, lifecycle, ...captured.value };
			} catch (error) {
				if (error instanceof WorkerContextForkStoreError && error.code === "identity_claimed") continue;
				const snapshot = lifecycle.getTaskRuntimeSnapshot();
				const candidateTask = snapshot.tasks[laneId];
				const candidateAttempts = candidateTask?.attemptIds.map((attemptId) => snapshot.attempts[attemptId]) ?? [];
				const candidateOwnsDurableAttempt = candidateAttempts.some((attempt) => attempt !== undefined);
				const sameRequestReplay = candidateAttempts.some(
					(attempt) =>
						attempt !== undefined &&
						attempt.dispatch.instructions === admission.instructions &&
						attempt.dispatch.parentAgentId === request.parentAgentId &&
						isDeepStrictEqual(attempt.dispatch.executionContract, admission.executionContract) &&
						(proposedReference === undefined ||
							isDeepStrictEqual(attempt.dispatch.birthContextForkReference, proposedReference)),
				);
				const corruptSnapshot =
					error instanceof WorkerContextForkStoreError &&
					(error.code === "snapshot_corrupt" || error.code === "snapshot_missing");
				const generatedIdWasConcurrentlyClaimed =
					candidateOwnsDurableAttempt && !sameRequestReplay && !corruptSnapshot;
				if (!generatedIdWasConcurrentlyClaimed) throw error;
			}
		}
		throw new Error("Worker logical-agent allocation retries were exhausted.");
	}

	private enqueuePreparedWorkerAttempt(
		record: LaneRecord,
		request: WorkerDelegationRequest,
		profileId: string,
		priority: boolean,
	): string | undefined {
		try {
			this.scheduler.enqueue(record, { ...request, profileId }, false, priority);
			return undefined;
		} catch (error) {
			const reasonCode =
				error instanceof Error && error.message === "worker_dispatch_queue_full"
					? "worker_dispatch_queue_full"
					: "worker_dispatch_enqueue_error";
			this.cancelAndPublish(this.lifecycle, record.laneId, reasonCode);
			this.safeWarn(`Worker dispatch enqueue failed: ${error instanceof Error ? error.message : String(error)}`);
			return reasonCode;
		}
	}

	private queuePreparedWorkerAttempt(
		prepared: PreparedWorkerAttempt,
		request: WorkerDelegationRequest,
		admission: Extract<WorkerAdmission, { ok: true }>,
		options: {
			ensureAgent?: boolean;
			drain?: boolean;
			onStarted?: (record: LaneRecord) => void;
		} = {},
	): QueuedWorkerAttemptOutcome {
		if (
			this.workerQueueReservationSkipReason(request, 1, 0) ||
			!this.scheduler.hasQueueCapacity(request.verificationOfTaskId !== undefined)
		) {
			this.cancelAndPublish(prepared.lifecycle, prepared.record.laneId, "worker_dispatch_queue_full");
			return { started: false, skipReason: "worker_dispatch_queue_full" };
		}
		if (options.ensureAgent !== false) {
			try {
				this.ensurePreparedAgent(prepared, admission);
			} catch (error) {
				this.cancelAndPublish(prepared.lifecycle, prepared.record.laneId, "worker_conversation_unavailable");
				this.safeWarn(
					`Worker conversation setup failed: ${error instanceof Error ? error.message : String(error)}`,
				);
				return { started: false, skipReason: "worker_conversation_unavailable" };
			}
		}
		const priority = request.verificationOfTaskId !== undefined;
		const enqueueSkipReason = this.enqueuePreparedWorkerAttempt(
			prepared.record,
			request,
			admission.shipment.profile.profileId,
			priority,
		);
		if (enqueueSkipReason) return { started: false, skipReason: enqueueSkipReason };
		this.notifications.statusChanged();
		options.onStarted?.(prepared.record);
		if (options.drain) this.scheduler.drain();
		return { started: true, record: prepared.record };
	}

	private ensurePreparedAgent(
		prepared: PreparedWorkerAttempt,
		admission: Extract<WorkerAdmission, { ok: true }>,
	): PreparedWorkerAgent {
		if (!prepared.attempt) throw new Error("Prepared worker attempt is missing.");
		const immutableWorker = prepared.attempt.dispatch.executionContract?.worker;
		if (!immutableWorker) throw new Error("Prepared worker execution contract is missing.");
		const agentId = prepared.attempt.agentId ?? prepared.attempt.dispatch.logicalLaneId ?? prepared.record.laneId;
		const birthContextForkReference = prepared.attempt.dispatch.birthContextForkReference;
		const existing = prepared.lifecycle.getAgent(agentId);
		if (existing) {
			const conversation = this.conversations.open({
				agentDir: this.deps.getAgentDir(),
				resumeContext: existing.resumeContext,
				expectedLogicalAgentId: existing.agentId,
			});
			if (!isDeepStrictEqual(conversation.getBirthContextForkReference(), birthContextForkReference)) {
				throw new Error("Worker conversation birth context conflicts with its durable attempt.");
			}
			const materialized = materializeWorkerResourceBundle(existing.resumeContext.contextPointers);
			if (!materialized.ok) throw new Error(`worker_resource_materialization_${materialized.code}`);
			return {
				conversation,
				resources: materialized.pointers,
				resourceSystemPrompt: materialized.systemPrompt,
			};
		}
		const selected = selectWorkerResourcePointers(immutableWorker.resourcePointers, admission.resourcePointerIds);
		if (!selected.ok) throw new Error(selected.reason);
		const materialized = materializeWorkerResourceBundle(selected.pointers);
		if (!materialized.ok) throw new Error(`worker_resource_materialization_${materialized.code}`);
		const conversation = this.conversations.ensure({
			agentDir: this.deps.getAgentDir(),
			parentSessionId: this.deps.getSessionId(),
			logicalAgentId: agentId,
			cwd: this.deps.getCwd(),
			orchestrationProfileId: immutableWorker.profile.profileId,
			modelRef: `${immutableWorker.modelBinding.provider}/${immutableWorker.modelBinding.modelId}`,
			resourceProfileNames: immutableWorker.profile.resourceProfileNames,
			contextPointers: materialized.pointers,
			...(birthContextForkReference ? { birthContextForkReference } : {}),
		});
		prepared.lifecycle.ensureAgent({
			agentId,
			...(prepared.attempt.dispatch.parentAgentId ? { parentAgentId: prepared.attempt.dispatch.parentAgentId } : {}),
			role: immutableWorker.profile.role,
			resumeContext: conversation.getResumeContext(),
		});
		return {
			conversation,
			resources: materialized.pointers,
			resourceSystemPrompt: materialized.systemPrompt,
		};
	}

	start(
		request: WorkerDelegationRequest,
	): { started: false; skipReason: string } | { started: true; record: LaneRecord } {
		return this.startInternal(request);
	}

	private startInternal(
		request: WorkerDelegationRequest,
		pinnedContract?: WorkerExecutionContract,
	): { started: false; skipReason: string } | { started: true; record: LaneRecord } {
		const admission = this.admitNewWorkerRequest(request, pinnedContract);
		if (!admission.ok) return { started: false, skipReason: admission.skipReason };
		const { settings, shipment } = admission;

		const foreground = this.deps.getModel();
		const contendsWithLocalForeground =
			foreground !== undefined && isLocalExecutionModel(foreground) && isLocalExecutionModel(shipment.model);
		const dependencyGated = (request.taskContext?.dependsOnTaskIds.length ?? 0) > 0;
		if (dependencyGated || contendsWithLocalForeground || !this.hasWorkerCapacity(settings)) {
			// A mandatory verifier is the continuation of an already admitted implementation, not a
			// new owner request. Reserve its queue admission so a burst of ordinary work cannot strand
			// the subject behind `independent_verification_required` with no terminal handoff.
			const priority = request.verificationOfTaskId !== undefined;
			if (
				this.workerQueueReservationSkipReason(request, 1, admission.verifierShipment ? 1 : 0) ||
				!this.scheduler.hasQueueCapacity(priority)
			) {
				return { started: false, skipReason: "worker_dispatch_queue_full" };
			}
			let prepared: PreparedWorkerAttempt;
			try {
				prepared = this.prepareWorkerAttempt(request, admission);
			} catch (error) {
				this.safeWarn(
					`Worker dispatch was not persisted: ${error instanceof Error ? error.message : String(error)}`,
				);
				return { started: false, skipReason: "orchestration_ledger_error" };
			}
			return this.queuePreparedWorkerAttempt(prepared, request, admission, {
				drain: dependencyGated,
			});
		}
		let startedRecord: LaneRecord | undefined;
		const promise = this.runOnceWithAdmission(
			request,
			(record) => {
				startedRecord = record;
			},
			undefined,
			admission,
			true,
		);
		if (!startedRecord) {
			// Preparation is synchronous up to the first isolated completion await. A promise that
			// rejected before producing a lane is still observed below, so it cannot become unhandled.
			void promise.catch(() => undefined);
			return { started: false, skipReason: "worker_not_started" };
		}
		this.scheduler.track(startedRecord.laneId, promise);
		return { started: true, record: startedRecord };
	}

	async runOnce(
		request: WorkerDelegationRequest,
		onStarted?: (record: LaneRecord) => void,
		existingRecord?: LaneRecord,
	): Promise<WorkerDelegationRunOutcome> {
		return this.runOnceWithAdmission(request, onStarted, existingRecord);
	}

	private async runOnceWithAdmission(
		request: WorkerDelegationRequest,
		onStarted?: (record: LaneRecord) => void,
		existingRecord?: LaneRecord,
		preparedAdmission?: Extract<WorkerAdmission, { ok: true }>,
		newWorkerAdmissionChecked = false,
	): Promise<WorkerDelegationRunOutcome> {
		const pinnedContract = existingRecord
			? this.getWorkerLifecycle().getActiveAttempt(existingRecord.laneId)?.dispatch.executionContract
			: undefined;
		const admission = existingRecord
			? this.resolveWorkerAdmission(request, pinnedContract)
			: preparedAdmission && newWorkerAdmissionChecked
				? preparedAdmission
				: this.admitNewWorkerRequest(request, pinnedContract);
		if (!admission.ok) return { started: false, skipReason: admission.skipReason };
		if (existingRecord && !request.verificationOfTaskId) this.recovery.recover();
		const { instructions, settings, verifierShipment } = admission;
		const { model, modelBinding, profile: orchestrationProfile, soul } = admission.shipment;
		if (!this.hasWorkerCapacity(settings)) {
			return { started: false, skipReason: "worker_delegation_already_running" };
		}
		const laneCapability = this.laneCapabilityProfile(model);
		const retentionPolicy = workerConversationRetentionPolicy(model, this.deps.getSettingsManager());
		const prepared = this.prepareWorkerAttempt(request, admission, existingRecord);
		const { executionPlan, lifecycle } = prepared;
		if (!prepared.attempt) return { started: false, skipReason: "orchestration_attempt_missing" };
		if (prepared.attempt.status === "queued") {
			const readiness = lifecycle.getAttemptDispatchReadiness(prepared.attempt.attemptId);
			if (readiness.state === "blocked") {
				this.cancelAndPublish(lifecycle, prepared.record.laneId, readiness.reasonCode);
				return { started: false, skipReason: readiness.reasonCode };
			}
			if (readiness.state === "waiting") {
				return this.queuePreparedWorkerAttempt(prepared, request, admission, { onStarted });
			}
		}
		let preparedAgent: PreparedWorkerAgent;
		try {
			preparedAgent = this.ensurePreparedAgent(prepared, admission);
		} catch (error) {
			this.cancelAndPublish(lifecycle, prepared.record.laneId, "worker_conversation_unavailable");
			this.safeWarn(`Worker conversation setup failed: ${error instanceof Error ? error.message : String(error)}`);
			return { started: false, skipReason: "worker_conversation_unavailable" };
		}
		const durableTask = lifecycle.getTask(prepared.record.laneId);
		if (!durableTask) return { started: false, skipReason: "orchestration_task_missing" };
		const immutableWorker = prepared.attempt.dispatch.executionContract?.worker;
		if (!immutableWorker) return { started: false, skipReason: "orchestration_execution_contract_missing" };
		let grant: ExecutionGrant;
		const workerResourceSystemPrompt = preparedAgent.resourceSystemPrompt;
		if (prepared.attempt.grant) {
			if (
				!this.recovery.durableGrantIsStillPermitted(prepared.attempt.grant, executionPlan, preparedAgent.resources)
			) {
				this.cancelAndPublish(lifecycle, prepared.record.laneId, "recovered_grant_revoked");
				return { started: false, skipReason: "recovered_grant_revoked" };
			}
			grant = prepared.attempt.grant;
		} else {
			const compiled = compileWorkerExecutionGrant({
				target: {
					objectiveId: durableTask.task.objectiveId,
					taskId: prepared.attempt.taskId,
					attemptId: prepared.attempt.attemptId,
				},
				profile: orchestrationProfile,
				plan: executionPlan,
				resources: preparedAgent.resources,
			});
			if (!compiled.ok) {
				this.cancelAndPublish(lifecycle, prepared.record.laneId, compiled.reasonCodes.join(","));
				return { started: false, skipReason: `execution_policy_denied:${compiled.reasonCodes.join(",")}` };
			}
			lifecycle.bindGrant(prepared.attempt.attemptId, compiled.grant);
			grant = compiled.grant;
		}
		const immutableProfile = immutableWorker.profile;
		// Follow-up tasks deliberately receive unique task ids while retaining the original logical
		// agent id in dispatch metadata. Never derive a new agent identity from a follow-up task id.
		const agentId = prepared.attempt.agentId ?? prepared.attempt.dispatch.logicalLaneId ?? prepared.record.laneId;
		const registeredAgent = lifecycle.getAgent(agentId);
		if (prepared.attempt.agentId && !registeredAgent) {
			this.cancelAndPublish(lifecycle, prepared.record.laneId, "orchestration_agent_missing");
			return { started: false, skipReason: "orchestration_agent_missing" };
		}
		const conversation = preparedAgent.conversation;
		if (prepared.attempt.status === "queued" || conversation.usesAttemptUsageBoundaries()) {
			try {
				conversation.beginAttemptUsage(prepared.attempt.attemptId);
			} catch (error) {
				this.cancelAndPublish(lifecycle, prepared.record.laneId, "worker_conversation_unavailable");
				this.safeWarn(
					`Worker usage boundary setup failed: ${error instanceof Error ? error.message : String(error)}`,
				);
				return { started: false, skipReason: "worker_conversation_unavailable" };
			}
		}
		if (prepared.attempt.status === "suspended") this.recovery.repairInterruptedToolResults(conversation);
		const reservation = this.writeReservations.acquire(prepared.record.laneId, prepared.attempt, executionPlan);
		if (reservation.kind === "denied") {
			this.cancelAndPublish(lifecycle, prepared.record.laneId, reservation.reasonCode);
			return { started: false, skipReason: reservation.reasonCode };
		}
		if (reservation.kind === "blocked") {
			return this.queuePreparedWorkerAttempt(prepared, request, admission, {
				ensureAgent: false,
				onStarted,
			});
		}
		let durableHandle: StartedDelegationAttempt;
		try {
			durableHandle =
				registeredAgent && prepared.attempt.status === "suspended"
					? lifecycle.resumeAgent(
							prepared.record.laneId,
							registeredAgent.agentId,
							immutableProfile.leaseTtlMs,
							this.agentControl.getProcessOwnerId(),
						)
					: lifecycle.startAgent(
							prepared.record.laneId,
							agentId,
							immutableProfile.leaseTtlMs,
							this.agentControl.getProcessOwnerId(),
						);
		} catch (error) {
			this.writeReservations.release(prepared.record.laneId);
			if (prepared.attempt.status !== "suspended")
				this.cancelAndPublish(lifecycle, prepared.record.laneId, "worker_start_unavailable");
			this.safeWarn(`Worker start failed: ${error instanceof Error ? error.message : String(error)}`);
			return { started: false, skipReason: "worker_start_unavailable" };
		}
		const startedRecord = lifecycle.getRecord(prepared.record.laneId);
		if (!startedRecord) {
			this.writeReservations.release(prepared.record.laneId);
			return { started: false, skipReason: "orchestration_projection_missing" };
		}
		if (
			this.writeReservations.hasFenceMismatch(
				startedRecord.laneId,
				durableHandle.attemptId,
				durableHandle.fencingToken,
			)
		) {
			this.writeReservations.release(startedRecord.laneId);
			const record = this.cancelAndPublish(lifecycle, startedRecord.laneId, "write_reservation_fence_mismatch");
			this.safeWarn("Worker write reservation fence did not match the durable attempt lease.");
			return { started: false, skipReason: record?.reasonCode ?? "write_reservation_fence_mismatch" };
		}
		const recoveredTerminal =
			prepared.attempt.status === "suspended"
				? this.recovery.recoveredTerminalCompletion(conversation, durableHandle.attemptId)
				: undefined;
		const checkpointUsage = lifecycle.getAttemptUsage(startedRecord.laneId);
		const initialUsage = this.recovery.initialUsage(conversation, checkpointUsage, durableHandle.attemptId);
		onStarted?.(startedRecord);
		const maxUsd = grant.budget.maxCostUsd;
		const executionPolicy = orchestrationProfile.executionPolicy;
		const recursiveDelegateTool = wrapToolDefinition(
			createDelegateToolDefinition({
				startWorkerDelegation: (childRequest) => this.start({ ...childRequest, parentAgentId: agentId }),
				runWorkerDelegation: (childRequest) => this.runOnce({ ...childRequest, parentAgentId: agentId }),
				orchestrationProfiles: this.getProfileCatalog(),
				workerAgentControl: this.agentControl,
				caller: { kind: "worker", agentId },
				resolveMessageReplayScope: () => ({
					sessionId: this.deps.getSessionId(),
					branchId: durableHandle.attemptId,
				}),
			}),
		);
		const agentBinding = lifecycle.getAgent(agentId);
		if (!agentBinding) {
			this.cancelAndPublish(lifecycle, prepared.record.laneId, "orchestration_agent_missing");
			return { started: false, skipReason: "orchestration_agent_missing" };
		}
		const rootAttempt = lifecycle.getLatestAgentAttempt(agentBinding.rootAgentId);
		const rootBudget = rootAttempt?.dispatch.executionContract?.worker.authority.budget ?? grant.budget;
		const sharedBudget = this.treeBudgets.createPort({
			rootAgentId: agentBinding.rootAgentId,
			attemptId: durableHandle.attemptId,
			budget: rootBudget,
			seeds: collectWorkerTreeBudgetSeeds(lifecycle.getTaskRuntimeSnapshot(), agentBinding.rootAgentId),
			initialUsage,
		});
		const shellGranted = executionPlan.toolManifests.some((manifest) => manifest.toolName === STABLE_SHELL_TOOL_NAME);
		const shellSessionKey = shellGranted ? `worker:${this.deps.getSessionId()}:${agentId}` : undefined;
		const shellOutputDirectory = shellGranted
			? getProcessWorkRun(this.deps.getAgentDir(), "outputs", "tool-streams").path
			: undefined;
		if (shellSessionKey) this.shellSessionKeys.add(shellSessionKey);
		const toolSurface = createLaneToolSurface({
			cwd: this.deps.getCwd(),
			readMemory: executionPlan.readMemory ? (query) => this.deps.readMemoryForLane(query) : undefined,
			writeEnabled: executionPlan.writeEnabled,
			writePaths: executionPlan.writePaths,
			...(executionPlan.processEnabled && executionPolicy ? { executionPolicy } : {}),
			processMaxWallClockMs: grant.budget.maxWallClockMs ?? 0,
			...(shellSessionKey ? { shellSessionKey } : {}),
			...(shellOutputDirectory ? { shellOutputDirectory } : {}),
			grant,
			toolManifests: executionPlan.toolManifests,
			additionalTools: [recursiveDelegateTool],
			initialUsage,
			sharedBudget,
		});
		const writeGranted =
			executionPlan.writeEnabled &&
			toolSurface.gateway !== undefined &&
			toolSurface.allowedTools.some((name) => name === "write" || name === "edit");
		const workerRequest: WorkerRequest = {
			id: startedRecord.laneId,
			instructions,
			route: {
				tier: "cheap",
				risk: writeGranted ? "scoped-write" : "read-only",
				confidence: 1,
				reasonCode: "profile_worker",
				reasons: [writeGranted ? "Path-scoped worker delegation" : "Read-only worker delegation"],
			},
			envelope: {
				id: `worker-${this.deps.getSessionId()}-${startedRecord.laneId}`,
				profileId: orchestrationProfile.profileId,
				// filesystem.write requires BOTH the opt-in AND an explicit non-empty path scope —
				// an unscoped write grant is refused here, not discovered at validation time.
				capabilities: [...grant.capabilities],
				...(writeGranted ? { allowedPaths: [...grant.writePaths] } : {}),
				deniedPaths: [...grant.deniedPaths],
				allowedTools: [...toolSurface.allowedTools],
				deniedTools: [...toolSurface.deniedTools],
				...(maxUsd !== undefined ? { maxEstimatedUsd: maxUsd } : {}),
				createdAt: new Date().toISOString(),
			},
			...(maxUsd !== undefined ? { maxEstimatedUsd: maxUsd } : {}),
			createdAt: new Date().toISOString(),
		};
		// Worker delegation START. Routing/scope codes + budget only — never the instructions text.
		this.deps.emitAutonomyTelemetry({
			type: AUTONOMY_TELEMETRY_EVENT_TYPES.workerRequest,
			timestamp: new Date().toISOString(),
			payload: {
				id: workerRequest.id,
				tier: workerRequest.route.tier,
				capabilities: [...workerRequest.envelope.capabilities],
				maxEstimatedUsd: workerRequest.maxEstimatedUsd ?? null,
			},
		});
		const usageReportId = `worker:${this.deps.getSessionId()}:${startedRecord.laneId}`;
		const laneAbortController = new AbortController();
		this.laneAbortControllers.set(startedRecord.laneId, laneAbortController);
		const workerSignal = AbortSignal.any([this.workerAbort.signal, laneAbortController.signal]);

		// Registered for the lane's full run so the reload gate waits it out; deregistered in the
		// finally below no matter how this lane terminates (success, disposal, or a thrown error).
		// registerInFlightWork is a pure sync map op (cannot throw), so placing it as the last
		// statement before `try` still guarantees the matching finally always runs.
		const deregisterInFlight = registerInFlightWork(
			this.deps.getAgentDir(),
			"lane",
			`worker:${startedRecord.laneId}`,
		);
		const executor = createWorkerAttemptExecutor({
			request: workerRequest,
			grant,
			executionPlan,
			toolSurface,
			conversation,
			lifecycle,
			laneId: startedRecord.laneId,
			agentId,
			durableHandle,
			parentSessionId: this.deps.getSessionId(),
			agentDir: this.deps.getAgentDir(),
			cwd: this.deps.getCwd(),
			model,
			thinkingLevel: modelBinding.thinkingLevel,
			laneCapability,
			...(soul ? { soul } : {}),
			workerResourceSystemPrompt,
			initialUsage,
			hasPersistedUsageCheckpoint: checkpointUsage !== undefined,
			usageReportId,
			processCapable: executionPlan.processEnabled,
			...(request.verificationOfTaskId ? { verificationSubjectTaskId: request.verificationOfTaskId } : {}),
			...(recoveredTerminal ? { recoveredTerminal } : {}),
			...(retentionPolicy ? { retentionPolicy } : {}),
			signal: workerSignal,
			runIsolatedCompletion: (options) => this.deps.runIsolatedCompletion(options),
			agentControl: this.agentControl,
			applyActions: workerRequest.envelope.capabilities.includes("filesystem.write")
				? (actions, actionJournal) =>
						applyWorkerActions({
							actions,
							gateway: toolSurface.gateway!,
							toolManifests: executionPlan.toolManifests,
							cwd: this.deps.getCwd(),
							...(actionJournal ? { actionJournal } : {}),
						})
				: undefined,
			warn: (message) => this.safeWarn(message),
		});
		try {
			// Register before the first execution await: disposal sees the live mutable ledger.
			this.inFlightLedgers.set(startedRecord.laneId, {
				changedFiles: executor.ledger.changedFiles,
				getUsage: executor.ledger.getUsage,
				request: workerRequest,
				handle: durableHandle,
			});
			const executionResult = await executor.run();
			const rawOutcome = executionResult.rawOutcome;
			// Attempt ladder: a retryable bounded failure suspends and re-enqueues instead of
			// terminalizing, resuming from the persisted transcript under a fresh fence.
			if (rawOutcome.laneStatus === "failed" && !this.deps.isDisposed() && !workerSignal.aborted) {
				const retry = this.recovery.scheduleAttemptRetry({
					laneId: startedRecord.laneId,
					agentId,
					ownerId: this.agentControl.getProcessOwnerId(),
					request: { ...request, profileId: admission.shipment.profile.profileId },
					outcome: rawOutcome,
					provider: modelBinding.provider,
					...(grant.budget.maxAttempts !== undefined ? { maxAttempts: grant.budget.maxAttempts } : {}),
				});
				if (retry.scheduled) {
					this.notifications.statusChanged();
					return { started: true, record: retry.record };
				}
			}
			const verificationRequired =
				orchestrationProfile.requireIndependentVerification &&
				orchestrationProfile.role !== "verifier" &&
				rawOutcome.claim.status === "completed";
			const outcome = verificationRequired
				? {
						...rawOutcome,
						accepted: false,
						reasonCode: "independent_verification_required",
						acceptance: {
							outcome: "ask-user" as const,
							gate: "independent_verification",
							reasonCode: "independent_verification_required",
							message: "The owner-authored profile requires an independent verifier before acceptance.",
						},
						claim: {
							...rawOutcome.claim,
							parentReviewRequired: true,
							blockers: [
								...(rawOutcome.claim.blockers ?? []),
								"independent verification is required before acceptance",
							],
						},
					}
				: rawOutcome;

			// Never persist against a disposed session. When disposal raced this
			// await, `abortInFlightLanes()`'s synchronous cutoff already completed this lane, persisted
			// its durable lane record + bounded WorkerClaim, and consumed (deleted) the ledger —
			// `.complete()` below is then a no-op (the lane is already terminal, so it returns
			// undefined) and no double persistence or duplicate terminal notification can happen here.
			if (this.deps.isDisposed()) {
				const record = lifecycle.getRecord(startedRecord.laneId);
				return { started: true, record, outcome };
			}

			const verificationSubject = request.verificationOfTaskId
				? lifecycle.getTask(request.verificationOfTaskId)
				: undefined;
			const finalUsage = executionResult.usage;
			const reportedUsage = providerUsageFromAttemptUsage(finalUsage);
			let record = finalizeWorkerClaim(lifecycle, {
				handle: durableHandle,
				claim: outcome.claim,
				accepted: outcome.accepted,
				costUsd: finalUsage.costUsd,
				reasonCode: outcome.reasonCode,
				cwd: this.deps.getCwd(),
				inputTokens: finalUsage.inputTokens,
				outputTokens: finalUsage.outputTokens,
				totalTokens: reportedUsage.totalTokens,
				wallClockMs: finalUsage.activeWallClockMs,
				toolCalls: finalUsage.toolCalls,
				verificationRequired,
				verificationCriterionIds: verificationSubject?.task.acceptanceCriterionIds,
				notify: !verificationRequired,
			}).record;
			try {
				this.deps.saveWorkerClaimSnapshot(outcome.claim, workerRequest);
			} catch (error) {
				this.safeWarn(
					`Failed to persist worker claim ${startedRecord.laneId}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (reportedUsage.cost.total > 0 || reportedUsage.totalTokens > 0) {
				this.deps.addSpawnedUsage(reportedUsage, { label: "worker-delegation", reportId: usageReportId });
			}

			const terminalRecords: LaneRecord[] = [record];
			if (request.verificationOfTaskId) {
				const decision = outcome.accepted ? outcome.claim.verification : undefined;
				const subject = lifecycle.reconcileVerification({
					subjectTaskId: request.verificationOfTaskId,
					verifierTaskId: startedRecord.laneId,
					verifierAttemptId: durableHandle.attemptId,
					verdict: decision?.verdict ?? "inconclusive",
					reasonCode: decision
						? decision.verdict === "accepted"
							? "independent_verification_accepted"
							: `independent_verification_rejected:${decision.reasonCodes.join(",")}`
						: `independent_verification_inconclusive:${outcome.reasonCode}`,
				});
				terminalRecords.push(subject);
			} else if (verificationRequired) {
				const verifierStart = verifierShipment
					? this.startInternal(
							this.buildVerifierRequest({
								subjectTaskId: startedRecord.laneId,
								verifierProfileId: verifierShipment.profile.profileId,
								summary: rawOutcome.claim.summary,
								artifactUris: rawOutcome.claim.changedFiles,
							}),
							verifierWorkerExecutionContract(admission.executionContract),
						)
					: { started: false as const, skipReason: "independent_verifier_unavailable" };
				if (verifierStart.started) {
					// The durable verifier dispatch is now the terminal-work owner. The subject remains
					// blocked and emits no compatibility terminal snapshot until reconciliation.
					terminalRecords.length = 0;
					this.scheduler.drain();
				} else {
					this.safeWarn(
						`Independent verifier for ${startedRecord.laneId} did not start: ${verifierStart.skipReason}`,
					);
				}
			}
			if (outcome.acceptance.outcome === "ask-user" && terminalRecords.length > 0) {
				this.deps.queueWorkerHumanInput({
					workerRequestId: startedRecord.laneId,
					message: outcome.acceptance.message ?? "Worker output requires owner review.",
					blockers: outcome.claim.blockers ?? [],
				});
			}
			for (const terminalRecord of terminalRecords) {
				this.publishTerminalRecord(terminalRecord);
			}
			if (request.verificationOfTaskId) {
				record = lifecycle.getRecord(startedRecord.laneId) ?? record;
			}
			return { started: true, record, outcome };
		} catch (error) {
			const durableState = lifecycle.ledger.runtime.getSnapshot().attempts[durableHandle.attemptId];
			if (durableState?.status === "suspended") {
				// Disposal/reload fences agent-bound work before its aborted completion unwinds. Do not
				// convert that resumable interruption into a terminal claim or cancellation.
				return { started: true, record: lifecycle.getRecord(startedRecord.laneId) };
			}
			if (durableState?.status === "cancelled" && (laneAbortController.signal.aborted || this.deps.isDisposed())) {
				return { started: true, record: lifecycle.getRecord(startedRecord.laneId) };
			}
			if (durableState?.status === "running" || durableState?.status === "leased") {
				const failureClaim: WorkerClaim = {
					requestId: startedRecord.laneId,
					status: "failed",
					summary: `Worker delegation failed: ${error instanceof Error ? error.message : String(error)}`,
					changedFiles: [],
					createdAt: new Date().toISOString(),
				};
				try {
					const failureUsage = executor.checkpointUsage(
						"Persisted cumulative usage while recording worker failure.",
					);
					const reportedUsage = providerUsageFromAttemptUsage(failureUsage);
					finalizeWorkerClaim(lifecycle, {
						handle: durableHandle,
						claim: failureClaim,
						accepted: false,
						costUsd: failureUsage.costUsd,
						cwd: this.deps.getCwd(),
						inputTokens: failureUsage.inputTokens,
						outputTokens: failureUsage.outputTokens,
						totalTokens: reportedUsage.totalTokens,
						wallClockMs: failureUsage.activeWallClockMs,
						toolCalls: failureUsage.toolCalls,
						reasonCode: "worker_delegation_error",
					});
				} catch (persistError) {
					this.safeWarn(
						`Failed to persist durable worker failure ${startedRecord.laneId}: ${persistError instanceof Error ? persistError.message : String(persistError)}`,
					);
				}
			}
			let record = lifecycle.getRecord(startedRecord.laneId);
			if (record?.status === "queued" || record?.status === "running") {
				record = this.cancelAndPublish(lifecycle, startedRecord.laneId, "worker_delegation_error");
			}
			if (record && !this.deps.isDisposed()) this.publishTerminalRecord(record);
			const message = error instanceof Error ? error.message : String(error);
			this.deps.emit({ type: "warning", message: `Worker delegation failed: ${message}` });
			return { started: true, record };
		} finally {
			this.writeReservations.release(startedRecord.laneId, durableHandle.attemptId, durableHandle.fencingToken);
			this.inFlightLedgers.delete(startedRecord.laneId);
			this.laneAbortControllers.delete(startedRecord.laneId);
			try {
				await toolSurface.dispose();
			} catch (error) {
				this.safeWarn(
					`Worker mutation payload cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			this.agentControl.signalStateChanged();
			deregisterInFlight();
			if (!this.deps.isDisposed()) this.scheduler.drain(true);
		}
	}

	/** Start every capacity-eligible queued worker at the owner session's foreground-idle boundary. */
	drain(): void {
		this.recovery.recover();
		this.scheduler.drain();
		this.terminalHandoffs.signal();
	}
}
