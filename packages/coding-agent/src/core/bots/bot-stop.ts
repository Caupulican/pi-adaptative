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
 * made until the owner's is declined (`declineUsageWaitForOwner`, once per stop), and what the bot's session armed or was
 * fired for before the stop is ended: its watches armed until then are deleted and the results fired for it until then that
 * it has not taken are settled without a turn (`endWatchesBeforeStop`). The stop is then taken, and every job a
 * session of the bot's home placed on another machine is ended, so nothing goes on spending; a failure there is told to the
 * owner and does not keep the stop. A managed lane is left to the extension that runs it, and the owner is told.
 *
 * Order: a stop ends the work there is when it is made. An inbox message whose `at` is at or before the stop's (sent before
 * it, or in the same millisecond, which the stop is read to cover) is refused with the owner-stopped reason; one after it is
 * the owner's next words and waits for the session. A stop recorded after it was made (`scoped`: this process could not
 * record it then, `UnrecordedBotStops`) ends only the work there was then: the worker attempts unended and the plans open
 * when it was made, the turn running since then, and the jobs placed by then or by those attempts; what started after it
 * goes on.
 */

import { existsSync, statSync } from "node:fs";
import type { OrchestrationHome } from "../../kernel/session/session-bundle-paths.ts";
import { readSessionHeaderResult } from "../../kernel/session/session-header.ts";
import { SessionManager } from "../../kernel/session/session-manager.ts";
import { botHostLockFile, orchestrationEventStoreDir } from "../agent-paths.ts";
import type { AgentSession } from "../agent-session.ts";
import type { PersistentBotTeamStore } from "../delegation/persistent-bot-team-store.ts";
import {
	type FleetStop,
	type FleetStopScope,
	OWNER_STOPPED_REASON,
	stopSessionWorkers,
	unendedWorkerAttempts,
	WHOLE_FLEET_STOP_SCOPE,
	type WorkerStopOutcome,
} from "../delegation/worker-fleet-stop.ts";
import { holdPersistedGoalForOwnerStop, type PersistedGoalStateHost } from "../goals/goal-lifecycle.ts";
import { appendGoalStateSnapshot, getLatestGoalStateSnapshot } from "../goals/session-goal-state.ts";
import { interfaceText } from "../language/interface-text.ts";
import { OrchestrationEventStore } from "../orchestration/event-store.ts";
import { DurableTaskRuntime } from "../orchestration/task-runtime.ts";
import { readTaskRuntimeProjection } from "../orchestration/task-runtime-reader.ts";
import { botSessionStorageRoots } from "../orchestration-homes.ts";
import { takeProcessLock } from "../remote/host-lock.ts";
import { endPlacedJobsOfSessions, type PlacedJobCover, placedJobsOfSessionsLeft } from "../remote/job-client.ts";
import { jobCancelReasonOf } from "../remote/remote-jobs.ts";
import { MAX_ROUTINE_OCCURRENCES } from "../routines/routine-contract.ts";
import { routineResultInputIds } from "../routines/routine-parent-input.ts";
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
import {
	type LinkedSessionNotices,
	type LinkedSessionOperation,
	RELEASE_OPERATION,
	stopOperation,
} from "./bot-link-notices.ts";
import { BotOwnerError } from "./bot-owner-error.ts";
import { botSessionOnDisk, type SavedBotSession } from "./bot-remote-view.ts";
import { BotSessionLinkError } from "./bot-session-pointer.ts";

/**
 * What applying a stop needs besides the bot's files: the owner's notices, the provider admission clock's time, what
 * the owner was told of the work a stop or a release left behind a symbolic link, kept for the process (`LinkedSessionNotices`),
 * and the store of the bot's watches.
 */
export interface BotStopPorts {
	warn(message: string): void;
	now(): number;
	readonly links: LinkedSessionNotices;
	watches(): BotWatchStore;
}

