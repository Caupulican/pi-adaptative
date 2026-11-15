/**
 * When a session's orchestration journal may be folded into a snapshot. A snapshot is the projection this build holds, so
 * a plan a newer build wrote, which this build keeps only by its identity (`isPlanFromNewerBuild`), would be written back
 * as that identity: its record, its steps' states and its closure would be gone, and the newer build would read the plan
 * as lost (`isPlanLostToOlderBuild`), as an earlier build up to 0.104.64 lost every version-3 plan. While the projection
 * holds such a plan, compaction is deferred: it waits for the widest tail the store is built for ({@link WIDEST_TAIL}:
 * 1024 events or 16 MiB, against the default 256 events and 4 MiB), so a newer build that opens the session before then
 * compacts it with the plan whole. Past that bound it compacts all
 * the same: the events directory is read under a bound of 2048 entries (`event-store.ts`), and a journal past it would
 * be read by no build at all.
 */

/** The widest tail a store may be configured with, and the one a deferred compaction waits for. */
export const WIDEST_TAIL = { events: 1_024, bytes: 16 * 1024 * 1024 } as const;

/**
 * `due`: at the configured tail bound; `deferred`: at the widest, beside a plan from a newer build (`compactionWhen` in
 * `retention-eligibility.ts`, which judges what the journal may drop); `forced`: now (a committed retention prune).
 */
export type CompactionWhen = "due" | "deferred" | "forced";

/** The tail bound a compaction of `when` waits for, given the store's configured one. */
export function compactionTailLimits(
	when: CompactionWhen,
	configured: { readonly events: number; readonly bytes: number },
): { readonly events: number; readonly bytes: number } {
	return when === "deferred" ? WIDEST_TAIL : configured;
}
