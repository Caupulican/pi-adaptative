import { MAX_GOAL_OBJECTIVE_LENGTH } from "./goal-state.ts";

export interface ExplicitChatGoal {
	objective: string;
}

const EXPLICIT_GOAL_PATTERNS = [
	/^\s*set\s+(?:this\s+as\s+)?a\s+(?:persistent\s+)?goal\s*(?::|to\s+)\s*(.+)$/is,
	/^\s*my\s+persistent\s+goal\s+is\s+to\s+(.+)$/is,
	/^\s*(?:the|our)\s+(?:persistent\s+)?goal\s+is\s+to\s+(.+)$/is,
	/^\s*treat\s+this\s+as\s+my\s+(?:persistent\s+)?goal\s*:\s*(.+)$/is,
	/^\s*i\s+want\s+this\s+as\s+(?:my\s+)?(?:persistent\s+)?goal\s*:\s*(.+)$/is,
	/^\s*keep\s+working\s+until\s+this\s+is\s+(?:complete|done)\s*:\s*(.+)$/is,
] as const;

/**
 * Recognize only explicit persistence language. Ordinary multi-step work and discussion ABOUT goal
 * mechanics deliberately return undefined; those must not silently expand into autonomous work.
 */
export function parseExplicitChatGoal(text: string): ExplicitChatGoal | undefined {
	for (const pattern of EXPLICIT_GOAL_PATTERNS) {
		const objective = pattern.exec(text)?.[1]?.trim();
		if (!objective || objective.length > MAX_GOAL_OBJECTIVE_LENGTH) continue;
		return { objective };
	}
	return undefined;
}
