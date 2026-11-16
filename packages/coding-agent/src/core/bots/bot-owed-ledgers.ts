/**
 * What a bot's owed work knows of the files of a session no process hosts, each read again only once the file changed: its
 * saved session file (the usage stop its load waits on and the goal its load takes up, `SavedSessionLedger`), its worker
 * bundle (`WorkerWorkLedger`) and the wakes its file holds accepted and never ran (`UnrunWakeLedger`). `BotOwedWork`
 * (`bot-session-owed-work.ts`) decides from them when the session opens.
 */

import { existsSync, statSync } from "node:fs";
import { ParentInputIndex } from "../../kernel/session/parent-input-ledger.ts";
import type { OrchestrationHome } from "../../kernel/session/session-bundle-paths.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import { type WorkerWorkFacts, workerWorkFacts } from "../delegation/worker-owed-work.ts";
import { goalResumesOnRestore } from "../goals/goal-lifecycle.ts";
import type { GoalState } from "../goals/goal-state.ts";
import { getLatestGoalStateSnapshot } from "../goals/session-goal-state.ts";
import { OrchestrationEventStore } from "../orchestration/event-store.ts";
import { OrchestrationSnapshotRequiredError } from "../orchestration/event-store-errors.ts";
import { readTaskRuntimeProjection } from "../orchestration/task-runtime-reader.ts";
import { botSessionStorageRoots } from "../orchestration-homes.ts";
import { goalUsageStop, type RestoredUsageRules, restoredUsageStop } from "../usage-reset-resume.ts";
import { latestUsageWake, type UsageWakeRecord } from "../usage-wake-record.ts";
import { botHomeOf } from "./bot-home.ts";
import { fileIdentity } from "./bot-home-records.ts";
import { readSessionSnapshot } from "./bot-remote-view.ts";

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
 * only when it holds one, with its latest wake.
 */
export interface SavedUsageStop {
	readonly lastMessage: AgentMessage | undefined;
	readonly goal: GoalState | undefined;
	readonly wake: UsageWakeRecord | undefined;
}

/** The latest goal a saved session holds: its identity (id and revision), and whether a load of the session takes it up. */
export interface SavedGoal {
	readonly key: string;
	readonly resumes: boolean;
}

/**
 * What a bot's owed work reads of its saved session file: the usage stop its load waits on (`usage`, undefined when it
 * holds none), and its latest goal (`goal`, undefined when it holds none). A goal a usage or rate limit stopped waits for
 * the reset, not for the load (`goalUsageStop`); any other the load takes up when it runs or the system's own recovery
 * resumes it (`goalResumesOnRestore`). Reads the whole file.
 */
export interface SavedSessionFacts {
	readonly usage: SavedUsageStop | undefined;
	readonly goal: SavedGoal | undefined;
}

function readSavedSessionFacts(file: string, agentDir: string): SavedSessionFacts {
	return readSessionSnapshot(file, agentDir, (view) => {
		const last = view.buildSessionContext().messages.at(-1);
		const lastMessage = last?.role === "assistant" && last.stopReason === "error" ? last : undefined;
		const latestGoal = getLatestGoalStateSnapshot(view);
		const usageStopped = latestGoal !== undefined && goalUsageStop(latestGoal) !== undefined;
		const goal = usageStopped ? latestGoal : undefined;
		return {
			usage: lastMessage || goal ? { lastMessage, goal, wake: latestUsageWake(view) } : undefined,
			goal: latestGoal && {
				key: `${latestGoal.goalId}@${latestGoal.revision ?? 0}`,
				resumes: !usageStopped && goalResumesOnRestore(latestGoal, new Date().toISOString()),
			},
		};
	});
}

/**
 * When the bot's saved session continues the turn or goal a subscription's usage limit stopped (`stop`, read by
 * {@link SavedSessionLedger}), moved later by the exhaustion the provider admission recorded for the refusing model, as
 * the live session's wake moves it: a closed bot is not opened against a limit that still holds. The rules are read at
 * each ask. Undefined when it waits for none.
 */
export function savedUsageResumeAt(stop: SavedUsageStop | undefined, rules: SavedUsageResumeRules): number | undefined {
	const restored = stop && restoredUsageStop(stop.lastMessage, stop.goal, stop.wake, rules);
	if (!restored) return undefined;
	const until = rules.modelExhaustion(restored.resume.ref)?.until;
	return until !== undefined && until > restored.at ? until : restored.at;
}

/** A saved session file as the host read it for its owed work; `fresh` the first time it did not read with that identity. */
export type SavedSessionRead =
	| { readonly kind: "read"; readonly facts: SavedSessionFacts }
	| { readonly kind: "unreadable"; readonly error: unknown; readonly fresh: boolean };

/**
 * What the host knows of each closed bot's saved session file for its owed work (`readSavedSessionFacts`): read again only
 * once the file's identity (`fileIdentity`, taken before the read) changed, so an unchanged transcript is not parsed at
 * every attach and host change. A file that did not read is kept with the identity it failed on, reported once. What its
 * usage stop holds and its goal's identity alone are kept, one record per bot.
 */
export class SavedSessionLedger {
	private readonly reads = new Map<
		string,
		{ readonly file: string; readonly identity: string | undefined; readonly read: SavedSessionRead }
	>();

	read(agentId: string, file: string, agentDir: string): SavedSessionRead {
		const identity = fileIdentity(file);
		const known = this.reads.get(agentId);
		if (known?.file === file && known.identity === identity)
			return known.read.kind === "unreadable" ? { ...known.read, fresh: false } : known.read;
		let read: SavedSessionRead;
		try {
			read = { kind: "read", facts: readSavedSessionFacts(file, agentDir) };
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
export type BundleRead =
	| { readonly kind: "none" }
	| { readonly kind: "facts"; readonly facts: WorkerWorkFacts }
	| { readonly kind: "unreadable"; readonly error: unknown; readonly fresh: boolean };

/**
 * What the host knows of the worker work each bot's bundle owes (`workerWorkFacts`): the projection is replayed again only
 * once the store committed since the last read, so the periodic listing costs a stat and an absent next event file per bot
 * whose store did not change. A bundle that did not read is read again only once its files change (`bundleFilesIdentity`),
 * so a corrupt one costs stats, not a replay, at each listing. The facts alone are kept, one record per bot.
 */
export class WorkerWorkLedger {
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
