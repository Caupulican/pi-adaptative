/**
 * A session's own watches: what the session or one of its worker runtimes arms to wait on a file, a process, a port, a
 * command or a page at no model cost, and how each one reaches its armer when it fires, reaches its end time, or keeps
 * failing. The records live in the session's watch ledger (`session-watch-ledger.ts`); a routine watch monitor samples
 * them through {@link WatchObservationStore} with the same samplers and edge rule as a routine watch
 * (`routine-watch-edge.ts`), so this service decides nothing about an observation but records it.
 *
 * A watch is one-shot and ends within {@link MAX_AGENT_WATCH_HORIZON_MS}; a session holds at most
 * {@link MAX_AGENT_ARMED_WATCHES} watches armed by its model (routine watches an earlier build armed without the owner's words
 * count too), a worker runtime at most {@link MAX_WORKER_ARMED_WATCHES}. Those numbers are the only bound: no turn's origin
 * refuses an arming. Who armed a watch is a code fact stamped on it (the turn's authority, or the worker), and decides only
 * whether its plan reads as the armer's own words or as data when it wakes.
 *
 * A wake goes to the session as a `routine-completion` parent input in steer mode, with the same details a routine watch's
 * wake carries (`routineId` holding the watch's id), so every reader of a session's transcript, older builds included,
 * reads it as a watch wake; a worker's wake goes to its runtime and reaches the session instead once the runtime has not
 * taken it for {@link WORKER_WAKE_RETRY_MS}. A wake is marked delivered only after its delivery returned, and its id and
 * words derive from the record alone, so a redelivery after a restart is the same input.
 */
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readAgentToolPolicyDeniedError } from "../../kernel/index.ts";
import { interfaceText } from "../language/interface-text.ts";
import {
	MAX_AGENT_ARMED_WATCHES,
	MAX_AGENT_WATCH_HORIZON_MS,
	MAX_WORKER_ARMED_WATCHES,
} from "../routines/routine-watch-arming.ts";
import {
	decideWatchObservation,
	type RoutineWatchObservationInput,
	type RoutineWatchOutcome,
	watchLastSeen,
} from "../routines/routine-watch-edge.ts";
import type { ObservedWatch, WatchFailing, WatchObservationStore } from "../routines/routine-watch-monitor.ts";
import {
	type WatchWakePlan,
	watchFailingWakeText,
	watchFiredWakeText,
	watchTimedOutWakeText,
} from "../routines/routine-watch-wake.ts";
import {
	WORKER_WAKE_PLAN_CHARS,
	WORKER_WAKE_RETRY_MS,
	type WorkerWake,
	workerUnreachableLine,
} from "../routines/routine-worker-wake.ts";
import { admitWatchCheck, type WatchCheckAdmitter } from "../routines/watch-check-admission.ts";
import { type WatchCondition, watchFiredLine } from "../routines/watch-contract.ts";
import { watchCheckRefusal } from "../routines/worker-watch-scope.ts";
import { boundedRedactedDiagnosticText } from "../security/secret-text.ts";
import { type TurnAuthority, turnAuthorityCovers } from "../turn-origin.ts";
import { OWNER_STOP_CLOCK, type TimerPort } from "../util/timer-port.ts";
import {
	isLiveSessionWatch,
	parseSessionWatchRecord,
	type SessionWatchArmer,
	type SessionWatchLedger,
	type SessionWatchRecord,
	type SessionWatchStatus,
	type SessionWatchWake,
	type SessionWatchWakeKind,
	withWake,
} from "./session-watch-ledger.ts";

/** How long a wake that could not be delivered waits before it is tried again. */
const WATCH_WAKE_RETRY_DELAY_MS = 5_000;

/** Who reads or ends a session's watches: a turn of the session, under its authority, or one of its worker runtimes. */
export type SessionWatchCaller =
	| {
			readonly kind: "turn";
			readonly authority: TurnAuthority;
			/** Only the watches the session itself armed (a bot's own session's `task_watch`), never a worker's. */
			readonly sessionOnly?: boolean;
	  }
	| { readonly kind: "worker"; readonly runtimeId: string };

