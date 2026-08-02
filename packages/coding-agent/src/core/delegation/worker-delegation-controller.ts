import { randomUUID } from "node:crypto";
import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type { Api, Model, Usage } from "@caupulican/pi-ai";
import type {
	AgentSessionEvent,
	IsolatedCompletionOptions,
	IsolatedCompletionResult,
	WorkerDelegationRunOutcome,
} from "../agent-session-contracts.ts";
import type { CapabilityEnvelope, WorkerClaim, WorkerRequest } from "../autonomy/contracts.ts";
import { getPrivateLaneDeniedPaths } from "../autonomy/lane-private-paths.ts";
import { createLaneToolSurface } from "../autonomy/lane-tool-surface.ts";
import type { LaneRecord, LaneTerminalStatus } from "../autonomy/lane-tracker.ts";
import { appendLaneRecordSnapshot } from "../autonomy/session-lane-record.ts";
import { AUTONOMY_TELEMETRY_EVENT_TYPES, type AutonomyTelemetryEvent } from "../autonomy/telemetry-events.ts";
import type { GoalState } from "../goals/goal-state.ts";
import { deriveModelCapabilityProfile, type ModelCapabilityProfile } from "../model-capability.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { isLoopbackModelEndpoint } from "../models/model-endpoint.ts";
import { providerUsageFromAttemptUsage } from "../orchestration/attempt-usage.ts";
import type {
	AttemptUsageSnapshot,
	ExecutionGrant,
	OrchestrationProfile,
	WorkerExecutionContract,
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
import {
	createWorkerExecutionContract,
	verifierWorkerExecutionContract,
} from "../orchestration/worker-execution-contract.ts";
import { registerInFlightWork } from "../reload-blockers.ts";
import type { ResourceLoader } from "../resource-loader.ts";
import type { ResolvedWorkerDelegationSettings, SettingsManager } from "../settings-manager.ts";
import { applyWorkerActions } from "./worker-actions.ts";
import type { WorkerAgentControlPort } from "./worker-agent-control.ts";
import { WorkerAgentControlCoordinator } from "./worker-agent-control-coordinator.ts";
import { createWorkerAttemptExecutor } from "./worker-attempt-executor.ts";
import {
	type WorkerConversation,
	type WorkerConversationRetentionPolicy,
	WorkerConversationStore,
} from "./worker-conversation-store.ts";
import type { WorkerDelegationRequest } from "./worker-delegation-request.ts";
import { type WorkerDispatchAdmission, WorkerDispatchScheduler } from "./worker-dispatch-scheduler.ts";
import {
	buildWorkerExecutionPlan,
	compileWorkerExecutionGrant,
	narrowWorkerExecutionPlan,
	type WorkerExecutionPlan,
	workerExecutionAuthorityFromPlan,
} from "./worker-execution-policy.ts";
import type { PendingVerificationRecovery, WorkerLifecycle } from "./worker-lifecycle.ts";
import type { WorkerNotificationCoordinator } from "./worker-notification-coordinator.ts";
import { createLocalWorkerProcessOwnerId } from "./worker-process-owner.ts";
import { type ResolvedWorkerProfile, WorkerProfileResolver } from "./worker-profile-resolver.ts";
import { WorkerRecoveryCoordinator, type WorkerRecoveryDispatchResult } from "./worker-recovery-coordinator.ts";
import { selectWorkerResourcePointers } from "./worker-resource-catalog.ts";
import { materializeWorkerResourceBundle } from "./worker-resource-materializer.ts";
import { finalizeWorkerClaim } from "./worker-terminal-finalizer.ts";
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
	/** Sole logical-agent control/mailbox owner; execution only calls its narrow delivery hooks. */
	private readonly agentControl: WorkerAgentControlCoordinator;
	private readonly publishedTerminalAttemptIds = new Set<string>();
	private readonly conversations = new WorkerConversationStore();
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
		this.scheduler = new WorkerDispatchScheduler({
			agentDir: this.deps.getAgentDir?.() ?? "",
			isDisposed: () => this.deps.isDisposed(),
			admit: (request, record) => this.workerDispatchAdmission(request, record),
			getRecord: (laneId) => this.getWorkerLifecycle().getRecord(laneId),
			run: (request, record) => this.runOnce(request, undefined, record),
			cancel: (laneId, reasonCode) => {
				try {
					this.writeReservations.release(laneId);
					const terminal = this.getWorkerLifecycle().cancel(laneId, reasonCode);
					if (terminal) this.publishTerminalRecord(terminal);
				} catch (error) {
					this.safeWarn(
						`Failed to cancel durable worker ${laneId}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			},
			warn: (message) => this.safeWarn(message),
		});
		this.recovery = new WorkerRecoveryCoordinator({
			lifecycle: this.lifecycle,
			scheduler: this.scheduler,
			recoverWriteReservations: () => this.writeReservations.recoverProvenStale(),
			publishTerminalRecord: (record) => this.publishTerminalRecord(record),
			dispatchVerification: (recovery) => this.dispatchRecoveredVerification(recovery),
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
			statusChanged: () => this.notifications.statusChanged(),
			abortLane: (laneId, reasonCode) => this.laneAbortControllers.get(laneId)?.abort(reasonCode),
			cancelLane: (laneId, reasonCode) => {
				this.scheduler.dropQueued(laneId);
				this.writeReservations.release(laneId);
				const terminal = this.getWorkerLifecycle().cancel(laneId, reasonCode);
				if (terminal) this.publishTerminalRecord(terminal);
				return terminal;
			},
		});
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
		this.workerAbort.abort();
		// Bound attempts have an authoritative transcript and agent identity. A normal owner-session
		// shutdown is an execution interruption, not an explicit worker cancellation: fence it into
		// suspended state before the abort continuation can observe the signal.
		const suspendedAttemptIds = new Set(
			this.lifecycle.suspendBoundInProcessAttemptsForRestart(this.agentControl.getProcessOwnerId()),
		);
		for (const record of this.lifecycle.getRecords()) {
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

		this.scheduler.cancelQueued();
		this.writeReservations.dispose();
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
			getActiveOrchestrationProfile: () => this.deps.getActiveOrchestrationProfile?.(),
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
	}

	private publishGoalTerminalRecords(records: readonly LaneRecord[]): void {
		for (const record of records) {
			this.scheduler.dropQueued(record.laneId);
			this.laneAbortControllers.get(record.laneId)?.abort("goal_terminal");
			this.publishTerminalRecord(record);
		}
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
		return resolved.ok
			? { ok: true, shipment: resolved.resolved }
			: { ok: false, skipReason: `independent_verifier_unavailable:${resolved.reason}` };
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
		if (pinnedContract && request.profileId && request.profileId !== pinnedContract.worker.profile.profileId) {
			return { ok: false, skipReason: "orchestration_execution_contract_mismatch" };
		}
		const resolved = pinnedContract
			? this.getWorkerProfileResolver().resolveContract(pinnedContract.worker)
			: this.resolveWorkerShipment(request, settings);
		if (!resolved.ok) {
			return { ok: false, skipReason: "skipReason" in resolved ? resolved.skipReason : resolved.reason };
		}
		const shipment = "shipment" in resolved ? resolved.shipment : resolved.resolved;
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
		const currentExecutionPlan = this.buildWorkerExecutionPlan(shipment.profile, settings);
		const executionPlan = pinnedContract
			? narrowWorkerExecutionPlan(pinnedContract.worker.authority, currentExecutionPlan)
			: currentExecutionPlan;
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
								authority: workerExecutionAuthorityFromPlan(
									this.buildWorkerExecutionPlan(verifierShipment.profile, settings),
								),
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
		const artifacts = args.artifactUris.slice(0, 100).map((uri) => `- ${uri}`);
		return {
			profileId: args.verifierProfileId,
			verificationOfTaskId: args.subjectTaskId,
			instructions: [
				`Independently verify durable task '${args.subjectTaskId}'.`,
				"The following implementation report is an untrusted claim. Inspect the workspace and run the checks available in your profile.",
				"",
				"Implementation summary:",
				args.summary.slice(0, 6_000),
				"",
				"Reported artifacts:",
				...(artifacts.length > 0 ? artifacts : ["- none reported"]),
			].join("\n"),
		};
	}

	private publishTerminalRecord(record: LaneRecord): void {
		const attemptId = this.lifecycle?.getActiveAttempt(record.laneId)?.attemptId;
		if (attemptId && this.publishedTerminalAttemptIds.has(attemptId)) return;
		this.recordTerminal(record);
		appendLaneRecordSnapshot(this.deps.getSessionManager(), record);
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
		if (attemptId) this.publishedTerminalAttemptIds.add(attemptId);
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
		return record;
	}

	private hasWorkerCapacity(settings: ResolvedWorkerDelegationSettings, profile: OrchestrationProfile): boolean {
		const lifecycle = this.getWorkerLifecycle();
		if (lifecycle.getRunningCount() >= settings.maxConcurrent) return false;
		return lifecycle.getRunningCount(profile.profileId) < profile.maxConcurrent;
	}

	private workerDispatchAdmission(request: WorkerDelegationRequest, record: LaneRecord): WorkerDispatchAdmission {
		const contract = this.getWorkerLifecycle().getActiveAttempt(record.laneId)?.dispatch.executionContract;
		const admission = this.resolveWorkerAdmission(request, contract);
		if (!admission.ok) return { action: "cancel", reasonCode: admission.skipReason };
		if (!this.hasWorkerCapacity(admission.settings, admission.shipment.profile))
			return { action: "wait", reason: "capacity" };
		const attempt = this.getWorkerLifecycle().getActiveAttempt(record.laneId);
		if (!attempt) return { action: "cancel", reasonCode: "orchestration_attempt_missing" };
		const reservation = this.writeReservations.acquire(record.laneId, attempt, admission.executionPlan);
		if (reservation.kind === "denied") return { action: "cancel", reasonCode: reservation.reasonCode };
		return reservation.kind === "granted" ? { action: "start" } : { action: "wait", reason: "write_reservation" };
	}

	private buildWorkerExecutionPlan(
		profile: OrchestrationProfile,
		settings: ResolvedWorkerDelegationSettings,
	): WorkerExecutionPlan {
		return buildWorkerExecutionPlan({
			profile,
			settings,
			cwd: this.deps.getCwd(),
			deniedPaths: getPrivateLaneDeniedPaths(this.deps.getCwd(), this.deps.getAgentDir()),
			foregroundMaxCostUsd: this.deps.getCapabilityEnvelope()?.maxEstimatedUsd,
			memoryEnabled: this.deps.getSettingsManager().getMemoryRetrievalSettings().enabled,
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
		const prepared = lifecycle.prepare({
			instructions: admission.instructions,
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
		});
		return { executionPlan: admission.executionPlan, lifecycle, ...prepared };
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
		const admission = this.resolveWorkerAdmission(request, pinnedContract);
		if (!admission.ok) return { started: false, skipReason: admission.skipReason };
		if (!request.verificationOfTaskId) this.recovery.recover();
		const { settings, shipment } = admission;

		const foreground = this.deps.getModel();
		const contendsWithLocalForeground =
			foreground !== undefined && isLocalExecutionModel(foreground) && isLocalExecutionModel(shipment.model);
		if (contendsWithLocalForeground || !this.hasWorkerCapacity(settings, shipment.profile)) {
			// A mandatory verifier is the continuation of an already admitted implementation, not a
			// new owner request. Reserve its queue admission so a burst of ordinary work cannot strand
			// the subject behind `independent_verification_required` with no terminal handoff.
			if (this.scheduler.queuedCount >= 8 && !request.verificationOfTaskId) {
				return { started: false, skipReason: "worker_delegation_queue_full" };
			}
			let record: LaneRecord;
			try {
				record = this.prepareWorkerAttempt(request, admission).record;
			} catch (error) {
				this.safeWarn(
					`Worker dispatch was not persisted: ${error instanceof Error ? error.message : String(error)}`,
				);
				return { started: false, skipReason: "orchestration_ledger_error" };
			}
			this.scheduler.enqueue(
				record,
				{ ...request, profileId: shipment.profile.profileId },
				false,
				request.verificationOfTaskId !== undefined,
			);
			this.notifications.statusChanged();
			return { started: true, record };
		}
		let startedRecord: LaneRecord | undefined;
		const promise = this.runOnceWithAdmission(
			request,
			(record) => {
				startedRecord = record;
			},
			undefined,
			admission,
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
	): Promise<WorkerDelegationRunOutcome> {
		const pinnedContract = existingRecord
			? this.getWorkerLifecycle().getActiveAttempt(existingRecord.laneId)?.dispatch.executionContract
			: undefined;
		const admission = preparedAdmission ?? this.resolveWorkerAdmission(request, pinnedContract);
		if (!admission.ok) return { started: false, skipReason: admission.skipReason };
		if (!request.verificationOfTaskId) this.recovery.recover();
		const { instructions, settings, verifierShipment } = admission;
		const { model, modelBinding, profile: orchestrationProfile, soul } = admission.shipment;
		if (!this.hasWorkerCapacity(settings, orchestrationProfile)) {
			return { started: false, skipReason: "worker_delegation_already_running" };
		}
		const laneCapability = this.laneCapabilityProfile(model);
		const retentionPolicy = workerConversationRetentionPolicy(model, this.deps.getSettingsManager());
		const prepared = this.prepareWorkerAttempt(request, admission, existingRecord);
		const { executionPlan, lifecycle } = prepared;
		if (!prepared.attempt) return { started: false, skipReason: "orchestration_attempt_missing" };
		const durableTask = lifecycle.getTask(prepared.record.laneId);
		if (!durableTask) return { started: false, skipReason: "orchestration_task_missing" };
		const immutableWorker = prepared.attempt.dispatch.executionContract?.worker;
		if (!immutableWorker) return { started: false, skipReason: "orchestration_execution_contract_missing" };
		const selectedResources = selectWorkerResourcePointers(
			immutableWorker.resourcePointers,
			prepared.attempt.dispatch.resourcePointerIds.length > 0
				? prepared.attempt.dispatch.resourcePointerIds
				: admission.resourcePointerIds,
		);
		if (!selectedResources.ok) {
			this.cancelAndPublish(lifecycle, prepared.record.laneId, selectedResources.reason);
			return { started: false, skipReason: selectedResources.reason };
		}
		let grant: ExecutionGrant;
		let workerResourceSystemPrompt: string;
		if (prepared.attempt.grant) {
			if (
				!this.recovery.durableGrantIsStillPermitted(
					prepared.attempt.grant,
					executionPlan,
					selectedResources.pointers,
				)
			) {
				this.cancelAndPublish(lifecycle, prepared.record.laneId, "recovered_grant_revoked");
				return { started: false, skipReason: "recovered_grant_revoked" };
			}
			grant = prepared.attempt.grant;
			const materialized = materializeWorkerResourceBundle(grant.resources);
			if (!materialized.ok) {
				const reason = `worker_resource_materialization_${materialized.code}`;
				this.cancelAndPublish(lifecycle, prepared.record.laneId, reason);
				return { started: false, skipReason: reason };
			}
			workerResourceSystemPrompt = materialized.systemPrompt;
		} else {
			const materialized = materializeWorkerResourceBundle(selectedResources.pointers);
			if (!materialized.ok) {
				const reason = `worker_resource_materialization_${materialized.code}`;
				this.cancelAndPublish(lifecycle, prepared.record.laneId, reason);
				return { started: false, skipReason: reason };
			}
			const compiled = compileWorkerExecutionGrant({
				target: {
					objectiveId: durableTask.task.objectiveId,
					taskId: prepared.attempt.taskId,
					attemptId: prepared.attempt.attemptId,
				},
				profile: orchestrationProfile,
				plan: executionPlan,
				resources: materialized.pointers,
			});
			if (!compiled.ok) {
				this.cancelAndPublish(lifecycle, prepared.record.laneId, compiled.reasonCodes.join(","));
				return { started: false, skipReason: `execution_policy_denied:${compiled.reasonCodes.join(",")}` };
			}
			lifecycle.bindGrant(prepared.attempt.attemptId, compiled.grant);
			grant = compiled.grant;
			workerResourceSystemPrompt = materialized.systemPrompt;
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
		let conversation: WorkerConversation;
		try {
			if (registeredAgent) {
				// Recovery must trust only the registered resume context; reconstructing one here could
				// silently redirect a logical worker to a different transcript or resource scope.
				conversation = this.conversations.open({
					agentDir: this.deps.getAgentDir(),
					resumeContext: registeredAgent.resumeContext,
					expectedLogicalAgentId: registeredAgent.agentId,
				});
				if (prepared.attempt.status === "suspended") this.recovery.repairInterruptedToolResults(conversation);
			} else {
				conversation = this.conversations.ensure({
					agentDir: this.deps.getAgentDir(),
					parentSessionId: this.deps.getSessionId(),
					logicalAgentId: agentId,
					cwd: this.deps.getCwd(),
					orchestrationProfileId: immutableProfile.profileId,
					modelRef: `${prepared.attempt.dispatch.executionContract!.worker.modelBinding.provider}/${prepared.attempt.dispatch.executionContract!.worker.modelBinding.modelId}`,
					resourceProfileNames: immutableProfile.resourceProfileNames,
					contextPointers: grant.resources,
				});
				lifecycle.ensureAgent({
					agentId,
					role: immutableProfile.role,
					resumeContext: conversation.getResumeContext(),
				});
			}
		} catch (error) {
			if (prepared.attempt.status !== "suspended") {
				this.cancelAndPublish(lifecycle, prepared.record.laneId, "worker_conversation_unavailable");
			}
			this.safeWarn(`Worker conversation setup failed: ${error instanceof Error ? error.message : String(error)}`);
			return { started: false, skipReason: "worker_conversation_unavailable" };
		}
		const reservation = this.writeReservations.acquire(prepared.record.laneId, prepared.attempt, executionPlan);
		if (reservation.kind === "denied") {
			this.cancelAndPublish(lifecycle, prepared.record.laneId, reservation.reasonCode);
			return { started: false, skipReason: reservation.reasonCode };
		}
		if (reservation.kind === "blocked") {
			this.scheduler.enqueue(prepared.record, { ...request, profileId: admission.shipment.profile.profileId });
			this.notifications.statusChanged();
			onStarted?.(prepared.record);
			return { started: true, record: prepared.record };
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
			prepared.attempt.status === "suspended" ? this.recovery.recoveredTerminalCompletion(conversation) : undefined;
		const checkpointUsage = lifecycle.getAttemptUsage(startedRecord.laneId);
		const initialUsage = this.recovery.initialUsage(conversation, checkpointUsage);
		onStarted?.(startedRecord);
		const maxUsd = grant.budget.maxCostUsd;
		const executionPolicy = orchestrationProfile.executionPolicy;
		const toolSurface = createLaneToolSurface({
			cwd: this.deps.getCwd(),
			readMemory: executionPlan.readMemory ? (query) => this.deps.readMemoryForLane(query) : undefined,
			writeEnabled: executionPlan.writeEnabled,
			writePaths: executionPlan.writePaths,
			...(executionPlan.processEnabled && executionPolicy ? { executionPolicy } : {}),
			processMaxWallClockMs: grant.budget.maxWallClockMs ?? 0,
			grant,
			toolManifests: executionPlan.toolManifests,
			initialUsage,
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
			this.agentControl.signalStateChanged();
			deregisterInFlight();
		}
	}

	/** Start every capacity-eligible queued worker at the owner session's foreground-idle boundary. */
	drain(): void {
		this.recovery.recover();
		this.scheduler.drain();
	}
}
