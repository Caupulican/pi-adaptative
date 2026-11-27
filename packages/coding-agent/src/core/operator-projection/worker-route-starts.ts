/** Projects immutable worker dispatch origins and durable start events onto their original route decisions. */
import { harnessLog } from "../../kernel/harness-log.ts";
import type { SqliteDatabase } from "../context/sqlite-database.ts";
import { isoDate } from "../orchestration/codec-primitives.ts";
import { type ObjectiveRouteOrigin, objectiveRouteOriginFields } from "../orchestration/dispatch-request-fields.ts";
import type { OrchestrationEventStore } from "../orchestration/event-store.ts";
import {
	archiveIsCommitted,
	type RetentionArchiveFile,
	readRetentionArchives,
	retentionArchiveDir,
} from "../orchestration/retention-archive.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import type { DecisionLedgerStore } from "./decision-ledger-store.ts";

export function writeRecoveredWorkerRouteStarts(
	database: SqliteDatabase,
	sessionId: string,
	starts: readonly ObjectiveRouteOrigin[],
): void {
	if (!starts.length) return;
	database
		.prepare(`WITH starts AS (
		SELECT json_extract(value, '$.sessionId') AS session_id, json_extract(value, '$.cycleId') AS cycle_id,
			json_extract(value, '$.objectiveId') AS objective_id,
			json_extract(value, '$.executor') AS executor FROM json_each(?)
	)
	UPDATE route_decisions AS target SET executor = starts.executor FROM starts
	WHERE target.session_id = ? AND target.session_id = starts.session_id AND target.cycle_id = starts.cycle_id AND target.objective_id = starts.objective_id AND target.executor IS NULL
		AND (SELECT COUNT(*) FROM route_decisions d WHERE d.session_id = target.session_id AND d.cycle_id = target.cycle_id) = 1
		AND ((starts.executor = 'worker:escalated' AND target.route = 'escalate_capability') OR
			(starts.executor = 'worker' AND target.route IN ('retrieve', 'implement', 'investigate', 'verify', 'review', 'replan', 'continue_current_worker')))`)
		.run(JSON.stringify(starts), sessionId);
}

/** Unleased and lease-only attempts have no firstStartedAt. Never reconstruct a missing origin from a lane or task name. */
export function reconcileWorkerRouteStarts(
	sessionId: string,
	snapshot: TaskRuntimeProjection | undefined,
	getLedger: () => DecisionLedgerStore | undefined,
	attemptId?: string,
): void {
	if (!snapshot) return;
	const starts: ObjectiveRouteOrigin[] = [];
	for (const attempt of attemptId === undefined ? Object.values(snapshot.attempts) : [snapshot.attempts[attemptId]]) {
		const origin = attempt?.dispatch.objectiveRouteOrigin;
		if (
			attempt?.firstStartedAt &&
			origin?.sessionId === sessionId &&
			attempt.dispatch.taskId === attempt.taskId &&
			snapshot.tasks[attempt.taskId]?.task.objectiveId === origin.objectiveId
		)
			starts.push(origin);
	}
	if (starts.length) getLedger()?.recoverWorkerRouteStarts(sessionId, starts);
}

const archiveRoutes = new WeakMap<RetentionArchiveFile, readonly ObjectiveRouteOrigin[]>();
const restoredArchives = new WeakMap<RetentionArchiveFile, WeakSet<DecisionLedgerStore>>();

function archivedRouteStarts(archive: RetentionArchiveFile): readonly ObjectiveRouteOrigin[] {
	const cached = archiveRoutes.get(archive);
	if (cached) return cached;
	const starts: ObjectiveRouteOrigin[] = [];
	for (const [id, attempt] of Object.entries(archive.records.attempts)) {
		if (
			!isPlainRecord(attempt) ||
			attempt.attemptId !== id ||
			typeof attempt.taskId !== "string" ||
			!attempt.firstStartedAt
		)
			continue;
		const dispatch = attempt.dispatch;
		if (!isPlainRecord(dispatch) || dispatch.taskId !== attempt.taskId || !dispatch.objectiveRouteOrigin) continue;
		let origin: ObjectiveRouteOrigin | undefined;
		try {
			isoDate(attempt.firstStartedAt, "archived worker route start");
			origin = objectiveRouteOriginFields(dispatch.objectiveRouteOrigin).objectiveRouteOrigin;
		} catch {
			harnessLog.warn("delegation", "a committed archive contains an invalid worker route witness", {
				archive: archive.digest,
				attemptId: id,
			});
			continue;
		}
		const task = archive.records.tasks[attempt.taskId];
		if (
			!origin ||
			origin.sessionId !== archive.sessionId ||
			!isPlainRecord(task) ||
			!Array.isArray(task.attemptIds) ||
			!task.attemptIds.includes(id) ||
			!isPlainRecord(task.task) ||
			task.task.taskId !== attempt.taskId ||
			task.task.objectiveId !== origin.objectiveId
		)
			continue;
		starts.push(origin);
	}
	archiveRoutes.set(archive, starts);
	return starts;
}

/** A pruned session task carries its attempts in the same digest-verified archive, even if its objective remains live. */
export function reconcileArchivedWorkerRouteStarts(
	sessionId: string,
	eventStoreRoot: string,
	committedIds: readonly string[] | undefined,
	getLedger: () => DecisionLedgerStore | undefined,
): void {
	if (!committedIds?.length) return;
	const committed = new Set(committedIds);
	for (const archive of readRetentionArchives(retentionArchiveDir(eventStoreRoot)).archives) {
		if (archive.sessionId !== sessionId || !archiveIsCommitted(archive, committed)) continue;
		const starts = archivedRouteStarts(archive);
		if (!starts.length) continue;
		const ledger = getLedger();
		if (!ledger) return;
		const restored = restoredArchives.get(archive) ?? new WeakSet<DecisionLedgerStore>();
		if (restored.has(ledger)) continue;
		ledger.recoverWorkerRouteStarts(sessionId, starts);
		restored.add(ledger);
		restoredArchives.set(archive, restored);
	}
}

/** Install the listener before replay so a newly recovered lease cannot slip past the initial scan. */
export function subscribeWorkerRouteStarts(
	store: Pick<OrchestrationEventStore, "sessionId" | "rootDir" | "subscribe">,
	runtime: { getTaskRuntimeSnapshot(): TaskRuntimeProjection },
	host: { getSessionId(): string; systemOne: { getDecisionLedger(): DecisionLedgerStore | undefined } },
	changed: () => void,
): () => void {
	const reconcile = (attemptId?: string) => {
		if (store.sessionId !== host.getSessionId()) return;
		const snapshot = runtime.getTaskRuntimeSnapshot();
		const ledger = () => host.systemOne.getDecisionLedger();
		reconcileWorkerRouteStarts(store.sessionId, snapshot, ledger, attemptId);
		if (attemptId === undefined)
			reconcileArchivedWorkerRouteStarts(store.sessionId, store.rootDir, snapshot.retentionArchiveIds, ledger);
	};
	const unsubscribe = store.subscribe((event) => {
		changed();
		if (event.type === "attempt.started") reconcile(event.aggregateId);
		else if (event.type === "retention.pruned") reconcile();
	});
	try {
		reconcile();
	} catch (error) {
		harnessLog.warn("delegation", "worker route starts could not be reconciled on reopen", () => ({
			error: error instanceof Error ? error.message : String(error),
		}));
	}
	return unsubscribe;
}
