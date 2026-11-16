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
import type { CiAttemptTerminalEvent } from "../events/host-event-contract.ts";
import type { GoalBoundWatch } from "../goals/goal-continuation-controller.ts";
import { englishText, interfaceText } from "../language/interface-text.ts";
import {
	MAX_AGENT_ARMED_WATCHES,
	MAX_AGENT_WATCH_HORIZON_MS,
	MAX_WORKER_ARMED_WATCHES,
} from "../routines/routine-watch-arming.ts";
import {
	decideWatchObservation,
	type RoutineWatchObservationInput,
	type RoutineWatchOutcome,
	type WatchLastSeen,
	watchLastSeen,
} from "../routines/routine-watch-edge.ts";
import type { ObservedWatch, WatchFailing, WatchObservationStore } from "../routines/routine-watch-monitor.ts";
import {
	type WatchWakePlan,
	watchCauseText,
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
import { watchFiredLine } from "../routines/watch-contract.ts";
import { watchCheckRefusal } from "../routines/worker-watch-scope.ts";
import { boundedRedactedDiagnosticText } from "../security/secret-text.ts";
import { type TurnAuthority, turnAuthorityCovers } from "../turn-origin.ts";
import { OWNER_STOP_CLOCK, type TimerPort } from "../util/timer-port.ts";
import {
	boundedGithubWatchResult,
	describeGithubWatchResult,
	type GithubWatchResult,
	type GithubWatchSource,
	githubWatchSubject,
	isGithubWatchSource,
} from "./github-watch-source.ts";
import {
	githubWatchFailingWakeText,
	githubWatchFiredWakeText,
	githubWatchTimedOutWakeText,
} from "./github-watch-wake.ts";
import {
	isLiveSessionWatch,
	parseSessionWatchRecord,
	type SessionRequirementJudgment,
	type SessionWatchArmer,
	type SessionWatchLedger,
	type SessionWatchRecord,
	type SessionWatchRequirement,
	type SessionWatchServed,
	type SessionWatchSource,
	type SessionWatchStatus,
	type SessionWatchWake,
	type SessionWatchWakeKind,
	withWake,
} from "./session-watch-ledger.ts";
import { sessionWatchPhoneKey, sessionWatchPhoneText } from "./session-watch-phone.ts";

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
	// A watch the host armed for the session holds the authority of the turn whose call it followed, as the session's own.
	return turnAuthorityCovers(caller.authority, record.armedBy.authority);
}

/** One arming: what to wait on, the plan, the end time and who arms it. */
export interface SessionWatchArmRequest {
	readonly watchId: string;
	readonly purpose?: string;
	readonly onFire: string;
	readonly condition: SessionWatchSource;
	readonly expiresAt: number;
	readonly armedBy: SessionWatchArmer;
	/** Tell the owner each result on the phone besides the armer's wake. */
	readonly tellOwner?: boolean;
	/**
	 * When the call the host arms this after began, on `OWNER_STOP_CLOCK` (the host's own arming, `watch-auto-arm.ts`): an
	 * owner's stop made at or after then refuses it, since the stop ended the work that call belongs to.
	 */
	readonly callStartedAt?: number;
	/** The goal requirement the watch waits for: the goal's continuation waits on it while it is live. */
	readonly forRequirement?: SessionWatchRequirement;
	/** The entry the arming answers to, when read before the arming (the host's for a call it read later); else the session's latest. */
	readonly served?: SessionWatchServed;
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
	readonly condition: SessionWatchSource;
	readonly purpose?: string;
	readonly onFire: string;
	readonly armedAt: string;
	readonly expiresAt: string;
	readonly endedAt?: string;
	readonly armedBy:
		| { readonly kind: "session" }
		| { readonly kind: "auto" }
		| { readonly kind: "worker"; readonly runtimeId: string };
	readonly tellOwner?: true;
	/** The id of the goal requirement the watch waits for. */
	readonly forRequirement?: string;
	/** What the watch last observed of its condition: while it watches, and when it ended without firing. */
	readonly lastObservation: WatchLastSeen;
	/** What its firing saw, once it fired. */
	readonly result?: { readonly cause: string; readonly observedAt: string };
	/** A typed source's last reading of GitHub: its status, conclusion, failed job and URL, pending or done. */
	readonly reading?: GithubWatchResult;
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
	/** The session's transcript entry an arming happens at, which its wakes are charged to; undefined with none. */
	armingEntry(): SessionWatchServed | undefined;
	/** Shows the owner a warning in the session (owner-facing text, in the interface language). */
	warnOwner(message: string): void;
	/** Tells the owner once per key on the phone (`OwnerPush.tell`); absent where no owner channel is hosted. */
	tellOwner?(key: string, text: string): void;
	isDisposed(): boolean;
	warn(message: string): void;
}

