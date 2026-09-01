import {
	MAX_ORCHESTRATION_AGENT_BINDINGS,
	MAX_ORCHESTRATION_APPROVALS,
	MAX_ORCHESTRATION_ATTEMPTS,
	MAX_ORCHESTRATION_CHECKPOINT_SUMMARY_LENGTH,
	MAX_ORCHESTRATION_CHECKPOINTS,
	MAX_ORCHESTRATION_COLLECTION_LENGTH,
	MAX_ORCHESTRATION_EVIDENCE,
	MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
	MAX_ORCHESTRATION_NOTIFICATIONS,
	MAX_ORCHESTRATION_OBJECTIVE_EVIDENCE,
	MAX_ORCHESTRATION_OBJECTIVES,
	MAX_ORCHESTRATION_PROJECTION_BYTES,
	MAX_ORCHESTRATION_RETAINED_RECORD_BYTES,
	MAX_ORCHESTRATION_TASKS,
} from "./contracts.ts";
import {
	DurableTaskRuntimeError,
	type ObjectiveRuntimeState,
	type OrchestrationProjectionCapacity,
	type TaskRuntimeProjection,
} from "./task-runtime-state.ts";

export function emptyProjection(): TaskRuntimeProjection {
	return {
		lastOrdinal: 0,
		agents: {},
		objectives: {},
		tasks: {},
		attempts: {},
		checkpoints: {},
		approvals: {},
		notifications: {},
	};
}

export const PROJECTION_RECORD_FIELDS = [
	"agents",
	"objectives",
	"tasks",
	"attempts",
	"checkpoints",
	"approvals",
	"notifications",
] as const;

export type ProjectionRecordField = (typeof PROJECTION_RECORD_FIELDS)[number];

const projectionSerializedByteCache = new WeakMap<TaskRuntimeProjection, number>();
const retainedRecordSerializedByteCache = new WeakMap<object, number>();

