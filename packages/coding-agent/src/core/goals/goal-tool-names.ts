export const LEGACY_GOAL_TOOL_NAME = "goal" as const;

/** Compact provider-neutral lifecycle surface mirrored from Codex's durable goal contract. */
export const GOAL_LIFECYCLE_TOOL_NAMES = ["create_goal", "get_goal", "update_goal"] as const;

export type GoalLifecycleToolName = (typeof GOAL_LIFECYCLE_TOOL_NAMES)[number];

/** A continuation needs a tool that can terminalize the goal, not merely inspect it. */
export function hasGoalContinuationControl(toolNames: readonly string[]): boolean {
	return toolNames.includes(LEGACY_GOAL_TOOL_NAME) || toolNames.includes("update_goal");
}
