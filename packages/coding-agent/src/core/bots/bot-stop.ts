/**
 * Taking the owner's stop of a bot (`requestBotStop` records it in the bot's inbox): whichever process takes it applies it,
 * and deletes it only then. The process hosting the bot's session applies it through the live session
 * (`takeHostedBotStops`). Any other process applies it while no process hosts the bot, durably and under the bot's host
 * lock (`applyUnhostedBotStop`), so a stop never waits for a host that may never come; one that finds the lock held leaves
 * it to the holder, and the work it stopped stays held back until then (`BotOwedWork`).
 *
 * What it ends: the bot's own work first, which the stop waits on until it is ended: every open plan is closed and every
 * unended worker attempt cancelled, the bot's parent agents included (`OWNER_STOPPED_REASON`, whose ends wake no one), then
 * the bot's goal is paused when it runs or the system would resume it on its own and the owner has not set it going since
 * the stop was made (`holdPersistedGoalForOwnerStop`; the owner resumes it), and the usage-limit wait of every usage stop
 * made until the owner's is declined (`declineUsageWaitForOwner`, once per stop). The stop is then taken, and every job a
 * session of the bot's home placed on another machine is ended, so nothing goes on spending; a failure there is told to the
 * owner and does not keep the stop. A managed lane is left to the extension that runs it, and the owner is told.
 *
 * Order: a stop ends the work there is when it is made. An inbox message whose `at` is at or before the stop's (sent before
 * it, or in the same millisecond, which the stop is read to cover) is refused with the owner-stopped reason; one after it is
 * the owner's next words and waits for the session.
 */

import { existsSync, statSync } from "node:fs";
import type { OrchestrationHome } from "../../kernel/session/session-bundle-paths.ts";
import { readSessionHeaderResult } from "../../kernel/session/session-header.ts";
import { SessionManager } from "../../kernel/session/session-manager.ts";
import { botHostLockFile, orchestrationEventStoreDir } from "../agent-paths.ts";
import type { AgentSession } from "../agent-session.ts";
import { OWNER_STOPPED_REASON, stopSessionWorkers, type WorkerStopOutcome } from "../delegation/worker-fleet-stop.ts";
import { holdPersistedGoalForOwnerStop, type PersistedGoalStateHost } from "../goals/goal-lifecycle.ts";
import { appendGoalStateSnapshot, getLatestGoalStateSnapshot } from "../goals/session-goal-state.ts";
import { interfaceText } from "../language/interface-text.ts";
import { OrchestrationEventStore } from "../orchestration/event-store.ts";
import { DurableTaskRuntime } from "../orchestration/task-runtime.ts";
import { botSessionStorageRoots } from "../orchestration-homes.ts";
import { takeProcessLock } from "../remote/host-lock.ts";
import { endPlacedJobsOfSessions } from "../remote/job-client.ts";
import { jobCancelReasonOf } from "../remote/remote-jobs.ts";
import { declineUsageWaitForOwner, type UsageWakeLog, type UsageWakeWriter } from "../usage-wake-record.ts";
import { errorText } from "./bot-error-text.ts";
import { botFailureText } from "./bot-failure-words.ts";
import { botHomeOf, botHomeOwnSessionIds } from "./bot-home.ts";
import { LEFTOVER_REREAD_MAX_MINUTES, tellUnreadableHomeRecord } from "./bot-home-records.ts";
import {
	type BotInboxStop,
	readBotInbox,
	readBotInboxStops,
	refuseBotInboxMessage,
	requestBotStop,
	takeBotInboxStop,
} from "./bot-inbox.ts";
import { BotOwnerError } from "./bot-owner-error.ts";
import { botSessionOnDisk, type SavedBotSession } from "./bot-remote-view.ts";
import { BotSessionLinkError } from "./bot-session-pointer.ts";

/** What applying a stop needs besides the bot's files: the owner's notices, and the provider admission clock's time. */
export interface BotStopPorts {
	warn(message: string): void;
	now(): number;
}

/** The live session of a hosted bot, as its stop reaches it. */
export interface HostedBotStopSession {
	readonly goal: PersistedGoalStateHost;
	readonly transcript: UsageWakeLog & UsageWakeWriter;
	readonly fleet: { cancelOwnFleet(reasonCode: string): WorkerStopOutcome };
}

/**
 * The stop applied at `now` to a hosted bot's live session (its foreground turn already stopped by the host): its whole
 * fleet cancelled (`cancelOwnFleet`), then its goal held and its usage wait declined as of when the stop was made. What it
 * left unended, by why.
 */
