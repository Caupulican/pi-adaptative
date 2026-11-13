import { isDeepStrictEqual } from "node:util";
import { harnessLog } from "../../kernel/harness-log.ts";
import type { WorkerTerminalHandoffRecord } from "../delegation/worker-notification-coordinator.ts";
import type { WorkerSavedIntent } from "../delegation/worker-saved-intent.ts";
import { ciEventSubject, ciSubjectKey, hostEventHash, isCiEnvelope } from "../events/host-event-contract.ts";
import type { GithubThreadInterest } from "../events/host-event-kinds.ts";
import { hostEventIsCurrent } from "../events/host-event-reducer.ts";
import type { HarnessNotice } from "../harness-notice.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import type { WorkerReceiptOrigin } from "../orchestration/worker-receipt-origin.ts";
import { boundedRedactedDiagnosticText, cleanRedactBound } from "../security/secret-text.ts";
import { alarmAt, type TimerPort, type WallAlarm } from "../util/timer-port.ts";
import { AWAY_OFF_BRANCH_REASON, AWAY_UNPINNED_REASON } from "./away-routine-admission.ts";
import {
	decideRoutineEvents,
	MAX_ROUTINE_OCCURRENCES,
	MAX_ROUTINE_SUMMARY_CHARS,
	ROUTINE_JOURNAL_SHARE,
	ROUTINE_UNFINISHED_PHASES,
	RoutineAdmissionRefused,
	type RoutineAwayClaimGate,
	type RoutineDefinitionView,
	type RoutineDelivery,
	type RoutineEventAnchor,
	type RoutineHostEventFact,
	type RoutineHostEventFeed,
	type RoutineOccurrence,
	rebasedRoutineCursor,
	routineEnded,
	routineEventKey,
	routineGithubInterest,
	routineOccurrenceReplayKeys,
	routineOccurrencesSettled,
	routineOpensAt,
	routinePreviousSlot,
	routineStartWindow,
	routineZoneUnsupported,
} from "./routine-contract.ts";
import type { RoutineHolder, RoutineScope } from "./routine-holder.ts";
import {
	type RoutineOriginLoss,
	routineUndeliverableMarker,
	routineUndeliverableWarning,
} from "./routine-origin-reach.ts";
import { routineTurnOrigin } from "./routine-parent-input.ts";
import { PROMOTED_SNAG_RUNS, promotedRoutineSnags, type RoutineRunFacts } from "./routine-progress.ts";
import { routineInstructions } from "./routine-run-brief.ts";
import { routineReceiptOrigin } from "./routine-save-origin.ts";
import type { RoutineStorePort } from "./routine-store-port.ts";
import { WATCH_WAKE_SUMMARY } from "./routine-watch-wake.ts";
import type { RoutineWorkerExecutor, RoutineWorkerRequest, RoutineWorkerState } from "./routine-worker-executor.ts";

const CLAIM_LEASE_MS = 120_000;
const RETRY_DELAY_MS = 5_000;
const CLAIM_BATCH_SIZE = 8;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The one shape of a routine run's dispatch identity, also read back to find its attempts. */
export function routineWorkerRequest(
	occurrence: RoutineOccurrence,
	intent: RoutineWorkerRequest["intent"],
	dispatchKey: string,
): RoutineWorkerRequest {
	const turnOrigin = routineTurnOrigin(occurrence);
	return {
		intent,
		instructions: routineInstructions(occurrence),
		dispatchKey,
		...(turnOrigin ? { turnOrigin } : {}),
	};
}

/**
 * What a finished worker run tells its routine's progress record beyond outcome and summary: code facts only (the
 * result's reason code and its first error's code, never their text) and the run's own report.
 */
function routineRunFacts(execution: RoutineWorkerState): RoutineRunFacts {
	const step = execution.result?.errors[0]?.code;
	const report = execution.result?.progress;
	return {
		reasonCode: execution.result?.reasonCode ?? execution.record.reasonCode ?? execution.record.status,
		...(step ? { step } : {}),
		...(report ? { report } : {}),
	};
}

/**
 * Changes on a new replay gap and when a successor source replaces its store's earlier source. An ended source counts
 * through its successor, so removing its record later changes nothing.
 */
function routineReplayGapDigest(state: TaskRuntimeProjection): string {
	const gaps = Object.values(state.eventSources)
		.filter((source) => !source.ended && (source.lastReplayGap !== undefined || source.replaced))
		.map((source) =>
			source.replaced
				? [source.registration.sourceId, source.lastReplayGap ?? null, "replaced"]
				: [source.registration.sourceId, source.lastReplayGap],
		)
		.sort(([left], [right]) => String(left).localeCompare(String(right)));
	return hostEventHash("pi-routine-replay-gaps-v1", gaps);
}

/** Ledger position a new or changed event routine is anchored at: nothing accepted earlier can start it. */
export function routineEventAnchor(state: TaskRuntimeProjection): RoutineEventAnchor {
	return { ordinal: state.lastOrdinal, replayGaps: routineReplayGapDigest(state) };
}

/** Retained host events with the root note's eligibility facts; readiness is this live session's seal. */
export function routineHostEventFeed(
	state: TaskRuntimeProjection,
	isSourceReady: (sourceId: string) => boolean,
): RoutineHostEventFeed {
	const ready = new Map<string, boolean>();
	const events = Object.values(state.hostEvents).flatMap((accepted): RoutineHostEventFact[] => {
		const envelope = accepted.envelope;
		const sourceId = envelope.sourceId;
		if (!ready.has(sourceId)) ready.set(sourceId, isSourceReady(sourceId));
		// A source collects GitHub occurrences of its own checkout's repository only, whatever its CI scope.
		if (!isCiEnvelope(envelope))
			return [
				{
					acceptedOrdinal: accepted.acceptedOrdinal,
					sourceSequence: envelope.sourceSequence,
					event: envelope.event,
					ready: ready.get(sourceId) === true,
					current: hostEventIsCurrent(state, accepted),
					rootApplicable: true,
				},
			];
		const subject = ciSubjectKey(ciEventSubject(envelope.event));
		return [
			{
				acceptedOrdinal: accepted.acceptedOrdinal,
				sourceSequence: envelope.sourceSequence,
				event: envelope.event,
				ready: ready.get(sourceId) === true,
				current: hostEventIsCurrent(state, accepted),
				rootApplicable:
					state.eventSources[sourceId]?.registration.rootSubjects.some(
						(candidate) => ciSubjectKey(candidate) === subject,
					) === true,
			},
		];
	});
	return { events, replayGaps: routineReplayGapDigest(state) };
}

/**
 * The workflow paths this session's live CI sources watch, read from the attempts they delivered to the ledger: an
 * attempt counts when its workflow is the one a live source watches for the current checkout (its root subjects).
 * Undefined while no source is live here; empty until a watched attempt was delivered.
 */
