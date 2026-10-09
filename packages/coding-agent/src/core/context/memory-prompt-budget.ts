import {
	charsWithinEstimatedTokens,
	estimateLineCount,
	estimateTokensFromChars,
	estimateTokensFromText,
} from "./context-item.ts";

export interface MemoryPromptBudgetInput {
	contextWindow?: number | null;
	currentPromptTokens?: number;
	reservedTokens?: number;
	configuredMaxResults?: number;
	/**
	 * Tokens the receiving request may still spend (a delegated lane's own grant and its tree's). It bounds the
	 * allowance the way window headroom does; a lane with none left gets a disabled budget, never full room.
	 */
	remainingTokenAllowance?: number;
	/** Ceiling for one on-demand read, in estimated tokens; the standing prompt block uses the default. */
	ceilingTokens?: number;
}

export interface MemoryPromptBudget {
	enabled: boolean;
	compact: boolean;
	maxLines: number;
	maxEstimatedTokens: number;
	maxChars: number;
	/**
	 * Ceiling on the block's UTF-8 byte length. Tokens and characters are estimates that read multi-byte
	 * text as cheap; bytes are the unit the wire and the stored record actually carry. Absent on a hand
	 * built allowance that sets no byte bound; every budget this module resolves sets it.
	 */
	maxBytes?: number;
	maxResults: number;
	reason?: string;
}

const COMPACT_CONTEXT_WINDOW_MAX = 2048;
const COMPACT_MAX_LINES = 10;
const COMPACT_MAX_TOKENS = 200;
const NORMAL_MAX_LINES = 20;
const NORMAL_MAX_TOKENS = 800;
/** Estimated tokens per line the standing block allows; a larger on-demand ceiling gets lines in proportion. */
const NORMAL_TOKENS_PER_LINE = NORMAL_MAX_TOKENS / NORMAL_MAX_LINES;
/**
 * Ceiling of one delegated-lane memory read: the former 8,000-character snapshot cut (four characters per
 * estimated token), now stated in the unit this budget enforces. The read is bounded by the receiving
 * lane's window, headroom and allowance below it, and its records are admitted whole, never cut.
 */
export const LANE_READ_MAX_ESTIMATED_TOKENS = 2000;
const DEFAULT_MAX_RESULTS = 5;
const MIN_MEMORY_LINE_CHARS = 48;

/** Generous bounded safety ceiling for maxChars, independent of token/line budget. */
const GENEROUS_MAX_CHARS = 64_000;

/**
 * UTF-8 bytes allowed per estimated token. The estimator reads four characters as one token, so
 * ASCII text reaches the token limit at four bytes per estimated token; eight leaves ASCII untouched
 * and caps text averaging more than two bytes per character at twice the ASCII byte weight.
 */
const MAX_BYTES_PER_ESTIMATED_TOKEN = 8;

function disabled(reason: string, compact = false): MemoryPromptBudget {
	return {
		enabled: false,
		compact,
		maxLines: 0,
		maxEstimatedTokens: 0,
		maxChars: 0,
		maxBytes: 0,
		maxResults: 0,
		reason,
	};
}

/**
 * Checks whether a text fits within a memory prompt budget.
 *
 * Enforces:
 * - `budget.enabled`
 * - `maxLines` via `estimateLineCount`
 * - `maxEstimatedTokens` via `estimateTokensFromText`
 * - `maxChars` strictly as a JS-character count (NOT UTF-8 bytes)
 * - `maxBytes`, when set, as the UTF-8 byte length (`Buffer.byteLength`)
 *
 * The `estimateTokensFromText` estimator is approximate (chars / 4);
 * no model tokenizer is used here. It must never be treated as
 * semantically critical.
 */
export function memoryTextFitsBudget(text: string, budget: MemoryPromptBudget): boolean {
	if (!budget.enabled) return false;
	if (
		[budget.maxLines, budget.maxEstimatedTokens, budget.maxChars, budget.maxBytes ?? 0].some(
			(limit) => !Number.isFinite(limit) || limit < 0,
		)
	) {
		return false;
	}
	if (estimateLineCount(text) > budget.maxLines) return false;
	if (estimateTokensFromText(text) > budget.maxEstimatedTokens) return false;
	// maxChars is a JS-character compatibility/resource bound, NOT UTF-8 bytes.
	if (text.length > budget.maxChars) return false;
	if (budget.maxBytes !== undefined && Buffer.byteLength(text, "utf8") > budget.maxBytes) return false;
	return true;
}

