import { SYSTEM_TIMER_PORT, type TimerPort } from "./timer-port.ts";

/**
 * The one way a wait ends. Every wait reports exactly one of these to whoever waited, so a steer, an abort and an
 * expired bound can never read the same.
 *
 * - `satisfied`: a named wake source produced the awaited value.
 * - `timed_out`: a deadline-mode bound expired (never a watchdog: a watchdog never ends on time).
 * - `aborted`: the waiter's own signal aborted.
 * - `steered`: input the waiter must read arrived while it waited (the owner's steer for the root, the parent's halt
 *   for a worker); the awaited thing is still in flight.
 * - `disposed`: the owner of the awaited thing shut down.
 * - `unavailable`: the awaited thing can no longer happen.
 */
export type WaitEndReason =
	| { readonly kind: "satisfied"; readonly by: string }
	| { readonly kind: "timed_out"; readonly boundMs: number }
	| { readonly kind: "aborted"; readonly reason: unknown }
	| { readonly kind: "steered"; readonly by: string; readonly decision: SteerDecision }
	| { readonly kind: "disposed" }
	| { readonly kind: "unavailable"; readonly cause: string };

export type WaitEndKind = WaitEndReason["kind"];

/**
 * How the admission of the input that steered a wait settled before the wait returned: `decided` (admitted, held,
 * withdrawn or run as its own turn), `timed_out` (its reported decision deadline expired first), `aborted` (the
 * waiter aborted while it settled), or `none` (the steer source has no admission to settle).
 */
export type SteerDecision = "decided" | "timed_out" | "aborted" | "none";

/** What a wake source reads: the awaited value, or the proof it can no longer come. `undefined` means not yet. */
export type WakeCheck<T> =
	| { readonly kind: "satisfied"; readonly value: T }
	| { readonly kind: "unavailable"; readonly cause: string };

/** One named, event-driven source of the awaited thing. */
export interface WakeSource<T> {
	/** Stable name, e.g. `task.terminal`, reported in the status stream and in the `satisfied` end. */
	readonly id: string;
	/** Subscribed before the first check, so a change that lands between them is never lost. Returns the unsubscribe. */
	subscribe(onWake: () => void): () => void;
	/** Read after subscribing and again on every wake (of any source). A throw ends the wait by rejecting. */
	check(): WakeCheck<T> | undefined;
}

/** Input the waiter must read before it continues: the owner's steer (`owner.steer`) or the parent's halt (`parent.halt`). */
export interface SteerWake {
	readonly id: string;
	subscribe(onSteer: () => void): () => void;
	/** Input that already arrived and the waiter has not read yet: checked right after subscribing. */
	pending(): boolean;
	/** After a steer ends the wait: lets the input's admission settle, so the waiter's next boundary already reads it. */
	settle?(signal: AbortSignal | undefined): Promise<SteerDecision>;
}

/**
 * Whether a steer ends the wait. `exempt` is a reviewed declaration: its reason says why ending this wait early
 * cannot let the waiter read the steer any sooner (for example, the steer rides the very request being waited for).
 */
export type WaitSteer =
	| { readonly mode: "end"; readonly wake: SteerWake }
	| { readonly mode: "exempt"; readonly reason: string };

/**
 * The bound every wait has. `deadline` ends the wait `timed_out` at `ms`. `watchdog` never ends on time: it reports
 * `overdue` naming the holder every `overdueMs` and keeps waiting, for waits where giving up would strand work or let
 * two owners run at once.
 */
export type WaitBound =
	| { readonly kind: "deadline"; readonly ms: number }
	| { readonly kind: "watchdog"; readonly overdueMs: number; readonly holder: () => string };

/** The owner of the awaited thing going away. */
export interface DisposeSource {
	isDisposed(): boolean;
	subscribe(onDispose: () => void): () => void;
}

/** A wait end as the status stream carries it: an abort reason is reduced to its message. */
export type WaitEndReport =
	| Exclude<WaitEndReason, { readonly kind: "aborted" }>
	| { readonly kind: "aborted"; readonly reason: string };

/**
 * One wait's status, on the session event bus. Every `start` is followed by exactly one `end`; `progress` and
 * `overdue` come only between them. A wait that is settled by its first check emits nothing.
 */
