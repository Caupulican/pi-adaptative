/**
 * Taking the owner's stop of a bot (`requestBotStop` records it in the bot's inbox): whichever process takes it applies it,
 * and deletes it only then. The process hosting the bot's session applies it through the live session
 * (`takeHostedBotStops`). Any other process applies it while no process hosts the bot, durably and under the bot's host
 * lock (`applyUnhostedBotStop`), so a stop never waits for a host that may never come; one that finds the lock held leaves
 * it to the holder, and the work it stopped stays held back until then (`BotOwedWork`).
 *
 * What it ends: every open plan is closed and every unended worker attempt cancelled, the bot's parent agents included
 * (`OWNER_STOPPED_REASON`, whose ends wake no one), and every job the session placed on another machine is ended, first,
 * so nothing goes on spending; then the bot's goal is paused when it runs or the system would resume it on its own
 * (`holdPersistedGoalForOwnerStop`; the owner resumes it) and its usage-limit wait is declined
 * (`declineUsageWaitForOwner`). A managed lane is left to the extension that runs it, and the owner is told.
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
import { endPlacedJobsOfSession } from "../remote/job-client.ts";
import { jobCancelReasonOf } from "../remote/remote-jobs.ts";
import { declineUsageWaitForOwner, type UsageWakeWriter } from "../usage-wake-record.ts";
import { botHomeOf } from "./bot-home.ts";
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
 * The stop applied to a hosted bot's live session (its foreground turn already stopped by the host): its whole fleet
 * cancelled (`cancelOwnFleet`), then its goal held and its usage wait declined. What it left unended, by why.
 */
export function applyOwnerStopToSession(
	session: HostedBotStopSession,
	stop: BotInboxStop,
	now: number,
): WorkerStopOutcome {
	const outcome = session.fleet.cancelOwnFleet(stop.reasonCode);
	holdPersistedGoalForOwnerStop(session.goal, new Date(now).toISOString());
	declineUsageWaitForOwner(session.transcript, now);
	return outcome;
}

/**
 * Takes the stops waiting for the bot this process hosts: the newest is applied through `stopHere` (the host stops the
 * foreground turn and calls {@link applyOwnerStopToSession}), the messages it covers are refused, and every stop read is
 * deleted. The stop applied, undefined when none waits.
 */
export function takeHostedBotStops(
	agentDir: string,
	agentId: string,
	stopHere: (stop: BotInboxStop) => WorkerStopOutcome,
	ports: BotStopPorts,
): BotInboxStop | undefined {
	return takeStops(agentDir, agentId, stopHere, ports);
}

/**
 * Applies the stop waiting for bot `agentId` while no process hosts it, under its host lock: its saved session's workers
 * and placed jobs ended (`cancelOwedWorkerWork`), its goal paused and its usage wait declined in its transcript, the
 * messages the stop covers refused and the stops deleted, all in one synchronous run that releases the lock at its end. A
 * bot whose session never ran has only its messages and stops to take. `held` when another process holds the lock (its
 * host takes the stop), `none` when no stop waits. A failure throws, the lock released and the stop left waiting.
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
			(stop) => (saved ? stopClosedSession(agentDir, agentId, saved, stop, ports.now()) : NOTHING_LEFT),
			ports,
		);
		return stop ? "applied" : "none";
	} finally {
		taken.lock.release();
	}
}

const NOTHING_LEFT: WorkerStopOutcome = { remote: [], managed: [], failed: [] };

/** The stop applied to a closed session, its host lock held: workers and placed jobs first, then its transcript. */
function stopClosedSession(
	agentDir: string,
	agentId: string,
	saved: SavedBotSession,
	stop: BotInboxStop,
	now: number,
): WorkerStopOutcome {
	const roots = botSessionStorageRoots(agentDir, botHomeOf(agentDir, agentId).orchestrationHome, saved.id);
	const { outcome } = cancelOwedWorkerWork(roots.orchestrationHome, agentDir, saved.id, stop.reasonCode);
	// A session file not written yet holds no goal and no usage wait; one that holds another session is refused.
	if (!existsSync(saved.file) || statSync(saved.file).size === 0) return outcome;
	const header = readSessionHeader(saved.file);
	if (header?.id !== saved.id)
		throw new Error(`the session file ${saved.file} does not hold the bot's session ${saved.id}`);
	const transcript = SessionManager.open(saved.file, roots);
	holdPersistedGoalForOwnerStop(closedGoalHost(transcript), new Date(now).toISOString());
	declineUsageWaitForOwner(transcript, now);
	return outcome;
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
 * The owner's stop of the workers of bot session `sessionId` while no process hosts it, written to its bundle in `home`
 * alone (`stopSessionWorkers`): every open plan closed and every unended worker attempt cancelled for `reasonCode`, so
 * nothing opens the session for them. Their ends are recorded delivered by the session's next open, when its outbox is
 * replayed (`owner_stopped` wakes no one). Then every job the session placed on another machine is ended in its record in
 * `agentDir` (`endPlacedJobsOfSession`), so its executor stops and stops spending; the bundle's cancel comes first, so no
 * open dispatches a lane again for a job this ends. The caller holds the bot's host lock, so no process runs what it
 * cancels. Returns how many attempts it cancelled, what it left unended, and how many placed jobs it ended.
 */
export function cancelOwedWorkerWork(
	home: OrchestrationHome,
	agentDir: string,
	sessionId: string,
	reasonCode: string,
): { readonly cancelled: number; readonly outcome: WorkerStopOutcome; readonly placedEnded: number } {
	const bundle = cancelBundleWorkers(home, sessionId, reasonCode);
	const placedEnded = endPlacedJobsOfSession(agentDir, sessionId, jobCancelReasonOf(reasonCode));
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