export function routineCiWorkflowPaths(
	state: TaskRuntimeProjection,
	isSourceReady: (sourceId: string) => boolean,
): readonly string[] | undefined {
	const workflowKey = (host: string, repositoryId: number, workflowId: number) =>
		JSON.stringify([host, repositoryId, workflowId]);
	const watched = new Set<string>();
	let live = false;
	for (const source of Object.values(state.eventSources)) {
		if (!isSourceReady(source.registration.sourceId)) continue;
		live = true;
		for (const subject of source.registration.rootSubjects)
			watched.add(workflowKey(subject.host, subject.repositoryId, subject.workflowId));
	}
	if (!live) return undefined;
	const paths = new Set<string>();
	for (const accepted of Object.values(state.hostEvents)) {
		if (!isCiEnvelope(accepted.envelope)) continue;
		const { identity, workflowPath } = accepted.envelope.event;
		if (watched.has(workflowKey(identity.host, identity.repositoryId, identity.workflowId))) paths.add(workflowPath);
	}
	return [...paths].sort();
}

/**
 * What this session's GitHub routines ask its CI source to collect: one interest per enabled, unended routine of the
 * session, at most {@link HOST_EVENT_LISTENER_LIMITS}.maxListenersPerSource (the store refuses more at save).
 */
export function routineGithubInterests(
	routines: readonly RoutineDefinitionView[],
	parentSessionId: string,
	nowMs: number,
): readonly GithubThreadInterest[] {
	return routines.flatMap((routine) =>
		routine.enabled &&
		routine.schedule.kind === "event" &&
		routine.schedule.source === "github" &&
		routine.target.kind === "session" &&
		routine.target.parentSessionId === parentSessionId &&
		routineEnded(routine, nowMs) === undefined
			? [routineGithubInterest(routine.schedule)]
			: [],
	);
}

/** Read-only view of the session's host events; the scheduler never writes event custody. */
export interface RoutineHostEventPort {
	feed(): RoutineHostEventFeed;
	/** Ledger commits and source readiness changes. */
	subscribe(listener: () => void): () => void;
}

/** How finished routine results reach the parent session; only a host with the parent open has it. */
export interface RoutineResultDelivery {
	deliver(delivery: RoutineDelivery): Promise<{ entryId: string }>;
	/**
	 * The parent input still carrying an earlier quiet result of this delivery's routine to the owner's next turn, when the
	 * delivery is itself quiet. Absent, the delivery is its own input.
	 */
	findCarriedQuietResult(delivery: RoutineDelivery): { entryId: string } | undefined;
	/** Consume the native notification only after its parent input is physically durable. */
	acknowledgeWorkerNotification(occurrence: RoutineOccurrence): void;
	/**
	 * Why a result addressed to `origin` can never reach this session (`routine-origin-reach.ts`): the session file it
	 * names is gone, or its anchor entry is absent from the durable session file. Undefined while it may still pass.
	 */
	originLoss(origin: WorkerReceiptOrigin): RoutineOriginLoss | undefined;
	/**
	 * Tells the owner once, with their next turn, that one of this session's routines is paused after failed runs,
	 * cannot be scheduled here, or keeps stumbling on the same snag; `undefined` observes that the state ended. `scope`
	 * is the subject holding the state on its own: the routine id, or one snag of it.
	 */
	noticeRoutineState(
		kind: "routine-paused" | "routine-unschedulable" | "routine-snag",
		scope: string,
		notice: HarnessNotice | undefined,
	): void;
}

interface RoutineSchedulerDeps {
	readonly store: RoutineStorePort;
	readonly worker: RoutineWorkerExecutor;
	readonly timers: TimerPort;
	readonly parentSessionId: string;
	/** What this runtime holds of the saved routines (`routine-holder.ts`): a bot's own session, only its watches. */
	readonly scope: RoutineScope;
	readonly owner: string;
	isDisposed(): boolean;
	canDispatch(): boolean;
	getReceiptOrigin(): WorkerReceiptOrigin;
	canUseOrigin(origin: WorkerReceiptOrigin): boolean;
	captureOriginGuard(origin: WorkerReceiptOrigin): () => void;
	subscribeContext(listener: () => void): () => void;
	subscribeExecution(listener: () => void): () => void;
	readonly hostEvents: RoutineHostEventPort;
	/** Includes physical resource release, which may follow the durable terminal record. */
	subscribeCapacity(listener: () => void): () => void;
	/** Whether a worker runtime can still be woken; a watch armed by one that cannot is dropped (`worker-watch-liveness.ts`). */
	workerRuntimeLive?(runtimeId: string): boolean;
	/**
	 * Present when the parent session is open here. A host running routines away has none: its results stay pending
	 * in the store and the parent's own scheduler delivers them when it opens.
	 */
	readonly delivery?: RoutineResultDelivery;
	/**
	 * Present only for a host running the parent's routines away. It runs only the parent's pinned session routines
	 * (never event, bot or team routines, which need the open session or are any session's), and every claim it makes
	 * is admitted under the away spend bound this returns.
	 */
	readonly away?: {
		gate(): RoutineAwayClaimGate;
		/** Why a saved run cannot run away (its authority needs the open session), or undefined when it can. */
		refusal(intent: WorkerSavedIntent): string | undefined;
	};
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
	/** The routines read from the store are only the ones this runtime holds. */
	private readonly holder: RoutineHolder;
	private readonly abort = new AbortController();
	private readonly unsubscribe: readonly (() => void)[];
	private unsubscribeCapacity: (() => void) | undefined;
	private alarm: WallAlarm | undefined;
	private pass: Promise<RoutineTickResult> | undefined;
	private scheduled = false;
	private dirty = false;
	private disposed = false;
	private started = false;
	private readonly deliveries = new Map<string, Promise<void>>();
	private capacityRevision = 0;
	private readonly deferred = new Map<string, number>();
	/** The reason last reported for each failing step; a step reports again only after it recovered or its reason changed. */
	private readonly faults = new Map<string, string>();
	/** A step of the running pass failed: the pass ends normally and the next one starts after the retry delay. */
	private stepFailed = false;
	/** The last claim left a due routine unconsumed for lack of journal room; only a store change can admit it. */
	private journalFull = false;
	/** Routines the last claim left due because each holds its whole journal share; only a store change can admit them. */
	private shareWait: ReadonlySet<string> = new Set();
	/**
	 * Away only: the routines the last claim left due because the away spend bound had no room, and when the oldest
	 * charged run leaves the window. Room otherwise returns only with a store change, which wakes the scheduler.
	 */
	private awayWait: { readonly routines: ReadonlySet<string>; readonly retryAt?: number } | undefined;
	/** Away only: routines the last claim left due because an earlier run away of each is not yet delivered. */
	private awayHeld: ReadonlySet<string> = new Set();
	/** `routinePreviousSlot` of each routine cursor seen by the last schedule read, so a cursor is evaluated once. */
	private previousSlots = new Map<string, number | undefined>();
	/** Pauses already logged by this process, keyed by routine and the occurrence whose failure paused it. */
	private readonly announcedPauses = new Set<string>();
	/** Snag scopes this runtime observed as promoted, so one that stops being promoted is observed clear. */
	private readonly noticedSnags = new Set<string>();