export interface WaitStatusEvent {
	readonly type: "wait";
	readonly phase: "start" | "progress" | "overdue" | "end";
	readonly id: string;
	/** Unique to this wait within the process: concurrent waits with the same `id` are told apart by it. */
	readonly seq: number;
	readonly wake: readonly string[];
	/** The steer source id, or `exempt: <reason>`. */
	readonly steer: string;
	readonly bound: { readonly kind: "deadline" | "watchdog"; readonly ms: number };
	readonly elapsedMs: number;
	/** `overdue` only: who holds what the wait waits for. */
	readonly holder?: string;
	/** `progress` only. */
	readonly progress?: string;
	/** `end` only. */
	readonly end?: WaitEndReport;
}

export interface WaitStatusSpec {
	readonly id: string;
	readonly wake: readonly string[];
	readonly steer: WaitSteer;
	readonly bound: WaitBound;
	readonly report: ((event: WaitStatusEvent) => void) | undefined;
	readonly now?: () => number;
}

export interface WaitStatus {
	start(): void;
	progress(detail: string): void;
	overdue(holder: string): void;
	end(end: WaitEndReason): void;
}

/** The next wait's `seq`. */
let nextWaitSeq = 1;

/** A wait end as the status stream carries it (see `WaitEndReport`). */
export function waitEndReport(end: WaitEndReason): WaitEndReport {
	if (end.kind !== "aborted") return end;
	const reason = end.reason instanceof Error ? end.reason.message : end.reason === undefined ? "" : String(end.reason);
	return { kind: "aborted", reason };
}

/**
 * The status stream of one wait. `waitFor` drives it; a wait with its own mechanism (one that predates `waitFor`, or
 * lives where `waitFor` cannot reach) maps onto the same stream through it. `end` is reported once, and only after
 * `start`; everything after `end` is dropped.
 */
export function createWaitStatus(spec: WaitStatusSpec): WaitStatus {
	const now = spec.now ?? Date.now;
	let startedAt: number | undefined;
	let ended = false;
	const base = {
		type: "wait" as const,
		id: spec.id,
		seq: nextWaitSeq++,
		wake: spec.wake,
		steer: spec.steer.mode === "end" ? spec.steer.wake.id : `exempt: ${spec.steer.reason}`,
		bound:
			spec.bound.kind === "deadline"
				? { kind: "deadline" as const, ms: spec.bound.ms }
				: { kind: "watchdog" as const, ms: spec.bound.overdueMs },
	};
	const emit = (
		phase: WaitStatusEvent["phase"],
		extra: Pick<WaitStatusEvent, "holder" | "progress" | "end">,
	): void => {
		if (startedAt === undefined || ended) return;
		try {
			spec.report?.({ ...base, phase, elapsedMs: Math.max(0, now() - startedAt), ...extra });
		} catch (error) {
			// Status delivery observes a wait; it does not own its result. In particular, an end
			// observer must not strand a promise after its resource-valued wake has already won.
			// Surface the diagnostic failure independently instead of losing the semantic outcome.
			process.emitWarning(error instanceof Error ? error : "Wait status observer threw a non-Error value.", {
				code: "PI_WAIT_STATUS_OBSERVER_FAILED",
			});
		}
	};
	return {
		start: () => {
			if (startedAt !== undefined) return;
			startedAt = now();
			emit("start", {});
		},
		progress: (detail) => emit("progress", { progress: detail }),
		overdue: (holder) => emit("overdue", { holder }),
		end: (end) => {
			emit("end", { end: waitEndReport(end) });
			ended = true;
		},
	};
}

export interface WaitSpec<T> {
	/** Status/telemetry key, e.g. `tool_task.wait`. */
	readonly id: string;
	/** At least one named source of the awaited value. */
	readonly wake: readonly WakeSource<T>[];
	/** The waiter's own cancellation; `undefined` only where the waiter genuinely has none (it still has a bound). */
	readonly signal: AbortSignal | undefined;
	readonly steer: WaitSteer;
	readonly bound: WaitBound;
	readonly disposed?: DisposeSource;
	/** The bound's alarms and, unless `now` is given, the clock the status stream's elapsed time reads. */
	readonly clock?: TimerPort;
	readonly now?: () => number;
	readonly report?: (event: WaitStatusEvent) => void;
}

export interface WaitOutcome<T> {
	readonly end: WaitEndReason;
	/** Present exactly when `end.kind === "satisfied"`. */
	readonly value?: T;
}

/**
 * Waits for one of `wake` to produce its value. It subscribes to every source (wakes, steer, dispose, abort) first and
 * checks second, so nothing that happens between them is lost, and it ends with exactly one typed reason. A source's
 * `check` that throws rejects the wait, after everything is unsubscribed. The bound runs on `clock`, so a host can
 * drive it without the wall clock.
 */
