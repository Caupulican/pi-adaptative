/**
 * What a bot's own session is owed, read from the store, its bundle and its file without loading it: a live watch to
 * sample, a firing whose wake it has not taken, a wake it accepted and never ran (a turn refused at its start), its
 * workers' work (`owesWorkerExecutionAt`, and what they hold to deliver) and the turn a usage limit stopped
 * (`savedUsageResumeAt`); and the opening of the session of a bot owed work that no process hosts (`BotOwedWork`), at once
 * or when the work comes due, after the owner's stop waiting for it is applied (`applyUnhostedBotStop`). And the one rule
 * that keeps watches with the session that holds them: the watches the home's other sessions armed are cancelled when the
 * bot continues one session.
 */

import { existsSync, statSync } from "node:fs";
import { ParentInputIndex } from "../../kernel/session/parent-input-ledger.ts";
import type { OrchestrationHome } from "../../kernel/session/session-bundle-paths.ts";
import type { SessionManager } from "../../kernel/session/session-manager.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import { realPathIdentity } from "../autonomy/path-scope.ts";
import type { PersistentBotRecord, PersistentBotTeamStore } from "../delegation/persistent-bot-team-store.ts";
import { OWNER_STOPPED_REASON, WHOLE_FLEET_STOP_SCOPE } from "../delegation/worker-fleet-stop.ts";
import {
	nextWorkerDueAt,
	owesWorkerExecutionAt,
	type WorkerWorkFacts,
	workerWorkFacts,
} from "../delegation/worker-owed-work.ts";
import type { GoalState } from "../goals/goal-state.ts";
import { getLatestGoalStateSnapshot } from "../goals/session-goal-state.ts";
import { interfaceText } from "../language/interface-text.ts";
import { OrchestrationEventStore } from "../orchestration/event-store.ts";
import { OrchestrationSnapshotRequiredError } from "../orchestration/event-store-errors.ts";
import { readTaskRuntimeProjection } from "../orchestration/task-runtime-reader.ts";
import { botSessionStorageRoots } from "../orchestration-homes.ts";
import { liveOwnWatches } from "../routines/routine-holder.ts";
import { goalUsageStop, type RestoredUsageRules, restoredUsageStop } from "../usage-reset-resume.ts";
import { latestUsageWake, type UsageWakeRecord } from "../usage-wake-record.ts";
import { alarmAt, type RepeatingAlarm, repeatEvery, type TimerPort, type WallAlarm } from "../util/timer-port.ts";
import { botFailureCause, botFailureText, logBotsFailure } from "./bot-failure-words.ts";
import { botHomeOf, botHomeSessionIds } from "./bot-home.ts";
import { fileIdentity } from "./bot-home-records.ts";
import type { RemoteBotHost } from "./bot-host-state.ts";
import { type BotInboxItem, botInboxStopNames, botInboxWaiting } from "./bot-inbox.ts";
import { type BotModelRefusal, type BotModelRefusalCause, BotModelRefusedError } from "./bot-model-refusal.ts";
import { BotOpenRetries, botOpenFailure, cappedFailure, storeFailure } from "./bot-open-retry.ts";
import { readSessionSnapshot, remoteHostActive, type SavedBotSession } from "./bot-remote-view.ts";
import type { BotSender } from "./bot-session-host.ts";
import {
	applyUnhostedBotStop,
	type BotStopPorts,
	type OwnerStopRequest,
	readStopScope,
	STOP_TAKE,
	type UnrecordedBotStops,
	writeOwnerStop,
} from "./bot-stop.ts";

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

/** What the time a saved transcript continues reads beside the rule of a kept stop: the reset recorded for a model. */
export interface SavedUsageResumeRules extends RestoredUsageRules {
	modelExhaustion(ref: string): { readonly until: number | undefined } | undefined;
}

/**
 * What of a bot's saved session file the time it continues reads (`restoredUsageStop` on the messages its load seeds its
 * agent with and on its goal): the refusal its messages end on and its goal when a usage or rate limit stopped it, each
 * only when it holds one, with its latest wake; undefined when neither does. Reads the whole file.
 */
interface SavedUsageStop {
	readonly lastMessage: AgentMessage | undefined;
	readonly goal: GoalState | undefined;
	readonly wake: UsageWakeRecord | undefined;
}

function readSavedUsageStop(file: string, agentDir: string): SavedUsageStop | undefined {
	return readSessionSnapshot(file, agentDir, (view) => {
		const last = view.buildSessionContext().messages.at(-1);
		const lastMessage = last?.role === "assistant" && last.stopReason === "error" ? last : undefined;
		const latestGoal = getLatestGoalStateSnapshot(view);
		const goal = latestGoal && goalUsageStop(latestGoal) ? latestGoal : undefined;
		return lastMessage || goal ? { lastMessage, goal, wake: latestUsageWake(view) } : undefined;
	});
}

