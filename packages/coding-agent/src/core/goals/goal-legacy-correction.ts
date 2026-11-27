/** Recovers old owner corrections only from retained canonical edit and completed journal ancestry. */
import { isDeepStrictEqual } from "node:util";
import type { SessionManager } from "../../kernel/node.ts";
import { goalExecutorScopeKey } from "./goal-executor-refusal.ts";
import { goalOwnerActivationAt, laterOwnerActivation } from "./goal-owner-activation.ts";
import { applyOwnerCorrection } from "./goal-owner-correction.ts";
import { cloneGoalStateForStorage, type GoalEvent, type GoalState } from "./goal-state.ts";
import { requirementKey } from "./requirement-proof.ts";
import {
	decodeGoalJournalPayload,
	decodeGoalStateSnapshotPayload,
	GOAL_STATE_CUSTOM_TYPE,
	replayGoalEventBatches,
} from "./session-goal-state.ts";

type GoalJournalSource = Pick<SessionManager, "getLatestCustomEntryOnBranch">;

interface RetainedGoalAuthority {
	correction?: {
		target: GoalState;
		correction: NonNullable<GoalState["ownerCorrection"]>;
		now: string;
		postEvents: Map<string, { revision: number; event: GoalEvent }>;
	};
	ownerActivatedAt?: string;
}

function rememberPostCorrection(
	admitted: RetainedGoalAuthority["correction"],
	events: readonly GoalEvent[],
	base: number,
): void {
	if (!admitted) return;
	for (const [index, event] of events.entries()) {
		const revision = base + index + 1;
		if (revision <= admitted.correction.revision) continue;
		const keys =
			event.type === "dispatch_worker"
				? event.laneId
					? [`lane:${event.id}`]
					: []
				: event.type === "add_requirement" || event.type === "set_requirement_check"
					? [`definition:${event.id}`]
					: event.type === "block_requirement"
						? [`block:${event.id}`]
						: event.type === "executor_refused"
							? [...event.ids.map((id) => `refusal:${id}`), ...(event.scopeKey ? ["goal-refusal"] : [])]
							: event.type === "completion_rejected"
								? ["completion-rejection"]
								: [];

		for (const key of keys)
			if (revision > (admitted.postEvents.get(key)?.revision ?? -1))
				admitted.postEvents.set(key, { revision, event });
	}
}

function retainedGoalAuthority(
	source: GoalJournalSource,
	state: GoalState,
	from?: string,
): RetainedGoalAuthority | undefined {
	const entries: NonNullable<ReturnType<GoalJournalSource["getLatestCustomEntryOnBranch"]>>[] = [];
	let entry = source.getLatestCustomEntryOnBranch(GOAL_STATE_CUSTOM_TYPE, from);
	while (entry) {
		const checkpoint = decodeGoalStateSnapshotPayload(entry.data);
		const payload = checkpoint ? undefined : decodeGoalJournalPayload(entry.data);
		const recorded = checkpoint ?? (payload?.kind === "checkpoint" ? payload.state : undefined);
		if ((!recorded && !payload) || payload?.kind === "cleared") break;
		if (
			recorded
				? recorded.goalId !== state.goalId || recorded.createdAt !== state.createdAt
				: payload?.kind !== "events" || payload.goalId !== state.goalId
		)
			break;
		entries.push(entry);
		if (!entry.parentId) break;
		entry = source.getLatestCustomEntryOnBranch(GOAL_STATE_CUSTOM_TYPE, entry.parentId);
	}
	let preceding: GoalState | undefined;
	let precedingEntryId: string | undefined;
	let admitted: RetainedGoalAuthority["correction"];
	let ownerActivatedAt: string | undefined;
	for (const record of entries.reverse()) {
		const checkpoint = decodeGoalStateSnapshotPayload(record.data);
		const payload = checkpoint ? undefined : decodeGoalJournalPayload(record.data);
		const recorded = checkpoint ?? (payload?.kind === "checkpoint" ? payload.state : undefined);
		if (recorded) {
			if (preceding && (recorded.revision ?? 0) < (preceding.revision ?? 0)) return undefined;
			preceding = recorded;
			rememberPostCorrection(admitted, recorded.events, (recorded.revision ?? 0) - recorded.events.length);
		} else if (payload?.kind === "events" && preceding && precedingEntryId) {
			const target = preceding;
			preceding = replayGoalEventBatches(target, [{ payload, entryId: record.id, targetEntryId: precedingEntryId }]);
			if (!preceding) return undefined;
			const event = payload.events[0];
			const correction = preceding.ownerCorrection;
			const ended = payload.events.some(
				(item) =>
					item.type === "complete_goal" || item.type === "complete_goal_manually" || item.type === "cancel_goal",
			);
			if (ended) admitted = undefined;
			else if (target.status === "completed" && event.type === "edit_goal" && correction?.ownerEntryId === record.id)
				admitted = { target, correction, now: event.now, postEvents: new Map() };
			rememberPostCorrection(admitted, payload.events, payload.baseRevision);
		} else if (!preceding) continue;
		else return undefined;
		ownerActivatedAt = laterOwnerActivation(ownerActivatedAt, goalOwnerActivationAt(preceding));
		if (preceding.status === "cancelled") return { ownerActivatedAt };
		if (preceding.status === "completed") admitted = undefined;
		precedingEntryId = record.id;
	}
	return { correction: admitted, ownerActivatedAt };
}

