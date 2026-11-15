/**
 * What a bot's own session is owed, read from the store, its bundle and its file without loading it: a live watch to
 * sample, a firing whose wake it has not taken, a wake it accepted and never ran (a turn refused at its start), its
 * workers' work (`owesWorkerWork`) and the turn a usage limit stopped (`savedUsageResumeAt`); and the opening of the
 * session of a bot owed work that no process hosts (`BotOwedWork`), at once or when the work comes due. The owner's stop of
 * the workers of a session no process hosts (`cancelOwedWorkerWork`). And the one rule that keeps watches with the session
 * that holds them: the watches the home's other sessions armed are cancelled when the bot continues one session.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ParentInputIndex } from "../../kernel/session/parent-input-ledger.ts";
import type { OrchestrationHome } from "../../kernel/session/session-bundle-paths.ts";
import { readSessionHeader } from "../../kernel/session/session-file-reading.ts";
import type { SessionManager } from "../../kernel/session/session-manager.ts";
import { isMissingFileError } from "../../kernel/storage/atomic-file.ts";
import { orchestrationEventStoreDir } from "../agent-paths.ts";
import { realPathIdentity } from "../autonomy/path-scope.ts";
import type { PersistentBotRecord, PersistentBotTeamStore } from "../delegation/persistent-bot-team-store.ts";
import { stopSessionWorkers } from "../delegation/worker-fleet-stop.ts";
import {
	nextWorkerRetryAt,
	owesWorkerWorkAt,
	type WorkerWorkFacts,
	workerWorkFacts,
} from "../delegation/worker-owed-work.ts";
import { getLatestGoalStateSnapshot } from "../goals/session-goal-state.ts";
import { interfaceText } from "../language/interface-text.ts";
import { OrchestrationEventStore, OrchestrationSnapshotRequiredError } from "../orchestration/event-store.ts";
import { DurableTaskRuntime } from "../orchestration/task-runtime.ts";
import { readTaskRuntimeProjection } from "../orchestration/task-runtime-reader.ts";
import { botSessionStorageRoots } from "../orchestration-homes.ts";
import { liveOwnWatches } from "../routines/routine-holder.ts";
import { type RestoredUsageRules, restoredUsageStop } from "../usage-reset-resume.ts";
import { alarmAt, type RepeatingAlarm, repeatEvery, type TimerPort, type WallAlarm } from "../util/timer-port.ts";
import { botFailureText } from "./bot-failure-words.ts";
import { botHomeOf } from "./bot-home.ts";
import { type BotInboxItem, botInboxStopWaiting, botInboxWaiting } from "./bot-inbox.ts";
import { type BotModelRefusal, type BotModelRefusalCause, BotModelRefusedError } from "./bot-model-refusal.ts";
import { BotOpenRetries, botOpenFailure, cappedFailure, storeFailure } from "./bot-open-retry.ts";
import { readSessionSnapshot, type SavedBotSession } from "./bot-remote-view.ts";
import type { BotSender } from "./bot-session-host.ts";
import { refuseLink } from "./bot-session-pointer.ts";

type WatchStore = Pick<PersistentBotTeamStore, "listRoutines" | "listPendingRoutineDeliveries" | "deleteRoutine">;

/**
 * Whether the bot session `sessionId` has watch work, as the store says now: a live watch to sample, or a firing whose wake
 * it has not yet taken (a one-shot that fired is no longer live, and its wake is delivered only by its own session).
 */
export function owesWatchWork(store: WatchStore, sessionId: string, nowMs: number): boolean {
	return (
		liveOwnWatches(store, sessionId, nowMs).count > 0 || store.listPendingRoutineDeliveries(sessionId, 1).length > 0
	);
}

/**
 * The delivery ids of the wakes the session file holds accepted and never ran: the store counts a fired watch's result
 * delivered once the session saved it, and a turn refused at its start (an outdated compile, an unusable model) leaves it
 * pending in the file, where only the session's own recovery, when it opens, runs it. Reads the whole file.
 */
