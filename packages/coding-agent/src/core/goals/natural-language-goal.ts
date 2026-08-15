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
	// After "goal" require end, whitespace, or punctuation — not a hyphen — so
	// "this is a goal, use it" authorizes while "this is a goal-oriented design" does not.
	/^\s*(?:this|that)\s+is\s+(?:now\s+)?a\s+(?:persistent\s+)?goal(?=[\s,.:;!?]|$)/is,
	/^\s*(?:this|the|that)\s+task\s+is\s+(?:now\s+)?a\s+(?:persistent\s+)?goal(?=[\s,.:;!?]|$)/is,
	/^\s*(?:make|treat)\s+this\s+(?:as\s+)?(?:my\s+|a\s+)?(?:persistent\s+)?goal(?=[\s,.:;!?]|$)/is,
	/^\s*(?:make|treat)\s+this\s+task\s+(?:as\s+)?(?:my\s+|a\s+)?(?:persistent\s+)?goal(?=[\s,.:;!?]|$)/is,
] as const;

const STANDALONE_GOAL_FILLER = /^(?:use it|please|now|ok|okay|thanks|go|do it)(?:[.!?])?$/i;

/** Raised when text unambiguously states a token-budget directive but the amount cannot be resolved
 * to an exact positive integer. Callers must let this propagate as a loud, explicit failure instead
 * of falling back to an unbounded goal. */
export class GoalTokenBudgetParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GoalTokenBudgetParseError";
	}
}

const TOKEN_UNIT_MULTIPLIERS: Record<string, number> = {
	k: 1_000,
	thousand: 1_000,
	m: 1_000_000,
	million: 1_000_000,
};

/**
 * Resolve a matched numeral into a plain integer, disambiguating a thousands separator from a
 * decimal point. Comma is never a decimal point in this grammar, so any comma-grouped digits
 * (e.g. "5,000") are treated as a separator. A dot is genuinely ambiguous ("1.5" vs "1.000.000"),
 * so it is only treated as a separator when the exactly-3-digit group repeats (e.g. "1.000.000");
 * a single dot group falls back to a literal decimal (e.g. "1.5", or "1.000" read as 1).
 */
function normalizeTokenNumeral(raw: string): number | undefined {
	// The caller's capture regex allows "," "_" "." to continue a numeral (they can be internal
	// separators), so it greedily swallows a trailing one that is NOT followed by more digits — e.g.
	// the sentence-ending "." after a dot-grouped "1.000.000." A separator is only ever meaningful
	// between digits, so a trailing one is always incidental punctuation; drop it before classifying.
	const compact = raw.replace(/_/g, "").replace(/[,.]+$/, "");
	if (/^[0-9]+$/.test(compact)) return Number(compact);
	if (/^[0-9]{1,3}(,[0-9]{3})+\.[0-9]+$/.test(compact)) return Number(compact.replace(/,/g, ""));
	if (/^[0-9]{1,3}(,[0-9]{3})+$/.test(compact)) return Number(compact.replace(/,/g, ""));
	if (/^[0-9]{1,3}(\.[0-9]{3}){2,}$/.test(compact)) return Number(compact.replace(/\./g, ""));
	if (/^[0-9]+\.[0-9]+$/.test(compact)) return Number(compact);
	return undefined;
}

function parsePositiveTokenCount(raw: string, unit: string | undefined): number | undefined {
	const value = normalizeTokenNumeral(raw);
	if (value === undefined) return undefined;
	const multiplier = unit ? (TOKEN_UNIT_MULTIPLIERS[unit.toLowerCase()] ?? 1) : 1;
	const tokens = value * multiplier;
	return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}

const TOKEN_BUDGET_PATTERNS = [
	/\btoken\s+budget\s*(?:of|is|:|=)?\s*([0-9][0-9,_.]*)(?:\s*(thousand|million|k|m)\b)?/i,
	/\b([0-9][0-9,_.]*)(?:\s*(thousand|million|k|m)\b)?\s*(?:token|tokens)\s+budget\b/i,
	/\bbudget\s*(?:of|is|:|=)?\s*([0-9][0-9,_.]*)(?:\s*(thousand|million|k|m)\b)?\s*(?:token|tokens)\b/i,
] as const;

/**
 * Scan `text` for one explicit token-budget directive. When `trailingOnly` is set, a match only
 * counts if it runs to the end of `text` (ignoring closing punctuation/whitespace) — used to scan
 * inside a captured goal objective, where a budget-shaped phrase embedded mid-sentence usually
 * describes the task's subject matter (e.g. a constant being edited in code), not the agent's own
 * execution ceiling, whereas a trailing clause ("... with a 40k token budget.") is a real directive.
 */
function scanTokenBudget(text: string, options: { trailingOnly: boolean }): number | undefined {
	for (const pattern of TOKEN_BUDGET_PATTERNS) {
		const match = pattern.exec(text);
		if (!match) continue;
		if (options.trailingOnly) {
			const tail = text.slice(match.index + match[0].length);
			if (!/^[.!?]?\s*$/.test(tail)) continue;
		}
		const tokens = parsePositiveTokenCount(match[1], match[2]);
		if (tokens === undefined) {
			throw new GoalTokenBudgetParseError(
				`Token budget phrase "${match[0].trim()}" could not be parsed into an exact token ceiling.`,
			);
		}
		return tokens;
	}
	return undefined;
}