/** The plan a wake carries: the armer's words, read as its own only when the session armed it under a turn not a third party's. */
function wakePlan(record: SessionWatchRecord): WatchWakePlan {
	return {
		watchId: record.watchId,
		text: record.purpose === undefined ? record.onFire : `Purpose: ${record.purpose}\nOn fire: ${record.onFire}`,
		// The host's own plan of a watch it armed is its words; a third party's turn's plan is data.
		trusted:
			record.armedBy.kind === "auto" ||
			(record.armedBy.kind === "session" && record.armedBy.authority !== "third-party"),
	};
}

/** The words of one wake, from the record alone. */
export function sessionWatchWakeText(record: SessionWatchRecord, wake: SessionWatchWake, planChars?: number): string {
	const plan = wakePlan(record);
	const { condition } = record;
	if (isGithubWatchSource(condition)) return githubWatchWakeText(record, condition, wake, planChars);
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
			condition,
			record.expiresAt,
			record.lastSeen,
			false,
			planChars,
		);
	if (!wake.failing) throw new Error(`Watch ${record.watchId} has no recorded failing streak.`);
	return watchFailingWakeText(plan, record.incarnationId, condition, record.expiresAt, wake.failing, planChars);
}

/** The words of one wake of a typed GitHub source. */
function githubWatchWakeText(
	record: SessionWatchRecord,
	source: GithubWatchSource,
	wake: SessionWatchWake,
	planChars?: number,
): string {
	const plan = wakePlan(record);
	if (wake.kind === "fired") {
		if (!record.result) throw new Error(`Watch ${record.watchId} has no recorded result.`);
		return githubWatchFiredWakeText(plan, wake.deliveryId, source, record.result, planChars);
	}
	if (wake.kind === "timed-out")
		return githubWatchTimedOutWakeText(plan, wake.deliveryId, source, record.expiresAt, record.result, planChars);
	if (!wake.failing) throw new Error(`Watch ${record.watchId} has no recorded failing streak.`);
	return githubWatchFailingWakeText(plan, record.incarnationId, source, record.expiresAt, wake.failing, planChars);
}

/**
 * The details of one wake: the keys a routine watch's wake carries, which every reader of a session transcript already
 * reads (`routineId` holds the watch's id; `oneShotWatch` keeps it out of the day's wake bound; `thirdParty` marks a firing
 * that carries the watched thing's words).
 */
export function sessionWatchWakeDetails(record: SessionWatchRecord, wake: SessionWatchWake): Record<string, unknown> {
	// The entry the watch was armed from: its wake turns are charged to that entry's spend window.
	const served = record.served === undefined ? {} : { served: record.served };
	// A typed source's firing: its cause in English (what every reader of a wake's row shows when it holds no firing
	// line) and the reading itself, which this build's row words in the interface language.
	if (wake.kind === "fired" && record.result && isGithubWatchSource(record.condition))
		return {
			routineId: record.watchId,
			outcome: "succeeded",
			wake: true,
			cause: describeGithubWatchResult(record.condition, record.result, englishText().chat.watch.github),
			github: { source: record.condition, result: record.result },
			oneShotWatch: true,
			...served,
		};
	if (wake.kind === "fired" && record.event)
		return {
			routineId: record.watchId,
			outcome: "succeeded",
			wake: true,
			watch: watchFiredLine(record.event),
			oneShotWatch: true,
			...(record.event.excerpt === undefined ? {} : { thirdParty: true }),
			...served,
		};
	if (wake.kind === "timed-out")
		return { routineId: record.watchId, expiresAt: record.expiresAt, oneShotWatch: true, ...served };
	return { routineId: record.watchId, failing: true, oneShotWatch: true, ...served };
}

