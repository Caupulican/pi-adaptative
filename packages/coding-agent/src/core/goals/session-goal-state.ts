import type { SessionManager } from "../../kernel/node.ts";
import {
	decodeSessionSnapshotPayload,
	type SessionSnapshotCodec,
	type SessionSnapshotPayload,
} from "../session-snapshot.ts";
import { deepFreeze } from "../util/deep-freeze.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { assertGoalIdentityAvailable, GOAL_STATE_CUSTOM_TYPE, goalIdentityConflict } from "./goal-journal-identity.ts";
import { recoverLegacyGoalCorrection } from "./goal-legacy-correction.ts";
import { getGoalStateRevision, matchesGoalStateRevision } from "./goal-lifecycle.ts";
import {
	applyGoalEvent,
	cloneGoalEventForStorage,
	cloneGoalStateForStorage,
	type GoalEvent,
	type GoalState,
	isGoalEvent,
	isGoalExecutionActive,
	isGoalState,
	MAX_GOAL_EVENT_HISTORY,
} from "./goal-state.ts";

export {
	assertGoalIdentityUnambiguous,
	GOAL_STATE_CUSTOM_TYPE,
	goalIdentityConflict,
} from "./goal-journal-identity.ts";

export type GoalStateSnapshotPayload = SessionSnapshotPayload<"state", GoalState>;

const GOAL_STATE_SNAPSHOT_CODEC: SessionSnapshotCodec<GoalState, "state"> = {
	customType: GOAL_STATE_CUSTOM_TYPE,
	valueKey: "state",
	isValue: isGoalState,
	clone: cloneGoalStateForStorage,
};

interface GoalEventBatchPayload {
	proofLifecycle?: "current";
	version: 2;
	kind: "events";
	goalId: string;
	baseRevision: number;
	events: readonly GoalEvent[];
}

interface GoalCheckpointPayload {
	version: 2;
	kind: "checkpoint";
	opensWorkUnit?: true;
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

export function decodeGoalJournalPayload(data: unknown): GoalJournalPayload | undefined {
	if (!isPlainRecord(data) || data.version !== 2 || typeof data.kind !== "string") return undefined;
	if (data.kind === "checkpoint") {
		if (!isGoalState(data.state)) return undefined;
		return {
			version: 2,
			kind: "checkpoint",
			...(data.opensWorkUnit === true ? { opensWorkUnit: true as const } : {}),
			state: cloneGoalStateForStorage(data.state),
		};
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
	if (data.kind !== "events" || (data.proofLifecycle !== undefined && data.proofLifecycle !== "current"))
		return undefined;
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
		proofLifecycle: data.proofLifecycle,
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
	sessionManager: Pick<SessionManager, "appendCustomEntry" | "getEntries" | "getLatestCustomEntryOnBranch">,
	state: GoalState,
	previous?: GoalState,
	admission?: {
		hasDurableObjective(goalId: string): boolean;
	},
): string {
	const current = getLatestGoalStateSnapshot(sessionManager);
	assertGoalIdentityAvailable(sessionManager, state, current, admission?.hasDurableObjective);
	previous ??= current;
	const revision = state.revision ?? 0;
	const previousRevision = previous?.revision ?? 0;
	const eventCount =
		previous && previous.goalId === state.goalId && previous.createdAt === state.createdAt
			? revision - previousRevision
			: 0;
	if (previous && eventCount > 0 && eventCount <= state.events.length && eventCount <= MAX_GOAL_EVENT_HISTORY) {
		const payload: GoalEventBatchPayload = {
			version: 2,
			kind: "events",
			proofLifecycle: "current",
			goalId: state.goalId,
			baseRevision: previousRevision,
			events: state.events.slice(-eventCount).map(cloneGoalEventForStorage),
		};
		const entryId = sessionManager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, payload);
		// The journal's newest entry now stands for exactly this state: prime the reader's cache so the
		// next read does not reconstruct what was just written.
		cacheGoalState(sessionManager, entryId, state, sessionManager);
		return entryId;
	}

	const payload: GoalCheckpointPayload = {
		version: 2,
		kind: "checkpoint",
		...(admission && current?.goalId !== state.goalId && isGoalExecutionActive(state.status)
			? { opensWorkUnit: true as const }
			: {}),
		state: cloneGoalStateForStorage(state),
	};
	const entryId = sessionManager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, payload);
	cacheGoalState(sessionManager, entryId, state, sessionManager);
	return entryId;
}

/** Clearing an ambiguous allocation retires its goal record without cancelling another lifetime's objective. */
export function clearGoalStateJournal(
	source: Pick<SessionManager, "appendCustomEntry" | "getLatestCustomEntryOnBranch" | "getEntries">,
	state: GoalState,
	now: string,
	synchronize: (state: GoalState) => void,
): string {
	if (!matchesGoalStateRevision(getLatestGoalStateSnapshot(source), getGoalStateRevision(state)))
		throw new Error("Goal state changed concurrently; retry clear against the latest state.");
	let settled = state;
	if (!goalIdentityConflict(source, state)) {
		let settledEntry = source.getLatestCustomEntryOnBranch(GOAL_STATE_CUSTOM_TYPE)?.id;
		if (state.status !== "cancelled" && state.status !== "completed") {
			settled = applyGoalEvent(state, { type: "cancel_goal", now });
			settledEntry = appendGoalStateSnapshot(source, settled, state);
		}
		const assertCurrent = () => {
			if (source.getLatestCustomEntryOnBranch(GOAL_STATE_CUSTOM_TYPE)?.id !== settledEntry)
				throw new Error("Goal state changed during synchronization; retry clear against the latest state.");
		};
		assertCurrent();
		// Keep the terminal record until its objective has reconciled, including a completion retried after a storage failure.
		synchronize(settled);
		assertCurrent();
	}
	return appendGoalClearedSnapshot(source, settled, now);
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
	goalStateCache.delete(sessionManager);
	return entryId;
}

