import { MAX_GOAL_OBJECTIVE_LENGTH } from "./goal-state.ts";

export interface ExplicitChatGoal {
	objective: string;
	tokenBudget?: number;
}

export interface ExplicitGoalStartAuthority {
	tokenBudget?: number;
}

const EXPLICIT_GOAL_PATTERNS = [
	/^\s*set\s+(?:this\s+as\s+)?a\s+(?:persistent\s+)?goal\s*(?::|to\s+)\s*(.+)$/is,
	/^\s*my\s+persistent\s+goal\s+is\s+to\s+(.+)$/is,
	/^\s*(?:the|our)\s+(?:persistent\s+)?goal\s+is\s+to\s+(.+)$/is,
	/^\s*treat\s+this\s+as\s+my\s+(?:persistent\s+)?goal\s*:\s*(.+)$/is,
	/^\s*i\s+want\s+this\s+as\s+(?:my\s+)?(?:persistent\s+)?goal\s*:\s*(.+)$/is,
	/^\s*keep\s+working\s+until\s+this\s+is\s+(?:complete|done)\s*:\s*(.+)$/is,
] as const;

const STANDALONE_GOAL_AUTHORITY_PATTERNS = [
	/^\s*(?:this|that)\s+is\s+(?:now\s+)?a\s+(?:persistent\s+)?goal(?:\s+(?:with|using)\s+.+)?[.!]?\s*$/is,
	/^\s*(?:make|treat)\s+this\s+(?:as\s+)?(?:my\s+|a\s+)?(?:persistent\s+)?goal(?:\s+(?:with|using)\s+.+)?[.!]?\s*$/is,
] as const;

function parsePositiveTokenCount(raw: string, suffix: string | undefined): number | undefined {
	const value = Number(raw.replace(/[,_]/g, ""));
	const multiplier = suffix?.toLowerCase() === "m" ? 1_000_000 : suffix?.toLowerCase() === "k" ? 1_000 : 1;
	const tokens = value * multiplier;
	return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}

function parseRequestedTokenBudget(text: string): number | undefined {
	const patterns = [
		/\btoken\s+budget\s*(?:of|is|:|=)?\s*([0-9][0-9,_.]*)([km])?\b/i,
		/\b([0-9][0-9,_.]*)([km])?\s*(?:token|tokens)\s+budget\b/i,
		/\bbudget\s*(?:of|is|:|=)?\s*([0-9][0-9,_.]*)([km])?\s*(?:token|tokens)\b/i,
	] as const;
	for (const pattern of patterns) {
		const match = pattern.exec(text);
		const tokens = match ? parsePositiveTokenCount(match[1], match[2]) : undefined;
		if (tokens !== undefined) return tokens;
	}
	return undefined;
}

/**
 * Recognize only explicit persistence language. Ordinary multi-step work and discussion ABOUT goal
 * mechanics deliberately return undefined; those must not silently expand into autonomous work.
 */
export function parseExplicitChatGoal(text: string): ExplicitChatGoal | undefined {
	for (const pattern of EXPLICIT_GOAL_PATTERNS) {
		const objective = pattern.exec(text)?.[1]?.trim();
		if (!objective || objective.length > MAX_GOAL_OBJECTIVE_LENGTH) continue;
		const tokenBudget = parseRequestedTokenBudget(text);
		return { objective, ...(tokenBudget !== undefined ? { tokenBudget } : {}) };
	}
	return undefined;
}

/** Exact owner authority for model-facing goal creation; ordinary work and meta-discussion fail closed. */
export function parseExplicitGoalStartAuthority(text: string): ExplicitGoalStartAuthority | undefined {
	const goal = parseExplicitChatGoal(text);
	if (goal) return goal.tokenBudget === undefined ? {} : { tokenBudget: goal.tokenBudget };
	if (!STANDALONE_GOAL_AUTHORITY_PATTERNS.some((pattern) => pattern.test(text))) return undefined;
	const tokenBudget = parseRequestedTokenBudget(text);
	return tokenBudget === undefined ? {} : { tokenBudget };
}
