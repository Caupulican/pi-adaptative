/** Attribution, budget and final-report authority held by a single foreground submission. */
import type {
	GoalCompletionPresentation,
	GoalForegroundTurn,
} from "../objective-execution/current-objective-execution.ts";
import type { RoutedGoalContext } from "./compact-goal-context.ts";

export const goalExecutionLeaseMarker: unique symbol = Symbol("goalExecutionLease");

/** Identity-bound attribution for one foreground execution; unbound until it owns a goal. */
export interface GoalExecutionLease {
	readonly goalId?: string;
	readonly [goalExecutionLeaseMarker]: true;
}

export interface MutableGoalExecutionLease extends GoalExecutionLease {
	/** The foreground submission that began this execution: the execution ends when it releases the foreground. */
	readonly ownerEpoch: number;
	goalId?: string;
	routedContext?: RoutedGoalContext;
	adoptNewGoal: boolean;
	adoptionBaselineGoalId?: string;
	provisionalTokenBudget?: number;
	pendingTokens: number;
	pendingSpendUsd: number;
	/** Last persisted active-time boundary; absent until ordinary work creates its own goal. */
	lastAccountedAtMs?: number;
	admittedWhileActive: boolean;
	foreground?: GoalForegroundTurn;
	presentation?: GoalCompletionPresentation;
}
