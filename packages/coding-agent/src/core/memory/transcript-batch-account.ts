/**
 * Batch and cause accounting of the transcript memory coordinator: the terminal batch being counted (its outcomes and
 * causes), the terminal events kept for status, the recent failures, the admission judgments and reuses, and the
 * internal-cause slots (the active fault and the newest event). Each count is written through a command of one of
 * these two objects, and the clock is read where the coordinator read it. What follows a closed batch (the record
 * handoff to the writer and the owner notice) stays with the coordinator.
 */

import type { TranscriptMemoryTerminalCause, TranscriptMemoryTerminalEvent } from "./transcript-memory-ports.ts";
import { bounded } from "./transcript-memory-reason-text.ts";
import type {
	TranscriptMemoryAdmissionStatus,
	TranscriptMemoryFailureRecord,
	TranscriptMemoryInternalCause,
} from "./transcript-memory-status.ts";
import type { TranscriptSummaryJob } from "./transcript-summary-scheduler.ts";

/** Status keeps this many terminal batches, the newest last. */
export const MAX_STATUS_BATCHES = 5;
const MAX_RECENT_FAILURES = 20;
const MAX_TERMINAL_CAUSES = 5;
const MAX_CAUSE_MESSAGE_CHARS = 300;

/** The job fields a batch count or failure record reads. */
export type JobSubject = Pick<TranscriptSummaryJob, "id" | "level" | "sessionId">;

/** The hold summary a closing batch's terminal event carries when work is still held. */
export type TerminalHolds = Pick<TranscriptMemoryTerminalEvent, "held" | "heldKind" | "heldReason" | "heldByKind">;

/** A batch whose terminal event is not yet written. */
export interface BatchState {
	id: number;
	startedAt: number;
	succeeded: number;
	failed: number;
	cancelled: number;
	stale: number;
	causes: TranscriptMemoryTerminalCause[];
}

/**
 * The batch being counted and the counts kept for status. Reads and writes of the clock happen where the coordinator
 * made them: a batch takes its start time only when it opens, a failure takes its time when it is recorded.
 */
export class BatchAccount {
	private open: BatchState | undefined;
	private counter = 0;
	private terminals: TranscriptMemoryTerminalEvent[] = [];
	private failures: TranscriptMemoryFailureRecord[] = [];
	private readonly judgmentCounts: TranscriptMemoryAdmissionStatus["judgments"] = {
		accepted: 0,
		rejected: 0,
		uncertain: 0,
		unavailable: 0,
	};
	/** Kept acceptances published again without a new judgment ({@link TranscriptMemoryAdmissionStatus.reused}). */
	private reuses = 0;
	private readonly now: () => number;

	constructor(now: () => number) {
		this.now = now;
	}

	/** The terminal events kept for status, oldest first. */
	get persistedBatches(): readonly TranscriptMemoryTerminalEvent[] {
		return this.terminals;
	}

	get recentFailures(): readonly TranscriptMemoryFailureRecord[] {
		return this.failures;
	}

	get judgments(): Readonly<TranscriptMemoryAdmissionStatus["judgments"]> {
		return this.judgmentCounts;
	}

	get reusedAdmissions(): number {
		return this.reuses;
	}

	isOpen(): boolean {
		return this.open !== undefined;
	}

	/** Opens a batch for work just enqueued; a batch already open is kept as it is. */
	noteEnqueued(): void {
		if (this.open) return;
		this.open = {
			id: ++this.counter,
			startedAt: this.now(),
			succeeded: 0,
			failed: 0,
			cancelled: 0,
			stale: 0,
			causes: [],
		};
	}

	countTerminal(
		kind: "succeeded" | "failed" | "cancelled" | "stale",
		job?: Pick<TranscriptSummaryJob, "id" | "level" | "sessionId">,
		reason?: string,
		message?: string,
	): void {
		const batch = this.open;
		if (!batch) return;
		batch[kind] += 1;
		if (kind === "failed" && job && batch.causes.length < MAX_TERMINAL_CAUSES) {
			batch.causes.push({
				jobId: job.id,
				level: job.level,
				sessionId: job.sessionId,
				reason: reason ?? "failed",
				message: bounded(message ?? "", MAX_CAUSE_MESSAGE_CHARS),
			});
		}
	}