export function applyOwnerStopToSession(
	session: HostedBotStopSession,
	stop: OwnerStop,
	now: number,
): WorkerStopOutcome {
	const outcome = session.fleet.cancelOwnFleet(stop.reasonCode);
	holdForOwnerStop(session, stop, now);
	return outcome;
}

/** What applying an owner's stop reads of it: when it was made, and the reason its cancelled work ends with. */
export type OwnerStop = Pick<BotInboxStop, "at" | "reasonCode">;

/** The bot's goal held and its usage wait declined at `now`, as of when the owner's stop was made. */
function holdForOwnerStop(session: Omit<HostedBotStopSession, "fleet">, stop: OwnerStop, now: number): void {
	holdPersistedGoalForOwnerStop(session.goal, stop.at, new Date(now).toISOString());
	declineUsageWaitForOwner(session.transcript, stop.at, now);
}

/**
 * Takes the stops waiting for the bot this process hosts in session `sessionId`: the newest is applied through `stopHere`
 * (the host stops the foreground turn and calls {@link applyOwnerStopToSession}), the jobs the home's other sessions placed
 * are ended (no client of theirs runs: the host holds the bot), the messages it covers are refused, and every stop read is
 * deleted ({@link takeStops}). A stop held in memory (`memory`) is taken with them. The stop applied, undefined when none
 * waits.
 */
export function takeHostedBotStops(
	agentDir: string,
	agentId: string,
	sessionId: string,
	stopHere: (stop: OwnerStop) => WorkerStopOutcome,
	ports: BotStopPorts,
	memory?: OwnerStop,
): OwnerStop | undefined {
	return takeStops(
		agentDir,
		agentId,
		stopHere,
		(stop) =>
			endHomePlacedJobs(
				agentDir,
				agentId,
				(ids) => ids.filter((id) => id !== sessionId),
				stop.reasonCode,
				ports.warn,
			),
		ports,
		memory,
	);
}

/**
 * Ends the jobs the sessions of bot `agentId`'s home placed on other machines, for `reasonCode` (no client of theirs runs:
 * the caller holds the bot): the home listed now ({@link homeSessionIds}), `placedBy` choosing which of its sessions (the
 * one the caller ended through its live client left out, a closed session's own added). It runs after the bot's own work
 * ended and never holds that back: a failure is told to the owner with its cause, and the stop or release goes on.
 */
function endHomePlacedJobs(
	agentDir: string,
	agentId: string,
	placedBy: (homeSessionIds: readonly string[]) => readonly string[],
	reasonCode: string,
	warn: (message: string) => void,
): void {
	try {
		const sessions = new Set(placedBy(homeSessionIds(agentDir, agentId, warn)));
		endPlacedJobsOfSessions(agentDir, sessions, jobCancelReasonOf(reasonCode));
	} catch (error) {
		warn(interfaceText().botTeam.botPlacedJobsNotEnded(agentId, botFailureText(agentId, error)));
	}
}

/**
 * The sessions bot `agentId`'s home holds as files of its own, whose placed jobs are the bot's to end: a session file that
 * is a symbolic link is skipped (the jobs of whatever session it names are not the bot's), and the owner told which.
 */
function homeSessionIds(agentDir: string, agentId: string, warn: (message: string) => void): string[] {
	const { ids, linked } = botHomeOwnSessionIds(botHomeOf(agentDir, agentId).sessionsDir);
	if (linked.length > 0) warn(interfaceText().botTeam.botLinkedSessionsJobsLeft(agentId, linked));
	return ids;
}

/**
 * The work of bot `agentId`'s session this process has loaded, ended for `reasonCode` as the owner's stop of a hosted bot
 * ends it, for a release of the bot (retired, or off the session path) and for a stop that could not be recorded or taken
 * ({@link endUnrecordedStopWork}): its whole fleet (`cancelOwnFleet`), then the jobs its home's other sessions placed.
 * What it left unended.
 */
export function endLoadedBotWork(
	agentDir: string,
	agentId: string,
	session: Pick<AgentSession, "sessionId" | "backgroundLanes">,
	reasonCode: string,
	warn: (message: string) => void,
): WorkerStopOutcome {
	const outcome = session.backgroundLanes.cancelOwnFleet(reasonCode);
	endHomePlacedJobs(agentDir, agentId, (ids) => ids.filter((id) => id !== session.sessionId), reasonCode, warn);
	return outcome;
}

