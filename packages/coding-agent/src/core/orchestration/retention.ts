/**
 * Retention of closed orchestration work, as the store sees it: the lifetime headroom check that refuses new records,
 * the plain-words texts those refusals give, and the reducer case that applies a `retention.pruned` event. The prune
 * itself is planned in retention-pass.ts and retention-eligibility.ts and committed by the runtime; this module applies it.
 *
 * Checks, by where they run:
 * - Structural (`assertRetentionPruneWellFormed`, run on every apply, live or replayed): the archive id names the digest,
 *   the cutoff is not after the event, the archive is not committed twice, every listed id exists, the lists are closed
 *   over one another, the agent turn prefix holds, and the dependents digest matches. Replay of a logged v1 prune runs
 *   these and nothing else, so a later hold or unit rule cannot refuse a prune the planner already made.
 * - Live rules (`assertRetentionPruneAllowed`, run by the runtime's `commitRetentionPrune` on the planned state, before the
 *   append): the newer-build plan refusal, the exact unit membership of the lists, the age of each listed unit, every
 *   projection hold, and the reference check. External holds (delegation state) are judged by the pass before it plans.
 * - Backstop (the snapshot decoder, `projectionFromSnapshot`, at the end of the apply): a result that leaves a dangling
 *   reference throws, whichever rule set wrote the prune.
 *
 * Version: `retention.pruned` payloads carry `v: 1 | 2`. Version-dependent derivations branch on `payload.v`, so a
 * logged v1 prune keeps its v1 meaning and digest while new prunes emit v2.
 */

import { type OrchestrationEvent, toJsonObject } from "./contracts.ts";
import {
	assertRetentionPruneWellFormed,
	closedObjectiveHolds,
	deriveCarry,
	deriveDependents,
	type ExternalHold,
	RETENTION_HOLD_ORDER,
	type RetentionHold,
	retentionUnits,
} from "./retention-eligibility.ts";
import { RETENTION_AGGREGATE_ID, retentionPrunedPayloadFromValue } from "./retention-event.ts";
import { projectionFromSnapshot } from "./task-runtime-codecs.ts";
import { requestedProjectionSlots } from "./task-runtime-projection.ts";
import {
	DurableTaskRuntimeError,
	type OrchestrationProjectionCapacity,
	type OrchestrationProjectionHeadroomRequest,
	type TaskRuntimeProjection,
} from "./task-runtime-state.ts";

const SESSION_OBJECTIVE_PREFIX = "session:";
const RELEASE_SENTENCE =
	"Closed work with nothing in this store holding it is released at the next idle moment: after orchestration.retention.closedObjectiveDays (default 14 days), or at once while the store is nearly full (0 keeps it for the session's life).";

/** Why a closed objective with no projection hold stays outside the projection: an external hold, or a fact the pass reads. */
export type ExternalKeep = ExternalHold | "legacy_window" | "agent_message_pending";

/** Closed objectives counted per external keep. A missing kind counts zero. */
export type ExternalKeepCounts = Readonly<Partial<Record<ExternalKeep, number>>>;

/** The words each external keep reads as, in the store-full notice and in the refusal texts. */
const EXTERNAL_KEEP_WORDS: Record<ExternalKeep, string> = {
	outcome_undelivered: "with an outcome not yet delivered to its parent",
	delegated_message_pending: "with a delegated message still pending",
	follower_open: "with a follower still open",
	current_goal: "that is the current goal",
	delegation_open_parent: "under an open parent delegation",
	legacy_window: "inside an open delegation's window",
	agent_message_pending: "with a message queued for one of its agents",
};

/**
 * The sentence that counts the closed objectives kept outside the store, in the words the store-full notice uses. Empty
 * when no objective is kept outside the store.
 */