/**
 * Parse an explicit token-budget directive from `text`. When `objective` locates a captured goal
 * objective within `text`, a budget-shaped phrase found INSIDE it only counts when it is the
 * trailing clause of the objective; text outside the objective (the prefix/suffix around it) is
 * scanned without that restriction. This keeps a genuine directive ("... with a 40k token budget.")
 * working while refusing to adopt a number that is merely part of the task's own subject matter
 * ("raise the model token budget of 4096 ... to 8192").
 */
export function parseRequestedTokenBudget(
	text: string,
	objective?: { start: number; end: number },
): number | undefined {
	if (!objective) return scanTokenBudget(text, { trailingOnly: false });
	const outside = `${text.slice(0, objective.start)} ${text.slice(objective.end)}`;
	const outsideBudget = scanTokenBudget(outside, { trailingOnly: false });
	if (outsideBudget !== undefined) return outsideBudget;
	return scanTokenBudget(text.slice(objective.start, objective.end), { trailingOnly: true });
}

/**
 * Recognize only explicit persistence language. Ordinary multi-step work and discussion ABOUT goal
 * mechanics deliberately return undefined; those must not silently expand into autonomous work.
 */
function standaloneGoalRemainder(text: string): string | undefined {
	for (const pattern of STANDALONE_GOAL_AUTHORITY_PATTERNS) {
		const match = pattern.exec(text);
		if (!match) continue;
		return text
			.slice(match.index + match[0].length)
			.replace(/^[\s,.:;!?-]+/, "")
			.replace(/^(?:and|then|so)\s+/i, "")
			.trim();
	}
	return undefined;
}

function remainderWithoutBudgetPhrase(remainder: string): string {
	let next = remainder;
	for (const pattern of TOKEN_BUDGET_PATTERNS) {
		next = next.replace(pattern, " ");
	}
	return next
		.replace(/\b(?:with|of|is|a|the|:|=)\b/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function isBudgetOnlyRemainder(remainder: string): boolean {
	if (!remainder || STANDALONE_GOAL_FILLER.test(remainder)) return true;
	try {
		if (parseRequestedTokenBudget(remainder) === undefined) return false;
	} catch {
		return false;
	}
	const leftover = remainderWithoutBudgetPhrase(remainder);
	return leftover.length === 0 || STANDALONE_GOAL_FILLER.test(leftover);
}

function userMessageText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" &&
				block !== null &&
				"type" in block &&
				block.type === "text" &&
				"text" in block &&
				typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("")
		.trim();
}

/** Latest owner prompt that is not the current classification phrase itself. */
export function priorUserPromptText(
	messages: readonly { role: string; content?: unknown }[],
	currentText: string,
): string | undefined {
	const current = currentText.trim();
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "user") continue;
		const text = userMessageText(message.content);
		if (!text || text === current) continue;
		return text;
	}
	return undefined;
}

export function parseExplicitChatGoal(text: string, priorUserText?: string): ExplicitChatGoal | undefined {
	for (const pattern of EXPLICIT_GOAL_PATTERNS) {
		const match = pattern.exec(text);
		const rawObjective = match?.[1];
		const objective = rawObjective?.trim();
		if (!match || !objective || objective.length > MAX_GOAL_OBJECTIVE_LENGTH) continue;
		// rawObjective is always a suffix of match[0] (every pattern ends in `(.+)$`), so its start
		// offset in `text` is match[0]'s length minus its own length.
		const objectiveSpan = {
			start: match.index + (match[0].length - (rawObjective?.length ?? 0)),
			end: match.index + match[0].length,
		};
		const tokenBudget = parseRequestedTokenBudget(text, objectiveSpan);
		return { objective, ...(tokenBudget !== undefined ? { tokenBudget } : {}) };
	}
	const remainder = standaloneGoalRemainder(text);
	if (remainder === undefined) return undefined;
	const tokenBudget = parseRequestedTokenBudget(text);
	const inline = remainder && !isBudgetOnlyRemainder(remainder) ? remainder : undefined;
	const prior = priorUserText?.trim();
	const objective =
		inline && inline.length <= MAX_GOAL_OBJECTIVE_LENGTH
			? inline
			: prior && prior !== text.trim() && prior.length <= MAX_GOAL_OBJECTIVE_LENGTH
				? prior
				: undefined;
	if (!objective) return undefined;
	return { objective, ...(tokenBudget !== undefined ? { tokenBudget } : {}) };
}

/** Exact owner authority for model-facing goal creation; ordinary work and meta-discussion fail closed. */
export function parseExplicitGoalStartAuthority(text: string): ExplicitGoalStartAuthority | undefined {
	const goal = parseExplicitChatGoal(text);
	if (goal) return goal.tokenBudget === undefined ? {} : { tokenBudget: goal.tokenBudget };
	if (!STANDALONE_GOAL_AUTHORITY_PATTERNS.some((pattern) => pattern.test(text))) return undefined;
	const tokenBudget = parseRequestedTokenBudget(text);
	return tokenBudget === undefined ? {} : { tokenBudget };
}