/**
 * The owner's stop of bot `agentId`, whose session this process hosts, when it was not taken from its record: its
 * foreground turn (`stopTurn`) and its own work ({@link endLoadedBotWork}) end all the same. A stop held in memory
 * (`stop`: one that could not be recorded, or whose record no longer reads) also holds the bot's goal, declines its
 * usage wait as of when it was made and refuses the messages sent before it, as a stop taken from its record does; a stop recorded and not taken (`stop` absent)
 * leaves those to its record, which is tried again. What it left unended; undefined when its workers could not be ended.
 * Each failure is told to the owner with its cause.
 */
export function endUnrecordedStopWork(
	agentDir: string,
	agentId: string,
	loaded: LoadedBotSession,
	stopTurn: () => void,
	stop: OwnerStop | undefined,
	ports: BotStopPorts,
): WorkerStopOutcome | undefined {
	stopTurn();
	let outcome: WorkerStopOutcome | undefined;
	try {
		outcome = endLoadedBotWork(agentDir, agentId, loaded.session, OWNER_STOPPED_REASON, ports.warn);
		if (outcome.failed.length > 0 || outcome.managed.length > 0)
			ports.warn(interfaceText().botTeam.botStopLeftLanes(agentId, outcome.failed.length, outcome.managed.length));
	} catch (error) {
		ports.warn(interfaceText().botTeam.botStopWorkersNotEnded(agentId, botFailureText(agentId, error)));
	}
	if (stop) {
		try {
			holdForOwnerStop(hostedStopSession(loaded), stop, ports.now());
		} catch (error) {
			ports.warn(interfaceText().botTeam.botStopGoalNotHeld(agentId, botFailureText(agentId, error)));
		}
		try {
			refuseMessagesBeforeStop(agentDir, agentId, stop.at, ports);
		} catch (error) {
			ports.warn(interfaceText().botTeam.botStopMessagesNotRefused(agentId, botFailureText(agentId, error)));
		}
	}
	return outcome;
}

/**
 * Refuses the messages waiting for bot `agentId` that were sent at or before the owner's stop made at `at`: the stop
 * covers them, whether it is taken from its record or held in memory. A failure throws, with the rest left waiting.
 */
function refuseMessagesBeforeStop(agentDir: string, agentId: string, at: number, ports: BotStopPorts): void {
	const reason = interfaceText().botTeam.botTurnAbortReasons.ownerStopped;
	const unreadable = tellUnreadableHomeRecord(agentId, "inboxMessage", (message) => ports.warn(message));
	for (const item of readBotInbox(agentDir, agentId, unreadable))
		if (item.message.at <= at) refuseBotInboxMessage(agentDir, item, reason, ports.now());
}

/**
 * Applies the stops waiting for bot `agentId` while no process hosts it, under its host lock: its saved session's workers
 * ended (`cancelBundleWorkers`), its goal paused and its usage wait declined in its transcript, the messages the stop
 * covers refused and the stops deleted, then the jobs every session of its home placed ended, all in one synchronous run
 * that releases the lock at its end. The caller found a stop waiting (in the inbox, or held by `unrecorded`). The session is
 * read from the bot's home on disk under the lock ({@link UnrecordedBotStops.underLock}). A bot with no saved session has
 * only its home's placed jobs, its messages and its stops to take; one whose saved session is a symbolic link
 * ({@link ClosedBotSession}) has its session's work left, the owner told. `held` when another process holds the lock (its
 * host takes the stop), else what the take applied. A failure throws, the lock released and the stop left waiting. A stop
 * this process could not record is applied with them, as the newest when it is, while the bot's work stands where it was
 * when the stop was made ({@link UnrecordedBotStops}).
 */
export function applyUnhostedBotStop(
	agentDir: string,
	agentId: string,
	ports: BotStopPorts,
	unrecorded: UnrecordedBotStops,
): "held" | LockedBotStop {
	const taken = takeProcessLock(botHostLockFile(agentDir, agentId));
	if (!taken.held) return "held";
	try {
		return unrecorded.underLock(agentId, ports);
	} finally {
		taken.lock.release();
	}
}

/**
 * The stop waiting for bot `agentId` applied to its closed session `saved` while the caller holds the bot's host lock and
 * no session of it is open: by {@link applyUnhostedBotStop}, and by a host that took the lock to open the bot's session,
 * before the session is built, so nothing the session's recovery would resume runs. The stop the take applied, if any; a
 * failure throws with the stop left waiting. A stop held in memory (`memory`) is taken as one
 * waiting.
 */
