/**
 * Plans the start of a chat goal (an owner's words asked for one) against the session's current goal, read without saving
 * anything: the one place that decides whether a chat goal starts and with which identity.
 */

import { createHash } from "node:crypto";
import { type GoalState, isGoalUnfinishedStatus } from "./goal-state.ts";
import { applyGoalAction } from "./goal-tool-core.ts";
import type { ExplicitChatGoal } from "./natural-language-goal.ts";

export type ChatGoalAdmission =
	| { status: "not_explicit" }
	| { status: "started"; state: GoalState }
	| { status: "unfinished_goal_exists"; state: GoalState };

/** What starting `parsed` as a chat goal does against `current`. An unfinished goal is never replaced implicitly. */
export function planExplicitChatGoal(
	current: GoalState | undefined,
	parsed: ExplicitChatGoal | undefined,
	admittedAt: string,
): ChatGoalAdmission {
	if (!parsed) return { status: "not_explicit" };
	if (current && isGoalUnfinishedStatus(current.status)) {
		return { status: "unfinished_goal_exists", state: current };
	}
	const digest = createHash("sha256")
		.update(`${admittedAt}\0${current?.goalId ?? "none"}\0${parsed.objective}`)
		.digest("hex")
		.slice(0, 20);
	const result = applyGoalAction(
		current,
		{
			action: "start",
			goalId: `chat-${digest}`,
			userGoal: parsed.objective,
			tokenBudget: parsed.tokenBudget,
		},
		admittedAt,
	);
	if (!result.ok) throw new Error(result.error);
	return { status: "started", state: result.state };
}
