/** Durable authority of one owner correction and the journal position that certifies its source. */
import { isPlainRecord } from "../util/value-guards.ts";

export interface GoalOwnerCorrection {
	ownerEntryId: string;
	revision: number;
	targetCompletionRevision: number;
	targetCompletionEntryId: string;
	objective: string;
}

export interface GoalSourcePosition {
	goalEntryId: string;
	isDescendantOf(entryId: string): boolean;
}

export function isGoalOwnerCorrection(value: unknown): value is GoalOwnerCorrection {
	return (
		isPlainRecord(value) &&
		typeof value.ownerEntryId === "string" &&
		value.ownerEntryId.trim().length > 0 &&
		typeof value.targetCompletionEntryId === "string" &&
		value.targetCompletionEntryId.trim().length > 0 &&
		typeof value.objective === "string" &&
		value.objective.trim().length > 0 &&
		Number.isSafeInteger(value.revision) &&
		Number(value.revision) > 0 &&
		Number.isSafeInteger(value.targetCompletionRevision) &&
		Number(value.targetCompletionRevision) >= 0 &&
		Number(value.revision) === Number(value.targetCompletionRevision) + 1
	);
}

export interface GoalObjectiveCursor {
	createdAt: string;
	revision: number;
	definitionKey: string;
	goalEntryId: string;
	lastCorrection?: GoalOwnerCorrection;
	correctedOutcomeProof?: string;
}

export function isGoalObjectiveCursor(value: unknown): value is GoalObjectiveCursor {
	return (
		isPlainRecord(value) &&
		typeof value.createdAt === "string" &&
		Number.isFinite(Date.parse(value.createdAt)) &&
		Number.isSafeInteger(value.revision) &&
		Number(value.revision) >= 0 &&
		typeof value.definitionKey === "string" &&
		/^[a-f0-9]{64}$/.test(value.definitionKey) &&
		typeof value.goalEntryId === "string" &&
		value.goalEntryId.trim().length > 0 &&
		(value.correctedOutcomeProof === undefined ||
			(typeof value.correctedOutcomeProof === "string" &&
				value.correctedOutcomeProof.length > 0 &&
				value.correctedOutcomeProof.length <= 256)) &&
		(value.lastCorrection === undefined ||
			(isGoalOwnerCorrection(value.lastCorrection) && value.lastCorrection.revision <= Number(value.revision)))
	);
}
