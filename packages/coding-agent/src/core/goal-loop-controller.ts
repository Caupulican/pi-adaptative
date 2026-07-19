/**
 * Goal auto-continuation loop.
 *
 * Extracted verbatim from agent-session.ts (god-file decomposition). Drives the bounded "keep the
 * active goal moving" loop: each pass reads the goal runtime snapshot, and — only while the snapshot
 * says `continue` — submits one continuation prompt back through the session's own prompt path. It
 * owns no state; the goal state lives in the session log and is read fresh every pass. Termination is
 * fully budget-gated (per-invocation turn cap, per-invocation wall-clock cap, a DURABLE cumulative
 * per-goal budget — turns + active wall-clock, persisted on `GoalState` across every invocation for
 * the goal's lifetime — and a no-progress guard on a MEANINGFUL progress signature — satisfied-
 * requirement count + ref-backed evidence count — so hollow goal-tool calls (e.g. add_requirement/
 * reopen churn that satisfies nothing) cannot defeat the stall guard). Each submitted pass also
 * reports its turn/wall-clock/spend contribution back to the session via `recordGoalContinuationPass`
 * so the cumulative budget stays accurate.
 */

import type {
	GoalContinuationLoopOptions,
	GoalContinuationLoopResult,
	GoalContinuationLoopStopReason,
	GoalContinuationOnceOptions,
	GoalContinuationOnceResult,
	PromptOptions,
} from "./agent-session.ts";
import {
	DEFAULT_GOAL_CUMULATIVE_MAX_TURNS,
	DEFAULT_GOAL_CUMULATIVE_MAX_WALL_CLOCK_MS,
	DEFAULT_GOAL_CUMULATIVE_MAX_WORKER_SPEND_USD,
} from "./goals/goal-continuation-defaults.ts";
import { buildGoalContinuationPrompt } from "./goals/goal-continuation-prompt.ts";
import type { GoalRuntimeSnapshot, GoalRuntimeSnapshotSettings } from "./goals/goal-runtime-snapshot.ts";
import type { GoalState } from "./goals/goal-state.ts";

/**
 * Progress signature for goal-loop stall detection. Keys ONLY on state that reflects actual
 * progress toward the goal — `goalId`, `status`, the count of satisfied requirements, and the
 * count of evidence entries that carry a ref (`uri`) AND are TRUSTED: either actually validated
 * (`verified === true`) or `kind === "user"` (a human-confirmed claim). Deliberately excludes
 * `events.length`, `updatedAt`, and `stallTurns`: those change on every goal-tool call (including
 * no-op churn like re-adding/reopening a requirement without satisfying anything), which let hollow
 * passes look like progress and defeat `goal_state_not_advanced`.
 *
 * `verified` is `undefined` both for evidence that hasn't been checked yet AND for evidence kinds
 * that carry no checkable ref at all (`"user"`/`"finding"`/`"test"` — see the doc comment on
 * `GoalEvidenceRef.verified` in `goal-state.ts`). Treating "undefined" as trusted would let a model spam
 * `kind:"finding"` evidence with a fabricated `uri` every turn — always undefined, always counted —
 * which is the same class of hollow churn this signature exists to stop. So `undefined` does NOT
 * count; only an explicit `verified === true` (a real, checked ref) or `kind === "user"` (mirrors
 * the `complete` gate's trusted set in `goal-tool-core.ts`'s `isVerifiedOrUserEvidence`) counts.
 * `satisfiedRequirementCount` still advances the signature for legitimate-but-unverifiable work
 * (e.g. `kind:"finding"`/`"test"` evidence cited on a `satisfy_requirement` call), and the
 * continuation controller's own `stallTurns` path remains available for the model to self-report.
 */
function goalProgressSignature(state: GoalState | undefined): string | undefined {
	if (!state) return undefined;
	const satisfiedRequirementCount = state.requirements.filter(
		(requirement) => requirement.status === "satisfied",
	).length;
	const refEvidenceCount = state.evidence.filter(
		(evidence) =>
			typeof evidence.uri === "string" &&
			evidence.uri.trim().length > 0 &&
			(evidence.verified === true || evidence.kind === "user"),
	).length;
	return `${state.goalId}:${state.status}:${satisfiedRequirementCount}:${refEvidenceCount}`;
}

/**
 * Whether the goal's DURABLE cumulative continuation budget (turns and/or active wall-clock,
 * persisted on `GoalState` and summed across every `continueGoalLoop` invocation for the goal's
 * lifetime) has been exhausted. Read fresh at the top of every pass (not just the top of the
 * invocation), so a single long-running invocation that crosses the ceiling mid-loop stops
 * immediately rather than waiting for the next invocation to notice. `undefined` counters (goal
 * state predating this field, or a fresh goal) count as `0` — never exhausted.
 */
function isGoalContinuationBudgetExhausted(state: GoalState | undefined): boolean {
	if (!state) return false;
	if ((state.continuationTurnsUsed ?? 0) >= DEFAULT_GOAL_CUMULATIVE_MAX_TURNS) return true;
	if ((state.continuationWallClockMs ?? 0) >= DEFAULT_GOAL_CUMULATIVE_MAX_WALL_CLOCK_MS) return true;
	if ((state.continuationWorkerSpendUsd ?? 0) >= DEFAULT_GOAL_CUMULATIVE_MAX_WORKER_SPEND_USD) return true;
	return false;
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
	prompt(text: string, options?: PromptOptions): Promise<void>;
	/**
	 * Persist one submitted pass's contribution to the active goal's durable cumulative budget
	 * (turns + active wall-clock; USD is attributed by the implementation from the session's own
	 * spend, not passed in here — see `AgentSession.recordGoalContinuationPass`). Called once per
	 * pass actually SUBMITTED (never for a no-op `continueGoalOnce` call).
	 */
	recordGoalContinuationPass(pass: { turns: number; wallClockMs: number }): void;
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
				return { turnsSubmitted, stopReason: nonContinueStopReason(beforeSnapshot), finalSnapshot: beforeSnapshot };
			}

			// Cumulative (durable, cross-invocation) budget — read fresh every pass, not just at the top
			// of this invocation, so a single long-running call still stops the moment it crosses the
			// ceiling rather than overshooting until the next invocation notices.
			if (isGoalContinuationBudgetExhausted(beforeSnapshot.goalState)) {
				return { turnsSubmitted, stopReason: "goal_budget_exhausted", finalSnapshot: beforeSnapshot };
			}

			const beforeKey = goalProgressSignature(beforeSnapshot.goalState);

			const passStartedAt = now();
			const result = await this.continueGoalOnce(options);
			if (result.submitted) {
				turnsSubmitted++;
				this.deps.recordGoalContinuationPass({ turns: 1, wallClockMs: now() - passStartedAt });
			}

			if (hasReachedWallClockBudget()) {
				return { turnsSubmitted, stopReason: "wall_clock_budget_reached", finalSnapshot: snapshot() };
			}

			const afterSnapshot = snapshot();
			if (afterSnapshot.continuation.action !== "continue") {
				return { turnsSubmitted, stopReason: nonContinueStopReason(afterSnapshot), finalSnapshot: afterSnapshot };
			}

			const afterKey = goalProgressSignature(afterSnapshot.goalState);

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