export function unrunWakes(file: string, agentDir: string): readonly string[] {
	return readSessionSnapshot(file, agentDir, (view) => {
		// The session's own reading of its branch (`getPendingParentInputs`), on a view that opens nothing for writing.
		const index = new ParentInputIndex();
		for (const entry of view.getBranch()) index.apply(entry, (id) => view.getEntry(id));
		return index.pendingInputs("turn").map((input) => input.metadata.deliveryId);
	});
}

/** The orchestration home bot `agentId`'s session `sessionId` keeps its workers in (`botSessionStorageRoots`). */
export function botSessionHome(agentDir: string, agentId: string, sessionId: string): OrchestrationHome {
	return botSessionStorageRoots(agentDir, botHomeOf(agentDir, agentId).orchestrationHome, sessionId).orchestrationHome;
}

/**
 * Whether the workers of session `sessionId`, whose bundle is in `home`, owe the session's open at `nowMs`
 * (`owesWorkerWorkAt`): queued or resumable work, a retry due, a lease holder proven dead, an end or a receipt not
 * delivered. A retry waiting past `nowMs` is owed at its time, not now. Replays the bundle's projection; false without one.
 */
export function owesWorkerWork(home: OrchestrationHome, sessionId: string, nowMs: number): boolean {
	if (!existsSync(orchestrationEventStoreDir(home, sessionId))) return false;
	const store = new OrchestrationEventStore({ orchestrationHome: home, sessionId });
	return owesWorkerWorkAt(workerWorkFacts(readTaskRuntimeProjection(store)), nowMs);
}

/**
 * The owner's stop of the workers of bot session `sessionId` while no process hosts it, written to its bundle in `home`
 * alone (`stopSessionWorkers`): every open plan closed and every unended worker attempt cancelled for `reasonCode`, so
 * nothing opens the session for them. Their ends are recorded delivered by the session's next open, when its outbox is
 * replayed (`owner_stopped` wakes no one). The caller holds the bot's host lock, so no process runs what it cancels.
 * Returns how many attempts it cancelled.
 */
export function cancelOwedWorkerWork(home: OrchestrationHome, sessionId: string, reasonCode: string): number {
	if (!existsSync(orchestrationEventStoreDir(home, sessionId))) return 0;
	const runtime = new DurableTaskRuntime({
		store: new OrchestrationEventStore({ orchestrationHome: home, sessionId }),
	});
	let cancelled = 0;
	stopSessionWorkers(
		runtime,
		undefined,
		(attempt) => {
			runtime.cancelAttempt(attempt.attemptId, reasonCode);
			cancelled++;
		},
		reasonCode,
	);
	return cancelled;
}

/** What the time a saved transcript continues reads beside the rule of a kept stop: the reset recorded for a model. */
export interface SavedUsageResumeRules extends RestoredUsageRules {
	modelExhaustion(ref: string): { readonly until: number | undefined } | undefined;
}

/**
 * When the bot's saved session, `file`, continues the turn or goal a subscription's usage limit stopped (`restoredUsageStop`
 * on the messages its load seeds its agent with and on its goal), moved later by the exhaustion the provider admission
 * recorded for the refusing model, as the live session's wake moves it: a closed bot is not opened against a limit that
 * still holds. Undefined when it waits for none. Reads the whole file.
 */
export function savedUsageResumeAt(file: string, agentDir: string, rules: SavedUsageResumeRules): number | undefined {
	const stop = readSessionSnapshot(file, agentDir, (view) =>
		restoredUsageStop(view.buildSessionContext().messages.at(-1), getLatestGoalStateSnapshot(view), rules),
	);
	if (!stop) return undefined;
	const until = rules.modelExhaustion(stop.resume.ref)?.until;
	return until !== undefined && until > stop.at ? until : stop.at;
}

/**
 * What the host knows of the worker work each bot's bundle owes (`workerWorkFacts`): the projection is replayed again only
 * once the store committed since the last read, so the periodic listing costs a stat and an absent next event file per bot
 * whose store did not change. The facts alone are kept, one record per bot.
 */
class WorkerWorkLedger {
	private readonly reads = new Map<
		string,
		{ readonly dir: string; readonly ino: number; readonly lastOrdinal: number; readonly facts: WorkerWorkFacts }
	>();