export function keptOutsideSentence(keptOutside: ExternalKeepCounts): string {
	const parts: string[] = [];
	let total = 0;
	for (const kind of Object.keys(EXTERNAL_KEEP_WORDS) as ExternalKeep[]) {
		const count = keptOutside[kind] ?? 0;
		if (count === 0) continue;
		total += count;
		parts.push(`${count} ${EXTERNAL_KEEP_WORDS[kind]}`);
	}
	if (total === 0) return "";
	return `Of the closed objectives counted above with no hold, ${total} ${total === 1 ? "is" : "are"} kept by delegation state outside the store (${parts.join(", ")}); ${total === 1 ? "it is" : "they are"} not released at idle until that state ends.`;
}

/** The retained record kinds with a lifetime bound on the hot projection, in the order a shortage is reported. */
const LIFETIME_BOUNDED_RECORDS = [
	{ field: "agents", label: "Agent binding", noun: "agent bindings" },
	{ field: "tasks", label: "Task", noun: "tasks" },
	{ field: "attempts", label: "Attempt", noun: "attempts" },
	{ field: "objectives", label: "Objective", noun: "objectives" },
	{ field: "checkpoints", label: "Checkpoint", noun: "checkpoints" },
	{ field: "approvals", label: "Approval", noun: "approvals" },
	{ field: "notifications", label: "Notification", noun: "notifications" },
	{ field: "evidence", label: "Evidence", noun: "evidence entries" },
] as const;

type LifetimeBoundedRecord = (typeof LIFETIME_BOUNDED_RECORDS)[number];

/** Why a closed objective stays, in the words the refusal uses. Every projection hold has one. */
const HOLD_WORDS: Record<RetentionHold, string> = {
	unfinished_task: "with an unfinished or unverified task",
	live_attempt: "with a turn still running",
	pending_notice: "with a notice not yet delivered",
	pending_approval: "with an approval pending",
	open_plan: "under an open plan",
	receipt_outbox: "with a result or charge not yet received by the parent",
	awaiting_parent: "whose last result the parent has not yet answered",
	host_event_custody: "with host events still in flight",
	resume_basis: "that an active agent resumes from",
	managed_lane: "whose managed worker is not retired",
	tree_live: "whose worker tree is still running",
	referenced: "that retained work depends on",
};

export type ObjectiveRetention =
	| { readonly kind: "open" }
	| { readonly kind: "session" }
	| { readonly kind: "held"; readonly hold: RetentionHold }
	| { readonly kind: "free" };

/** Every objective of the projection, classified by the projection facts that hold it. */
export function classifyObjectives(state: TaskRuntimeProjection): Map<string, ObjectiveRetention> {
	const holds = closedObjectiveHolds(state);
	const result = new Map<string, ObjectiveRetention>();
	for (const [objectiveId, runtime] of Object.entries(state.objectives)) {
		const status = runtime.objective.status;
		if (status === "active" || status === "paused") result.set(objectiveId, { kind: "open" });
		else if (objectiveId.startsWith(SESSION_OBJECTIVE_PREFIX)) result.set(objectiveId, { kind: "session" });
		else {
			const hold = holds.get(objectiveId);
			result.set(objectiveId, hold ? { kind: "held", hold } : { kind: "free" });
		}
	}
	return result;
}

/** The first sentence of the objective refusal: how many objectives the store keeps and what each group is. */
function objectiveSummary(state: TaskRuntimeProjection): string {
	const classes = classifyObjectives(state);
	const heldCounts = new Map<RetentionHold, number>();
	let open = 0;
	let session = 0;
	let free = 0;
	for (const retention of classes.values()) {
		if (retention.kind === "open") open += 1;
		else if (retention.kind === "session") session += 1;
		else if (retention.kind === "free") free += 1;
		else heldCounts.set(retention.hold, (heldCounts.get(retention.hold) ?? 0) + 1);
	}
	const held = [...heldCounts.values()].reduce((total, count) => total + count, 0);
	const heldParts = RETENTION_HOLD_ORDER.filter((hold) => (heldCounts.get(hold) ?? 0) > 0).map(
		(hold) => `${heldCounts.get(hold)} ${HOLD_WORDS[hold]}`,
	);
	const heldDetail = held === 0 ? "" : ` (${heldParts.join(", ")})`;
	return `${classes.size} objectives are kept in this session's store: ${open} open, ${session} session work (which never closes; its finished tasks are released one by one, or with the closed plan that names them),${held} closed and held${heldDetail}, and ${free} closed with no hold.`;
}

