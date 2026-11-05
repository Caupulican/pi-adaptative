import type { WorkerTerminalHandoffRecord } from "../delegation/worker-notification-coordinator.ts";
import type { WorkerReceiptOrigin } from "../orchestration/worker-receipt-origin.ts";
import { boundedRedactedDiagnosticText } from "../security/secret-text.ts";
import { boundedText } from "../util/bounded-line.ts";
import type { TimerPort } from "../util/timer-port.ts";
import {
	MAX_ROUTINE_OCCURRENCES,
	MAX_ROUTINE_SUMMARY_CHARS,
	nextRoutineAt,
	type RoutineDelivery,
	type RoutineOccurrence,
} from "./routine-contract.ts";
import type { RoutineStorePort } from "./routine-store-port.ts";
import type { RoutineWorkerExecutor, RoutineWorkerRequest, RoutineWorkerState } from "./routine-worker-executor.ts";

const CLAIM_LEASE_MS = 120_000;
const RETRY_DELAY_MS = 5_000;
const CLAIM_BATCH_SIZE = 8;

interface RoutineSchedulerDeps {
	readonly store: RoutineStorePort;
	readonly worker: RoutineWorkerExecutor;
	readonly timers: TimerPort;
	readonly parentSessionId: string;
	readonly owner: string;
	isDisposed(): boolean;
	canDispatch(): boolean;
	getReceiptOrigin(): WorkerReceiptOrigin;
	canUseOrigin(origin: WorkerReceiptOrigin): boolean;
	captureOriginGuard(origin: WorkerReceiptOrigin): () => void;
	subscribeContext(listener: () => void): () => void;
	subscribeExecution(listener: () => void): () => void;
	deliver(delivery: RoutineDelivery): Promise<{ entryId: string }>;
	/** Consume the native notification only after its parent input is physically durable. */
	acknowledgeWorkerNotification(occurrence: RoutineOccurrence): void;
	dispatchMessage(occurrence: RoutineOccurrence): Promise<string>;
	warn(message: string): void;
}

export interface RoutineTickResult {
	dispatched: string[];
	failed: string[];
}

/** One scheduling owner. Alarms discover due time; execution completion arrives from the task ledger. */
export class RoutineSchedulerController {
	private readonly deps: RoutineSchedulerDeps;
	private readonly abort = new AbortController();
	private readonly unsubscribe: readonly (() => void)[];
	private alarm: { handle?: unknown } | undefined;
	private pass: Promise<RoutineTickResult> | undefined;
	private scheduled = false;
	private dirty = false;
	private disposed = false;
	private started = false;
	private readonly deliveries = new Map<string, Promise<void>>();

	constructor(deps: RoutineSchedulerDeps) {
		this.deps = deps;
		this.unsubscribe = [
			deps.store.subscribe(() => this.wake()),
			deps.subscribeExecution(() => this.wake()),
			deps.subscribeContext(() => this.wake()),
		];
	}

	start(): void {
		if (this.disposed || this.started) return;
		this.started = true;
		this.wake();
	}

