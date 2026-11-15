/**
 * Taking the owner's stop of a bot (`requestBotStop` records it in the bot's inbox): whichever process takes it applies it,
 * and deletes it only then. The process hosting the bot's session applies it through the live session
 * (`takeHostedBotStops`). Any other process applies it while no process hosts the bot, durably and under the bot's host
 * lock (`applyUnhostedBotStop`), so a stop never waits for a host that may never come; one that finds the lock held leaves
 * it to the holder, and the work it stopped stays held back until then (`BotOwedWork`).
 *
 * What it ends: every open plan is closed and every unended worker attempt cancelled, the bot's parent agents included
 * (`OWNER_STOPPED_REASON`, whose ends wake no one), and every job a session of the bot's home placed on another machine
 * is ended, first, so nothing goes on spending; then the bot's goal is paused when it runs or the system would resume it on
 * its own and the owner has not set it going since the stop was made (`holdPersistedGoalForOwnerStop`; the owner resumes
 * it), and the usage-limit wait of every usage stop made until the owner's is declined (`declineUsageWaitForOwner`). A
 * managed lane is left to the extension that runs it, and the owner is told.
 *
 * Order: a stop ends the work there is when it is made. An inbox message whose `at` is at or before the stop's (sent before
 * it, or in the same millisecond, which the stop is read to cover) is refused with the owner-stopped reason; one after it is
 * the owner's next words and waits for the session.
 */

import { existsSync, statSync } from "node:fs";
import type { OrchestrationHome } from "../../kernel/session/session-bundle-paths.ts";
import { readSessionHeader } from "../../kernel/session/session-file-reading.ts";
import { SessionManager } from "../../kernel/session/session-manager.ts";
import { botHostLockFile, orchestrationEventStoreDir } from "../agent-paths.ts";
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
import { declineUsageWaitForOwner, type UsageWakeWriter } from "../usage-wake-record.ts";
import { botHomeOf, botHomeSessionIds } from "./bot-home.ts";
import {
	type BotInboxStop,
	botInboxStopWaiting,
	readBotInbox,
	readBotInboxStops,
	refuseBotInboxMessage,
	takeBotInboxStop,
} from "./bot-inbox.ts";
import type { SavedBotSession } from "./bot-remote-view.ts";

/** What applying a stop needs besides the bot's files: the owner's notices, and the provider admission clock's time. */
export interface BotStopPorts {
	warn(message: string): void;
	now(): number;
}

/** The live session of a hosted bot, as its stop reaches it. */
export interface HostedBotStopSession {
	readonly goal: PersistedGoalStateHost;
	readonly transcript: UsageWakeWriter;
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
 * deleted. The stop applied, undefined when none waits.
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
		(stop) => {
			// Read before acting: a home that does not list leaves the stop waiting with nothing done.
			const others = botHomeSessionIds(botHomeOf(agentDir, agentId).sessionsDir, "follow").filter(
				(id) => id !== sessionId,
			);
			const outcome = stopHere(stop);
			endPlacedJobsOfSessions(agentDir, new Set(others), jobCancelReasonOf(stop.reasonCode));
			return outcome;
		},
		ports,
	);
}

/**
 * Applies the stop waiting for bot `agentId` while no process hosts it, under its host lock: its saved session's workers
 * and the jobs every session of its home placed ended (`cancelOwedWorkerWork`), its goal paused and its usage wait
 * declined in its transcript, the messages the stop covers refused and the stops deleted, all in one synchronous run that
 * releases the lock at its end. A bot with no saved session has only its home's placed jobs, its messages and its stops to
 * take. `held` when another process holds the lock (its host takes the stop), `none` when no stop waits. A failure
 * throws, the lock released and the stop left waiting.
 */
export function applyUnhostedBotStop(
	agentDir: string,
	agentId: string,
	saved: SavedBotSession | undefined,
	ports: BotStopPorts,
): "applied" | "held" | "none" {
	if (!botInboxStopWaiting(agentDir, agentId)) return "none";
	const taken = takeProcessLock(botHostLockFile(agentDir, agentId));
	if (!taken.held) return "held";
	try {
		const stop = takeStops(
			agentDir,
			agentId,
			(stop) => stopClosedSession(agentDir, agentId, saved, stop, ports),
			ports,
		);
		return stop ? "applied" : "none";
	} finally {
		taken.lock.release();
	}
}

const NOTHING_LEFT: WorkerStopOutcome = { remote: [], managed: [], failed: [] };

/**
 * The stop applied to a closed bot, its host lock held: its saved session's transcript read first, then its workers and its
 * home's placed jobs ended, then the transcript written.
 */
