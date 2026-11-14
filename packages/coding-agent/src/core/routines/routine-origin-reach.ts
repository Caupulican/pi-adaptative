/**
 * Whether a routine's parent origin reaches the session open here: usable now, waiting (it may pass later), or lost (it can
 * provably never pass). The scheduler dispatches and delivers only under an origin usable now: this session's own file, the
 * anchor on the current branch, the anchor entry durable. A pending result whose origin is lost (the session file it names
 * is gone, or its anchor entry is absent from the durable session file, for example lost to a crash before it was written)
 * is settled undeliverable instead of waiting forever; one on another branch, not yet durable, in another existing file of
 * the session or under uncertain persistence waits.
 */
import { statSync } from "node:fs";
import type { SessionManager } from "../../kernel/session/session-manager.ts";
import type { WorkerReceiptOrigin } from "../orchestration/worker-receipt-origin.ts";
import { isSessionAppendAnchorCurrent } from "../session-snapshot.ts";
import type { RoutineOccurrence } from "./routine-contract.ts";

/** Why an origin can never pass: the session file it names is gone, or its anchor entry is absent from the session file. */
export type RoutineOriginLoss = "session-file-gone" | "origin-entry-absent";

export type RoutineOriginReach = "usable" | "waiting" | RoutineOriginLoss;

/**
 * How a run was settled because its origin is lost: `undelivered`, its result was settled undeliverable in place of its
 * delivery; `unstarted`, it was cancelled before dispatch because its routine's own origin is lost.
 */
export type RoutineOriginSettledRun = "undelivered" | "unstarted";

const ORIGIN_SETTLEMENT_PREFIXES: Readonly<Record<RoutineOriginSettledRun, string>> = {
	undelivered: "undeliverable:",
	unstarted: "unstarted:",
};

/** The delivery marker of a result settled because its origin is lost: the run's stored result keeps why it was not delivered. */
export function routineUndeliverableMarker(loss: RoutineOriginLoss): string {
	return `${ORIGIN_SETTLEMENT_PREFIXES.undelivered}${loss}`;
}

/** The delivery marker of a run cancelled before dispatch because its routine's own origin is lost. */
export function routineUnstartedMarker(loss: RoutineOriginLoss): string {
	return `${ORIGIN_SETTLEMENT_PREFIXES.unstarted}${loss}`;
}

/** A run settled because its origin is lost: which run, how, why, and when the settlement was written. */
export interface RoutineOriginSettlement {
	readonly routineId: string;
	readonly occurrenceId: string;
	readonly run: RoutineOriginSettledRun;
	readonly loss: RoutineOriginLoss;
	readonly settledAt: number;
}

/** How and why a delivery marker says its run was settled for a lost origin; undefined for a delivered result's marker. */
function originSettlement(marker: string | undefined): Pick<RoutineOriginSettlement, "run" | "loss"> | undefined {
	if (marker === undefined) return undefined;
	for (const run of ["undelivered", "unstarted"] as const) {
		const prefix = ORIGIN_SETTLEMENT_PREFIXES[run];
		if (!marker.startsWith(prefix)) continue;
		const loss = marker.slice(prefix.length);
		return loss === "session-file-gone" || loss === "origin-entry-absent" ? { run, loss } : undefined;
	}
	return undefined;
}

/**
 * Per routine id, the latest of `occurrences` settled because its origin is lost (its result, or the uncertainty result
 * before it), read from the delivery markers the journal keeps while it holds the run; only runs settled as `run` when
 * given.
 */
export function latestOriginSettlements(
	occurrences: Iterable<RoutineOccurrence>,
	run?: RoutineOriginSettledRun,
): ReadonlyMap<string, RoutineOriginSettlement> {
	const latest = new Map<string, RoutineOriginSettlement>();
	for (const occurrence of occurrences) {
		const settled =
			originSettlement(occurrence.result?.deliveryMarker) ??
			originSettlement(occurrence.priorUncertaintyResult?.deliveryMarker);
		if (settled === undefined || (run !== undefined && settled.run !== run)) continue;
		const known = latest.get(occurrence.routineId);
		if (known && known.settledAt >= occurrence.updatedAt) continue;
		latest.set(occurrence.routineId, {
			routineId: occurrence.routineId,
			occurrenceId: occurrence.occurrenceId,
			...settled,
			settledAt: occurrence.updatedAt,
		});
	}
	return latest;
}

/** Whether the session file `path` provably does not exist. An unreadable path is not proof: it may be readable again. */
export function sessionFileGone(path: string): boolean {
	try {
		statSync(path);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

/**
 * Whether the anchor entry is provably absent from this session: not in its entry graph (an entry on another branch or
 * buffered before the first flush is), and, for a persisted session, not in its durable file on disk either.
 */
function anchorEntryAbsent(manager: SessionManager, leafId: string): boolean {
	if (manager.getEntry(leafId) !== undefined) return false;
	// An in-memory session holds every entry it ever had.
	if (!manager.isPersisted()) return true;
	const sessionFile = manager.getSessionFile();
	if (!manager.hasDurableSessionFile() || sessionFile === undefined) return false;
	try {
		statSync(sessionFile);
	} catch {
		// The file cannot be read now, so its contents prove nothing.
		return false;
	}
	return !manager.isEntryPersisted(leafId);
}

/** Where `origin` stands for the session `manager` holds; `usable` is exactly the scheduler's origin gate. */
export function routineOriginReach(manager: SessionManager, origin: WorkerReceiptOrigin): RoutineOriginReach {
	if (origin.sessionId !== manager.getSessionId() || manager.isPersistenceStateUncertain()) return "waiting";
	const sessionFile = manager.getSessionFile();
	const sameFile = manager.isPersisted()
		? Boolean(sessionFile) && (origin.sessionFile === undefined || origin.sessionFile === sessionFile)
		: origin.sessionFile === undefined;
	if (!sameFile)
		return origin.sessionFile !== undefined &&
			origin.sessionFile !== sessionFile &&
			sessionFileGone(origin.sessionFile)
			? "session-file-gone"
			: "waiting";
	if (
		isSessionAppendAnchorCurrent(manager, origin) &&
		Boolean(origin.leafId && manager.isEntryDurableForSession(origin.leafId))
	)
		return "usable";
	return origin.leafId && anchorEntryAbsent(manager, origin.leafId) ? "origin-entry-absent" : "waiting";
}
