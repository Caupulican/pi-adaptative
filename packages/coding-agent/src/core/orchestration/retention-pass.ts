/**
 * The retention pass: one synchronous run that plans a prune of closed orchestration work, writes its archive under the
 * session bundle, and commits the `retention.pruned` event. It is the only path that writes a prune. The controller
 * (retention-controller.ts) decides when it runs; this module decides what is released, and every hold it checks is a
 * projection fact or a delegation fact read here, never a model's judgment. The snapshot, the plan, the orphan sweep and the
 * commit run in one bundle admission, so no writer runs between the plan and its commit.
 */

import { type DelegationRecord, readDelegations } from "../delegation/leader-delegation-ledger.ts";
import { toJsonObject } from "./contracts.ts";
import type { OrchestrationEventStore } from "./event-store.ts";
import type { ExternalKeep, ExternalKeepCounts } from "./retention.ts";
import {
	buildRetentionArchive,
	retentionArchiveDir,
	sweepRetentionArchives,
	writeRetentionArchive,
} from "./retention-archive.ts";
import {
	closedObjectiveHolds,
	type ExternalHold,
	RETENTION_PRESSURE_HEADROOM,
	type RetentionSelection,
	retentionDependentsDigest,
	retentionUnits,
	selectRetention,
} from "./retention-eligibility.ts";
import { RetentionPlanStaleError, type RetentionPrunedPayload, retentionArchiveId } from "./retention-event.ts";
import { delegatedMessagesPending, hasPendingControlMessages } from "./retention-readers.ts";
import { withSessionBundleMaintenance } from "./session-bundle-lifecycle.ts";
import type { DurableTaskRuntime } from "./task-runtime.ts";
import type { OrchestrationProjectionCapacity, TaskRuntimeProjection } from "./task-runtime-state.ts";

const DAY_MS = 86_400_000;
/**
 * The least age of released work, even under pressure: a replayed tool call or control message finds its attempt by the
 * control message id, and a released attempt cannot be found by it, so the replay window must have closed first.
 */
export const RETENTION_REPLAY_FLOOR_MS = 3_600_000;

export interface RetentionPassDeps {
	readonly runtime: () => DurableTaskRuntime;
	readonly store: () => OrchestrationEventStore;
	readonly sessionId: string;
	readonly agentDir: string;
	readonly closedObjectiveDays: () => number;
	/** The orchestration clock: the store stamps `occurredAt` on it, and the reducer compares the cutoff with that stamp. */
	readonly now: () => number;
	readonly hasDelivered: (deliveryId: string) => boolean;
	readonly currentGoalId: () => string | undefined;
	/** Reports a condition the pass cannot clear itself (a damaged archive); the controller reports each text once. */
	readonly warn: (message: string) => void;
}

export type { ExternalKeep, ExternalKeepCounts } from "./retention.ts";

export type RetentionPassResult =
	| { readonly kind: "disabled" }
	| { readonly kind: "nothing"; readonly held: number; readonly external: ExternalKeepCounts }
	| {
			readonly kind: "pruned";
			readonly archiveId: string;
			readonly objectives: number;
			readonly attempts: number;
			readonly truncated: boolean;
	  };

/** True when the store has fewer free objective or attempt slots than the pressure headroom: the age floor is then waived. */
export function isUnderRetentionPressure(capacity: OrchestrationProjectionCapacity): boolean {
	return (
		capacity.headroom.objectives < RETENTION_PRESSURE_HEADROOM ||
		capacity.headroom.attempts < RETENTION_PRESSURE_HEADROOM
	);
}

/** What the pass reads from delegation state and the mailboxes, before it plans. */
interface ExternalHolds {
	/** Objective id -> the first external hold on it. */
	readonly objectives: ReadonlyMap<string, ExternalHold>;
	/** Attempts inside an open legacy delegation window. */
	readonly attempts: ReadonlySet<string>;
	/** Agents with a control message still pending. */
	readonly agents: ReadonlySet<string>;
}

function isOpenDelegation(record: DelegationRecord): boolean {
	return record.state === "queued" || record.state === "running" || record.state === "paused";
}

function externalHolds(state: TaskRuntimeProjection, deps: RetentionPassDeps): ExternalHolds {
	const objectives = new Map<string, ExternalHold>();
	const hold = (objectiveId: string, reason: ExternalHold) => {
		if (!objectives.has(objectiveId)) objectives.set(objectiveId, reason);
	};
	const currentGoal = deps.currentGoalId();
	// synchronizeGoalState re-creates the current goal's objective on its next write, so it is never released.
	if (currentGoal !== undefined) hold(`goal:${currentGoal}`, "current_goal");
	const attempts = new Set<string>();
	let delegatedPending: ((objectiveId: string) => boolean) | undefined;
	const delegations = readDelegations(state);
	const openObjectives = new Set(delegations.filter(isOpenDelegation).map((record) => record.objectiveId));
	const openFollowed = new Set(
		delegations
			.filter(isOpenDelegation)
			.map((record) => record.charter.parentObjectiveId)
			.filter((parentId): parentId is string => parentId !== undefined),
	);
	for (const record of delegations) {
		if (!isOpenDelegation(record)) {
			// A nested goal waits while the goal that handed it on is open.
			if (record.charter.parentObjectiveId !== undefined && openObjectives.has(record.charter.parentObjectiveId)) {
				hold(record.objectiveId, "delegation_open_parent");
			}
			// Only an outcome that has not reached its recipient holds the objective: the parent leader's for a nested goal (once
			// it was delivered there, or the parent has since closed and the root heard it), else the orchestrator's. A closed
			// delegation with no outcome has nothing to deliver.
			const delivered = record.outcomeDeliveredToParent || deps.hasDelivered(`leader-outcome:${record.objectiveId}`);
			if (record.outcome !== undefined && !delivered) hold(record.objectiveId, "outcome_undelivered");
			if (openFollowed.has(record.objectiveId)) hold(record.objectiveId, "follower_open");
			delegatedPending ??= delegatedMessagesPending(deps.agentDir, deps.sessionId, state, deps.warn);
			if (delegatedPending(record.objectiveId)) hold(record.objectiveId, "delegated_message_pending");
		} else if (!record.filedByObjective && record.dispatchedAt !== undefined) {
			// The legacy turnBelongsTo attributes an attempt to an open delegation by time window.
			const dispatchedMs = Date.parse(record.dispatchedAt);
			for (const attempt of Object.values(state.attempts)) {
				if (Date.parse(attempt.createdAt) >= dispatchedMs) attempts.add(attempt.attemptId);
			}
		}
	}
	const agentIds = new Set<string>();
	for (const unit of retentionUnits(state)) {
		for (const attemptId of unit.attemptIds) {
			const agentId = state.attempts[attemptId]?.agentId;
			if (agentId !== undefined) agentIds.add(agentId);
		}
	}
	const agents = new Set<string>();
	for (const agentId of agentIds) {
		if (hasPendingControlMessages(deps.agentDir, deps.sessionId, agentId, deps.warn)) agents.add(agentId);
	}
	return { objectives, attempts, agents };
}