export function resolveMemoryPromptBudget(input: MemoryPromptBudgetInput): MemoryPromptBudget {
	const contextWindow = input.contextWindow ?? 0;
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return disabled("missing_context_window");

	const compact = contextWindow <= COMPACT_CONTEXT_WINDOW_MAX;
	const currentPromptTokens = Math.max(0, Math.trunc(input.currentPromptTokens ?? 0));
	if (!Number.isFinite(currentPromptTokens) || currentPromptTokens < 0)
		return disabled("invalid_current_prompt_tokens");
	const reservedTokens = Math.max(0, Math.trunc(input.reservedTokens ?? 0));
	if (!Number.isFinite(reservedTokens) || reservedTokens < 0) return disabled("invalid_reserved_tokens");
	const remainingTokenAllowance = input.remainingTokenAllowance;
	if (remainingTokenAllowance !== undefined && !(remainingTokenAllowance > 0)) {
		return disabled("no_token_allowance", compact);
	}
	const availableTokens = Math.min(
		Math.floor(contextWindow) - currentPromptTokens - reservedTokens,
		remainingTokenAllowance === undefined ? Number.POSITIVE_INFINITY : Math.floor(remainingTokenAllowance),
	);
	if (availableTokens <= 0) return disabled("no_context_headroom", compact);

	const configuredMaxResults = Math.max(1, Math.trunc(input.configuredMaxResults ?? DEFAULT_MAX_RESULTS));
	if (compact) {
		const maxEstimatedTokens = Math.min(COMPACT_MAX_TOKENS, Math.max(0, availableTokens));
		if (maxEstimatedTokens < estimateTokensFromChars(MIN_MEMORY_LINE_CHARS)) {
			return disabled("memory_block_cannot_fit_minimum_line", true);
		}
		return {
			enabled: true,
			compact: true,
			maxLines: COMPACT_MAX_LINES,
			maxEstimatedTokens,
			maxChars: GENEROUS_MAX_CHARS,
			maxBytes: maxEstimatedTokens * MAX_BYTES_PER_ESTIMATED_TOKEN,
			maxResults: Math.min(configuredMaxResults, 3),
		};
	}

	const percentCap = Math.max(200, Math.floor(contextWindow * 0.03));
	const maxEstimatedTokens = Math.min(input.ceilingTokens ?? NORMAL_MAX_TOKENS, percentCap, availableTokens);
	if (maxEstimatedTokens < estimateTokensFromChars(MIN_MEMORY_LINE_CHARS)) {
		return disabled("memory_block_cannot_fit_minimum_line", false);
	}
	return {
		enabled: true,
		compact: false,
		maxLines: Math.max(NORMAL_MAX_LINES, Math.ceil(maxEstimatedTokens / NORMAL_TOKENS_PER_LINE)),
		maxEstimatedTokens,
		maxChars: GENEROUS_MAX_CHARS,
		maxBytes: maxEstimatedTokens * MAX_BYTES_PER_ESTIMATED_TOKEN,
		maxResults: Math.min(configuredMaxResults, 10),
	};
}

/**
 * The share of one memory allowance that remains after other records of the same allowance (the history
 * frontier, a delegated lane's standing memory) took `reserved`. Every record is drawn from the one
 * headroom-derived budget, never from independent ones; a remainder that cannot hold a minimum line
 * disables the block.
 */
export function reserveMemoryPromptBudget(
	budget: MemoryPromptBudget,
	reserved: { bytes: number; estimatedTokens: number; lines?: number },
): MemoryPromptBudget {
	const lines = reserved.lines ?? 0;
	if (!budget.enabled || (reserved.bytes <= 0 && reserved.estimatedTokens <= 0 && lines <= 0)) return budget;
	const maxEstimatedTokens = Math.max(0, budget.maxEstimatedTokens - reserved.estimatedTokens);
	if (maxEstimatedTokens < estimateTokensFromChars(MIN_MEMORY_LINE_CHARS)) {
		return { ...disabled("reserved_records_consume_budget", budget.compact) };
	}
	return {
		...budget,
		maxEstimatedTokens,
		maxLines: Math.max(0, budget.maxLines - lines),
		...(budget.maxBytes !== undefined ? { maxBytes: Math.max(0, budget.maxBytes - reserved.bytes) } : {}),
	};
}

/**
 * A share (0..1) of one allowance, for the record that may take at most that fraction of it: tokens, lines
 * and bytes scale together, and a share that cannot hold a minimum line is disabled like any other.
 */
export function shareOfMemoryPromptBudget(budget: MemoryPromptBudget, share: number): MemoryPromptBudget {
	if (!budget.enabled) return budget;
	const maxEstimatedTokens = Math.floor(budget.maxEstimatedTokens * share);
	if (maxEstimatedTokens < estimateTokensFromChars(MIN_MEMORY_LINE_CHARS)) {
		return disabled("budget_share_cannot_fit_minimum_line", budget.compact);
	}
	return {
		...budget,
		maxEstimatedTokens,
		maxLines: Math.floor(budget.maxLines * share),
		...(budget.maxBytes !== undefined ? { maxBytes: Math.floor(budget.maxBytes * share) } : {}),
	};
}

/**
 * Bytes one record limited to `share` of the allowance may take. The byte ceiling is deliberately loose (it is
 * a multiple of the token ceiling), so a share of it alone would let the record spend every estimated token;
 * the record is also held to the share of the token ceiling, at the estimator's characters per token, which
 * bounds its characters because a character is at least one byte.
 */
export function memoryShareAllowanceBytes(budget: MemoryPromptBudget, share: number): number {
	if (!budget.enabled || budget.maxBytes === undefined) return 0;
	return Math.min(
		Math.floor(budget.maxBytes * share),
		charsWithinEstimatedTokens(Math.floor(budget.maxEstimatedTokens * share)),
	);
}

/**
 * An allowance bounded by characters alone, for a record set whose bound is a character count (the reflection
 * snapshot, the pre-compression handoff). Lines and tokens follow from the characters, so the composer's whole-
 * record admission is the only limit that bites.
 */
export function charBoundedMemoryPromptBudget(maxChars: number): MemoryPromptBudget {
	if (!(maxChars > 0)) return disabled("no_character_room");
	return {
		enabled: true,
		compact: false,
		maxLines: maxChars,
		maxEstimatedTokens: estimateTokensFromChars(maxChars),
		maxChars,
		maxResults: maxChars,
	};
}
