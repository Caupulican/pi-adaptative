/**
 * Runs the routines of sessions nobody has open (away). The supervisor reads the shared routine store, decides which
 * closed parents have work it may run, and holds at most `routines.away.maxParentHosts` of them open away at once; each
 * held parent gets one routine scheduler on an away parent context (`openAwayParentContext`). Their results stay
 * pending in the store for the parent's own scheduler to deliver when it opens.
 *
 * - A parent anything else holds (a lease holder other than its host's own hold, not proven dead) is open: its own
 *   scheduler owns its routines, and a host it already has here dispatches nothing new and closes once its runs end.
 * - A due run that cannot run away is recorded on its routine with the reason (`recordRoutineAwayRefusals`), once per
 *   reason, and reported once here; the parent reports it when it opens and the slot stays due for it.
 * - The supervisor wakes on routine store changes, its own alarm (the next due time, the spend window's next exit, an
 *   open retry) and `wake()` from its owner (the daemon's lease tick, which is when a parent's holder can have died).
 * - A host is closed when it has nothing left to run; the parent's file stamp and its due work at that moment are
 *   remembered, so the same parent is not reopened until one of them changes.
 * - A closed parent with an event routine that may run away gets one event feed (`AwayEventFeed`), never one per
 *   routine: the parent's own event consumer, followed by the sources `eventSources` builds for its checkout. A decided
 *   attempt is a pending occurrence, which a host then claims like any recoverable run. The feed closes when the parent
 *   opens, its session file is gone or no such routine remains.
 */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { readSessionLeaseHolders } from "../../kernel/session/session-bundle-lifecycle.ts";
import { configFile } from "../agent-paths.ts";
import type { AuthStorage } from "../auth-storage.ts";
import { AwayParentWriteRefusal } from "../delegation/away-parent-writes.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { WorkerReceiptOrigin } from "../orchestration/worker-receipt-origin.ts";
import { isSessionAppendAnchorCurrent } from "../session-snapshot.ts";
import type { ResolvedRoutineAwaySettings } from "../settings/settings-schema.ts";
import { alarmAt, type TimerSource, type WallAlarm } from "../util/timer-port.ts";
import { AwayEventFeed, AwayEventFeedUnavailable, type AwayEventSourceFactory } from "./away-event-feed.ts";
import { type AwayParentContext, AwayParentUnavailable, openAwayParentContext } from "./away-parent-context.ts";
import {
	AWAY_LEASES_UNREADABLE_REASON,
	AWAY_NO_SESSION_FILE_REASON,
	AWAY_OFF_BRANCH_REASON,
	AWAY_UNPINNED_REASON,
	awayRunRefusal,
} from "./away-routine-admission.ts";
import {
	ROUTINE_AWAY_HELD_REASON,
	ROUTINE_AWAY_SPEND_REFUSAL,
	RoutineAdmissionRefused,
	type RoutineAwayCharge,
	type RoutineAwayClaimGate,
	type RoutineOccurrence,
	routineAwayHeld,
	routineAwaySpendRoom,
	routineEnded,
	routineJournalRoom,
	routineJournalShare,
	routineOpensAt,
} from "./routine-contract.ts";
import { RoutineSchedulerController, routineHostEventFeed } from "./routine-scheduler-controller.ts";
import type { RoutineStorePort } from "./routine-store-port.ts";
import { RoutineWorkerExecutor } from "./routine-worker-executor.ts";

/** The wait before a parent whose away context failed to open for a reason other than its transcript is tried again. */
const OPEN_RETRY_MS = 60_000;
/** The earliest the supervisor's own alarm fires after a pass. */
const MIN_ALARM_DELAY_MS = 1_000;