	constructor(deps: RoutineSchedulerDeps) {
		this.deps = deps;
		this.holder = { sessionId: deps.parentSessionId, scope: deps.scope };
		this.unsubscribe = [
			deps.store.subscribe(() => this.wake()),
			deps.subscribeExecution(() => this.wake()),
			deps.hostEvents.subscribe(() => this.wake()),
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
			() => {
				this.faults.delete("pass");
				this.settled(pass, this.stepFailed);
			},
			(error) => {
				this.report("pass", error);
				this.settled(pass, true);
			},
		);
		return pass;
	}

	/**
	 * Away only: whether the last claim left due runs for lack of room under the away spend bound, and the earliest
	 * instant a charge ends by time (absent when room returns only with a store change).
	 */
	awaySpendWait(): { readonly retryAt?: number } | undefined {
		return this.awayWait && (this.awayWait.retryAt === undefined ? {} : { retryAt: this.awayWait.retryAt });
	}

	run(routineId: string, expectedRevision: number | undefined, commandId: string): string {
		if (!this.active) throw new Error("Routine scheduler is disposed.");
		const definition = this.deps.store.getRoutine(routineId);
		const saved = definition && routineReceiptOrigin(definition);
		if (saved) this.deps.captureOriginGuard(saved)();
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
			// A run whose bodies were dropped was delivered, its notifications marked delivered before that: it owns none,
			// and its brief no longer rebuilds the dispatched text.
			if ("bodiesElided" in occurrence.trigger && occurrence.trigger.bodiesElided) continue;
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
		for (const unsubscribe of [...this.unsubscribe, this.unsubscribeCapacity]) {
			try {
				unsubscribe?.();
			} catch (error) {
				this.warn(error);
			}
		}
	}

