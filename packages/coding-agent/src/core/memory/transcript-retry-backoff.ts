/**
 * Retry bookkeeping of the transcript memory coordinator: the bounded backoff every failed write or receipt waits on,
 * the store work an unavailable write left undone, and the claims whose provider call was paid (their usage receipt is
 * owed until it is recorded). The delay formula is shared; the two ways a failure advances the backoff are named
 * apart, because they differ: a failed job save is its own attempt, while a failed round of deferred work or owed
 * receipts advances the backoff once, and only while no retry is armed.
 */

/** The first retry waits this long; each further failure doubles the wait. */
const RETRY_BASE_MS = 1_000;
/** No retry waits longer than this. */
const RETRY_MAX_MS = 60_000;

/** The wait after `failures` failures in a row: one second doubling to at most one minute. */
export function retryDelayMs(failures: number): number {
	return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (failures - 1));
}

/**
 * One bounded backoff: when the next retry is due (`at`, undefined while none is armed) and how many failures in a row
 * it answers (`failures`). The clock is the coordinator's.
 */
export class RetryBackoff {
	private dueAt: number | undefined;
	private count = 0;
	private readonly now: () => number;

	constructor(now: () => number) {
		this.now = now;
	}

	get at(): number | undefined {
		return this.dueAt;
	}

	get failures(): number {
		return this.count;
	}

	/** Every failure advances the backoff and arms the next retry. */
	fail(): void {
		this.count += 1;
		this.dueAt = this.now() + retryDelayMs(this.count);
	}

	/** One failed round advances the backoff once; a round that fails again while a retry is armed does not advance it. */
	failRound(): void {
		if (this.dueAt !== undefined) return;
		this.count += 1;
		this.dueAt = this.now() + retryDelayMs(this.count);
	}

	/** The armed retry is taken (it is due or superseded); the failure count stays. */
	disarm(): void {
		this.dueAt = undefined;
	}

	/** A round that finished without a failure starts the backoff again from its base. */
	clearFailures(): void {
		this.count = 0;
	}

	reset(): void {
		this.count = 0;
		this.dueAt = undefined;
	}
}

/**
 * Work a store write the store could not serve (its typed `unavailable`) left undone, tried again after the store
 * backoff: discovery as a whole, retention, anchoring of undated nodes, the reconciliation of sessions, the
 * republication of frontiers and the removal of forgotten sessions' derived data (their permanent marker is already
 * durable).
 */
export interface StoreRetryWork {
	discover: boolean;
	retention: boolean;
	anchors: boolean;
	sessions: Set<string>;
	frontiers: Set<string>;
	forgets: Set<string>;
}

/** The work a deferral adds to the pending set; every field is optional. */
export interface DeferredStoreWork {
	discover?: boolean;
	retention?: boolean;
	anchors?: boolean;
	sessions?: Iterable<string>;
	frontiers?: Iterable<string>;
	forgets?: Iterable<string>;
}

export function emptyStoreRetry(): StoreRetryWork {
	return {
		discover: false,
		retention: false,
		anchors: false,
		sessions: new Set(),
		frontiers: new Set(),
		forgets: new Set(),
	};
}

/** The store work awaiting its retry, and the backoff that paces it. */
export class StoreRetryState {
	private pending: StoreRetryWork = emptyStoreRetry();
	private readonly backoff: RetryBackoff;

	constructor(now: () => number) {
		this.backoff = new RetryBackoff(now);
	}

	get work(): Readonly<StoreRetryWork> {
		return this.pending;
	}

	get at(): number | undefined {
		return this.backoff.at;
	}

	get failures(): number {
		return this.backoff.failures;
	}

	/** Adds deferred work to the pending set and advances the backoff once for the round. */
	defer(work: DeferredStoreWork): void {
		if (work.discover) this.pending.discover = true;
		if (work.retention) this.pending.retention = true;
		if (work.anchors) this.pending.anchors = true;
		for (const sessionId of work.sessions ?? []) this.pending.sessions.add(sessionId);
		for (const sessionId of work.frontiers ?? []) this.pending.frontiers.add(sessionId);
		for (const sessionId of work.forgets ?? []) this.pending.forgets.add(sessionId);
		this.backoff.failRound();
	}

	/** The pending work is handed to a retry pass; a fresh set replaces it and the armed retry is taken. */
	take(): StoreRetryWork {
		const work = this.pending;
		this.pending = emptyStoreRetry();
		this.backoff.disarm();
		return work;
	}

	clearFailures(): void {
		this.backoff.clearFailures();
	}

	reset(): void {
		this.pending = emptyStoreRetry();
		this.backoff.reset();
	}
}

/** Owed usage receipts: when they are tried again, and the claims whose provider call was paid. */
export class ReceiptRetryState {
	private readonly backoff: RetryBackoff;
	/** Claims that reached the summarizer provider, until their outcome settles: only these spent their attempt on a call. */
	private readonly paid = new Set<number>();

	constructor(now: () => number) {
		this.backoff = new RetryBackoff(now);
	}

	get at(): number | undefined {
		return this.backoff.at;
	}

	/** One failed round of owed receipts: advances the backoff once while no retry is armed. */
	arm(): void {
		this.backoff.failRound();
	}

	disarm(): void {
		this.backoff.disarm();
	}

	clearFailures(): void {
		this.backoff.clearFailures();
	}

	markPaid(claimId: number): void {
		this.paid.add(claimId);
	}

	/** Whether the claim's provider call was paid; the claim is no longer tracked once taken. */
	takePaid(claimId: number): boolean {
		return this.paid.delete(claimId);
	}

	reset(): void {
		this.backoff.reset();
		this.paid.clear();
	}
}
