import type { Message } from "@caupulican/pi-ai";
import { Value } from "typebox/value";
import { executionContextScope } from "../../kernel/tool-invocation-binding.ts";
import { retainedToolInvocation } from "../../kernel/tool-invocation-receipt.ts";
import type { WorkerCommandReceipt } from "../autonomy/contracts.ts";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import { isPathWithinScope } from "../autonomy/path-scope.ts";
import { reconcileAttemptUsage } from "../orchestration/attempt-usage.ts";
import type { AttemptUsageSnapshot, ExecutionGrant, ResourcePointer, RiskBudget } from "../orchestration/contracts.ts";
import type { AttemptRuntimeState } from "../orchestration/task-runtime.ts";
import type { TimerPort } from "../util/timer-port.ts";
import type { RecoveredWorkerTerminalCompletion } from "./worker-attempt-executor.ts";
import type { WorkerConversation } from "./worker-conversation-store.ts";
import type { WorkerDelegationRequest } from "./worker-delegation-request.ts";
import type { WorkerDispatchScheduler } from "./worker-dispatch-scheduler.ts";
import type { WorkerExecutionPlan } from "./worker-execution-policy.ts";
import type { PendingVerificationRecovery, WorkerLifecycle } from "./worker-lifecycle.ts";
import { appendCommandReceipt, commandReceiptFor } from "./worker-receipts.ts";
import {
	SUBMIT_REPORT_TOOL_NAME,
	type SubmittedWorkerReport,
	submitReportParameters,
	submittedReportFromArguments,
} from "./worker-report.ts";
import { evaluateWorkerRetry } from "./worker-retry-policy.ts";

export type WorkerRecoveryDispatchResult = { started: true } | { started: false; skipReason: string };

export type WorkerRetryScheduleResult =
	/** The retry is durably retained; an unavailable process alarm is reported separately. */
	| { scheduled: true; record: LaneRecord; retriesUsed: number; notBefore: string }
	| { scheduled: false; reason: string };

interface PendingRetryDispatch {
	laneId: string;
	notBefore: string;
	request: WorkerDelegationRequest;
	priority: boolean;
	wakeAt: number;
	handling: boolean;
	alarm?: { timer?: unknown };
	/** Consecutive failed reads or enqueues of this due retry, for its backoff alarm. */
	failures?: number;
}

/** Backoff bounds for a due retry whose durable read or enqueue failed for a reason other than capacity. */
const RETRY_ENQUEUE_FAILURE_BASE_MS = 1_000;
const RETRY_ENQUEUE_FAILURE_MAX_MS = 30_000;

export interface WorkerRecoveryCoordinatorOptions {
	/**
	 * The session's `orchestration` port: the retry deadline is computed and rechecked on its clock and every retry
	 * alarm is armed on its timers. The lifecycle's task runtime reads the same clock when it checks the deadline again
	 * at resume.
	 */
	timers: TimerPort;
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
	/**
	 * Publish a rate limit or overload this worker's retry ladder is about to wait out, so sibling
	 * processes on the same account stop sending until the same reset (see provider-admission/).
	 */
	publishProviderLimit?(input: {
		provider: string;
		reason: "rate_limit" | "overloaded";
		delayMs: number;
		detail?: string;
	}): void;
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
	private disposed = false;
	private readonly verificationRecoveryFailures = new Map<string, string>();
	private readonly pendingRetries = new Map<string, PendingRetryDispatch>();
	private readonly unsubscribeQueueCapacity: (() => void) | undefined;

	constructor(options: WorkerRecoveryCoordinatorOptions) {
		this.options = options;
		this.unsubscribeQueueCapacity = options.scheduler.onQueueCapacityAvailable?.(() => {
			// Mandatory verifier dispatches remain derivable from durable subject state even after the
			// ordinary queue was fully recovered. Every released slot must replay that retained demand.
			this.recover();
		});
	}