	/**
	 * Disposes, then joins the in-flight pass and parent deliveries. A settled pass or delivery observed the disposal
	 * before its next store write, so nothing this owner started writes after the join.
	 */
	async close(): Promise<void> {
		this.dispose();
		await Promise.allSettled([this.pass, ...this.deliveries.values()]);
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

	/** Every session's unfinished runs: one of them holds its routine's `readyBy` window shut, as the claim reads it. */
	private unfinishedOccurrences(): readonly RoutineOccurrence[] {
		return this.deps.store.listRoutineOccurrences({
			phases: ROUTINE_UNFINISHED_PHASES,
			limit: MAX_ROUTINE_OCCURRENCES,
		});
	}

	private request(occurrence: RoutineOccurrence): RoutineWorkerRequest {
		const snapshot = occurrence.definition.executionSnapshot;
		if (!snapshot || !occurrence.dispatchKey) throw new Error("Routine occurrence has no saved execution identity.");
		return routineWorkerRequest(occurrence, snapshot.savedIntent, occurrence.dispatchKey);
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

	/**
	 * One scheduling pass. Results are delivered first, so their acknowledgement frees journal room for the claim. Each
	 * step (a delivery read, one occurrence's reconciliation or dispatch, the claim) is isolated: a failing step is
	 * reported once and retried after `RETRY_DELAY_MS` while every other step of this session still runs.
	 */
	private async runPass(): Promise<RoutineTickResult> {
		const result: RoutineTickResult = { dispatched: [], failed: [] };
		this.stepFailed = false;
		this.deps.store.reload();
		this.attempt("undeliverable", () => this.settleUndeliverable());
		this.attempt("delivery", () => this.deliverPending());
		// A fault about an occurrence or routine that no longer exists is forgotten.
		const present = new Set(this.occurrences().map((entry) => entry.occurrenceId));
		const routines = new Set(this.deps.store.listRoutines(this.holder).map((routine) => routine.routineId));
		for (const unit of this.faults.keys()) {
			const separator = unit.indexOf("|");
			if (separator < 0) continue;
			const subject = unit.slice(separator + 1);
			const aboutRoutine = unit.startsWith("routine|") || unit.startsWith("away|") || unit.startsWith("share|");
			if (!(aboutRoutine ? routines : present).has(subject)) this.faults.delete(unit);
		}
		const pendingIds = new Set(
			this.occurrences()
				.filter((entry) => entry.phase === "pending" || entry.phase === "claimed")
				.map((entry) => entry.occurrenceId),
		);
		for (const id of this.deferred.keys()) if (!pendingIds.has(id)) this.deferred.delete(id);
		for (const occurrence of this.occurrences()) {
			if (!this.active) return result;
			// Away, only runs dispatched away are this host's to reconcile; the parent reconciles its own when it opens.
			if (this.deps.away && occurrence.executor !== "away") continue;
			if (occurrence.phase === "dispatching" || occurrence.phase === "running" || occurrence.phase === "uncertain")
				this.attempt(`reconcile|${occurrence.occurrenceId}`, () => this.reconcile(occurrence));
		}
		// Ending needs no dispatch: an ended routine is removed even while workers cannot start.
		this.attempt("retire", () => this.retire());
		this.attempt("worker-watches", () => this.dropWatchesOfEndedWorkers());
		if (this.deps.canDispatch()) {
			this.attempt("claim", () => this.claim());
			for (const occurrence of this.occurrences()) {
				if (!this.active) return result;
				if (
					occurrence.phase !== "claimed" ||
					this.deferred.get(occurrence.occurrenceId) === this.capacityRevision ||
					occurrence.claim?.owner !== this.deps.owner ||
					(!this.deps.canUseOrigin(occurrence.parentOrigin) && !this.claimedAway(occurrence))
				)
					continue;
				const unit = `dispatch|${occurrence.occurrenceId}`;
				try {
					await this.dispatch(occurrence, result);
					this.faults.delete(unit);
				} catch (error) {
					this.fail(unit, error);
				}
			}
		}
		this.attempt("delivery", () => this.deliverPending());
		const parent = this.deps.delivery;
		if (parent) this.attempt("notices", () => this.observeRoutineStates(parent));
		return result;
	}

	/**
	 * Observes, for each routine of this session, the kept states the owner acts on: a pause after failed runs (from its
	 * durable record, so a restart finds the notice already saved), a time zone this runtime cannot place, and each snag
	 * its progress record counts at least {@link PROMOTED_SNAG_RUNS} times while unresolved (one notice per snag episode).
	 */
	private observeRoutineStates(parent: RoutineResultDelivery): void {
		const promoted = new Set<string>();
		for (const routine of this.deps.store.listRoutines(this.holder)) {
			if (routine.target.kind !== "session") continue;
			const pause = routine.failurePause;
			if (pause) {
				const key = `${routine.routineId}:${pause.occurrenceId}`;
				if (!this.announcedPauses.has(key)) {
					this.announcedPauses.add(key);
					harnessLog.warn("routines", "a routine was paused after failed runs", {
						routineId: routine.routineId,
						after: pause.after,
					});
				}
			}
			parent.noticeRoutineState(
				"routine-paused",
				routine.routineId,
				pause && {
					reason: `${routine.routineId}:${pause.occurrenceId}`,
					text: `Routine ${routine.routineId} was paused after ${pause.after} failed runs in a row and stays paused until the owner resumes it.`,
					// The failed run's own words: the model reads them fenced as data, the owner's line does not carry them.
					evidence: `The last run reported:\n${pause.lastError}`,
				},
			);
			const schedule = routine.schedule;
			parent.noticeRoutineState(
				"routine-unschedulable",
				routine.routineId,
				schedule.kind === "calendar" && routineZoneUnsupported(schedule) !== undefined
					? {
							reason: `${routine.routineId}:${routine.incarnationId}:${schedule.timeZone}`,
							text: `Routine ${routine.routineId} cannot be scheduled: time zone ${JSON.stringify(schedule.timeZone)} is not supported by this runtime, so it does not run until the owner changes the zone or a runtime that supports it opens the session.`,
						}
					: undefined,
			);
			for (const snag of promotedRoutineSnags(routine.progress)) {
				const scope = `${routine.routineId}:snag:${snag.signature}`;
				promoted.add(scope);
				this.noticedSnags.add(scope);
				// A paused or off routine runs nothing: the headline says so first, and its
				// reason changes with that state, so the notice is told again when the state changes.
				const held =
					routine.failurePause !== undefined
						? "paused until the owner resumes it"
						: !routine.enabled
							? "off until the owner enables it"
							: undefined;
				const stumbling = `keeps stumbling on the same thing (${snag.seenCount} runs so far).`;
				// The snag's own words, as the run wrote them: fenced for the model, never part of the owner's line.
				const evidence = [
					`Where the run stumbled: ${snag.what}`,
					...(snag.remedy ? [`The last remedy tried: ${snag.remedy}`] : []),
				].join("\n");
				parent.noticeRoutineState("routine-snag", scope, {
					reason: `${routine.routineId}:${snag.signature}:${snag.firstSeenAt}:${held === undefined ? "active" : "held"}`,
					text:
						held === undefined
							? `Routine ${routine.routineId} ${stumbling} A note through the routine tool reaches its next run.`
							: `Routine ${routine.routineId} is ${held}; a note through the routine tool reaches its first run after that. It ${stumbling}`,
					evidence,
				});
			}
		}
		// A snag that resolved, was reset or left with its routine ends its notice.
		for (const scope of this.noticedSnags) {
			if (promoted.has(scope)) continue;
			this.noticedSnags.delete(scope);
			parent.noticeRoutineState("routine-snag", scope, undefined);
		}
	}

	private eligibleRoutines(): RoutineDefinitionView[] {
		return this.deps.store.listRoutines(this.holder).filter((routine) => {
			const origin = routineReceiptOrigin(routine);
			return origin === undefined || this.deps.canUseOrigin(origin);
		});
	}

	/**
	 * Hands this session's ended routines whose runs are all delivered to the store for removal. A routine still
	 * waiting on a run or a delivery is left: that settlement wakes a later pass.
	 */
	private retire(): void {
		// Away, the closed parent's ended routines are retired when it opens: their notice needs its receipt origin.
		if (this.deps.away) return;
		const nowMs = this.deps.timers.now();
		const occurrences = this.occurrences();
		const ended = this.eligibleRoutines().filter(
			(routine) => routineEnded(routine, nowMs) !== undefined && routineOccurrencesSettled(occurrences, routine),
		);
		if (ended.length === 0) return;
		const retired = this.deps.store.retireEndedRoutines({
			nowMs,
			owner: this.deps.owner,
			leaseMs: CLAIM_LEASE_MS,
			parentSessionId: this.deps.parentSessionId,
			receiptOrigin: this.deps.getReceiptOrigin(),
			routineIds: ended.map((routine) => routine.routineId),
		});
		for (const routineId of retired.retired)
			harnessLog.info("routines", "an ended routine was removed", { routineId });
		if (retired.journalFull)
			this.report(
				"retire-journal",
				"An ended routine is waiting to be removed: the routine journal shared by this agent directory's sessions has no room for its notice until delivered runs leave it.",
			);
		else this.faults.delete("retire-journal");
	}

	/** Deletes the watches of this session that a worker runtime armed and that runtime can no longer be woken for (retired, cancelled, gone). */
	private dropWatchesOfEndedWorkers(): void {
		const live = this.deps.workerRuntimeLive;
		if (!live) return;
		for (const routine of this.deps.store.listRoutines(this.holder)) {
			const { wake } = routine;
			if (wake?.kind !== "worker" || wake.parentSessionId !== this.deps.parentSessionId) continue;
			if (live(wake.runtimeId)) continue;
			if (this.deps.store.deleteRoutine(routine.routineId, routine.revision, this.deps.timers.now()))
				harnessLog.info("routines", "a watch was dropped with the worker that armed it", {
					routineId: routine.routineId,
				});
		}
	}

	/** Claims what is due for this session: clock slots, recoverable occurrences and event attempts. */
	private claim(): void {
		const nowMs = this.deps.timers.now();
		const away = this.deps.away;
		const routines = this.deps.store.listRoutines(this.holder);
		const eligibleRoutines = routines.filter((routine) => this.schedulable(routine));
		const eligibleRoutineIds = eligibleRoutines.map((routine) => routine.routineId);
		if (away) {
			// A due routine this host cannot run is recorded on the routine once, never held silently.
			const unfinished = this.unfinishedOccurrences();
			const refusals = routines.flatMap((routine) => {
				const reason = this.awayUnrunnable(routine);
				return reason !== undefined &&
					routineOpensAt(routine, unfinished) <= nowMs &&
					routine.awayRefusal?.reason !== reason
					? [{ routineId: routine.routineId, reason }]
					: [];
			});
			if (refusals.length > 0) {
				this.deps.store.recordRoutineAwayRefusals({ refusals, nowMs });
				for (const { routineId, reason } of refusals)
					this.report(`away|${routineId}`, `Routine ${routineId} was not run away: ${reason}`);
			}
		}
		// A run that could not run while this session was closed is reported once, before its slot runs here.
		else
			for (const routine of routines)
				if (routine.awayRefusal && routine.target.kind === "session")
					this.report(
						`away|${routine.routineId}`,
						`Routine ${routine.routineId} did not run while this session was closed: ${routine.awayRefusal.reason}`,
					);
		const eventRoutines = eligibleRoutines.filter(
			(routine) =>
				routine.enabled &&
				routineEnded(routine, nowMs) === undefined &&
				routine.schedule.kind === "event" &&
				routine.schedule.source !== "watch" &&
				routine.target.kind === "session",
		);
		// Host events are read only while an event routine can be decided; other sessions never load the ledger here.
		const hostEvents = eventRoutines.length > 0 ? this.deps.hostEvents.feed() : undefined;
		// Away, a run already claimed away is reclaimed whatever its origin or authority reads now: its dispatch either
		// runs it or releases it, so no run away is left holding its host and its charge.
		const recoverable = this.occurrences().filter(
			(entry) =>
				this.deferred.get(entry.occurrenceId) !== this.capacityRevision &&
				(this.claimedAway(entry) ||
					(this.deps.canUseOrigin(entry.parentOrigin) &&
						(!away ||
							(entry.target.kind === "session" &&
								entry.definition.executionSnapshot !== undefined &&
								away.refusal(entry.definition.executionSnapshot.savedIntent) === undefined)))) &&
				(entry.phase === "pending" ||
					(entry.phase === "claimed" && entry.claim && entry.claim.leaseUntil <= nowMs)),
		);
		if (
			this.nextScheduledAt(nowMs) > nowMs &&
			recoverable.length === 0 &&
			(hostEvents === undefined || !this.hasEventWork(eventRoutines, hostEvents))
		) {
			this.journalFull = false;
			this.shareWait = new Set();
			this.awayWait = undefined;
			this.awayHeld = new Set();
			this.faults.delete("journal");
			return;
		}
		const claim = this.deps.store.claimDueRoutineOccurrences({
			nowMs,
			owner: this.deps.owner,
			leaseMs: CLAIM_LEASE_MS,
			limit: CLAIM_BATCH_SIZE,
			parentSessionId: this.deps.parentSessionId,
			eligibleRoutineIds,
			eligibleOccurrenceIds: recoverable.map((occurrence) => occurrence.occurrenceId),
			// Away, only pinned routines run, so no origin is captured from the closed session.
			...(away ? { away: away.gate() } : { receiptOrigin: this.deps.getReceiptOrigin() }),
			...(hostEvents ? { hostEvents } : {}),
		});
		for (const { routineId, reason } of claim.unschedulable)
			this.report(`routine|${routineId}`, `Routine ${routineId} cannot be scheduled: ${reason}`);
		this.shareWait = new Set(claim.journalShareFull);
		for (const routineId of claim.journalShareFull)
			this.report(
				`share|${routineId}`,
				`Routine ${routineId} is waiting: it already holds ${ROUTINE_JOURNAL_SHARE} unfinished, uncertain or undelivered runs, its share of the routine journal; its due run starts once one of them settles.`,
			);
		for (const unit of this.faults.keys())
			if (unit.startsWith("share|") && !this.shareWait.has(unit.slice("share|".length))) this.faults.delete(unit);
		this.awayWait =
			claim.awayRefused.length > 0
				? {
						routines: new Set(claim.awayRefused),
						...(claim.awayRetryAt === undefined ? {} : { retryAt: claim.awayRetryAt }),
					}
				: undefined;
		this.awayHeld = new Set(claim.awayHeld);
		for (const routineId of [...claim.awayRefused, ...claim.awayHeld])
			this.report(
				`away|${routineId}`,
				`Routine ${routineId} was not run away: ${this.deps.store.getRoutine(routineId)?.awayRefusal?.reason ?? "the away spend bound has no room for another run."}`,
			);
		this.journalFull = claim.journalFull;
		if (claim.journalFull)
			this.report(
				"journal",
				"Due routines are waiting: the routine journal shared by this agent directory's sessions is full of unfinished, uncertain or undelivered runs, and only finished, delivered runs leave it.",
			);
		else this.faults.delete("journal");
	}

	/**
	 * Whether a claim would move an event routine: its cursor advances or a current matching attempt has no
	 * occurrence yet. Every ledger commit wakes a pass; this keeps passes with nothing to decide off the store's
	 * locked claim path.
	 */
	private hasEventWork(routines: readonly RoutineDefinitionView[], feed: RoutineHostEventFeed): boolean {
		const occurrences = this.occurrences();
		const known = new Set(occurrences.flatMap((occurrence) => routineOccurrenceReplayKeys(occurrence)));
		for (const routine of routines) {
			if (
				routine.schedule.kind !== "event" ||
				routine.schedule.source === "watch" ||
				routine.cursor.kind !== "event"
			)
				continue;
			if (
				occurrences.some(
					(occurrence) =>
						occurrence.routineId === routine.routineId &&
						(occurrence.phase === "pending" || occurrence.phase === "claimed"),
				)
			)
				continue;
			const decision = decideRoutineEvents(routine.schedule, routine.cursor, feed);
			if (!isDeepStrictEqual(decision.cursor, routine.cursor)) return true;
			for (const fact of decision.candidates) if (!known.has(routineEventKey(routine, fact.event))) return true;
		}
		return false;
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
			harnessLog.warn("routines", "a routine run was interrupted; its outcome is unknown and it is not repeated", {
				routineId: occurrence.routineId,
				occurrenceId: occurrence.occurrenceId,
			});
			this.deps.store.markRoutineUncertain({
				occurrenceId: occurrence.occurrenceId,
				claimToken: occurrence.claim.token,
				reason:
					"Dispatch was interrupted and no exact durable execution could be established; it was not repeated.",
				recipient: this.deps.parentSessionId,
				nowMs: this.deps.timers.now(),
				facts: { reasonCode: "dispatch_interrupted" },
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
			// Passed whole: the store cleans, redacts and bounds every summary before it cuts it (`resultSummaryText`).
			summary:
				execution.result?.summary ??
				execution.record.reasonDetail ??
				execution.record.reasonCode ??
				execution.record.status,
			recipient: this.deps.parentSessionId,
			nowMs: this.deps.timers.now(),
			// A run away settles its spend in the write that ends it, whichever host ends it.
			...(occurrence.executor === "away"
				? { awaySpentUsd: this.deps.worker.spentUsd(this.request(occurrence)) }
				: {}),
			// Where the task stands: code facts of the result (its reason code and failing step) and the run's own report.
			facts: routineRunFacts(execution),
		};
		// Only a routine whose brief named an end the owner stated acts on a run reporting it met; for any other the
		// report is dropped and the drop reported once.
		let conditionMet: { conditionMet: true } | undefined;
		if (outcome.outcome === "succeeded" && execution.result?.conditionMet === true) {
			if (occurrence.definition.origin?.endCondition !== undefined) conditionMet = { conditionMet: true };
			else
				this.report(
					`condition|${occurrence.routineId}`,
					`Routine ${occurrence.routineId}: a run reported an end condition met, but the routine has no stated end; the report was ignored.`,
				);
		}
		// A resolved uncertainty is never quiet: the parent was already told this run's outcome was unknown.
		if (occurrence.phase === "uncertain")
			this.deps.store.resolveUncertainRoutineOccurrence({
				...outcome,
				dispatchKey: occurrence.dispatchKey!,
				executionRef: { taskId: execution.taskId, attemptId: execution.attemptId },
				...conditionMet,
			});
		else
			this.deps.store.finishRoutineOccurrence({
				...outcome,
				...(outcome.outcome === "succeeded" && execution.result?.ownerUpdate === "none"
					? { ownerUpdate: "none" as const }
					: {}),
				...conditionMet,
			});
		harnessLog.log(outcome.outcome === "failed" ? "warn" : "info", "routines", "a routine run ended", () => ({
			routineId: occurrence.routineId,
			occurrenceId: occurrence.occurrenceId,
			outcome: outcome.outcome,
		}));
	}

	/** Away, a run claimed away is this host's to dispatch or release, whatever its origin reads now. */
	private claimedAway(occurrence: RoutineOccurrence): boolean {
		return this.deps.away !== undefined && occurrence.executor === "away";
	}

	/**
	 * Returns a claim no executor took to pending, for whichever host may run it (the parent's own once it opens).
	 * Away, a run that can no longer run away is released the same way, with its reason recorded on its routine.
	 */
	private release(occurrence: RoutineOccurrence, claimToken: string, reason: string): void {
		this.deps.store.deferRoutineOccurrence({
			occurrenceId: occurrence.occurrenceId,
			claimToken,
			nowMs: this.deps.timers.now(),
		});
		if (this.deps.away)
			this.report(`away|${occurrence.routineId}`, `Routine ${occurrence.routineId} was not run away: ${reason}`);
	}

	/**
	 * After the host's guard refused a dispatch: with no execution of the run, nothing was handed to an executor and the
	 * claim is released; an execution that exists is recorded (exactly once). False when no execution can be
	 * established exactly (conflicting identity): the caller marks the run uncertain.
	 */
	private settleRefused(occurrence: RoutineOccurrence, claimToken: string, refused: RoutineAdmissionRefused): boolean {
		let execution: RoutineWorkerState | undefined;
		try {
			execution = this.deps.worker.find(this.request(occurrence));
		} catch {
			return false;
		}
		if (execution) this.recordExecution(occurrence, execution);
		else this.release(occurrence, claimToken, refused.message);
		return true;
	}

	private async dispatch(claimed: RoutineOccurrence, result: RoutineTickResult): Promise<void> {
		const guard = this.deps.captureOriginGuard(claimed.parentOrigin);
		// Every refusal of the host's guard is typed, wherever the worker layer calls it; the first one is kept.
		const guarded: { refused?: RoutineAdmissionRefused } = {};
		const assertOrigin = (): void => {
			try {
				guard();
			} catch (error) {
				guarded.refused ??=
					error instanceof RoutineAdmissionRefused ? error : new RoutineAdmissionRefused(errorText(error));
				throw guarded.refused;
			}
		};
		const claimToken = claimed.claim!.token;
		const intent = claimed.definition.executionSnapshot?.savedIntent;
		const awayReason = this.deps.away && (intent ? this.deps.away.refusal(intent) : AWAY_UNPINNED_REASON);
		if (awayReason) {
			this.release(claimed, claimToken, awayReason);
			return;
		}
		try {
			assertOrigin();
		} catch (error) {
			this.release(claimed, claimToken, errorText(error));
			return;
		}
		const dispatchKey = `routine:${claimed.occurrenceId}`;
		this.deps.store.markRoutineDispatching({
			occurrenceId: claimed.occurrenceId,
			claimToken,
			dispatchKey,
			nowMs: this.deps.timers.now(),
		});
		const occurrence = { ...claimed, phase: "dispatching" as const, dispatchKey };
		try {
			if (occurrence.trigger.kind === "watch") {
				// A firing taken before watches woke their armer directly: it is delivered as the wake it is, never run by a worker.
				this.deps.store.finishRoutineOccurrence({
					occurrenceId: occurrence.occurrenceId,
					claimToken,
					outcome: "succeeded",
					summary: WATCH_WAKE_SUMMARY,
					recipient: this.deps.parentSessionId,
					nowMs: this.deps.timers.now(),
					facts: { reasonCode: "delivered" },
				});
			} else if (occurrence.target.kind === "session") {
				this.unsubscribeCapacity ??= this.deps.subscribeCapacity(() => {
					this.capacityRevision++;
					this.wake();
				});
				const capacityRevision = this.capacityRevision;
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
					// The guard refused: a run with no execution was handed to no executor; one that has an execution keeps it.
					if (guarded.refused) {
						if (!this.settleRefused(occurrence, claimToken, guarded.refused)) throw guarded.refused;
						return;
					}
					if (
						outcome.skipReason === "worker_specialist_busy" ||
						outcome.skipReason === "worker_cleanup_pending" ||
						outcome.skipReason.startsWith("worker_specialist_release_retained:")
					) {
						// The executor confirmed no admission. Keep this exact occurrence across restart;
						// only a later capacity event permits another attempt in this live scheduler. Away, the release
						// also frees the host: the run waits for a later host or the parent's own scheduler.
						this.deferred.set(occurrence.occurrenceId, capacityRevision);
						this.release(
							occurrence,
							claimToken,
							`its worker could not take it now (${outcome.skipReason}), for example while a turn of its session is pending on it; it waits for a later host or for the session to open.`,
						);
						return;
					}
					this.deps.store.finishRoutineOccurrence({
						occurrenceId: occurrence.occurrenceId,
						claimToken,
						outcome: "failed",
						summary: outcome.skipReason,
						recipient: this.deps.parentSessionId,
						nowMs: this.deps.timers.now(),
						// Nothing started, so nothing was spent.
						...(occurrence.executor === "away" ? { awaySpentUsd: 0 } : {}),
						facts: { reasonCode: outcome.skipReason, step: "start" },
					});
					harnessLog.warn("routines", "a routine run did not start", {
						routineId: occurrence.routineId,
						occurrenceId: occurrence.occurrenceId,
						reason: outcome.skipReason,
					});
					result.failed.push(`${occurrence.routineId}: ${outcome.skipReason}`);
					return;
				}
				this.deferred.delete(occurrence.occurrenceId);
				const missedSlots = occurrence.trigger.kind === "schedule" ? occurrence.trigger.missedCount : 0;
				harnessLog.log(
					missedSlots > 0 ? "warn" : "info",
					"routines",
					missedSlots > 0 ? "a routine run started after missed slots" : "a routine run started",
					() => ({
						routineId: occurrence.routineId,
						occurrenceId: occurrence.occurrenceId,
						away: occurrence.executor === "away",
						missedSlots,
					}),
				);
				this.recordExecution(occurrence, outcome.state);
			} else {
				const summary = await this.deps.dispatchMessage(occurrence);
				if (!this.active) return;
				this.deps.store.finishRoutineOccurrence({
					occurrenceId: occurrence.occurrenceId,
					claimToken,
					outcome: "succeeded",
					summary,
					recipient: this.deps.parentSessionId,
					nowMs: this.deps.timers.now(),
					facts: { reasonCode: "delivered" },
				});
			}
			result.dispatched.push(occurrence.routineId);
		} catch (error) {
			if (!this.active) return;
			if (
				guarded.refused &&
				occurrence.target.kind === "session" &&
				this.settleRefused(occurrence, claimToken, guarded.refused)
			)
				return;
			const detail =
				cleanRedactBound(error instanceof Error ? error.message : String(error), MAX_ROUTINE_SUMMARY_CHARS) ||
				"Routine dispatch failed.";
			this.deps.store.markRoutineUncertain({
				occurrenceId: occurrence.occurrenceId,
				claimToken,
				reason: detail,
				recipient: this.deps.parentSessionId,
				nowMs: this.deps.timers.now(),
				facts: { reasonCode: "dispatch_failed", step: "dispatch" },
			});
			harnessLog.warn("routines", "a routine run's dispatch failed; its outcome is unknown", {
				routineId: occurrence.routineId,
				occurrenceId: occurrence.occurrenceId,
			});
			result.failed.push(`${occurrence.routineId}: ${detail}`);
		}
	}

	/**
	 * Settles each pending result whose origin can never pass here ({@link RoutineResultDelivery.originLoss}) as a delivery
	 * settles it, with an `undeliverable:` marker naming the loss in place of a parent input, and warns the owner once the
	 * settlement is durable. A result whose origin may still pass (another branch, not yet durable) keeps waiting.
	 */
	private settleUndeliverable(): void {
		const parent = this.deps.delivery;
		if (!parent || !this.active) return;
		for (const { occurrence, result } of this.deps.store.listPendingRoutineDeliveries(
			this.deps.parentSessionId,
			2 * MAX_ROUTINE_OCCURRENCES,
		)) {
			if (this.deliveries.has(occurrence.occurrenceId)) continue;
			const loss = parent.originLoss(occurrence.parentOrigin);
			if (!loss) continue;
			this.attempt(`undeliverable|${occurrence.occurrenceId}`, () => {
				if (result.outcome !== "uncertain") parent.acknowledgeWorkerNotification(occurrence);
				this.deps.store.acknowledgeRoutineDelivery({
					occurrenceId: occurrence.occurrenceId,
					recipient: result.recipient,
					resultDigest: result.digest,
					deliveryMarker: routineUndeliverableMarker(loss),
					nowMs: this.deps.timers.now(),
				});
				harnessLog.warn("routines", "a routine result can never be delivered and was settled undeliverable", {
					routineId: occurrence.routineId,
					occurrenceId: occurrence.occurrenceId,
					loss,
				});
				this.deps.warn(routineUndeliverableWarning(occurrence.routineId, loss));
			});
		}
	}

	private deliverPending(): void {
		const parent = this.deps.delivery;
		if (!parent || !this.active || this.deliveries.size > 0) return;
		const pending = this.deps.store
			.listPendingRoutineDeliveries(this.deps.parentSessionId, 2 * MAX_ROUTINE_OCCURRENCES)
			.find((entry) => this.deps.canUseOrigin(entry.occurrence.parentOrigin));
		if (!pending) return;
		const { occurrence, result } = pending;
		// One quiet result per routine waits for the owner; later quiet runs are acknowledged against it and stay in history.
		const delivery = Promise.resolve()
			.then(() => parent.findCarriedQuietResult(pending) ?? parent.deliver(pending))
			.then((receipt) => {
				if (!this.active) return;
				if (result.outcome !== "uncertain") parent.acknowledgeWorkerNotification(occurrence);
				this.deps.store.acknowledgeRoutineDelivery({
					occurrenceId: occurrence.occurrenceId,
					recipient: result.recipient,
					resultDigest: result.digest,
					deliveryMarker: receipt.entryId,
					nowMs: this.deps.timers.now(),
				});
			});
		this.deliveries.set(occurrence.occurrenceId, delivery);
		const unit = `delivery|${occurrence.occurrenceId}`;
		void delivery.then(
			() => {
				this.deliveries.delete(occurrence.occurrenceId);
				this.faults.delete(unit);
				this.wake();
			},
			(error) => {
				this.deliveries.delete(occurrence.occurrenceId);
				// A failure while closing is no fault. A pass in flight arms the retry when it settles; arm() stops when inactive.
				if (this.active) this.fail(unit, error);
				if (!this.pass) this.arm(this.deps.timers.now() + RETRY_DELAY_MS);
			},
		);
	}

	private settled(pass: Promise<RoutineTickResult>, retry = false): void {
		if (this.pass !== pass) return;
		this.pass = undefined;
		if (!this.active) return;
		if (retry) {
			this.arm(this.deps.timers.now() + RETRY_DELAY_MS);
			return;
		}
		if (this.dirty) {
			this.wake();
			return;
		}
		try {
			const nowMs = this.deps.timers.now();
			const waiting = new Set([...this.shareWait, ...(this.awayWait?.routines ?? []), ...this.awayHeld]);
			let next = this.nextScheduledAt(nowMs, this.journalFull, waiting);
			if (this.awayWait?.retryAt !== undefined) next = Math.min(next, this.awayWait.retryAt);
			for (const occurrence of this.occurrences())
				if (
					occurrence.claim &&
					(occurrence.phase === "dispatching" ||
						(occurrence.phase === "claimed" &&
							(this.deps.canUseOrigin(occurrence.parentOrigin) || this.claimedAway(occurrence))))
				)
					next = Math.min(next, occurrence.claim.leaseUntil);
			if (Number.isFinite(next)) this.arm(Math.max(nowMs + RETRY_DELAY_MS, next));
			this.faults.delete("schedule");
		} catch (error) {
			this.report("schedule", error);
			this.arm(this.deps.timers.now() + RETRY_DELAY_MS);
		}
	}

	/**
	 * The earliest instant a routine of this session can be claimed: its next slot after a backward clock step is undone
	 * (`rebasedRoutineCursor`, as the claim persists it), or the opening of that slot's `readyBy` window
	 * (`routineStartWindow`, as the claim reads it), and never before the routine's last edit. An event routine
	 * contributes only an edit still ahead of the clock. Every routine, paused ones included, contributes its end time
	 * while that is ahead (not away, where nothing is retired). With `waitingForRoom`, a routine already due is left
	 * out: the last claim found no journal room for it, and only a store change (which wakes the scheduler) can make
	 * room; the same holds for a due routine in `waiting`: one holding its whole journal share, or one the away spend
	 * bound refused, whose room also returns as the away spend window passes.
	 */
	private nextScheduledAt(nowMs: number, waitingForRoom = false, waiting?: ReadonlySet<string>): number {
		let next = Number.POSITIVE_INFINITY;
		const previousSlots = new Map<string, number | undefined>();
		const unfinished = this.unfinishedOccurrences();
		for (const routine of this.deps.store.listRoutines(this.holder)) {
			if (!this.schedulable(routine)) {
				// Away, a routine this host cannot run still wakes it once when due, so its refusal is recorded.
				const reason = this.awayUnrunnable(routine);
				if (reason !== undefined && routine.awayRefusal?.reason !== reason)
					next = Math.min(next, routineOpensAt(routine, unfinished));
				continue;
			}
			// A routine's end wakes the retire step, paused or not. Once ended it has no alarm: the settlement of its last
			// run or delivery wakes the pass that removes it.
			const end = this.deps.away || routine.schedule.kind === "once" ? undefined : routine.schedule.expiresAt;
			if (routineEnded(routine, nowMs) !== undefined) continue;
			let due: number | undefined;
			try {
				due = routine.enabled ? this.routineDueAt(routine, nowMs, previousSlots, unfinished) : undefined;
			} catch (error) {
				// Only this routine is left out of the alarm; the claim skips and reports it the same way.
				this.report(
					`routine|${routine.routineId}`,
					`Routine ${routine.routineId} cannot be scheduled: ${errorText(error)}`,
				);
				due = undefined;
			}
			if (end !== undefined) due = due === undefined ? end : Math.min(due, end);
			if (due === undefined || (due <= nowMs && (waitingForRoom || waiting?.has(routine.routineId)))) continue;
			next = Math.min(next, due);
		}
		this.previousSlots = previousSlots;
		return next;
	}

	/**
	 * Whether this host schedules the routine: a pinned routine only while its origin is usable here, and away only a
	 * pinned session clock routine.
	 */
	private schedulable(routine: RoutineDefinitionView): boolean {
		const origin = routineReceiptOrigin(routine);
		if (origin && !this.deps.canUseOrigin(origin)) return false;
		const away = this.deps.away;
		return (
			!away ||
			(routine.executionSnapshot !== undefined &&
				routine.target.kind === "session" &&
				routine.schedule.kind !== "event" &&
				away.refusal(routine.executionSnapshot.savedIntent) === undefined)
		);
	}

	/**
	 * Away only: why an enabled clock routine of this parent cannot run here, so it is reported instead of held
	 * silently. Event routines need the open session's sealed sources and are not this host's to report.
	 */
	private awayUnrunnable(routine: RoutineDefinitionView): string | undefined {
		const away = this.deps.away;
		if (
			!away ||
			!routine.enabled ||
			routine.target.kind !== "session" ||
			routine.target.parentSessionId !== this.deps.parentSessionId ||
			routine.schedule.kind === "event" ||
			// An ended routine has no run left; the parent retires it when it opens.
			routineEnded(routine, this.deps.timers.now()) !== undefined
		)
			return undefined;
		const snapshot = routine.executionSnapshot;
		if (!snapshot) return AWAY_UNPINNED_REASON;
		if (!this.deps.canUseOrigin(snapshot.savedIntent.receiptOrigin)) return AWAY_OFF_BRANCH_REASON;
		return away.refusal(snapshot.savedIntent);
	}

	private routineDueAt(
		routine: RoutineDefinitionView,
		nowMs: number,
		previousSlots: Map<string, number | undefined>,
		unfinished: readonly RoutineOccurrence[],
	): number | undefined {
		const editedAt = Date.parse(routine.updatedAt);
		if (routine.schedule.kind === "event") return editedAt > nowMs ? editedAt : undefined;
		if (routineZoneUnsupported(routine.schedule) !== undefined) {
			// Only the claim that records the routine's one notice is due; its slots cannot be placed here.
			const slot = routine.cursor.kind === "calendar" ? routine.cursor.nextAt : null;
			return slot !== null && (routine.lastRunAt ?? Number.NEGATIVE_INFINITY) < slot
				? Math.max(slot, editedAt)
				: undefined;
		}
		const key = `${routine.routineId}:${routine.revision}:${JSON.stringify(routine.cursor)}`;
		const previousSlot = this.previousSlots.has(key)
			? this.previousSlots.get(key)
			: routinePreviousSlot(routine.schedule, routine.cursor);
		previousSlots.set(key, previousSlot);
		const cursor = rebasedRoutineCursor(routine.schedule, routine.cursor, nowMs, previousSlot) ?? routine.cursor;
		const window = routineStartWindow(routine, cursor, unfinished);
		return window === undefined ? undefined : Math.max(window.opensAt, editedAt);
	}

	private clearAlarm(): void {
		const alarm = this.alarm;
		this.alarm = undefined;
		if (alarm) {
			try {
				alarm.stop();
			} catch (error) {
				this.warn(error);
			}
		}
	}

	/** Wakes a pass once this session's routine clock reads `atMs`, rechecking it so a suspend or clock step cannot hold it back. */
	private arm(atMs: number): void {
		if (!this.active) return;
		this.clearAlarm();
		try {
			const alarm = alarmAt(this.deps.timers, atMs, () => {
				if (this.alarm !== alarm) return;
				this.alarm = undefined;
				this.wake();
			});
			this.alarm = alarm;
			this.faults.delete("alarm");
		} catch (error) {
			this.report("alarm", error);
		}
	}

	/** Runs one isolated step of a pass; its failure is reported once and makes the pass end with a retry. */
	private attempt(unit: string, step: () => void): void {
		try {
			step();
			this.faults.delete(unit);
		} catch (error) {
			this.fail(unit, error);
		}
	}

	private fail(unit: string, error: unknown): void {
		this.stepFailed = true;
		this.report(unit, error);
	}

	/** Warns once per failing unit and reason; the same reason again stays quiet until the unit recovers. */
	private report(unit: string, error: unknown): void {
		const reason = errorText(error);
		if (this.faults.get(unit) === reason) return;
		this.faults.set(unit, reason);
		harnessLog.warn("routines", "routine scheduling reported a fault", () => ({
			step: unit.split("|")[0],
			subject: unit.split("|")[1],
		}));
		this.warn(error);
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