/** The store's watches of a bot's session and the results they fired, as the owner's stop ends them. */
export type BotWatchStore = Pick<
	PersistentBotTeamStore,
	"reload" | "listRoutines" | "deleteRoutine" | "listPendingRoutineDeliveries" | "acknowledgeRoutineDelivery"
>;

/**
 * The transcript note of the fired results the owner's stop settled without a turn (`endWatchesBeforeStop`): the store
 * marks each one acknowledged by this entry, as a delivery marks a result by the input that carried it.
 */
export const BOT_STOP_WATCH_RESULTS_CUSTOM_TYPE = "bot_stop_watch_results";

/** A bot session's transcript as the stop notes in it the results it settled. */
type StopNoteTranscript = Pick<SessionManager, "appendCustomEntry" | "isEntryDurableForSession" | "getParentInput">;

/**
 * What bot `agentId`'s session `sessionId` armed or was fired for before the owner's stop made at `stop.at`, ended by it:
 * every watch the session holds that was armed at or before then is deleted (`deleteRoutine`, which also cancels its runs
 * not yet dispatched), and every result fired for the session at or before then that it has not taken is settled without a
 * turn, marked acknowledged by a note in its `transcript` that names them; none is settled while the session has no
 * transcript of its own to note them in. One whose parent input its session's delivery appended while the stop waited is
 * delivered, not settled: it is marked by that input, as the delivery would mark it, so it is never both. A watch armed after the stop, and a result fired after it, are the bot's later
 * work and stay. What it ended is told through `ports.warn` as it ends, failure or not, so a take that fails after it and
 * is tried again, which finds them ended, has told them once. A failure throws.
 */
function endWatchesBeforeStop(
	agentId: string,
	sessionId: string,
	transcript: StopNoteTranscript | undefined,
	stop: OwnerStop,
	ports: Pick<BotStopPorts, "warn" | "now" | "watches">,
): void {
	const store = ports.watches();
	const now = ports.now();
	let [ended, settled] = [0, 0];
	try {
		store.reload(true);
		for (const watch of store.listRoutines({ sessionId, scope: "own-watches" }))
			if (Date.parse(watch.createdAt) <= stop.at && store.deleteRoutine(watch.routineId, watch.revision, now))
				ended++;
		const fired = store
			.listPendingRoutineDeliveries(sessionId, 2 * MAX_ROUTINE_OCCURRENCES)
			.filter(({ occurrence }) => occurrence.createdAt <= stop.at);
		if (!transcript || fired.length === 0) return;
		const carried = new Map(
			fired.map((delivery) => [
				delivery,
				routineResultInputIds(delivery)
					.map((id) => transcript.getParentInput(id)?.entryId)
					.find((entryId) => entryId !== undefined),
			]),
		);
		const unsettled = fired.filter((delivery) => carried.get(delivery) === undefined);
		const note =
			unsettled.length === 0
				? undefined
				: transcript.appendCustomEntry(BOT_STOP_WATCH_RESULTS_CUSTOM_TYPE, {
						version: 1,
						stoppedAt: stop.at,
						occurrenceIds: unsettled.map(({ occurrence }) => occurrence.occurrenceId),
					});
		if (note !== undefined && !transcript.isEntryDurableForSession(note))
			throw new Error("the note of the watch results the stop settles was not saved");
		for (const delivery of fired) {
			const { occurrence, result } = delivery;
			const marker = carried.get(delivery) ?? note;
			if (marker === undefined) continue;
			store.acknowledgeRoutineDelivery({
				occurrenceId: occurrence.occurrenceId,
				recipient: result.recipient,
				resultDigest: result.digest,
				deliveryMarker: marker,
				nowMs: Math.max(now, occurrence.updatedAt),
			});
			if (marker === note) settled++;
		}
	} finally {
		if (ended + settled > 0) ports.warn(interfaceText().botTeam.botStopWatchesEnded(agentId, ended, settled));
	}
}