/**
 * When the bot's saved session continues the turn or goal a subscription's usage limit stopped (`stop`, read by
 * {@link SavedUsageStopLedger}), moved later by the exhaustion the provider admission recorded for the refusing model, as
 * the live session's wake moves it: a closed bot is not opened against a limit that still holds. The rules are read at
 * each ask. Undefined when it waits for none.
 */
function savedUsageResumeAt(stop: SavedUsageStop | undefined, rules: SavedUsageResumeRules): number | undefined {
	const restored = stop && restoredUsageStop(stop.lastMessage, stop.goal, stop.wake, rules);
	if (!restored) return undefined;
	const until = rules.modelExhaustion(restored.resume.ref)?.until;
	return until !== undefined && until > restored.at ? until : restored.at;
}

/** A saved session file as the host read it for its usage wait; `fresh` the first time it did not read with that identity. */
type SavedUsageRead =
	| { readonly kind: "read"; readonly stop: SavedUsageStop | undefined }
	| { readonly kind: "unreadable"; readonly error: unknown; readonly fresh: boolean };

/**
 * What the host knows of each closed bot's saved session file for its usage wait (`readSavedUsageStop`): read again only
 * once the file's identity (`fileIdentity`, taken before the read) changed, so an unchanged
 * transcript is not parsed at every attach and host change. A file that did not read is kept with the identity it failed
 * on, reported once. What the stop holds alone is kept, one record per bot, none when it holds no stop.
 */
class SavedUsageStopLedger {
	private readonly reads = new Map<
		string,
		{ readonly file: string; readonly identity: string | undefined; readonly read: SavedUsageRead }
	>();

	read(agentId: string, file: string, agentDir: string): SavedUsageRead {
		const identity = fileIdentity(file);
		const known = this.reads.get(agentId);
		if (known?.file === file && known.identity === identity)
			return known.read.kind === "unreadable" ? { ...known.read, fresh: false } : known.read;
		let read: SavedUsageRead;
		try {
			read = { kind: "read", stop: readSavedUsageStop(file, agentDir) };
		} catch (error) {
			read = { kind: "unreadable", error, fresh: true };
		}
		this.reads.set(agentId, { file, identity, read });
		return read;
	}

	/** The bot's session loaded, or the bot was released: its file is read again when next asked. */
	forget(agentId: string): void {
		this.reads.delete(agentId);
	}
}

/** A bundle as the host read it: none; its facts; or the error it did not read with, `fresh` the first time its files read so. */
type BundleRead =
	| { readonly kind: "none" }
	| { readonly kind: "facts"; readonly facts: WorkerWorkFacts }
	| { readonly kind: "unreadable"; readonly error: unknown; readonly fresh: boolean };

/**
 * What the host knows of the worker work each bot's bundle owes (`workerWorkFacts`): the projection is replayed again only
 * once the store committed since the last read, so the periodic listing costs a stat and an absent next event file per bot
 * whose store did not change. A bundle that did not read is read again only once its files change (`bundleFilesIdentity`),
 * so a corrupt one costs stats, not a replay, at each listing. The facts alone are kept, one record per bot.
 */
class WorkerWorkLedger {
	private readonly reads = new Map<
		string,
		{ readonly dir: string; readonly ino: number; readonly lastOrdinal: number; readonly facts: WorkerWorkFacts }
	>();
	private readonly failures = new Map<string, { readonly identity: string; readonly error: unknown }>();

	/** What the bundle of the bot's session `sessionId` in `home` owes. */
	read(agentId: string, home: OrchestrationHome, sessionId: string): BundleRead {
		const store = new OrchestrationEventStore({ orchestrationHome: home, sessionId });
		if (!existsSync(store.rootDir)) {
			this.forget(agentId);
			return { kind: "none" };
		}
		const identity = bundleFilesIdentity(store);
		const failed = this.failures.get(agentId);
		if (failed?.identity === identity) return { kind: "unreadable", error: failed.error, fresh: false };
		try {
			const ino = statSync(store.rootDir).ino;
			const known = this.reads.get(agentId);
			if (known?.dir === store.rootDir && known.ino === ino && committedNothingAfter(store, known.lastOrdinal))
				return { kind: "facts", facts: known.facts };
			const state = readTaskRuntimeProjection(store);
			const facts = workerWorkFacts(state);
			this.reads.set(agentId, { dir: store.rootDir, ino, lastOrdinal: state.lastOrdinal, facts });
			this.failures.delete(agentId);
			return { kind: "facts", facts };
		} catch (error) {
			// Kept with the identity of the files it failed on: reported once, read again once they change.
			this.reads.delete(agentId);
			this.failures.set(agentId, { identity, error });
			return { kind: "unreadable", error, fresh: true };
		}
	}

