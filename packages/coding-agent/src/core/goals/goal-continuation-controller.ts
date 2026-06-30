import type { GoalState } from "./goal-state.ts";

export type GoalContinuationAction = "continue" | "ask-user" | "finalize" | "stop";
export type GoalContinuationReasonCode =
	| "goal_active"
	| "goal_completed"
	| "goal_blocked"
	| "goal_cancelled"
	| "stall_limit_reached"
	| "no_open_requirements"
	| "blocked_requirements_present"
	| "missing_goal_state";

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
