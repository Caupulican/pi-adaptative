/**
 * Every release has exactly one outcome. `released` and `superseded` end the resource here. `retained` keeps the exact
 * resource with a named retry owner, which retries it on a capped exponential backoff alarm on an injectable
 * {@link TimerPort}, on its dependents' signals, and once more on shutdown, and wakes its dependents when the resource is
 * finally released. `abandoned` names the reaper that will take the resource over (a dead-owner reaper, the next owner's
 * recovery). Nothing is caught and forgotten.
 *
 * {@link RetainedReleases} is the synchronous retry owner, {@link AsyncRetainedReleases} the one whose release is a
 * promise; both share the backoff and the entry bookkeeping.
 */

import { SYSTEM_TIMER_PORT, type TimerPort } from "./timer-port.ts";

export type ReleaseOutcome =
	| { readonly kind: "released" }
	/** Another fence, generation or owner holds the resource now: nothing was mutated and nothing is retried. */
	| { readonly kind: "superseded"; readonly detail: string }
	| { readonly kind: "retained"; readonly cause: string; readonly retryOwner: string }
	| { readonly kind: "abandoned"; readonly cause: string; readonly reaper: string };

/**
 * What one release attempt that did not throw found: the resource is released, another holder supersedes it, or no
 * retry can release it and the named reaper takes it over. Each one ends the retry.
 */
export type ReleaseAttemptResult =
	| "released"
	| { readonly superseded: string }
	| { readonly abandoned: string; readonly reaper: string };

/** A resource its owner could not release yet. */
export interface RetainedRelease<T> {
	readonly key: string;
	readonly value: T;
	/** The latest failure, as a message. */
	readonly cause: string;
	/** Failed attempts, the first one (the release that retained it) included. */
	readonly failures: number;
}

/** A retained resource that a retry settled, and how. */
export interface SettledRelease<T> {
	readonly entry: RetainedRelease<T>;
	readonly outcome: Exclude<ReleaseOutcome, { kind: "retained" }>;
}

export interface RetainedReleaseSnapshot {
	readonly retryOwner: string;
	readonly retained: readonly { readonly key: string; readonly cause: string; readonly failures: number }[];
	/** Delay of the armed backoff alarm; absent when none is armed. */
	readonly armedDelayMs?: number;
}

export interface RetainedReleaseRetryOptions<T> {
	/** Report every failure of this pass through `reportFailure`. Opportunistic passes on dependents' signals do not. */
	readonly report: boolean;
	/** Retry only the matching entries. A filtered pass never resets the backoff. */
	readonly filter?: (value: T, key: string) => boolean;
	/** The final pass before shutdown: nothing retries after it. */
	readonly lastChance?: boolean;
}

interface RetainedReleaseOptionsBase<T> {
	/** Names the retry owner in outcomes, snapshots and diagnostics. */
	readonly retryOwner: string;
	/** The backoff alarm's timers; absent means {@link SYSTEM_TIMER_PORT}. */
	readonly timers?: TimerPort;
	/** First backoff delay; every failed pass doubles it. Default 1 s. */
	readonly baseDelayMs?: number;
	/** Backoff cap. Default 30 s. */
	readonly maxDelayMs?: number;
	/** A failure of a reporting pass (the alarm's, or one the owner asked to report). */
	readonly reportFailure?: (entry: RetainedRelease<T>, error: unknown) => void;
	/** A dependent's wake listener threw; the release it was told about still stands. */
	readonly reportListenerFailure?: (error: unknown) => void;
}

export interface RetainedReleasesOptions<T> extends RetainedReleaseOptionsBase<T> {
	/** Releases one retained resource. Throws when it is still unreleasable; returning nothing means released. */
	readonly release: (
		value: T,
		context: { readonly key: string; readonly lastChance: boolean },
	) => ReleaseAttemptResult | undefined;
}

export interface AsyncRetainedReleasesOptions<T> extends RetainedReleaseOptionsBase<T> {
	/** Releases one retained resource. Rejects when it is still unreleasable; resolving to nothing means released. */
	readonly release: (
		value: T,
		context: { readonly key: string; readonly lastChance: boolean },
	) => Promise<ReleaseAttemptResult | undefined>;
}

const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;

interface MutableEntry<T> {
	readonly key: string;
	readonly value: T;
	cause: string;
	failures: number;
}