	wake(): void {
		if (!this.active) return;
		this.dirty = true;
		if (this.pass || this.scheduled) return;
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			if (this.active) void this.tick().catch(() => {});
		});
	}

	tick(): Promise<RoutineTickResult> {
		if (this.pass) return this.pass;
		if (!this.active) return Promise.resolve({ dispatched: [], failed: [] });
		this.clearAlarm();
		this.dirty = false;
		const pass = this.runPass();
		this.pass = pass;
		void pass.then(
			() => this.settled(pass),
			(error) => {
				this.warn(error);
				this.settled(pass, true);
			},
		);
		return pass;
	}

	run(routineId: string, expectedRevision: number | undefined, commandId: string): string {
		if (!this.active) throw new Error("Routine scheduler is disposed.");
		const definition = this.deps.store.getRoutine(routineId);
		if (definition?.executionSnapshot)
			this.deps.captureOriginGuard(definition.executionSnapshot.savedIntent.receiptOrigin)();
		const occurrence = this.deps.store.claimManualRoutineOccurrence({
			routineId,
			expectedRevision,
			commandId,
			parentSessionId: this.deps.parentSessionId,
			receiptOrigin: this.deps.getReceiptOrigin(),
			owner: this.deps.owner,
			nowMs: this.deps.timers.now(),
			leaseMs: CLAIM_LEASE_MS,
		});
		this.wake();
		return occurrence.occurrenceId;
	}

	/** Durable occurrence custody is independent of current branch or delivery eligibility. */
	ownsNotification(record: WorkerTerminalHandoffRecord): boolean {
		if (!record.attemptId) return false;
		for (const occurrence of this.occurrences()) {
			if (occurrence.target.kind !== "session" || !occurrence.dispatchKey) continue;
			if (this.deps.worker.notificationAttemptIds(this.request(occurrence)).has(record.attemptId)) {
				this.wake();
				return true;
			}
		}
		return false;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.abort.abort(new Error("Routine scheduler stopped; durable occurrences remain available for recovery."));
		this.clearAlarm();
		for (const unsubscribe of this.unsubscribe) {
			try {
				unsubscribe();
			} catch (error) {
				this.warn(error);
			}
		}
	}

	private get active(): boolean {
		return this.started && !this.disposed && !this.deps.isDisposed();
	}

	private occurrences(): readonly RoutineOccurrence[] {
		return this.deps.store.listRoutineOccurrences({
			parentSessionId: this.deps.parentSessionId,
			limit: MAX_ROUTINE_OCCURRENCES,
		});
	}

	private request(occurrence: RoutineOccurrence): RoutineWorkerRequest {
		const snapshot = occurrence.definition.executionSnapshot;
		if (!snapshot || !occurrence.dispatchKey) throw new Error("Routine occurrence has no saved execution identity.");
		return {
			intent: snapshot.savedIntent,
			instructions: occurrence.definition.prompt,
			dispatchKey: occurrence.dispatchKey,
		};
	}

	private assertClaim(occurrence: RoutineOccurrence): void {
		if (!this.active) throw new Error("Routine execution owner is no longer active.");
		this.deps.store.reload();
		const current = this.occurrences().find((entry) => entry.occurrenceId === occurrence.occurrenceId);
		if (
			!current?.claim ||
			current.claim.token !== occurrence.claim?.token ||
			current.claim.leaseUntil <= this.deps.timers.now() ||
			current.phase !== "dispatching"
		)
			throw new Error("Routine execution claim changed before worker admission.");
	}

	private async runPass(): Promise<RoutineTickResult> {
		const result: RoutineTickResult = { dispatched: [], failed: [] };
		this.deps.store.reload();
		for (const occurrence of this.occurrences()) {
			if (!this.active) return result;
			if (occurrence.phase === "dispatching" || occurrence.phase === "running" || occurrence.phase === "uncertain")
				this.reconcile(occurrence);
		}
		if (this.deps.canDispatch()) {
			const nowMs = this.deps.timers.now();
			const eligibleRoutineIds = this.deps.store
				.listRoutines()
				.filter(
					(routine) =>
						!routine.executionSnapshot ||
						this.deps.canUseOrigin(routine.executionSnapshot.savedIntent.receiptOrigin),
				)
				.map((routine) => routine.routineId);
			const recoverable = this.occurrences().filter(
				(entry) =>
					this.deps.canUseOrigin(entry.parentOrigin) &&
					(entry.phase === "pending" ||
						(entry.phase === "claimed" && entry.claim && entry.claim.leaseUntil <= nowMs)),
			);
			if (this.nextScheduledAt() <= nowMs || recoverable.length > 0)
				this.deps.store.claimDueRoutineOccurrences({
					nowMs,
					owner: this.deps.owner,
					leaseMs: CLAIM_LEASE_MS,
					limit: CLAIM_BATCH_SIZE,
					parentSessionId: this.deps.parentSessionId,
					eligibleRoutineIds,
					eligibleOccurrenceIds: recoverable.map((occurrence) => occurrence.occurrenceId),
					receiptOrigin: this.deps.getReceiptOrigin(),
				});
			for (const occurrence of this.occurrences()) {
				if (!this.active) return result;
				if (
					occurrence.phase !== "claimed" ||
					occurrence.claim?.owner !== this.deps.owner ||
					!this.deps.canUseOrigin(occurrence.parentOrigin)
				)
					continue;
				await this.dispatch(occurrence, result);
			}
		}
		this.deliverPending();
		return result;
	}

	private reconcile(occurrence: RoutineOccurrence): void {
		if (occurrence.target.kind === "session") {
			const execution = this.deps.worker.find(this.request(occurrence));
			if (execution) {
				this.recordExecution(occurrence, execution);
				return;
			}
		}
		if (
			occurrence.phase !== "uncertain" &&
			occurrence.claim &&
			occurrence.claim.leaseUntil <= this.deps.timers.now()
		) {
			this.deps.store.markRoutineUncertain({
				occurrenceId: occurrence.occurrenceId,
				claimToken: occurrence.claim.token,
				reason:
					"Dispatch was interrupted and no exact durable execution could be established; it was not repeated.",
				recipient: this.deps.parentSessionId,
				nowMs: this.deps.timers.now(),
			});
		}
	}

	private recordExecution(occurrence: RoutineOccurrence, execution: RoutineWorkerState): void {
		const claimToken = occurrence.claim?.token;
		if (!claimToken) throw new Error("Routine execution has no durable claim.");
		if (execution.record.status === "queued" || execution.record.status === "running") {
			if (occurrence.phase === "uncertain") return;
			if (occurrence.phase !== "running" || occurrence.executionRef?.attemptId !== execution.attemptId)
				this.deps.store.markRoutineRunning({
					occurrenceId: occurrence.occurrenceId,
					claimToken,
					dispatchKey: occurrence.dispatchKey!,
					executionRef: { taskId: execution.taskId, attemptId: execution.attemptId },
					nowMs: this.deps.timers.now(),
				});
			return;
		}
		const outcome = {
			occurrenceId: occurrence.occurrenceId,
			claimToken,
			outcome:
				execution.record.status === "succeeded"
					? ("succeeded" as const)
					: execution.record.status === "canceled"
						? ("cancelled" as const)
						: ("failed" as const),
			summary: boundedText(
				execution.result?.summary ??
					execution.record.reasonDetail ??
					execution.record.reasonCode ??
					execution.record.status,
				MAX_ROUTINE_SUMMARY_CHARS,
			),
			recipient: this.deps.parentSessionId,
			nowMs: this.deps.timers.now(),
		};
		if (occurrence.phase === "uncertain")
			this.deps.store.resolveUncertainRoutineOccurrence({
				...outcome,
				dispatchKey: occurrence.dispatchKey!,
				executionRef: { taskId: execution.taskId, attemptId: execution.attemptId },
			});
		else this.deps.store.finishRoutineOccurrence(outcome);
	}

	private async dispatch(claimed: RoutineOccurrence, result: RoutineTickResult): Promise<void> {
		const assertOrigin = this.deps.captureOriginGuard(claimed.parentOrigin);
		assertOrigin();
		const claimToken = claimed.claim!.token;
		const dispatchKey = `routine:${claimed.occurrenceId}`;
		this.deps.store.markRoutineDispatching({
			occurrenceId: claimed.occurrenceId,
			claimToken,
			dispatchKey,
			nowMs: this.deps.timers.now(),
		});
		const occurrence = { ...claimed, phase: "dispatching" as const, dispatchKey };
		try {
			if (occurrence.target.kind === "session") {
				const outcome = await this.deps.worker.start(
					this.request(occurrence),
					() => {
						assertOrigin();
						this.assertClaim(occurrence);
					},
					this.abort.signal,
				);
				if (!this.active) return;
				if (!outcome.started) {
					this.deps.store.finishRoutineOccurrence({
						occurrenceId: occurrence.occurrenceId,
						claimToken,
						outcome: "failed",
						summary: boundedText(outcome.skipReason, MAX_ROUTINE_SUMMARY_CHARS),
						recipient: this.deps.parentSessionId,
						nowMs: this.deps.timers.now(),
					});
					result.failed.push(`${occurrence.routineId}: ${outcome.skipReason}`);
					return;
				}
				this.recordExecution(occurrence, outcome.state);
			} else {
				const summary = await this.deps.dispatchMessage(occurrence);
				if (!this.active) return;
				this.deps.store.finishRoutineOccurrence({
					occurrenceId: occurrence.occurrenceId,
					claimToken,
					outcome: "succeeded",
					summary: boundedText(summary, MAX_ROUTINE_SUMMARY_CHARS),
					recipient: this.deps.parentSessionId,
					nowMs: this.deps.timers.now(),
				});
			}
			result.dispatched.push(occurrence.routineId);
		} catch (error) {
			if (!this.active) return;
			const detail = boundedText(
				boundedRedactedDiagnosticText(error instanceof Error ? error.message : String(error)) ??
					"Routine dispatch failed.",
				MAX_ROUTINE_SUMMARY_CHARS,
			);
			this.deps.store.markRoutineUncertain({
				occurrenceId: occurrence.occurrenceId,
				claimToken,
				reason: detail,
				recipient: this.deps.parentSessionId,
				nowMs: this.deps.timers.now(),
			});
			result.failed.push(`${occurrence.routineId}: ${detail}`);
		}
	}

	private deliverPending(): void {
		if (!this.active || this.deliveries.size > 0) return;
		const pending = this.deps.store
			.listPendingRoutineDeliveries(this.deps.parentSessionId, 2 * MAX_ROUTINE_OCCURRENCES)
			.find((entry) => this.deps.canUseOrigin(entry.occurrence.parentOrigin));
		if (!pending) return;
		const { occurrence, result } = pending;
		const delivery = Promise.resolve()
			.then(() => this.deps.deliver(pending))
			.then((receipt) => {
				if (!this.active) return;
				if (result.outcome !== "uncertain") this.deps.acknowledgeWorkerNotification(occurrence);
				this.deps.store.acknowledgeRoutineDelivery({
					occurrenceId: occurrence.occurrenceId,
					recipient: result.recipient,
					resultDigest: result.digest,
					deliveryMarker: receipt.entryId,
					nowMs: this.deps.timers.now(),
				});
			});
		this.deliveries.set(occurrence.occurrenceId, delivery);
		void delivery.then(
			() => {
				this.deliveries.delete(occurrence.occurrenceId);
				this.wake();
			},
			(error) => {
				this.deliveries.delete(occurrence.occurrenceId);
				this.warn(error);
				this.arm(RETRY_DELAY_MS);
			},
		);
	}

	private settled(pass: Promise<RoutineTickResult>, retry = false): void {
		if (this.pass !== pass) return;
		this.pass = undefined;
		if (!this.active) return;
		if (retry) {
			this.arm(RETRY_DELAY_MS);
			return;
		}
		if (this.dirty) {
			this.wake();
			return;
		}
		try {
			let next = this.nextScheduledAt();
			for (const occurrence of this.occurrences())
				if (
					occurrence.claim &&
					(occurrence.phase === "dispatching" ||
						(occurrence.phase === "claimed" && this.deps.canUseOrigin(occurrence.parentOrigin)))
				)
					next = Math.min(next, occurrence.claim.leaseUntil);
			if (Number.isFinite(next)) this.arm(Math.max(RETRY_DELAY_MS, next - this.deps.timers.now()));
		} catch (error) {
			this.warn(error);
			this.arm(RETRY_DELAY_MS);
		}
	}

	private nextScheduledAt(): number {
		let next = Number.POSITIVE_INFINITY;
		for (const routine of this.deps.store.listRoutines()) {
			if (
				!routine.enabled ||
				(routine.executionSnapshot &&
					!this.deps.canUseOrigin(routine.executionSnapshot.savedIntent.receiptOrigin)) ||
				(routine.target.kind === "session" && routine.target.parentSessionId !== this.deps.parentSessionId)
			)
				continue;
			const due = nextRoutineAt(routine.schedule, routine.cursor);
			if (due !== undefined) next = Math.min(next, due);
		}
		return next;
	}

	private clearAlarm(): void {
		const alarm = this.alarm;
		this.alarm = undefined;
		if (alarm) {
			try {
				this.deps.timers.clearTimeout(alarm.handle);
			} catch (error) {
				this.warn(error);
			}
		}
	}

	private arm(delayMs: number): void {
		if (!this.active) return;
		this.clearAlarm();
		const alarm: { handle?: unknown } = {};
		this.alarm = alarm;
		try {
			const handle = this.deps.timers.setTimeout(
				() => {
					if (this.alarm === alarm) {
						this.alarm = undefined;
						this.wake();
					}
				},
				Math.min(delayMs, 2_147_000_000),
			);
			if (this.alarm === alarm && this.active) alarm.handle = handle;
			else this.deps.timers.clearTimeout(handle);
		} catch (error) {
			if (this.alarm === alarm) this.alarm = undefined;
			this.warn(error);
		}
	}

	private warn(error: unknown): void {
		try {
			const detail = boundedRedactedDiagnosticText(error instanceof Error ? error.message : String(error));
			this.deps.warn(`Routine scheduler: ${detail ?? "operation unavailable"}`);
		} catch {
			/* Diagnostics retain no delivery authority. */
		}
	}
}