	/** A fresh verdict is a judgment; a kept verdict applied again is a reuse event (only an acceptance counts as one), never a judgment. */
	countJudgment(disposition: keyof TranscriptMemoryAdmissionStatus["judgments"], replayed: boolean): void {
		if (!replayed) this.judgmentCounts[disposition] += 1;
		else if (disposition === "accepted") this.reuses += 1;
	}

	/** A kept admission record reused without a judgment call. */
	countReuse(): void {
		this.reuses += 1;
	}

	recordFailure(subject: JobSubject, reason: string, message: string): void {
		this.failures.push({
			jobId: subject.id,
			sessionId: subject.sessionId,
			level: subject.level,
			reason,
			message: bounded(message, MAX_CAUSE_MESSAGE_CHARS),
			at: this.now(),
		});
		if (this.failures.length > MAX_RECENT_FAILURES) this.failures.shift();
	}

	/**
	 * Closes the batch (the decision part of finishing it): the open batch, or a synthetic one when a stop has a reason
	 * but nothing was counted. Returns the terminal event, already kept for status, or undefined when there is nothing
	 * to close. `holds` is read only when there is a batch to close, at the point the event is built.
	 */
	close(
		outcome: "completed" | "stopped",
		interrupted: number,
		stopReason: string | undefined,
		holds: () => TerminalHolds | undefined,
	): TranscriptMemoryTerminalEvent | undefined {
		const batch =
			this.open ??
			(stopReason === undefined
				? undefined
				: {
						id: ++this.counter,
						startedAt: this.now(),
						succeeded: 0,
						failed: 0,
						cancelled: 0,
						stale: 0,
						causes: [],
					});
		if (!batch) return undefined;
		this.open = undefined;
		const held = holds();
		const event: TranscriptMemoryTerminalEvent = {
			batchId: batch.id,
			outcome,
			succeeded: batch.succeeded,
			failed: batch.failed,
			cancelled: batch.cancelled,
			stale: batch.stale,
			interrupted,
			startedAt: batch.startedAt,
			endedAt: this.now(),
			causes: batch.causes,
			...(held ?? {}),
			...(stopReason !== undefined ? { stopReason: bounded(stopReason, MAX_CAUSE_MESSAGE_CHARS) } : {}),
		};
		this.terminals.push(event);
		if (this.terminals.length > MAX_STATUS_BATCHES) this.terminals.shift();
		return event;
	}

	/** The terminal events a loaded store state carried, kept as the run's status history. */
	restoreTerminals(terminals: readonly TranscriptMemoryTerminalEvent[]): void {
		this.terminals = [...terminals];
	}

	/** The admission counts and reuses start again with a run. */
	resetAdmissionCounts(): void {
		this.judgmentCounts.accepted =
			this.judgmentCounts.rejected =
			this.judgmentCounts.uncertain =
			this.judgmentCounts.unavailable =
				0;
		this.reuses = 0;
	}
}

/**
 * The internal-cause slots: the active fault (the latest internal cause, the one a status shows as active) and the
 * newest event of any kind. Written only through {@link noteInternal} and {@link noteBenign}.
 */
export class CauseSlots {
	private activeCause: TranscriptMemoryInternalCause | undefined;
	private lastCause: TranscriptMemoryInternalCause | undefined;
	private readonly now: () => number;

	constructor(now: () => number) {
		this.now = now;
	}

	get active(): TranscriptMemoryInternalCause | undefined {
		return this.activeCause;
	}

	get last(): TranscriptMemoryInternalCause | undefined {
		return this.lastCause;
	}

	/** Records `cause` as the latest internal cause: it becomes both the active fault and the newest event. */
	noteInternal(cause: string): void {
		this.activeCause = { cause, at: new Date(this.now()).toISOString() };
		this.lastCause = this.activeCause;
	}

	/** Records a benign event (no fault): the newest-event slot shows it, the active fault cause is left as it was. */
	noteBenign(event: string): void {
		this.lastCause = { cause: event, at: new Date(this.now()).toISOString() };
	}
}
