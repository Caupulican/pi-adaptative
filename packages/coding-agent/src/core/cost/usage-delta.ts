/**
 * Owns the difference between two readings of one cumulative usage ledger: the charge a span of work added.
 */
import type { Usage } from "@caupulican/pi-ai";
import { createEmptyUsage } from "../../kernel/usage.ts";

/**
 * What a cumulative usage gained between two readings of the same ledger: tokens and dollars, each field floored at zero.
 * Provider breakdowns (`details`) are not carried; a delta is a charge to report, not a transcript of the requests.
 */
export function usageSince(before: Usage, after: Usage): Usage {
	const gain = (now: number, then: number): number => Math.max(0, now - then);
	const delta = createEmptyUsage();
	delta.input = gain(after.input, before.input);
	delta.output = gain(after.output, before.output);
	delta.cacheRead = gain(after.cacheRead, before.cacheRead);
	delta.cacheWrite = gain(after.cacheWrite, before.cacheWrite);
	delta.totalTokens = gain(after.totalTokens, before.totalTokens);
	delta.cost.input = gain(after.cost.input, before.cost.input);
	delta.cost.output = gain(after.cost.output, before.cost.output);
	delta.cost.cacheRead = gain(after.cost.cacheRead, before.cost.cacheRead);
	delta.cost.cacheWrite = gain(after.cost.cacheWrite, before.cost.cacheWrite);
	delta.cost.total = gain(after.cost.total, before.cost.total);
	if (after.cost.estimate === "base-rates") delta.cost.estimate = "base-rates";
	return delta;
}
