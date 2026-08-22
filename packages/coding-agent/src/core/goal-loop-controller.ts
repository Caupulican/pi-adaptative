/**
 * Goal auto-continuation loop.
 *
 * Extracted verbatim from agent-session.ts (god-file decomposition). Drives the bounded "keep the
 * active goal moving" loop: each pass reads the goal runtime snapshot, and — only while the snapshot
 * says `continue` — submits one continuation prompt back through the session's own prompt path. It
 * owns no state; the goal state lives in the session log and is read fresh every pass. Termination is
 * gated only by real terminal conditions and limits the owner explicitly supplied: an optional
 * per-invocation turn cap, an optional per-invocation wall-clock cap, and an optional durable token
 * budget on the goal. Each submitted pass still reports turn/wall-clock telemetry; provider usage
 * and spend are attributed at the response boundary. The host compares each pass's authoritative
 * progress revision and records unchanged passes as stalls, so the continuation prompt can force
 * a different recovery approach even when a model omits a voluntary `no_progress` call.
 */

import { AgentBusyError } from "@caupulican/pi-agent-core/agent";
import type {
	GoalContinuationLoopOptions,
	GoalContinuationLoopResult,
	GoalContinuationLoopStopReason,
	GoalContinuationOnceOptions,
	GoalContinuationOnceResult,
	PromptOptions,
} from "./agent-session-contracts.ts";
import {
	buildGoalContinuationPrompt,
	GOAL_CONTINUATION_TRIGGER_CUSTOM_TYPE,
} from "./goals/goal-continuation-prompt.ts";
import { GoalBudgetExhaustedError } from "./goals/goal-execution-errors.ts";
import type { GoalRuntimeSnapshot, GoalRuntimeSnapshotSettings } from "./goals/goal-runtime-snapshot.ts";
import { type GoalState, isGoalExecutionActive } from "./goals/goal-state.ts";

/**
 * Resolve an owner-supplied durable goal budget. Wall-clock and spend counters are deliberately
 * absent here: they are telemetry unless the public goal contract grows matching explicit limits.
 * Execution limits are policy inputs, not hidden runtime defaults.
 */
function getExplicitGoalBudgetExhaustion(state: GoalState | undefined): string | undefined {
	if (!state || !isGoalExecutionActive(state.status)) return undefined;
	if (state.tokenBudget !== undefined && (state.tokensUsed ?? 0) >= state.tokenBudget) {
		return `token budget exhausted (${state.tokensUsed ?? 0}/${state.tokenBudget})`;
	}
	return undefined;
}

/**
 * Maps a non-"continue" continuation action onto the loop's own stopReason vocabulary.
 * `"waiting"` (a worker is dispatched against an open requirement) gets its OWN benign stopReason so
 * a wait is never misreported as `continuation_not_allowed` (which reads as a terminal refusal) —
 * callers/telemetry can tell "paused, will resume on its own" apart from "stopped, needs a human or a
 * new decision." Every other non-continue action (ask-user/finalize/stop) keeps the existing
 * `continuation_not_allowed` stopReason unchanged.
 */
function nonContinueStopReason(snapshot: GoalRuntimeSnapshot): GoalContinuationLoopStopReason {
	return snapshot.continuation.action === "waiting" ? "worker_in_flight" : "continuation_not_allowed";
}

export interface GoalLoopControllerDeps {
	/** Read the current goal runtime snapshot (continuation decision + goal state) fresh each pass. */
	getGoalRuntimeSnapshot(settings: GoalRuntimeSnapshotSettings): GoalRuntimeSnapshot;
	/** Submit a continuation prompt through the session's own prompt path. */
	prompt(text: string, options?: PromptOptions): Promise<"completed" | "interrupted">;
	/**
	 * Persist one submitted pass's turn and active-wall-clock contribution. Provider usage is charged
	 * at each assistant response before another request can be admitted. Called once per
	 * pass actually SUBMITTED (never for a no-op `continueGoalOnce` call).
	 */
	recordGoalContinuationPass(pass: {
		turns: number;
		wallClockMs: number;
		goalId: string;
		progressRevision: number;
		stallTurns: number;
	}): void;
	/** Persist an exhausted/non-retryable continuation failure as a stopped goal state. */
	recordGoalContinuationFailure(error: unknown): void;
	/** Persist a reason-specific budget terminal state before returning control. */
	markGoalBudgetLimited(reason: string): void;
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

		const prompt = buildGoalContinuationPrompt();
		const turnOutcome = await this.deps.prompt(prompt.text, {
			expandPromptTemplates: false,
			processSlashCommands: false,
			autoContinueGoal: false,
			internalContextType: GOAL_CONTINUATION_TRIGGER_CUSTOM_TYPE,
			goalExecutionId: snapshot.goalState?.goalId,
		});

