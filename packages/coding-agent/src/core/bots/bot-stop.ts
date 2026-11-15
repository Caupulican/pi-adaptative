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
import { stopSessionWorkers, type WorkerStopOutcome } from "../delegation/worker-fleet-stop.ts";
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
import { botFailureText } from "./bot-failure-words.ts";
import { botHomeOf, botHomeOwnSessionIds } from "./bot-home.ts";
import {
	type BotInboxStop,
	botInboxStopWaiting,
	readBotInbox,
	readBotInboxStops,
	refuseBotInboxMessage,
	takeBotInboxStop,
} from "./bot-inbox.ts";
import { BotOwnerError } from "./bot-owner-error.ts";
import type { SavedBotSession } from "./bot-remote-view.ts";
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
	stop: BotInboxStop,
	now: number,
): WorkerStopOutcome {
	const outcome = session.fleet.cancelOwnFleet(stop.reasonCode);
	holdPersistedGoalForOwnerStop(session.goal, stop.at, new Date(now).toISOString());
	declineUsageWaitForOwner(session.transcript, stop.at, now);
	return outcome;
}

/**
 * Takes the stops waiting for the bot this process hosts in session `sessionId`: the newest is applied through `stopHere`
 * (the host stops the foreground turn and calls {@link applyOwnerStopToSession}), the jobs the home's other sessions placed
 * are ended (no client of theirs runs: the host holds the bot), the messages it covers are refused, and every stop read is
 * deleted ({@link takeStops}). The stop applied, undefined when none waits.
 */