/** Closed objectives the projection holds nothing on, counted by the external fact that keeps them. */
function keptOutside(state: TaskRuntimeProjection, holds: ExternalHolds): ExternalKeepCounts {
	const projectionHolds = closedObjectiveHolds(state);
	const counts: Partial<Record<ExternalKeep, number>> = {};
	const count = (kind: ExternalKeep) => {
		counts[kind] = (counts[kind] ?? 0) + 1;
	};
	for (const unit of retentionUnits(state)) {
		if (unit.kind !== "objective" || projectionHolds.get(unit.objectiveId) !== undefined) continue;
		const objectiveHold = holds.objectives.get(unit.objectiveId);
		if (objectiveHold !== undefined) count(objectiveHold);
		else if (unit.attemptIds.some((attemptId) => holds.attempts.has(attemptId))) count("legacy_window");
		else if (
			unit.attemptIds.some((attemptId) => {
				const agentId = state.attempts[attemptId]?.agentId;
				return agentId !== undefined && holds.agents.has(agentId);
			})
		) {
			count("agent_message_pending");
		}
	}
	return counts;
}

/**
 * One pass, in one bundle admission: take the snapshot, plan, sweep the orphan archives, write the archive and commit the
 * prune. The snapshot and the plan are read inside the admission, so no writer can advance the store between the plan and
 * the sweep. A declined admission, an empty selection and a stale plan all return `nothing`, and the next idle re-plans.
 */
export function runRetentionPass(deps: RetentionPassDeps): RetentionPassResult {
	const days = deps.closedObjectiveDays();
	if (days === 0) return { kind: "disabled" };
	const archiveDir = retentionArchiveDir(deps.store().rootDir);
	const admitted = withSessionBundleMaintenance(deps.agentDir, deps.sessionId, (): RetentionPassResult => {
		const runtime = deps.runtime();
		const state = runtime.getSnapshot();
		const now = deps.now();
		const cutoff = new Date(
			now - (isUnderRetentionPressure(runtime.getProjectionCapacity()) ? RETENTION_REPLAY_FLOOR_MS : days * DAY_MS),
		).toISOString();
		const holds = externalHolds(state, deps);
		const selection: RetentionSelection = selectRetention({
			state,
			cutoff,
			externalObjectiveHolds: holds.objectives,
			externalAgentHolds: holds.agents,
			externalAttemptHolds: holds.attempts,
		});
		const nothing = (): RetentionPassResult => ({
			kind: "nothing",
			held: selection.held,
			external: keptOutside(state, holds),
		});
		const kept = sweepRetentionArchives(archiveDir, {
			sessionId: deps.sessionId,
			committed: new Set(state.retentionArchiveIds ?? []),
			nowMs: now,
		});
		for (const path of kept) {
			deps.warn(
				`Orchestration retention archive ${path} does not verify or belongs to another session; it is kept.`,
			);
		}
		if (selection.objectiveIds.length === 0 && selection.taskIds.length === 0 && selection.planIds.length === 0) {
			return nothing();
		}
		const file = buildRetentionArchive({
			sessionId: deps.sessionId,
			cutoff,
			selection,
			projection: toJsonObject(state),
		});
		writeRetentionArchive(archiveDir, file);
		const payload: RetentionPrunedPayload = {
			v: 1,
			archiveId: retentionArchiveId(file.digest),
			archiveDigest: file.digest,
			cutoff,
			objectiveIds: selection.objectiveIds,
			taskIds: selection.taskIds,
			attemptIds: selection.attemptIds,
			planIds: selection.planIds,
			dependentsDigest: retentionDependentsDigest(selection.dependents),
		};
		try {
			runtime.commitRetentionPrune(payload, state.lastOrdinal);
		} catch (error) {
			// Another writer advanced the store since the plan: the next idle re-plans from the new projection.
			if (error instanceof RetentionPlanStaleError) return nothing();
			throw error;
		}
		return {
			kind: "pruned",
			archiveId: payload.archiveId,
			objectives: selection.objectiveIds.length,
			attempts: selection.attemptIds.length,
			truncated: selection.truncated,
		};
	});
	// A declined admission means the bundle is being deleted: there is nothing to plan, and no store-side count to report.
	return admitted.admitted ? admitted.value : { kind: "nothing", held: 0, external: {} };
}