		return { submitted: true, snapshot, prompt, turnOutcome };
	}

	async continueGoalLoop(options: GoalContinuationLoopOptions): Promise<GoalContinuationLoopResult> {
		if (!Number.isSafeInteger(options.maxTurns) || options.maxTurns < 0) {
			throw new Error("Goal continuation maxTurns must be a non-negative safe integer; 0 means unbounded.");
		}
		let turnsSubmitted = 0;
		const hasExplicitTurnLimit = options.maxTurns > 0;
		const now = options.now ?? Date.now;
		const maxWallClockMs =
			typeof options.maxWallClockMinutes === "number" && options.maxWallClockMinutes > 0
				? options.maxWallClockMinutes * 60_000
				: undefined;
		const startedAt = now();
		const hasReachedWallClockBudget = () => maxWallClockMs !== undefined && now() - startedAt >= maxWallClockMs;
		const snapshot = () => this.deps.getGoalRuntimeSnapshot({ maxStallTurns: options.maxStallTurns });

		if (hasReachedWallClockBudget()) {
			return { turnsSubmitted, stopReason: "wall_clock_budget_reached", finalSnapshot: snapshot() };
		}

		while (!hasExplicitTurnLimit || turnsSubmitted < options.maxTurns) {
			const beforeSnapshot = snapshot();
			if (beforeSnapshot.continuation.action !== "continue") {
				return { turnsSubmitted, stopReason: nonContinueStopReason(beforeSnapshot), finalSnapshot: beforeSnapshot };
			}

			// Owner-supplied durable token budget — read fresh every pass so an invocation stops as
			// soon as its own latest persisted usage crosses the explicit ceiling.
			const beforeBudgetExhaustion = getExplicitGoalBudgetExhaustion(beforeSnapshot.goalState);
			if (beforeBudgetExhaustion) {
				this.deps.markGoalBudgetLimited(beforeBudgetExhaustion);
				return { turnsSubmitted, stopReason: "goal_budget_exhausted", finalSnapshot: snapshot() };
			}

			const passStartedAt = now();
			const beforeGoal = beforeSnapshot.goalState;
			if (!beforeGoal) {
				return { turnsSubmitted, stopReason: "continuation_not_allowed", finalSnapshot: beforeSnapshot };
			}
			const passAccounting = {
				turns: 1,
				goalId: beforeGoal.goalId,
				progressRevision: beforeGoal.progressRevision ?? 0,
				stallTurns: beforeGoal.stallTurns,
			};
			let result: GoalContinuationOnceResult;
			try {
				result = await this.continueGoalOnce(options);
			} catch (error) {
				// Prompt admission did not happen. A concurrent foreground owner is transient session
				// coordination, not a consumed goal turn and not evidence that the goal is blocked.
				if (error instanceof AgentBusyError) throw error;
				if (error instanceof GoalBudgetExhaustedError) {
					// The goal already stopped itself durably (markBudgetLimited ran synchronously before
					// this signal was thrown) — surface the existing clean stop instead of charging a turn.
					return { turnsSubmitted, stopReason: "goal_budget_exhausted", finalSnapshot: snapshot() };
				}
				turnsSubmitted++;
				this.deps.recordGoalContinuationPass({ ...passAccounting, wallClockMs: now() - passStartedAt });
				this.deps.recordGoalContinuationFailure(error);
				throw error;
			}
			if (result.submitted) {
				turnsSubmitted++;
				this.deps.recordGoalContinuationPass({ ...passAccounting, wallClockMs: now() - passStartedAt });
			}

			let afterSnapshot = snapshot();
			if (afterSnapshot.goalState?.status === "budget_limited") {
				return { turnsSubmitted, stopReason: "goal_budget_exhausted", finalSnapshot: afterSnapshot };
			}
			const afterBudgetExhaustion = getExplicitGoalBudgetExhaustion(afterSnapshot.goalState);
			if (afterBudgetExhaustion) {
				this.deps.markGoalBudgetLimited(afterBudgetExhaustion);
				afterSnapshot = snapshot();
				return { turnsSubmitted, stopReason: "goal_budget_exhausted", finalSnapshot: afterSnapshot };
			}
			if (afterSnapshot.continuation.action !== "continue") {
				return { turnsSubmitted, stopReason: nonContinueStopReason(afterSnapshot), finalSnapshot: afterSnapshot };
			}
			if (result.turnOutcome === "interrupted") {
				return { turnsSubmitted, stopReason: "turn_interrupted", finalSnapshot: afterSnapshot };
			}
			if (hasReachedWallClockBudget()) {
				return { turnsSubmitted, stopReason: "wall_clock_budget_reached", finalSnapshot: afterSnapshot };
			}
		}

		return {
			turnsSubmitted,
			stopReason: "max_turns_reached",
			finalSnapshot: snapshot(),
		};
	}
}