function applyBotStopUnderLock(
	agentDir: string,
	agentId: string,
	session: ClosedBotSession,
	ports: BotStopPorts,
	memory?: OwnerStop,
): OwnerStop | undefined {
	const saved = "saved" in session ? session.saved : undefined;
	return takeStops(
		agentDir,
		agentId,
		(stop, warn) => {
			if ("saved" in session) return stopClosedSession(agentDir, agentId, saved, stop, { warn, now: ports.now });
			// Nothing is ended through the link: the rest of the stop applies, and the owner is told what it left.
			warn(interfaceText().botTeam.botStopLinkedSessionLeft(agentId, session.linked));
			return NOTHING_LEFT;
		},
		(stop) =>
			endHomePlacedJobs(agentDir, agentId, (ids) => (saved ? [...ids, saved.id] : ids), stop.reasonCode, ports.warn),
		ports,
		memory,
	);
}

/**
 * A closed bot's saved session as its stop reads it: the session (none when the bot has none), or the path of the symbolic
 * link its pointer or session file is, through which no work is ended.
 */
export type ClosedBotSession = { readonly saved: SavedBotSession | undefined } | { readonly linked: string };

/** A closed bot's saved session read through `read`, a writer's read that refuses a link ({@link ClosedBotSession}). */
export function readClosedBotSession(read: () => SavedBotSession | undefined): ClosedBotSession {
	try {
		return { saved: read() };
	} catch (error) {
		if (error instanceof BotSessionLinkError) return { linked: error.path };
		throw error;
	}
}

/** A bot's session loaded in this process, and the transcript it writes, as the owner's stop reaches them. */
export interface LoadedBotSession {
	readonly session: Pick<
		AgentSession,
		"sessionId" | "getGoalStateSnapshot" | "saveGoalStateSnapshot" | "backgroundLanes"
	>;
	readonly sessionManager: UsageWakeLog & UsageWakeWriter;
}

/** A loaded bot session as the owner's stop reaches it: its goal, the transcript it writes and its fleet. */
function hostedStopSession({ session, sessionManager }: LoadedBotSession): HostedBotStopSession {
	return {
		goal: {
			getGoalStateSnapshot: () => session.getGoalStateSnapshot(),
			saveGoalStateSnapshot: (state, expected) => session.saveGoalStateSnapshot(state, expected),
		},
		transcript: sessionManager,
		fleet: session.backgroundLanes,
	};
}

/** A take of the stops waiting for a hosted bot (`stopLoadedBot`). */
export interface LoadedBotStop {
	/** The stop applied; absent when none read or the take failed. */
	readonly stop?: OwnerStop;
	/** What the stop ended and left unended, a failed take's up to its failure included; nothing when none read. */
	readonly outcome: WorkerStopOutcome;
	/** Why the take failed, the stops left waiting. */
	readonly failure?: { readonly cause: unknown };
}

/**
 * Takes the stops waiting for the bot whose session this process hosts ({@link takeHostedBotStops}): the turn it runs
 * stopped for the owner by `stopTurn` (the host's, which the words it gives next wait on until the turn ended), then
 * {@link applyOwnerStopToSession}. A failure is handed back with what the stop had already ended, never thrown, so the
 * lanes its cancel ended before the failure are counted with what a fallback ends after it. A stop held in memory
 * (`memory`) is taken with the ones waiting.
 */
export function stopLoadedBot(
	agentDir: string,
	agentId: string,
	loaded: LoadedBotSession,
	stopTurn: () => void,
	ports: BotStopPorts,
	memory?: OwnerStop,
): LoadedBotStop {
	let outcome: WorkerStopOutcome = NOTHING_LEFT;
	try {
		const live = hostedStopSession(loaded);
		const stop = takeHostedBotStops(
			agentDir,
			agentId,
			loaded.session.sessionId,
			(taken) => {
				stopTurn();
				outcome = applyOwnerStopToSession(live, taken, ports.now());
				return outcome;
			},
			ports,
			memory,
		);
		return stop ? { stop, outcome } : { outcome };
	} catch (cause) {
		return { outcome, failure: { cause } };
	}
}

const NOTHING_LEFT: WorkerStopOutcome = { remote: [], managed: [], failed: [], stopped: 0 };

