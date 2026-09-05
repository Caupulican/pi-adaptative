import type { Message, Usage } from "@caupulican/pi-ai";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import { isPathWithinScope } from "../autonomy/path-scope.ts";
import { reconcileAttemptUsage } from "../orchestration/attempt-usage.ts";
import type { AttemptUsageSnapshot, ExecutionGrant, ResourcePointer, RiskBudget } from "../orchestration/contracts.ts";
import type { AttemptRuntimeState } from "../orchestration/task-runtime.ts";
import type { WorkerConversation } from "./worker-conversation-store.ts";
import type { WorkerDelegationRequest } from "./worker-delegation-request.ts";
import type { WorkerDispatchScheduler } from "./worker-dispatch-scheduler.ts";
import type { WorkerExecutionPlan } from "./worker-execution-policy.ts";
import type { PendingVerificationRecovery, WorkerLifecycle } from "./worker-lifecycle.ts";
import { evaluateWorkerRetry } from "./worker-retry-policy.ts";

export type WorkerRecoveryDispatchResult = { started: true } | { started: false; skipReason: string };

export type WorkerRetryScheduleResult =
	| { scheduled: true; record: LaneRecord; retriesUsed: number; notBefore: string }
	| { scheduled: false; reason: string };

interface PendingRetryDispatch {
	laneId: string;
	notBefore: string;
	request: WorkerDelegationRequest;
	priority: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

export interface WorkerRecoveryCoordinatorOptions {
	lifecycle: WorkerLifecycle;
	scheduler: Pick<WorkerDispatchScheduler, "enqueue"> &
		Partial<Pick<WorkerDispatchScheduler, "onQueueCapacityAvailable">>;
	recoverWriteReservations(): void;
	publishTerminalRecord(record: LaneRecord): void;
	publishTerminalRecords?(records: readonly LaneRecord[]): void;
	dispatchVerification(
		recovery: Extract<PendingVerificationRecovery, { action: "dispatch" }>,
	): WorkerRecoveryDispatchResult;
	recoverTaskBearingMailboxTurns(): void;
	recoverSessionRootReplies(): void;
	/** Wake the scheduler and UI after a retained retry deadline becomes eligible. */
	retryReady?(): void;
	now?(): number;
	warn(message: string): void;
}

function restartResumableSuspension(
	attempt: AttemptRuntimeState,
	newlySuspendedAttemptIds: ReadonlySet<string>,
): boolean {
	return (
		newlySuspendedAttemptIds.has(attempt.attemptId) ||
		attempt.reasonCode === "agent_process_recovered_after_owner_exit" ||
		attempt.reasonCode === "agent_process_interrupted" ||
		attempt.reasonCode?.startsWith("retry_scheduled:") === true
	);
}

/**
 * Owns restart-only worker state repair. It has no provider or tool execution authority: it
 * reconstructs bounded durable requests, requeues them through the owner scheduler, and supplies
 * the execution layer with narrow transcript/usage/grant recovery decisions.
 */
export class WorkerRecoveryCoordinator {
	private readonly options: WorkerRecoveryCoordinatorOptions;
	private queueRecovered = false;
	private recoveringDurableState = false;
	private readonly verificationRecoveryFailures = new Map<string, string>();
	private readonly retryTimers = new Map<string, PendingRetryDispatch>();
	private readonly unsubscribeQueueCapacity: (() => void) | undefined;

	constructor(options: WorkerRecoveryCoordinatorOptions) {
		this.options = options;
		this.unsubscribeQueueCapacity = options.scheduler.onQueueCapacityAvailable?.(() => {
			this.flushDueRetries();
			// Mandatory verifier dispatches remain derivable from durable subject state even after the
			// ordinary queue was fully recovered. Every released slot must replay that retained demand.
			this.recover();
		});
	}

