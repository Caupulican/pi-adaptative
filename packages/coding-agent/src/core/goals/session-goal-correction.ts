/** Certifies owner correction commands and goal positions against the active durable journal branch. */
import { isDeepStrictEqual } from "node:util";
import type { SessionManager } from "../../kernel/node.ts";
import { GOAL_OWNER_CORRECTION_CUSTOM_TYPE } from "../../kernel/session/session-entries.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import type { GoalOwnerCorrection, GoalSourcePosition } from "./goal-correction-contract.ts";
import { getGoalStateRevision, matchesGoalStateRevision } from "./goal-lifecycle.ts";
import type { GoalState } from "./goal-state.ts";
import {
	assertGoalIdentityUnambiguous,
	decodeGoalJournalPayload,
	GOAL_STATE_CUSTOM_TYPE,
	getLatestGoalStateSnapshot,
} from "./session-goal-state.ts";

function descends(manager: SessionManager, from: string, ancestor: string): boolean {
	let cursor = manager.getEntry(from);
	const visited = new Set<string>();
	while (cursor && !visited.has(cursor.id)) {
		if (cursor.id === ancestor) return true;
		visited.add(cursor.id);
		cursor = cursor.parentId ? manager.getEntry(cursor.parentId) : undefined;
	}
	return false;
}

const certifiedCorrections = new WeakMap<
	SessionManager,
	{ token: string; head: NonNullable<ReturnType<SessionManager["getEntry"]>> }
>();

function correctionIsRecorded(manager: SessionManager, goal: GoalState, goalEntryId: string): boolean {
	const cacheKey = JSON.stringify([goal.goalId, goal.createdAt, goal.ownerCorrection]);
	const cached = certifiedCorrections.get(manager);
	const head = manager.getEntry(goalEntryId);
	if (
		cached?.token === cacheKey &&
		head &&
		manager.getEntry(cached.head.id) === cached.head &&
		descends(manager, goalEntryId, cached.head.id)
	) {
		certifiedCorrections.set(manager, { token: cacheKey, head });
		return true;
	}
	const token = goal.ownerCorrection;
	if (!token) return true;
	const owner = manager.getEntry(token.ownerEntryId);
	const legacy =
		owner?.type === "custom" && owner.customType === GOAL_STATE_CUSTOM_TYPE
			? decodeGoalJournalPayload(owner.data)
			: undefined;
	const legacyEdit =
		legacy?.kind === "events" &&
		legacy.goalId === goal.goalId &&
		legacy.baseRevision === token.targetCompletionRevision &&
		legacy.events[0]?.type === "edit_goal" &&
		legacy.events[0].userGoal === token.objective;
	if (
		owner?.type !== "custom" ||
		(!legacyEdit &&
			(owner.customType !== GOAL_OWNER_CORRECTION_CUSTOM_TYPE ||
				!isPlainRecord(owner.data) ||
				owner.data.goalId !== goal.goalId ||
				owner.data.createdAt !== goal.createdAt ||
				owner.data.objective !== token.objective ||
				owner.data.targetCompletionRevision !== token.targetCompletionRevision ||
				owner.data.targetCompletionEntryId !== token.targetCompletionEntryId)) ||
		manager.getLatestCustomEntryOnBranch(GOAL_STATE_CUSTOM_TYPE, owner.parentId ?? undefined)?.id !==
			token.targetCompletionEntryId ||
		!descends(manager, goalEntryId, owner.id) ||
		!descends(manager, owner.id, token.targetCompletionEntryId)
	)
		return false;
	const target = getLatestGoalStateSnapshot({
		getLatestCustomEntryOnBranch: (type, from) =>
			manager.getLatestCustomEntryOnBranch(type, from ?? token.targetCompletionEntryId),
	});
	if (
		target?.goalId !== goal.goalId ||
		target.createdAt !== goal.createdAt ||
		target.status !== "completed" ||
		(target.revision ?? 0) !== token.targetCompletionRevision
	)
		return false;
	let entry = manager.getLatestCustomEntryOnBranch(GOAL_STATE_CUSTOM_TYPE, goalEntryId);
	while (entry && entry.id !== token.targetCompletionEntryId) {
		const payload = decodeGoalJournalPayload(entry.data);
		if (legacyEdit && entry.id === owner.id) {
			if (head) certifiedCorrections.set(manager, { token: cacheKey, head });
			return true;
		}
		if (
			payload?.kind === "events" &&
			payload.goalId === goal.goalId &&
			payload.events.some(
				(event, index) =>
					event.type === "correct_completed_goal" &&
					payload.baseRevision + index + 1 === token.revision &&
					isDeepStrictEqual(event.correction, token),
			)
		) {
			if (head) certifiedCorrections.set(manager, { token: cacheKey, head });
			return true;
		}
		entry = entry.parentId ? manager.getLatestCustomEntryOnBranch(GOAL_STATE_CUSTOM_TYPE, entry.parentId) : undefined;
	}
	return false;
}

export function goalSourcePosition(manager: SessionManager, goal: GoalState): GoalSourcePosition | undefined {
	const current = getLatestGoalStateSnapshot(manager);
	const entry = manager.getLatestCustomEntryOnBranch(GOAL_STATE_CUSTOM_TYPE);
	if (
		!entry ||
		!current ||
		!matchesGoalStateRevision(current, getGoalStateRevision(goal)) ||
		!correctionIsRecorded(manager, current, entry.id)
	)
		return undefined;
	return { goalEntryId: entry.id, isDescendantOf: (id) => descends(manager, entry.id, id) };
}

export function recordGoalOwnerCorrection(
	manager: SessionManager,
	goal: GoalState,
	objective: string,
	now: string,
	expectedEntryId?: string,
): GoalOwnerCorrection {
	const position = goalSourcePosition(manager, goal);
	if (
		goal.status !== "completed" ||
		!position ||
		(expectedEntryId && expectedEntryId !== position.goalEntryId) ||
		!matchesGoalStateRevision(getLatestGoalStateSnapshot(manager), getGoalStateRevision(goal))
	)
		throw new Error("Goal state or branch changed; retry the owner correction against the current completed goal.");
	assertGoalIdentityUnambiguous(manager, goal);
	const targetCompletionRevision = goal.revision ?? 0;
	const record = {
		goalId: goal.goalId,
		createdAt: goal.createdAt,
		objective,
		now,
		targetCompletionRevision,
		targetCompletionEntryId: position.goalEntryId,
	};
	const ownerEntryId = manager.appendCustomEntry(GOAL_OWNER_CORRECTION_CUSTOM_TYPE, record);
	return {
		ownerEntryId,
		objective,
		revision: targetCompletionRevision + 1,
		targetCompletionRevision,
		targetCompletionEntryId: position.goalEntryId,
	};
}
