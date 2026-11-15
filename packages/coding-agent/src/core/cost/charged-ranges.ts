/**
 * Spawned usage charged as ranges of one source's cumulative usage: a bot session's charges each name the range of the
 * session's recorded cumulative usage they cover (`from` to `through`), keyed by the bot session (`sourceSessionId`,
 * whose one cumulative usage the ranges read). A reader sums such charges as the union of their ranges, per source and
 * per usage field, so a range delivered twice, to several root sessions, again after a reopen, or overlapping another
 * counts once by construction; with dates (`sweepChargedRanges`), each covered stretch counts on the earliest
 * `recordedAt` of the charges covering it. A report without a range (worker receipts, an earlier build's charges) is
 * not one: its readers keep the report-id dedupe. A charge with per-model components carries no range (its components
 * cannot be split by range), so it is not one either (`chargedRangeOf`, in session-usage.ts).
 */

import type { Usage } from "@caupulican/pi-ai";
import { createEmptyUsage } from "../../kernel/usage.ts";

/** One charged range of a source's cumulative usage. */
export interface ChargedRange {
	/** The source whose cumulative usage the range reads: the bot session's id. */
	readonly source: string;
	readonly from: Usage;
	readonly through: Usage;
}

/** The fields a range covers, each a cumulative counter of its own. */
const FIELDS: readonly ((usage: Usage) => number)[] = [
	(usage) => usage.input,
	(usage) => usage.output,
	(usage) => usage.cacheRead,
	(usage) => usage.cacheWrite,
	(usage) => usage.totalTokens,
	(usage) => usage.cost.input,
	(usage) => usage.cost.output,
	(usage) => usage.cost.cacheRead,
	(usage) => usage.cost.cacheWrite,
	(usage) => usage.cost.total,
];

/**
 * How much of [`low`, `high`] the sorted, disjoint `covered` stretches leave open, as the sum of the open gaps (none
 * open is exactly 0); then covers it too.
 */
function cover(covered: [number, number][], low: number, high: number): number {
	if (!(high > low)) return 0;
	let open = 0;
	let reached = low;
	let start = low;
	let end = high;
	const kept: [number, number][] = [];
	for (const stretch of covered) {
		if (stretch[1] < low || stretch[0] > high) {
			kept.push(stretch);
			continue;
		}
		if (stretch[0] > reached) open += stretch[0] - reached;
		reached = Math.max(reached, stretch[1]);
		start = Math.min(start, stretch[0]);
		end = Math.max(end, stretch[1]);
	}
	if (high > reached) open += high - reached;
	kept.push([start, end]);
	kept.sort((a, b) => a[0] - b[0]);
	covered.splice(0, covered.length, ...kept);
	return open;
}

/** The ranges taken so far, per source and per field. */
export class ChargedRanges {
	private readonly sources = new Map<string, [number, number][][]>();

	/**
	 * The part of `range` no range taken before covers, field by field, then takes `range`: the charge's own `usage` when
	 * none of it was covered, undefined when all of it was, else the open part (with `usage`'s cost estimate).
	 */
	take(range: ChargedRange, usage: Usage): Usage | undefined {
		let fields = this.sources.get(range.source);
		if (!fields) {
			fields = FIELDS.map(() => []);
			this.sources.set(range.source, fields);
		}
		let whole = true;
		const open = FIELDS.map((field, index) => {
			const low = field(range.from);
			const high = field(range.through);
			const left = cover(fields[index] ?? [], low, high);
			if (left !== Math.max(0, high - low)) whole = false;
			return left;
		});
		if (whole) return usage;
		if (open.every((left) => left === 0)) return undefined;
		const result = createEmptyUsage();
		[
			result.input,
			result.output,
			result.cacheRead,
			result.cacheWrite,
			result.totalTokens,
			result.cost.input,
			result.cost.output,
			result.cost.cacheRead,
			result.cost.cacheWrite,
			result.cost.total,
		] = open as [number, number, number, number, number, number, number, number, number, number];
		if (usage.cost.estimate === "base-rates") result.cost.estimate = "base-rates";
		return result;
	}
}

/**
 * For each item that charges a range, the part of it that counts (`ChargedRanges.take`; undefined for none): items are
 * taken oldest first by `at` (ms since the epoch; ties in their order), so each covered stretch counts with the earliest
 * item covering it. Items that charge no range are not in the result.
 */
export function sweepChargedRanges<T>(
	items: Iterable<T>,
	rangeOf: (item: T) => { readonly range: ChargedRange; readonly usage: Usage; readonly at: number } | undefined,
): Map<T, Usage | undefined> {
	const ranged = [...items].flatMap((item) => {
		const found = rangeOf(item);
		return found ? [{ item, ...found }] : [];
	});
	ranged.sort((a, b) => a.at - b.at);
	const ranges = new ChargedRanges();
	return new Map(ranged.map(({ item, range, usage }) => [item, ranges.take(range, usage)]));
}