	/** Idempotently rebuild in-process queues, terminal outboxes, and task-bearing mailboxes. */
	recover(): void {
		if (this.disposed || this.recoveringDurableState) return;
		this.recoveringDurableState = true;
		const { lifecycle } = this.options;
		try {
			this.flushDueRetries();
			if (this.disposed) return;
			if (!this.queueRecovered) {
				const newlySuspendedAttemptIds = new Set(lifecycle.suspendBoundInProcessAttemptsForRestart());
				if (this.disposed) return;
				try {
					this.options.recoverWriteReservations();
				} catch (error) {
					this.warnBestEffort(
						`Worker write reservation recovery failed closed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				if (this.disposed) return;
				const queued = lifecycle.recoverQueued();
				if (this.disposed) return;
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
					if (this.disposed) return;
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
						this.warnBestEffort(
							`Failed to recover queued worker ${record.laneId}; retaining durable dispatch: ${error instanceof Error ? error.message : String(error)}`,
						);
						continue;
					}
					if (retained) continue;
					recoveredAll = false;
					break;
				}
				if (this.disposed) return;
				this.queueRecovered = recoveredAll;
			}

			for (const recovery of lifecycle.getPendingVerificationRecoveries()) {
				if (this.disposed) return;
				if (recovery.action === "reconcile") {
					try {
						const record = lifecycle.reconcileVerification(recovery);
						if (this.disposed) return;
						this.options.publishTerminalRecord(record);
						if (this.disposed) return;
						this.verificationRecoveryFailures.delete(recovery.subjectTaskId);
					} catch (error) {
						this.warnBestEffort(
							`Failed to reconcile recovered verification for ${recovery.subjectTaskId}: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
					continue;
				}
				let started: WorkerRecoveryDispatchResult;
				try {
					started = this.options.dispatchVerification(recovery);
					if (this.disposed) return;
				} catch (error) {
					if (this.disposed) return;
					const reason = error instanceof Error ? error.message : String(error);
					const failureKey = `dispatch_threw:${reason}`;
					if (this.verificationRecoveryFailures.get(recovery.subjectTaskId) !== failureKey) {
						this.verificationRecoveryFailures.set(recovery.subjectTaskId, failureKey);
						this.warnBestEffort(
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
				this.warnBestEffort(
					`Recovered verification for ${recovery.subjectTaskId} did not start: ${started.skipReason}`,
				);
			}

			if (this.disposed) return;
			const terminalRecords = lifecycle
				.getPendingTerminalNotifications()
				.map((notification) => notification.record)
				// ManagedLaneController owns tmux projection and durable delivery; replaying it here
				// creates a second publisher every time unrelated foreground state triggers recovery.
				.filter((record) => record.type !== "tmux-worker");
			if (this.disposed) return;
			if (terminalRecords.length > 0) {
				if (this.options.publishTerminalRecords) this.options.publishTerminalRecords(terminalRecords);
				else {
					for (const record of terminalRecords) {
						if (this.disposed) return;
						this.options.publishTerminalRecord(record);
					}
				}
			}
			if (this.disposed) return;
			this.options.recoverSessionRootReplies();
			if (this.disposed) return;
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
		/** The attempt's contract has another usable candidate for a quota failure (see evaluateWorkerRetry). */
		failover?: boolean;
	}): WorkerRetryScheduleResult {
		if (this.disposed) return { scheduled: false, reason: "disposed" };
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
			...(args.failover ? { failover: true } : {}),
		});
		if (!decision.retry) return { scheduled: false, reason: decision.reason };
		if (decision.reason === "rate_limit" || decision.reason === "overloaded") {
			try {
				this.options.publishProviderLimit?.({
					provider: args.provider,
					reason: decision.reason,
					delayMs: decision.delayMs,
					...(args.outcome.reasonDetail ? { detail: args.outcome.reasonDetail } : {}),
				});
			} catch {
				// Shared-state bookkeeping must never fail the retry it observes.
			}
		}
		if (this.disposed) return { scheduled: false, reason: "disposed" };
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
			this.warnBestEffort(
				`Worker ${args.laneId} retry suspension failed; terminalizing instead: ${error instanceof Error ? error.message : String(error)}`,
			);
			return { scheduled: false, reason: "retry_suspension_failed" };
		}
		this.warnBestEffort(
			`Worker ${args.laneId} failed (${decision.reason}); retrying from the persisted transcript in ${Math.ceil(decision.delayMs / 1000)}s (attempt ${nextRetriesUsed + 1}).`,
		);
		this.enqueueOrDeferRetry(record, suspended, args.request, args.request.verificationOfTaskId !== undefined);
		return { scheduled: true, record, retriesUsed: nextRetriesUsed, notBefore };
	}

	/** Cancel only process-local alarms; the retained deadline remains authoritative on disk. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		const entries = [...this.pendingRetries.values()];
		this.pendingRetries.clear();
		for (const entry of entries) this.disarmRetry(entry);
		try {
			this.unsubscribeQueueCapacity?.();
		} catch (error) {
			this.warnBestEffort(
				`Worker recovery queue-capacity unsubscribe failed during disposal: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	clearScheduledRetry(attemptId: string): void {
		const entry = this.pendingRetries.get(attemptId);
		if (!entry) return;
		this.removeRetry(attemptId, entry);
	}

	/** Keep an externally requested wake queued while the durable retry deadline is still retained. */
	deferRetryIfNeeded(record: LaneRecord, request: WorkerDelegationRequest): boolean {
		if (this.disposed) return false;
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
		if (this.disposed) return false;
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
		const existing = this.pendingRetries.get(attempt.attemptId);
		let entry = existing;
		if (!entry || entry.notBefore !== retry.notBefore) {
			entry = {
				laneId: record.laneId,
				notBefore: retry.notBefore,
				request,
				priority,
				wakeAt: Date.parse(retry.notBefore),
				handling: false,
			};
			this.pendingRetries.set(attempt.attemptId, entry);
			if (existing) this.disarmRetry(existing);
		}
		this.tryEnqueueDueRetry(attempt.attemptId, entry);
		return true;
	}

	private armRetry(attemptId: string, entry: PendingRetryDispatch): void {
		if (this.disposed || this.pendingRetries.get(attemptId) !== entry || entry.alarm || entry.handling) return;
		const alarm: NonNullable<PendingRetryDispatch["alarm"]> = {};
		entry.alarm = alarm;
		try {
			const timer = this.options.timers.setTimeout(
				() => {
					if (this.disposed || this.pendingRetries.get(attemptId) !== entry || entry.alarm !== alarm) return;
					delete entry.alarm;
					this.tryEnqueueDueRetry(attemptId, entry);
				},
				Math.min(Math.max(0, entry.wakeAt - this.now()), 2_147_000_000),
			);
			if (!this.disposed && this.pendingRetries.get(attemptId) === entry && entry.alarm === alarm) {
				alarm.timer = timer;
			} else {
				this.clearRetryTimer(timer, entry.laneId);
			}
		} catch (error) {
			if (entry.alarm === alarm) delete entry.alarm;
			this.warnBestEffort(
				`Worker ${entry.laneId} retry alarm is unavailable; the durable retry remains pending until a recovery event or session restart: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private disarmRetry(entry: PendingRetryDispatch): void {
		const alarm = entry.alarm;
		delete entry.alarm;
		if (alarm) this.clearRetryTimer(alarm.timer, entry.laneId);
	}

	private clearRetryTimer(timer: unknown, laneId: string): void {
		try {
			this.options.timers.clearTimeout(timer);
		} catch (error) {
			this.warnBestEffort(
				`Worker ${laneId} retry alarm could not be cleared; its callback is inactive: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private removeRetry(attemptId: string, entry: PendingRetryDispatch): void {
		if (this.pendingRetries.get(attemptId) !== entry) return;
		this.pendingRetries.delete(attemptId);
		this.disarmRetry(entry);
	}

	/**
	 * A retained retry uses its deadline/backoff alarm or the queue-capacity event. Unavailable alarms
	 * retain the same wake deadline and are retried at the next explicit recovery boundary.
	 */
	private tryEnqueueDueRetry(
		attemptId: string,
		entry: PendingRetryDispatch,
	): "enqueued" | "full" | "stale" | "retained" {
		if (this.disposed || this.pendingRetries.get(attemptId) !== entry) return "stale";
		if (entry.handling || entry.alarm) return "retained";
		entry.handling = true;
		let needsAlarm = false;
		try {
			let attempt: AttemptRuntimeState | undefined;
			let record: LaneRecord | undefined;
			let now: number;
			try {
				attempt = this.options.lifecycle.getActiveAttempt(entry.laneId);
				record = attempt ? this.options.lifecycle.getRecord(entry.laneId) : undefined;
				now = this.now();
			} catch (error) {
				this.retainFailedRetry(attemptId, entry, "durable read", error);
				needsAlarm = true;
				return "retained";
			}
			if (this.disposed || this.pendingRetries.get(attemptId) !== entry) return "stale";
			if (
				!attempt ||
				attempt.attemptId !== attemptId ||
				attempt.status !== "suspended" ||
				attempt.retry?.notBefore !== entry.notBefore
			) {
				this.removeRetry(attemptId, entry);
				return "stale";
			}
			if (!record) {
				this.removeRetry(attemptId, entry);
				return "stale";
			}
			entry.wakeAt = Math.max(entry.wakeAt, Date.parse(entry.notBefore));
			if (entry.wakeAt > now) {
				needsAlarm = true;
				return "retained";
			}
			try {
				this.options.scheduler.enqueue(record, entry.request, true, entry.priority);
			} catch (error) {
				if (error instanceof Error && error.message === "worker_dispatch_queue_full") return "full";
				this.retainFailedRetry(attemptId, entry, "enqueue", error);
				needsAlarm = true;
				return "retained";
			}
			if (this.disposed || this.pendingRetries.get(attemptId) !== entry) return "stale";
			this.removeRetry(attemptId, entry);
			try {
				this.options.retryReady?.();
			} catch (error) {
				// The lane is queued; the wake may run on a timer, where a throw would escape uncaught.
				// The next scheduler signal drains it.
				this.warnBestEffort(
					`Worker ${entry.laneId} retry was queued, but its scheduler wake failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return "enqueued";
		} finally {
			entry.handling = false;
			if (needsAlarm) this.armRetry(attemptId, entry);
		}
	}

	/** Keep the due retry and arm a bounded backoff alarm: no capacity event is coming for this failure. */
	private retainFailedRetry(attemptId: string, entry: PendingRetryDispatch, step: string, error: unknown): void {
		if (this.disposed || this.pendingRetries.get(attemptId) !== entry) return;
		entry.failures = (entry.failures ?? 0) + 1;
		const delayMs = Math.min(
			RETRY_ENQUEUE_FAILURE_MAX_MS,
			RETRY_ENQUEUE_FAILURE_BASE_MS * 2 ** Math.min(entry.failures - 1, 16),
		);
		entry.wakeAt = this.now() + delayMs;
		this.warnBestEffort(
			`Worker ${entry.laneId} retry ${step} failed; retaining the durable retry with ${Math.ceil(delayMs / 1000)}s backoff: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	private flushDueRetries(): void {
		if (this.disposed) return;
		for (const [attemptId, entry] of [...this.pendingRetries]) {
			if (this.disposed) return;
			if (this.tryEnqueueDueRetry(attemptId, entry) === "full") break;
		}
	}

	private warnBestEffort(message: string): void {
		try {
			this.options.warn(message);
		} catch {
			// A diagnostic cannot revoke a committed retry or interrupt timer cleanup.
		}
	}

	private now(): number {
		return this.options.timers.now();
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
	): RecoveredWorkerTerminalCompletion | undefined {
		const transcript = conversation.getAttemptTranscript(attemptId);
		if (!transcript || transcript.attemptId !== attemptId) return undefined;
		const last = transcript.messages.at(-1)?.message;
		if (last?.role !== "assistant" || last.stopReason === "error" || last.stopReason === "aborted") {
			return undefined;
		}
		if (last.content.some((content) => content.type === "toolCall")) return undefined;
		const attempt = this.options.lifecycle.getTaskRuntimeSnapshot().attempts[attemptId];
		if (!attempt) return undefined;
		const context = attempt.dispatch.executionContract?.worker.executionContext;
		const scope = context
			? executionContextScope({
					...context,
					sessionId: conversation.getResumeContext().sessionId,
					taskId: attempt.taskId,
				})
			: undefined;
		const calls = new Map<string, { name: string; arguments: unknown; entryId: string }>();
		const results = new Set<string>();
		const blockers = new Set<string>();
		const commandReceipts: WorkerCommandReceipt[] = [];
		let submittedReport: SubmittedWorkerReport | undefined;
		for (const { entryId, message } of transcript.messages) {
			if (message.role === "assistant") {
				for (const content of message.content) {
					if (content.type !== "toolCall") continue;
					if (calls.has(content.id)) return undefined;
					calls.set(content.id, { name: content.name, arguments: content.arguments, entryId });
				}
			} else if (message.role === "toolResult") {
				const call = calls.get(message.toolCallId);
				if (!call || results.has(message.toolCallId) || call.name !== message.toolName) return undefined;
				const binding = transcript.toolResults.find((result) => result.resultMessageEntryId === entryId);
				const invocation = retainedToolInvocation(message.details);
				if (
					!binding?.requestId ||
					binding.assistantMessageEntryId !== call.entryId ||
					binding.callId !== message.toolCallId ||
					binding.toolName !== call.name ||
					!invocation ||
					invocation.requestId !== binding.requestId ||
					invocation.execution !== "completed" ||
					(invocation.executionScope !== undefined && invocation.executionScope !== scope)
				)
					return undefined;
				for (const failure of invocation.postprocessingFailures)
					blockers.add(`recovered tool ${failure} failure for provider request ${invocation.requestId}`);
				results.add(message.toolCallId);
				if (call.name === SUBMIT_REPORT_TOOL_NAME) {
					if (invocation.operationStatus !== "success") return undefined;
					if (!Value.Check(submitReportParameters, call.arguments)) return undefined;
					submittedReport = submittedReportFromArguments(call.arguments);
				}
				const receipt = commandReceiptFor({
					toolCallId: message.toolCallId,
					toolName: call.name,
					args: call.arguments,
					isError: message.isError || invocation.operationStatus === "error",
					result: message,
				});
				if (receipt) appendCommandReceipt(commandReceipts, receipt);
			}
		}
		if ([...calls.keys()].some((id) => !results.has(id))) return undefined;
		const text = last.content
			.filter(
				(content): content is Extract<(typeof last.content)[number], { type: "text" }> => content.type === "text",
			)
			.map((content) => content.text)
			.join("");
		return {
			attemptId,
			text,
			usage: last.usage,
			stopReason: last.stopReason,
			commandReceipts,
			blockers: [...blockers],
			...(submittedReport ? { submittedReport } : {}),
		};
	}

	/** Reconstruct legacy usage only before generation-attributed accounting becomes authoritative. */
	initialUsage(
		conversation: WorkerConversation,
		checkpointUsage: AttemptUsageSnapshot | undefined,
		attemptId: string,
	): AttemptUsageSnapshot {
		const accounting = this.options.lifecycle.getTaskRuntimeSnapshot().attempts[attemptId]?.usageAccounting;
		if (accounting) return structuredClone(accounting.total);
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
