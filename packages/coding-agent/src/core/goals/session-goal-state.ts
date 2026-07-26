import type { SessionManager } from "@caupulican/pi-agent-core/node";
import {
	appendSessionSnapshot,
	decodeSessionSnapshotPayload,
	type SessionSnapshotCodec,
	type SessionSnapshotPayload,
} from "../session-snapshot.ts";
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
		return sessionManager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, payload);
	}

	const payload: GoalCheckpointPayload = {
		version: 2,
		kind: "checkpoint",
		state: cloneGoalStateForStorage(state),
	};
	return sessionManager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, payload);
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
	return sessionManager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, payload);
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

const goalStateCache = new WeakMap<GoalStateSource, GoalStateCacheEntry>();

function cacheGoalState(
	sessionManager: GoalStateSource,
	latestEntryId: string | null,
	state: GoalState | undefined,
): GoalState | undefined {
	const stored = state ? cloneGoalStateForStorage(state) : undefined;
	goalStateCache.set(sessionManager, { latestEntryId, state: stored });
	return stored ? cloneGoalStateForStorage(stored) : undefined;
}

/**
 * Reconstruct the latest goal from one checkpoint plus linear event batches. Any malformed newest
 * goal journal fails closed instead of skipping backward to an older active state and resurrecting
 * work after corruption.
 */
export function getLatestGoalStateSnapshot(sessionManager: GoalStateSource): GoalState | undefined {
	const latestEntry = sessionManager.getLatestCustomEntryOnBranch(GOAL_STATE_CUSTOM_TYPE);
	const latestEntryId = latestEntry?.id ?? null;
	const cached = goalStateCache.get(sessionManager);
	if (cached?.latestEntryId === latestEntryId) {
		return cached.state ? cloneGoalStateForStorage(cached.state) : undefined;
	}
	if (!latestEntry) return cacheGoalState(sessionManager, latestEntryId, undefined);

	const batches: GoalEventBatchPayload[] = [];
	let entry = latestEntry;
	for (;;) {
		const legacy = decodeGoalStateSnapshotPayload(entry.data);
		const journal = legacy ? undefined : decodeGoalJournalPayload(entry.data);
		if (!legacy && !journal) return cacheGoalState(sessionManager, latestEntryId, undefined);
		if (journal?.kind === "cleared") return cacheGoalState(sessionManager, latestEntryId, undefined);

		const checkpoint = legacy ?? (journal?.kind === "checkpoint" ? journal.state : undefined);
		if (checkpoint) {
			let state = checkpoint;
			for (const batch of batches.reverse()) {
				if (batch.goalId !== state.goalId || batch.baseRevision !== (state.revision ?? 0)) {
					return cacheGoalState(sessionManager, latestEntryId, undefined);
				}
				for (const event of batch.events) state = applyGoalEvent(state, event);
			}
			return cacheGoalState(sessionManager, latestEntryId, state);
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
