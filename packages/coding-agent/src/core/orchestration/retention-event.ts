/**
 * The `retention.pruned` event: its payload shape, strict decoding, the append input the runtime commits, the
 * idempotency keys it retires, and the stale-plan error. Pure; it writes nothing and reads no store.
 */

import {
	type AppendOrchestrationEventInput,
	MAX_ORCHESTRATION_ATTEMPTS,
	MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
	MAX_ORCHESTRATION_OBJECTIVES,
	MAX_ORCHESTRATION_TASKS,
	type OrchestrationEvent,
	toJsonObject,
} from "./contracts.ts";
import { exactRecord } from "./task-runtime-projection.ts";
import { DurableTaskRuntimeError } from "./task-runtime-state.ts";

/** Bounds every id list of one prune: the record caps, so a closed objective with many attempts still fits. */
export const MAX_RETENTION_PRUNE_RECORDS = Math.max(
	MAX_ORCHESTRATION_OBJECTIVES,
	MAX_ORCHESTRATION_TASKS,
	MAX_ORCHESTRATION_ATTEMPTS,
);

/** The aggregate every retention event names; the prune is store-wide, so it has no record of its own. */
export const RETENTION_AGGREGATE_ID = "retention";

/** The id an archive is named by: its content digest, so the same selection always names the same file. */
export function retentionArchiveId(digest: string): string {
	return `ar-${digest.slice(0, 16)}`;
}
const RETENTION_PRUNED_FIELDS = [
	"v",
	"archiveId",
	"archiveDigest",
	"cutoff",
	"objectiveIds",
	"taskIds",
	"attemptIds",
	"planIds",
	"dependentsDigest",
] as const;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface RetentionPrunedPayload {
	readonly v: 1;
	readonly archiveId: string; // "ar-" + first 16 hex of archiveDigest
	readonly archiveDigest: string; // sha256 hex of the archive's canonical content
	readonly cutoff: string; // ISO; every released unit's last activity is <= cutoff; cutoff <= event.occurredAt
	readonly objectiveIds: readonly string[]; // closed non-session objectives released whole
	readonly taskIds: readonly string[]; // every released task (whole objectives' tasks, finished session tasks, session plan groups' tasks)
	readonly attemptIds: readonly string[]; // every released attempt
	readonly planIds: readonly string[]; // plans of released objectives, and closed session plans released with every task they name
	readonly dependentsDigest: string; // sha256 hex of canonical JSON of the derived dependents
}

/** A plan was made at an ordinal that another writer has since advanced past; the pass re-plans at the next idle. */
export class RetentionPlanStaleError extends DurableTaskRuntimeError {
	constructor(plannedAtOrdinal: number, currentOrdinal: number) {
		super(`Retention plan made at ordinal ${plannedAtOrdinal} is stale; the store is at ordinal ${currentOrdinal}.`);
		this.name = "RetentionPlanStaleError";
	}
}

/**
 * Payload paths that name the record an event creates or changes (task-runtime.ts commit sites, plan and outcome
 * payloads). Every record an event names here is either the released record itself or a dependent deleted with it
 * (retention-eligibility.ts), so retiring the event's key is safe. A path that names a reference rather than the
 * changed record (for example a plan's `subgraphOf.parentPlanId`) is never listed.
 */
const RECORD_ID_PATHS = [
	["objectiveId"],
	["taskId"],
	["attemptId"],
	["planId"],
	["task", "taskId"], // task.created, task.attempt_prepared
	["approval", "objectiveId"], // approval.requested
	["approval", "taskId"],
	["approval", "attemptId"],
	["checkpoint", "attemptId"], // attempt.checkpointed
	["result", "attemptId"], // attempt.finished
	["lease", "attemptId"], // attempt.leased
	["outcome", "taskId"], // task.outcome_recorded, plan.join_settled
	["outcome", "objectiveId"],
	["record", "planId"], // plan.recorded
	["record", "objectiveId"],
	["record", "taskId"], // task.escalation_scheduled: the rung's task and attempt
	["record", "attemptId"],
	["record", "supersedesTaskId"],
	["subjectAttemptId"], // task.verification_finished
	["verifierTaskId"],
	["verifierAttemptId"],
] as const;

function canonicalRetentionId(value: unknown, label: string): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_ORCHESTRATION_IDENTIFIER_LENGTH ||
		value.trim() !== value
	) {
		throw new DurableTaskRuntimeError(`${label} must be a canonical identifier.`);
	}
	return value;
}

/** A list of canonical ids, no longer than `limit` when one is given, in which no id repeats. */
function canonicalIdList(value: unknown, label: string, limit?: number): readonly string[] {
	if (!Array.isArray(value)) throw new DurableTaskRuntimeError(`${label} must be a list.`);
	if (limit !== undefined && value.length > limit) {
		throw new DurableTaskRuntimeError(`${label} exceeds ${limit} records.`);
	}
	const ids = value.map((id, index) => canonicalRetentionId(id, `${label}[${index}]`));
	if (new Set(ids).size !== ids.length) throw new DurableTaskRuntimeError(`${label} repeats an id.`);
	return ids;
}