/**
 * Whether `caller` holds watch `record`, to read or end it: a worker runtime its own; a turn a watch the session armed at
 * the turn's authority or below, and a worker's only from an owner's turn. So a third party's run, or one opened from an
 * owner channel, never reads or ends a watch an owner's turn armed, nor its plan.
 */
export function callerHoldsWatch(record: SessionWatchRecord, caller: SessionWatchCaller): boolean {
	if (caller.kind === "worker")
		return record.armedBy.kind === "worker" && record.armedBy.runtimeId === caller.runtimeId;
	if (record.armedBy.kind === "worker") return caller.authority === "owner" && caller.sessionOnly !== true;
	return turnAuthorityCovers(caller.authority, record.armedBy.authority);
}

/** One arming: what to wait on, the plan, the end time and who arms it. */
export interface SessionWatchArmRequest {
	readonly watchId: string;
	readonly purpose?: string;
	readonly onFire: string;
	readonly condition: WatchCondition;
	readonly expiresAt: number;
	readonly armedBy: SessionWatchArmer;
	/**
	 * The session's tool call that arms it: a command's or page's check is admitted by the session's gate as its sub-call.
	 * A worker's arming has none, since the worker's own gate admitted the check before it asked.
	 */
	readonly toolCallId?: string;
	readonly parentToolName: string;
}

/** A watch as its armer reads it back. */
export interface SessionWatchView {
	readonly watchId: string;
	readonly status: SessionWatchStatus;
	readonly condition: WatchCondition;
	readonly purpose?: string;
	readonly onFire: string;
	readonly armedAt: string;
	readonly expiresAt: string;
	readonly endedAt?: string;
	readonly armedBy: { readonly kind: "session" } | { readonly kind: "worker"; readonly runtimeId: string };
	/** Wakes the armer is still owed. */
	readonly pendingWakes: number;
}

export interface SessionWatchServiceDeps {
	readonly ledger: SessionWatchLedger;
	readonly sessionId: string;
	readonly timers: TimerPort;
	readonly checks: WatchCheckAdmitter;
	/** Live routine watches an earlier build armed without the owner's words: they hold slots of the same bound. */
	legacyAgentWatches(): number;
	/** Live routine watches an earlier build armed for this worker runtime. */
	legacyWorkerWatches(runtimeId: string): number;
	/** Whether a worker runtime can still be woken (`worker-watch-liveness.ts`): retiring or cancelling it ends its watches. */
	workerRuntimeLive(runtimeId: string): boolean;
	/** Tells the listener of every change of the session's worker runtimes. */
	subscribeWorkers(listener: () => void): () => void;
	/**
	 * Wakes the session with one parent input (steer mode); resolves once it is durable. `owed` is read under the
	 * transcript's lock right before the append: a wake no longer owed (the owner's stop settled it meanwhile) appends
	 * nothing and resolves `"settled"`.
	 */
	deliverToSession(
		deliveryId: string,
		content: string,
		details: Readonly<Record<string, unknown>>,
		owed: () => boolean,
	): Promise<"delivered" | "settled">;
	wakeWorker(runtimeId: string, text: string, key: string): WorkerWake;
	/** Shows the owner a warning in the session (owner-facing text, in the interface language). */
	warnOwner(message: string): void;
	isDisposed(): boolean;
	warn(message: string): void;
}

/** The plan a wake carries: the armer's words, read as its own only when the session armed it under a turn not a third party's. */
function wakePlan(record: SessionWatchRecord): WatchWakePlan {
	return {
		watchId: record.watchId,
		text: record.purpose === undefined ? record.onFire : `Purpose: ${record.purpose}\nOn fire: ${record.onFire}`,
		trusted: record.armedBy.kind === "session" && record.armedBy.authority !== "third-party",
	};
}

/** The words of one wake, from the record alone. */
export function sessionWatchWakeText(record: SessionWatchRecord, wake: SessionWatchWake, planChars?: number): string {
	const plan = wakePlan(record);
	if (wake.kind === "fired") {
		if (!record.event) throw new Error(`Watch ${record.watchId} has no recorded firing.`);
		return watchFiredWakeText(
			plan,
			wake.deliveryId,
			{ event: record.event, sequence: record.cursor.fires },
			false,
			planChars,
		);
	}
	if (wake.kind === "timed-out")
		return watchTimedOutWakeText(
			plan,
			wake.deliveryId,
			record.condition,
			record.expiresAt,
			record.lastSeen,
			false,
			planChars,
		);
	if (!wake.failing) throw new Error(`Watch ${record.watchId} has no recorded failing streak.`);
	return watchFailingWakeText(plan, record.incarnationId, record.condition, record.expiresAt, wake.failing, planChars);
}

