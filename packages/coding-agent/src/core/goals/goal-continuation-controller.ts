import type { GoalState } from "./goal-state.ts";

export type GoalContinuationAction = "continue" | "ask-user" | "finalize" | "stop" | "waiting";
export type GoalContinuationReasonCode =
	| "goal_active"
	| "goal_completed"
	| "goal_blocked"
	| "goal_cancelled"
	| "stall_limit_reached"
	| "no_open_requirements"
	| "blocked_requirements_present"
	| "missing_goal_state"
	| "worker_in_flight"
	| "worker_wait_timeout"
	| "lane_sync_conflict"
	| "lane_sync_required";

export interface GoalContinuationDecision {
	action: GoalContinuationAction;
	reasonCode: GoalContinuationReasonCode;
	message: string;
	goalId?: string;
	stallTurns?: number;
	maxStallTurns?: number;
	openRequirementIds: readonly string[];
	blockedRequirementIds: readonly string[];
	satisfiedRequirementIds: readonly string[];
}

export interface GoalContinuationSettings {
	maxStallTurns: number;
}

export function evaluateGoalContinuation(args: {
	state?: GoalState;
	settings: GoalContinuationSettings;
	/**
	 * LaneIds currently queued/running AND tagged with THIS goal's id (see `LaneRecord.goalId`).
	 * When an open requirement is bound (`Requirement.boundLaneId`) to one of these lanes, the
	 * goal is WAITING on that worker rather than stalled or ready for another pass: the loop must not
	 * submit a hollow continuation prompt (which would then misreport as `goal_state_not_advanced`),
	 * and the idle scheduler must not race a re-dispatch against the same open requirement. Optional
	 * so every pre-existing (in-flight-unaware) caller keeps compiling and behaving unchanged.
	 */
	inFlightGoalLaneIds?: ReadonlySet<string>;
	/**
	 * Current time as an ISO string, paired with `maxWorkerWaitMs` to detect a bound in-flight
	 * requirement that has hung past its deadline (see below). Optional so every pre-existing
	 * caller that omits it keeps behaving byte-identically -- the goal waits indefinitely, exactly
	 * as before this field existed.
	 */
	now?: string;
	/**
	 * Maximum milliseconds a bound in-flight requirement (`Requirement.boundAt`) may wait before
	 * this escalates to `action:"ask-user"`/`reasonCode:"worker_wait_timeout"` instead of
	 * `"waiting"` -- a worker that is alive-but-hung past its deadline must not wait forever. Only
	 * takes effect when BOTH `now` and this are supplied; escalation fires only once EVERY
	 * bound-in-flight open requirement has individually passed `boundAt + maxWorkerWaitMs`, so a
	 * goal with a mix of fresh and stale bindings keeps waiting on the fresh one.
	 */
	maxWorkerWaitMs?: number;
	/**
	 * Bound lanes (`Requirement.boundLaneId` -- SAME id-space as `inFlightGoalLaneIds`, not the raw
	 * worktree-sync `laneKey`) whose worktree-sync lane has a rebase stopped on conflicts
	 * (`LaneFacts.rebaseInProgress`). The caller (`goal-runtime-snapshot.ts`) is responsible for
	 * translating live per-worktree-lane status into this id-space by matching each status entry's
	 * own `boundLaneId` against the requirement -- this function stays pure and never resolves a
	 * worktree laneKey itself, exactly like `inFlightGoalLaneIds` never resolves a tmux job id.
	 * Checked BEFORE the waiting branch (see `lane_sync_conflict` below): a stalled-but-conflicted
	 * worker must get the resolve directive, not silently wait forever. Optional so every
	 * pre-existing caller keeps compiling and behaving byte-identically when omitted or empty.
	 */
	laneSyncConflictLaneKeys?: ReadonlySet<string>;
	/**
	 * Bound lanes (`Requirement.boundLaneId`, same id-space note as {@link laneSyncConflictLaneKeys})
	 * whose worktree-sync lane is stale and must sync with current main before further work
	 * (`sync_required`, i.e. NOT already covered by `laneSyncConflictLaneKeys` -- a lane with a
	 * rebase in progress is reported as a conflict, never double-counted here). Checked BEFORE the
	 * waiting branch, same precedence rationale as above. Optional so every pre-existing caller keeps
	 * compiling and behaving byte-identically when omitted or empty.
	 */
	syncRequiredLaneKeys?: ReadonlySet<string>;
}): GoalContinuationDecision {
	if (!args.state) {
		return {
			action: "ask-user",
			reasonCode: "missing_goal_state",
			message: "No goal state is present.",
			openRequirementIds: [],
			blockedRequirementIds: [],
			satisfiedRequirementIds: [],
		};
	}

	const state = args.state;
	const openRequirementIds: string[] = [];
	const blockedRequirementIds: string[] = [];
	const satisfiedRequirementIds: string[] = [];

	for (const req of state.requirements) {
		if (req.status === "open") openRequirementIds.push(req.id);
		else if (req.status === "blocked") blockedRequirementIds.push(req.id);
		else if (req.status === "satisfied") satisfiedRequirementIds.push(req.id);
	}

	const baseDecision = {
		goalId: state.goalId,
		stallTurns: state.stallTurns,
		maxStallTurns: args.settings.maxStallTurns,
		openRequirementIds,
		blockedRequirementIds,
		satisfiedRequirementIds,
	};

	if (state.status === "completed") {
		return {
			...baseDecision,
			action: "finalize",
			reasonCode: "goal_completed",
			message: "The goal is marked as completed.",
		};
	}

	if (state.status === "blocked") {
		return {
			...baseDecision,
			action: "ask-user",
			reasonCode: "goal_blocked",
			message: "The goal is explicitly blocked.",
		};
	}

	if (state.status === "cancelled") {
		return {
			...baseDecision,
			action: "stop",
			reasonCode: "goal_cancelled",
			message: "The goal has been cancelled.",
		};
	}

	// Status is active
	if (blockedRequirementIds.length > 0) {
		return {
			...baseDecision,
			action: "ask-user",
			reasonCode: "blocked_requirements_present",
			message: "One or more requirements are blocked.",
		};
	}

	if (openRequirementIds.length === 0) {
		return {
			...baseDecision,
			action: "finalize",
			reasonCode: "no_open_requirements",
			message: "There are no open requirements left to satisfy.",
		};
	}

	// Worktree-sync directives take precedence over the "waiting" branch below: a worker whose bound
	// lane is conflicted or stale is NOT merely in-flight-and-quiet -- it needs an explicit directive
	// (resolve conflicts, or sync) delivered through the continuation prompt, and a stalled-but-stale
	// worker must never be left waiting indefinitely for a sync it was never told to run. Conflict is
	// checked first: a lane with a rebase already stopped on conflicts cannot usefully be told to
	// "sync" again (that lane's `sync_required` flag is never set while `rebaseInProgress` is true --
	// see `goal-runtime-snapshot.ts` -- so the two sets below are disjoint by construction, not by a
	// priority check here).
	const laneSyncConflictLaneKeys = args.laneSyncConflictLaneKeys;
	const conflictedRequirements = laneSyncConflictLaneKeys
		? state.requirements.filter(
				(requirement) =>
					requirement.status === "open" &&
					requirement.boundLaneId !== undefined &&
					laneSyncConflictLaneKeys.has(requirement.boundLaneId),
			)
		: [];
	if (conflictedRequirements.length > 0) {
		return {
			...baseDecision,
			action: "continue",
			reasonCode: "lane_sync_conflict",
			message: `Requirement(s) ${conflictedRequirements.map((requirement) => requirement.id).join(", ")} are bound to a worktree-sync lane with a rebase stopped on conflicts; resolve via worktree_sync action:"continue" (or "abort_sync") before this goal can progress further.`,
		};
	}

	const syncRequiredLaneKeys = args.syncRequiredLaneKeys;
	const syncRequiredRequirements = syncRequiredLaneKeys
		? state.requirements.filter(
				(requirement) =>
					requirement.status === "open" &&
					requirement.boundLaneId !== undefined &&
					syncRequiredLaneKeys.has(requirement.boundLaneId),
			)
		: [];
	if (syncRequiredRequirements.length > 0) {
		return {
			...baseDecision,
			action: "continue",
			reasonCode: "lane_sync_required",
			message: `Requirement(s) ${syncRequiredRequirements.map((requirement) => requirement.id).join(", ")} are bound to a worktree-sync lane that must rebase current main before further work; deliver worktree_sync action:"sync" to the bound worker, or run it directly for an idle lane.`,
		};
	}

	// A worker is dispatched (queued/running) against an open requirement this goal owns — wait
	// for it rather than submit a hollow pass or let the stall counter judge the goal unproductive.
	// Checked BEFORE the stall check so an in-flight worker always wins over an accumulated stall
	// count: the goal isn't stalled, it's actively being worked by something other than this loop.
	const inFlightGoalLaneIds = args.inFlightGoalLaneIds;
	const boundInFlightRequirements = inFlightGoalLaneIds
		? state.requirements.filter(
				(requirement) =>
					requirement.status === "open" &&
					requirement.boundLaneId !== undefined &&
					inFlightGoalLaneIds.has(requirement.boundLaneId),
			)
		: [];

	if (boundInFlightRequirements.length > 0) {
		// Never-hang backstop: a worker alive-but-hung past its deadline must escalate to the owner
		// instead of waiting forever. Only evaluated when the caller supplies BOTH a clock reading and
		// a deadline; escalates only once EVERY bound-in-flight requirement has individually timed out,
		// so one fresh binding keeps the goal legitimately waiting.
		if (args.now !== undefined && args.maxWorkerWaitMs !== undefined) {
			const nowMs = Date.parse(args.now);
			const maxWorkerWaitMs = args.maxWorkerWaitMs;
			const allTimedOut =
				Number.isFinite(nowMs) &&
				boundInFlightRequirements.every((requirement) => {
					if (requirement.boundAt === undefined) return false;
					const boundAtMs = Date.parse(requirement.boundAt);
					return Number.isFinite(boundAtMs) && boundAtMs + maxWorkerWaitMs <= nowMs;
				});
			if (allTimedOut) {
				return {
					...baseDecision,
					action: "ask-user",
					reasonCode: "worker_wait_timeout",
					message: `A dispatched worker has not completed within the maximum wait of ${maxWorkerWaitMs}ms; escalating to the owner instead of waiting indefinitely.`,
				};
			}
		}

		return {
			...baseDecision,
			action: "waiting",
			reasonCode: "worker_in_flight",
			message: "A worker is dispatched against an open requirement; waiting for it to finish before continuing.",
		};
	}

	if (args.settings.maxStallTurns > 0 && state.stallTurns >= args.settings.maxStallTurns) {
		return {
			...baseDecision,
			action: "ask-user",
			reasonCode: "stall_limit_reached",
			message: `The goal has reached the maximum stall limit of ${args.settings.maxStallTurns} turns.`,
		};
	}

	return {
		...baseDecision,
		action: "continue",
		reasonCode: "goal_active",
		message: "The goal is active and making progress.",
	};
}
