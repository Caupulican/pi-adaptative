import type { SessionEntry, SessionManager } from "@caupulican/pi-agent-core/node";
import type { LearningDecision } from "../autonomy/contracts.ts";
import {
	appendSessionSnapshot,
	getSessionSnapshots,
	type SessionSnapshotCodec,
	type SessionSnapshotPayload,
} from "../session-snapshot.ts";
import { cloneLearningDecisionForStorage, isLearningDecision } from "./learning-gate.ts";

export const LEARNING_DECISION_CUSTOM_TYPE = "learning_decision";

export type LearningDecisionSnapshotPayload = SessionSnapshotPayload<"decision", LearningDecision>;

const LEARNING_DECISION_SNAPSHOT_CODEC: SessionSnapshotCodec<LearningDecision, "decision"> = {
	customType: LEARNING_DECISION_CUSTOM_TYPE,
	valueKey: "decision",
	isValue: isLearningDecision,
	clone: cloneLearningDecisionForStorage,
};

export function appendLearningDecisionSnapshot(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	decision: LearningDecision,
): string {
	return appendSessionSnapshot(sessionManager, LEARNING_DECISION_SNAPSHOT_CODEC, decision);
}

export function getLearningDecisionSnapshots(entries: readonly SessionEntry[]): LearningDecision[] {
	return getSessionSnapshots(entries, LEARNING_DECISION_SNAPSHOT_CODEC);
}