function serializedJsonBytes(value: unknown, label: string): number {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(value);
	} catch (error) {
		throw new DurableTaskRuntimeError(
			`${label} is not serializable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (serialized === undefined) throw new DurableTaskRuntimeError(`${label} is not serializable.`);
	return Buffer.byteLength(serialized, "utf8");
}

function retainedRecordSerializedBytes(value: unknown, label: string): number {
	if (!value || typeof value !== "object") {
		throw new DurableTaskRuntimeError(`${label} retained record is invalid.`);
	}
	const cached = retainedRecordSerializedByteCache.get(value);
	if (cached !== undefined) return cached;
	const bytes = serializedJsonBytes(value, label);
	if (bytes > MAX_ORCHESTRATION_RETAINED_RECORD_BYTES) {
		throw new DurableTaskRuntimeError(
			`${label} retained record exceeds its ${MAX_ORCHESTRATION_RETAINED_RECORD_BYTES}-byte limit.`,
		);
	}
	retainedRecordSerializedByteCache.set(value, bytes);
	return bytes;
}

function retainedRecordKeyBytes(key: string, label: string): number {
	if (!key || key.length > MAX_ORCHESTRATION_IDENTIFIER_LENGTH) {
		throw new DurableTaskRuntimeError(`${label} retained record key exceeds its identifier bound.`);
	}
	return serializedJsonBytes(key, `${label} retained record key`);
}

function emptyProjectionSerializedBytes(lastOrdinal: number): number {
	return serializedJsonBytes(
		{
			lastOrdinal,
			agents: {},
			objectives: {},
			tasks: {},
			attempts: {},
			checkpoints: {},
			approvals: {},
			notifications: {},
		},
		"Orchestration projection",
	);
}

/** Compute once for snapshots/external projections; reducer-produced projections carry a delta cache. */
export function projectionSerializedBytes(projection: TaskRuntimeProjection): number {
	const cached = projectionSerializedByteCache.get(projection);
	if (cached !== undefined) return cached;
	const expectedFields = new Set<string>(["lastOrdinal", ...PROJECTION_RECORD_FIELDS]);
	const unsupported = Object.keys(projection).find((field) => !expectedFields.has(field));
	if (unsupported) throw new DurableTaskRuntimeError(`Orchestration projection.${unsupported} is unsupported.`);
	let bytes = emptyProjectionSerializedBytes(projection.lastOrdinal);
	for (const field of PROJECTION_RECORD_FIELDS) {
		let entryCount = 0;
		for (const [key, value] of Object.entries(projection[field])) {
			bytes +=
				(entryCount > 0 ? 1 : 0) +
				retainedRecordKeyBytes(key, `Orchestration projection.${field}.${key}`) +
				1 +
				retainedRecordSerializedBytes(value, `Orchestration projection.${field}.${key}`);
			entryCount += 1;
			if (bytes > MAX_ORCHESTRATION_PROJECTION_BYTES) {
				throw new DurableTaskRuntimeError(
					`Orchestration projection exceeds its ${MAX_ORCHESTRATION_PROJECTION_BYTES}-byte limit.`,
				);
			}
		}
	}
	projectionSerializedByteCache.set(projection, bytes);
	return bytes;
}

export function assertProjectionRecordReplacementWithinLimits(
	projection: TaskRuntimeProjection,
	field: ProjectionRecordField,
	key: string,
	value: object,
): void {
	const label = `Orchestration projection.${field}.${key}`;
	const current = projection[field][key];
	const nextRecordBytes = retainedRecordSerializedBytes(value, label);
	const currentRecordBytes = current ? retainedRecordSerializedBytes(current, label) : 0;
	const insertionBytes = current
		? 0
		: retainedRecordKeyBytes(key, label) + 1 + (countRecordEntries(projection[field]) > 0 ? 1 : 0);
	if (
		projectionSerializedBytes(projection) + insertionBytes + nextRecordBytes - currentRecordBytes >
		MAX_ORCHESTRATION_PROJECTION_BYTES
	) {
		throw new DurableTaskRuntimeError(
			`Orchestration projection exceeds its ${MAX_ORCHESTRATION_PROJECTION_BYTES}-byte limit.`,
		);
	}
}

export class ProjectionByteTracker {
	private bytes: number;
	private readonly entryCounts = new Map<ProjectionRecordField, number>();
	private readonly source: TaskRuntimeProjection;

	constructor(source: TaskRuntimeProjection) {
		this.source = source;
		this.bytes = projectionSerializedBytes(source);
	}

	track<Value>(field: ProjectionRecordField, target: Record<string, Value>): Record<string, Value> {
		this.entryCounts.set(field, countRecordEntries(target));
		return new Proxy(target, {
			set: (record, property, value) => {
				if (typeof property !== "string") {
					throw new DurableTaskRuntimeError(`Orchestration projection.${field} record key is invalid.`);
				}
				const label = `Orchestration projection.${field}.${property}`;
				const exists = Object.hasOwn(record, property);
				const nextRecordBytes = retainedRecordSerializedBytes(value, label);
				const previousRecordBytes = exists ? retainedRecordSerializedBytes(record[property], label) : 0;
				const keyAndSeparatorBytes = exists
					? 0
					: retainedRecordKeyBytes(property, label) + 1 + ((this.entryCounts.get(field) ?? 0) > 0 ? 1 : 0);
				const nextBytes = this.bytes + keyAndSeparatorBytes + nextRecordBytes - previousRecordBytes;
				if (nextBytes > MAX_ORCHESTRATION_PROJECTION_BYTES) {
					throw new DurableTaskRuntimeError(
						`Orchestration projection exceeds its ${MAX_ORCHESTRATION_PROJECTION_BYTES}-byte limit.`,
					);
				}
				Reflect.set(record, property, value);
				this.bytes = nextBytes;
				if (!exists) this.entryCounts.set(field, (this.entryCounts.get(field) ?? 0) + 1);
				return true;
			},
		});
	}

	finish(nextOrdinal: number): number {
		this.bytes +=
			serializedJsonBytes(nextOrdinal, "Orchestration projection ordinal") -
			serializedJsonBytes(this.source.lastOrdinal, "Orchestration projection ordinal");
		if (this.bytes > MAX_ORCHESTRATION_PROJECTION_BYTES) {
			throw new DurableTaskRuntimeError(
				`Orchestration projection exceeds its ${MAX_ORCHESTRATION_PROJECTION_BYTES}-byte limit.`,
			);
		}
		return this.bytes;
	}
}

export function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new DurableTaskRuntimeError(`${label} is not an object.`);
	}
	return value as Record<string, unknown>;
}

export function exactRecord(value: unknown, label: string, allowedFields: readonly string[]): Record<string, unknown> {
	const parsed = record(value, label);
	const unsupported = Object.keys(parsed).find((field) => !allowedFields.includes(field));
	if (unsupported) throw new DurableTaskRuntimeError(`${label}.${unsupported} is unsupported.`);
	return parsed;
}

export function assertRecordWithinLimit(values: Readonly<Record<string, unknown>>, limit: number, label: string): void {
	let count = 0;
	for (const key in values) {
		if (!Object.hasOwn(values, key)) continue;
		count += 1;
		if (count > limit) {
			throw new DurableTaskRuntimeError(`Orchestration ${label} limit (${limit}) exceeded.`);
		}
	}
}

export function assertRecordHasCapacity(values: Readonly<Record<string, unknown>>, limit: number, label: string): void {
	let count = 0;
	for (const key in values) {
		if (!Object.hasOwn(values, key)) continue;
		count += 1;
		if (count >= limit) {
			throw new DurableTaskRuntimeError(`Orchestration ${label} limit (${limit}) reached.`);
		}
	}
}

export function assertIdentifierListHasCapacity(values: readonly string[], limit: number, label: string): void {
	if (values.length >= limit) {
		throw new DurableTaskRuntimeError(`Orchestration ${label} limit (${limit}) reached.`);
	}
}

export function assertObjectiveEvidenceHasCapacity(
	objectives: Readonly<Record<string, ObjectiveRuntimeState>>,
	objective: ObjectiveRuntimeState,
): void {
	if (objective.evidence.length >= MAX_ORCHESTRATION_OBJECTIVE_EVIDENCE) {
		throw new DurableTaskRuntimeError(
			`Orchestration objective evidence limit (${MAX_ORCHESTRATION_OBJECTIVE_EVIDENCE}) reached.`,
		);
	}
	let count = 0;
	for (const objectiveId in objectives) {
		if (!Object.hasOwn(objectives, objectiveId)) continue;
		count += objectives[objectiveId]?.evidence.length ?? 0;
		if (count >= MAX_ORCHESTRATION_EVIDENCE) {
			throw new DurableTaskRuntimeError(`Orchestration evidence limit (${MAX_ORCHESTRATION_EVIDENCE}) reached.`);
		}
	}
}

export function assertBoundedIdentifierList(
	value: unknown,
	limit: number,
	label: string,
): asserts value is readonly string[] {
	if (!Array.isArray(value) || value.length > limit) {
		throw new DurableTaskRuntimeError(`${label} exceeds its retained collection limit (${limit}).`);
	}
	const identities = new Set<string>();
	for (const entry of value) {
		if (
			typeof entry !== "string" ||
			entry.length === 0 ||
			entry.length > MAX_ORCHESTRATION_IDENTIFIER_LENGTH ||
			identities.has(entry)
		) {
			throw new DurableTaskRuntimeError(`${label} must contain unique bounded identifiers.`);
		}
		identities.add(entry);
	}
}

export function retainedIdentifierArray(value: unknown, limit: number, label: string): string[] {
	assertBoundedIdentifierList(value, limit, label);
	return [...value];
}

export function assertRetainedProjectionNestedCollections(
	objectives: Readonly<Record<string, unknown>>,
	tasks: Readonly<Record<string, unknown>>,
	attempts: Readonly<Record<string, unknown>>,
	checkpoints: Readonly<Record<string, unknown>>,
	label: string,
): number {
	let evidenceCount = 0;
	for (const objectiveId in objectives) {
		if (!Object.hasOwn(objectives, objectiveId)) continue;
		const objective = record(objectives[objectiveId], `${label}.objectives.${objectiveId}`);
		assertBoundedIdentifierList(
			objective.taskIds,
			MAX_ORCHESTRATION_TASKS,
			`${label}.objectives.${objectiveId}.taskIds`,
		);
		if (!Array.isArray(objective.evidence)) {
			throw new DurableTaskRuntimeError(`${label}.objectives.${objectiveId}.evidence must be an array.`);
		}
		if (objective.evidence.length > MAX_ORCHESTRATION_OBJECTIVE_EVIDENCE) {
			throw new DurableTaskRuntimeError(
				`Orchestration objective evidence limit (${MAX_ORCHESTRATION_OBJECTIVE_EVIDENCE}) exceeded.`,
			);
		}
		evidenceCount += objective.evidence.length;
		if (evidenceCount > MAX_ORCHESTRATION_EVIDENCE) {
			throw new DurableTaskRuntimeError(`Orchestration evidence limit (${MAX_ORCHESTRATION_EVIDENCE}) exceeded.`);
		}
	}
	for (const taskId in tasks) {
		if (!Object.hasOwn(tasks, taskId)) continue;
		const task = record(tasks[taskId], `${label}.tasks.${taskId}`);
		assertBoundedIdentifierList(task.attemptIds, MAX_ORCHESTRATION_ATTEMPTS, `${label}.tasks.${taskId}.attemptIds`);
	}
	for (const attemptId in attempts) {
		if (!Object.hasOwn(attempts, attemptId)) continue;
		const attempt = record(attempts[attemptId], `${label}.attempts.${attemptId}`);
		assertBoundedIdentifierList(
			attempt.checkpointIds,
			MAX_ORCHESTRATION_CHECKPOINTS,
			`${label}.attempts.${attemptId}.checkpointIds`,
		);
	}
	for (const checkpointId in checkpoints) {
		if (!Object.hasOwn(checkpoints, checkpointId)) continue;
		const checkpoint = record(checkpoints[checkpointId], `${label}.checkpoints.${checkpointId}`);
		const summary = checkpoint.summary;
		if (typeof summary !== "string" || summary.length === 0) {
			throw new DurableTaskRuntimeError(`${label}.checkpoints.${checkpointId}.summary is required.`);
		}
		if (summary.length > MAX_ORCHESTRATION_CHECKPOINT_SUMMARY_LENGTH) {
			throw new DurableTaskRuntimeError(
				`${label}.checkpoints.${checkpointId}.summary exceeds its durable size bound.`,
			);
		}
		assertBoundedIdentifierList(
			checkpoint.artifactIds,
			MAX_ORCHESTRATION_COLLECTION_LENGTH,
			`${label}.checkpoints.${checkpointId}.artifactIds`,
		);
		assertBoundedIdentifierList(
			checkpoint.evidenceIds,
			MAX_ORCHESTRATION_COLLECTION_LENGTH,
			`${label}.checkpoints.${checkpointId}.evidenceIds`,
		);
	}
	return evidenceCount;
}

export function assertProjectionWithinLimits(projection: TaskRuntimeProjection): void {
	assertRecordWithinLimit(projection.agents, MAX_ORCHESTRATION_AGENT_BINDINGS, "agent binding");
	assertRecordWithinLimit(projection.objectives, MAX_ORCHESTRATION_OBJECTIVES, "objective");
	assertRecordWithinLimit(projection.tasks, MAX_ORCHESTRATION_TASKS, "task");
	assertRecordWithinLimit(projection.attempts, MAX_ORCHESTRATION_ATTEMPTS, "attempt");
	assertRecordWithinLimit(projection.checkpoints, MAX_ORCHESTRATION_CHECKPOINTS, "checkpoint");
	assertRecordWithinLimit(projection.approvals, MAX_ORCHESTRATION_APPROVALS, "approval");
	assertRecordWithinLimit(projection.notifications, MAX_ORCHESTRATION_NOTIFICATIONS, "notification");
	assertRetainedProjectionNestedCollections(
		projection.objectives,
		projection.tasks,
		projection.attempts,
		projection.checkpoints,
		"orchestration projection",
	);
	projectionSerializedBytes(projection);
}

function countRecordEntries(values: Readonly<Record<string, unknown>>): number {
	let count = 0;
	for (const key in values) {
		if (Object.hasOwn(values, key)) count += 1;
	}
	return count;
}

export function projectionCapacity(projection: TaskRuntimeProjection): OrchestrationProjectionCapacity {
	const evidence = assertRetainedProjectionNestedCollections(
		projection.objectives,
		projection.tasks,
		projection.attempts,
		projection.checkpoints,
		"orchestration projection",
	);
	const counts = {
		agents: countRecordEntries(projection.agents),
		objectives: countRecordEntries(projection.objectives),
		tasks: countRecordEntries(projection.tasks),
		attempts: countRecordEntries(projection.attempts),
		checkpoints: countRecordEntries(projection.checkpoints),
		approvals: countRecordEntries(projection.approvals),
		notifications: countRecordEntries(projection.notifications),
		evidence,
	};
	const limits = {
		agents: MAX_ORCHESTRATION_AGENT_BINDINGS,
		objectives: MAX_ORCHESTRATION_OBJECTIVES,
		tasks: MAX_ORCHESTRATION_TASKS,
		attempts: MAX_ORCHESTRATION_ATTEMPTS,
		checkpoints: MAX_ORCHESTRATION_CHECKPOINTS,
		approvals: MAX_ORCHESTRATION_APPROVALS,
		notifications: MAX_ORCHESTRATION_NOTIFICATIONS,
		evidence: MAX_ORCHESTRATION_EVIDENCE,
	};
	return {
		counts,
		limits,
		headroom: {
			agents: limits.agents - counts.agents,
			objectives: limits.objectives - counts.objectives,
			tasks: limits.tasks - counts.tasks,
			attempts: limits.attempts - counts.attempts,
			checkpoints: limits.checkpoints - counts.checkpoints,
			approvals: limits.approvals - counts.approvals,
			notifications: limits.notifications - counts.notifications,
			evidence: limits.evidence - counts.evidence,
		},
	};
}

export function requestedProjectionSlots(value: number | undefined, label: string): number {
	const slots = value ?? 0;
	if (!Number.isSafeInteger(slots) || slots < 0) {
		throw new DurableTaskRuntimeError(`${label} projection slots must be a non-negative safe integer.`);
	}
	return slots;
}

export function cacheProjectionSerializedBytes(projection: TaskRuntimeProjection, bytes: number): void {
	projectionSerializedByteCache.set(projection, bytes);
}