	/** What the bundle of the bot's session `sessionId` in `home` owes; undefined when it has none. */
	read(agentId: string, home: OrchestrationHome, sessionId: string): WorkerWorkFacts | undefined {
		const store = new OrchestrationEventStore({ orchestrationHome: home, sessionId });
		let ino: number;
		try {
			ino = statSync(store.rootDir).ino;
		} catch (error) {
			if (!isMissingFileError(error)) throw error;
			this.reads.delete(agentId);
			return undefined;
		}
		const known = this.reads.get(agentId);
		if (known?.dir === store.rootDir && known.ino === ino && committedNothingAfter(store, known.lastOrdinal))
			return known.facts;
		const state = readTaskRuntimeProjection(store);
		const facts = workerWorkFacts(state);
		this.reads.set(agentId, { dir: store.rootDir, ino, lastOrdinal: state.lastOrdinal, facts });
		return facts;
	}

	/** The bot's session loaded, or the bot was released: its bundle is read again when next asked. */
	forget(agentId: string): void {
		this.reads.delete(agentId);
	}
}

/** Whether the store committed nothing after `ordinal` (a snapshot that moved past it counts as a commit). */
function committedNothingAfter(store: OrchestrationEventStore, ordinal: number): boolean {
	try {
		return store.readAfter(ordinal).length === 0;
	} catch (error) {
		if (error instanceof OrchestrationSnapshotRequiredError) return false;
		throw error;
	}
}

/**
 * What the host knows of the wakes each bot's session file holds unrun (see {@link unrunWakes}): the ids it read, read
 * again only once the file's size or modification time changed, so an idle bot's whole transcript is not parsed at every
 * attach and host change (the ids alone are kept, one record per bot).
 */
export class UnrunWakeLedger {
	private readonly reads = new Map<string, { file: string; size: number; mtimeMs: number; ids: string }>();

	/** The ids of the wakes the bot's session file holds unrun, joined by spaces; empty when none. */
	read(agentId: string, file: string, agentDir: string): string {
		// Taken before the read: a write landing during it leaves a size or time the next ask finds changed.
		const { size, mtimeMs } = statSync(file);
		const known = this.reads.get(agentId);
		if (known?.file === file && known.size === size && known.mtimeMs === mtimeMs) return known.ids;
		const ids = unrunWakes(file, agentDir).join(" ");
		this.reads.set(agentId, { file, size, mtimeMs, ids });
		return ids;
	}

	/** The bot's session loaded, or the bot was released: its file is read again when next asked. */
	forget(agentId: string): void {
		this.reads.delete(agentId);
	}
}

/**
 * Why the bot's session was last refused, with the definition it was refused on: a run refused at its start while it held
 * wakes (`run`), which is what stops those wakes from opening it again, or an open refused before it took the lock
 * (`open`), which stops every owed work from opening it. `cause` is the model refusal's reason, undefined for a refusal
 * of the definition itself (an outdated compile), which only a changed definition lifts.
 */
interface RecordedRefusal {
	readonly scope: "run" | "open";
	readonly key: string | undefined;
	readonly cause: BotModelRefusalCause | undefined;
	/** When the cause is recorded to end (a quota exhaustion's reset): the retake alarm is armed then. */
	readonly clearsAt: number | undefined;
}

/**
 * The invariant of the one place a bot's session id is chosen (the host's `load`): the bot's watches target that id. A
 * watch is held by the runtime of the session it targets, so a watch another session of the bot's home armed would be held
 * by none once the bot continues another: such watches are cancelled. Returns how many were. A session file that is a
 * symbolic link stops the load before any is cancelled (`BotSessionLinkError`), as the load's own choice does.
 */
export function cancelOtherSessionsWatches(
	store: WatchStore,
	sessionsDir: string,
	sessionId: string,
	nowMs: number,
): number {
	const others = readdirSync(sessionsDir)
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => join(sessionsDir, name))
		.flatMap((path) => {
			refuseLink(path);
			return readSessionHeader(path)?.id ?? [];
		})
		.filter((id) => id !== sessionId);
	let cancelled = 0;
	for (const other of others)
		for (const routine of store.listRoutines({ sessionId: other, scope: "own-watches" }))
			if (store.deleteRoutine(routine.routineId, undefined, nowMs)) cancelled++;
	return cancelled;
}