/**
 * Where a closed bot's own work stood: its saved session as its stop reads it (none, or the link it is), and the last event
 * of that session's bundle (0 when it has none). A process that runs the bot moves one of them before any work it starts
 * there: a worker it starts, a plan it opens or a job it places is an event of that bundle, and a new session is a new one.
 */
interface BotWorkMark {
	readonly session: string | undefined;
	readonly linked: string | undefined;
	readonly head: number;
}

/**
 * Where bot `agentId`'s closed session `session`, as its home on disk holds it, stands now ({@link BotWorkMark}): its
 * bundle's last event read from the store's file names (`lastCommittedOrdinal`), without replaying the bundle.
 */
function workMarkOf(agentDir: string, agentId: string, session: ClosedBotSession): BotWorkMark {
	if ("linked" in session) return { session: undefined, linked: session.linked, head: 0 };
	const bundle = closedBundle(agentDir, agentId, session.saved);
	const store =
		bundle &&
		existsSync(orchestrationEventStoreDir(bundle.home, bundle.sessionId)) &&
		new OrchestrationEventStore({ orchestrationHome: bundle.home, sessionId: bundle.sessionId });
	return {
		session: session.saved?.id,
		linked: undefined,
		head: store ? store.lastCommittedOrdinal() : 0,
	};
}

const sameWorkMark = (a: BotWorkMark, b: BotWorkMark): boolean =>
	a.session === b.session && a.linked === b.linked && a.head === b.head;

/** Bot `agentId`'s closed session as its home on disk holds it now: never a view's cache, which may lag a change. */
function closedSessionOnDisk(agentDir: string, agentId: string): ClosedBotSession {
	return readClosedBotSession(() => botSessionOnDisk(agentDir, agentId));
}

/** Where a bot's work stood when a stop was made ({@link BotWorkMark}), or why that did not read. */
export type WorkMarkReading = { readonly mark: BotWorkMark } | { readonly unread: unknown };

function markReading(read: () => BotWorkMark): WorkMarkReading {
	try {
		return { mark: read() };
	} catch (error) {
		return { unread: error };
	}
}

/**
 * Where bot `agentId`'s work stands now, read from its home on disk without writing it, as the owner's stop is made (its
 * `at` stamped): a read that fails is handed back, for the stop that could not be recorded to be dropped and told.
 */
export function readWorkMark(agentDir: string, agentId: string): WorkMarkReading {
	return markReading(() => workMarkOf(agentDir, agentId, closedSessionOnDisk(agentDir, agentId)));
}

/** The owner's stop as `requestBotStop` writes it. */
export type OwnerStopRequest = Parameters<typeof requestBotStop>[1];

/**
 * Writes the owner's stop to the bot's home (`requestBotStop`): why it could not be written, undefined once it is. A stop
 * written is recorded even when the older stops it replaces were not removed, which is told through `warn`.
 */
export function writeOwnerStop(
	agentDir: string,
	stop: OwnerStopRequest,
	warn: (message: string) => void,
): string | undefined {
	let written: ReturnType<typeof requestBotStop>;
	try {
		written = requestBotStop(agentDir, stop);
	} catch (error) {
		return errorText(error);
	}
	if (written.olderLeft !== undefined)
		warn(interfaceText().botTeam.botStopOlderLeft(stop.agentId, botFailureText(stop.agentId, written.olderLeft)));
	return undefined;
}

/** The owner's stop that could not be recorded, with where the bot's work stood when it was made ({@link readWorkMark}). */
export interface UnrecordedOwnerStop {
	readonly stop: OwnerStop;
	readonly mark: WorkMarkReading;
}

/** A stop held in memory, with where the bot's work stood when it was made. */
interface HeldOwnerStop {
	readonly stop: OwnerStop;
	readonly mark: BotWorkMark;
}

/** A take of the stops waiting for a closed bot under its host lock: the stop it applied, if any, and its session as it read it. */
export interface LockedBotStop {
	readonly stop?: OwnerStop;
	readonly session: ClosedBotSession;
}

