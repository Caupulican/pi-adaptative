import path from "node:path";
import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type { Api, Model, Usage } from "@caupulican/pi-ai";
import type {
	AgentSessionEvent,
	IsolatedCompletionOptions,
	IsolatedCompletionResult,
	WorkerDelegationRunOutcome,
} from "../agent-session.ts";
import type { CapabilityEnvelope, WorkerRequest, WorkerResult } from "../autonomy/contracts.ts";
import { getPrivateLaneDeniedPaths } from "../autonomy/lane-private-paths.ts";
import { createLaneToolSurface } from "../autonomy/lane-tool-surface.ts";
import type { LaneRecord, LaneTerminalStatus } from "../autonomy/lane-tracker.ts";
import { safeRealpathSync } from "../autonomy/path-scope.ts";
import { appendLaneRecordSnapshot, getLaneRecordSnapshots } from "../autonomy/session-lane-record.ts";
import { composeSubagentSystemPrompt } from "../autonomy/subagent-prompt.ts";
import { AUTONOMY_TELEMETRY_EVENT_TYPES, type AutonomyTelemetryEvent } from "../autonomy/telemetry-events.ts";
import type { GoalState } from "../goals/goal-state.ts";
import { deriveModelCapabilityProfile, type ModelCapabilityProfile } from "../model-capability.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { OrchestrationProfile } from "../orchestration/contracts.ts";
import type { StartedDelegationAttempt } from "../orchestration/delegation-ledger.ts";
import { adaptWorkerResult, adaptWorkerRunOutcome } from "../orchestration/worker-result-adapter.ts";
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
import { WorkerLifecycle } from "./worker-lifecycle.ts";
import { WorkerNotificationCoordinator } from "./worker-notification-coordinator.ts";
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
	saveWorkerResultSnapshot(result: WorkerResult, request?: WorkerRequest): string;
	readMemoryForLane(query: string): Promise<string>;
	addSpawnedUsage(
		usage: Usage,
		opts: { label?: string; sourceSessionId?: string; reportId: string },
	): string | undefined;
	runIsolatedCompletion(opts: IsolatedCompletionOptions): Promise<IsolatedCompletionResult>;
}

export class WorkerDelegationController {
	private readonly deps: WorkerDelegationControllerDeps;
	private readonly workerAbort = new AbortController();
	private lifecycle: WorkerLifecycle | undefined;
	private profileResolver: WorkerProfileResolver | undefined;
	private queueRecovered = false;
	private readonly notifications: WorkerNotificationCoordinator;
	private readonly scheduler: WorkerDispatchScheduler;
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