	/** Idempotently rebuild in-process queues, terminal outboxes, and task-bearing mailboxes. */
	recover(): void {
		if (this.recoveringDurableState) return;
		this.recoveringDurableState = true;
		const { lifecycle } = this.options;
		try {
			if (!this.queueRecovered) {
				const newlySuspendedAttemptIds = new Set(lifecycle.suspendBoundInProcessAttemptsForRestart());
				try {
					this.options.recoverWriteReservations();
				} catch (error) {
					this.options.warn(
						`Worker write reservation recovery failed closed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				const queued = lifecycle.recoverQueued();
				const snapshot = lifecycle.getTaskRuntimeSnapshot();
				for (const attempt of Object.values(snapshot.attempts)) {
					if (
						attempt.status !== "suspended" ||
						!attempt.agentId ||
						attempt.dispatch.executionKind === "managed-process" ||
						!restartResumableSuspension(attempt, newlySuspendedAttemptIds)
					) {
						continue;
					}
					const record = lifecycle.getRecord(attempt.taskId);
					const task = snapshot.tasks[attempt.taskId]?.task;
					if (!record || !task) continue;
					queued.push({
						record,
						attempt,
						...(task.verificationOfTaskId ? { verificationOfTaskId: task.verificationOfTaskId } : {}),
					});
				}
				let recoveredAll = true;
				for (const { attempt, record, verificationOfTaskId } of queued) {
					let retained: boolean;
					try {
						retained = this.enqueueOrDeferRetry(
							record,
							attempt,
							this.recoveredRequest(attempt, verificationOfTaskId),
							verificationOfTaskId !== undefined,
						);
					} catch (error) {
						recoveredAll = false;
						this.options.warn(
							`Failed to recover queued worker ${record.laneId}; retaining durable dispatch: ${error instanceof Error ? error.message : String(error)}`,
						);
						continue;
					}
					if (retained) continue;
					recoveredAll = false;
					break;
				}
				this.queueRecovered = recoveredAll;
			}

			for (const recovery of lifecycle.getPendingVerificationRecoveries()) {
				if (recovery.action === "reconcile") {
					try {
						this.options.publishTerminalRecord(lifecycle.reconcileVerification(recovery));
						this.verificationRecoveryFailures.delete(recovery.subjectTaskId);
					} catch (error) {
						this.options.warn(
							`Failed to reconcile recovered verification for ${recovery.subjectTaskId}: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
					continue;
				}
				let started: WorkerRecoveryDispatchResult;
				try {
					started = this.options.dispatchVerification(recovery);
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					const failureKey = `dispatch_threw:${reason}`;
					if (this.verificationRecoveryFailures.get(recovery.subjectTaskId) !== failureKey) {
						this.verificationRecoveryFailures.set(recovery.subjectTaskId, failureKey);
						this.options.warn(
							`Recovered verification for ${recovery.subjectTaskId} threw during dispatch: ${reason}`,
						);
					}
					continue;
				}
				if (started.started) {
					this.verificationRecoveryFailures.delete(recovery.subjectTaskId);
					continue;
				}
				if (this.verificationRecoveryFailures.get(recovery.subjectTaskId) === started.skipReason) continue;
				this.verificationRecoveryFailures.set(recovery.subjectTaskId, started.skipReason);
				this.options.warn(
					`Recovered verification for ${recovery.subjectTaskId} did not start: ${started.skipReason}`,
				);
			}

			const terminalRecords = lifecycle
				.getPendingTerminalNotifications()
				.map((notification) => notification.record)
				// ManagedLaneController owns tmux projection and durable delivery; replaying it here
				// creates a second publisher every time unrelated foreground state triggers recovery.
				.filter((record) => record.type !== "tmux-worker");
			if (terminalRecords.length > 0) {
				if (this.options.publishTerminalRecords) this.options.publishTerminalRecords(terminalRecords);
				else for (const record of terminalRecords) this.options.publishTerminalRecord(record);
			}
			this.options.recoverSessionRootReplies();
			this.options.recoverTaskBearingMailboxTurns();
		} finally {
			this.recoveringDurableState = false;
		}
	}

	/** Evaluate, persist, and arm one retry through the same durable path used by restart recovery. */
	scheduleAttemptRetry(args: {
		laneId: string;
		agentId: string;
		ownerId: string;
		request: WorkerDelegationRequest;
		outcome: { laneStatus: string; reasonCode: string; reasonDetail?: string };
		provider: string;
		maxAttempts?: number;
	}): WorkerRetryScheduleResult {
		const attempt = this.options.lifecycle.getActiveAttempt(args.laneId);
		const record = this.options.lifecycle.getRecord(args.laneId);
		if (!attempt || !record) return { scheduled: false, reason: "attempt_missing" };
		const retriesUsed = attempt.retry?.retriesUsed ?? 0;
		const decision = evaluateWorkerRetry({
			laneStatus: args.outcome.laneStatus,
			reasonCode: args.outcome.reasonCode,
			...(args.outcome.reasonDetail ? { reasonDetail: args.outcome.reasonDetail } : {}),
			provider: args.provider,
			retriesUsed,
			...(args.maxAttempts !== undefined ? { maxAttempts: args.maxAttempts } : {}),
		});
		if (!decision.retry) return { scheduled: false, reason: decision.reason };
		const nextRetriesUsed = retriesUsed + 1;
		const notBefore = new Date(this.now() + decision.delayMs).toISOString();
		let suspended: AttemptRuntimeState;
		try {
			suspended = this.options.lifecycle.scheduleAgentRetry({
				laneId: args.laneId,
				agentId: args.agentId,
				ownerId: args.ownerId,
				reasonCode: `retry_scheduled:${decision.reason}`,
				retry: { retriesUsed: nextRetriesUsed, notBefore },
			});
		} catch (error) {
			this.options.warn(
				`Worker ${args.laneId} retry suspension failed; terminalizing instead: ${error instanceof Error ? error.message : String(error)}`,
			);
			return { scheduled: false, reason: "retry_suspension_failed" };
		}
		this.options.warn(
			`Worker ${args.laneId} failed (${decision.reason}); retrying from the persisted transcript in ${Math.ceil(decision.delayMs / 1000)}s (attempt ${nextRetriesUsed + 1}).`,
		);
		this.enqueueOrDeferRetry(record, suspended, args.request, args.request.verificationOfTaskId !== undefined);
		return { scheduled: true, record, retriesUsed: nextRetriesUsed, notBefore };
	}

	/** Cancel only process-local alarms; the retained deadline remains authoritative on disk. */
	dispose(): void {
		this.unsubscribeQueueCapacity?.();
		for (const entry of this.retryTimers.values()) {
			if (entry.timer) clearTimeout(entry.timer);
		}
		this.retryTimers.clear();
	}

	clearScheduledRetry(laneId: string): void {
		for (const [attemptId, entry] of this.retryTimers) {
			if (entry.laneId !== laneId) continue;
			if (entry.timer) clearTimeout(entry.timer);
			this.retryTimers.delete(attemptId);
		}
	}

	/** Keep an externally requested wake queued while the durable retry deadline is still retained. */
	deferRetryIfNeeded(record: LaneRecord, request: WorkerDelegationRequest): boolean {
		const attempt = this.options.lifecycle.getActiveAttempt(record.laneId);
		if (attempt?.status !== "suspended" || !attempt.retry || Date.parse(attempt.retry.notBefore) <= this.now()) {
			return false;
		}
		this.enqueueOrDeferRetry(record, attempt, request, request.verificationOfTaskId !== undefined);
		return true;
	}

	private enqueueOrDeferRetry(
		record: LaneRecord,
		attempt: AttemptRuntimeState,
		request: WorkerDelegationRequest,
		priority: boolean,
	): boolean {
		const retry = attempt.retry;
		if (!retry) {
			try {
				this.options.scheduler.enqueue(record, request, true, priority);
				return true;
			} catch (error) {
				if (error instanceof Error && error.message === "worker_dispatch_queue_full") return false;
				throw error;
			}
		}
		const existing = this.retryTimers.get(attempt.attemptId);
		if (existing?.notBefore === retry.notBefore) return true;
		if (existing?.timer) clearTimeout(existing.timer);
		const entry: PendingRetryDispatch = {
			laneId: record.laneId,
			notBefore: retry.notBefore,
			request,
			priority,
		};
		this.retryTimers.set(attempt.attemptId, entry);
		const remainingMs = Date.parse(retry.notBefore) - this.now();
		if (remainingMs <= 0) {
			this.tryEnqueueDueRetry(attempt.attemptId, entry);
			return true;
		}
		const timer = setTimeout(() => this.onRetryTimer(attempt.attemptId), Math.min(remainingMs, 2_147_000_000));
		if (typeof timer === "object" && "unref" in timer) timer.unref();
		entry.timer = timer;
		return true;
	}

	private onRetryTimer(attemptId: string): void {
		const entry = this.retryTimers.get(attemptId);
		if (!entry) return;
		delete entry.timer;
		this.tryEnqueueDueRetry(attemptId, entry);
	}

	private tryEnqueueDueRetry(attemptId: string, entry: PendingRetryDispatch): "enqueued" | "full" | "stale" {
		const attempt = this.options.lifecycle.getActiveAttempt(entry.laneId);
		if (
			!attempt ||
			attempt.attemptId !== attemptId ||
			attempt.status !== "suspended" ||
			attempt.retry?.notBefore !== entry.notBefore
		) {
			this.retryTimers.delete(attemptId);
			return "stale";
		}
		const record = this.options.lifecycle.getRecord(entry.laneId);
		if (!record) {
			this.retryTimers.delete(attemptId);
			return "stale";
		}
		const remainingMs = Date.parse(entry.notBefore) - this.now();
		if (remainingMs > 0) {
			const timer = setTimeout(() => this.onRetryTimer(attemptId), Math.min(remainingMs, 2_147_000_000));
			if (typeof timer === "object" && "unref" in timer) timer.unref();
			entry.timer = timer;
			return "stale";
		}
		try {
			this.options.scheduler.enqueue(record, entry.request, true, entry.priority);
		} catch (error) {
			if (error instanceof Error && error.message === "worker_dispatch_queue_full") return "full";
			this.options.warn(
				`Worker ${entry.laneId} retry enqueue failed; retaining the durable retry: ${error instanceof Error ? error.message : String(error)}`,
			);
			return "full";
		}
		this.retryTimers.delete(attemptId);
		this.options.retryReady?.();
		return "enqueued";
	}

	private flushDueRetries(): void {
		for (const [attemptId, entry] of this.retryTimers) {
			if (entry.timer || Date.parse(entry.notBefore) > this.now()) continue;
			if (this.tryEnqueueDueRetry(attemptId, entry) === "full") break;
		}
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	/** Rebuild task metadata from its durable dispatch; no current profile/model selection is consulted. */
	recoveredRequest(attempt: AttemptRuntimeState, verificationOfTaskId?: string): WorkerDelegationRequest {
		const task = this.options.lifecycle.getTask(attempt.taskId)?.task;
		const durableVerificationOfTaskId = verificationOfTaskId ?? task?.verificationOfTaskId;
		return {
			instructions: attempt.dispatch.instructions,
			profileId: attempt.dispatch.profileId,
			...(attempt.dispatch.parentAgentId ? { parentAgentId: attempt.dispatch.parentAgentId } : {}),
			...(durableVerificationOfTaskId ? { verificationOfTaskId: durableVerificationOfTaskId } : {}),
			...(task
				? {
						taskContext: {
							requirementIds: attempt.dispatch.requirementIds ?? [],
							dependsOnTaskIds: task.dependsOn,
							acceptanceCriterionIds: task.acceptanceCriterionIds,
							resourcePointerIds: attempt.dispatch.resourcePointerIds,
						},
					}
				: {}),
		};
	}

	/** Append deterministic unknown outcomes only for tool calls not durably followed by a result. */
	repairInterruptedToolResults(conversation: WorkerConversation): void {
		const messages = conversation.getProviderMessages();
		const completedToolCallIds = new Set<string>();
		let index = messages.length - 1;
		while (index >= 0 && messages[index]?.role === "toolResult") {
			completedToolCallIds.add((messages[index] as Extract<Message, { role: "toolResult" }>).toolCallId);
			index -= 1;
		}
		const assistant = messages[index];
		if (assistant?.role !== "assistant") return;
		for (const content of assistant.content) {
			if (content.type !== "toolCall" || completedToolCallIds.has(content.id)) continue;
			conversation.appendMessage({
				role: "toolResult",
				toolCallId: content.id,
				toolName: content.name,
				content: [
					{
						type: "text",
						text: "Execution outcome is unknown because this worker was interrupted before a durable tool result was recorded. Inspect the workspace and prior evidence before deciding whether to retry this operation.",
					},
				],
				isError: true,
				timestamp: Date.now(),
			});
		}
	}

	/** Return an already-persisted final assistant response so recovery cannot duplicate provider work. */
	recoveredTerminalCompletion(
		conversation: WorkerConversation,
		attemptId: string,
	): { text: string; usage: Usage; stopReason: string } | undefined {
		const last = conversation.getLastAttemptMessage(attemptId);
		if (last?.role !== "assistant" || last.stopReason === "error" || last.stopReason === "aborted") {
			return undefined;
		}
		if (last.content.some((content) => content.type === "toolCall")) return undefined;
		const text = last.content
			.filter(
				(content): content is Extract<(typeof last.content)[number], { type: "text" }> => content.type === "text",
			)
			.map((content) => content.text)
			.join("");
		return { text, usage: last.usage, stopReason: last.stopReason };
	}

	/** Legacy raw transcripts predate durable usage checkpoints; reconstruct their bounded cumulative baseline. */
	initialUsage(
		conversation: WorkerConversation,
		checkpointUsage: AttemptUsageSnapshot | undefined,
		attemptId: string,
	): AttemptUsageSnapshot {
		const transcriptUsage = conversation.getRawTranscriptUsage(attemptId);
		return checkpointUsage ? reconcileAttemptUsage(checkpointUsage, transcriptUsage) : transcriptUsage;
	}

	/** Fail closed when the current owner profile no longer permits a persisted grant. */
	durableGrantIsStillPermitted(
		grant: ExecutionGrant,
		plan: WorkerExecutionPlan,
		selectedResources: readonly ResourcePointer[],
	): boolean {
		const allowedTools = new Set(plan.toolManifests.map((manifest) => manifest.toolName));
		const allowedCapabilities = new Set(plan.requiredCapabilities);
		const scopesRemainPermitted = (granted: readonly string[], permitted: readonly string[]) =>
			granted.every((scope) => permitted.some((candidate) => isPathWithinScope(scope, candidate)));
		const liveDenialsRemainEnforced = plan.deniedPaths.every((denied) =>
			grant.deniedPaths.some((granted) => isPathWithinScope(denied, granted)),
		);
		const budgetRemainsPermitted = (Object.keys(plan.budget) as Array<keyof RiskBudget>).every((field) => {
			const current = plan.budget[field];
			const persisted = grant.budget[field];
			return current === undefined || (persisted !== undefined && persisted <= current);
		});
		const resourcesRemainPermitted =
			grant.resources.length === selectedResources.length &&
			grant.resources.every((granted, index) => {
				const selected = selectedResources[index];
				return (
					selected !== undefined &&
					granted.id === selected.id &&
					granted.kind === selected.kind &&
					granted.uri === selected.uri &&
					granted.readOnly === selected.readOnly &&
					typeof granted.digest === "string" &&
					(selected.digest === undefined || selected.digest === granted.digest) &&
					granted.metadata?.name === selected.metadata?.name
				);
			});
		return (
			grant.allowedTools.every((toolName) => allowedTools.has(toolName)) &&
			grant.capabilities.every((capability) => allowedCapabilities.has(capability)) &&
			resourcesRemainPermitted &&
			scopesRemainPermitted(grant.readPaths, plan.readPaths) &&
			scopesRemainPermitted(grant.writePaths, plan.writePaths) &&
			liveDenialsRemainEnforced &&
			budgetRemainsPermitted
		);
	}
}