/**
 * The details of one wake: the keys a routine watch's wake carries, which every reader of a session transcript already
 * reads (`routineId` holds the watch's id; `oneShotWatch` keeps it out of the day's wake bound; `thirdParty` marks a firing
 * that carries the watched thing's words).
 */
export function sessionWatchWakeDetails(record: SessionWatchRecord, wake: SessionWatchWake): Record<string, unknown> {
	if (wake.kind === "fired" && record.event)
		return {
			routineId: record.watchId,
			outcome: "succeeded",
			wake: true,
			watch: watchFiredLine(record.event),
			oneShotWatch: true,
			...(record.event.excerpt === undefined ? {} : { thirdParty: true }),
		};
	if (wake.kind === "timed-out") return { routineId: record.watchId, expiresAt: record.expiresAt, oneShotWatch: true };
	return { routineId: record.watchId, failing: true, oneShotWatch: true };
}

function deliveryId(sessionId: string, record: SessionWatchRecord, kind: SessionWatchWakeKind, at: number): string {
	return `watch:${createHash("sha256")
		.update(JSON.stringify([sessionId, record.watchId, record.incarnationId, kind, kind === "failing" ? at : 0]))
		.digest("hex")}`;
}

function view(record: SessionWatchRecord): SessionWatchView {
	return {
		watchId: record.watchId,
		status: record.status,
		condition: record.condition,
		...(record.purpose === undefined ? {} : { purpose: record.purpose }),
		onFire: record.onFire,
		armedAt: new Date(record.armedAt).toISOString(),
		expiresAt: new Date(record.expiresAt).toISOString(),
		...(record.endedAt === undefined ? {} : { endedAt: new Date(record.endedAt).toISOString() }),
		armedBy:
			record.armedBy.kind === "session"
				? { kind: "session" }
				: { kind: "worker", runtimeId: record.armedBy.runtimeId },
		pendingWakes: record.wakes.filter((wake) => !wake.delivered).length,
	};
}

export class SessionWatchService implements WatchObservationStore {
	private readonly deps: SessionWatchServiceDeps;
	private started = false;
	private stopped = false;
	private expiryTimer: unknown;
	private retryTimer: unknown;
	private draining: Promise<void> | undefined;
	private drainAgain = false;
	private unsubscribeWorkers: (() => void) | undefined;
	/** The reason last warned for a wake that could not be delivered, so one failing delivery warns once. */
	private lastDeliveryFault: string | undefined;

	constructor(deps: SessionWatchServiceDeps) {
		this.deps = deps;
	}

	/** Ends what reached its end time while the session was closed, delivers what is owed, and follows the end times. */
	start(): void {
		if (this.started || this.stopped) return;
		this.started = true;
		this.unsubscribeWorkers = this.deps.subscribeWorkers(() => this.endWatchesOfEndedWorkers());
		this.endWatchesOfEndedWorkers();
		this.expireDue();
		this.drain();
	}