/** What ending the jobs a bot's home placed tells the owner through: its notices, and what they were told of its links. */
export type LinkNoticePorts = Pick<BotStopPorts, "warn" | "links">;

/** The live session of a hosted bot, as its stop reaches it. */
export interface HostedBotStopSession {
	readonly goal: PersistedGoalStateHost;
	readonly transcript: UsageWakeLog & UsageWakeWriter;
	readonly fleet: { cancelOwnFleet(stop: FleetStop): WorkerStopOutcome };
}

/**
 * The stop applied at `now` to a hosted bot's live session (its foreground turn already stopped by the host): the fleet
 * work it covers cancelled (`cancelOwnFleet`), then its goal held and its usage wait declined as of when the stop was
 * made. What it left unended, by why.
 */
export function applyOwnerStopToSession(
	session: HostedBotStopSession,
	stop: OwnerStop,
	now: number,
): WorkerStopOutcome {
	const outcome = session.fleet.cancelOwnFleet(stop);
	holdForOwnerStop(session, stop, now);
	return outcome;
}

/** The take of an owner's stop, as a failure of it is told once per cause (`botFailureCause`). */
export const STOP_TAKE = "stop take";

/** What applying an owner's stop reads of it: when it was made, the reason its cancelled work ends with, and what it ends. */
export type OwnerStop = Pick<BotInboxStop, "at" | "reasonCode" | "scope">;

/**
 * The jobs placed on other machines that `stop` ends: every one for a whole stop, else those placed by the time it was made
 * (the placer's clock, the wall clock its `at` is on) or by an attempt it ends.
 */
function placedJobsOf(stop: OwnerStop): PlacedJobCover {
	const { scope } = stop;
	if (scope.kind === "whole") return EVERY_PLACED_JOB;
	return (job) => job.createdAt <= stop.at || (job.attemptId !== undefined && scope.attempts.includes(job.attemptId));
}

/** Every job placed: what a whole stop and a release end. */
const EVERY_PLACED_JOB: PlacedJobCover = () => true;

/** The bot's goal held and its usage wait declined at `now`, as of when the owner's stop was made. */
function holdForOwnerStop(session: Omit<HostedBotStopSession, "fleet">, stop: OwnerStop, now: number): void {
	holdPersistedGoalForOwnerStop(session.goal, stop.at, new Date(now).toISOString());
	declineUsageWaitForOwner(session.transcript, stop.at, now);
}

/**
 * Takes the stops waiting for the bot this process hosts in session `sessionId`, as one ({@link takeStops}), applied through `stopHere`
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
				placedJobsOf(stop),
				stopOperation(stop.at),
				ports,
			),
		ports,
		memory,
	);
}

/**
 * Ends the jobs the sessions of bot `agentId`'s home placed on other machines that `covers` names, for `reasonCode` (no
 * client of theirs runs: the caller holds the bot): the home listed now ({@link homeSessionIds}), `placedBy` choosing which
 * of its sessions (the one the caller ended through its live client left out, a closed session's own added), for
 * `operation` (the stop or the release that ends them). It runs after the bot's own work ended and never holds that back: a failure is told to the
 * owner with its cause, and the stop or release goes on.
 */
function endHomePlacedJobs(
	agentDir: string,
	agentId: string,
	placedBy: (homeSessionIds: readonly string[]) => readonly string[],
	reasonCode: string,
	covers: PlacedJobCover,
	operation: LinkedSessionOperation,
	ports: LinkNoticePorts,
): void {
	try {
		const sessions = new Set(placedBy(homeSessionIds(agentDir, agentId, operation, ports)));
		endPlacedJobsOfSessions(agentDir, sessions, jobCancelReasonOf(reasonCode), covers);
	} catch (error) {
		ports.warn(interfaceText().botTeam.botPlacedJobsNotEnded(agentId, botFailureText(agentId, error)));
	}
}

