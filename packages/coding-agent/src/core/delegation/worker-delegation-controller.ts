import path from "node:path";
import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type { Api, Model, Usage } from "@caupulican/pi-ai";
import type {
	AgentSessionEvent,
	IsolatedCompletionOptions,
	IsolatedCompletionResult,
	WorkerDelegationRunOutcome,
} from "../agent-session.ts";
import type { CapabilityEnvelope, WorkerClaim, WorkerRequest } from "../autonomy/contracts.ts";
import { getPrivateLaneDeniedPaths } from "../autonomy/lane-private-paths.ts";
import { createLaneToolSurface } from "../autonomy/lane-tool-surface.ts";
import type { LaneRecord, LaneTerminalStatus } from "../autonomy/lane-tracker.ts";
import { safeRealpathSync } from "../autonomy/path-scope.ts";
import { appendLaneRecordSnapshot } from "../autonomy/session-lane-record.ts";
import { composeSubagentSystemPrompt } from "../autonomy/subagent-prompt.ts";
import { AUTONOMY_TELEMETRY_EVENT_TYPES, type AutonomyTelemetryEvent } from "../autonomy/telemetry-events.ts";
import type { GoalState } from "../goals/goal-state.ts";
import { deriveModelCapabilityProfile, type ModelCapabilityProfile } from "../model-capability.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { OrchestrationProfile } from "../orchestration/contracts.ts";
import type { StartedDelegationAttempt } from "../orchestration/delegation-ledger.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { createWorkerResultContract } from "../orchestration/worker-result-adapter.ts";
import { registerInFlightWork } from "../reload-blockers.ts";
import type { ResolvedWorkerDelegationSettings, SettingsManager } from "../settings-manager.ts";
import { applyWorkerActions } from "./worker-actions.ts";
import type { WorkerDelegationRequest } from "./worker-delegation-request.ts";
import { type WorkerDispatchAdmission, WorkerDispatchScheduler } from "./worker-dispatch-scheduler.ts";
import {
	buildWorkerExecutionPlan,
	compileWorkerExecutionGrant,
	type WorkerExecutionPlan,
} from "./worker-execution-policy.ts";
import type { WorkerLifecycle } from "./worker-lifecycle.ts";
import type { WorkerNotificationCoordinator } from "./worker-notification-coordinator.ts";
import { type ResolvedWorkerProfile, WorkerProfileResolver } from "./worker-profile-resolver.ts";
import { runWorker } from "./worker-runner.ts";

export function isLocalExecutionModel(model: Pick<Model<Api>, "provider" | "baseUrl">): boolean {
	if (model.provider === "ollama" || model.provider === "transformers" || model.provider === "llama-cpp") {
		return true;
	}
	try {
		const hostname = new URL(model.baseUrl).hostname.toLowerCase();
		return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
	} catch {
		return false;
	}
}

