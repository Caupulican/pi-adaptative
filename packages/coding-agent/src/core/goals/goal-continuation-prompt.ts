/** Hidden turn trigger. The current goal record is injected ephemerally during context assembly. */
export const GOAL_CONTINUATION_TRIGGER_CUSTOM_TYPE = "goal_continuation_trigger";

export interface GoalContinuationPrompt {
	text: string;
	truncated: false;
}

/**
 * Keep the persisted trigger constant and tiny. Dynamic objective and usage fields belong to the
 * ephemeral compact projection, never to the append-only transcript.
 */
export function buildGoalContinuationPrompt(): GoalContinuationPrompt {
	return {
		text: "Continue working toward the active goal.",
		truncated: false,
	};
}