/**
 * The owner's stops this process could not record (`requestBotStop` failed) for bots it does not host, the newest per bot,
 * kept for the process and agent directory across its hosts in turn (`bot-session-registry.ts`: a root session replaced by
 * a new or resumed one keeps them), held until a take of the bot's stops applies one: the unhosted application
 * ({@link applyUnhostedBotStop}), or this process's open of the bot's session, under its lock before the session is built
 * ({@link underLock}) and once it is built ({@link loaded}), so a stop made while the open runs is taken by it. A take that
 * applied it, or a newer stop that covers it, ends the hold; a failed one keeps it for the next.
 *
 * No other process learns of it, so it ends only the work there was when it was made: each stop is held with where the
 * bot's work stood as it was stamped ({@link readWorkMark}), and a take under the lock reads the bot's session from its home
 * on disk once, for that comparison and for the stop it applies, and drops the stop when the work moved, since a process
 * ran the bot since and what is there now came after the stop. Its own failed take marks it again where that take left the
 * bot. A read that fails inside a take keeps the stop held and fails the take. A stop held while this process opens or
 * closes the bot is marked where it found the bot then: the open's take once the session is built applies it under the same
 * lock, and what an open that failed, or a close, wrote after drops it. One whose mark does not read (as it was made, or
 * after its own take failed) is not held. A stop dropped either way is told to the owner once (`botStopDropped`), with the
 * way to make it again.
 */
export class UnrecordedBotStops {
	private readonly held = new Map<string, HeldOwnerStop>();
	private readonly agentDir: string;

	constructor(agentDir: string) {
		this.agentDir = agentDir;
	}

	/**
	 * Holds the stop for the bot, marked where its work stood when it was made, unless a newer one is held. One whose mark
	 * did not read is dropped, the owner told, and leaves an older stop held as it was.
	 */
	hold(agentId: string, unrecorded: UnrecordedOwnerStop, warn: (message: string) => void): void {
		const held = this.held.get(agentId);
		if (held && unrecorded.stop.at < held.stop.at) return;
		if ("mark" in unrecorded.mark) this.held.set(agentId, { stop: unrecorded.stop, mark: unrecorded.mark.mark });
		else tellUnreadDrop(agentId, unrecorded.mark.unread, warn);
	}

	/** The stop held for the bot. */
	of(agentId: string): OwnerStop | undefined {
		return this.held.get(agentId)?.stop;
	}

	/** The bot was released (retired, or off the session path): no stop is held for it. */
	drop(agentId: string): void {
		this.held.delete(agentId);
	}

	/** Whether no stop is held, for any bot. */
	isEmpty(): boolean {
		return this.held.size === 0;
	}

	/**
	 * {@link applyBotStopUnderLock} under the lock the caller just took, on the bot's session as its home on disk holds it,
	 * the stop held for the bot taken with the ones waiting while the bot's work stands where it was when the stop was made,
	 * and dropped otherwise (see the class).
	 */
	underLock(agentId: string, ports: BotStopPorts): LockedBotStop {
		const session = closedSessionOnDisk(this.agentDir, agentId);
		const marked = this.held.get(agentId);
		if (marked && !sameWorkMark(marked.mark, workMarkOf(this.agentDir, agentId, session))) {
			this.held.delete(agentId);
			const text = interfaceText().botTeam;
			ports.warn(text.botStopDropped(agentId, text.botStopDropReasons.workChanged));
		}
		const memory = this.held.get(agentId);
		try {
			const stop = applyBotStopUnderLock(this.agentDir, agentId, session, ports, memory?.stop);
			this.taken(agentId, memory);
			return { stop, session };
		} catch (error) {
			// What the take ended before it failed is this process's own move of the bot's work.
			if (memory) {
				const mark = markReading(() => workMarkOf(this.agentDir, agentId, session));
				this.keep(agentId, { stop: memory.stop, mark }, ports.warn);
			}
			throw error;
		}
	}

	/**
	 * {@link stopLoadedBot} of a session just built, no turn running yet, under the lock its open took: the held stop was
	 * made since the take under it ({@link underLock}), so it ends the session's whole work; it is kept when the take failed.
	 */
	loaded(agentId: string, loaded: LoadedBotSession, ports: BotStopPorts): LoadedBotStop {
		const memory = this.held.get(agentId);
		const taken = stopLoadedBot(this.agentDir, agentId, loaded, () => {}, ports, memory?.stop);
		if (taken.failure === undefined) this.taken(agentId, memory);
		return taken;
	}

	/** A take that read `held` (the one held when it began) applied it or a newer one: it is held no longer. */
	private taken(agentId: string, held: HeldOwnerStop | undefined): void {
		if (held !== undefined && this.held.get(agentId) === held) this.held.delete(agentId);
	}