export function waitFor<T>(spec: WaitSpec<T>): Promise<WaitOutcome<T>> {
	if (spec.wake.length === 0) return Promise.reject(new TypeError(`Wait ${spec.id} has no wake source.`));
	const boundMs = spec.bound.kind === "deadline" ? spec.bound.ms : spec.bound.overdueMs;
	if (!Number.isFinite(boundMs) || boundMs < 0) {
		return Promise.reject(new TypeError(`Wait ${spec.id} has an invalid bound: ${boundMs}.`));
	}
	const clock = spec.clock ?? SYSTEM_TIMER_PORT;
	const status = createWaitStatus({
		id: spec.id,
		wake: spec.wake.map((source) => source.id),
		steer: spec.steer,
		bound: spec.bound,
		report: spec.report,
		now: spec.now ?? (() => clock.now()),
	});
	return new Promise<WaitOutcome<T>>((resolve, reject) => {
		let settled = false;
		let timer: unknown;
		const unsubscribes: Array<() => void> = [];
		const cleanup = (): void => {
			if (timer !== undefined) clock.clearTimeout(timer);
			timer = undefined;
			spec.signal?.removeEventListener("abort", onAbort);
			for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
		};
		const finish = (outcome: WaitOutcome<T>): void => {
			if (settled) return;
			settled = true;
			cleanup();
			status.end(outcome.end);
			resolve(outcome);
		};
		const fail = (error: unknown): void => {
			if (settled) return;
			settled = true;
			cleanup();
			status.end({ kind: "unavailable", cause: error instanceof Error ? error.message : String(error) });
			reject(error);
		};
		const onAbort = (): void => finish({ end: { kind: "aborted", reason: spec.signal?.reason } });
		const onSteer = (): void => {
			if (settled || spec.steer.mode !== "end") return;
			const steer = spec.steer.wake;
			// Ended now: nothing else may settle it while the steer's admission settles.
			settled = true;
			cleanup();
			const settleSteer = steer.settle ? steer.settle(spec.signal) : Promise.resolve<SteerDecision>("none");
			settleSteer.then(
				(decision) => {
					const end: WaitEndReason = { kind: "steered", by: steer.id, decision };
					status.end(end);
					resolve({ end });
				},
				(error: unknown) => {
					status.end({ kind: "unavailable", cause: error instanceof Error ? error.message : String(error) });
					reject(error);
				},
			);
		};
		const check = (): void => {
			if (settled) return;
			for (const source of spec.wake) {
				let read: WakeCheck<T> | undefined;
				try {
					read = source.check();
				} catch (error) {
					fail(error);
					return;
				}
				if (read?.kind === "satisfied") {
					finish({ end: { kind: "satisfied", by: source.id }, value: read.value });
					return;
				}
				if (read?.kind === "unavailable") {
					finish({ end: { kind: "unavailable", cause: read.cause } });
					return;
				}
			}
		};
		const armBound = (): void => {
			if (spec.bound.kind === "deadline") {
				const ms = spec.bound.ms;
				timer = clock.setTimeout(() => {
					timer = undefined;
					// The last read wins over the bound: a value that arrived without a wake is still the answer.
					check();
					finish({ end: { kind: "timed_out", boundMs: ms } });
				}, ms);
				return;
			}
			const { overdueMs, holder } = spec.bound;
			const overdue = (): void => {
				timer = clock.setTimeout(() => {
					timer = undefined;
					if (settled) return;
					status.overdue(holder());
					overdue();
				}, overdueMs);
			};
			overdue();
		};
		// A source may call back while it subscribes: what subscribes after the wait ended is released at once.
		const hold = (unsubscribe: () => void): void => {
			if (settled) unsubscribe();
			else unsubscribes.push(unsubscribe);
		};
		// Subscribe everything first.
		for (const source of spec.wake) hold(source.subscribe(check));
		if (spec.steer.mode === "end") hold(spec.steer.wake.subscribe(onSteer));
		if (spec.disposed) hold(spec.disposed.subscribe(() => finish({ end: { kind: "disposed" } })));
		if (settled) return;
		spec.signal?.addEventListener("abort", onAbort, { once: true });
		// Then check, in precedence order: the awaited value, the waiter's own abort, its owner, pending steer input.
		check();
		if (settled) return;
		if (spec.signal?.aborted) {
			onAbort();
			return;
		}
		if (spec.disposed?.isDisposed()) {
			finish({ end: { kind: "disposed" } });
			return;
		}
		status.start();
		// A start listener may itself settle the wait (it can queue the very steer the wait ends on).
		if (settled) return;
		if (spec.steer.mode === "end" && spec.steer.wake.pending()) {
			onSteer();
			return;
		}
		armBound();
	});
}