/**
 * The sessions bot `agentId`'s home holds as files of its own, whose placed jobs are the bot's to end: a session file that
 * is a symbolic link is skipped (the jobs of whatever session it names are not the bot's), and the owner told which, once
 * for `operation` and those links however often it runs again (`LinkedSessionNotices`).
 */
function homeSessionIds(
	agentDir: string,
	agentId: string,
	operation: LinkedSessionOperation,
	ports: LinkNoticePorts,
): string[] {
	const { ids, linked } = botHomeOwnSessionIds(botHomeOf(agentDir, agentId).sessionsDir);
	if (linked.length > 0) {
		const sentence = interfaceText().botTeam.botLinkedSessionsJobsLeft(agentId, linked);
		ports.links.tell(agentId, operation, "jobs", linked, sentence, ports.warn);
	}
	return ids;
}

/**
 * The work of bot `agentId`'s session this process has loaded, ended for `reasonCode` as the owner's stop of a hosted bot
 * ends it, for a release of the bot (retired, or off the session path) and for a stop that could not be recorded or taken
 * ({@link endUnrecordedStopWork}): its whole fleet (`cancelOwnFleet`), then the jobs its home's other sessions placed,
 * for `operation` (that release, or that stop). What it left unended.
 */
export function endLoadedBotWork(
	agentDir: string,
	agentId: string,
	session: Pick<AgentSession, "sessionId" | "backgroundLanes">,
	reasonCode: string,
	operation: LinkedSessionOperation,
	ports: LinkNoticePorts,
): WorkerStopOutcome {
	const outcome = session.backgroundLanes.cancelOwnFleet({ reasonCode, scope: WHOLE_FLEET_STOP_SCOPE });
	const placedBy = (ids: readonly string[]) => ids.filter((id) => id !== session.sessionId);
	endHomePlacedJobs(agentDir, agentId, placedBy, reasonCode, EVERY_PLACED_JOB, operation, ports);
	return outcome;
}

/**
 * The owner's stop of bot `agentId`, whose session this process hosts, when it was not taken from its record: its
 * foreground turn (`stopTurn`) and its own work ({@link endLoadedBotWork}) end all the same. A stop held in memory
 * (`stop`: one that could not be recorded, or whose record no longer reads) also holds the bot's goal, declines its
 * usage wait as of when it was made and refuses the messages sent before it, as a stop taken from its record does; a stop recorded and not taken (`stop` absent)
 * leaves those to its record, which is tried again. `operation` is the stop made (its record's take, tried again, tells
 * nothing of its links twice). What it left unended; undefined when its workers could not be ended. Each failure is told
 * to the owner with its cause.
 */