/**
 * How often every bot's inbox is listed, beside the watch over the bot homes: where that watch does not fire (a network
 * home, some WSL mounts), a message left waiting is taken up within this, not at the owner's next send or the session's
 * idle close.
 */
const OWED_INBOX_SWEEP_MS = 60 * 1000;

/** What the opening of owed sessions reads from its host. */
export interface BotOwedWorkPorts {
	agentDir(): string;
	store(): PersistentBotTeamStore;
	/** The host's timers: the store's watches are read on its clock. */
	timers(): TimerPort;
	warn(message: string): void;
	/** Whether the host stopped: it opens nothing after. */
	stopped(): boolean;
	/** Whether the host runs the bot's session itself. */
	hostedHere(agentId: string): boolean;
	/** Whether another host holds the bot's lock now. */
	heldElsewhere(agentId: string): boolean;
	/** The bot's own session as its home saved it last. */
	savedSessionOf(agentId: string): SavedBotSession | undefined;
	/** The messages waiting in the bot's inbox, oldest first. */
	waiting(agentId: string): readonly BotInboxItem[];
	/** Whether the record answers in a session of its own (`BotSessionHost.runsAsSession`). */
	runsAsSession(record: PersistentBotRecord): boolean;
	/** The directory the record's session works in for `sender`; throws the owner's words when it cannot run as one. */
	definedCwd(record: PersistentBotRecord, sender: BotSender): string;
	/** What defines the record's session for `sender` now; undefined when it cannot run as one. */
	currentKey(record: PersistentBotRecord, sender: BotSender): string | undefined;
	/** Why the model of the record's session for `sender` may not run now; undefined when it may. */
	modelRefusal(record: PersistentBotRecord, sender: BotSender): BotModelRefusal | undefined;
	/** The provider admission's timers: a model refusal's end is due on their clock. */
	admissionTimers(): TimerPort;
	/** A refusal's cause may have cleared: the host takes the bot's refused work up again. */
	retake(agentId: string): void;
	/** Takes the inbox of a bot the host runs. */
	takeInbox(agentId: string): void;
	/** The root attached last, and an attached root working in `cwd`. */
	sender(): BotSender;
	senderIn(cwd: string): BotSender | undefined;
	/** Opens the bot's session for `sender`. */
	open(agentId: string, sender: BotSender): Promise<unknown>;
}

/**
 * Opens the session of a bot owed work that no process hosts (see {@link BotOwedWork.openIfOwed}), and tells the owner,
 * once for each cause, what the work waits on when it cannot be taken up here. A refusal is kept with its cause, and the
 * work it held back is taken up again once the cause no longer holds: read again at every ask, and at the time a model
 * refusal's recorded end comes (a quota exhaustion's reset), on the provider admission clock, never by polling the model.
 */
export class BotOwedWork {
	private readonly ports: BotOwedWorkPorts;
	/** Bots whose owed work waits on something (no root works where it does, its session did not open), with what the owner was told. */
	private readonly told = new Map<string, string>();
	/** The wakes the bots' session files hold unrun. */
	private readonly wakes = new UnrunWakeLedger();
	/** Why each bot's session was last refused, while no run of it was admitted since. */
	private readonly refusals = new Map<string, RecordedRefusal>();
	/** The alarm at the recorded end of a bot's model refusal. */
	private readonly alarms = new Map<string, WallAlarm>();
	/**
	 * An open that failed for another reason than its model (an unreadable session file, a directory gone): what defined it
	 * and the inbox files it was opened for. The periodic listing does not open it again while both are the same; an attach,
	 * a host change or a record change does.
	 */
	private readonly failedOpens = new Map<string, { readonly key: string | undefined; readonly inbox: string }>();
	/** The periodic listing of the bots' inboxes (see {@link sweepInboxes}). */
	private sweep: RepeatingAlarm | undefined;
	/** The next open of each bot whose session failed to open for a cause that passes on its own (`botOpenFailure`). */
	private readonly openRetries: BotOpenRetries;
	/** What each bot's worker bundle owes. */
	private readonly workerWork = new WorkerWorkLedger();
	/** The alarm at the time a bot's saved session continues what a usage limit stopped (`armOwedAt`). */
	private readonly usageWaits = new Map<string, WallAlarm>();
	/** Bots whose usage wait ended while no process hosted them: owed their session's open until it loads. */
	private readonly usageDue = new Set<string>();
	/** The alarm at the next retry a bot's workers wait on, with its time. */
	private readonly retryWaits = new Map<string, { readonly at: number; readonly alarm: WallAlarm }>();