	/** Holds the stop at its mark; one whose mark did not read is dropped, and the owner told (see the class). */
	private keep(agentId: string, { stop, mark }: UnrecordedOwnerStop, warn: (message: string) => void): void {
		if ("mark" in mark) {
			this.held.set(agentId, { stop, mark: mark.mark });
			return;
		}
		this.held.delete(agentId);
		tellUnreadDrop(agentId, mark.unread, warn);
	}
}

/** The owner is told a stop was dropped because where the bot's work stands did not read (`unread`). */
function tellUnreadDrop(agentId: string, unread: unknown, warn: (message: string) => void): void {
	const text = interfaceText().botTeam;
	warn(text.botStopDropped(agentId, text.botStopDropReasons.workUnread(botFailureText(agentId, unread))));
}

/**
 * The stop applied to a closed bot's own work, its host lock held: its saved session's transcript read first, then its
 * bundle's workers ended, then the transcript written.
 */
function stopClosedSession(
	agentDir: string,
	agentId: string,
	saved: SavedBotSession | undefined,
	stop: OwnerStop,
	ports: BotStopPorts,
): WorkerStopOutcome {
	const bundle = closedBundle(agentDir, agentId, saved);
	const transcript = saved && bundle && closedTranscript(agentDir, agentId, bundle.home, saved, ports);
	const outcome =
		bundle === undefined ? NOTHING_LEFT : cancelBundleWorkers(bundle.home, bundle.sessionId, stop.reasonCode);
	if (transcript) {
		const now = ports.now();
		holdPersistedGoalForOwnerStop(closedGoalHost(transcript), stop.at, new Date(now).toISOString());
		declineUsageWaitForOwner(transcript, stop.at, now);
	}
	return outcome;
}

/**
 * Where a closed bot's own work is: its saved session's bundle, in the home its id resolves to now (the bot's, or the
 * owner's it was left in); none when the bot has no saved session.
 */
function closedBundle(
	agentDir: string,
	agentId: string,
	saved: SavedBotSession | undefined,
): { readonly home: OrchestrationHome; readonly sessionId: string } | undefined {
	const home = botHomeOf(agentDir, agentId);
	return (
		saved && {
			home: botSessionStorageRoots(agentDir, home.orchestrationHome, saved.id).orchestrationHome,
			sessionId: saved.id,
		}
	);
}

/**
 * The work bot `agentId`'s closed session left, ended for `reasonCode` as a stop of it while no process hosts it ends
 * it, under its host lock: its bundle's queued and recovered attempts ({@link cancelBundleWorkers}), then the jobs its
 * home's sessions placed ({@link endHomePlacedJobs}). A saved session that is a symbolic link ({@link ClosedBotSession})
 * has its own work left, the owner told, and the jobs its home's other sessions placed still end. For a release of the bot
 * (retired, or off the session path) with no session of it loaded here, so nothing a later open of it would resume is
 * left. What it left unended. A lock held (by the host of the bot, or by this process opening or closing it) throws the
 * owner's words: the release stays owed and runs again.
 */
export function endClosedBotWork(
	agentDir: string,
	agentId: string,
	session: ClosedBotSession,
	reasonCode: string,
	warn: (message: string) => void,
): WorkerStopOutcome {
	const taken = takeProcessLock(botHostLockFile(agentDir, agentId));
	if (!taken.held) throw new BotOwnerError(interfaceText().botTeam.botReleaseHeldBy(taken.owner.pid));
	try {
		const saved = "saved" in session ? session.saved : undefined;
		// Nothing is ended through the link: the owner is told, under the lock, so a release owed again tells it once.
		if ("linked" in session) warn(interfaceText().botTeam.botReleaseWorkersLeft(agentId, session.linked));
		const bundle = closedBundle(agentDir, agentId, saved);
		const outcome =
			bundle === undefined ? NOTHING_LEFT : cancelBundleWorkers(bundle.home, bundle.sessionId, reasonCode);
		endHomePlacedJobs(agentDir, agentId, (ids) => (saved ? [...ids, saved.id] : ids), reasonCode, warn);
		return outcome;
	} finally {
		taken.lock.release();
	}
}

/**
 * The closed session's transcript the stop writes: none when its file is not written yet (it holds no goal and no usage
 * wait), or when it holds another session, which the stop leaves as it is and the owner is told of.
 */