	/** The bot's session loaded, or the bot was released: its bundle is read again when next asked. */
	forget(agentId: string): void {
		this.reads.delete(agentId);
		this.failures.delete(agentId);
	}
}

/**
 * The identity of a bundle's files without reading them: the inode and modification time of its directory, its events
 * and its snapshots (a commit adds an event file, a compaction a snapshot). A stat that fails names its error code.
 */
function bundleFilesIdentity(store: OrchestrationEventStore): string {
	return [store.rootDir, store.eventsDir, store.snapshotsDir]
		.map((path) => {
			try {
				const stat = statSync(path, { throwIfNoEntry: false });
				return stat ? `${stat.ino}:${stat.mtimeMs}` : "-";
			} catch (error) {
				return `!${(error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error))}`;
			}
		})
		.join(" ");
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
	const others = botHomeSessionIds(sessionsDir, "refuse").filter((id) => id !== sessionId);
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
export const OWED_INBOX_SWEEP_MS = 60 * 1000;

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
	/** Whether another host holds the bot's lock now; the host takes the bot up again when that hold changes. */
	heldElsewhere(agentId: string): boolean;
	/** The host, in another process or another host of this one, holding the bot's lock now; it throws when it does not read. */
	hostOf(agentId: string): RemoteBotHost | undefined;
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
	/** What applying a stop reads: the owner's warnings, the admission clock, what was told of the bot's links. */
	stopPorts(): BotStopPorts;
	/** A refusal's cause may have cleared: the host takes the bot's refused work up again. */
	retake(agentId: string): void;
	/** Takes the inbox of a bot the host runs. */
	takeInbox(agentId: string): void;
	/** The root attached last, and an attached root working in `cwd`. */
	sender(): BotSender;
	senderIn(cwd: string): BotSender | undefined;
	/** Opens the bot's session for `sender`. */
	open(agentId: string, sender: BotSender): Promise<unknown>;
	/** What reads the time a saved session continues what a usage limit stopped (`savedUsageResumeAt`). */
	usageRules(): SavedUsageResumeRules;
}

/** One running ask to open a bot, and the asks gathered while it runs (see {@link BotOwedWork.openIfOwed}). */
interface AskPass {
	again?: { readonly swept: boolean };
}

/**
 * What {@link BotOwedWork.applyOwnerStop} left: whether a stop still waits in the bot's inbox, holding back the work it
 * stops; whether applying it failed (the owner told); and whether it is tried again after a backoff.
 */
interface OwnerStopOutcome {
	readonly waits: boolean;
	readonly failed: boolean;
	readonly retrying: boolean;
}

/**
 * Opens the session of a bot owed work that no process hosts (see {@link BotOwedWork.openIfOwed}), and tells the owner,
 * once for each cause, what the work waits on when it cannot be taken up here. A refusal is kept with its cause, and the
 * work it held back is taken up again once the cause no longer holds: read again at every ask, and at the time a model
 * refusal's recorded end comes (a quota exhaustion's reset), on the provider admission clock, never by polling the model.
 */
export class BotOwedWork {
	private readonly ports: BotOwedWorkPorts;
	/**
	 * Bots whose owed work waits on something (no root works where it does, its session did not open), with every sentence
	 * the owner was told of it: each is told once, until its waits clear (an ask finds it owed nothing and tells nothing, or
	 * not this host's to open), its session loads or the bot is released.
	 */
	private readonly told = new Map<string, Set<string>>();
	/** What the owner was told of a bot the periodic listing failed on: each cause told once, forgotten once it lists clean. */
	private readonly sweepTold = new Map<string, Set<string>>();
	/**
	 * Each bot whose ask to open (`openIfOwed`) runs now (its reads, and the open it started until that settles), and
	 * whether another ask for it came meanwhile (`swept` when every such ask was the periodic listing's).
	 */
	private readonly asking = new Map<string, AskPass>();
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
	/** What each closed bot's saved session file holds of a usage stop, read once per file identity. */
	private readonly usageStops = new SavedUsageStopLedger();
	/** The alarm at the time a bot's saved session continues what a usage limit stopped (`armOwedAt`). */
	private readonly usageWaits = new Map<string, WallAlarm>();
	/** Bots whose usage wait ended while no process hosted them: owed their session's open until it loads. */
	private readonly usageDue = new Set<string>();
	/** The alarm at the next time a bot's workers come due (a retry, an unbound lease's term), with its time. */
	private readonly retryWaits = new Map<string, { readonly at: number; readonly alarm: WallAlarm }>();
	/**
	 * The items each bot's bundle held to deliver when its session last closed here (`closed`): the session's open could not
	 * deliver them, so they do not open the session again.
	 */
	private readonly offered = new Map<string, ReadonlySet<string>>();
	/**
	 * The stops waiting for each bot when applying them last failed here, and the cause the owner was told of it
	 * ({@link applyOwnerStop}, `botFailureCause`).
	 */
	private readonly failedStops = new Map<string, { readonly key: string; readonly cause: string }>();
	/**
	 * The owner's stops this process could not record, held until a take applies them; its opens of a bot take them too.
	 * They are its process's and agent directory's, kept across its hosts (`bot-session-registry.ts`).
	 */
	readonly unrecorded: UnrecordedBotStops;