export interface AwayRoutineSupervisorDeps {
	/** The agent directory's shared routine store. */
	readonly store: RoutineStorePort;
	readonly agentDir: string;
	readonly timers: TimerSource;
	settings(): ResolvedRoutineAwaySettings;
	/** Diagnostics: each refusal, open failure and host warning, once per cause. */
	report(message: string): void;
	/** Shared credential owners, when the caller has them; otherwise each parent builds them as the SDK does. */
	readonly authStorage?: AuthStorage;
	readonly modelRegistry?: ModelRegistry;
	/** Builds a closed parent's event sources away; without it, event routines wait for their session. */
	readonly eventSources?: AwayEventSourceFactory;
	/** The owner's global `proactivity.ciEvents`; off, no CI source is followed away. */
	ciEvents?(): boolean;
	/** The daemon's other charges on the same away spend bound: its channel turns while no session was open. */
	otherAwayCharges?(): readonly RoutineAwayCharge[];
}

/** One closed parent held open away: its context and the routine scheduler that runs its routines on it. */
interface AwayRoutineHost {
	readonly parentSessionId: string;
	readonly context: AwayParentContext;
	readonly scheduler: RoutineSchedulerController;
}

/** What one parent has for a host to do, as the store reads now. */
interface ParentWork {
	sessionFile: string | undefined;
	/** A run away of this parent is admitted and not finished: a host must hold it. */
	active: boolean;
	/** Due work a host may run: routine slots and recoverable or uncertain occurrences. */
	readonly due: string[];
	/** Some of `due` is already charged (an uncertain run away), so a host may take it with no spend room. */
	dueWithoutRoom: boolean;
	/** The due routines among `due`, which a refusal of the whole parent is recorded on. */
	readonly dueRoutines: string[];
	/** Event routines that may run away: the parent's event feed decides them. */
	readonly eventRoutines: string[];
	/** Due routines no host could run, with why; recorded only while the parent is closed. */
	readonly refusals: { readonly routineId: string; readonly reason: string; readonly current?: string }[];
}