function closedTranscript(
	agentDir: string,
	agentId: string,
	orchestrationHome: OrchestrationHome,
	saved: SavedBotSession,
	ports: BotStopPorts,
): SessionManager | undefined {
	if (!existsSync(saved.file) || statSync(saved.file).size === 0) return undefined;
	const header = readSessionHeaderResult(saved.file);
	// A file that does not read leaves the stop waiting; one that reads as another session's, or none, is not the bot's.
	if (!header.ok && header.reason === "unreadable") throw header.cause;
	if (!header.ok || header.header.id !== saved.id) {
		ports.warn(interfaceText().botTeam.botStopSessionFileForeign(agentId, saved.file, saved.id));
		return undefined;
	}
	return SessionManager.open(saved.file, { agentDir, orchestrationHome });
}

/** The goal of a closed session's transcript, read and written as the session's own goal store does. */
function closedGoalHost(transcript: SessionManager): PersistedGoalStateHost {
	return {
		getGoalStateSnapshot: () => getLatestGoalStateSnapshot(transcript),
		saveGoalStateSnapshot: (state) =>
			appendGoalStateSnapshot(transcript, state, getLatestGoalStateSnapshot(transcript)),
	};
}

/**
 * The owner's stop of the workers of the closed bot session `sessionId`, whose bundle is in `home`, while no process
 * hosts the bot, written to its bundle alone (`stopSessionWorkers`): every open plan closed and every unended worker
 * attempt cancelled for `reasonCode`, so nothing opens the session for them. Their ends are recorded delivered by the
 * session's next open, when its outbox is replayed (`owner_stopped` wakes no one). It runs before the jobs the home's
 * sessions placed are ended, so no open dispatches a lane again for a job that end reaches. The caller holds the bot's host
 * lock, so no process runs what it cancels. What it left unended.
 */
function cancelBundleWorkers(home: OrchestrationHome, sessionId: string, reasonCode: string): WorkerStopOutcome {
	if (!existsSync(orchestrationEventStoreDir(home, sessionId))) return NOTHING_LEFT;
	const runtime = new DurableTaskRuntime({
		store: new OrchestrationEventStore({ orchestrationHome: home, sessionId }),
	});
	return stopSessionWorkers(
		runtime,
		undefined,
		(attempt) => {
			runtime.cancelAttempt(attempt.attemptId, reasonCode);
			return false;
		},
		reasonCode,
	);
}

/**
 * Takes the stops waiting for bot `agentId`: the newest is applied to the bot's own work by `ownWork`, which must end it (a
 * failure throws with the stops left waiting, and what it told the owner is dropped, so a retry tells it once); then the
 * stop is taken (the messages it covers refused, every stop read deleted) and what `ownWork` told is told; then the jobs
 * the home's sessions placed are ended by `placedJobs`, which never keeps the stop. A stop that could not be recorded
 * (`memory`) is taken with them, applied when it is the newest; it covers the messages sent before it all the same. A
 * stop that does not read has no date to order it by and stops nothing: it is set aside and told as a stop, or, when it
 * could not be set aside, told once as one left in place, a leftover (`bot-home-records.ts`) no listing counts as
 * waiting until its backoff's read is due or it changes, read again then and not told again. The stop applied, if any.
 */
function takeStops(
	agentDir: string,
	agentId: string,
	ownWork: (stop: OwnerStop, warn: (message: string) => void) => WorkerStopOutcome,
	placedJobs: (stop: OwnerStop) => void,
	ports: BotStopPorts,
	memory?: OwnerStop,
): OwnerStop | undefined {
	const words = interfaceText().botTeam;
	const stops = readBotInboxStops(agentDir, agentId, (file, reason, setAside) =>
		ports.warn(
			setAside
				? words.botInboxStopUnreadable(agentId, file, reason)
				: words.botInboxStopNotSetAside(agentId, file, reason, LEFTOVER_REREAD_MAX_MINUTES),
		),
	);
	const recorded = stops.at(-1)?.message;
	const newest = memory && (!recorded || memory.at > recorded.at) ? memory : recorded;
	if (!newest) return undefined;
	const told: string[] = [];
	const outcome = ownWork(newest, (message) => told.push(message));
	refuseMessagesBeforeStop(agentDir, agentId, newest.at, ports);
	for (const stop of stops) takeBotInboxStop(stop);
	for (const message of told) ports.warn(message);
	if (outcome.failed.length > 0 || outcome.managed.length > 0)
		ports.warn(interfaceText().botTeam.botStopLeftLanes(agentId, outcome.failed.length, outcome.managed.length));
	placedJobs(newest);
	return newest;
}