	/** Stops the timers, joins the delivery in flight and records that the session closed. */
	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		this.unsubscribeWorkers?.();
		this.unsubscribeWorkers = undefined;
		this.clearTimer("expiryTimer");
		this.clearTimer("retryTimer");
		await this.draining;
		this.deps.ledger.close();
	}

	private get active(): boolean {
		return this.started && !this.stopped && !this.deps.isDisposed();
	}

	/** Live watches of the session (the operator bar's and a bot roster's count). */
	liveCount(nowMs = this.deps.timers.now()): number {
		return this.deps.ledger.list().filter((record) => isLiveSessionWatch(record, nowMs)).length;
	}

	/** Every watch of the session, for its own readers (the operator's status); a caller reads only its own ({@link listFor}). */
	list(): SessionWatchView[] {
		return this.deps.ledger.list().map(view);
	}

	/** The watches `caller` holds ({@link callerHoldsWatch}). */
	listFor(caller: SessionWatchCaller): SessionWatchView[] {
		return this.deps.ledger
			.list()
			.filter((record) => callerHoldsWatch(record, caller))
			.map(view);
	}

	/** Whether the ledger holds watch `watchId` at all, whoever armed it. */
	holds(watchId: string): boolean {
		return this.deps.ledger.get(watchId) !== undefined;
	}

	/**
	 * The owner's stop made at `stopAt` (a bot's): the watches the session armed by then end and the wakes they are owed
	 * are settled without a turn, a wake its transcript already carries (`carried`) marked by that input
	 * ({@link endWatchesArmedByStop}). A failure throws, with the ledger as it was.
	 */
	endArmedByStop(stopAt: number, carried: (deliveryId: string) => boolean): { ended: number; settled: number } {
		const outcome = this.deps.ledger.endArmedByStop(stopAt, carried);
		this.followEndTimes();
		return outcome;
	}

	/** Watch `watchId` when `caller` holds it; absent to it otherwise, as a watch never armed is. */
	get(watchId: string, caller: SessionWatchCaller): SessionWatchView | undefined {
		const record = this.deps.ledger.get(watchId);
		return record && callerHoldsWatch(record, caller) ? view(record) : undefined;
	}

	/**
	 * Arms one watch. A command or page the session arms is admitted by the session's gate as a sub-call of the arming call
	 * (`watch-check-admission.ts`); a worker's was admitted by its own gate, and is admitted here under its scope and the
	 * session's authority together. The slots are counted again after the admission, just before the write.
	 */
	async arm(request: SessionWatchArmRequest, signal?: AbortSignal): Promise<SessionWatchView> {
		this.check(signal);
		this.requireRoom(request);
		const worker =
			request.armedBy.kind === "worker"
				? { runtimeId: request.armedBy.runtimeId, scope: request.armedBy.scope }
				: undefined;
		const admitted =
			request.toolCallId === undefined
				? { condition: this.deps.checks.admitWatch(request.condition, worker), check: undefined }
				: await admitWatchCheck(
						this.deps.checks,
						{
							toolCallId: request.toolCallId,
							parentToolName: request.parentToolName,
							watchId: request.watchId,
							condition: request.condition,
							...(worker ? { worker } : {}),
						},
						signal,
					);
		let record: SessionWatchRecord;
		try {
			// Built through the ledger's own codec, so no arming writes a record a reload would set aside.
			record = parseSessionWatchRecord({
				watchId: request.watchId,
				incarnationId: randomUUID(),
				...(request.purpose === undefined ? {} : { purpose: request.purpose }),
				onFire: request.onFire,
				condition: admitted.condition,
				// On the clock an owner's stop of a bot is dated on, so a stop judges what was armed before it by one clock.
				armedAt: OWNER_STOP_CLOCK.now(),
				expiresAt: request.expiresAt,
				armedBy: request.armedBy,
				cursor: { kind: "watch", truth: null, fires: 0 },
				status: "live",
				wakes: [],
			} satisfies SessionWatchRecord);
			this.check(signal);
			this.requireRoom(request);
			this.deps.ledger.commit([
				...this.deps.ledger.list().filter((entry) => entry.watchId !== request.watchId),
				record,
			]);
		} catch (error) {
			// Nothing was armed: an owner approval the check claimed is freed, not spent.
			admitted.check?.abandon();
			throw error;
		}
		if (admitted.check) this.spendArming(admitted.check, record);
		this.followEndTimes();
		return view(record);
	}

	/**
	 * Spends what the armed watch's check admission claimed. A spend that cannot be recorded removes the watch again, so no
	 * approval stays reusable while a watch it armed runs; when the removal fails too, the watch stays armed and the owner
	 * is warned.
	 */
	private spendArming(check: { consume(): void }, record: SessionWatchRecord): void {
		try {
			check.consume();
		} catch (error) {
			try {
				this.deps.ledger.commit(
					this.deps.ledger.list().filter((entry) => entry.incarnationId !== record.incarnationId),
				);
			} catch (undoError) {
				const undo = undoError instanceof Error ? undoError.message : String(undoError);
				this.deps.warnOwner(interfaceText().notices.watchArmedApprovalUnrecorded(record.watchId, undo));
				throw new Error(
					`Watch "${record.watchId}" is armed, but the use of the owner's approval that admitted its check could not be recorded, and removing it failed (${undo}). The owner was warned; report it, and cancel the watch if it should not run.`,
				);
			}
			const denial = readAgentToolPolicyDeniedError(error);
			if (denial) throw watchCheckRefusal(record.watchId, { reason: denial.message, correction: denial.correction });
			throw error;
		}
	}

	/** Why one more watch may not be armed now, as a numeric bound: the end time, a live watch of the same id, the slots. */
	private requireRoom(request: SessionWatchArmRequest): void {
		const nowMs = this.deps.timers.now();
		const hours = MAX_AGENT_WATCH_HORIZON_MS / 3_600_000;
		if (request.expiresAt <= nowMs || request.expiresAt > nowMs + MAX_AGENT_WATCH_HORIZON_MS)
			throw new Error(`A watch's deadline must be after now and at most ${hours} hours ahead.`);
		const live = this.deps.ledger.list().filter((record) => isLiveSessionWatch(record, nowMs));
		if (live.some((record) => record.watchId === request.watchId))
			throw new Error(`Watch ${request.watchId} is already armed; cancel it first or arm under another id.`);
		if (live.length + this.deps.legacyAgentWatches() >= MAX_AGENT_ARMED_WATCHES)
			throw new Error(
				`This session already holds ${MAX_AGENT_ARMED_WATCHES} watches, the most it may; cancel one or wait for one to fire or end.`,
			);
		const { armedBy } = request;
		if (
			armedBy.kind === "worker" &&
			live.filter((record) => record.armedBy.kind === "worker" && record.armedBy.runtimeId === armedBy.runtimeId)
				.length +
				this.deps.legacyWorkerWatches(armedBy.runtimeId) >=
				MAX_WORKER_ARMED_WATCHES
		)
			throw new Error(
				`This worker already holds ${MAX_WORKER_ARMED_WATCHES} watches, the most one may; wait for one to fire or end.`,
			);
	}

	/** Stops a live watch `caller` holds; it wakes nobody. One it does not hold is absent to it. */
	cancel(watchId: string, caller: SessionWatchCaller, signal?: AbortSignal): SessionWatchView {
		this.check(signal);
		const nowMs = this.deps.timers.now();
		const record = this.deps.ledger.get(watchId);
		if (!record || !callerHoldsWatch(record, caller) || !isLiveSessionWatch(record, nowMs))
			throw new Error(`No live watch ${watchId} you armed in this session.`);
		const cancelled: SessionWatchRecord = { ...record, status: "cancelled", endedAt: nowMs };
		this.replace(cancelled);
		this.followEndTimes();
		return view(cancelled);
	}

	subscribe(listener: () => void): () => void {
		return this.deps.ledger.subscribe(listener);
	}

	observedWatches(nowMs: number): readonly ObservedWatch[] {
		return this.deps.ledger
			.list()
			.filter((record) => isLiveSessionWatch(record, nowMs))
			.map((record) => ({
				routineId: record.watchId,
				incarnationId: record.incarnationId,
				condition: record.condition,
				worker:
					record.armedBy.kind === "worker"
						? { runtimeId: record.armedBy.runtimeId, scope: record.armedBy.scope }
						: undefined,
			}));
	}

	/** The edge rule over a watch's cursor: a firing ends the watch in the same write that records the wake it owes. */
	observeWatch(input: RoutineWatchObservationInput): RoutineWatchOutcome {
		const record = this.deps.ledger.get(input.routineId);
		if (
			!record ||
			record.incarnationId !== input.incarnationId ||
			input.parentSessionId !== this.deps.sessionId ||
			!isLiveSessionWatch(record, input.nowMs)
		)
			return "stale";
		const decision = decideWatchObservation(record.cursor, input.observation);
		if (!decision.fire) {
			if (isDeepStrictEqual(decision.cursor, record.cursor)) return "unchanged";
			this.replace({ ...record, cursor: decision.cursor });
			return "recorded";
		}
		const fired: SessionWatchRecord = {
			...record,
			cursor: { ...decision.cursor, fires: record.cursor.fires + 1, spent: true },
			status: "fired",
			endedAt: input.nowMs,
			event: input.event,
		};
		this.replace({
			...fired,
			wakes: withWake(fired, {
				kind: "fired",
				deliveryId: deliveryId(this.deps.sessionId, fired, "fired", input.nowMs),
				at: input.nowMs,
				delivered: false,
			}),
		});
		this.followEndTimes();
		this.drain();
		return "fired";
	}

	/** A failing streak the monitor reported: one more wake for the armer, keyed by when it was reported. */
	noteFailing(failing: WatchFailing): void {
		const nowMs = this.deps.timers.now();
		const record = this.deps.ledger.get(failing.routineId);
		if (!record || record.incarnationId !== failing.incarnationId || !isLiveSessionWatch(record, nowMs)) return;
		this.replace({
			...record,
			wakes: withWake(record, {
				kind: "failing",
				deliveryId: deliveryId(this.deps.sessionId, record, "failing", nowMs),
				at: nowMs,
				delivered: false,
				failing: { cause: failing.cause, failures: failing.failures, reason: failing.reason },
			}),
		});
		this.drain();
	}

	private replace(record: SessionWatchRecord): void {
		this.deps.ledger.commit(
			this.deps.ledger.list().map((entry) => (entry.watchId === record.watchId ? record : entry)),
		);
	}

	/**
	 * Ends the live watches of worker runtimes that can no longer be woken (retired, cancelled, gone): what they waited for
	 * ended with the worker, so they free their slots and wake nobody. Read from the durable task state, so it holds across
	 * a restart.
	 */
	private endWatchesOfEndedWorkers(): void {
		if (!this.active) return;
		const nowMs = this.deps.timers.now();
		const ended = this.deps.ledger
			.list()
			.filter(
				(record) =>
					record.status === "live" &&
					record.armedBy.kind === "worker" &&
					!this.deps.workerRuntimeLive(record.armedBy.runtimeId),
			);
		if (ended.length === 0) return;
		const ids = new Set(ended.map((record) => record.watchId));
		try {
			this.deps.ledger.commit(
				this.deps.ledger
					.list()
					.map((record) =>
						ids.has(record.watchId) ? { ...record, status: "cancelled" as const, endedAt: nowMs } : record,
					),
			);
		} catch (error) {
			// The ledger could not be written: the next change of the session's workers tries again.
			this.warn(error);
			return;
		}
		this.followEndTimes();
	}

	/** Ends every live watch whose end time passed, with what it last saw and the wake it owes. */
	private expireDue(): void {
		const nowMs = this.deps.timers.now();
		const due = this.deps.ledger.list().filter((record) => record.status === "live" && nowMs >= record.expiresAt);
		if (due.length > 0) {
			const ended = new Map(
				due.map((record) => {
					const timedOut: SessionWatchRecord = {
						...record,
						status: "timed-out",
						endedAt: nowMs,
						lastSeen: watchLastSeen(record.cursor),
					};
					const wake: SessionWatchWake = {
						kind: "timed-out",
						deliveryId: deliveryId(this.deps.sessionId, timedOut, "timed-out", nowMs),
						at: nowMs,
						delivered: false,
					};
					return [record.watchId, { ...timedOut, wakes: withWake(timedOut, wake) }] as const;
				}),
			);
			try {
				this.deps.ledger.commit(this.deps.ledger.list().map((record) => ended.get(record.watchId) ?? record));
			} catch (error) {
				// The ledger could not be written: the end is recorded on a later attempt, never lost.
				this.warn(error);
				this.clearTimer("expiryTimer");
				if (this.active)
					this.expiryTimer = this.deps.timers.setTimeout(() => {
						this.expiryTimer = undefined;
						if (this.active) this.expireDue();
					}, WATCH_WAKE_RETRY_DELAY_MS);
				this.drain();
				return;
			}
		}
		this.followEndTimes();
		this.drain();
	}

	/** One timer at the nearest end time of a live watch. */
	private followEndTimes(): void {
		this.clearTimer("expiryTimer");
		if (!this.active) return;
		const next = Math.min(
			...this.deps.ledger
				.list()
				.filter((record) => record.status === "live")
				.map((record) => record.expiresAt),
		);
		if (!Number.isFinite(next)) return;
		this.expiryTimer = this.deps.timers.setTimeout(
			() => {
				this.expiryTimer = undefined;
				if (this.active) this.expireDue();
			},
			Math.max(0, next - this.deps.timers.now()),
		);
	}

	/** Delivers every owed wake in order, one delivery at a time; one that cannot be delivered now is tried again later. */
	private drain(): void {
		if (!this.active) return;
		if (this.draining) {
			this.drainAgain = true;
			return;
		}
		this.draining = this.deliverOwed().finally(() => {
			this.draining = undefined;
			if (this.drainAgain) {
				this.drainAgain = false;
				this.drain();
			}
		});
	}

	private async deliverOwed(): Promise<void> {
		let retry = false;
		for (const record of this.deps.ledger.list())
			for (const wake of record.wakes) {
				if (wake.delivered || !this.active) continue;
				try {
					const outcome = await this.deliver(record, wake);
					if (outcome === "later") {
						retry = true;
						continue;
					}
					if (outcome === "delivered") this.markDelivered(record.watchId, wake.deliveryId);
					this.lastDeliveryFault = undefined;
				} catch (error) {
					retry = true;
					const reason = error instanceof Error ? error.message : String(error);
					if (reason !== this.lastDeliveryFault) this.warn(error);
					this.lastDeliveryFault = reason;
				}
			}
		if (retry) this.retryLater();
	}

	/**
	 * Delivers one wake: `"later"` when its worker did not take it now and the retry window is still open, `"settled"` when
	 * it was no longer owed at the append (the owner's stop settled it).
	 */
	private async deliver(
		record: SessionWatchRecord,
		wake: SessionWatchWake,
	): Promise<"delivered" | "settled" | "later"> {
		const details = sessionWatchWakeDetails(record, wake);
		const text = sessionWatchWakeText(record, wake);
		const owed = () =>
			this.deps.ledger
				.get(record.watchId)
				?.wakes.some((entry) => entry.deliveryId === wake.deliveryId && !entry.delivered) === true;
		if (record.armedBy.kind === "session") return this.deps.deliverToSession(wake.deliveryId, text, details, owed);
		const { runtimeId } = record.armedBy;
		const woken = this.deps.wakeWorker(
			runtimeId,
			sessionWatchWakeText(record, wake, WORKER_WAKE_PLAN_CHARS),
			wake.deliveryId,
		);
		// A runtime that is gone settles the wake unwoken, as a routine watch's does.
		if (woken.kind !== "refused") return "delivered";
		if (this.deps.timers.now() - wake.at < WORKER_WAKE_RETRY_MS) return "later";
		return this.deps.deliverToSession(
			`${wake.deliveryId}:session`,
			`${workerUnreachableLine(runtimeId, woken.reason)}\n${text}`,
			details,
			owed,
		);
	}

	private markDelivered(watchId: string, wakeId: string): void {
		const record = this.deps.ledger.get(watchId);
		if (!record) return;
		this.replace({
			...record,
			wakes: record.wakes.map((wake) => (wake.deliveryId === wakeId ? { ...wake, delivered: true } : wake)),
		});
	}

	private retryLater(): void {
		if (!this.active || this.retryTimer !== undefined) return;
		this.retryTimer = this.deps.timers.setTimeout(() => {
			this.retryTimer = undefined;
			this.drain();
		}, WATCH_WAKE_RETRY_DELAY_MS);
	}

	private clearTimer(name: "expiryTimer" | "retryTimer"): void {
		if (this[name] === undefined) return;
		this.deps.timers.clearTimeout(this[name]);
		this[name] = undefined;
	}

	private check(signal?: AbortSignal): void {
		signal?.throwIfAborted();
		if (this.stopped || this.deps.isDisposed()) throw new Error("Session watches are stopped.");
	}

	private warn(error: unknown): void {
		this.deps.warn(
			`Session watch: ${boundedRedactedDiagnosticText(error instanceof Error ? error.message : String(error)) ?? "operation unavailable"}`,
		);
	}
}
