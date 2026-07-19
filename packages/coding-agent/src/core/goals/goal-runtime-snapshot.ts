import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type { EvidenceBundle, LearningDecision, WorkerResult } from "../autonomy/contracts.ts";
import { getWorkerResultSnapshots } from "../delegation/session-worker-result.ts";
import { getLearningDecisionSnapshots } from "../learning/session-learning-decision.ts";
import { getLatestEvidenceBundleSnapshot } from "../research/session-evidence-bundle.ts";
import { getLatestTaskStepsStateSnapshot } from "../tasks/session-task-state.ts";
import type { TaskStepStatus } from "../tasks/task-state.ts";
import { evaluateGoalContinuation, type GoalContinuationDecision } from "./goal-continuation-controller.ts";
import type { GoalState } from "./goal-state.ts";
import { getLatestGoalStateSnapshot } from "./session-goal-state.ts";

export interface GoalRuntimeSnapshotSettings {
	maxStallTurns: number;
}

/**
 * A read-only projection of one OPEN (non-terminal) task_steps step, included in the goal
 * runtime snapshot purely for cross-visibility. This is NOT a shared state machine: the goal
 * loop never writes back to task state through this snapshot, and the task store stays the
 * single source of truth for its own steps.
 */
export interface GoalRuntimeOpenTaskStep {
	id: string;
	status: TaskStepStatus;
	content: string;
}

export interface GoalRuntimeSnapshot {
	goalState?: GoalState;
	latestEvidenceBundle?: EvidenceBundle;
	workerResults: readonly WorkerResult[];
	learningDecisions: readonly LearningDecision[];
	continuation: GoalContinuationDecision;
	/**
	 * Open (non-terminal) task_steps steps on the active branch, latest-wins. Read-only.
	 * Optional (like `goalState`/`latestEvidenceBundle`) so hand-built snapshots in existing
	 * tests/call sites that predate this field keep compiling unchanged; `buildGoalRuntimeSnapshot`
	 * itself always populates a concrete array (possibly empty).
	 */
	openTaskSteps?: readonly GoalRuntimeOpenTaskStep[];
}

/**
 * Branch-scoped: every resolver here reads from ONE source (the active branch), so the goal
 * state, evidence bundle, worker results, learning decisions, and open task steps in the
 * returned snapshot are never a mix of the current branch and a sibling branch's history.
 */
export function buildGoalRuntimeSnapshot(args: {
	sessionManager: Pick<SessionManager, "getLatestCustomEntryOnBranch" | "getBranch">;
	settings: GoalRuntimeSnapshotSettings;
}): GoalRuntimeSnapshot {
	const branchEntries = args.sessionManager.getBranch();
	const goalState = getLatestGoalStateSnapshot(args.sessionManager);
	const latestEvidenceBundle = getLatestEvidenceBundleSnapshot(branchEntries);
	const workerResults = getWorkerResultSnapshots(branchEntries);
	const learningDecisions = getLearningDecisionSnapshots(branchEntries);

	// Reuses the SAME branch-scoped primitive as goal-state resolution (getLatestCustomEntryOnBranch),
	// so the task-steps summary below can never leak a sibling branch's checklist either.
	const taskStepsState = getLatestTaskStepsStateSnapshot(args.sessionManager);
	const openTaskSteps: GoalRuntimeOpenTaskStep[] = (taskStepsState?.steps ?? [])
		.filter((step) => step.status !== "completed" && step.status !== "cancelled")
		.map((step) => ({ id: step.id, status: step.status, content: step.activeForm || step.content }));

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
		openTaskSteps,
	};
}