export function endUnrecordedStopWork(
	agentDir: string,
	agentId: string,
	loaded: LoadedBotSession,
	stopTurn: () => void,
	stop: OwnerStop | undefined,
	operation: LinkedSessionOperation,
	ports: BotStopPorts,
): WorkerStopOutcome | undefined {
	stopTurn();
	let outcome: WorkerStopOutcome | undefined;
	try {
		outcome = endLoadedBotWork(agentDir, agentId, loaded.session, OWNER_STOPPED_REASON, operation, ports);
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
			endWatchesBeforeStop(agentId, loaded.session.sessionId, loaded.sessionManager, stop, ports);
		} catch (error) {
			ports.warn(interfaceText().botTeam.botStopWatchesNotEnded(agentId, botFailureText(agentId, error)));
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
 * this process could not record is applied with them, scoped to the work there was when it was made
 * ({@link UnrecordedBotStops}).
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
			if ("saved" in session)
				return stopClosedSession(agentDir, agentId, saved, stop, { ...ports, warn }, ports.warn);
			// Nothing is ended through the link: the rest of the stop applies, and the owner is told what it left.
			warn(interfaceText().botTeam.botStopLinkedSessionLeft(agentId, session.linked));
			return NOTHING_LEFT;
		},
		(stop) => {
			const placedBy = (ids: readonly string[]) => closedPlacers(ids, saved);
			endHomePlacedJobs(
				agentDir,
				agentId,
				placedBy,
				stop.reasonCode,
				placedJobsOf(stop),
				stopOperation(stop.at),
				ports,
			);
		},
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
	readonly sessionManager: UsageWakeLog & UsageWakeWriter & StopNoteTranscript;
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
	stopTurn: (stop: OwnerStop) => void,
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
				stopTurn(taken);
				outcome = applyOwnerStopToSession(live, taken, ports.now());
				endWatchesBeforeStop(agentId, loaded.session.sessionId, loaded.sessionManager, taken, ports);
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

/** Bot `agentId`'s closed session as its home on disk holds it now: never a view's cache, which may lag a change. */
function closedSessionOnDisk(agentDir: string, agentId: string): ClosedBotSession {
	return readClosedBotSession(() => botSessionOnDisk(agentDir, agentId));
}

/** The worker attempts unended and the plans open in a bundle, by id, read without writing it. */
function bundleWork(store: OrchestrationEventStore): Extract<FleetStopScope, { kind: "scoped" }> {
	const snapshot = readTaskRuntimeProjection(store);
	return {
		kind: "scoped",
		attempts: unendedWorkerAttempts(snapshot).map((attempt) => attempt.attemptId),
		plans: Object.entries(snapshot.plans)
			.filter(([, plan]) => !plan.closed)
			.map(([planId]) => planId),
	};
}

/**
 * The work of bot `agentId` there is now, read from its home on disk without writing it, as the owner's stop is made (its
 * `at` stamped next): the worker attempts unended and the plans open in its saved session's bundle (none for a bot with no
 * saved session or bundle, or whose saved session is a symbolic link, whose work no stop ends). What a stop recorded late
 * ends ({@link UnrecordedBotStops}); `unread` the failure when it does not read.
 */
export function readStopScope(
	agentDir: string,
	agentId: string,
): { readonly scope: FleetStopScope } | { readonly unread: unknown } {
	try {
		const session = closedSessionOnDisk(agentDir, agentId);
		const store = "saved" in session ? closedBundleStore(agentDir, agentId, session.saved) : undefined;
		return { scope: store ? bundleWork(store) : { kind: "scoped", attempts: [], plans: [] } };
	} catch (error) {
		return { unread: error };
	}
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

/** A take of the stops waiting for a closed bot under its host lock: the stop it applied, if any, and its session as it read it. */
export interface LockedBotStop {
	readonly stop?: OwnerStop;
	readonly session: ClosedBotSession;
}

/**
 * The owner's stops this process could not record (`requestBotStop` failed) for bots it does not host, the newest per bot,
 * kept for the process and agent directory across its hosts in turn (`bot-session-registry.ts`: a root session replaced by
 * a new or resumed one keeps them). Each is scoped to the work there was when it was made (`readStopScope`), so wherever
 * and whenever it is applied it ends that work and nothing started after it. It is held until one of these ends it:
 * - a take of the bot's stops applies it with the ones waiting, while no process hosts the bot: the unhosted application
 *   under the bot's lock ({@link applyUnhostedBotStop}, {@link underLock}), or this process's open of the bot's session
 *   once it is built ({@link loaded}), so a stop made while the open runs is taken by it; a failed take keeps it;
 * - its record lands late while another process hosts the bot ({@link recordLate}): that host takes it, scoped as it was
 *   made, and the owner is told it is recorded now;
 * - a stop of the bot made later is recorded, which covers it ({@link drop});
 * - this process quits ({@link recordAtQuit}): it is recorded one last time, and the owner told it is recorded or lost.
 */
export class UnrecordedBotStops {
	private readonly held = new Map<string, OwnerStopRequest>();
	private readonly agentDir: string;

	constructor(agentDir: string) {
		this.agentDir = agentDir;
	}

	/** Holds the stop for its bot, unless a newer one is held. */
	hold(stop: OwnerStopRequest): void {
		const held = this.held.get(stop.agentId);
		if (held && stop.at < held.at) return;
		this.held.set(stop.agentId, stop);
	}

	/** The stop held for the bot. */
	of(agentId: string): OwnerStop | undefined {
		return this.held.get(agentId);
	}

	/** The bot was released (retired, or off the session path), or a later stop of it was recorded: none is held for it. */
	drop(agentId: string): void {
		this.held.delete(agentId);
	}

	/**
	 * {@link applyBotStopUnderLock} under the lock the caller just took, on the bot's session as its home on disk holds it,
	 * the stop held for the bot taken with the ones waiting. A failure throws with the stop still held.
	 */
	underLock(agentId: string, ports: BotStopPorts): LockedBotStop {
		const session = closedSessionOnDisk(this.agentDir, agentId);
		const memory = this.held.get(agentId);
		const stop = applyBotStopUnderLock(this.agentDir, agentId, session, ports, memory);
		this.taken(agentId, memory);
		return { stop, session };
	}

	/**
	 * {@link stopLoadedBot} of a session just built, no turn running yet, under the lock its open took: the stop held is
	 * taken with the ones waiting, and kept when the take failed.
	 */
	loaded(agentId: string, loaded: LoadedBotSession, ports: BotStopPorts): LoadedBotStop {
		const memory = this.held.get(agentId);
		const taken = stopLoadedBot(this.agentDir, agentId, loaded, () => {}, ports, memory);
		if (taken.failure === undefined) this.taken(agentId, memory);
		return taken;
	}

	/**
	 * Records the stop held for the bot (`requestBotStop`), dated, sent and scoped as it was made, for the process hosting
	 * the bot to take: the hold ends and the owner is told it is recorded now. A write that fails again keeps it held and
	 * tells nothing more (the owner was told when it was made).
	 */
	recordLate(agentId: string, warn: (message: string) => void): void {
		const held = this.held.get(agentId);
		if (!held || writeOwnerStop(this.agentDir, held, warn) !== undefined) return;
		this.taken(agentId, held);
		warn(interfaceText().botTeam.botStopRecordedLate(agentId));
	}

	/**
	 * This process quits: every stop held is recorded one last time ({@link recordLate}) and none is held after it. What the
	 * owner is told of each: that it is recorded now, or that it is lost and why. Never throws.
	 */
	recordAtQuit(): string[] {
		const text = interfaceText().botTeam;
		const told: string[] = [];
		for (const held of this.held.values()) {
			const unwritten = writeOwnerStop(this.agentDir, held, (message) => told.push(message));
			told.push(
				unwritten === undefined
					? text.botStopRecordedLate(held.agentId)
					: text.botStopLostAtQuit(held.agentId, unwritten),
			);
		}
		this.held.clear();
		return told;
	}

	/** A take or a write that read `held` (the one held when it began) applied or recorded it: it is held no longer. */
	private taken(agentId: string, held: OwnerStopRequest | undefined): void {
		if (held !== undefined && this.held.get(agentId) === held) this.held.delete(agentId);
	}
}

/**
 * The stop applied to a closed bot's own work, its host lock held: its saved session's transcript read first, then its
 * bundle's workers ended, then the transcript written, then its watches and the results they fired ended
 * ({@link endWatchesBeforeStop}, told through `tell` as they end).
 */
function stopClosedSession(
	agentDir: string,
	agentId: string,
	saved: SavedBotSession | undefined,
	stop: OwnerStop,
	ports: BotStopPorts,
	tell: (message: string) => void,
): WorkerStopOutcome {
	const bundle = closedBundle(agentDir, agentId, saved);
	const transcript = saved && bundle && closedTranscript(agentDir, agentId, bundle.home, saved, ports);
	const store = closedBundleStore(agentDir, agentId, saved);
	const outcome = store === undefined ? NOTHING_LEFT : cancelBundleWorkers(store, stop);
	if (transcript) {
		const now = ports.now();
		holdPersistedGoalForOwnerStop(closedGoalHost(transcript), stop.at, new Date(now).toISOString());
		declineUsageWaitForOwner(transcript, stop.at, now);
	}
	if (saved) endWatchesBeforeStop(agentId, saved.id, transcript, stop, { ...ports, warn: tell });
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

/** The store of a closed bot's own bundle ({@link closedBundle}); none when the bot has no saved session or its bundle was never written. */
function closedBundleStore(
	agentDir: string,
	agentId: string,
	saved: SavedBotSession | undefined,
): OrchestrationEventStore | undefined {
	const bundle = closedBundle(agentDir, agentId, saved);
	return bundle && existsSync(orchestrationEventStoreDir(bundle.home, bundle.sessionId))
		? new OrchestrationEventStore({ orchestrationHome: bundle.home, sessionId: bundle.sessionId })
		: undefined;
}

/** The sessions whose placed jobs are a closed bot's: its home's own session files (`ids`) and its saved session. */
function closedPlacers(ids: readonly string[], saved: SavedBotSession | undefined): readonly string[] {
	return saved ? [...ids, saved.id] : ids;
}

/**
 * Whether bot `agentId`'s closed session `session` left work a release of it ends ({@link endClosedBotWork}): an
 * unended attempt of its own or an open plan in its bundle, or a job its home's sessions placed that has not ended. What
 * a release leaves (the work behind a symbolic link, a managed lane) is not counted, so a bot whose release finished
 * counts none. Read only, without its host lock; a read that fails throws.
 */
export function closedBotWorkLeft(agentDir: string, agentId: string, session: ClosedBotSession): boolean {
	const saved = "saved" in session ? session.saved : undefined;
	const store = closedBundleStore(agentDir, agentId, saved);
	if (store) {
		const snapshot = readTaskRuntimeProjection(store);
		if (unendedWorkerAttempts(snapshot).length > 0 || Object.values(snapshot.plans).some((plan) => !plan.closed))
			return true;
	}
	const { ids } = botHomeOwnSessionIds(botHomeOf(agentDir, agentId).sessionsDir);
	return placedJobsOfSessionsLeft(agentDir, new Set(closedPlacers(ids, saved)));
}

/**
 * The work bot `agentId`'s closed session left, ended for `reasonCode` as a stop of it while no process hosts it ends
 * it, under its host lock: its bundle's queued and recovered attempts ({@link cancelBundleWorkers}), then the jobs its
 * home's sessions placed ({@link endHomePlacedJobs}). A saved session that is a symbolic link ({@link ClosedBotSession})
 * has its own work left, the owner told, and the jobs its home's other sessions placed still end. For a release of the bot
 * (retired, or off the session path) with no session of it loaded here, so nothing a later open of it would resume is
 * left. What it left unended. A lock held (by the host of the bot, or by this process opening or closing it) throws the
 * owner's words: the release stays owed and runs again, and what it told of the links is told once for the release
 * however often it runs (`LinkedSessionNotices`).
 */
export function endClosedBotWork(
	agentDir: string,
	agentId: string,
	session: ClosedBotSession,
	reasonCode: string,
	ports: LinkNoticePorts,
): WorkerStopOutcome {
	const taken = takeProcessLock(botHostLockFile(agentDir, agentId));
	if (!taken.held) throw new BotOwnerError(interfaceText().botTeam.botReleaseHeldBy(taken.owner.pid));
	try {
		const saved = "saved" in session ? session.saved : undefined;
		// Nothing is ended through the link: the owner is told, once for the release however often it runs again.
		if ("linked" in session) {
			const sentence = interfaceText().botTeam.botReleaseWorkersLeft(agentId, session.linked);
			ports.links.tell(agentId, RELEASE_OPERATION, "workers", [session.linked], sentence, ports.warn);
		}
		const store = closedBundleStore(agentDir, agentId, saved);
		const outcome =
			store === undefined ? NOTHING_LEFT : cancelBundleWorkers(store, { reasonCode, scope: WHOLE_FLEET_STOP_SCOPE });
		const placedBy = (ids: readonly string[]) => closedPlacers(ids, saved);
		endHomePlacedJobs(agentDir, agentId, placedBy, reasonCode, EVERY_PLACED_JOB, RELEASE_OPERATION, ports);
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
 * The owner's stop of the workers of a closed bot session, whose bundle `store` holds, while no process hosts the bot,
 * written to its bundle alone (`stopSessionWorkers`): every open plan closed and every unended worker
 * attempt cancelled for `reasonCode`, so nothing opens the session for them. Their ends are recorded delivered by the
 * session's next open, when its outbox is replayed (`owner_stopped` wakes no one). It runs before the jobs the home's
 * sessions placed are ended, so no open dispatches a lane again for a job that end reaches. The caller holds the bot's host
 * lock, so no process runs what it cancels. What it left unended.
 */
function cancelBundleWorkers(store: OrchestrationEventStore, stop: FleetStop): WorkerStopOutcome {
	const runtime = new DurableTaskRuntime({ store });
	return stopSessionWorkers(
		runtime,
		undefined,
		(attempt) => {
			runtime.cancelAttempt(attempt.attemptId, stop.reasonCode);
			return false;
		},
		stop,
	);
}

/**
 * The stop that covers every stop in `stops` taken together: made when the newest was, for its reason, ending everything
 * unended when one of them does (`whole`), else the work any of them was made over. None for none.
 */
function coveringStop(stops: readonly OwnerStop[]): OwnerStop | undefined {
	if (stops.length === 0) return undefined;
	const newest = stops.reduce((last, stop) => (stop.at > last.at ? stop : last));
	const scoped = stops.flatMap((stop) => (stop.scope.kind === "scoped" ? [stop.scope] : []));
	if (scoped.length < stops.length)
		return { at: newest.at, reasonCode: newest.reasonCode, scope: WHOLE_FLEET_STOP_SCOPE };
	const union = (ids: (scope: (typeof scoped)[number]) => readonly string[]) => [...new Set(scoped.flatMap(ids))];
	return {
		at: newest.at,
		reasonCode: newest.reasonCode,
		scope: { kind: "scoped", attempts: union((scope) => scope.attempts), plans: union((scope) => scope.plans) },
	};
}

/**
 * Takes the stops waiting for bot `agentId`, applied together as the one that covers them all ({@link coveringStop}): it is
 * applied to the bot's own work by `ownWork`, which must end it (a failure throws with the stops left waiting, and what it
 * told the owner is dropped, so a retry tells it once); then the stop is taken (the messages it covers refused, every stop
 * read deleted) and what `ownWork` told is told; then the jobs the home's sessions placed are ended by `placedJobs`, which
 * never keeps the stop. A stop that could not be recorded (`memory`) is taken with them.
 * Once it applied, what the owner was told of the stop's links ends with it (`LinkedSessionNotices.done`): a take of it
 * tried again after a failure told them already. A stop that does not read has no date to order it by and stops nothing: it is set aside and told as a stop, or, when it
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
	const newest = coveringStop([...stops.map((stop) => stop.message), ...(memory ? [memory] : [])]);
	if (!newest) return undefined;
	const told: string[] = [];
	const outcome = ownWork(newest, (message) => told.push(message));
	refuseMessagesBeforeStop(agentDir, agentId, newest.at, ports);
	for (const stop of stops) takeBotInboxStop(stop);
	for (const message of told) ports.warn(message);
	if (outcome.failed.length > 0 || outcome.managed.length > 0)
		ports.warn(interfaceText().botTeam.botStopLeftLanes(agentId, outcome.failed.length, outcome.managed.length));
	placedJobs(newest);
	ports.links.done(agentId, "stop");
	return newest;
}
