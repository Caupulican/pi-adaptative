/** Submit the root route on its foreground lifetime and read the outcome of that exact submission. */
import type { GoalContinuationTurnOutcome } from "../agent-session-contracts.ts";
import {
	assertCurrentGoalObjective,
	type GoalExecutionCustody,
	type GoalForegroundTurn,
	ObjectiveExecutionInterruptedError,
} from "../objective-execution/current-objective-execution.ts";
import type { ObjectiveExecutionControllerDeps } from "../objective-execution/objective-execution-controller.ts";
import { buildObjectiveRoutePrompt, GOAL_CONTINUATION_TRIGGER_CUSTOM_TYPE } from "./goal-continuation-prompt.ts";
import {
	getContinuationTurnOutcome,
	ObjectiveRootTurnErroredError,
	ObjectiveRootTurnInterruptedError,
} from "./goal-execution-errors.ts";
import type { GoalSessionControllerDeps } from "./goal-session-controller.ts";
import type { GoalState } from "./goal-state.ts";

export function goalObjectiveRootExecutor(
	deps: Pick<GoalSessionControllerDeps, "getSessionManager" | "getModel" | "prompt">,
	custody: GoalExecutionCustody,
	readGoal: () => GoalState | undefined,
	admit: (turn: GoalForegroundTurn | undefined) => void,
	outcome: (value?: GoalContinuationTurnOutcome["outcome"], completed?: GoalState) => void,
): NonNullable<ObjectiveExecutionControllerDeps["rootExecutor"]> {
	return {
		reportsAdmission: true,
		execute: async (route, signal, submitted) => {
			signal?.throwIfAborted();
			const goal = assertCurrentGoalObjective(route.objective_id, readGoal());
			const manager = deps.getSessionManager();
			const assertBranch = manager.captureBranchContext();
			const firstTurnEntryIndex = manager.getEntryCount();
			const turn = goal && custody.openForeground(goal, signal);
			let admitted = false;
			outcome();
			try {
				await deps.prompt(buildObjectiveRoutePrompt(route).text, {
					expandPromptTemplates: false,
					processSlashCommands: false,
					autoContinueGoal: false,
					internalContextType: GOAL_CONTINUATION_TRIGGER_CUSTOM_TYPE,
					goalExecutionId: goal?.goalId,
					signal: turn?.signal ?? signal,
					preflightResult: (accepted) => {
						if (accepted && !admitted) {
							admitted = true;
							admit(turn);
							submitted?.();
						}
					},
				});
				if (deps.getSessionManager() !== manager) throw new ObjectiveExecutionInterruptedError("session_replaced");
				try {
					assertBranch();
				} catch {
					throw new ObjectiveExecutionInterruptedError("session_replaced");
				}
				if (!admitted) {
					outcome("interrupted");
					throw new ObjectiveRootTurnInterruptedError();
				}
				const result = getContinuationTurnOutcome(manager, firstTurnEntryIndex, deps.getModel()?.provider);
				outcome(result.outcome, result.outcome === "completed" ? turn?.completedGoal : undefined);
				if (result.outcome === "interrupted") throw new ObjectiveRootTurnInterruptedError();
				if (result.outcome === "errored")
					throw new ObjectiveRootTurnErroredError(result.errorMessage ?? "provider error");
			} finally {
				turn?.release();
			}
		},
	};
}
