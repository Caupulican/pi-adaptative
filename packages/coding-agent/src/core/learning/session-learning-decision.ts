import type { LearningDecision } from "../autonomy/contracts.ts";
import type { SessionEntry, SessionManager } from "../session-manager.ts";
import { cloneLearningDecisionForStorage, isLearningDecision } from "./learning-gate.ts";

export const LEARNING_DECISION_CUSTOM_TYPE = "learning_decision";

export interface LearningDecisionSnapshotPayload {
	version: 1;
	decision: LearningDecision;
}

export function appendLearningDecisionSnapshot(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	decision: LearningDecision,
): string {
	const payload: LearningDecisionSnapshotPayload = {
		version: 1,
		decision: cloneLearningDecisionForStorage(decision),
	};
	return sessionManager.appendCustomEntry(LEARNING_DECISION_CUSTOM_TYPE, payload);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

export function getLearningDecisionSnapshots(entries: readonly SessionEntry[]): LearningDecision[] {
	const results: LearningDecision[] = [];

	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== LEARNING_DECISION_CUSTOM_TYPE) {
			continue;
		}

		const payload = entry.data;
		if (!isPlainRecord(payload)) continue;
		if (payload.version !== 1) continue;
		if (!("decision" in payload)) continue;
		const decision = payload.decision;
		if (isLearningDecision(decision)) {
			results.push(cloneLearningDecisionForStorage(decision));
		}
	}

	return results;
}
