import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type { EvidenceBundle, LearningDecision, WorkerResult } from "../autonomy/contracts.ts";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import { getWorkerResultSnapshots } from "../delegation/session-worker-result.ts";
import { getLearningDecisionSnapshots } from "../learning/session-learning-decision.ts";
import { getLatestEvidenceBundleSnapshot } from "../research/session-evidence-bundle.ts";
import { getLatestTaskStepsStateSnapshot } from "../tasks/session-task-state.ts";
import type { TaskStepStatus } from "../tasks/task-state.ts";
import { evaluateGoalContinuation, type GoalContinuationDecision } from "./goal-continuation-controller.ts";
import { DEFAULT_GOAL_WORKER_WAIT_MS } from "./goal-continuation-defaults.ts";
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

/**
 * Live, per-worktree-sync-lane status for one lane bound to a dispatched worker, as the caller
 * (runtime-builder / whatever host process has live git-engine access) derives it. `boundLaneId` is
 * the host `LaneRecord.laneId` the lane's registration was correlated to
 * (`LaneRegistration.boundLaneId`, same id-space as `Requirement.boundLaneId`) -- `undefined` for a
 * lane never bound to a dispatch. `fresh`/`stale` mirror `LaneFacts`; `syncRequired` is the
 * staleness-propagation verdict (`WorktreeSyncPolicy`-derived); `rebaseInProgress` marks a sync that
 * stopped on conflicts (a rebase left in progress) -- see `core/worktree-sync/git-engine.ts`.
 */
export interface GoalRuntimeWorktreeLaneStatus {
	laneKey: string;
	boundLaneId?: string;
	fresh: boolean;
	stale: boolean;
	syncRequired: boolean;
	rebaseInProgress: boolean;
}

/**
 * Per-requirement projection of {@link GoalRuntimeWorktreeLaneStatus}, joined via
 * `requirement.boundLaneId === status.boundLaneId` -- read-only cross-visibility for snapshot
 * consumers (e.g. a future continuation-prompt render), mirroring `openTaskSteps`'s role. This is
 * NOT what feeds `evaluateGoalContinuation` (that reads the raw `boundLaneId`-keyed sets directly);
 * it exists purely so a requirement's worktree state is visible without re-deriving the join.
 */
export interface GoalRuntimeRequirementWorktreeState {
	requirementId: string;
	laneKey: string;
	fresh: boolean;
	stale: boolean;
	syncRequired: boolean;
	rebaseInProgress: boolean;
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
	/**
	 * Per-requirement worktree-sync state, present only for requirements whose `boundLaneId` matches
	 * a `worktreeLaneStatus` entry supplied to the builder. Optional (like `openTaskSteps`) so every
	 * pre-existing caller/test keeps compiling unchanged; omitted entirely (not an empty array) when
	 * the builder was never given `worktreeLaneStatus`, since "no data supplied" and "data supplied,
	 * nothing bound" are genuinely different states worth distinguishing.
	 */
	requirementWorktreeStates?: readonly GoalRuntimeRequirementWorktreeState[];
}

/**
 * Branch-scoped: every resolver here reads from ONE source (the active branch), so the goal
 * state, evidence bundle, worker results, learning decisions, and open task steps in the
 * returned snapshot are never a mix of the current branch and a sibling branch's history.
 */
