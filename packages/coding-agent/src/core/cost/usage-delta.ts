/**
 * Owns the arithmetic over readings of one cumulative usage ledger: the charge a span of work added, and how far two
 * readings reach together.
 */
import type { Usage } from "@caupulican/pi-ai";
import { createEmptyUsage } from "../../kernel/usage.ts";

/** Each token and dollar field of `a` and `b` combined by `combine`; provider breakdowns (`details`) are not carried. */
function fieldwise(a: Usage, b: Usage, combine: (a: number, b: number) => number): Usage {
	const result = createEmptyUsage();
	result.input = combine(a.input, b.input);
	result.output = combine(a.output, b.output);
	result.cacheRead = combine(a.cacheRead, b.cacheRead);
	result.cacheWrite = combine(a.cacheWrite, b.cacheWrite);
	result.totalTokens = combine(a.totalTokens, b.totalTokens);
	result.cost.input = combine(a.cost.input, b.cost.input);
	result.cost.output = combine(a.cost.output, b.cost.output);
	result.cost.cacheRead = combine(a.cost.cacheRead, b.cost.cacheRead);
	result.cost.cacheWrite = combine(a.cost.cacheWrite, b.cost.cacheWrite);
	result.cost.total = combine(a.cost.total, b.cost.total);
	return result;
}

/**
 * What a cumulative usage gained between two readings of the same ledger: tokens and dollars, each field floored at zero.
 * Provider breakdowns (`details`) are not carried; a delta is a charge to report, not a transcript of the requests.
 */
export function usageSince(before: Usage, after: Usage): Usage {
	const delta = fieldwise(after, before, (now, then) => Math.max(0, now - then));
	if (after.cost.estimate === "base-rates") delta.cost.estimate = "base-rates";
	return delta;
}

/**
 * How far two readings of one cumulative usage reach together: each field the larger of the two. A reading that fell
 * short of an earlier one in some field (a history not loaded yet) never moves that field back.
 */
export function usageReach(a: Usage, b: Usage): Usage {
	const reach = fieldwise(a, b, Math.max);
	if (a.cost.estimate === "base-rates" || b.cost.estimate === "base-rates") reach.cost.estimate = "base-rates";
	return reach;
}
