import type { GoalState } from "../goals/goal-state.ts";
import type { MemoryPromptBudget } from "./memory-prompt-budget.ts";
import { hasSecretLikeMemoryText } from "./memory-provider-contract.ts";

export type LongTermMemoryTriggerReason =
	| "explicit_recall"
	| "goal_continuation_missing_context"
	| "user_or_project_preference"
	| "durable_identifier"
	| "missing_background"
	| "short_or_grounded_turn"
	| "budget_disabled"
	| "secret_like_query";

export interface LongTermMemoryTriggerInput {
	latestUserText: string;
	goalState?: GoalState;
	budget?: MemoryPromptBudget;
	currentWorkCandidateCount?: number;
}

export interface LongTermMemoryTriggerDecision {
	shouldQuery: boolean;
	reason: LongTermMemoryTriggerReason;
}

const EXPLICIT_RECALL_RE = /\b(recall|remember|memory|memories|resume|previous|prior|before|history)\b/i;
const PREFERENCE_RE = /\b(preferences?|prefers?|rules?|instructions?|policy|how should|how do you usually|project context|user context)\b/i;
const DURABLE_ID_RE = /\b(?:goal-[a-z0-9-]+|[A-Z]+-\d+|#[0-9]+|[a-f0-9]{8,40}|build\s*#?\d+|artifact|trello|jenkins|branch)\b/i;
const MISSING_BACKGROUND_RE = /\b(context|background|what did|where were|what was|remind me|familiar|ready)\b/i;

function substantial(text: string): boolean {
	return text
		.trim()
		.split(/\s+/)
		.filter((word) => word.length >= 3).length >= 3;
}

export function shouldQueryLongTermMemory(input: LongTermMemoryTriggerInput): LongTermMemoryTriggerDecision {
	const text = input.latestUserText.trim();
	if (input.budget !== undefined && !input.budget.enabled) return { shouldQuery: false, reason: "budget_disabled" };
	if (hasSecretLikeMemoryText(text)) return { shouldQuery: false, reason: "secret_like_query" };

	if (EXPLICIT_RECALL_RE.test(text)) return { shouldQuery: true, reason: "explicit_recall" };
	if (PREFERENCE_RE.test(text)) return { shouldQuery: true, reason: "user_or_project_preference" };
	if (DURABLE_ID_RE.test(text)) return { shouldQuery: true, reason: "durable_identifier" };
	if (MISSING_BACKGROUND_RE.test(text)) return { shouldQuery: true, reason: "missing_background" };

	const activeGoal = input.goalState?.status === "active" ? input.goalState : undefined;
	if (activeGoal !== undefined && text.length === 0 && activeGoal.requirements.some((requirement) => requirement.status === "open")) {
		return { shouldQuery: true, reason: "goal_continuation_missing_context" };
	}

	if (!substantial(text)) return { shouldQuery: false, reason: "short_or_grounded_turn" };
	if ((input.currentWorkCandidateCount ?? 0) > 0 && input.budget?.compact) {
		return { shouldQuery: false, reason: "short_or_grounded_turn" };
	}
	return { shouldQuery: false, reason: "short_or_grounded_turn" };
}
