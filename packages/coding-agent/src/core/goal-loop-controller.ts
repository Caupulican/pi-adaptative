/**
 * Goal auto-continuation loop.
 *
 * Extracted verbatim from agent-session.ts (god-file decomposition). Drives the bounded "keep the
 * active goal moving" loop: each pass reads the goal runtime snapshot, and — only while the snapshot
 * says `continue` — submits one continuation prompt back through the session's own prompt path. It
 * owns no state; the goal state lives in the session log and is read fresh every pass. Termination is
 * fully budget-gated (turn cap, wall-clock cap, and a no-progress guard on the goal-state key).
 */

import type {
	GoalContinuationLoopOptions,
	GoalContinuationLoopResult,
	GoalContinuationOnceOptions,
	GoalContinuationOnceResult,
	PromptOptions,
} from "./agent-session.ts";
import { buildGoalContinuationPrompt } from "./goals/goal-continuation-prompt.ts";
import type { GoalRuntimeSnapshot, GoalRuntimeSnapshotSettings } from "./goals/goal-runtime-snapshot.ts";

export interface GoalLoopControllerDeps {
	/** Read the current goal runtime snapshot (continuation decision + goal state) fresh each pass. */
	getGoalRuntimeSnapshot(settings: GoalRuntimeSnapshotSettings): GoalRuntimeSnapshot;
	/** Submit a continuation prompt through the session's own prompt path. */
	prompt(text: string, options?: PromptOptions): Promise<void>;
}

export class GoalLoopController {
	private readonly deps: GoalLoopControllerDeps;

	constructor(deps: GoalLoopControllerDeps) {
		this.deps = deps;
	}

	async continueGoalOnce(options: GoalContinuationOnceOptions): Promise<GoalContinuationOnceResult> {
		const snapshot = this.deps.getGoalRuntimeSnapshot({ maxStallTurns: options.maxStallTurns });

		if (snapshot.continuation.action !== "continue") {
			return { submitted: false, snapshot };
		}

		const prompt = buildGoalContinuationPrompt({ snapshot, limits: options.promptLimits });
		await this.deps.prompt(prompt.text, {
			expandPromptTemplates: false,
			processSlashCommands: false,
			autoContinueGoal: false,
		});

		return { submitted: true, snapshot, prompt };
	}

	async continueGoalLoop(options: GoalContinuationLoopOptions): Promise<GoalContinuationLoopResult> {
		let turnsSubmitted = 0;
		const now = options.now ?? Date.now;
		const maxWallClockMs =
			typeof options.maxWallClockMinutes === "number" && options.maxWallClockMinutes > 0
				? options.maxWallClockMinutes * 60_000
				: undefined;
		const startedAt = now();
		const hasReachedWallClockBudget = () => maxWallClockMs !== undefined && now() - startedAt >= maxWallClockMs;
		const snapshot = () => this.deps.getGoalRuntimeSnapshot({ maxStallTurns: options.maxStallTurns });

		if (options.maxTurns <= 0) {
			return {
				turnsSubmitted: 0,
				stopReason: "max_turns_reached",
				finalSnapshot: snapshot(),
			};
		}

		if (hasReachedWallClockBudget()) {
			return { turnsSubmitted, stopReason: "wall_clock_budget_reached", finalSnapshot: snapshot() };
		}

		while (turnsSubmitted < options.maxTurns) {
			const beforeSnapshot = snapshot();
			if (beforeSnapshot.continuation.action !== "continue") {
				return { turnsSubmitted, stopReason: "continuation_not_allowed", finalSnapshot: beforeSnapshot };
			}

			const state = beforeSnapshot.goalState;
			const beforeKey = state
				? `${state.goalId}:${state.updatedAt}:${state.events.length}:${state.stallTurns}:${state.status}`
				: undefined;

			const result = await this.continueGoalOnce(options);
			if (result.submitted) {
				turnsSubmitted++;
			}

			if (hasReachedWallClockBudget()) {
				return { turnsSubmitted, stopReason: "wall_clock_budget_reached", finalSnapshot: snapshot() };
			}

			const afterSnapshot = snapshot();
			if (afterSnapshot.continuation.action !== "continue") {
				return { turnsSubmitted, stopReason: "continuation_not_allowed", finalSnapshot: afterSnapshot };
			}

			const afterState = afterSnapshot.goalState;
			const afterKey = afterState
				? `${afterState.goalId}:${afterState.updatedAt}:${afterState.events.length}:${afterState.stallTurns}:${afterState.status}`
				: undefined;

			if (beforeKey === afterKey) {
				return { turnsSubmitted, stopReason: "goal_state_not_advanced", finalSnapshot: afterSnapshot };
			}
		}

		return {
			turnsSubmitted,
			stopReason: "max_turns_reached",
			finalSnapshot: snapshot(),
		};
	}
}