function uniqueIdList(value: unknown, label: string): readonly string[] {
	return canonicalIdList(value, label, MAX_RETENTION_PRUNE_RECORDS);
}

function sha256Hex(value: unknown, label: string): string {
	if (typeof value !== "string" || !SHA256_HEX.test(value)) {
		throw new DurableTaskRuntimeError(`${label} must be 64 lowercase hex digits.`);
	}
	return value;
}

function canonicalIsoInstant(value: unknown, label: string): string {
	if (typeof value !== "string") throw new DurableTaskRuntimeError(`${label} must be an ISO timestamp.`);
	const epochMs = Date.parse(value);
	if (!Number.isFinite(epochMs) || new Date(epochMs).toISOString() !== value) {
		throw new DurableTaskRuntimeError(`${label} must be a canonical ISO timestamp.`);
	}
	return value;
}

/**
 * Decodes the projection's committed archive ids. The list has one id per prune that reached the projection, so it is not
 * capped by the record bounds: a cap would make an old committed archive look like an orphan. Its size counts against the
 * projection's byte budget instead.
 */
export function retentionArchiveIdsFromValue(value: unknown, label: string): readonly string[] {
	return canonicalIdList(value, label);
}

/** The snapshot's optional committed-archive field, decoded: absent when the snapshot holds no prune. */
export function retentionArchiveIdsField(snapshot: Readonly<Record<string, unknown>>): {
	readonly retentionArchiveIds?: readonly string[];
} {
	if (snapshot.retentionArchiveIds === undefined) return {};
	const label = "orchestration projection snapshot.retentionArchiveIds";
	return { retentionArchiveIds: retentionArchiveIdsFromValue(snapshot.retentionArchiveIds, label) };
}

/** Decodes a `retention.pruned` payload with the same strictness the projection decoder applies to its records. */
export function retentionPrunedPayloadFromValue(value: unknown): RetentionPrunedPayload {
	const input = exactRecord(value, "retention.pruned", [...RETENTION_PRUNED_FIELDS]);
	if (input.v !== 1) throw new DurableTaskRuntimeError("retention.pruned.v is invalid.");
	return {
		v: 1,
		archiveId: canonicalRetentionId(input.archiveId, "retention.pruned.archiveId"),
		archiveDigest: sha256Hex(input.archiveDigest, "retention.pruned.archiveDigest"),
		cutoff: canonicalIsoInstant(input.cutoff, "retention.pruned.cutoff"),
		objectiveIds: uniqueIdList(input.objectiveIds, "retention.pruned.objectiveIds"),
		taskIds: uniqueIdList(input.taskIds, "retention.pruned.taskIds"),
		attemptIds: uniqueIdList(input.attemptIds, "retention.pruned.attemptIds"),
		planIds: uniqueIdList(input.planIds, "retention.pruned.planIds"),
		dependentsDigest: sha256Hex(input.dependentsDigest, "retention.pruned.dependentsDigest"),
	};
}

/** The append the runtime commits for one planned prune. The key is the archive, so a replayed prune is idempotent. */
export function retentionPruneEventInput(payload: RetentionPrunedPayload): AppendOrchestrationEventInput {
	return {
		type: "retention.pruned",
		aggregateId: RETENTION_AGGREGATE_ID,
		actor: "runtime",
		idempotencyKey: `retention:${payload.archiveId}`,
		payload: toJsonObject(payload),
	};
}

/** The ids a prune deleted. Only a `retention.pruned` event retires anything. */
export function retiredRecordIds(event: OrchestrationEvent): ReadonlySet<string> {
	if (event.type !== "retention.pruned") return new Set();
	const payload = retentionPrunedPayloadFromValue(event.payload);
	return new Set([...payload.objectiveIds, ...payload.taskIds, ...payload.attemptIds, ...payload.planIds]);
}

/**
 * True when the event's aggregate or a record-naming payload path is one of `ids`. The match is exact string equality:
 * a false match would retire a retained record's key and let a retried usage event apply twice.
 */
export function eventNamesRecord(event: OrchestrationEvent, ids: ReadonlySet<string>): boolean {
	if (ids.has(event.aggregateId)) return true;
	for (const path of RECORD_ID_PATHS) {
		let current: unknown = event.payload;
		for (const segment of path) {
			if (typeof current !== "object" || current === null) {
				current = undefined;
				break;
			}
			current = (current as Record<string, unknown>)[segment];
		}
		if (typeof current === "string" && ids.has(current)) return true;
	}
	return false;
}
