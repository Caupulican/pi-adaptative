/**
 * The away spend bound (`routines.away.maxUsdPerDay`) over the runs away the routine store journals and the daemon's
 * channel turns away: what each charges it, until when, and whether one more metered run fits. It holds metered (API)
 * spend alone: a run whose pinned models are subscription logins reserves nothing and is held by its usage windows.
 */

import {
	type PersistentRoutineDefinition,
	ROUTINE_UNCERTAIN_RETENTION_MS,
	type RoutineOccurrence,
} from "./routine-contract.ts";

/** The rolling window of the away spend bound. */
export const ROUTINE_AWAY_SPEND_WINDOW_MS = 24 * 60 * 60 * 1000;

/** One charge on the away spend bound, in micro-dollars, until when (undefined: until the store that made it changes). */
export interface RoutineAwayCharge {
	readonly micros: number;
	readonly until?: number;
}

/** The away spend bound a claim by an away host is admitted under; the store decides it under its lock. */
export interface RoutineAwayClaimGate {
	readonly maxUsdPerRun: number;
	readonly maxUsdPerDay: number;
	/**
	 * What else the daemon spent away on the same bound: its channel turns while no session was open
	 * (`away-channels.ts`). Read by the daemon just before the claim, in the one process that makes every away charge.
	 */
	readonly otherCharges?: readonly RoutineAwayCharge[];
	/**
	 * Whether a run of this definition spends metered (API) dollars (`awayRunMetered`); absent, or true: it does and is
	 * charged its full per-run bound. A run that does not reserves nothing on the bound: its plan's usage windows hold it.
	 */
	spendsMetered?(definition: RoutineAwaySpendDefinition): boolean;
	/**
	 * Whether the run away of this dispatch key was reserved on the bound after its admission (`reserveAwayMeteredRun`: an
	 * attempt of it started on a metered model); such a run is charged as a metered one. Absent: none was.
	 */
	reservedMetered?(dispatchKey: string): boolean;
}

/** What a run's metered kind is read from: its routine's pinned execution snapshot. */
export type RoutineAwaySpendDefinition = Pick<PersistentRoutineDefinition, "executionSnapshot">;

/** Whether a run of this definition is charged the away spend bound: unless the gate reads its spend as not metered. */
export function routineAwayRunMetered(
	gate: Pick<RoutineAwayClaimGate, "spendsMetered">,
	definition: RoutineAwaySpendDefinition,
): boolean {
	return gate.spendsMetered?.(definition) !== false;
}

/** Whether a run away is charged the bound's per-run reservation: its definition spends metered, or it was reserved. */
export function routineAwayOccurrenceMetered(
	gate: Pick<RoutineAwayClaimGate, "spendsMetered" | "reservedMetered">,
	item: Pick<RoutineOccurrence, "definition" | "dispatchKey">,
): boolean {
	return (
		routineAwayRunMetered(gate, item.definition) ||
		(item.dispatchKey !== undefined && gate.reservedMetered?.(item.dispatchKey) === true)
	);
}

/** Whole micro-dollars: the bound's sums and comparisons are exact. */
export function awaySpendMicros(usd: number): number {
	return Math.round(usd * 1_000_000);
}

/**
 * What one run away charges the away spend bound now, in micro-dollars, and until when (undefined: until it changes).
 * Admission, not creation, starts the charge, so a run is charged at any age:
 * - admitted and not finished (claimed, dispatching, running): its full per-run bound, until it finishes or returns to
 *   pending (which drops `executor`);
 * - uncertain: its full per-run bound, until resolved, or the spend window after the journal's uncertain retention;
 * - finished after dispatch: its settled metered (API) spend (its full per-run bound when unread), for the spend window
 *   after it finished;
 * - finished without dispatch (cancelled before it started): nothing.
 * A run that spends no metered dollars (`routineAwayOccurrenceMetered`: its definition is not metered and it was not
 * reserved after its admission) is charged nothing in place of its per-run bound.
 */
export function routineAwayCharge(
	item: RoutineOccurrence,
	gate: Pick<RoutineAwayClaimGate, "maxUsdPerRun" | "spendsMetered" | "reservedMetered">,
	nowMs: number,
): RoutineAwayCharge | undefined {
	if (item.executor !== "away") return undefined;
	const maxUsdPerRun = routineAwayOccurrenceMetered(gate, item) ? gate.maxUsdPerRun : 0;
	if (item.phase === "uncertain") {
		const until = item.updatedAt + ROUTINE_UNCERTAIN_RETENTION_MS + ROUTINE_AWAY_SPEND_WINDOW_MS;
		return until > nowMs ? { micros: awaySpendMicros(maxUsdPerRun), until } : undefined;
	}
	if (item.phase !== "terminal") return { micros: awaySpendMicros(maxUsdPerRun) };
	if (!item.dispatchKey) return undefined;
	const until = (item.awaySettlement?.at ?? item.updatedAt) + ROUTINE_AWAY_SPEND_WINDOW_MS;
	if (until <= nowMs) return undefined;
	return { micros: awaySpendMicros(item.awaySettlement?.costUsd ?? maxUsdPerRun), until };
}

/** Whether the run away is still charged the away spend bound, so the journal keeps it. */
export function routineAwayCharged(item: RoutineOccurrence, nowMs: number): boolean {
	return routineAwayCharge(item, { maxUsdPerRun: 0 }, nowMs) !== undefined;
}

/**
 * The away spend bound's state: whether one more metered run fits (`charged + maxUsdPerRun <= maxUsdPerDay`, exact in
 * micro-dollars) and, when it does not, the earliest instant a charge ends by time (undefined when every charge ends
 * only by a store change: a run finishing or returning to pending, or a channel turn away settling). The gate's
 * `otherCharges` count like runs.
 */
export function routineAwaySpendRoom(
	occurrences: Iterable<RoutineOccurrence>,
	gate: RoutineAwayClaimGate,
	nowMs: number,
): { readonly chargedMicros: number; readonly fits: (extraRuns: number) => boolean; readonly exit?: number } {
	let chargedMicros = 0;
	let exit: number | undefined;
	const routineCharges = [...occurrences].map((item) => routineAwayCharge(item, gate, nowMs));
	for (const charge of [...routineCharges, ...(gate.otherCharges ?? [])]) {
		if (!charge) continue;
		chargedMicros += charge.micros;
		if (charge.until !== undefined) exit = Math.min(exit ?? Number.POSITIVE_INFINITY, charge.until);
	}
	const perRun = awaySpendMicros(gate.maxUsdPerRun);
	const perDay = awaySpendMicros(gate.maxUsdPerDay);
	return {
		chargedMicros,
		fits: (extraRuns) => chargedMicros + (extraRuns + 1) * perRun <= perDay,
		...(exit === undefined ? {} : { exit }),
	};
}
