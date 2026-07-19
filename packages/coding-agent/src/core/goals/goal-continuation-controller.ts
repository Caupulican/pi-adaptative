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
	| "worker_in_flight";

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

	// A worker is dispatched (queued/running) against an open requirement this goal owns — wait
	// for it rather than submit a hollow pass or let the stall counter judge the goal unproductive.
	// Checked BEFORE the stall check so an in-flight worker always wins over an accumulated stall
	// count: the goal isn't stalled, it's actively being worked by something other than this loop.
	const inFlightGoalLaneIds = args.inFlightGoalLaneIds;
	if (
		inFlightGoalLaneIds &&
		state.requirements.some(
			(requirement) =>
				requirement.status === "open" &&
				requirement.boundLaneId !== undefined &&
				inFlightGoalLaneIds.has(requirement.boundLaneId),
		)
	) {
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
