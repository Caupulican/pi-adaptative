/**
 * What a bot's own session is owed, read from the store and its file without loading it: a live watch to sample, a firing
 * whose wake it has not taken, or a wake it accepted and never ran (a turn refused at its start). And the one rule that
 * keeps watches with the session that holds them: the watches the home's other sessions armed are cancelled when the bot
 * continues one session.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ParentInputIndex } from "../../kernel/session/parent-input-ledger.ts";
import { readSessionHeader } from "../../kernel/session/session-file-reading.ts";
import type { SessionManager } from "../../kernel/session/session-manager.ts";
import type { PersistentBotTeamStore } from "../delegation/persistent-bot-team-store.ts";
import { liveOwnWatches } from "../routines/routine-holder.ts";
import { readSessionSnapshot } from "./bot-remote-view.ts";

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
 * attach and host change (the ids alone are kept, one record per bot); and the wakes a run of the session was refused at
 * its start while holding, with the definition it ran on, so a refusal is not what opens the session again.
 */
export class UnrunWakeLedger {
	private readonly reads = new Map<string, { file: string; size: number; mtimeMs: number; ids: string }>();
	private readonly refusals = new Map<string, string>();

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

	/** A run of the bot's session, built on `key`, was refused at its start while `manager` held these wakes. */
	refused(agentId: string, key: string, manager: Pick<SessionManager, "getPendingParentInputs">): void {
		const ids = manager.getPendingParentInputs("turn").map((input) => input.metadata.deliveryId);
		if (ids.length > 0) this.refusals.set(agentId, `${key} ${ids.join(" ")}`);
	}

	/** Whether the wakes `ids` were refused on the definition `key` already: nothing changed that lets them run. */
	refusedAlready(agentId: string, key: string | undefined, ids: string): boolean {
		return this.refusals.get(agentId) === `${key} ${ids}`;
	}

	/** An open of the bot's session failed: it refused no wake, so the next change asks again. */
	openFailed(agentId: string): void {
		this.refusals.delete(agentId);
	}

	/** The bot's session loaded: its file is read again when next asked, after the session wrote it. */
	loaded(agentId: string): void {
		this.reads.delete(agentId);
	}

	/** The bot was released (retired, or off the session path): nothing of it is kept. */
	released(agentId: string): void {
		this.reads.delete(agentId);
		this.refusals.delete(agentId);
	}
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
