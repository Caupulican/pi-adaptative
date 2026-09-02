import type { SessionManager } from "@caupulican/pi-agent-core/node";
import {
	appendSessionSnapshot,
	decodeSessionSnapshotPayload,
	type SessionSnapshotCodec,
	type SessionSnapshotPayload,
} from "../session-snapshot.ts";
import { deepFreeze } from "../util/deep-freeze.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import {
	applyGoalEvent,
	cloneGoalEventForStorage,
	cloneGoalStateForStorage,
	type GoalEvent,
	type GoalState,
	isGoalEvent,
	isGoalState,
	MAX_GOAL_EVENT_HISTORY,
} from "./goal-state.ts";

export const GOAL_STATE_CUSTOM_TYPE = "goal_state";

export type GoalStateSnapshotPayload = SessionSnapshotPayload<"state", GoalState>;

const GOAL_STATE_SNAPSHOT_CODEC: SessionSnapshotCodec<GoalState, "state"> = {
	customType: GOAL_STATE_CUSTOM_TYPE,
	valueKey: "state",
	isValue: isGoalState,
	clone: cloneGoalStateForStorage,
};

interface GoalEventBatchPayload {
	version: 2;
	kind: "events";
	goalId: string;
	baseRevision: number;
	events: readonly GoalEvent[];
}

interface GoalCheckpointPayload {
	version: 2;
	kind: "checkpoint";
	state: GoalState;
}

interface GoalClearedPayload {
	version: 2;
	kind: "cleared";
	goalId: string;
	baseRevision: number;
	clearedAt: string;
}

type GoalJournalPayload = GoalEventBatchPayload | GoalCheckpointPayload | GoalClearedPayload;

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function decodeGoalJournalPayload(data: unknown): GoalJournalPayload | undefined {
	if (!isPlainRecord(data) || data.version !== 2 || typeof data.kind !== "string") return undefined;
	if (data.kind === "checkpoint") {
		if (!isGoalState(data.state)) return undefined;
		return { version: 2, kind: "checkpoint", state: cloneGoalStateForStorage(data.state) };
	}
	if (data.kind === "cleared") {
		if (
			typeof data.goalId !== "string" ||
			!isNonNegativeInteger(data.baseRevision) ||
			typeof data.clearedAt !== "string"
		) {
			return undefined;
		}
		return {
			version: 2,
			kind: "cleared",
			goalId: data.goalId,
			baseRevision: data.baseRevision,
			clearedAt: data.clearedAt,
		};
	}
	if (data.kind !== "events") return undefined;
	if (
		typeof data.goalId !== "string" ||
		!isNonNegativeInteger(data.baseRevision) ||
		!Array.isArray(data.events) ||
		data.events.length === 0 ||
		data.events.length > MAX_GOAL_EVENT_HISTORY ||
		!data.events.every(isGoalEvent)
	) {
		return undefined;
	}
	return {
		version: 2,
		kind: "events",
		goalId: data.goalId,
		baseRevision: data.baseRevision,
		events: data.events.map(cloneGoalEventForStorage),
	};
}

/**
 * Persist one state transition. Canonical reducer transitions are journaled as a bounded event
 * batch; starts, replacements, and non-canonical imports use one checkpoint. This removes the old
 * recursive full-state-on-every-mutation growth while keeping compound owner transitions atomic.
 */
export function appendGoalStateSnapshot(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	state: GoalState,
	previous?: GoalState,
): string {
	const revision = state.revision ?? 0;
	const previousRevision = previous?.revision ?? 0;
	const eventCount = previous && previous.goalId === state.goalId ? revision - previousRevision : 0;
	if (previous && eventCount > 0 && eventCount <= state.events.length && eventCount <= MAX_GOAL_EVENT_HISTORY) {
		const payload: GoalEventBatchPayload = {
			version: 2,
			kind: "events",
			goalId: state.goalId,
			baseRevision: previousRevision,
			events: state.events.slice(-eventCount).map(cloneGoalEventForStorage),
		};
		const entryId = sessionManager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, payload);
		// The journal's newest entry now stands for exactly this state: prime the reader's cache so the
		// next read does not reconstruct what was just written.
		cacheGoalState(sessionManager, entryId, state);
		return entryId;
	}

	const payload: GoalCheckpointPayload = {
		version: 2,
		kind: "checkpoint",
		state: cloneGoalStateForStorage(state),
	};
	const entryId = sessionManager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, payload);
	cacheGoalState(sessionManager, entryId, state);
	return entryId;
}

export function appendGoalClearedSnapshot(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	state: GoalState,
	clearedAt: string,
): string {
	const payload: GoalClearedPayload = {
		version: 2,
		kind: "cleared",
		goalId: state.goalId,
		baseRevision: state.revision ?? 0,
		clearedAt,
	};
	const entryId = sessionManager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, payload);
	cacheGoalState(sessionManager, entryId, undefined);
	return entryId;
}