function emptyParentWork(): ParentWork {
	return {
		sessionFile: undefined,
		active: false,
		due: [],
		dueWithoutRoom: false,
		dueRoutines: [],
		eventRoutines: [],
		refusals: [],
	};
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function fileStamp(path: string | undefined): string {
	if (path === undefined) return "none";
	try {
		const stat = statSync(path);
		return `${stat.size}:${stat.mtimeMs}`;
	} catch {
		return "missing";
	}
}

/** Opens one closed parent away and builds the routine scheduler that runs its saved routine runs there. */
async function openAwayRoutineHost(args: {
	readonly deps: AwayRoutineSupervisorDeps;
	readonly parentSessionId: string;
	readonly sessionFile: string;
	gate(): RoutineAwayClaimGate;
	isParentOpen(): boolean;
	report(message: string): void;
}): Promise<AwayRoutineHost> {
	const { deps, parentSessionId } = args;
	const awayDispatchKeys = (): ReadonlySet<string> =>
		new Set(
			deps.store
				.listRoutineOccurrences({ parentSessionId })
				.flatMap((occurrence) =>
					occurrence.executor === "away" && occurrence.dispatchKey ? [occurrence.dispatchKey] : [],
				),
		);
	const context = await openAwayParentContext({
		agentDir: deps.agentDir,
		parentSessionId,
		sessionFile: args.sessionFile,
		timers: deps.timers,
		maxUsdPerRun: () => deps.settings().maxUsdPerRun,
		awayDispatchKeys,
		report: args.report,
		...(deps.authStorage ? { authStorage: deps.authStorage } : {}),
		...(deps.modelRegistry ? { modelRegistry: deps.modelRegistry } : {}),
	});
	try {
		// The reader is the parent's persisted file itself, so every entry it holds is persisted.
		// A parent whose file is gone has no current branch to check an origin against: its last read is not one.
		const canUseOrigin = (origin: WorkerReceiptOrigin): boolean => {
			if (fileStamp(args.sessionFile) === "missing") return false;
			const reader = context.reader();
			return (
				origin.sessionId === reader.getSessionId() &&
				(origin.sessionFile === undefined || origin.sessionFile === reader.getSessionFile()) &&
				isSessionAppendAnchorCurrent(reader, origin)
			);
		};
		const worker = new RoutineWorkerExecutor({
			getSnapshot: () => context.lifecycle.getTaskRuntimeSnapshot(),
			start: (input, signal) => context.workers.startSavedIntent(input, signal),
		});
		const contextListeners = new Set<() => void>();
		const scheduler = new RoutineSchedulerController({
			store: deps.store,
			worker,
			timers: deps.timers.port("routines"),
			parentSessionId,
			owner: randomUUID(),
			isDisposed: () => context.isClosed(),
			canDispatch: () => !args.isParentOpen(),
			getReceiptOrigin: () => {
				throw new AwayParentWriteRefusal(
					"A parent opened away captures no receipt origin; its routines are pinned.",
				);
			},
			canUseOrigin,
			captureOriginGuard: (origin) => () => {
				if (context.isClosed()) throw new RoutineAdmissionRefused("its away host closed.");
				if (args.isParentOpen()) throw new RoutineAdmissionRefused("its session opened, so the session runs it.");
				if (!canUseOrigin(origin)) throw new RoutineAdmissionRefused(AWAY_OFF_BRANCH_REASON);
			},
			subscribeContext: (listener) => {
				contextListeners.add(listener);
				return () => contextListeners.delete(listener);
			},
			subscribeExecution: (listener) => context.subscribeExecution(listener),
			hostEvents: {
				feed: () =>
					routineHostEventFeed(context.lifecycle.getTaskRuntimeSnapshot(), (sourceId) =>
						context.lifecycle.ledger.runtime.hostEvents.isSourceReady(sourceId),
					),
				// A host schedules no event routine: the parent's event feed decides them, and a host claims their runs.
				subscribe: () => () => {},
			},
			subscribeCapacity: (listener) => context.workers.getAgentControl().subscribeStateChanges(listener),
			away: { gate: () => args.gate(), refusal: (intent) => awayRunRefusal(intent, context.modelRegistry) },
			dispatchMessage: () => {
				throw new Error(
					"A host running away dispatches only session routines, through the native worker executor.",
				);
			},
			warn: args.report,
		});
		return { parentSessionId, context, scheduler };
	} catch (error) {
		await context.close();
		throw error;
	}
}

/** Supervises the hosts that run closed parents' routines away; one per agent directory, in the daemon. */
export class AwayRoutineSupervisor {
	private readonly deps: AwayRoutineSupervisorDeps;
	private readonly hosts = new Map<string, AwayRoutineHost>();
	/** Per closed parent, its one event feed, and the event routines it decides (read by the feed at each decision). */
	private readonly feeds = new Map<string, AwayEventFeed>();
	private readonly feedRoutines = new Map<string, readonly string[]>();
	/** Per parent, when a feed that failed to open is tried again. */
	private readonly feedRetryAt = new Map<string, number>();
	/** Per parent, the file stamp, due work and journal room its last host closed idle on, or its last refusal was recorded for. */
	private readonly idle = new Map<string, string>();
	/** Per parent, when a failed open is tried again. */
	private readonly retryAt = new Map<string, number>();
	/** The message last reported per cause; a cause reports again only after it cleared or its message changed. */
	private readonly reported = new Map<string, string>();
	private readonly unsubscribe: () => void;
	private alarm: WallAlarm | undefined;
	private pass: Promise<void> | undefined;
	private dirty = false;
	private disposed = false;

	constructor(deps: AwayRoutineSupervisorDeps) {
		this.deps = deps;
		this.unsubscribe = deps.store.subscribe(() => this.wake());
	}

	/** Schedules a pass; passes never overlap, and a wake during one runs another after it. */
	wake(): void {
		if (this.disposed) return;
		this.dirty = true;
		// The drain starts past this stack: its synchronous prefix writes the store (a scheduler tick), whose listener
		// calls back here, and it must find this pass in flight instead of starting a second one.
		this.pass ??= Promise.resolve().then(() => this.drain());
	}

	/** The parents held open away right now. */
	hostedParents(): readonly string[] {
		return [...this.hosts.keys()];
	}

	/**
	 * Stops waking, joins the pass in flight and closes every host. A run still executing is interrupted: its attempt
	 * is suspended and resumes when a host holds its parent again, or the parent recovers it when it opens.
	 */
	async close(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe();
		this.alarm?.stop();
		this.alarm = undefined;
		await this.pass;
		await this.closeFeeds(
			[...this.feeds.keys()],
			"the away host stopped; the session or the next away host resumes from the saved position",
		);
		await this.closeHosts([...this.hosts.keys()]);
	}

	private async drain(): Promise<void> {
		try {
			while (this.dirty && !this.disposed) {
				this.dirty = false;
				try {
					await this.runPass();
					this.reported.delete("pass");
				} catch (error) {
					this.reportOnce("pass", `Away routine supervision failed: ${errorText(error)}`);
					this.arm(this.deps.timers.port("routines").now() + OPEN_RETRY_MS);
				}
			}
		} finally {
			this.pass = undefined;
		}
	}

	private async runPass(): Promise<void> {
		const { store } = this.deps;
		const clock = this.deps.timers.port("routines");
		store.reload();
		const settings = this.deps.settings();
		if (!settings.enabled) {
			this.alarm?.stop();
			this.alarm = undefined;
			await this.closeFeeds([...this.feeds.keys()], "routines away are off in the owner's settings");
			await this.closeHosts([...this.hosts.keys()]);
			return;
		}
		const nowMs = clock.now();
		const occurrences = store.listRoutineOccurrences();
		// Recomputed after every host's claim: one parent's admitted runs can leave no room for the next parent.
		let room = routineAwaySpendRoom(occurrences, this.gate(), nowMs).fits(0);
		// A model price change can lift a refusal a parent's file stamp does not show.
		const modelsStamp = fileStamp(configFile(this.deps.agentDir, "models.json"));
		const parents = new Map<string, ParentWork>();
		const work = (parentSessionId: string): ParentWork => {
			let entry = parents.get(parentSessionId);
			if (!entry) {
				entry = emptyParentWork();
				parents.set(parentSessionId, entry);
			}
			return entry;
		};
		const refusals: { routineId: string; reason: string }[] = [];
		let next = Number.POSITIVE_INFINITY;
		let waitingForRoom = false;

		for (const routine of store.listRoutines()) {
			if (!routine.enabled || routine.target.kind !== "session") continue;
			if (routineEnded(routine, nowMs) !== undefined) continue;
			const snapshot = routine.executionSnapshot;
			const sessionFile = snapshot?.savedIntent.receiptOrigin.sessionFile;
			const reason = !snapshot
				? AWAY_UNPINNED_REASON
				: (awayRunRefusal(snapshot.savedIntent, this.deps.modelRegistry) ??
					(sessionFile === undefined ? AWAY_NO_SESSION_FILE_REASON : undefined));
			// An event routine is due whenever its source delivers: its parent's feed decides it, no slot is due here. With
			// no sources or CI events off (the owner's own switch, which stops CI in the session too) nothing is followed.
			if (routine.schedule.kind === "event") {
				// A watch is evaluated by its open session only; the away host has no condition to follow for it.
				if (routine.schedule.source === "watch") continue;
				if (!this.deps.eventSources || this.deps.ciEvents?.() === false) continue;
				const entry = work(routine.target.parentSessionId);
				const current = routine.awayRefusal?.reason;
				if (reason !== undefined)
					entry.refusals.push({ routineId: routine.routineId, reason, ...(current ? { current } : {}) });
				else {
					entry.sessionFile ??= sessionFile;
					entry.eventRoutines.push(routine.routineId);
				}
				continue;
			}
			// The claim's own start: a `readyBy` window may open before the slot.
			const opensAt = routineOpensAt(routine, occurrences);
			if (opensAt > nowMs) {
				// A routine due later wakes the supervisor then, to run it or to record why it cannot.
				next = Math.min(next, opensAt);
				continue;
			}
			const entry = work(routine.target.parentSessionId);
			const current = routine.awayRefusal?.reason;
			if (reason !== undefined) {
				entry.refusals.push({ routineId: routine.routineId, reason, ...(current ? { current } : {}) });
				continue;
			}
			// One run away per routine waits for its session at a time; the claim holds the slot the same way.
			if (routineAwayHeld(occurrences, routine, nowMs)) {
				entry.refusals.push({
					routineId: routine.routineId,
					reason: ROUTINE_AWAY_HELD_REASON,
					...(current ? { current } : {}),
				});
				continue;
			}
			if (!room) {
				waitingForRoom = true;
				entry.refusals.push({
					routineId: routine.routineId,
					reason: ROUTINE_AWAY_SPEND_REFUSAL,
					...(current ? { current } : {}),
				});
				continue;
			}
			entry.sessionFile ??= sessionFile;
			entry.due.push(`routine:${routine.routineId}`);
			entry.dueRoutines.push(routine.routineId);
			// A routine holding its whole journal share frees it by time when an uncertain run's retention passes.
			const share = routineJournalShare(occurrences, routine.routineId, nowMs);
			if (!share.fits && share.exit !== undefined) next = Math.min(next, share.exit);
		}
		// A full journal makes room by time when an entry's retention or away charge ends; otherwise by a store change.
		const journal = routineJournalRoom(occurrences, nowMs);
		if (!journal.room && journal.exit !== undefined && [...parents.values()].some((entry) => entry.due.length > 0))
			next = Math.min(next, journal.exit);
		/**
		 * What a parent's idle memo stands on: its transcript, model prices, its due work, and the journal room that work
		 * needs (the journal's own room and which due routines hold their whole share). Room returning through another
		 * parent's delivered results changes no file of this parent, so it must change the memo.
		 */
		const fingerprintOf = (entry: ParentWork, current: readonly RoutineOccurrence[]): string => {
			const shareless = entry.dueRoutines.filter(
				(routineId) => !routineJournalShare(current, routineId, nowMs).fits,
			);
			return `${fileStamp(entry.sessionFile)}|${modelsStamp}|${[...entry.due].sort().join(",")}|${routineJournalRoom(current, nowMs).room}|${shareless.sort().join(",")}`;
		};
		for (const occurrence of occurrences) {
			if (occurrence.target.kind !== "session") continue;
			const parentSessionId = occurrence.parentOrigin.sessionId;
			const sessionFile = occurrence.parentOrigin.sessionFile;
			if (occurrence.executor === "away") {
				if (occurrence.phase === "terminal") continue;
				const entry = work(parentSessionId);
				entry.sessionFile ??= sessionFile;
				// An uncertain run is due once per change: a host resumes its suspended attempt or resolves it exactly. It
				// is already charged, so it needs no room.
				if (occurrence.phase === "uncertain") {
					entry.due.push(`occurrence:${occurrence.occurrenceId}`);
					entry.dueWithoutRoom = true;
				} else entry.active = true;
				continue;
			}
			const recoverable =
				occurrence.phase === "pending" ||
				(occurrence.phase === "claimed" && occurrence.claim !== undefined && occurrence.claim.leaseUntil <= nowMs);
			const intent = occurrence.definition.executionSnapshot?.savedIntent;
			if (
				!recoverable ||
				!intent ||
				sessionFile === undefined ||
				awayRunRefusal(intent, this.deps.modelRegistry) !== undefined
			)
				continue;
			// A run not yet charged is admitted only under the spend bound; the claim records the refusal on its routine.
			if (!room) {
				waitingForRoom = true;
				continue;
			}
			const entry = work(parentSessionId);
			entry.sessionFile ??= sessionFile;
			entry.due.push(`occurrence:${occurrence.occurrenceId}`);
		}

		let closedAny = false;
		let capped = false;
		/**
		 * After a host's claim: keep it while it holds a run; otherwise close it and remember its parent idle, unless the
		 * claim waited for spend room, which time or another run's end returns without any change to the parent.
		 */
		const afterClaim = async (host: AwayRoutineHost, entry: ParentWork): Promise<boolean> => {
			const held = this.holdsWork(host);
			const current = store.listRoutineOccurrences();
			room = routineAwaySpendRoom(current, this.gate(), nowMs).fits(0);
			if (held) return true;
			const spendWait = host.scheduler.awaySpendWait();
			await this.closeHosts([host.parentSessionId]);
			closedAny = true;
			if (spendWait) {
				waitingForRoom = true;
				if (spendWait.retryAt !== undefined) next = Math.min(next, spendWait.retryAt);
				this.idle.delete(host.parentSessionId);
			}
			// Memoized on the journal room left after the claim, so room returning wakes the parent again.
			else this.idle.set(host.parentSessionId, fingerprintOf(entry, current));
			return false;
		};
		for (const parentSessionId of new Set([...parents.keys(), ...this.hosts.keys()])) {
			if (this.disposed) return;
			const entry = parents.get(parentSessionId) ?? emptyParentWork();
			const fingerprint = fingerprintOf(entry, occurrences);
			const host = this.hosts.get(parentSessionId);
			const open = this.parentOpen(parentSessionId);
			// A refusal stands only for a closed parent: an open one runs its own routines.
			if (open === false)
				for (const { routineId, reason, current } of entry.refusals)
					if (current !== reason) refusals.push({ routineId, reason });
			if (host) {
				if (entry.active || host.context.hasLiveRun()) {
					host.scheduler.wake();
					continue;
				}
				// Idle: let it claim what is due now, then keep it only while that left a run to hold.
				if (!open && entry.due.length > 0 && this.idle.get(parentSessionId) !== fingerprint) {
					await host.scheduler.tick();
					await afterClaim(host, entry);
					continue;
				}
				await this.closeHosts([parentSessionId]);
				this.idle.set(parentSessionId, fingerprint);
				closedAny = true;
				continue;
			}
			if (open === "unknown") {
				for (const routineId of [...entry.dueRoutines, ...entry.refusals.map((refusal) => refusal.routineId)])
					refusals.push({ routineId, reason: AWAY_LEASES_UNREADABLE_REASON });
				continue;
			}
			if (open) continue;
			if (!entry.active && (entry.due.length === 0 || this.idle.get(parentSessionId) === fingerprint)) continue;
			// Every due run of this parent needs room an earlier parent's claim in this pass may have taken.
			if (!entry.active && !entry.dueWithoutRoom && !room) {
				waitingForRoom = true;
				continue;
			}
			const retryAt = this.retryAt.get(parentSessionId);
			if (retryAt !== undefined && retryAt > nowMs) {
				next = Math.min(next, retryAt);
				continue;
			}
			if (this.hosts.size >= settings.maxParentHosts) {
				capped = true;
				continue;
			}
			if (entry.sessionFile === undefined) continue;
			let opened: AwayRoutineHost;
			try {
				opened = await openAwayRoutineHost({
					deps: this.deps,
					parentSessionId,
					sessionFile: entry.sessionFile,
					gate: () => this.gate(),
					isParentOpen: () => this.parentOpen(parentSessionId) !== false,
					report: (message) => this.deps.report(`Routines of session ${parentSessionId} away: ${message}`),
				});
			} catch (error) {
				if (error instanceof AwayParentUnavailable) {
					for (const routineId of entry.dueRoutines)
						refusals.push({ routineId, reason: `${error.message} It waits for the session to open.` });
					this.idle.set(parentSessionId, fingerprint);
					// No host can release this parent's lapsed away claims, so the supervisor does; a run that reached
					// dispatch bypasses the idle memo and is tried again on the open retry, not every pass.
					if (entry.active && !store.releaseLapsedAwayClaims({ parentSessionId, nowMs })) {
						this.retryAt.set(parentSessionId, nowMs + OPEN_RETRY_MS);
						next = Math.min(next, nowMs + OPEN_RETRY_MS);
					}
				} else {
					this.reportOnce(
						`open|${parentSessionId}`,
						`Routines of session ${parentSessionId} could not be opened away: ${errorText(error)}`,
					);
					this.retryAt.set(parentSessionId, nowMs + OPEN_RETRY_MS);
					next = Math.min(next, nowMs + OPEN_RETRY_MS);
				}
				continue;
			}
			if (this.disposed) {
				await this.closeHost(opened);
				return;
			}
			this.retryAt.delete(parentSessionId);
			this.reported.delete(`open|${parentSessionId}`);
			this.hosts.set(parentSessionId, opened);
			opened.scheduler.start();
			await opened.scheduler.tick();
			await afterClaim(opened, entry);
		}

		next = Math.min(next, await this.reconcileFeeds(parents, refusals, nowMs));
		if (this.disposed) return;
		if (refusals.length > 0) {
			store.recordRoutineAwayRefusals({ refusals, nowMs });
			for (const { routineId, reason } of refusals)
				this.reportOnce(`away|${routineId}`, `Routine ${routineId} was not run away: ${reason}`);
		}
		// A capped parent waits for a host to close; a close in this pass lets another pass open it.
		if (capped && closedAny) this.dirty = true;
		// Room returns when a charge ends by time (armed here) or when a run ends or is released (a store change).
		if (waitingForRoom) {
			const exit = routineAwaySpendRoom(store.listRoutineOccurrences(), this.gate(), nowMs).exit;
			if (exit !== undefined) next = Math.min(next, exit);
		}
		if (Number.isFinite(next)) this.arm(Math.max(next, nowMs + MIN_ALARM_DELAY_MS));
		else {
			this.alarm?.stop();
			this.alarm = undefined;
		}
	}

	/**
	 * Keeps one event feed per closed parent with an event routine that may run away, and closes every other. Returns
	 * when a feed that failed to open is tried again; a parent with nothing to follow is refused on its routines.
	 */
	private async reconcileFeeds(
		parents: ReadonlyMap<string, ParentWork>,
		refusals: { routineId: string; reason: string }[],
		nowMs: number,
	): Promise<number> {
		let next = Number.POSITIVE_INFINITY;
		const eventSources = this.deps.eventSources;
		for (const parentSessionId of new Set([...parents.keys(), ...this.feeds.keys()])) {
			if (this.disposed) break;
			const entry = parents.get(parentSessionId);
			const routineIds = entry?.eventRoutines ?? [];
			const sessionFile = entry?.sessionFile;
			const retire = async (reason: string): Promise<void> => {
				this.feedRoutines.delete(parentSessionId);
				this.feedRetryAt.delete(parentSessionId);
				await this.closeFeeds([parentSessionId], reason);
			};
			if (!eventSources || routineIds.length === 0 || sessionFile === undefined) {
				await retire("no event routine of it may run away now");
				continue;
			}
			const open = this.parentOpen(parentSessionId);
			const stop =
				fileStamp(sessionFile) === "missing"
					? "its session file is gone"
					: open === true
						? "its session opened, so the session follows its events"
						: open === "unknown"
							? AWAY_LEASES_UNREADABLE_REASON
							: undefined;
			if (stop !== undefined) {
				await retire(stop);
				continue;
			}
			this.feedRoutines.set(parentSessionId, routineIds);
			const current = this.feeds.get(parentSessionId);
			if (current && !current.isHandedBack()) continue;
			if (current) {
				// Another holder took the consumer (a session that has let go again, or another host): a new feed takes it up
				// once the hold ends. A hold that outlasts the retries is reported once.
				await this.closeFeeds(
					[parentSessionId],
					"another holder took its events; the away host follows them again later",
					"once",
				);
				this.feedRetryAt.set(parentSessionId, nowMs + OPEN_RETRY_MS);
				next = Math.min(next, nowMs + OPEN_RETRY_MS);
				continue;
			}
			const retryAt = this.feedRetryAt.get(parentSessionId);
			if (retryAt !== undefined && retryAt > nowMs) {
				next = Math.min(next, retryAt);
				continue;
			}
			try {
				const feed = await AwayEventFeed.open({
					agentDir: this.deps.agentDir,
					parentSessionId,
					sessionFile,
					timers: this.deps.timers,
					store: this.deps.store,
					sources: eventSources,
					isParentOpen: () => this.parentOpen(parentSessionId) !== false,
					eventRoutineIds: () => this.feedRoutines.get(parentSessionId) ?? [],
					report: (message) => this.deps.report(message),
					handedBack: () => this.wake(),
				});
				if (this.disposed) {
					await feed.close();
					break;
				}
				this.feeds.set(parentSessionId, feed);
				this.feedRetryAt.delete(parentSessionId);
				this.reported.delete(`feed|${parentSessionId}`);
			} catch (error) {
				this.feedRetryAt.set(parentSessionId, nowMs + OPEN_RETRY_MS);
				next = Math.min(next, nowMs + OPEN_RETRY_MS);
				if (error instanceof AwayEventFeedUnavailable)
					for (const routineId of routineIds)
						refusals.push({ routineId, reason: `${error.message} It waits for the session to open.` });
				else
					this.reportOnce(
						`feed|${parentSessionId}`,
						`Event routines of session ${parentSessionId} could not be followed away: ${errorText(error)}`,
					);
			}
		}
		return next;
	}

	/** The feed's terminal signal: one report of why its events are no longer followed away, after its sources parked. */
	private async closeFeeds(
		parentSessionIds: readonly string[],
		reason: string,
		repeat: "always" | "once" = "always",
	): Promise<void> {
		for (const parentSessionId of parentSessionIds) {
			const feed = this.feeds.get(parentSessionId);
			if (!feed) continue;
			this.feeds.delete(parentSessionId);
			try {
				await feed.close();
				this.reported.delete(`feed-close|${parentSessionId}`);
				const message = `Events of session ${parentSessionId} are no longer followed away: ${reason}`;
				if (repeat === "once") this.reportOnce(`feed-held|${parentSessionId}`, message);
				else {
					// Any other end closes the episode of a hold reported once.
					this.reported.delete(`feed-held|${parentSessionId}`);
					this.deps.report(message);
				}
			} catch (error) {
				this.reportOnce(
					`feed-close|${parentSessionId}`,
					`Event routines of session ${parentSessionId} did not stop cleanly away: ${errorText(error)}`,
				);
			}
		}
	}

	/** Whether the host still holds a run of its parent: an admitted run away not finished, or a live attempt. */
	private holdsWork(host: AwayRoutineHost): boolean {
		this.deps.store.reload();
		return (
			host.context.hasLiveRun() ||
			this.deps.store
				.listRoutineOccurrences({ parentSessionId: host.parentSessionId })
				.some(
					(occurrence) =>
						occurrence.executor === "away" && occurrence.phase !== "terminal" && occurrence.phase !== "uncertain",
				)
		);
	}

	/**
	 * Whether any hold other than this supervisor's own away holds holds the parent's session: only a holder proven dead
	 * does not count. `unknown` when the lease registry cannot be read; nothing then proves the session closed.
	 */
	private parentOpen(parentSessionId: string): boolean | "unknown" {
		// Every away-host hold of this process is this supervisor's, including one whose host is still opening (its lease
		// is taken before the open yields). A session open in this same process holds the parent in the session role.
		try {
			return readSessionLeaseHolders(this.deps.agentDir, parentSessionId).some(
				(holder) => !(holder.self && holder.role === "away-host") && holder.standing !== "dead",
			);
		} catch {
			return "unknown";
		}
	}

	/** The away spend bound every host's claim is admitted under; finished runs carry their own settled spend. */
	private gate(): RoutineAwayClaimGate {
		const settings = this.deps.settings();
		const otherCharges = this.deps.otherAwayCharges?.();
		return {
			maxUsdPerRun: settings.maxUsdPerRun,
			maxUsdPerDay: settings.maxUsdPerDay,
			...(otherCharges ? { otherCharges } : {}),
		};
	}

	private async closeHosts(parentSessionIds: readonly string[]): Promise<void> {
		for (const parentSessionId of parentSessionIds) {
			const host = this.hosts.get(parentSessionId);
			if (!host) continue;
			this.hosts.delete(parentSessionId);
			await this.closeHost(host);
		}
	}

	private async closeHost(host: AwayRoutineHost): Promise<void> {
		try {
			await host.scheduler.close();
			await host.context.close();
			this.reported.delete(`close|${host.parentSessionId}`);
		} catch (error) {
			this.reportOnce(
				`close|${host.parentSessionId}`,
				`Routines of session ${host.parentSessionId} did not close cleanly away: ${errorText(error)}`,
			);
		}
	}

	private arm(atMs: number): void {
		this.alarm?.stop();
		this.alarm = alarmAt(this.deps.timers.port("routines"), atMs, () => {
			this.alarm = undefined;
			this.wake();
		});
	}

	private reportOnce(cause: string, message: string): void {
		if (this.reported.get(cause) === message) return;
		this.reported.set(cause, message);
		this.deps.report(message);
	}
}