	constructor(deps: WorkerDelegationControllerDeps) {
		this.deps = deps;
		this.notifications = new WorkerNotificationCoordinator({
			getWorkerRecords: () => this.lifecycle?.getRecords() ?? [],
			emitStatus: (status) => {
				if (typeof this.deps.emit === "function") {
					this.deps.emit({
						type: "delegate_workers",
						...status,
						terminalSinceFlush: [...status.terminalSinceFlush],
					});
				}
			},
			notify: (records) => {
				if (typeof this.deps.notifyWorkerTerminalHandoff !== "function") {
					return Promise.reject(new Error("worker terminal handoff bridge is unavailable"));
				}
				return this.deps.notifyWorkerTerminalHandoff(records);
			},
			warn: (message) => this.safeWarn(message),
			markDurableDelivered: (notificationIds) => this.lifecycle?.markNotificationsDelivered(notificationIds),
		});
		this.scheduler = new WorkerDispatchScheduler({
			agentDir: this.deps.getAgentDir?.() ?? "",
			isDisposed: () => this.deps.isDisposed(),
			admit: (request) => this.workerDispatchAdmission(request),
			getRecord: (laneId) => this.getWorkerLifecycle().getRecord(laneId),
			run: (request, record) => this.runOnce(request, undefined, record),
			cancel: (laneId, reasonCode) => {
				try {
					const terminal = this.getWorkerLifecycle().cancel(laneId, reasonCode);
					if (terminal) this.recordTerminal(terminal);
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
		if (record.type === "worker" && this.lifecycle) {
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
		if (!this.lifecycle && this.deps.isDelegateToolActive?.()) this.recoverDurableQueue();
		return this.lifecycle?.getRecords() ?? [];
	}

	abort(): void {
		this.workerAbort.abort();
		for (const record of this.lifecycle?.getRecords() ?? []) {
			if (record.status !== "queued" && record.status !== "running") continue;
			const ledger = this.inFlightLedgers.get(record.laneId);
			if (!ledger) {
				try {
					const canceled = this.lifecycle?.cancel(record.laneId, "session_disposed");
					if (canceled) {
						appendLaneRecordSnapshot(this.deps.getSessionManager(), canceled);
						this.recordTerminal(canceled);
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
				const result: WorkerResult = {
					requestId: ledger.request.id,
					status: "cancelled",
					summary: "canceled on session dispose",
					changedFiles: [...ledger.changedFiles],
					usageReportId: reportId,
					createdAt: new Date().toISOString(),
				};
				const canceled = this.getWorkerLifecycle().finish(
					adaptWorkerResult({
						handle: ledger.handle,
						result,
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
				appendLaneRecordSnapshot(this.deps.getSessionManager(), canceled);
				this.recordTerminal(canceled);
				// Bounded honesty: spend may be incomplete (it lands only when the isolated completion
				// returns, which a mid-flight abort preempts) — record what `getSpend()` knows. Same
				// deterministic reportId scheme as the normal path, so a later duplicate report (there
				// is none in practice here, since the lane is now terminal) stays idempotent.
				this.deps.saveWorkerResultSnapshot(result, ledger.request);
				if (spend && (spend.cost.total > 0 || spend.totalTokens > 0)) {
					this.deps.addSpawnedUsage(spend, { label: "worker-delegation", reportId });
				}
			} catch (error) {
				this.safeWarn(
					`Failed to persist canceled worker result ${record.laneId}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		this.scheduler.cancelQueued();
		this.notifications.dispose();
	}

	private getWorkerLifecycle(): WorkerLifecycle {
		if (this.lifecycle) return this.lifecycle;
		let minimumNextLaneNumber = 1;
		try {
			for (const record of getLaneRecordSnapshots(this.deps.getSessionManager().getEntries())) {
				const suffix = /^worker-(\d+)$/.exec(record.laneId)?.[1];
				if (suffix) minimumNextLaneNumber = Math.max(minimumNextLaneNumber, Number(suffix) + 1);
			}
		} catch {
			// Durable runtime IDs remain authoritative when compatibility history is unavailable.
		}
		this.lifecycle = new WorkerLifecycle({
			agentDir: this.deps.getAgentDir(),
			sessionId: this.deps.getSessionId(),
			minimumNextLaneNumber,
		});
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
			const settings = this.deps.getSettingsManager().getWorkerDelegationSettings();
			const implementation = this.resolveWorkerShipment(
				{ instructions: recovery.summary, profileId: recovery.implementationProfileId },
				settings,
			);
			const verifier = implementation.ok ? this.resolveRequiredVerifier(implementation.shipment.profile) : undefined;
			const started =
				verifier?.ok && verifier.shipment
					? this.start(
							this.buildVerifierRequest({
								subjectTaskId: recovery.subjectTaskId,
								verifierProfileId: verifier.shipment.profile.profileId,
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
		this.recordTerminal(record);
		appendLaneRecordSnapshot(this.deps.getSessionManager(), record);
		this.deps.emitAutonomyTelemetry({
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

	private hasWorkerCapacity(settings: ResolvedWorkerDelegationSettings, profile: OrchestrationProfile): boolean {
		const lifecycle = this.getWorkerLifecycle();
		if (lifecycle.getRunningCount() >= settings.maxConcurrent) return false;
		return lifecycle.getRunningCount(profile.profileId) < profile.maxConcurrent;
	}

	private workerDispatchAdmission(request: WorkerDelegationRequest): WorkerDispatchAdmission {
		if (this.deps.isDisposed()) return { action: "cancel", reasonCode: "session_disposed" };
		if (!this.deps.isDelegateToolActive()) return { action: "cancel", reasonCode: "delegate_tool_inactive" };
		const settings = this.deps.getSettingsManager().getWorkerDelegationSettings();
		if (!settings.enabled) return { action: "cancel", reasonCode: "worker_delegation_disabled" };
		const resolved = this.resolveWorkerShipment(request, settings);
		if (!resolved.ok) return { action: "cancel", reasonCode: resolved.skipReason };
		if (!this.laneCapabilityProfile(resolved.shipment.model).backgroundLanesEnabled) {
			return { action: "cancel", reasonCode: "model_delegation_unsupported" };
		}
		return this.hasWorkerCapacity(settings, resolved.shipment.profile) ? { action: "start" } : { action: "wait" };
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

	start(
		request: WorkerDelegationRequest,
	): { started: false; skipReason: string } | { started: true; record: LaneRecord } {
		const settings = this.deps.getSettingsManager().getWorkerDelegationSettings();
		if (this.deps.isDisposed()) return { started: false, skipReason: "session_disposed" };
		if (request.instructions.trim().length === 0) return { started: false, skipReason: "missing_instructions" };
		if (!this.deps.isDelegateToolActive()) return { started: false, skipReason: "delegate_tool_inactive" };
		if (!settings.enabled) return { started: false, skipReason: "worker_delegation_disabled" };
		this.recoverDurableQueue();
		const resolved = this.resolveWorkerShipment(request, settings);
		if (!resolved.ok) return { started: false, skipReason: resolved.skipReason };
		const shipment = resolved.shipment;
		const verifier = this.resolveRequiredVerifier(shipment.profile);
		if (!verifier.ok) return { started: false, skipReason: verifier.skipReason };
		if (!this.laneCapabilityProfile(shipment.model).backgroundLanesEnabled) {
			return { started: false, skipReason: "model_delegation_unsupported" };
		}

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
			const plan = this.buildWorkerExecutionPlan(shipment.profile, settings);
			let record: LaneRecord;
			try {
				const goal = this.deps.getGoalStateSnapshot();
				record = this.getWorkerLifecycle().prepare({
					instructions: request.instructions.trim(),
					profile: shipment.profile,
					requiredCapabilities: plan.requiredCapabilities,
					...(request.verificationOfTaskId ? { verificationOfTaskId: request.verificationOfTaskId } : {}),
					...(goal ? { goal: { goalId: goal.goalId, description: goal.userGoal } } : {}),
				}).record;
			} catch (error) {
				this.safeWarn(
					`Worker dispatch was not persisted: ${error instanceof Error ? error.message : String(error)}`,
				);
				return { started: false, skipReason: "orchestration_ledger_error" };
			}
			this.scheduler.enqueue(record, request, false, request.verificationOfTaskId !== undefined);
			this.notifications.statusChanged();
			return { started: true, record };
		}
		let startedRecord: LaneRecord | undefined;
		const promise = this.runOnce(request, (record) => {
			startedRecord = record;
		});
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
		const delegationSettings = this.deps.getSettingsManager().getWorkerDelegationSettings();
		if (this.deps.isDisposed()) {
			return { started: false, skipReason: "session_disposed" };
		}
		const instructions = request.instructions.trim();
		if (instructions.length === 0) {
			return { started: false, skipReason: "missing_instructions" };
		}

		const settings = delegationSettings;
		if (!this.deps.isDelegateToolActive()) {
			return { started: false, skipReason: "delegate_tool_inactive" };
		}
		if (!settings.enabled) {
			return { started: false, skipReason: "worker_delegation_disabled" };
		}
		this.recoverDurableQueue();

		const resolved = this.resolveWorkerShipment(request, settings);
		if (!resolved.ok) {
			return { started: false, skipReason: resolved.skipReason };
		}
		const { model, modelBinding, profile: orchestrationProfile, soul } = resolved.shipment;
		const requiredVerifier = this.resolveRequiredVerifier(orchestrationProfile);
		if (!requiredVerifier.ok) {
			return { started: false, skipReason: requiredVerifier.skipReason };
		}
		if (!this.hasWorkerCapacity(settings, orchestrationProfile)) {
			return { started: false, skipReason: "worker_delegation_already_running" };
		}
		const laneCapability = this.laneCapabilityProfile(model);
		if (!laneCapability.backgroundLanesEnabled) {
			return { started: false, skipReason: "model_delegation_unsupported" };
		}

		const executionPlan = this.buildWorkerExecutionPlan(orchestrationProfile, settings);
		const goal = this.deps.getGoalStateSnapshot();
		const lifecycle = this.getWorkerLifecycle();
		const prepared = existingRecord
			? { record: existingRecord, attempt: lifecycle.getActiveAttempt(existingRecord.laneId) }
			: lifecycle.prepare({
					instructions,
					profile: orchestrationProfile,
					requiredCapabilities: executionPlan.requiredCapabilities,
					...(request.verificationOfTaskId ? { verificationOfTaskId: request.verificationOfTaskId } : {}),
					...(goal ? { goal: { goalId: goal.goalId, description: goal.userGoal } } : {}),
				});
		if (!prepared.attempt) return { started: false, skipReason: "orchestration_attempt_missing" };
		const durableHandle = lifecycle.start(prepared.record.laneId, orchestrationProfile.leaseTtlMs);
		const compiled = compileWorkerExecutionGrant({
			handle: durableHandle,
			profile: orchestrationProfile,
			plan: executionPlan,
		});
		if (!compiled.ok) {
			lifecycle.cancel(prepared.record.laneId, compiled.reasonCodes.join(","));
			return { started: false, skipReason: `execution_policy_denied:${compiled.reasonCodes.join(",")}` };
		}
		lifecycle.bindGrant(durableHandle.attemptId, compiled.grant.grantId);
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
		const memoryReadGranted = executionPlan.readMemory && toolSurface.allowedTools.includes("memory");
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
				// write_files requires BOTH the opt-in AND an explicit non-empty path scope —
				// an unscoped write grant is refused here, not discovered at validation time.
				capabilities: [
					...(compiled.grant.readPaths.length > 0 ? (["read_files"] as const) : []),
					...(memoryReadGranted ? (["memory_read"] as const) : []),
					...(writeGranted ? (["write_files"] as const) : []),
					...(executionPlan.processEnabled ? (["run_shell"] as const) : []),
				],
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
				signal: this.workerAbort.signal,
				// Parent validation must use the same relative-path baseline the runner reports in.
				cwd: this.deps.getCwd(),
				processCapable: executionPlan.processEnabled,
				...(request.verificationOfTaskId ? { verificationSubjectTaskId: request.verificationOfTaskId } : {}),
				// Write lane: runner-side action application through the envelope path scope.
				applyActions: workerRequest.envelope.capabilities.includes("write_files")
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
							"The tool-turn budget is exhausted. Do not call more tools. Return the required worker-result JSON envelope now using only evidence already gathered. If the investigation is incomplete, say so in the summary or blockers instead of omitting the envelope.",
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
				rawOutcome.result.status === "completed";
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
						result: {
							...rawOutcome.result,
							parentReviewRequired: true,
							blockers: [
								...(rawOutcome.result.blockers ?? []),
								"independent verification is required before acceptance",
							],
						},
					}
				: rawOutcome;

			// Never persist against a disposed session. When disposal raced this
			// await, `abortInFlightLanes()`'s synchronous cutoff already completed this lane, persisted
			// its durable lane record + bounded WorkerResult, and consumed (deleted) the ledger —
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
				adaptWorkerRunOutcome({
					handle: durableHandle,
					outcome,
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
				this.deps.saveWorkerResultSnapshot(outcome.result, workerRequest);
			} catch (error) {
				this.safeWarn(
					`Failed to persist compatibility worker snapshot ${startedRecord.laneId}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (spentUsage && (spentUsage.cost.total > 0 || spentUsage.totalTokens > 0)) {
				this.deps.addSpawnedUsage(spentUsage, { label: "worker-delegation", reportId: usageReportId });
			}

			const terminalRecords: LaneRecord[] = [record];
			if (request.verificationOfTaskId) {
				const decision = outcome.accepted ? outcome.result.verification : undefined;
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
				const verifierShipment = requiredVerifier.ok ? requiredVerifier.shipment : undefined;
				const verifierStart = verifierShipment
					? this.start(
							this.buildVerifierRequest({
								subjectTaskId: startedRecord.laneId,
								verifierProfileId: verifierShipment.profile.profileId,
								summary: rawOutcome.result.summary,
								artifactUris: rawOutcome.result.changedFiles,
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
			for (const terminalRecord of terminalRecords) {
				this.publishTerminalRecord(terminalRecord);
			}
			if (request.verificationOfTaskId) {
				record = lifecycle.getRecord(startedRecord.laneId) ?? record;
			}
			return { started: true, record, outcome };
		} catch (error) {
			const durableState = lifecycle.ledger.runtime.getSnapshot().attempts[durableHandle.attemptId];
			if (durableState?.status === "running" || durableState?.status === "leased") {
				const failureResult: WorkerResult = {
					requestId: startedRecord.laneId,
					status: "failed",
					summary: `Worker delegation failed: ${error instanceof Error ? error.message : String(error)}`,
					changedFiles: [],
					createdAt: new Date().toISOString(),
				};
				try {
					lifecycle.finish(
						adaptWorkerResult({
							handle: durableHandle,
							result: failureResult,
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
			if (record) this.recordTerminal(record);
			if (record && !this.deps.isDisposed()) {
				appendLaneRecordSnapshot(this.deps.getSessionManager(), record);
				this.deps.emitAutonomyTelemetry({
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
			this.deps.emit({ type: "warning", message: `Worker delegation failed: ${message}` });
			return { started: true, record };
		} finally {
			this.inFlightLedgers.delete(startedRecord.laneId);
			deregisterInFlight();
		}
	}

	/** Start every capacity-eligible queued worker at the owner session's foreground-idle boundary. */
	drain(): void {
		this.recoverDurableQueue();
		this.scheduler.drain();
	}
}