/** Legacy payload decode retained for imports and focused codec tests. */
export function decodeGoalStateSnapshotPayload(data: unknown): GoalState | undefined {
	return decodeSessionSnapshotPayload(data, GOAL_STATE_SNAPSHOT_CODEC);
}

interface GoalStateSource {
	getLatestCustomEntryOnBranch: SessionManager["getLatestCustomEntryOnBranch"];
}

interface GoalStateCacheEntry {
	latestEntryId: string | null;
	state: GoalState | undefined;
}

/**
 * Keyed by the session manager object itself, so the writer (`appendGoalStateSnapshot`, which only
 * sees the append surface) and the reader (`getLatestGoalStateSnapshot`) share one entry.
 */
const goalStateCache = new WeakMap<object, GoalStateCacheEntry>();

function cacheGoalState(
	sessionManager: object,
	latestEntryId: string | null,
	state: GoalState | undefined,
): GoalState | undefined {
	// One frozen value per journal position, shared by every reader: its identity changes exactly
	// when the journal does, so a reader compares snapshots by identity instead of deep-comparing
	// two fresh clones, and no reader pays a clone of every event per read.
	const stored = state ? deepFreeze(cloneGoalStateForStorage(state)) : undefined;
	goalStateCache.set(sessionManager, { latestEntryId, state: stored });
	return stored;
}

function replayGoalEventBatches(base: GoalState, batches: readonly GoalEventBatchPayload[]): GoalState | undefined {
	let state = base;
	for (const batch of batches) {
		if (batch.goalId !== state.goalId || batch.baseRevision !== (state.revision ?? 0)) return undefined;
		for (const event of batch.events) state = applyGoalEvent(state, event);
	}
	return state;
}

/**
 * Reconstruct the latest goal from one checkpoint plus linear event batches. Any malformed newest
 * goal journal fails closed instead of skipping backward to an older active state and resurrecting
 * work after corruption.
 *
 * Cost is bounded by what changed since the last read, not by the session. The journal appends an
 * event batch on nearly every request of an active goal (thousands per long session), so a cache
 * keyed only on the newest entry id missed on every read and each miss walked the whole ancestry
 * back to the checkpoint, replaying every batch since -- measured at 9ms growing to 94ms per
 * `get_goal` across one 4,500-request session. The walk now stops at the entry the cache already
 * reflects and replays only the batches after it, and every write primes the cache with the state
 * it just journaled, so the common read after a write is a clone and nothing else.
 */
export function getLatestGoalStateSnapshot(sessionManager: GoalStateSource): GoalState | undefined {
	const latestEntry = sessionManager.getLatestCustomEntryOnBranch(GOAL_STATE_CUSTOM_TYPE);
	const latestEntryId = latestEntry?.id ?? null;
	const cached = goalStateCache.get(sessionManager);
	if (cached?.latestEntryId === latestEntryId) return cached.state;
	if (!latestEntry) return cacheGoalState(sessionManager, latestEntryId, undefined);

	const batches: GoalEventBatchPayload[] = [];
	let entry = latestEntry;
	for (;;) {
		if (cached?.state && entry.id === cached.latestEntryId) {
			// Everything from here back is already reflected in the cached state; only the batches
			// collected on the way down are new. A batch that does not chain onto it is corruption of
			// the same kind the checkpoint path fails closed on, and gets the same answer.
			batches.reverse();
			return cacheGoalState(sessionManager, latestEntryId, replayGoalEventBatches(cached.state, batches));
		}
		const legacy = decodeGoalStateSnapshotPayload(entry.data);
		const journal = legacy ? undefined : decodeGoalJournalPayload(entry.data);
		if (!legacy && !journal) return cacheGoalState(sessionManager, latestEntryId, undefined);
		if (journal?.kind === "cleared") return cacheGoalState(sessionManager, latestEntryId, undefined);

		const checkpoint = legacy ?? (journal?.kind === "checkpoint" ? journal.state : undefined);
		if (checkpoint) {
			batches.reverse();
			return cacheGoalState(sessionManager, latestEntryId, replayGoalEventBatches(checkpoint, batches));
		}

		if (journal?.kind !== "events") return cacheGoalState(sessionManager, latestEntryId, undefined);
		batches.push(journal);
		if (entry.parentId === null) return cacheGoalState(sessionManager, latestEntryId, undefined);
		const previousEntry = sessionManager.getLatestCustomEntryOnBranch(GOAL_STATE_CUSTOM_TYPE, entry.parentId);
		if (!previousEntry) return cacheGoalState(sessionManager, latestEntryId, undefined);
		entry = previousEntry;
	}
}

/** Explicit legacy writer for migration tests only. */
export function appendLegacyGoalStateSnapshot(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	state: GoalState,
): string {
	return appendSessionSnapshot(sessionManager, GOAL_STATE_SNAPSHOT_CODEC, state);
}