export interface WorkerDelegationControllerDeps {
	isDisposed(): boolean;
	getSessionId(): string;
	getCwd(): string;
	getAgentDir(): string;
	getSessionManager(): SessionManager;
	getSettingsManager(): SettingsManager;
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
	private queueRecovered = false;
	private readonly notifications: WorkerNotificationCoordinator;
	private readonly scheduler: WorkerDispatchScheduler;
	private readonly laneAbortControllers = new Map<string, AbortController>();
	private readonly publishedTerminalAttemptIds = new Set<string>();
	private readonly inFlightLedgers = new Map<
		string,
		{
			changedFiles: Set<string>;
			getSpend: () => Usage | undefined;
			getToolCalls: () => number;
			request: WorkerRequest;
			handle: StartedDelegationAttempt;
			startedAt: number;
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
			admit: (request) => this.workerDispatchAdmission(request),
			getRecord: (laneId) => this.getWorkerLifecycle().getRecord(laneId),
			run: (request, record) => this.runOnce(request, undefined, record),
			cancel: (laneId, reasonCode) => {
				try {
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
	}

	private safeWarn(message: string): void {
		try {
			this.deps.emit({ type: "warning", message });
		} catch {
			// Disposal and recovery diagnostics must never throw.
		}
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
		if (this.deps.isDelegateToolActive?.()) this.recoverDurableQueue();
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
		for (const record of this.lifecycle.getRecords()) {
			if (record.status !== "queued" && record.status !== "running") continue;
			const ledger = this.inFlightLedgers.get(record.laneId);
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
				const spend = ledger.getSpend();
				const reportId = `worker:${this.deps.getSessionId()}:${record.laneId}`;
				const claim: WorkerClaim = {
					requestId: ledger.request.id,
					status: "cancelled",
					summary: "canceled on session dispose",
					changedFiles: [...ledger.changedFiles],
					usageReportId: reportId,
					createdAt: new Date().toISOString(),
				};
				const canceled = this.getWorkerLifecycle().finish(
					createWorkerResultContract({
						handle: ledger.handle,
						claim,
						accepted: false,
						costUsd: spend?.cost.total ?? 0,
						cwd: this.deps.getCwd(),
						...(spend
							? {
									inputTokens: spend.input,
									outputTokens: spend.output,
									totalTokens: spend.totalTokens,
								}
							: {}),
						wallClockMs: Date.now() - ledger.startedAt,
						toolCalls: ledger.getToolCalls(),
						reasonCode: "session_disposed",
					}),
				);
				this.publishTerminalRecord(canceled);
				// Bounded honesty: spend may be incomplete (it lands only when the isolated completion
				// returns, which a mid-flight abort preempts) — record what `getSpend()` knows. Same
				// deterministic reportId scheme as the normal path, so a later duplicate report (there
				// is none in practice here, since the lane is now terminal) stays idempotent.
				this.deps.saveWorkerClaimSnapshot(claim, ledger.request);
				if (spend && (spend.cost.total > 0 || spend.totalTokens > 0)) {
					this.deps.addSpawnedUsage(spend, { label: "worker-delegation", reportId });
				}
			} catch (error) {
				this.safeWarn(
					`Failed to persist canceled worker claim ${record.laneId}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		this.scheduler.cancelQueued();
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
			getModelRegistry: () => this.deps.getModelRegistry(),
			isModelExhausted: (model) => this.deps.isModelExhausted(model),
			getActiveOrchestrationProfile: () => this.deps.getActiveOrchestrationProfile?.(),
			onDiagnostic: (message) => this.safeWarn(message),
		});
		return this.profileResolver;
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

	private recoverDurableQueue(): void {
		if (this.queueRecovered) return;
		this.queueRecovered = true;
		const lifecycle = this.getWorkerLifecycle();
		for (const { attempt, record, verificationOfTaskId } of lifecycle.recoverQueued()) {
			const request: WorkerDelegationRequest = {
				instructions: attempt.dispatch.instructions,
				profileId: attempt.dispatch.profileId,
				...(verificationOfTaskId ? { verificationOfTaskId } : {}),
			};
			this.scheduler.enqueue(record, request, true, verificationOfTaskId !== undefined);
		}
		for (const recovery of lifecycle.getPendingVerificationRecoveries()) {
			if (recovery.action === "reconcile") {
				try {
					this.publishTerminalRecord(lifecycle.reconcileVerification(recovery));
				} catch (error) {
					this.safeWarn(
						`Failed to reconcile recovered verification for ${recovery.subjectTaskId}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				continue;
			}
			const implementation = this.resolveWorkerAdmission({
				instructions: recovery.summary,
				profileId: recovery.implementationProfileId,
			});
			const started =
				implementation.ok && implementation.verifierShipment
					? this.start(
							this.buildVerifierRequest({
								subjectTaskId: recovery.subjectTaskId,
								verifierProfileId: implementation.verifierShipment.profile.profileId,
								summary: recovery.summary,
								artifactUris: recovery.artifactUris,
							}),
						)
					: { started: false as const, skipReason: "independent_verifier_unavailable" };
			if (!started.started) {
				this.safeWarn(`Recovered verification for ${recovery.subjectTaskId} did not start: ${started.skipReason}`);
			}
		}
		for (const notification of lifecycle.getPendingTerminalNotifications()) {
			this.notifications.recordTerminal(notification.record, notification.notificationId);
		}
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
	private resolveWorkerAdmission(request: WorkerDelegationRequest): WorkerAdmission {
		if (this.deps.isDisposed()) return { ok: false, skipReason: "session_disposed" };
		const instructions = request.instructions.trim();
		if (!instructions) return { ok: false, skipReason: "missing_instructions" };
		if (!this.deps.isDelegateToolActive()) return { ok: false, skipReason: "delegate_tool_inactive" };
		const settings = this.deps.getSettingsManager().getWorkerDelegationSettings();
		if (!settings.enabled) return { ok: false, skipReason: "worker_delegation_disabled" };
		const resolved = this.resolveWorkerShipment(request, settings);
		if (!resolved.ok) return resolved;
		const verifier = this.resolveRequiredVerifier(resolved.shipment.profile);
		if (!verifier.ok) return verifier;
		if (!this.laneCapabilityProfile(resolved.shipment.model).backgroundLanesEnabled) {
			return { ok: false, skipReason: "model_delegation_unsupported" };
		}
		return {
			ok: true,
			instructions,
			settings,
			shipment: resolved.shipment,
			...(verifier.shipment ? { verifierShipment: verifier.shipment } : {}),
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

	private hasWorkerCapacity(settings: ResolvedWorkerDelegationSettings, profile: OrchestrationProfile): boolean {
		const lifecycle = this.getWorkerLifecycle();
		if (lifecycle.getRunningCount() >= settings.maxConcurrent) return false;
		return lifecycle.getRunningCount(profile.profileId) < profile.maxConcurrent;
	}

	private workerDispatchAdmission(request: WorkerDelegationRequest): WorkerDispatchAdmission {
		const admission = this.resolveWorkerAdmission(request);
		if (!admission.ok) return { action: "cancel", reasonCode: admission.skipReason };
		return this.hasWorkerCapacity(admission.settings, admission.shipment.profile)
			? { action: "start" }
			: { action: "wait" };
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
		const executionPlan = this.buildWorkerExecutionPlan(admission.shipment.profile, admission.settings);
		const lifecycle = this.getWorkerLifecycle();
		if (existingRecord) {
			return {
				executionPlan,
				lifecycle,
				record: existingRecord,
				attempt: lifecycle.getActiveAttempt(existingRecord.laneId),
			};
		}
		const goal = this.deps.getGoalStateSnapshot();
		const prepared = lifecycle.prepare({
			instructions: admission.instructions,
			profile: admission.shipment.profile,
			requiredCapabilities: executionPlan.requiredCapabilities,
			...(request.verificationOfTaskId ? { verificationOfTaskId: request.verificationOfTaskId } : {}),
			...(goal ? { goal } : {}),
		});
		return { executionPlan, lifecycle, ...prepared };
	}

	start(
		request: WorkerDelegationRequest,
	): { started: false; skipReason: string } | { started: true; record: LaneRecord } {
		const admission = this.resolveWorkerAdmission(request);
		if (!admission.ok) return { started: false, skipReason: admission.skipReason };
		this.recoverDurableQueue();
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
		const admission = preparedAdmission ?? this.resolveWorkerAdmission(request);
		if (!admission.ok) return { started: false, skipReason: admission.skipReason };
		this.recoverDurableQueue();
		const { instructions, settings, verifierShipment } = admission;
		const { model, modelBinding, profile: orchestrationProfile, soul } = admission.shipment;
		if (!this.hasWorkerCapacity(settings, orchestrationProfile)) {
			return { started: false, skipReason: "worker_delegation_already_running" };
		}
		const laneCapability = this.laneCapabilityProfile(model);
		const prepared = this.prepareWorkerAttempt(request, admission, existingRecord);
		const { executionPlan, lifecycle } = prepared;
		if (!prepared.attempt) return { started: false, skipReason: "orchestration_attempt_missing" };
		const durableTask = lifecycle.getTask(prepared.record.laneId);
		if (!durableTask) return { started: false, skipReason: "orchestration_task_missing" };
		const compiled = compileWorkerExecutionGrant({
			target: {
				objectiveId: durableTask.task.objectiveId,
				taskId: prepared.attempt.taskId,
				attemptId: prepared.attempt.attemptId,
			},
			profile: orchestrationProfile,
			plan: executionPlan,
		});
		if (!compiled.ok) {
			lifecycle.cancel(prepared.record.laneId, compiled.reasonCodes.join(","));
			return { started: false, skipReason: `execution_policy_denied:${compiled.reasonCodes.join(",")}` };
		}
		lifecycle.bindGrant(prepared.attempt.attemptId, compiled.grant);
		const durableHandle = lifecycle.start(prepared.record.laneId, orchestrationProfile.leaseTtlMs);
		const startedRecord = lifecycle.getRecord(prepared.record.laneId);
		if (!startedRecord) return { started: false, skipReason: "orchestration_projection_missing" };
		onStarted?.(startedRecord);
		const maxUsd = compiled.grant.budget.maxCostUsd;
		const executionPolicy = orchestrationProfile.executionPolicy;
		const toolSurface = createLaneToolSurface({
			cwd: this.deps.getCwd(),
			readMemory: executionPlan.readMemory ? (query) => this.deps.readMemoryForLane(query) : undefined,
			writeEnabled: executionPlan.writeEnabled,
			writePaths: executionPlan.writePaths,
			...(executionPlan.processEnabled && executionPolicy ? { executionPolicy } : {}),
			processMaxWallClockMs: compiled.grant.budget.maxWallClockMs ?? 0,
			grant: compiled.grant,
			toolManifests: executionPlan.toolManifests,
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
				capabilities: [...compiled.grant.capabilities],
				...(writeGranted ? { allowedPaths: [...compiled.grant.writePaths] } : {}),
				deniedPaths: [...compiled.grant.deniedPaths],
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
		const durableStartedAt = Date.now();
		try {
			let spentUsage: Usage | undefined;
			const toolChangedFiles = new Set<string>();
			const toolIssues = new Set<string>();
			// Register the live mutation ledger BEFORE the suspend point below so a synchronous
			// disposal cutoff (`abortInFlightLanes`) can read a race-free snapshot of whatever this
			// worker has already applied — the worker is suspended at the `await runWorker(...)` below
			// whenever abort runs, and the abort signal stops further tool calls. Deleted in the
			// `finally` on every exit path (normal completion, throw, or already consumed by abort).
			this.inFlightLedgers.set(startedRecord.laneId, {
				changedFiles: toolChangedFiles,
				getSpend: () => spentUsage,
				getToolCalls: () => toolSurface.gateway?.getUsage().toolCalls ?? 0,
				request: workerRequest,
				handle: durableHandle,
				startedAt: durableStartedAt,
			});
			const maxToolCalls = compiled.grant.budget.maxToolCalls ?? 0;
			const rawOutcome = await runWorker({
				request: workerRequest,
				maxUsd,
				maxWallClockMs: compiled.grant.budget.maxWallClockMs ?? 0,
				usageReportId,
				getChangedFiles: () => [...toolChangedFiles],
				signal: workerSignal,
				// Parent validation must use the same relative-path baseline the runner reports in.
				cwd: this.deps.getCwd(),
				processCapable: executionPlan.processEnabled,
				...(request.verificationOfTaskId ? { verificationSubjectTaskId: request.verificationOfTaskId } : {}),
				// Write lane: runner-side action application through the envelope path scope.
				applyActions: workerRequest.envelope.capabilities.includes("filesystem.write")
					? (actions) => {
							return applyWorkerActions({
								actions,
								gateway: toolSurface.gateway!,
								toolManifests: executionPlan.toolManifests,
								cwd: this.deps.getCwd(),
							});
						}
					: undefined,
				complete: async ({ systemPrompt, userPrompt, signal }) => {
					const completion = await this.deps.runIsolatedCompletion({
						// Level-0 core and owner-authored profile remain authoritative. The delegating
						// model supplies task instructions only; it cannot replace the worker role prompt.
						systemPrompt: composeSubagentSystemPrompt({
							soul,
							rolePrompt: systemPrompt,
						}),
						messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
						model,
						thinkingLevel: modelBinding.thinkingLevel,
						maxTokens: Math.min(
							laneCapability.laneMaxOutputTokens,
							compiled.grant.budget.maxTokens ?? Number.POSITIVE_INFINITY,
						),
						tools: toolSurface.tools,
						maxTurns: Math.max(1, Math.min(6, maxToolCalls + 1)),
						finalTextPrompt:
							"The tool-turn budget is exhausted. Do not call more tools. Return the required worker-claim JSON envelope now using only evidence already gathered. If the investigation is incomplete, say so in the summary or blockers instead of omitting the envelope.",
						beforeToolCall: async (context, toolSignal) => {
							const decision = await toolSurface.beforeToolCall(context, toolSignal);
							if (decision?.block) {
								toolIssues.add(`${context.toolCall.name} blocked: ${decision.reason ?? "capability denied"}`);
							}
							return decision;
						},
						afterToolCall: async ({ toolCall, args, isError }) => {
							// This hook runs only for a validated, gate-approved tool that actually entered
							// execution. Record a direct mutation target before inspecting `isError`: write/edit
							// may have changed disk and then observed cancellation, timeout, or a late I/O error.
							// Pre-gate/profile/path refusals never reach afterToolCall, so they remain unreported.
							if (toolCall.name === "write" || toolCall.name === "edit") {
								if (args && typeof args === "object" && !Array.isArray(args)) {
									const rawPath = (args as Record<string, unknown>).path;
									if (typeof rawPath === "string" && rawPath.length > 0) {
										const absolutePath = path.isAbsolute(rawPath)
											? path.resolve(rawPath)
											: path.resolve(this.deps.getCwd(), rawPath);
										let canonicalPath = absolutePath;
										try {
											canonicalPath = safeRealpathSync(absolutePath);
										} catch {
											// Execution was attempted; preserve conservative accounting with the lexical path.
										}
										toolChangedFiles.add(
											path.relative(this.deps.getCwd(), canonicalPath).split(path.sep).join("/"),
										);
									}
								}
							}
							if (isError) {
								toolIssues.add(`${toolCall.name} failed during isolated execution`);
								return undefined;
							}
							return undefined;
						},
						signal,
						// Core/soul/role are all static per configuration — the provider can cache the prefix.
						cacheRetention: "short",
						// Stable per-lane synthetic affinity key so repeat worker-delegation calls route to
						// the same cache-warm backend without carrying the real session id.
						laneKind: "worker",
					});
					spentUsage = completion.usage;
					toolSurface.gateway?.recordUsage({
						inputTokens: completion.usage.input,
						outputTokens: completion.usage.output,
						costUsd: completion.usage.cost.total,
					});
					return {
						text: completion.text,
						costUsd: completion.usage.cost.total,
						stopReason: String(completion.stopReason),
						changedFiles: [...toolChangedFiles],
						blockers: [...toolIssues],
					};
				},
			});
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
			let record = lifecycle.finish(
				createWorkerResultContract({
					handle: durableHandle,
					claim: outcome.claim,
					accepted: outcome.accepted,
					costUsd: outcome.costUsd,
					reasonCode: outcome.reasonCode,
					cwd: this.deps.getCwd(),
					...(spentUsage
						? {
								inputTokens: spentUsage.input,
								outputTokens: spentUsage.output,
								totalTokens: spentUsage.totalTokens,
							}
						: {}),
					wallClockMs: Date.now() - durableStartedAt,
					toolCalls: toolSurface.gateway?.getUsage().toolCalls ?? 0,
					verificationRequired,
					verificationCriterionIds: verificationSubject?.task.acceptanceCriterionIds,
				}),
				{ notify: !verificationRequired },
			);
			try {
				this.deps.saveWorkerClaimSnapshot(outcome.claim, workerRequest);
			} catch (error) {
				this.safeWarn(
					`Failed to persist worker claim ${startedRecord.laneId}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (spentUsage && (spentUsage.cost.total > 0 || spentUsage.totalTokens > 0)) {
				this.deps.addSpawnedUsage(spentUsage, { label: "worker-delegation", reportId: usageReportId });
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
					? this.start(
							this.buildVerifierRequest({
								subjectTaskId: startedRecord.laneId,
								verifierProfileId: verifierShipment.profile.profileId,
								summary: rawOutcome.claim.summary,
								artifactUris: rawOutcome.claim.changedFiles,
							}),
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
					lifecycle.finish(
						createWorkerResultContract({
							handle: durableHandle,
							claim: failureClaim,
							accepted: false,
							costUsd: 0,
							cwd: this.deps.getCwd(),
							wallClockMs: Date.now() - durableStartedAt,
							toolCalls: toolSurface.gateway?.getUsage().toolCalls ?? 0,
							reasonCode: "worker_delegation_error",
						}),
					);
				} catch (persistError) {
					this.safeWarn(
						`Failed to persist durable worker failure ${startedRecord.laneId}: ${persistError instanceof Error ? persistError.message : String(persistError)}`,
					);
				}
			}
			let record = lifecycle.getRecord(startedRecord.laneId);
			if (record?.status === "queued" || record?.status === "running") {
				record = lifecycle.cancel(startedRecord.laneId, "worker_delegation_error");
			}
			if (record && !this.deps.isDisposed()) this.publishTerminalRecord(record);
			const message = error instanceof Error ? error.message : String(error);
			this.deps.emit({ type: "warning", message: `Worker delegation failed: ${message}` });
			return { started: true, record };
		} finally {
			this.inFlightLedgers.delete(startedRecord.laneId);
			this.laneAbortControllers.delete(startedRecord.laneId);
			deregisterInFlight();
		}
	}

	/** Start every capacity-eligible queued worker at the owner session's foreground-idle boundary. */
	drain(): void {
		this.recoverDurableQueue();
		this.scheduler.drain();
	}
}