	constructor(ports: BotOwedWorkPorts) {
		this.ports = ports;
		this.openRetries = new BotOpenRetries({
			timers: () => ports.admissionTimers(),
			stopped: () => ports.stopped(),
			retry: (agentId) => this.openIfOwed(agentId),
		});
	}

	/**
	 * The bot's session failed to open with `error`: whether it is opened again after a backoff (a cause that passes on
	 * its own, `botOpenFailure`, not past its cap).
	 */
	openLater(agentId: string, error: unknown): boolean {
		const failure = botOpenFailure(error);
		return failure !== undefined && this.openRetries.arm(agentId, cappedFailure(failure));
	}

	/**
	 * A run of the bot's session, built on `key`, was refused at its start with `error` while `manager` held wakes: they
	 * do not open the session again until the definition or the cause changes.
	 */
	refused(
		agentId: string,
		key: string,
		manager: Pick<SessionManager, "getPendingParentInputs">,
		error: unknown,
	): void {
		if (manager.getPendingParentInputs("turn").length > 0) this.record(agentId, "run", key, error);
	}

	/** A run of the bot's session was admitted: no refusal holds its work back any more. */
	admitted(agentId: string): void {
		this.forgetRefusal(agentId);
	}

	/**
	 * The bot's session loaded: what it was owed is its own now (its own usage wait and worker retries take their times up),
	 * and its file and bundle are read again when next asked.
	 */
	loaded(agentId: string): void {
		this.told.delete(agentId);
		this.wakes.forget(agentId);
		this.failedOpens.delete(agentId);
		this.openRetries.forget(agentId);
		this.forgetOwedTimes(agentId);
	}

	/** The bot was released (retired, or off the session path): nothing of it is kept. */
	released(agentId: string): void {
		this.told.delete(agentId);
		this.wakes.forget(agentId);
		this.forgetRefusal(agentId);
		this.failedOpens.delete(agentId);
		this.openRetries.forget(agentId);
		this.forgetOwedTimes(agentId);
	}

	/** The host stopped: no alarm takes work up after it. */
	stop(): void {
		for (const alarm of this.alarms.values()) alarm.stop();
		this.alarms.clear();
		this.openRetries.stop();
		for (const agentId of [...this.usageWaits.keys(), ...this.retryWaits.keys()]) this.forgetOwedTimes(agentId);
		this.sweep?.stop();
		this.sweep = undefined;
	}

	/**
	 * The bot's session closed, or this process found it hosted by none: `usageResumeAt` is when its saved session continues
	 * what a usage limit stopped (`savedUsageResumeAt`), undefined when nothing waits. The session is opened at that time,
	 * on the provider admission clock, and at the next retry its workers wait on (read from its bundle, by
	 * {@link openIfOwed}, which runs now), on the host's; any earlier usage alarm ends.
	 */
	armOwedAt(agentId: string, usageResumeAt: number | undefined): void {
		this.usageWaits.get(agentId)?.stop();
		this.usageWaits.delete(agentId);
		if (usageResumeAt !== undefined && !this.ports.stopped())
			this.usageWaits.set(
				agentId,
				alarmAt(this.ports.admissionTimers(), usageResumeAt, () => {
					this.usageWaits.delete(agentId);
					this.usageDue.add(agentId);
					this.openIfOwed(agentId);
				}),
			);
		this.openIfOwed(agentId);
	}

