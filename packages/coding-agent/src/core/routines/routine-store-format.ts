/**
 * Which format version the routine store is written in. Each version adds fields an earlier build cannot read, and a store is
 * written in the oldest version that holds every field it carries, so a build that predates a field refuses the store instead of
 * dropping the routines it cannot read: 3 is the current shape (a revision counter, no legacy routine key), 4 adds progress, 5
 * arming stamps and wake addresses, 6 a watch saved with its receipt origin and no execution snapshot.
 */
import type { RoutineDefinitionView, RoutineOccurrence } from "./routine-contract.ts";
import { carriesRoutineArming } from "./routine-provenance.ts";

/** Every store version this build reads; 1 and 2 are the first shapes, which it rewrites in the current one. */
export const ROUTINE_STORE_VERSIONS: readonly number[] = [1, 2, 3, 4, 5, 6];

/** The version to write for these routines and occurrences (an occurrence's frozen definition counts like a routine). */
export function routineStoreFormatVersion(
	routines: readonly RoutineDefinitionView[],
	occurrences: readonly RoutineOccurrence[],
): number {
	const definitions = [...routines, ...occurrences.map((occurrence) => occurrence.definition)];
	if (definitions.some((definition) => definition.receiptOrigin !== undefined)) return 6;
	if (definitions.some(carriesRoutineArming)) return 5;
	return routines.some((routine) => routine.progress !== undefined) ||
		occurrences.some(
			(occurrence) => occurrence.progressBrief !== undefined || occurrence.progressUntrusted !== undefined,
		)
		? 4
		: 3;
}