	constructor(ports: BotOwedWorkPorts, unrecorded: UnrecordedBotStops) {
		this.ports = ports;
		this.unrecorded = unrecorded;
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
	 * Why a message the owner sent waits for the bot's session, which failed to open with `error` and opens later
	 * ({@link openLater}). A sender that shows it (`shown`: the send's `waitsFor`) has told the owner, so it counts as
	 * told; else the owner is told here. Either way an open asked again for the same cause tells nothing more.
	 */
	sentWaits(agentId: string, error: unknown, shown: boolean): string {
		const reason = botFailureText(agentId, error);
		const text = this.waitsText(agentId, reason);
		if (shown) this.toldOf(agentId).add(text);
		else this.tellWaits(agentId, text);
		return reason;
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
		this.usageStops.forget(agentId);
		this.failedOpens.delete(agentId);
		this.openRetries.forget(agentId);
		this.forgetOwedTimes(agentId);
	}

	/**
	 * The bot's session closed here, its bundle's writes done: the items the bundle holds to deliver now are what the session
	 * could not deliver while it ran (a receipt or an end an owner that only a live session registers holds, a parent write
	 * whose import keeps failing), so it opens the session for none of them; only an item not among them does. Kept in this
	 * process only: a process that starts opens such a bot once.
	 */
	closed(agentId: string): void {
		const { ports } = this;
		const record = ports.store().getBot(agentId);
		// A host that stopped, or a bot released (retired, or off the session path), is owed nothing here.
		if (ports.stopped() || !record || record.retired || !ports.runsAsSession(record)) return;
		const saved = this.savedRead(agentId);
		const read = saved?.id === undefined ? undefined : this.workerFacts(agentId, saved.id);
		if (read?.kind === "facts") this.offered.set(agentId, new Set(read.facts.deliveryItems));
		else this.offered.delete(agentId);
		this.unhosted(agentId, saved);
	}

	/**
	 * Whether the workers of the bot's loaded session `sessionId`, whose bundle is in `home`, owe it execution now
	 * (`owesWorkerExecutionAt`): queued or resumable work, a retry due, a lease its recovery takes back. Its idle close waits
	 * for them; what it holds to deliver does not hold it (its own deliveries take that up while it runs). Read through the
	 * bundle ledger (a replay only once the store committed); a bundle that does not read owes nothing here, and the owner
	 * is told once.
	 */
	owesLoadedExecution(agentId: string, home: OrchestrationHome, sessionId: string): boolean {
		const read = this.workerWork.read(agentId, home, sessionId);
		if (read.kind === "unreadable" && read.fresh) this.notReadable(agentId, read.error);
		return read.kind === "facts" && owesWorkerExecutionAt(read.facts, this.ports.timers().now());
	}

	/**
	 * No process hosts the bot now (this process found it so, or its session closed here): its session is opened at the time
	 * its saved session `saved` continues what a usage limit stopped (`savedUsageResumeAt`), and now for what it owes
	 * ({@link armOwedAt}). A saved session that does not read arms no usage wait, and the owner is told.
	 */
	unhosted(agentId: string, saved = this.savedRead(agentId)): void {
		this.armOwedAt(agentId, this.usageResumeAt(agentId, saved));
	}

	/** The bot's saved session; undefined when its home does not read, which {@link openIfOwed} tells the owner. */
	private savedRead(agentId: string): SavedBotSession | undefined {
		try {
			return this.ports.savedSessionOf(agentId);
		} catch {
			return undefined;
		}
	}

	/** When the bot's saved session continues what a usage limit stopped; none while a process hosts it (its own wait runs). */
	private usageResumeAt(agentId: string, saved: SavedBotSession | undefined): number | undefined {
		const { ports } = this;
		if (saved?.cwd === undefined || ports.stopped() || ports.hostedHere(agentId) || ports.heldElsewhere(agentId))
			return undefined;
		const read = this.usageStops.read(agentId, saved.file, ports.agentDir());
		if (read.kind === "unreadable" && read.fresh) this.notReadable(agentId, read.error);
		return read.kind === "read" ? savedUsageResumeAt(read.stop, ports.usageRules()) : undefined;
	}

	/** The owner is told what of the bot's session store did not read (`storeFailure`). */
	private notReadable(agentId: string, error: unknown): void {
		this.tellWaits(
			agentId,
			interfaceText().botTeam.botWatchesNotResumed(
				agentId,
				botFailureText(agentId, storeFailure(agentId, error, undefined)),
			),
		);
	}

	/** The bot was released (retired, or off the session path): nothing of it is kept. */
	released(agentId: string): void {
		this.offered.delete(agentId);
		this.failedStops.delete(agentId);
		this.told.delete(agentId);
		this.sweepTold.delete(agentId);
		this.wakes.forget(agentId);
		this.usageStops.forget(agentId);
		this.forgetRefusal(agentId);
		this.failedOpens.delete(agentId);
		this.openRetries.forget(agentId);
		this.forgetOwedTimes(agentId);
		this.unrecorded.drop(agentId);
	}

	/**
	 * The host stopped: no alarm takes work up after it. The stops it held stay held, for the host that replaces it in its
	 * process (`bot-session-registry.ts`).
	 */
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
		this.armUsageWait(agentId, usageResumeAt);
		this.openIfOwed(agentId);
	}

	/** Opens the bot's session at `usageResumeAt`, on the provider admission clock; any earlier usage alarm ends. */
	private armUsageWait(agentId: string, usageResumeAt: number | undefined): void {
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
	}

	/** Opens the bot's session at `at`, the next time its workers come due; any earlier alarm ends, the same time keeps it. */
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

	/** What the workers of the bot's saved session `sessionId` owe, read from its bundle. */
	private workerFacts(agentId: string, sessionId: string): BundleRead {
		return this.workerWork.read(agentId, botSessionHome(this.ports.agentDir(), agentId, sessionId), sessionId);
	}

	/**
	 * Whether the workers of the bot's saved session `sessionId` owe its open at `nowMs`, and the next time they come due:
	 * execution (`owesWorkerExecutionAt`), or an item to deliver the session did not hold when it last closed here
	 * (`closed`). A bundle that does not read is returned as such.
	 */
	private workerOwed(
		agentId: string,
		sessionId: string,
		nowMs: number,
	):
		| { readonly owed: boolean; readonly dueAt: number | undefined }
		| { readonly unreadable: unknown; readonly fresh: boolean } {
		const read = this.workerFacts(agentId, sessionId);
		if (read.kind === "none") return { owed: false, dueAt: undefined };
		if (read.kind === "unreadable") return { unreadable: read.error, fresh: read.fresh };
		const { facts } = read;
		const offered = this.offered.get(agentId);
		return {
			owed: owesWorkerExecutionAt(facts, nowMs) || facts.deliveryItems.some((item) => offered?.has(item) !== true),
			dueAt: nextWorkerDueAt(facts, nowMs),
		};
	}

	/**
	 * Whether a bot no process hosts is owed its session's open beside its inbox, as the periodic listing asks: a usage wait
	 * that ended, or its workers' work. A bundle that does not read asks once, so {@link openIfOwed} reports it, and again
	 * only once its files change.
	 */
	private owedBeyondInbox(agentId: string): boolean {
		if (this.usageDue.has(agentId)) return true;
		const sessionId = this.savedRead(agentId)?.id;
		if (sessionId === undefined) return false;
		const owed = this.workerOwed(agentId, sessionId, this.ports.timers().now());
		return "unreadable" in owed ? owed.fresh : owed.owed;
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
			let bots: readonly { readonly agentId: string }[];
			try {
				bots = this.ports.store().listBots();
			} catch (error) {
				logBotsFailure("the owed-work listing could not list the bots", error);
				return;
			}
			// Each bot on its own: one whose files fail to read is told once per cause until it lists clean again, and the
			// bots after it are listed.
			for (const { agentId } of bots)
				try {
					if (this.sweepBot(agentDir, agentId)) this.sweepTold.delete(agentId);
				} catch (error) {
					const message = interfaceText().botTeam.botSweepFailed(agentId, botFailureText(agentId, error));
					const told = this.sweepTold.get(agentId) ?? new Set<string>();
					this.sweepTold.set(agentId, told);
					if (told.has(message)) continue;
					this.ports.warn(message);
					told.add(message);
				}
		});
	}

	/**
	 * One bot of the periodic listing ({@link sweepInboxes}); whether its inbox listed clean (false when it did not list and a
	 * held stop's failed take told why). While another process hosts the bot, a stop held here is recorded for that host to
	 * take ({@link UnrecordedBotStops.recordLate}).
	 */
	private sweepBot(agentDir: string, agentId: string): boolean {
		if (this.ports.hostedHere(agentId)) {
			if (botInboxWaiting(agentDir, agentId) || botInboxStopNames(agentDir, agentId).length > 0)
				this.ports.takeInbox(agentId);
			return true;
		}
		// A stop waiting is applied whether or not the bot's next open is armed: it does not wait for the backoff. A stop held
		// here is tried even when the inbox does not list, as an ask tries it; its take reads the inbox under the lock, so a
		// listing that keeps failing fails it, told once as the stop not applied, not again as the sweep's failure.
		if (!this.ports.heldElsewhere(agentId)) {
			let stops: readonly string[] | undefined;
			let unlisted: unknown;
			try {
				stops = botInboxStopNames(agentDir, agentId);
			} catch (error) {
				unlisted = error;
			}
			const stop =
				this.unrecorded.of(agentId) || (stops !== undefined && stops.length > 0)
					? this.applyOwnerStop(agentId, true, stops)
					: undefined;
			if (stops === undefined) {
				if (stop?.failed) return false;
				throw unlisted;
			}
		} else this.unrecorded.recordLate(agentId, (line) => this.ports.warn(line));
		const waiting = botInboxWaiting(agentDir, agentId);
		if (
			!this.openRetries.pending(agentId) &&
			(waiting || (!this.ports.heldElsewhere(agentId) && this.owedBeyondInbox(agentId)))
		)
			this.openIfOwed(agentId, true);
		return true;
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
	 * watch's wake not yet taken, its workers owe it work (execution, `owesWorkerExecutionAt`, or something to deliver it has not been offered: only its own recovery takes it up), the
	 * usage wait {@link armOwedAt} armed has ended, its file holds a wake it accepted and never ran (a turn refused at its
	 * start: only its own recovery runs it), or its inbox holds messages another process sent. The next time its workers
	 * come due is armed here. A watch is sampled and its wake delivered
	 * only by its own session, and an inbox is taken only by the host of the session, so a process that starts, sees a host
	 * let the bot go or die, or rebuilds a session on a changed record takes them up again. A session with watches is opened
	 * only by a process working in the directory it worked in (a watch's relative path reads against it); one owed only its
	 * inbox (a bot whose session never ran is owed nothing else), also by a process working where a waiting message was
	 * sent from. Another process that opened it first is not a failure. `swept` (the periodic listing asks) skips a bot
	 * whose last open failed on what defines it now and the inbox files waiting now. Asks for the bot made while one runs
	 * (a host change the home watch reports as it starts, when this ask's read starts it; any change while the open it
	 * started is pending) are gathered into one more pass after it settles, which reads the bot again: two passes at once
	 * would share one open and arm its next attempt twice, and dropping the later ask would miss a change made after the
	 * running one read the bot.
	 */
	openIfOwed(agentId: string, swept = false): void {
		const running = this.asking.get(agentId);
		if (running) {
			running.again = { swept: (running.again?.swept ?? true) && swept };
			return;
		}
		const pass: AskPass = {};
		this.asking.set(agentId, pass);
		let opened: Promise<unknown> | undefined;
		try {
			opened = this.askOpen(agentId, swept);
		} catch (error) {
			this.finishAsk(agentId, pass);
			throw error;
		}
		if (opened) void opened.finally(() => this.finishAsk(agentId, pass));
		else this.finishAsk(agentId, pass);
	}

	/** The bot's running ask settled: the asks gathered meanwhile run as one more pass. */
	private finishAsk(agentId: string, pass: AskPass): void {
		this.asking.delete(agentId);
		const again = pass.again;
		if (!again) return;
		// Only listings asked: answered as the listing answers, not while the bot's next attempt is armed.
		if (again.swept && this.openRetries.pending(agentId)) return;
		// No caller waits on this pass (it runs as the one before it settles, or after its open did): a read that throws
		// is told to the owner as the pass's own reads that fail are.
		try {
			this.openIfOwed(agentId, again.swept);
		} catch (error) {
			this.tellWaits(agentId, this.waitsText(agentId, botFailureText(agentId, error)));
		}
	}

	/** Reads the bot and opens its session when it is owed; the open it started, if any. */
	private askOpen(agentId: string, swept: boolean): Promise<unknown> | undefined {
		const { ports } = this;
		const agentDir = ports.agentDir();
		if (ports.stopped()) return;
		// Its host continues what a usage limit stopped (its session's own wait): this process owes it nothing.
		if (ports.heldElsewhere(agentId)) this.usageDue.delete(agentId);
		// The stops waiting in its inbox, listed once: the owner's stop applied first and the work it holds back read the same.
		let stopNames: readonly string[] | undefined;
		let unlisted: unknown;
		try {
			stopNames = botInboxStopNames(agentDir, agentId);
		} catch (error) {
			unlisted = error;
		}
		// The owner's stop first, whatever else it is owed: a stop that failed for a cause that passes on its own is retried.
		const stop = ports.heldElsewhere(agentId) ? undefined : this.applyOwnerStop(agentId, swept, stopNames);
		const stopRetrying = stop?.retrying === true;
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
			this.told.delete(agentId);
			return;
		}
		// A cause that passes on its own is asked again after a backoff, armed once for this attempt whichever read or open
		// failed; any other cause at the next change. Whether the session opens later is returned.
		let retrying = stopRetrying;
		let toldNow = false;
		const notResumed = (error: unknown): boolean => {
			toldNow = true;
			const failure = botOpenFailure(error);
			if (failure !== undefined && !retrying) retrying = this.openRetries.arm(agentId, cappedFailure(failure));
			this.tellWaits(agentId, this.waitsText(agentId, botFailureText(agentId, error)));
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
		// Stops that did not list may hold back any of its work: it waits, and the owner is told why once (a held stop that
		// failed to apply told it already).
		if (stopNames === undefined) {
			if (!stop?.failed) notResumed(storeFailure(agentId, unlisted, undefined));
			return;
		}
		// A stop the owner wrote while another process hosted it (`requestBotStop`) holds back the work it stopped: its
		// workers and its usage wait open nothing until a host takes the stop (opened for anything else, it takes it first).
		const stopWaiting = stop?.waits === true;
		// Its workers' work, and the next time they come due armed; a bundle it cannot read leaves the rest it is owed.
		const owed = worked && !stopWaiting ? this.workerOwed(agentId, worked.id, ports.timers().now()) : undefined;
		if (owed && "unreadable" in owed) notResumed(owed.unreadable);
		const workers = owed !== undefined && "owed" in owed && owed.owed;
		this.armRetry(agentId, owed && "dueAt" in owed ? owed.dueAt : undefined);
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
			// Owed nothing it could read: an attempt armed for an earlier failure is not needed; one armed for this read is. With
			// nothing told in this ask its waits cleared, and what was told of them is forgotten.
			if (!unread && !stopRetrying) this.openRetries.forget(agentId);
			if (!toldNow) this.told.delete(agentId);
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
		return ports.open(agentId, sender).catch((error: unknown) => {
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

	/**
	 * Applies the owner's stop waiting for the bot while no process hosts it (`applyUnhostedBotStop`); its usage wait and
	 * alarms end with it. `inbox` names the stops waiting in its inbox, as the caller listed them (undefined when they did
	 * not list: only a stop held here is applied then). A stop it could not apply keeps waiting, holding back the work it
	 * stops, and the owner is told once per stops waiting and cause (a failed take keeps a held stop held); a stop that does
	 * not read stops nothing and holds nothing back;
	 * `swept` (the periodic listing asks) tries it again only once the stops waiting change; a failure that passes on its own
	 * (`botOpenFailure`) is tried again after the backoff of the bot's next open (`retrying`). The owner's
	 * stop of a bot this process does not host writes the stop (`requestBotStop`) and asks the bot open ({@link ownerStopped}),
	 * which calls this; a host holding the bot takes it instead. A stop that could not be written is held
	 * (`UnrecordedBotStops`) and applied with the ones waiting, the messages sent before it refused, here or by this
	 * process's open of the bot, ending the work there was when it was made; while another process holds the bot's lock, it
	 * is recorded late for that process to take (`UnrecordedBotStops.recordLate`).
	 */
	applyOwnerStop(agentId: string, swept: boolean, inbox: readonly string[] | undefined): OwnerStopOutcome {
		const none: OwnerStopOutcome = { waits: false, failed: false, retrying: false };
		if (this.ports.stopped() || this.ports.hostedHere(agentId)) return none;
		const agentDir = this.ports.agentDir();
		// Nothing waits when no stop is held here and the inbox listed none, or did not list (only a held stop is applied then).
		const nothingWaits = () =>
			this.unrecorded.of(agentId) === undefined && (inbox === undefined || inbox.length === 0);
		// The stops waiting as a failed application is keyed: the listed ones, or an inbox that did not list, and the one held;
		// the listing tries a failed application again once it changes.
		const waiting = () => {
			const held = this.unrecorded.of(agentId);
			return [...(inbox === undefined ? ["unlisted"] : inbox), ...(held ? [`held ${held.at}`] : [])].join("\n");
		};
		// What waits in the inbox until a take: all the listed stops while none ran here, or another process holds the lock.
		const waits = inbox !== undefined && inbox.length > 0;
		if (nothingWaits()) {
			// Known to hold none only once the inbox listed.
			if (inbox !== undefined) this.failedStops.delete(agentId);
			return none;
		}
		if (swept && this.failedStops.get(agentId)?.key === waiting()) return { waits, failed: true, retrying: false };
		try {
			// Applied, the alarms it held back end, and the usage wait is read again from what the stop wrote to the session the
			// take read (a saved session that is a symbolic link is left, and the rest of the stop applies all the same).
			const taken = applyUnhostedBotStop(agentDir, agentId, this.ports.stopPorts(), this.unrecorded);
			if (taken === "held") {
				// Held by another host, which takes it once it is recorded; held by this process's own open, that open takes it.
				if (this.ports.heldElsewhere(agentId)) this.unrecorded.recordLate(agentId, (line) => this.ports.warn(line));
			} else if (taken.stop) {
				this.forgetOwedTimes(agentId);
				this.armUsageWait(
					agentId,
					this.usageResumeAt(agentId, "saved" in taken.session ? taken.session.saved : undefined),
				);
			}
			this.failedStops.delete(agentId);
			// A take applied the newest stop that reads; one that does not read has no date to order it by and stops nothing,
			// left in place or not, so nothing waits after it.
			return { waits: taken === "held" ? waits : false, failed: false, retrying: false };
		} catch (error) {
			// Told once for the stops that wait and the cause, and again once either changes (a new stop, one taken or dropped,
			// an inbox that stopped listing, another cause); the listing asks again only once the stops change.
			const key = waiting();
			const known = this.failedStops.get(agentId);
			if (swept && known?.key === key) return { waits, failed: true, retrying: false };
			const failure = storeFailure(agentId, error, undefined);
			const cause = botFailureCause(STOP_TAKE, agentId, failure);
			this.failedStops.set(agentId, { key, cause });
			const passing = botOpenFailure(failure);
			const retrying = passing !== undefined && this.openRetries.arm(agentId, cappedFailure(passing));
			if (known?.key !== key || known.cause !== cause)
				this.ports.warn(interfaceText().botTeam.botStopNotApplied(agentId, botFailureText(agentId, failure)));
			return { waits, failed: true, retrying };
		}
	}

	/**
	 * The owner's stop of a bot this process does not host, made from `from`: dated now, with the work there is as it is
	 * dated (`readStopScope`), and written (`requestBotStop`), which covers a stop held for the bot ({@link
	 * UnrecordedBotStops.drop}), or held scoped to that work when it cannot be (told to the owner, then {@link
	 * UnrecordedBotStops.hold}; dropped and told when that work did not read); the bot is asked open, which applies the
	 * stops waiting first. A written stop is
	 * taken by the host running the bot, if one does: that host is returned, for the owner to be told where the stop went.
	 * It never throws, so the owner's stop of this process's other work goes on: a read that fails is told to the owner, the
	 * open's as a later pass's is, the host's as the one place the stop went that could not be named.
	 */
	ownerStopped(agentId: string, from: OwnerStopRequest["from"]): RemoteBotHost | undefined {
		const agentDir = this.ports.agentDir();
		const [words, made] = [interfaceText().botTeam, readStopScope(agentDir, agentId)];
		const stop = { agentId, reasonCode: OWNER_STOPPED_REASON, from, at: Date.now() };
		const unwritten = writeOwnerStop(agentDir, { ...stop, scope: WHOLE_FLEET_STOP_SCOPE }, (line) =>
			this.ports.warn(line),
		);
		if (unwritten === undefined) this.unrecorded.drop(agentId);
		else {
			this.ports.warn(words.botStopNotRecorded(agentId, unwritten));
			if ("scope" in made) this.unrecorded.hold({ ...stop, scope: made.scope });
			else {
				const why = words.botStopDropReasons.workUnread(botFailureText(agentId, made.unread));
				this.ports.warn(words.botStopDropped(agentId, why));
			}
		}
		try {
			this.openIfOwed(agentId);
		} catch (error) {
			this.tellWaits(agentId, this.waitsText(agentId, botFailureText(agentId, error)));
		}
		if (unwritten !== undefined) return undefined;
		try {
			const host = this.ports.hostOf(agentId);
			return remoteHostActive(host) ? host : undefined;
		} catch (error) {
			this.ports.warn(interfaceText().botTeam.botStopHostUnread(agentId, botFailureText(agentId, error)));
			return undefined;
		}
	}

	/** What the owner is told the bot's owed work waits on when its session did not open for `reason`. */
	private waitsText(agentId: string, reason: string): string {
		return interfaceText().botTeam.botWatchesNotResumed(agentId, reason);
	}

	/** What the owner was told the bot's owed work waits on ({@link told}). */
	private toldOf(agentId: string): Set<string> {
		let told = this.told.get(agentId);
		if (!told) {
			told = new Set();
			this.told.set(agentId, told);
		}
		return told;
	}

	/**
	 * The owner is told once each thing the bot's owed work waits on, however the asks that meet it interleave: every attach
	 * and every other host's change asks again.
	 */
	private tellWaits(agentId: string, message: string): void {
		const told = this.toldOf(agentId);
		if (told.has(message)) return;
		this.ports.warn(message);
		told.add(message);
	}
}
