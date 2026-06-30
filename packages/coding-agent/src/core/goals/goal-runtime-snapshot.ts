import type { EvidenceBundle, LearningDecision, WorkerResult } from "../autonomy/contracts.ts";
import { getWorkerResultSnapshots } from "../delegation/session-worker-result.ts";
import { getLearningDecisionSnapshots } from "../learning/session-learning-decision.ts";
import { getLatestEvidenceBundleSnapshot } from "../research/session-evidence-bundle.ts";
import type { SessionEntry } from "../session-manager.ts";
import { evaluateGoalContinuation, type GoalContinuationDecision } from "./goal-continuation-controller.ts";
import type { GoalState } from "./goal-state.ts";
import { getLatestGoalStateSnapshot } from "./session-goal-state.ts";

export interface GoalRuntimeSnapshotSettings {
	maxStallTurns: number;
}

export interface GoalRuntimeSnapshot {
	goalState?: GoalState;
	latestEvidenceBundle?: EvidenceBundle;
	workerResults: readonly WorkerResult[];
	learningDecisions: readonly LearningDecision[];
	continuation: GoalContinuationDecision;
}

export function buildGoalRuntimeSnapshot(args: {
	entries: readonly SessionEntry[];
	settings: GoalRuntimeSnapshotSettings;
}): GoalRuntimeSnapshot {
	const goalState = getLatestGoalStateSnapshot(args.entries);
	const latestEvidenceBundle = getLatestEvidenceBundleSnapshot(args.entries);
	const workerResults = getWorkerResultSnapshots(args.entries);
	const learningDecisions = getLearningDecisionSnapshots(args.entries);

	const continuation = evaluateGoalContinuation({
		state: goalState,
		settings: { maxStallTurns: args.settings.maxStallTurns },
	});

	return {
		goalState,
		latestEvidenceBundle,
		workerResults,
		learningDecisions,
		continuation,
	};
}
