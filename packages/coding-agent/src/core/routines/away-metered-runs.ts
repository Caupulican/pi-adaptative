/**
 * The runs away reserved on the away spend bound (`routines.away.maxUsdPerDay`) after their admission. A run whose
 * pinned models are subscription logins is admitted reserving nothing (`routineAwayRunMetered`); when an attempt of it
 * starts on a metered model (it failed over), the daemon reserves the run's full per-run bound here before that attempt's
 * first request, so its metered spend stays inside the day bound. From then on the run is charged as a metered run is
 * (`routineAwayCharge`): its full per-run bound while it runs or is uncertain, then its settled spend, or the
 * reservation while that spend is unread. A file of its own (`awayMeteredRunsFile`), so the routine store's records keep
 * the shape older readers accept. The daemon, the one process that runs and charges runs away, writes it; a file that
 * does not read counts every run as reserved.
 */

import { readFileSync } from "node:fs";
import { awayMeteredRunsFile } from "../agent-paths.ts";
import { isMissingFileError, writeFileAtomicSync } from "../util/atomic-file.ts";
import {
	type RoutineAwayClaimGate,
	routineAwayCharged,
	routineAwayOccurrenceMetered,
	routineAwaySpendRoom,
} from "./routine-away-spend.ts";
import type { RoutineOccurrence } from "./routine-contract.ts";

const AWAY_METERED_RUNS_VERSION = 1;

/** The dispatch keys reserved; undefined when the file does not read, and then no run can be proven unreserved. */
function readAwayMeteredRuns(agentDir: string): ReadonlySet<string> | undefined {
	let text: string;
	try {
		text = readFileSync(awayMeteredRunsFile(agentDir), "utf8");
	} catch (error) {
		return isMissingFileError(error) ? new Set() : undefined;
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const { version, runs } = value as { readonly version?: unknown; readonly runs?: unknown };
	if (version !== AWAY_METERED_RUNS_VERSION || !Array.isArray(runs)) return undefined;
	if (!runs.every((run): run is string => typeof run === "string")) return undefined;
	return new Set(runs);
}

/** The gate's `reservedMetered`, read at each call, so a reservation made after the gate was built counts. */
export function awayMeteredRunReserved(agentDir: string): (dispatchKey: string) => boolean {
	return (dispatchKey) => readAwayMeteredRuns(agentDir)?.has(dispatchKey) ?? true;
}

/**
 * Reserves the run away of `dispatchKey` on the away spend bound as an attempt of it starts on a metered model: true when
 * its metered spend is reserved (now, or already: it was admitted metered or reserved by an earlier attempt), false when
 * the bound has no room for one more run, the run is not in the store, or the reservation could not be written
 * (`report` tells why). Keys whose run the bound no longer charges are dropped as it writes.
 */
export function reserveAwayMeteredRun(input: {
	readonly agentDir: string;
	readonly dispatchKey: string;
	readonly occurrences: readonly RoutineOccurrence[];
	readonly gate: RoutineAwayClaimGate;
	readonly nowMs: number;
	report(message: string): void;
}): boolean {
	const { agentDir, dispatchKey, occurrences, gate, nowMs } = input;
	const run = occurrences.find((item) => item.executor === "away" && item.dispatchKey === dispatchKey);
	if (!run) return false;
	const reserved = awayMeteredRunReserved(agentDir);
	const charging = { ...gate, reservedMetered: reserved };
	if (routineAwayOccurrenceMetered(charging, run)) return true;
	if (!routineAwaySpendRoom(occurrences, charging, nowMs).fits(0)) return false;
	const charged = new Set(
		occurrences.flatMap((item) =>
			item.executor === "away" && item.dispatchKey && routineAwayCharged(item, nowMs) ? [item.dispatchKey] : [],
		),
	);
	const runs = [...(readAwayMeteredRuns(agentDir) ?? [])].filter((key) => charged.has(key));
	try {
		writeFileAtomicSync(
			awayMeteredRunsFile(agentDir),
			`${JSON.stringify({ version: AWAY_METERED_RUNS_VERSION, runs: [...runs, dispatchKey] })}\n`,
		);
	} catch (error) {
		input.report(
			`A run away that moved to a metered model was not reserved on the away spend bound, so its metered requests are refused: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
	return true;
}