/** @deprecated Current checkpoints record correction and activation authority. Remove when fieldless checkpoints are no longer supported. */
export function recoverLegacyGoalCorrection(source: GoalJournalSource, state: GoalState, from?: string): GoalState {
	const needsCorrection = !state.ownerCorrection && state.status !== "completed" && state.status !== "cancelled";
	if (state.ownerActivatedAt !== undefined && !needsCorrection) return state;
	const authority = retainedGoalAuthority(source, state, from);
	const ownerActivatedAt = laterOwnerActivation(goalOwnerActivationAt(state), authority?.ownerActivatedAt);
	const migrated = ownerActivatedAt === state.ownerActivatedAt ? state : { ...state, ownerActivatedAt };
	const admitted = needsCorrection ? authority?.correction : undefined;
	if (!admitted || admitted.correction.revision > (state.revision ?? 0)) return migrated;
	const { target, correction, now } = admitted;
	const next = cloneGoalStateForStorage(migrated);
	next.revision = correction.revision;
	applyOwnerCorrection(target, next, { type: "correct_completed_goal", correction, now });
	next.revision = state.revision;
	next.progressRevision = state.progressRevision;
	next.lastProgressAt = state.lastProgressAt;
	next.stallTurns = state.stallTurns;
	for (const [index, requirement] of state.requirements.entries()) {
		const recovered = next.requirements[index];
		const before = target.requirements.find((item) => item.id === requirement.id);
		const newerDefinition = !before || requirementKey(before) !== requirementKey(requirement);
		if (newerDefinition) {
			recovered.definitionAt = requirement.definitionAt;
			recovered.definitionRevision = requirement.definitionRevision;
		}
		const definitionRecord = admitted.postEvents.get(`definition:${requirement.id}`);
		const definitionRevision = Math.max(
			correction.revision,
			requirement.definitionRevision ?? 0,
			definitionRecord?.revision ?? 0,
		);
		const definitionAt = requirement.definitionAt ?? definitionRecord?.event.now ?? now;
		const laneRecord = admitted.postEvents.get(`lane:${requirement.id}`);
		const laneEvent = laneRecord?.event;
		const postLane =
			laneRecord &&
			laneRecord.revision > definitionRevision &&
			laneEvent?.type === "dispatch_worker" &&
			laneEvent.laneId === requirement.boundLaneId &&
			laneEvent.now === requirement.boundAt;
		const laterLaneTime =
			requirement.boundAt !== undefined &&
			Date.parse(requirement.boundAt) >
				Math.max(Date.parse(now), Date.parse(definitionAt), Date.parse(definitionRecord?.event.now ?? now));
		const knownStaleLane =
			laneRecord &&
			laneRecord.revision <= definitionRevision &&
			laneEvent?.type === "dispatch_worker" &&
			laneEvent.laneId === requirement.boundLaneId &&
			laneEvent.now === requirement.boundAt;
		const changedLane = requirement.boundLaneId !== before?.boundLaneId || requirement.boundAt !== before?.boundAt;
		const newerLane =
			!knownStaleLane &&
			(postLane || laterLaneTime || (!newerDefinition && definitionRevision === correction.revision && changedLane));
		if (newerLane) {
			recovered.boundLaneId = requirement.boundLaneId;
			recovered.boundAt = requirement.boundAt;
		}

		const blockEvent = admitted.postEvents.get(`block:${requirement.id}`)?.event;
		const postBlock =
			blockEvent?.type === "block_requirement" && blockEvent.blockedReason === requirement.blockedReason;
		const refusalRecord = admitted.postEvents.get(`refusal:${requirement.id}`);
		const refusalEvent = refusalRecord?.event;
		const refusal = requirement.executorRefusal;
		const postRefusal =
			refusalRecord &&
			refusalRecord.revision > definitionRevision &&
			refusalEvent?.type === "executor_refused" &&
			refusalEvent.definitions[refusalEvent.ids.indexOf(requirement.id)] === refusal?.definitionKey &&
			refusalEvent.reason === refusal?.reason &&
			refusalEvent.retryAt === refusal?.retryAt;
		const newerRefusal =
			refusal &&
			refusal.definitionKey === requirementKey(requirement) &&
			(newerDefinition || postRefusal || !isDeepStrictEqual(refusal, before?.executorRefusal));
		if (newerRefusal) recovered.executorRefusal = { ...refusal, definitionKey: requirementKey(recovered) };
		if (
			requirement.status === "blocked" &&
			(newerDefinition ||
				postBlock ||
				newerRefusal ||
				requirement.status !== before?.status ||
				requirement.blockedReason !== before?.blockedReason)
		) {
			recovered.status = "blocked";
			recovered.blockedReason = requirement.blockedReason;
		}
		if (newerDefinition || newerLane || postBlock || newerRefusal) recovered.updatedAt = requirement.updatedAt;
	}

	next.userGoal = state.userGoal;
	next.status = state.status;
	next.blockedReason = state.blockedReason;
	const goalRefusal = state.executorRefusal;
	const goalRefusalEvent = admitted.postEvents.get("goal-refusal")?.event;
	if (
		goalRefusal?.definitionKey === goalExecutorScopeKey(state) &&
		(!isDeepStrictEqual(goalRefusal, target.executorRefusal) ||
			(goalRefusalEvent?.type === "executor_refused" &&
				goalRefusalEvent.scopeKey === goalRefusal.definitionKey &&
				goalRefusalEvent.reason === goalRefusal.reason &&
				goalRefusalEvent.retryAt === goalRefusal.retryAt))
	)
		next.executorRefusal = { ...goalRefusal, definitionKey: goalExecutorScopeKey(next) };
	if (
		!isDeepStrictEqual(state.lastCompletionRejection, target.lastCompletionRejection) ||
		admitted.postEvents.has("completion-rejection")
	)
		next.lastCompletionRejection = state.lastCompletionRejection;
	return next;
}
