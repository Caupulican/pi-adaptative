import { estimateLineCount, estimateTokensFromChars, estimateTokensFromText } from "./context-item.ts";

export interface MemoryPromptBudgetInput {
	contextWindow?: number | null;
	currentPromptTokens?: number;
	reservedTokens?: number;
	configuredMaxResults?: number;
}

export interface MemoryPromptBudget {
	enabled: boolean;
	compact: boolean;
	maxLines: number;
	maxEstimatedTokens: number;
	maxChars: number;
	maxResults: number;
	reason?: string;
}

const COMPACT_CONTEXT_WINDOW_MAX = 2048;
const COMPACT_MAX_LINES = 10;
const COMPACT_MAX_TOKENS = 200;
const NORMAL_MAX_LINES = 20;
const NORMAL_MAX_TOKENS = 800;
const DEFAULT_MAX_RESULTS = 5;
const MIN_MEMORY_LINE_CHARS = 48;

/** Generous bounded safety ceiling for maxChars, independent of token/line budget. */
const GENEROUS_MAX_CHARS = 64_000;

function disabled(reason: string, compact = false): MemoryPromptBudget {
	return {
		enabled: false,
		compact,
		maxLines: 0,
		maxEstimatedTokens: 0,
		maxChars: 0,
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
 *
 * The `estimateTokensFromText` estimator is approximate (chars / 4);
 * no model tokenizer is used here. It must never be treated as
 * semantically critical.
 */
export function memoryTextFitsBudget(text: string, budget: MemoryPromptBudget): boolean {
	if (!budget.enabled) return false;
	if (
		[budget.maxLines, budget.maxEstimatedTokens, budget.maxChars].some(
			(limit) => !Number.isFinite(limit) || limit < 0,
		)
	) {
		return false;
	}
	if (estimateLineCount(text) > budget.maxLines) return false;
	if (estimateTokensFromText(text) > budget.maxEstimatedTokens) return false;
	// maxChars is a JS-character compatibility/resource bound, NOT UTF-8 bytes.
	if (text.length > budget.maxChars) return false;
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
	const availableTokens = Math.floor(contextWindow) - currentPromptTokens - reservedTokens;
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
			maxResults: Math.min(configuredMaxResults, 3),
		};
	}

	const percentCap = Math.max(200, Math.floor(contextWindow * 0.03));
	const maxEstimatedTokens = Math.min(NORMAL_MAX_TOKENS, percentCap, availableTokens);
	if (maxEstimatedTokens < estimateTokensFromChars(MIN_MEMORY_LINE_CHARS)) {
		return disabled("memory_block_cannot_fit_minimum_line", false);
	}
	return {
		enabled: true,
		compact: false,
		maxLines: NORMAL_MAX_LINES,
		maxEstimatedTokens,
		maxChars: GENEROUS_MAX_CHARS,
		maxResults: Math.min(configuredMaxResults, 10),
	};
}