export function takeHostedBotStops(
	agentDir: string,
	agentId: string,
	sessionId: string,
	stopHere: (stop: BotInboxStop) => WorkerStopOutcome,
	ports: BotStopPorts,
): BotInboxStop | undefined {
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
 * ends it, for a release of the bot (retired, or off the session path): its whole fleet (`cancelOwnFleet`), then the jobs
 * its home's other sessions placed. What it left unended.
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
 * Applies the stop waiting for bot `agentId` while no process hosts it, under its host lock: its saved session's workers
 * ended (`cancelBundleWorkers`), its goal paused and its usage wait declined in its transcript, the messages the stop
 * covers refused and the stops deleted, then the jobs every session of its home placed ended, all in one synchronous run
 * that releases the lock at its end. A bot with no saved session has only its home's placed jobs, its messages and its stops to
 * take; one whose saved session is a symbolic link ({@link ClosedBotSession}) has its session's work left, the owner told. `held` when another process holds the lock (its host takes the stop), `none` when no stop waits. A failure
 * throws, the lock released and the stop left waiting.
 */
export function applyUnhostedBotStop(
	agentDir: string,
	agentId: string,
	session: ClosedBotSession,
	ports: BotStopPorts,
): "applied" | "held" | "none" {
	if (!botInboxStopWaiting(agentDir, agentId)) return "none";
	const taken = takeProcessLock(botHostLockFile(agentDir, agentId));
	if (!taken.held) return "held";
	try {
		return applyBotStopUnderLock(agentDir, agentId, session, ports) ? "applied" : "none";
	} finally {
		taken.lock.release();
	}
}

/**
 * The stop waiting for bot `agentId` applied to its closed session `saved` while the caller holds the bot's host lock and
 * no session of it is open: by {@link applyUnhostedBotStop}, and by a host that took the lock to open the bot's session,
 * before the session is built, so nothing the session's recovery would resume runs. The stop applied, undefined when none
 * waits; a failure throws with the stop left waiting.
 */
export function applyBotStopUnderLock(
	agentDir: string,
	agentId: string,
	session: ClosedBotSession,
	ports: BotStopPorts,
): BotInboxStop | undefined {
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
		"sessionId" | "abort" | "getGoalStateSnapshot" | "saveGoalStateSnapshot" | "backgroundLanes"
	>;
	readonly transcript: UsageWakeLog & UsageWakeWriter;
}

/**
 * Takes the stops waiting for the bot whose session this process hosts ({@link takeHostedBotStops}): the turn it
 * runs, when `turnRuns`, stopped for the owner, then {@link applyOwnerStopToSession}. The stop applied, undefined when
 * none waits; a failure throws with the stops left waiting.
 */
export function stopLoadedBot(
	agentDir: string,
	agentId: string,
	{ session, transcript }: LoadedBotSession,
	turnRuns: boolean,
	ports: BotStopPorts,
): BotInboxStop | undefined {
	const words = interfaceText().botTeam;
	const live: HostedBotStopSession = {
		goal: {
			getGoalStateSnapshot: () => session.getGoalStateSnapshot(),
			saveGoalStateSnapshot: (state, expected) => session.saveGoalStateSnapshot(state, expected),
		},
		transcript,
		fleet: session.backgroundLanes,
	};
	return takeHostedBotStops(
		agentDir,
		agentId,
		session.sessionId,
		(stop) => {
			if (turnRuns)
				void session
					.abort(words.botTurnAbortReasons.ownerStopped)
					.catch((error: unknown) =>
						ports.warn(words.botTurnFailed(agentId, error instanceof Error ? error.message : String(error))),
					);
			return applyOwnerStopToSession(live, stop, ports.now());
		},
		ports,
	);
}

const NOTHING_LEFT: WorkerStopOutcome = { remote: [], managed: [], failed: [] };

/**
 * The stop applied to a closed bot's own work, its host lock held: its saved session's transcript read first, then its
 * bundle's workers ended, then the transcript written.
 */
function stopClosedSession(
	agentDir: string,
	agentId: string,
	saved: SavedBotSession | undefined,
	stop: BotInboxStop,
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
 * The work bot `agentId`'s closed session `saved` left, ended for `reasonCode` as a stop of it while no process hosts it
 * ends it, under its host lock: its bundle's queued and recovered attempts ({@link cancelBundleWorkers}), then the jobs its
 * home's sessions placed ({@link endHomePlacedJobs}). For a release of the bot (retired, or off the session path) with no session of it loaded here,
 * so nothing a later open of it would resume is left. What it left unended. A lock held (by the host of the bot, or by
 * this process opening or closing it) throws the owner's words: the release stays owed and runs again.
 */
export function endClosedBotWork(
	agentDir: string,
	agentId: string,
	saved: SavedBotSession | undefined,
	reasonCode: string,
	warn: (message: string) => void,
): WorkerStopOutcome {
	const taken = takeProcessLock(botHostLockFile(agentDir, agentId));
	if (!taken.held) throw new BotOwnerError(interfaceText().botTeam.botReleaseHeldBy(taken.owner.pid));
	try {
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
 * the home's sessions placed are ended by `placedJobs`, which never keeps the stop. The stop applied, undefined when none
 * waits.
 */
function takeStops(
	agentDir: string,
	agentId: string,
	ownWork: (stop: BotInboxStop, warn: (message: string) => void) => WorkerStopOutcome,
	placedJobs: (stop: BotInboxStop) => void,
	ports: BotStopPorts,
): BotInboxStop | undefined {
	const unreadable = (file: string, reason: string) =>
		ports.warn(interfaceText().botTeam.botInboxUnreadable(agentId, file, reason));
	const stops = readBotInboxStops(agentDir, agentId, unreadable);
	const newest = stops.at(-1)?.message;
	if (!newest) return undefined;
	const told: string[] = [];
	const outcome = ownWork(newest, (message) => told.push(message));
	const reason = interfaceText().botTeam.botTurnAbortReasons.ownerStopped;
	for (const item of readBotInbox(agentDir, agentId, unreadable))
		if (item.message.at <= newest.at) refuseBotInboxMessage(agentDir, item, reason, ports.now());
	for (const stop of stops) takeBotInboxStop(stop);
	for (const message of told) ports.warn(message);
	if (outcome.failed.length > 0 || outcome.managed.length > 0)
		ports.warn(interfaceText().botTeam.botStopLeftLanes(agentId, outcome.failed.length, outcome.managed.length));
	placedJobs(newest);
	return newest;
}
