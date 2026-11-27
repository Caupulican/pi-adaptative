/**
 * Typed execution-admission signals, kept in their own module so both the goal session controller
 * (which throws them) and the goal continuation loop (which must recognize them) can import without
 * creating a cycle between `goal-session-controller.ts` and `../goal-loop-controller.ts`.
 */

import type { AssistantMessage } from "@caupulican/pi-ai";
import { classifyFailure } from "../../kernel/reliability/index.ts";
import { MAX_SESSION_ENTRY_VISIT_COUNT, type SessionManager } from "../../kernel/session/session-manager.ts";
import { type GoalContinuationTurnOutcome, isInterruptedAssistantStopReason } from "../agent-session-contracts.ts";

import type { GoalState } from "./goal-state.ts";

/** Telemetry for a root turn belongs to the generation that admitted it. */
export function submittedGoalTurn(goal: GoalState, outcome: GoalContinuationTurnOutcome["outcome"]) {
	return {
		turns: 1,
		wallClockMs: 0,
		goalId: goal.goalId,
		progressRevision: goal.progressRevision ?? 0,
		stallTurns: goal.stallTurns,
		outcome,
		...(outcome === "completed" ? { completionTurn: (goal.continuationTurnsUsed ?? 0) + 1 } : {}),
	};
}

/** Classified reasons that mean the provider, not the harness, ended the turn. */
const PROVIDER_FAILURE_REASONS: ReadonlySet<string> = new Set([
	"overloaded",
	"rate_limit",
	"server_error",
	"network",
	"stream_stall",
	"auth",
	"billing_or_quota",
]);

export function isGoalProviderFailure(reason: string): boolean {
	return PROVIDER_FAILURE_REASONS.has(reason);
}

export function getContinuationTurnOutcome(
	sessionManager: SessionManager,
	firstTurnEntryIndex: number,
	provider?: string,
): GoalContinuationTurnOutcome {
	const endIndex = sessionManager.getEntryCount();
	let nextIndex = firstTurnEntryIndex;
	let lastAssistant: Pick<AssistantMessage, "stopReason" | "errorMessage"> | undefined;
	while (nextIndex < endIndex) {
		const visitCount = Math.min(MAX_SESSION_ENTRY_VISIT_COUNT, endIndex - nextIndex);
		nextIndex = sessionManager.visitEntries(nextIndex, visitCount, (entry) => {
			if (entry.type === "message" && entry.message.role === "assistant") {
				lastAssistant = { stopReason: entry.message.stopReason, errorMessage: entry.message.errorMessage };
			}
		});
	}
	if (!lastAssistant) return { outcome: "interrupted" };
	if (lastAssistant.stopReason === "error" && lastAssistant.errorMessage) {
		// Only provider failures block the goal. Harness-owned stops have their own recovery paths.
		const classified = classifyFailure({
			message: lastAssistant.errorMessage,
			provider,
		});
		if (isGoalProviderFailure(classified.reason)) {
			return { outcome: "errored", errorMessage: lastAssistant.errorMessage };
		}
	}
	return { outcome: isInterruptedAssistantStopReason(lastAssistant.stopReason) ? "interrupted" : "completed" };
}

/**
 * Thrown by `GoalSessionController#admitProviderRequest` when a goal's token budget is exhausted —
 * either already recorded (`status: "budget_limited"`) or just crossed by this very admission. The
 * durable stop (`markBudgetLimited`) is always applied synchronously BEFORE this is thrown, so by the
 * time a caller observes it the goal state already reflects the clean stop. Callers that own a
 * bounded "keep going until told to stop" contract (the goal continuation loop) must recognize this
 * distinctly from a genuine unexpected failure and report their own clean stop reason instead of
 * reclassifying an intentional, already-recorded stop as a continuation failure.
 */
/** A System One route ran as a root turn and the owner interrupted it; the goal stays as it was. */
export class ObjectiveRootTurnInterruptedError extends Error {
	constructor() {
		super("The root turn System One routed was interrupted.");
		this.name = "ObjectiveRootTurnInterruptedError";
	}
}

/** A System One route ran as a root turn and the provider failed it after the loop's own retries. */
export class ObjectiveRootTurnErroredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ObjectiveRootTurnErroredError";
	}
}

export class GoalBudgetExhaustedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GoalBudgetExhaustedError";
	}
}