/**
 * The objective limit's refusal, in plain words: what the store keeps, what releases closed work, and when. `external` is
 * the count of closed objectives the store holds nothing on but that state outside the store keeps; without it the text
 * says only what the store can see.
 */
export function describeObjectiveLimit(state: TaskRuntimeProjection, external?: ExternalKeepCounts): string {
	const oldest = retentionUnits(state)
		.filter((unit) => unit.kind === "objective")
		.reduce<number | undefined>(
			(min, unit) => (min === undefined || unit.lastActivityMs < min ? unit.lastActivityMs : min),
			undefined,
		);
	const oldestSentence =
		oldest === undefined
			? ""
			: `The oldest closed objective has been closed since ${new Date(oldest).toISOString().slice(0, 10)}.`;
	return [
		objectiveSummary(state),
		RELEASE_SENTENCE,
		external === undefined ? "" : keptOutsideSentence(external),
		oldestSentence,
		"Held work is released when its hold ends; otherwise start a new session.",
	]
		.filter((sentence) => sentence.length > 0)
		.join(" ");
}

/** The attempt limit's refusal, in plain words: which objectives the kept attempts belong to. */
export function describeAttemptLimit(state: TaskRuntimeProjection): string {
	const classes = classifyObjectives(state);
	let session = 0;
	let closed = 0;
	let open = 0;
	for (const attempt of Object.values(state.attempts)) {
		const objectiveId = state.tasks[attempt.taskId]?.task.objectiveId;
		const retention = objectiveId === undefined ? undefined : classes.get(objectiveId);
		if (retention?.kind === "session") session += 1;
		else if (retention?.kind === "held" || retention?.kind === "free") closed += 1;
		else open += 1;
	}
	return [
		`${Object.keys(state.attempts).length} attempts are kept in this session's store:`,
		`${session} belong to session work (which never closes),`,
		`${closed} to closed objectives,`,
		`and ${open} to open ones.`,
		"Finished session tasks and closed objectives with nothing in this store holding them release their attempts at idle after orchestration.retention.closedObjectiveDays (default 14; 0 keeps them).",
	].join(" ");
}

/**
 * The refusal for one full lifetime record kind: the count, the limit, the shortfall, and what releases it. `external` is
 * passed on to the objective summary for the objective and attempt kinds, as in `describeObjectiveLimit`.
 */
function describeRecordShortfall(
	state: TaskRuntimeProjection,
	record: LifetimeBoundedRecord,
	slots: number,
	capacity: OrchestrationProjectionCapacity,
	external?: ExternalKeepCounts,
): string {
	const counted = record.field === "objectives" || record.field === "attempts";
	const summary = counted ? ` ${objectiveSummary(state)}` : "";
	const outside = counted && external !== undefined ? keptOutsideSentence(external) : "";
	return `This session's store holds ${capacity.counts[record.field]} of its ${capacity.limits[record.field]} ${record.noun} and ${slots} more ${slots === 1 ? "is" : "are"} needed. Closed work with nothing in this store holding it is released at idle after orchestration.retention.closedObjectiveDays (default 14; 0 keeps it).${summary}${outside.length > 0 ? ` ${outside}` : ""} Lower the setting or start a new session to make room sooner.`;
}

/**
 * Refuses an admission whose lifetime record kinds lack headroom. Retained records are released by a prune, so the
 * refusal names the setting that releases them.
 */
export function assertLifetimeHeadroom(
	state: TaskRuntimeProjection,
	capacity: OrchestrationProjectionCapacity,
	required: OrchestrationProjectionHeadroomRequest,
	external?: ExternalKeepCounts,
): void {
	const requests = LIFETIME_BOUNDED_RECORDS.map((record) => ({
		record,
		slots: requestedProjectionSlots(required[record.field], record.label),
	}));
	for (const { record, slots } of requests) {
		if (slots <= capacity.headroom[record.field]) continue;
		throw new DurableTaskRuntimeError(describeRecordShortfall(state, record, slots, capacity, external));
	}
}