function stopClosedSession(
	agentDir: string,
	agentId: string,
	saved: SavedBotSession | undefined,
	stop: BotInboxStop,
	ports: BotStopPorts,
): WorkerStopOutcome {
	const home = botHomeOf(agentDir, agentId);
	const transcript = saved && closedTranscript(agentDir, agentId, home.orchestrationHome, saved, ports);
	const { outcome } = cancelOwedWorkerWork(
		home.orchestrationHome,
		agentDir,
		saved?.id,
		new Set([...botHomeSessionIds(home.sessionsDir, "follow"), ...(saved ? [saved.id] : [])]),
		stop.reasonCode,
	);
	if (transcript) {
		const now = ports.now();
		holdPersistedGoalForOwnerStop(closedGoalHost(transcript), stop.at, new Date(now).toISOString());
		declineUsageWaitForOwner(transcript, stop.at, now);
	}
	return outcome;
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
	if (readSessionHeader(saved.file)?.id !== saved.id) {
		ports.warn(interfaceText().botTeam.botStopSessionFileForeign(agentId, saved.file, saved.id));
		return undefined;
	}
	return SessionManager.open(saved.file, botSessionStorageRoots(agentDir, orchestrationHome, saved.id));
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
 * The owner's stop of the workers of bot session `sessionId` (none when the bot has no saved session) while no process
 * hosts the bot, written to its bundle in `home` alone (`stopSessionWorkers`): every open plan closed and every unended
 * worker attempt cancelled for `reasonCode`, so nothing opens the session for them. Their ends are recorded delivered by
 * the session's next open, when its outbox is replayed (`owner_stopped` wakes no one). Then every job the sessions
 * `placedBy` (every session the bot's home holds) placed on another machine is ended in its record in `agentDir`
 * (`endPlacedJobsOfSessions`), so its executor stops and stops spending; the bundle's cancel comes first, so no open
 * dispatches a lane again for a job this ends. The caller holds the bot's host lock, so no process runs what it cancels.
 * Returns how many attempts it cancelled, what it left unended, and how many placed jobs it ended.
 */
export function cancelOwedWorkerWork(
	home: OrchestrationHome,
	agentDir: string,
	sessionId: string | undefined,
	placedBy: ReadonlySet<string>,
	reasonCode: string,
): { readonly cancelled: number; readonly outcome: WorkerStopOutcome; readonly placedEnded: number } {
	const bundle =
		sessionId === undefined
			? { cancelled: 0, outcome: NOTHING_LEFT }
			: cancelBundleWorkers(home, sessionId, reasonCode);
	const placedEnded = endPlacedJobsOfSessions(agentDir, placedBy, jobCancelReasonOf(reasonCode));
	return { ...bundle, placedEnded };
}

function cancelBundleWorkers(
	home: OrchestrationHome,
	sessionId: string,
	reasonCode: string,
): { readonly cancelled: number; readonly outcome: WorkerStopOutcome } {
	if (!existsSync(orchestrationEventStoreDir(home, sessionId))) return { cancelled: 0, outcome: NOTHING_LEFT };
	const runtime = new DurableTaskRuntime({
		store: new OrchestrationEventStore({ orchestrationHome: home, sessionId }),
	});
	let cancelled = 0;
	const outcome = stopSessionWorkers(
		runtime,
		undefined,
		(attempt) => {
			runtime.cancelAttempt(attempt.attemptId, reasonCode);
			cancelled++;
			return false;
		},
		reasonCode,
	);
	return { cancelled, outcome };
}

function takeStops(
	agentDir: string,
	agentId: string,
	apply: (stop: BotInboxStop) => WorkerStopOutcome,
	ports: BotStopPorts,
): BotInboxStop | undefined {
	const unreadable = (file: string, reason: string) =>
		ports.warn(interfaceText().botTeam.botInboxUnreadable(agentId, file, reason));
	const stops = readBotInboxStops(agentDir, agentId, unreadable);
	const newest = stops.at(-1)?.message;
	if (!newest) return undefined;
	const outcome = apply(newest);
	if (outcome.failed.length > 0 || outcome.managed.length > 0)
		ports.warn(interfaceText().botTeam.botStopLeftLanes(agentId, outcome.failed.length, outcome.managed.length));
	const reason = interfaceText().botTeam.botTurnAbortReasons.ownerStopped;
	for (const item of readBotInbox(agentDir, agentId, unreadable))
		if (item.message.at <= newest.at) refuseBotInboxMessage(agentDir, item, reason, ports.now());
	for (const stop of stops) takeBotInboxStop(stop);
	return newest;
}