	/** Opens the bot's session at `at`, the next retry its workers wait on; any earlier retry alarm ends, the same time keeps it. */
	private armRetry(agentId: string, at: number | undefined): void {
		const armed = this.retryWaits.get(agentId);
		if (armed?.at === at) return;
		armed?.alarm.stop();
		this.retryWaits.delete(agentId);
		if (at === undefined || this.ports.stopped()) return;
		const alarm = alarmAt(this.ports.timers(), at, () => {
			this.retryWaits.delete(agentId);
			this.openIfOwed(agentId);
		});
		this.retryWaits.set(agentId, { at, alarm });
	}

	/** Ends the bot's usage and retry alarms, its usage wait's due mark and its bundle's read. */
	private forgetOwedTimes(agentId: string): void {
		this.usageWaits.get(agentId)?.stop();
		this.usageWaits.delete(agentId);
		this.usageDue.delete(agentId);
		this.retryWaits.get(agentId)?.alarm.stop();
		this.retryWaits.delete(agentId);
		this.workerWork.forget(agentId);
	}

	/** What the workers of the bot's saved session `sessionId` owe, read from its bundle; undefined without one. */
	private workerFacts(agentId: string, sessionId: string): WorkerWorkFacts | undefined {
		return this.workerWork.read(agentId, botSessionHome(this.ports.agentDir(), agentId, sessionId), sessionId);
	}

	/**
	 * Whether a bot no process hosts is owed its session's open beside its inbox, as the periodic listing asks: a usage wait
	 * that ended, or its workers' work. A bundle that does not read is reported by {@link openIfOwed}, so it asks.
	 */
	private owedBeyondInbox(agentId: string): boolean {
		if (this.usageDue.has(agentId)) return true;
		const sessionId = this.ports.savedSessionOf(agentId)?.id;
		if (sessionId === undefined) return false;
		try {
			const facts = this.workerFacts(agentId, sessionId);
			return facts !== undefined && owesWorkerWorkAt(facts, this.ports.timers().now());
		} catch {
			return true;
		}
	}

	/**
	 * Lists every bot's inbox every `OWED_INBOX_SWEEP_MS` until the host stops, whether the watch over the bot homes runs
	 * or not (a watch that runs can still miss what another process writes): a message waiting for a bot this host runs is
	 * taken, and a bot no host runs is opened ({@link openIfOwed}) when its inbox, its workers or a usage wait that ended
	 * owe it, unless its last open failed on the same definition and inbox or its next open is armed already. Costs one
	 * directory listing per bot, and per bot no host runs a stat of its worker bundle (replayed only once it changed); no
	 * session file is read.
	 */
	sweepInboxes(): void {
		if (this.sweep !== undefined || this.ports.stopped()) return;
		this.sweep = repeatEvery(this.ports.timers(), OWED_INBOX_SWEEP_MS, () => {
			const agentDir = this.ports.agentDir();
			for (const { agentId } of this.ports.store().listBots()) {
				const waiting = botInboxWaiting(agentDir, agentId);
				if (this.ports.hostedHere(agentId)) {
					if (waiting || botInboxStopWaiting(agentDir, agentId)) this.ports.takeInbox(agentId);
				} else if (
					!this.openRetries.pending(agentId) &&
					(waiting || (!this.ports.heldElsewhere(agentId) && this.owedBeyondInbox(agentId)))
				)
					this.openIfOwed(agentId, true);
			}
		});
	}

	private record(agentId: string, scope: RecordedRefusal["scope"], key: string | undefined, error: unknown): void {
		const refusal = error instanceof BotModelRefusedError ? error.refusal : undefined;
		this.refusals.set(agentId, { scope, key, cause: refusal?.cause, clearsAt: refusal?.clearsAt });
		this.armRetake(agentId, refusal?.clearsAt);
	}

	private forgetRefusal(agentId: string): void {
		this.refusals.delete(agentId);
		this.armRetake(agentId, undefined);
	}

