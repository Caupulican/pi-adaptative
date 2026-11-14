/**
 * What a bot's own session is owed, read from the store and its file without loading it: a live watch to sample, a firing
 * whose wake it has not taken, or a wake it accepted and never ran (a turn refused at its start); and the opening of the
 * session of a bot owed work that no process hosts (`BotOwedWork`). And the one rule that keeps watches with the session
 * that holds them: the watches the home's other sessions armed are cancelled when the bot continues one session.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ParentInputIndex } from "../../kernel/session/parent-input-ledger.ts";
import { readSessionHeader } from "../../kernel/session/session-file-reading.ts";
import type { SessionManager } from "../../kernel/session/session-manager.ts";
import { realPathIdentity } from "../autonomy/path-scope.ts";
import type { PersistentBotRecord, PersistentBotTeamStore } from "../delegation/persistent-bot-team-store.ts";
import { interfaceText } from "../language/interface-text.ts";
import { liveOwnWatches } from "../routines/routine-holder.ts";
import { alarmAt, type TimerPort, type WallAlarm } from "../util/timer-port.ts";
import { type BotInboxItem, botInboxWaiting } from "./bot-inbox.ts";
import { type BotModelRefusal, BotModelRefusedError } from "./bot-model-refusal.ts";
import { readSessionSnapshot, type SavedBotSession } from "./bot-remote-view.ts";
import type { BotSender } from "./bot-session-host.ts";

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
	readonly cause: string | undefined;
}

/**
 * The invariant of the one place a bot's session id is chosen (the host's `load`): the bot's watches target that id. A
 * watch is held by the runtime of the session it targets, so a watch another session of the bot's home armed would be held
 * by none once the bot continues another: such watches are cancelled. Returns how many were.
 */
export function cancelOtherSessionsWatches(
	store: WatchStore,
	sessionsDir: string,
	sessionId: string,
	nowMs: number,
): number {
	const others = readdirSync(sessionsDir)
		.filter((name) => name.endsWith(".jsonl"))
		.flatMap((name) => readSessionHeader(join(sessionsDir, name))?.id ?? [])
		.filter((id) => id !== sessionId);
	let cancelled = 0;
	for (const other of others)
		for (const routine of store.listRoutines({ sessionId: other, scope: "own-watches" }))
			if (store.deleteRoutine(routine.routineId, undefined, nowMs)) cancelled++;
	return cancelled;
}

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
	/** The root attached last, and an attached root working in `cwd`. */
	sender(): BotSender;
	senderIn(cwd: string): BotSender | undefined;
	/** Opens the bot's session for `sender`. */
	open(agentId: string, sender: BotSender): Promise<unknown>;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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

	constructor(ports: BotOwedWorkPorts) {
		this.ports = ports;
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

	/** The bot's session loaded: what it was owed is its own now, and its file is read again when next asked. */
	loaded(agentId: string): void {
		this.told.delete(agentId);
		this.wakes.forget(agentId);
	}

	/** The bot was released (retired, or off the session path): nothing of it is kept. */
	released(agentId: string): void {
		this.wakes.forget(agentId);
		this.forgetRefusal(agentId);
	}

	/** The host stopped: no alarm takes work up after it. */
	stop(): void {
		for (const alarm of this.alarms.values()) alarm.stop();
		this.alarms.clear();
	}

	private record(agentId: string, scope: RecordedRefusal["scope"], key: string | undefined, error: unknown): void {
		const refusal = error instanceof BotModelRefusedError ? error.refusal : undefined;
		this.refusals.set(agentId, { scope, key, cause: refusal?.reason });
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
	 * cause now. When it does, the retake is armed at the cause's end as recorded now (a reset can be recorded later).
	 */
	private stillRefused(agentId: string, record: PersistentBotRecord, sender: BotSender, onlyWakes: boolean): boolean {
		const recorded = this.refusals.get(agentId);
		if (!recorded || (recorded.scope === "run" && !onlyWakes)) return false;
		const key = this.ports.currentKey(record, sender);
		const now = key === undefined ? undefined : this.ports.modelRefusal(record, sender);
		if (recorded.key !== key || recorded.cause !== now?.reason) return false;
		this.armRetake(agentId, now?.clearsAt);
		return true;
	}

	/**
	 * Opens the bot's session when no process hosts it and it is owed: its home's session holds live watches or a fired
	 * watch's wake not yet taken, its file holds a wake it accepted and never ran (a turn refused at its start: only its own
	 * recovery runs it), or its inbox holds messages another process sent. A watch is sampled and its wake delivered
	 * only by its own session, and an inbox is taken only by the host of the session, so a process that starts, sees a host
	 * let the bot go or die, or rebuilds a session on a changed record takes them up again. A session with watches is opened
	 * only by a process working in the directory it worked in (a watch's relative path reads against it); one owed only its
	 * inbox (a bot whose session never ran is owed nothing else), also by a process working where a waiting message was
	 * sent from. Another process that opened it first is not a failure.
	 */
	openIfOwed(agentId: string): void {
		const { ports } = this;
		const agentDir = ports.agentDir();
		if (ports.stopped() || ports.hostedHere(agentId) || ports.heldElsewhere(agentId)) return;
		const record = ports.store().getBot(agentId);
		if (!record || record.retired || !ports.runsAsSession(record)) return;
		// A bot whose session never ran (no file, or one naming no directory) holds no watch: it is owed only its inbox.
		const saved = ports.savedSessionOf(agentId);
		const worked = saved?.cwd === undefined ? undefined : { ...saved, cwd: saved.cwd };
		const notResumed = (error: unknown) =>
			this.tellWaits(agentId, interfaceText().botTeam.botWatchesNotResumed(agentId, errorText(error)));
		const watching = worked !== undefined && owesWatchWork(ports.store(), worked.id, ports.timers().now());
		let unrun = "";
		try {
			// The file, only when the store owes nothing; a file it cannot read leaves the rest of what it is owed.
			if (worked && !watching) unrun = this.wakes.read(agentId, worked.file, agentDir);
		} catch (error) {
			notResumed(error);
		}
		const waiting = !watching && botInboxWaiting(agentDir, agentId) ? ports.waiting(agentId) : [];
		if (!watching && !unrun && waiting.length === 0) return;
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
		if (this.stillRefused(agentId, record, sender, !watching && waiting.length === 0)) return;
		const key = ports.currentKey(record, sender);
		void ports.open(agentId, sender).catch((error: unknown) => {
			// A model refused before the lock is kept with its cause; any other failure is asked again at the next change.
			if (error instanceof BotModelRefusedError) this.record(agentId, "open", key, error);
			else this.forgetRefusal(agentId);
			if (!ports.heldElsewhere(agentId)) notResumed(error);
		});
	}

	/** The owner is told once what the bot's owed work waits on: every attach and every other host's change asks again. */
	private tellWaits(agentId: string, message: string): void {
		if (this.told.get(agentId) !== message) this.ports.warn(message);
		this.told.set(agentId, message);
	}
}