export function buildGoalRuntimeSnapshot(args: {
	sessionManager: Pick<SessionManager, "getLatestCustomEntryOnBranch" | "getBranch">;
	settings: GoalRuntimeSnapshotSettings;
	/**
	 * Live lane records (queued/running/terminal), independent of branch scoping. Used ONLY to (a)
	 * detect a worker in flight against the active goal's open requirement ("waiting" — see
	 * `evaluateGoalContinuation`'s `inFlightGoalLaneIds`), and (b) surface this goal's cumulative
	 * worker/subagent spend (advisory — see `GoalState.continuationWorkerSpendUsd`). Optional so
	 * every pre-existing caller (hand-built snapshots, tests) that predates lane-awareness keeps
	 * compiling and behaving byte-identically: omitting it disables both the "waiting" branch and the
	 * worker-spend overlay, and never changes any OTHER continuation outcome.
	 */
	laneRecords?: readonly LaneRecord[];
	/**
	 * Current time as an ISO-string factory, threaded into `evaluateGoalContinuation`'s never-hang
	 * wait-timeout check (`now`/`maxWorkerWaitMs` — see there) alongside `maxWorkerWaitMs` below.
	 * Defaults to the real wall clock. A factory (not a plain string) so a caller/test can inject a
	 * fixed clock without freezing global `Date`.
	 */
	now?: () => string;
	/**
	 * Maximum milliseconds a bound in-flight requirement may wait before the continuation escalates
	 * to `worker_wait_timeout` instead of `"waiting"` forever (see `evaluateGoalContinuation`).
	 * Defaults to `DEFAULT_GOAL_WORKER_WAIT_MS`.
	 */
	maxWorkerWaitMs?: number;
	/**
	 * Live per-lane worktree-sync status, independent of branch scoping -- exactly like `laneRecords`,
	 * this builder performs NO I/O of its own; the caller derives this array (e.g. from
	 * `core/worktree-sync/git-engine.ts`'s live status) and supplies it ready-made. Used to (a) build
	 * `requirementWorktreeStates` (per-requirement projection, matched via `boundLaneId`) and (b)
	 * derive the `laneSyncConflictLaneKeys`/`syncRequiredLaneKeys` sets threaded into
	 * `evaluateGoalContinuation`. Optional so every pre-existing caller (predating worktree-sync
	 * awareness) keeps compiling and behaving byte-identically: omitting it disables both, and never
	 * changes any OTHER continuation outcome.
	 */
	worktreeLaneStatus?: readonly GoalRuntimeWorktreeLaneStatus[];
}): GoalRuntimeSnapshot {
	const branchEntries = args.sessionManager.getBranch();
	let goalState = getLatestGoalStateSnapshot(args.sessionManager);
	const latestEvidenceBundle = getLatestEvidenceBundleSnapshot(branchEntries);
	const workerResults = getWorkerResultSnapshots(branchEntries);
	const learningDecisions = getLearningDecisionSnapshots(branchEntries);

	// Reuses the SAME branch-scoped primitive as goal-state resolution (getLatestCustomEntryOnBranch),
	// so the task-steps summary below can never leak a sibling branch's checklist either.
	const taskStepsState = getLatestTaskStepsStateSnapshot(args.sessionManager);
	const openTaskSteps: GoalRuntimeOpenTaskStep[] = (taskStepsState?.steps ?? [])
		.filter((step) => step.status !== "completed" && step.status !== "cancelled")
		.map((step) => ({ id: step.id, status: step.status, content: step.activeForm || step.content }));

	let inFlightGoalLaneIds: ReadonlySet<string> | undefined;
	if (goalState && args.laneRecords) {
		const goalId = goalState.goalId;
		const inFlight = new Set<string>();
		// Live-derived, not durably persisted: the goal-state event log has no reducer branch that
		// writes `continuationWorkerSpendUsd` (see its doc comment on `GoalState`), so every read
		// re-sums THIS goal's own lane records instead of trusting a stale/zero persisted value.
		// `costUsd` is set today for in-process worker/research lane completions (LaneTracker.complete);
		// it is NOT yet set for tmux-worker completions (`ManagedLaneEvent` carries no cost claim), so
		// this sum is accurate for in-process lanes and a documented undercount for tmux workers until
		// `reportSpawnedUsage` threads a goalId/lane correlation through. Forward-compatible: the moment
		// tmux-worker costUsd is populated, this same sum picks it up with no further change here.
		let workerSpendUsd = 0;
		for (const record of args.laneRecords) {
			if (record.goalId !== goalId) continue;
			if (record.status === "queued" || record.status === "running") inFlight.add(record.laneId);
			workerSpendUsd += record.costUsd ?? 0;
		}
		inFlightGoalLaneIds = inFlight;
		goalState = { ...goalState, continuationWorkerSpendUsd: workerSpendUsd };
	}

	// Worktree-sync surfacing: (a) a per-requirement projection (matched via `boundLaneId`, purely for
	// snapshot consumers -- never read by `evaluateGoalContinuation` itself), and (b) the
	// `boundLaneId`-keyed sets `evaluateGoalContinuation` actually matches against
	// `Requirement.boundLaneId`, same id-space and matching pattern as `inFlightGoalLaneIds` above.
	// Disjoint by construction: a lane with `rebaseInProgress` feeds the conflict set only, never both.
	let requirementWorktreeStates: GoalRuntimeRequirementWorktreeState[] | undefined;
	const laneSyncConflictLaneKeys = new Set<string>();
	const syncRequiredLaneKeys = new Set<string>();
	if (args.worktreeLaneStatus) {
		for (const status of args.worktreeLaneStatus) {
			if (status.boundLaneId === undefined) continue;
			if (status.rebaseInProgress) laneSyncConflictLaneKeys.add(status.boundLaneId);
			else if (status.syncRequired) syncRequiredLaneKeys.add(status.boundLaneId);
		}
		if (goalState) {
			const states: GoalRuntimeRequirementWorktreeState[] = [];
			for (const requirement of goalState.requirements) {
				if (requirement.boundLaneId === undefined) continue;
				const status = args.worktreeLaneStatus.find(
					(candidate) => candidate.boundLaneId === requirement.boundLaneId,
				);
				if (!status) continue;
				states.push({
					requirementId: requirement.id,
					laneKey: status.laneKey,
					fresh: status.fresh,
					stale: status.stale,
					syncRequired: status.syncRequired,
					rebaseInProgress: status.rebaseInProgress,
				});
			}
			requirementWorktreeStates = states;
		}
	}

	const now = (args.now ?? (() => new Date().toISOString()))();
	const maxWorkerWaitMs = args.maxWorkerWaitMs ?? DEFAULT_GOAL_WORKER_WAIT_MS;
	const continuation = evaluateGoalContinuation({
		state: goalState,
		settings: { maxStallTurns: args.settings.maxStallTurns },
		inFlightGoalLaneIds,
		now,
		maxWorkerWaitMs,
		laneSyncConflictLaneKeys: laneSyncConflictLaneKeys.size > 0 ? laneSyncConflictLaneKeys : undefined,
		syncRequiredLaneKeys: syncRequiredLaneKeys.size > 0 ? syncRequiredLaneKeys : undefined,
	});

	return {
		goalState,
		latestEvidenceBundle,
		workerResults,
		learningDecisions,
		continuation,
		openTaskSteps,
		...(requirementWorktreeStates !== undefined ? { requirementWorktreeStates } : {}),
	};
}