	/** Takes the bot's refused work up again at `clearsAt`, when the cause is known to end then; any earlier alarm ends. */
	private armRetake(agentId: string, clearsAt: number | undefined): void {
		this.alarms.get(agentId)?.stop();
		this.alarms.delete(agentId);
		if (clearsAt === undefined || this.ports.stopped()) return;
		this.alarms.set(
			agentId,
			alarmAt(this.ports.admissionTimers(), clearsAt, () => {
				this.alarms.delete(agentId);
				this.ports.retake(agentId);
			}),
		);
	}

	/**
	 * Whether the refusal recorded for the bot still holds back what it is owed: the same definition, refused for the same
	 * cause now. When it does and the cause's end as recorded now differs from the one armed (a reset can be recorded
	 * later), the retake is armed again at it; the same end keeps its alarm.
	 */
	private stillRefused(agentId: string, record: PersistentBotRecord, sender: BotSender, onlyWakes: boolean): boolean {
		const recorded = this.refusals.get(agentId);
		if (!recorded || (recorded.scope === "run" && !onlyWakes)) return false;
		const key = this.ports.currentKey(record, sender);
		const now = key === undefined ? undefined : this.ports.modelRefusal(record, sender);
		if (recorded.key !== key || recorded.cause !== now?.cause) return false;
		if (recorded.clearsAt !== now?.clearsAt) {
			this.refusals.set(agentId, { ...recorded, clearsAt: now?.clearsAt });
			this.armRetake(agentId, now?.clearsAt);
		}
		return true;
	}

