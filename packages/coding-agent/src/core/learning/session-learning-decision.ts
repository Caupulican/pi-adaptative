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

export function getLearningDecisionSnapshots(entries: readonly SessionEntry[]): LearningDecision[] {
	const results: LearningDecision[] = [];

	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== LEARNING_DECISION_CUSTOM_TYPE) {
			continue;
		}

		const payload = entry.data;
		if (!payload || typeof payload !== "object" || !("version" in payload)) continue;
		const record = payload as Record<string, unknown>;
		if (record.version !== 1) continue;
		if (!("decision" in record)) continue;
		const decision = record.decision;
		if (isLearningDecision(decision)) {
			results.push(cloneLearningDecisionForStorage(decision));
		}
	}

	return results;
}
