/**
 * The one bounded-read owner for summary store reads: a ticketed single flight over ONE whole operation, with
 * every caller settled by its own deadline. The read-only view loads through it, and the running coordinator's
 * delivery fence reads its manifest through it.
 *
 * - `join` shares any flight running now (a read that has observed nothing yet may use any of them).
 * - `fence` must observe storage after the moment it was called: it never uses a flight that started before it,
 *   and waits for the ONE follow-up queued behind the running flight instead.
 * - Each caller waits only until its own `deadlineAt`, then gets a typed `unavailable` in the registry's timedOut
 *   wording; the race's timer is cleared when the caller settles. No caller deadline reaches the flight.
 * - The owner caches nothing. `work` receives the flight's start ticket (a later ticket observed storage at least as
 *   current), and adopting a result, or not, is the client's decision.
 *
 * Bound: one running plus one queued flight per client (one instance per client, dropped with it). A dropped client
 * leaves at most those two to settle, and nothing adopts their results. Work already started is not cancelled: a
 * file read in progress settles when the OS returns it.
 */

import type { TranscriptReadUnavailable } from "./transcript-memory-contracts.ts";

/** What a caller gets once its deadline passes first; timedOut wording, never a changed-in-flight one. */
const TIMED_OUT: TranscriptReadUnavailable = {
	status: "unavailable",
	reason: "the summary store read operation timed out before its deadline; exact history recall is unaffected",
};

type Settled<T> = T | TranscriptReadUnavailable;

/** `pending`, or the typed timeout once `deadlineAt` passes first; the timer is cleared either way. */
function withinDeadline<T>(pending: Promise<Settled<T>>, deadlineAt: number | undefined): Promise<Settled<T>> {
	if (deadlineAt === undefined) return pending;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<Settled<T>>((resolve) => {
		timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, deadlineAt - Date.now()));
		timer.unref();
	});
	return Promise.race([pending, timedOut]).finally(() => clearTimeout(timer));
}

export class TranscriptBoundedRead<T> {
	private readonly work: (ticket: number) => Promise<Settled<T>>;
	private tickets = 0;
	/** The one flight running now. */
	private flight: { ticket: number; done: Promise<Settled<T>> } | undefined;
	/** The one follow-up queued behind {@link flight} for fences that must not use it. */
	private followUp: Promise<Settled<T>> | undefined;

	constructor(work: (ticket: number) => Promise<Settled<T>>) {
		this.work = work;
	}

	/** Any running flight, else a new one; settled by `deadlineAt`. */
	join(deadlineAt?: number): Promise<Settled<T>> {
		return withinDeadline((this.flight ?? this.start()).done, deadlineAt);
	}

	/**
	 * A flight that starts after this call: a new one when nothing runs, else the one follow-up queued behind the
	 * running flight (it starts once that flight settles, however it settles). Settled by `deadlineAt`.
	 */
	fence(deadlineAt?: number): Promise<Settled<T>> {
		const running = this.flight;
		if (!running) return withinDeadline(this.start().done, deadlineAt);
		this.followUp ??= running.done.then(
			() => this.startFollowUp(),
			() => this.startFollowUp(),
		);
		return withinDeadline(this.followUp, deadlineAt);
	}

	private startFollowUp(): Promise<Settled<T>> {
		this.followUp = undefined;
		return (this.flight ?? this.start()).done;
	}

	private start(): { ticket: number; done: Promise<Settled<T>> } {
		const ticket = ++this.tickets;
		const done = this.work(ticket).finally(() => {
			if (this.flight?.ticket === ticket) this.flight = undefined;
		});
		this.flight = { ticket, done };
		return this.flight;
	}
}