	/**
	 * Opens the bot's session when no process hosts it and it is owed: its home's session holds live watches or a fired
	 * watch's wake not yet taken, its workers owe it work ({@link owesWorkerWork}: only its own recovery takes it up), the
	 * usage wait {@link armOwedAt} armed has ended, its file holds a wake it accepted and never ran (a turn refused at its
	 * start: only its own recovery runs it), or its inbox holds messages another process sent. The next retry its workers
	 * wait on is armed here. A watch is sampled and its wake delivered
	 * only by its own session, and an inbox is taken only by the host of the session, so a process that starts, sees a host
	 * let the bot go or die, or rebuilds a session on a changed record takes them up again. A session with watches is opened
	 * only by a process working in the directory it worked in (a watch's relative path reads against it); one owed only its
	 * inbox (a bot whose session never ran is owed nothing else), also by a process working where a waiting message was
	 * sent from. Another process that opened it first is not a failure. `swept` (the periodic listing asks) skips a bot
	 * whose last open failed on what defines it now and the inbox files waiting now.
	 */
	openIfOwed(agentId: string, swept = false): void {
		const { ports } = this;
		const agentDir = ports.agentDir();
		if (ports.stopped()) return;
		const record = ports.store().getBot(agentId);
		// Nothing of it is this host's to open: no attempt stays armed for it.
		if (
			ports.hostedHere(agentId) ||
			ports.heldElsewhere(agentId) ||
			!record ||
			record.retired ||
			!ports.runsAsSession(record)
		) {
			this.openRetries.forget(agentId);
			return;
		}
		// A cause that passes on its own is asked again after a backoff, armed once for this attempt whichever read or open
		// failed; any other cause at the next change. Whether the session opens later is returned.
		let retrying = false;
		const notResumed = (error: unknown): boolean => {
			const failure = botOpenFailure(error);
			if (failure !== undefined && !retrying) retrying = this.openRetries.arm(agentId, cappedFailure(failure));
			this.tellWaits(agentId, interfaceText().botTeam.botWatchesNotResumed(agentId, botFailureText(agentId, error)));
			return failure !== undefined && retrying;
		};
		// A bot whose session never ran (no file, or one naming no directory) holds no watch: it is owed only its inbox. A
		// home that does not read is asked again at the next change.
		let saved: SavedBotSession | undefined;
		try {
			saved = ports.savedSessionOf(agentId);
		} catch (error) {
			notResumed(storeFailure(agentId, error, undefined));
			return;
		}
		const worked = saved?.cwd === undefined ? undefined : { ...saved, cwd: saved.cwd };
		const watching = worked !== undefined && owesWatchWork(ports.store(), worked.id, ports.timers().now());
		// A stop the owner wrote while another process hosted it (`requestBotStop`) holds back the work it stopped: its
		// workers and its usage wait open nothing until a host takes the stop (opened for anything else, it takes it first).
		const stopWaiting = botInboxStopWaiting(agentDir, agentId);
		// Its workers' work, and the next retry they wait on armed; a bundle it cannot read leaves the rest it is owed.
		let workers = false;
		try {
			const facts = worked && !stopWaiting ? this.workerFacts(agentId, worked.id) : undefined;
			const now = ports.timers().now();
			workers = facts !== undefined && owesWorkerWorkAt(facts, now);
			this.armRetry(agentId, facts && nextWorkerRetryAt(facts, now));
		} catch (error) {
			notResumed(error);
		}
		// A usage wait that ended continues the saved session's turn: owed only by a session that ran.
		const usage = worked !== undefined && !stopWaiting && this.usageDue.has(agentId);
		let unrun = "";
		let unread = false;
		try {
			// The file, only when nothing else owes; a file it cannot read leaves the rest of what it is owed.
			if (worked && !watching && !workers && !usage) unrun = this.wakes.read(agentId, worked.file, agentDir);
		} catch (error) {
			unread = true;
			notResumed(storeFailure(agentId, error, undefined));
		}
		const waiting = !watching && botInboxWaiting(agentDir, agentId) ? ports.waiting(agentId) : [];
		if (!watching && !workers && !usage && !unrun && waiting.length === 0) {
			// Owed nothing it could read: an attempt armed for an earlier failure is not needed; one armed for this read is.
			if (!unread) this.openRetries.forget(agentId);
			return;
		}
		const cwds = [...(worked ? [worked.cwd] : []), ...waiting.map((item) => item.message.from.cwd)];
		// It opens for a root its session works in one of those directories for: a bot of its own works where that root works,
		// a profile's where its profile compiles to for that root.
		let sender: BotSender | undefined;
		try {
			// The same directory however it was written (a symlink, a trailing separator, the case of a Windows drive).
			const places = new Set(cwds.map(realPathIdentity));
			const candidates = [...cwds.map((cwd) => ports.senderIn(cwd)), ports.sender()];
			sender = candidates.find(
				(candidate): candidate is BotSender =>
					candidate !== undefined && places.has(realPathIdentity(ports.definedCwd(record, candidate))),
			);
		} catch (error) {
			notResumed(error);
			return;
		}
		if (!sender) {
			const where = [...new Set(cwds)].join(", ");
			this.tellWaits(agentId, interfaceText().botTeam.botOwedWorkNoRoot(agentId, where));
			return;
		}
		// Refused on what defines it now, for a cause that still holds: not opened again until either changes.
		if (this.stillRefused(agentId, record, sender, !watching && !workers && !usage && waiting.length === 0)) return;
		const key = ports.currentKey(record, sender);
		// What waits in the inbox, read here too when the bot is owed its watches (the listing above skipped it then).
		const inbox = (watching ? ports.waiting(agentId) : waiting).map((item) => item.file).join("\n");
		const failed = this.failedOpens.get(agentId);
		if (swept && failed !== undefined && failed.key === key && failed.inbox === inbox) return;
		void ports.open(agentId, sender).catch((error: unknown) => {
			// A model refused before the lock is kept with its cause; a cause that passes on its own is asked again after a
			// backoff; any other failure at the next change, and by the periodic listing only once what defines the bot or what
			// waits in its inbox changed.
			this.failedOpens.delete(agentId);
			if (error instanceof BotModelRefusedError) this.record(agentId, "open", key, error);
			else this.forgetRefusal(agentId);
			if (ports.heldElsewhere(agentId)) return;
			const later = notResumed(error);
			if (!(error instanceof BotModelRefusedError) && !later) this.failedOpens.set(agentId, { key, inbox });
		});
	}

	/** The owner is told once what the bot's owed work waits on: every attach and every other host's change asks again. */
	private tellWaits(agentId: string, message: string): void {
		if (this.told.get(agentId) !== message) this.ports.warn(message);
		this.told.set(agentId, message);
	}
}