/**
 * Applies one `retention.pruned` event to the reducer's copied projection. Returns false for other event types. It checks
 * the payload's structure (never the live rules, see the module header), writes the agent carry, deletes the released
 * records and their dependents, records the archive id as committed, then decodes a plain copy the way the next process
 * open does, so a dangling reference throws here.
 */
export function applyRetentionEvent(state: TaskRuntimeProjection, event: OrchestrationEvent): boolean {
	if (event.type !== "retention.pruned") return false;
	if (event.aggregateId !== RETENTION_AGGREGATE_ID) {
		throw new DurableTaskRuntimeError(
			`Retention prune '${RETENTION_AGGREGATE_ID}' does not match aggregate '${event.aggregateId}'.`,
		);
	}
	const payload = retentionPrunedPayloadFromValue(event.payload);
	assertRetentionPruneWellFormed(state, payload, event.occurredAt);
	const carry = deriveCarry(state, payload);
	const dependents = deriveDependents(state, payload);
	const agents = state.agents as Record<string, unknown>;
	for (const [agentId, turns] of carry) {
		const agent = state.agents[agentId];
		if (!agent) throw new DurableTaskRuntimeError(`Retention carry names unknown agent '${agentId}'.`);
		agents[agentId] = { ...agent, prunedTurns: turns };
	}
	const releasedCheckpoints = new Set(dependents.checkpointIds);
	for (const [agentId, agent] of Object.entries(state.agents)) {
		const latestCheckpointId = agent.resumeContext.latestCheckpointId;
		if (latestCheckpointId === undefined || !releasedCheckpoints.has(latestCheckpointId)) continue;
		const { latestCheckpointId: _released, ...resumeContext } = agent.resumeContext;
		agents[agentId] = { ...agent, resumeContext };
	}
	const released = new Set(payload.taskIds);
	for (const [objectiveId, runtime] of Object.entries(state.objectives)) {
		if (!objectiveId.startsWith(SESSION_OBJECTIVE_PREFIX)) continue;
		if (!runtime.taskIds.some((taskId) => released.has(taskId))) continue;
		(state.objectives as Record<string, unknown>)[objectiveId] = {
			...runtime,
			taskIds: runtime.taskIds.filter((taskId) => !released.has(taskId)),
		};
	}
	deleteIds(state.attempts, payload.attemptIds);
	deleteIds(state.agents, payload.agentIds);
	deleteIds(state.checkpoints, dependents.checkpointIds);
	deleteIds(state.notifications, dependents.notificationIds);
	deleteIds(state.approvals, dependents.approvalIds);
	deleteIds(state.threadSubscriptions, dependents.subscriptionIds);
	deleteIds(state.tasks, payload.taskIds);
	deleteIds(state.plans, payload.planIds);
	deleteIds(state.objectives, payload.objectiveIds);
	state.retentionArchiveIds = [...(state.retentionArchiveIds ?? []), payload.archiveId];
	// Each tracked map is a byte-accounting proxy, which structuredClone refuses; a spread copy is plain.
	projectionFromSnapshot(
		toJsonObject({
			...state,
			agents: { ...state.agents },
			objectives: { ...state.objectives },
			tasks: { ...state.tasks },
			attempts: { ...state.attempts },
			checkpoints: { ...state.checkpoints },
			approvals: { ...state.approvals },
			notifications: { ...state.notifications },
			plans: { ...state.plans },
			eventSources: { ...state.eventSources },
			hostEvents: { ...state.hostEvents },
			threadSubscriptions: { ...state.threadSubscriptions },
			eventDeliveries: { ...state.eventDeliveries },
		}),
		state.lastOrdinal,
	);
	return true;
}

function deleteIds(record: object, ids: readonly string[]): void {
	for (const id of ids) delete (record as Record<string, unknown>)[id];
}
