/**
 * Typed execution-admission signals, kept in their own module so both the goal session controller
 * (which throws them) and the goal continuation loop (which must recognize them) can import without
 * creating a cycle between `goal-session-controller.ts` and `../goal-loop-controller.ts`.
 */

/**
 * Thrown by `GoalSessionController#admitProviderRequest` when a goal's token budget is exhausted —
 * either already recorded (`status: "budget_limited"`) or just crossed by this very admission. The
 * durable stop (`markBudgetLimited`) is always applied synchronously BEFORE this is thrown, so by the
 * time a caller observes it the goal state already reflects the clean stop. Callers that own a
 * bounded "keep going until told to stop" contract (the goal continuation loop) must recognize this
 * distinctly from a genuine unexpected failure and report their own clean stop reason instead of
 * reclassifying an intentional, already-recorded stop as a continuation failure.
 */
export class GoalBudgetExhaustedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GoalBudgetExhaustedError";
	}
}