/**
 * Legacy payload decode retained for imports and focused codec tests.
 *
 * @deprecated Decodes the legacy goal snapshot format written before the v2 goal journal; remove when no session file holds a legacy snapshot.
 */
export function decodeGoalStateSnapshotPayload(data: unknown): GoalState | undefined {
	return decodeSessionSnapshotPayload(data, GOAL_STATE_SNAPSHOT_CODEC);
}

interface GoalStateSource {
	getLatestCustomEntryOnBranch: SessionManager["getLatestCustomEntryOnBranch"];
}

/** A pruned host receipt stays consumed on the active branch's durable goal journal. */
export function hasRecordedGoalEvidence(
	sessionManager: GoalStateSource,
	goal: Pick<GoalState, "goalId" | "createdAt">,
	evidenceId: string,
): boolean {
	let entry = sessionManager.getLatestCustomEntryOnBranch(GOAL_STATE_CUSTOM_TYPE);
	let batchFound = false;
	while (entry) {
		const legacy = decodeGoalStateSnapshotPayload(entry.data);
		const journal = legacy ? undefined : decodeGoalJournalPayload(entry.data);
		if (!legacy && !journal) throw new Error("Cannot verify a host receipt against malformed goal history.");
		if (journal?.kind === "cleared") return false;
		const checkpoint = legacy ?? (journal?.kind === "checkpoint" ? journal.state : undefined);
		if (checkpoint) {
			if (checkpoint.goalId !== goal.goalId || checkpoint.createdAt !== goal.createdAt) return false;
			if (batchFound || checkpoint.evidence.some((evidence) => evidence.id === evidenceId)) return true;
		} else if (journal?.kind === "events") {
			if (journal.goalId !== goal.goalId) return false;
			batchFound ||= journal.events.some((event) => event.type === "add_evidence" && event.id === evidenceId);
		}
		if (entry.parentId === null) return false;
		entry = sessionManager.getLatestCustomEntryOnBranch(GOAL_STATE_CUSTOM_TYPE, entry.parentId);
	}
	return false;
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
	source?: GoalStateSource,
): GoalState | undefined {
	// One frozen value per journal position, shared by every reader: its identity changes exactly
	// when the journal does, so a reader compares snapshots by identity instead of deep-comparing
	// two fresh clones, and no reader pays a clone of every event per read.
	const authoritative =
		source && state && state.ownerActivatedAt === undefined
			? recoverLegacyGoalCorrection(source, state, latestEntryId ?? undefined)
			: state;
	const stored = authoritative ? deepFreeze(cloneGoalStateForStorage(authoritative)) : undefined;
	goalStateCache.set(sessionManager, { latestEntryId, state: stored });
	return stored;
}

interface GoalReplayBatch {
	payload: GoalEventBatchPayload;
	entryId: string;
	targetEntryId: string;
}

export function replayGoalEventBatches(base: GoalState, batches: readonly GoalReplayBatch[]): GoalState | undefined {
	let state = base;
	for (const { payload: batch, entryId, targetEntryId } of batches) {
		if (batch.goalId !== state.goalId || batch.baseRevision !== (state.revision ?? 0)) return undefined;
		for (const [index, event] of batch.events.entries()) {
			// Only a retained canonical owner edit immediately after a durable completion proves legacy authority.
			const admitted =
				state.status === "completed" && event.type === "edit_goal" && index === 0
					? {
							type: "correct_completed_goal" as const,
							correction: {
								ownerEntryId: entryId,
								revision: (state.revision ?? 0) + 1,
								targetCompletionRevision: state.revision ?? 0,
								targetCompletionEntryId: targetEntryId,
								objective: event.userGoal,
							},
							tokenBudget: event.tokenBudget,
							now: event.now,
						}
					: event;
			try {
				state = applyGoalEvent(state, admitted, batch.proofLifecycle ?? "legacy");
			} catch {
				return undefined;
			}
		}
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

	const batches: GoalReplayBatch[] = [];
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
			return cacheGoalState(
				sessionManager,
				latestEntryId,
				replayGoalEventBatches(recoverLegacyGoalCorrection(sessionManager, checkpoint, entry.id), batches),
			);
		}

		if (journal?.kind !== "events") return cacheGoalState(sessionManager, latestEntryId, undefined);
		if (entry.parentId === null) return cacheGoalState(sessionManager, latestEntryId, undefined);
		const previousEntry = sessionManager.getLatestCustomEntryOnBranch(GOAL_STATE_CUSTOM_TYPE, entry.parentId);
		if (!previousEntry) return cacheGoalState(sessionManager, latestEntryId, undefined);
		batches.push({ payload: journal, entryId: entry.id, targetEntryId: previousEntry.id });
		entry = previousEntry;
	}
}
