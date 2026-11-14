/**
 * What a bot's own session is owed, read from the store and its file without loading it: a live watch to sample, a firing
 * whose wake it has not taken, or a wake it accepted and never ran (a turn refused at its start). And the one rule that
 * keeps watches with the session that holds them: the watches the home's other sessions armed are cancelled when the bot
 * continues one session.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ParentInputIndex } from "../../kernel/session/parent-input-ledger.ts";
import { readSessionHeader } from "../../kernel/session/session-file-reading.ts";
import { SessionManager } from "../../kernel/session/session-manager.ts";
import type { PersistentBotTeamStore } from "../delegation/persistent-bot-team-store.ts";
import { liveOwnWatches } from "../routines/routine-holder.ts";

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
 * Whether the session file holds a wake it accepted and never ran: the store counts a fired watch's result delivered once
 * the session saved it, and a turn refused at its start (an outdated compile, an unusable model) leaves it pending in the
 * file, where only the session's own recovery, when it opens, runs it. Reads the whole file.
 */
export function holdsUnrunWake(file: string, agentDir: string): boolean {
	const view = SessionManager.openReadOnly(file, agentDir);
	// The session's own reading of its branch (`getPendingParentInputs`), on a view that opens nothing for writing.
	const index = new ParentInputIndex();
	for (const entry of view.getBranch()) index.apply(entry, (id) => view.getEntry(id));
	return index.pendingInputs("turn").length > 0;
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