/** A failure as the message an outcome and a snapshot carry. */
export function releaseFailureCause(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function settledOutcome(result: ReleaseAttemptResult | undefined): SettledRelease<unknown>["outcome"] {
	if (result === undefined || result === "released") return { kind: "released" };
	if ("superseded" in result) return { kind: "superseded", detail: result.superseded };
	return { kind: "abandoned", cause: result.abandoned, reaper: result.reaper };
}

/**
 * The bookkeeping both retry owners share. The backoff counts failed passes, not failed entries: a set that starts from
 * empty starts at the base delay, a pass over every entry with no failure resets it, and a filtered pass only ever
 * raises it. At most one alarm is armed; it is never armed after `close()`.
 */
interface ReleasePass<T> {
	readonly entries: MutableEntry<T>[];
	context(entry: MutableEntry<T>): { key: string; lastChance: boolean };
	settle(entry: MutableEntry<T>, result: ReleaseAttemptResult | undefined): void;
	fail(entry: MutableEntry<T>, error: unknown): void;
	end(): unknown[];
}

abstract class RetainedReleaseSet<T> {
	protected readonly entries = new Map<string, MutableEntry<T>>();
	protected readonly base: RetainedReleaseOptionsBase<T>;
	private readonly timers: TimerPort;
	private readonly baseDelayMs: number;
	private readonly maxDelayMs: number;
	private readonly listeners = new Set<(settled: readonly SettledRelease<T>[]) => void>();
	/** The armed alarm's handle, opaque here: only `undefined` means no alarm is armed. */
	private timer: unknown;
	private timerDelayMs: number | undefined;
	private failedPasses = 0;
	private isClosed = false;

	protected constructor(options: RetainedReleaseOptionsBase<T>) {
		this.base = options;
		this.timers = options.timers ?? SYSTEM_TIMER_PORT;
		this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
		this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
	}

	get retryOwner(): string {
		return this.base.retryOwner;
	}

	get size(): number {
		return this.entries.size;
	}

	/** True once `close()` ran: entries may remain, but no alarm is armed for them any more. */
	get closed(): boolean {
		return this.isClosed;
	}

	has(key: string): boolean {
		return this.entries.has(key);
	}

	get(key: string): RetainedRelease<T> | undefined {
		const entry = this.entries.get(key);
		return entry === undefined ? undefined : { ...entry };
	}

	keys(): string[] {
		return [...this.entries.keys()];
	}

	values(): T[] {
		return [...this.entries.values()].map((entry) => entry.value);
	}

	entriesSnapshot(): RetainedRelease<T>[] {
		return [...this.entries.values()].map((entry) => ({ ...entry }));
	}

	/**
	 * Keeps a resource whose release failed with `error` and arms the backoff alarm. Retaining a key again replaces its
	 * value and counts one more failure.
	 */
	retain(key: string, value: T, error: unknown): Extract<ReleaseOutcome, { kind: "retained" }> {
		if (this.entries.size === 0) this.failedPasses = 0;
		const previous = this.entries.get(key);
		const cause = releaseFailureCause(error);
		this.entries.set(key, { key, value, cause, failures: (previous?.failures ?? 0) + 1 });
		this.arm();
		return { kind: "retained", cause, retryOwner: this.base.retryOwner };
	}

	/** The owner took the resource back (re-adoption) or another path released it: nothing retries it any more. */
	delete(key: string): boolean {
		const deleted = this.entries.delete(key);
		if (deleted && this.entries.size === 0) this.disarm();
		return deleted;
	}

	/** Wakes `listener` after every retry pass that settled at least one entry. */
	subscribe(listener: (settled: readonly SettledRelease<T>[]) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	snapshot(): RetainedReleaseSnapshot {
		return {
			retryOwner: this.base.retryOwner,
			retained: [...this.entries.values()].map(({ key, cause, failures }) => ({ key, cause, failures })),
			...(this.timer !== undefined && this.timerDelayMs !== undefined ? { armedDelayMs: this.timerDelayMs } : {}),
		};
	}

	/** Disarms the alarm for good. Entries stay, so a last-chance pass and the owner's report can still see them. */
	close(): void {
		this.isClosed = true;
		this.disarm();
	}

	protected abstract scheduledRetry(): void;

	/** One pass over the (matching) entries, captured before it starts; `end()` settles the bookkeeping and wakes listeners. */
	protected beginPass(options: RetainedReleaseRetryOptions<T>): ReleasePass<T> {
		const errors: unknown[] = [];
		const settled: SettledRelease<T>[] = [];
		const entries =
			this.entries.size === 0
				? []
				: [...this.entries.values()].filter(
						(entry) => options.filter === undefined || options.filter(entry.value, entry.key),
					);
		let failed = false;
		return {
			entries,
			context: (entry) => ({ key: entry.key, lastChance: options.lastChance === true }),
			// One attempted entry released or superseded; an entry replaced or deleted meanwhile is not this attempt's to settle.
			settle: (entry, result) => {
				if (this.entries.get(entry.key) !== entry) return;
				this.entries.delete(entry.key);
				settled.push({ entry: { ...entry }, outcome: settledOutcome(result) });
			},
			fail: (entry, error) => {
				failed = true;
				errors.push(error);
				if (this.entries.get(entry.key) === entry) {
					entry.cause = releaseFailureCause(error);
					entry.failures += 1;
				}
				if (!options.report) return;
				try {
					this.base.reportFailure?.({ ...entry }, error);
				} catch (reportError) {
					this.reportListener(reportError);
				}
			},
			end: () => {
				if (this.entries.size === 0 && errors.length === 0 && settled.length === 0) return errors;
				this.finishPass(failed, options.filter !== undefined, settled);
				return errors;
			},
		};
	}

	private finishPass(failed: boolean, filtered: boolean, settled: readonly SettledRelease<T>[]): void {
		if (failed) this.failedPasses += 1;
		else if (!filtered) this.failedPasses = 0;
		if (this.entries.size === 0) this.disarm();
		this.arm();
		if (settled.length === 0) return;
		for (const listener of [...this.listeners]) {
			try {
				listener(settled);
			} catch (error) {
				this.reportListener(error);
			}
		}
	}

	private reportListener(error: unknown): void {
		try {
			this.base.reportListenerFailure?.(error);
		} catch {
			// The release already stands; a failing diagnostic sink cannot undo or repeat it.
		}
	}

	private arm(): void {
		if (this.isClosed || this.timer !== undefined || this.entries.size === 0) return;
		const delayMs = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.min(this.failedPasses, 16));
		this.timerDelayMs = delayMs;
		this.timer = this.timers.setTimeout(() => {
			this.timer = undefined;
			this.timerDelayMs = undefined;
			this.scheduledRetry();
		}, delayMs);
	}

	private disarm(): void {
		if (this.timer === undefined) return;
		this.timers.clearTimeout(this.timer);
		this.timer = undefined;
		this.timerDelayMs = undefined;
	}
}

/** A retry owner whose release is synchronous: a pass runs to its end before `retry` returns. */
export class RetainedReleases<T> extends RetainedReleaseSet<T> {
	private readonly release: RetainedReleasesOptions<T>["release"];

	constructor(options: RetainedReleasesOptions<T>) {
		super(options);
		this.release = options.release;
	}

	/** Attempts every (matching) entry once and returns the failures; a failure keeps its entry and its alarm. */
	retry(options: RetainedReleaseRetryOptions<T>): unknown[] {
		const pass = this.beginPass(options);
		for (const entry of pass.entries) {
			try {
				pass.settle(entry, this.release(entry.value, pass.context(entry)));
			} catch (error) {
				pass.fail(entry, error);
			}
		}
		return pass.end();
	}

	protected scheduledRetry(): void {
		this.retry({ report: true });
	}
}

/**
 * A retry owner whose release is a promise. Passes run one at a time in request order, so two passes never attempt
 * the same entry at once; `retry` never rejects.
 */
export class AsyncRetainedReleases<T> extends RetainedReleaseSet<T> {
	private readonly release: AsyncRetainedReleasesOptions<T>["release"];
	private tail: Promise<unknown> = Promise.resolve();

	constructor(options: AsyncRetainedReleasesOptions<T>) {
		super(options);
		this.release = options.release;
	}

	retry(options: RetainedReleaseRetryOptions<T>): Promise<unknown[]> {
		const pass = this.tail.then(() => this.pass(options));
		this.tail = pass;
		return pass;
	}

	/** Resolves once every pass requested so far has ended. */
	settled(): Promise<void> {
		return this.tail.then(() => undefined);
	}

	protected scheduledRetry(): void {
		void this.retry({ report: true });
	}

	private async pass(options: RetainedReleaseRetryOptions<T>): Promise<unknown[]> {
		const pass = this.beginPass(options);
		for (const entry of pass.entries) {
			try {
				pass.settle(entry, await this.release(entry.value, pass.context(entry)));
			} catch (error) {
				pass.fail(entry, error);
			}
		}
		return pass.end();
	}
}

/**
 * Run every release step of a `finally`, whatever an earlier one threw, and throw their failures together after the
 * last one. `primary` is the failure of the work the `finally` closes, when it failed: it is thrown with them rather
 * than replaced by them.
 */
export function runReleaseSteps(
	steps: readonly (() => void)[],
	message: string,
	primary?: { readonly error: unknown },
): void {
	const failures: unknown[] = [];
	for (const step of steps) {
		try {
			step();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length === 0) return;
	const all = primary === undefined ? failures : [primary.error, ...failures];
	throw all.length === 1 ? all[0] : new AggregateError(all, message);
}