function deliveryId(sessionId: string, record: SessionWatchRecord, kind: SessionWatchWakeKind, at: number): string {
	return `watch:${createHash("sha256")
		.update(JSON.stringify([sessionId, record.watchId, record.incarnationId, kind, kind === "failing" ? at : 0]))
		.digest("hex")}`;
}

function view(record: SessionWatchRecord): SessionWatchView {
	const github = isGithubWatchSource(record.condition) ? record.condition : undefined;
	const done = github && record.result?.state === "done" ? record.result : undefined;
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
			record.armedBy.kind === "worker"
				? { kind: "worker", runtimeId: record.armedBy.runtimeId }
				: { kind: record.armedBy.kind },
		...(record.tellOwner ? { tellOwner: true as const } : {}),
		...(record.forRequirement ? { forRequirement: record.forRequirement.requirementId } : {}),
		lastObservation: github
			? record.result === undefined
				? "unobserved"
				: "not-met"
			: (record.lastSeen ?? watchLastSeen(record.cursor)),
		...(record.event === undefined
			? {}
			: { result: { cause: watchCauseText(record.event), observedAt: record.event.observedAt } }),
		...(github && done
			? {
					result: {
						cause: describeGithubWatchResult(github, done, englishText().chat.watch.github),
						observedAt: new Date(done.observedAt).toISOString(),
					},
				}
			: {}),
		...(record.result === undefined ? {} : { reading: record.result }),
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
	/** The latest instant an owner's stop was applied at here, on `OWNER_STOP_CLOCK`: no call begun by then is armed after. */
	private latestStopAt: number | undefined;

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
		// Recorded before the ledger is touched: the owner stopped at `stopAt` whether or not the write succeeds, and a call
		// begun by then arms nothing after it either way.
		this.latestStopAt = Math.max(this.latestStopAt ?? stopAt, stopAt);
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
		const { condition } = request;
		// A typed source runs no check: the host reads GitHub itself, read-only, and no command or page is admitted.
		const admitted = isGithubWatchSource(condition)
			? { condition, check: undefined }
			: request.toolCallId === undefined
				? { condition: this.deps.checks.admitWatch(condition, worker), check: undefined }
				: await admitWatchCheck(
						this.deps.checks,
						{
							toolCallId: request.toolCallId,
							parentToolName: request.parentToolName,
							watchId: request.watchId,
							condition,
							...(worker ? { worker } : {}),
						},
						signal,
					);
		// A worker's wakes go to its runtime and are charged to its own run, not to the session entry it was armed at.
		const served = request.armedBy.kind === "worker" ? undefined : (request.served ?? this.deps.armingEntry());
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
				...(request.tellOwner === true ? { tellOwner: true } : {}),
				...(request.forRequirement === undefined ? {} : { forRequirement: request.forRequirement }),
				...(served === undefined ? {} : { served }),
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

	/**
	 * Why one more watch may not be armed now, as a numeric bound: the end time, a watch of the same id still live or still
	 * owed a wake, the slots.
	 */
	private requireRoom(request: SessionWatchArmRequest): void {
		const nowMs = this.deps.timers.now();
		const hours = MAX_AGENT_WATCH_HORIZON_MS / 3_600_000;
		if (request.expiresAt <= nowMs || request.expiresAt > nowMs + MAX_AGENT_WATCH_HORIZON_MS)
			throw new Error(`A watch's deadline must be after now and at most ${hours} hours ahead.`);
		if (
			request.callStartedAt !== undefined &&
			this.latestStopAt !== undefined &&
			request.callStartedAt <= this.latestStopAt
		)
			throw new Error("the owner's stop ended the work of the call that started it, which began before the stop");
		const live = this.deps.ledger.list().filter((record) => isLiveSessionWatch(record, nowMs));
		if (live.some((record) => record.watchId === request.watchId))
			throw new Error(`Watch ${request.watchId} is already armed; cancel it first or arm under another id.`);
		// Arming an id replaces its record, so an ended watch's id is taken again only once its armer has had every wake.
		if (
			this.deps.ledger
				.list()
				.some((record) => record.watchId === request.watchId && record.wakes.some((wake) => !wake.delivered))
		)
			throw new Error(
				`Watch ${request.watchId} ended and its wake is not delivered yet; arm under another id, or again once it is.`,
			);
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

	/**
	 * The watches bound to `goalId`'s requirements, the latest armed per requirement (one it replaced is history): live
	 * while it waits before its end time, with what is left of it on the routines clock; else how it ended. A live record
	 * past its end time has timed out, which the next expiry pass records.
	 */
	boundTo(goalId: string, nowMs = this.deps.timers.now()): GoalBoundWatch[] {
		const latest = new Map<string, SessionWatchRecord>();
		for (const record of this.deps.ledger.list()) {
			const bound = record.forRequirement;
			if (bound?.goalId !== goalId) continue;
			const held = latest.get(bound.requirementId);
			if (!held || held.armedAt <= record.armedAt) latest.set(bound.requirementId, record);
		}
		return [...latest].map(([requirementId, { watchId, status, expiresAt }]) =>
			status === "live" && nowMs < expiresAt
				? { requirementId, watchId, status, remainingMs: expiresAt - nowMs }
				: { requirementId, watchId, status: status === "live" ? "timed-out" : status },
		);
	}

	/** System One's answers about the session's goal requirements, as the ledger keeps them across restarts. */
	requirementJudgments(): readonly SessionRequirementJudgment[] {
		return this.deps.ledger.requirementJudgments();
	}

	/** Keeps an answer about a goal requirement; one that cannot be written is warned and asked again after a restart. */
	saveRequirementJudgment(judgment: SessionRequirementJudgment): void {
		try {
			this.deps.ledger.saveRequirementJudgment(judgment);
		} catch (error) {
			this.warn(error);
		}
	}

	/** Whether a watch the session armed for itself, not a worker's, still waits. */
	ownLive(nowMs = this.deps.timers.now()): boolean {
		return this.deps.ledger
			.list()
			.some((record) => record.armedBy.kind !== "worker" && isLiveSessionWatch(record, nowMs));
	}

	/** The incarnations of the session's own watches that ended: one not seen before fired, timed out or was cancelled. */
	endedOwn(): string[] {
		return this.deps.ledger
			.list()
			.flatMap((record) =>
				record.armedBy.kind !== "worker" && record.status !== "live" ? [record.incarnationId] : [],
			);
	}

	subscribe(listener: () => void): () => void {
		return this.deps.ledger.subscribe(listener);
	}

	/** The live watches on a condition the routine watch monitor samples; a typed source is read by its own poller. */
	observedWatches(nowMs: number): readonly ObservedWatch[] {
		return this.deps.ledger.list().flatMap((record) => {
			const { condition } = record;
			if (isGithubWatchSource(condition) || !isLiveSessionWatch(record, nowMs)) return [];
			return [
				{
					routineId: record.watchId,
					incarnationId: record.incarnationId,
					condition,
					worker:
						record.armedBy.kind === "worker"
							? { runtimeId: record.armedBy.runtimeId, scope: record.armedBy.scope }
							: undefined,
				},
			];
		});
	}

	/** The live watches on a typed GitHub source, for the poller that reads them (`github-watch-poller.ts`). */
	githubWatches(nowMs: number): readonly { watchId: string; incarnationId: string; source: GithubWatchSource }[] {
		return this.deps.ledger.list().flatMap((record) => {
			const { condition } = record;
			return isGithubWatchSource(condition) && isLiveSessionWatch(record, nowMs)
				? [{ watchId: record.watchId, incarnationId: record.incarnationId, source: condition }]
				: [];
		});
	}

	/**
	 * The watch on the thing `source` names, live or ended, that wakes whom `armer` would: a worker runtime its own, the
	 * session one the session or the host armed for it. One wait per subject and recipient, so a worker's call is woken by
	 * a watch of its own though the session already waits on the same subject, and the other way round.
	 */
	armedOn(source: GithubWatchSource, armer: SessionWatchArmer): SessionWatchView | undefined {
		const subject = githubWatchSubject(source);
		const wakesSame = (other: SessionWatchArmer) =>
			armer.kind === "worker"
				? other.kind === "worker" && other.runtimeId === armer.runtimeId
				: other.kind !== "worker";
		const record = this.deps.ledger
			.list()
			.find(
				({ condition, armedBy }) =>
					wakesSame(armedBy) && isGithubWatchSource(condition) && githubWatchSubject(condition) === subject,
			);
		return record && view(record);
	}

	/**
	 * One reading of a typed source: a pending one is recorded when it changed, a done one fires the watch in the same
	 * write that records the wake it owes, as a condition's firing does.
	 */
	observeGithub(
		watchId: string,
		incarnationId: string,
		reading: GithubWatchResult,
	): "stale" | "unchanged" | "recorded" | "fired" {
		const nowMs = this.deps.timers.now();
		const record = this.deps.ledger.get(watchId);
		if (
			!record ||
			record.incarnationId !== incarnationId ||
			!isGithubWatchSource(record.condition) ||
			!isLiveSessionWatch(record, nowMs)
		)
			return "stale";
		const result = boundedGithubWatchResult(reading);
		if (result.state === "pending") {
			const last = record.result;
			if (last?.status === result.status && last.runId === result.runId && last.runAttempt === result.runAttempt)
				return "unchanged";
			this.replace({ ...record, result });
			return "recorded";
		}
		const fired: SessionWatchRecord = {
			...record,
			cursor: { ...record.cursor, fires: record.cursor.fires + 1, spent: true },
			status: "fired",
			endedAt: nowMs,
			result,
		};
		this.replace({
			...fired,
			wakes: withWake(fired, {
				kind: "fired",
				deliveryId: deliveryId(this.deps.sessionId, fired, "fired", nowMs),
				at: nowMs,
				delivered: false,
			}),
		});
		this.followEndTimes();
		this.drain();
		return "fired";
	}

	/**
	 * Fires every live `ci` watch on a CI attempt's commit with that attempt's result, in one read and one write, and answers
	 * whether a watch the session armed (a worker's wakes reach the worker) now holds that attempt's firing, so the root
	 * delivery of the same result would be the session's second copy of it (`HostEventSessionController`). Coverage is the
	 * record's own firing, never a watch's liveness read at one instant and its firing made at another. A failed attempt's
	 * first failed job is read after the firing (`ciJobsAwaited`), and the wake waits for that read.
	 */
	claimCi(event: CiAttemptTerminalEvent): boolean {
		const nowMs = this.deps.timers.now();
		const onCommit = (record: SessionWatchRecord) =>
			record.condition.type === "ci" && record.condition.sha === event.headSha;
		const due = this.deps.ledger.list().filter((record) => onCommit(record) && isLiveSessionWatch(record, nowMs));
		if (due.length > 0) {
			const result: GithubWatchResult = boundedGithubWatchResult({
				state: "done",
				status: "completed",
				conclusion: event.conclusion,
				url: event.runUrl,
				runId: event.identity.runId,
				runAttempt: event.identity.runAttempt,
				observedAt: nowMs,
			});
			const fired = new Map(
				due.map((record) => {
					const ended: SessionWatchRecord = {
						...record,
						cursor: { ...record.cursor, fires: record.cursor.fires + 1, spent: true },
						status: "fired",
						endedAt: nowMs,
						result,
						...(event.conclusion === "failure" ? { awaitingFailedJob: true as const } : {}),
					};
					const wake: SessionWatchWake = {
						kind: "fired",
						deliveryId: deliveryId(this.deps.sessionId, ended, "fired", nowMs),
						at: nowMs,
						delivered: false,
					};
					return [record.watchId, { ...ended, wakes: withWake(ended, wake) }] as const;
				}),
			);
			this.deps.ledger.commit(this.deps.ledger.list().map((record) => fired.get(record.watchId) ?? record));
			this.followEndTimes();
			this.drain();
		}
		return this.deps.ledger
			.list()
			.some(
				(record) =>
					onCommit(record) &&
					record.armedBy.kind !== "worker" &&
					record.status === "fired" &&
					record.result?.runId === event.identity.runId &&
					record.result.runAttempt === event.identity.runAttempt,
			);
	}

	/** The fired `ci` watches whose failed attempt's first failed job is still to be read, for the poller that reads it. */
	ciJobsAwaited(): readonly {
		watchId: string;
		incarnationId: string;
		sha: string;
		runId: number;
		runAttempt: number;
	}[] {
		return this.deps.ledger.list().flatMap((record) => {
			const { condition, result } = record;
			return record.awaitingFailedJob &&
				condition.type === "ci" &&
				result?.runId !== undefined &&
				result.runAttempt !== undefined
				? [
						{
							watchId: record.watchId,
							incarnationId: record.incarnationId,
							sha: condition.sha,
							runId: result.runId,
							runAttempt: result.runAttempt,
						},
					]
				: [];
		});
	}

	/** Records what the read of a fired watch's failed job found: the job's name, none, or why it could not be read. */
	settleFailedJob(watchId: string, incarnationId: string, read: { job?: string } | { unread: string }): void {
		const record = this.deps.ledger.get(watchId);
		if (!record?.awaitingFailedJob || record.incarnationId !== incarnationId || !record.result) return;
		const { awaitingFailedJob: _settled, ...rest } = record;
		this.replace({
			...rest,
			result: boundedGithubWatchResult({
				...record.result,
				...("unread" in read
					? { failedJobUnread: read.unread }
					: read.job === undefined
						? {}
						: { failedJob: read.job }),
			}),
		});
		this.drain();
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
		// One failing wake is owed at a time: the armer hears the streak once, and the record stays within its wake bound.
		if (record.wakes.some((wake) => wake.kind === "failing" && !wake.delivered)) return;
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
				// A failed attempt's wake is told with its failed job, or why that could not be read, once the read ends.
				if (wake.delivered || !this.active || (wake.kind === "fired" && record.awaitingFailedJob)) continue;
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
		if (record.tellOwner) this.tellOwner(record, wake);
		const owed = () =>
			this.deps.ledger
				.get(record.watchId)
				?.wakes.some((entry) => entry.deliveryId === wake.deliveryId && !entry.delivered) === true;
		if (record.armedBy.kind !== "worker") return this.deps.deliverToSession(wake.deliveryId, text, details, owed);
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

	/**
	 * Tells the owner a wake's result on the phone, once per wake (`OwnerPush` keeps one push per key), whether or not its
	 * armer takes it now. A sentence that cannot be built is warned and does not hold the armer's wake back.
	 */
	private tellOwner(record: SessionWatchRecord, wake: SessionWatchWake): void {
		try {
			this.deps.tellOwner?.(
				sessionWatchPhoneKey(record, wake),
				sessionWatchPhoneText(record, wake, interfaceText().chat.watch),
			);
		} catch (error) {
			this.warn(error);
		}
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
