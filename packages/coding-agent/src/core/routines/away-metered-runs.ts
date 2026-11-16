/**
 * The runs away reserved on the away spend bound (`routines.away.maxUsdPerDay`) after their admission. A run whose
 * pinned models are subscription logins is admitted reserving nothing (`routineAwayRunMetered`); while the day bound has
 * no room for it, its attempts are held off metered models (`awayMeteredRunFits`), and when an attempt of it starts on a
 * metered model (it failed over while there was room), the daemon reserves the run's full per-run bound here before that
 * attempt's first request, so its metered spend stays inside the day bound. From then on the run is charged as a metered
 * run is (`routineAwayCharge`): its full per-run bound while it runs or is uncertain, then its settled spend, or the
 * reservation while that spend is unread. A file of its own (`awayMeteredRunsFile`), so the routine store's records keep
 * the shape older readers accept. The daemon, the one process that runs and charges runs away, writes it, and drops the
 * keys of runs the bound no longer charges each time it reads it; a file that does not read counts every run as reserved.
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

/** The reserved dispatch keys, or why the file did not read (a code such as `EACCES`, or `invalid`). */
type AwayMeteredRunsRead =
	| { readonly kind: "read"; readonly runs: ReadonlySet<string> }
	| { readonly kind: "unreadable"; readonly cause: string };

function readAwayMeteredRuns(agentDir: string): AwayMeteredRunsRead {
	let text: string;
	try {
		text = readFileSync(awayMeteredRunsFile(agentDir), "utf8");
	} catch (error) {
		if (isMissingFileError(error)) return { kind: "read", runs: new Set() };
		const code = (error as { readonly code?: unknown }).code;
		return { kind: "unreadable", cause: typeof code === "string" ? code : "unreadable" };
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { kind: "unreadable", cause: "invalid" };
	}
	if (typeof value !== "object" || value === null) return { kind: "unreadable", cause: "invalid" };
	const { version, runs } = value as { readonly version?: unknown; readonly runs?: unknown };
	if (version !== AWAY_METERED_RUNS_VERSION || !Array.isArray(runs)) return { kind: "unreadable", cause: "invalid" };
	if (!runs.every((run): run is string => typeof run === "string")) return { kind: "unreadable", cause: "invalid" };
	return { kind: "read", runs: new Set(runs) };
}

function writeAwayMeteredRuns(agentDir: string, runs: readonly string[]): void {
	writeFileAtomicSync(
		awayMeteredRunsFile(agentDir),
		`${JSON.stringify({ version: AWAY_METERED_RUNS_VERSION, runs })}\n`,
	);
}

/** The gate's `reservedMetered`, read at each call, so a reservation made after the gate was built counts. */
export function awayMeteredRunReserved(agentDir: string): (dispatchKey: string) => boolean {
	return (dispatchKey) => {
		const read = readAwayMeteredRuns(agentDir);
		return read.kind === "unreadable" || read.runs.has(dispatchKey);
	};
}

/** The dispatch keys of the runs away the bound still charges (`routineAwayCharged`). */
function chargedRuns(occurrences: readonly RoutineOccurrence[], nowMs: number): ReadonlySet<string> {
	return new Set(
		occurrences.flatMap((item) =>
			item.executor === "away" && item.dispatchKey && routineAwayCharged(item, nowMs) ? [item.dispatchKey] : [],
		),
	);
}

/**
 * The daemon's read of the reservations at each pass: drops the keys of runs the bound no longer charges, and returns
 * why the file does not read when it does not (every run then counts as reserved until it reads again). A drop that
 * cannot be written is left to the next write: a key whose run is not charged charges nothing.
 */
export function settleAwayMeteredRuns(
	agentDir: string,
	occurrences: readonly RoutineOccurrence[],
	nowMs: number,
): { readonly unreadable?: string } {
	const read = readAwayMeteredRuns(agentDir);
	if (read.kind === "unreadable") return { unreadable: read.cause };
	const charged = chargedRuns(occurrences, nowMs);
	const kept = [...read.runs].filter((key) => charged.has(key));
	if (kept.length === read.runs.size) return {};
	try {
		writeAwayMeteredRuns(agentDir, kept);
	} catch {
		// Left for the next write; nothing is charged by a stale key.
	}
	return {};
}

/** What deciding a run's metered spend on the away day bound reads. */
export interface AwayMeteredRunInput {
	readonly agentDir: string;
	readonly dispatchKey: string;
	readonly occurrences: readonly RoutineOccurrence[];
	readonly gate: RoutineAwayClaimGate;
	readonly nowMs: number;
}

/**
 * Whether the run away of `dispatchKey` may spend metered dollars now: it is charged as a metered run already (admitted
 * metered, or reserved by an earlier attempt), or the away day bound has room for one more run. False for a run the
 * store does not hold.
 */
export function awayMeteredRunFits(input: AwayMeteredRunInput): boolean {
	const { dispatchKey, occurrences, nowMs } = input;
	const run = occurrences.find((item) => item.executor === "away" && item.dispatchKey === dispatchKey);
	if (!run) return false;
	const charging = { ...input.gate, reservedMetered: awayMeteredRunReserved(input.agentDir) };
	return routineAwayOccurrenceMetered(charging, run) || routineAwaySpendRoom(occurrences, charging, nowMs).fits(0);
}

/**
 * Reserves the run away of `dispatchKey` on the away spend bound as an attempt of it starts on a metered model: true when
 * its metered spend is reserved (now, or already), false when it does not fit (`awayMeteredRunFits`) or the reservation
 * could not be written (`notWritten` tells why). Keys whose run the bound no longer charges are dropped as it writes.
 */
export function reserveAwayMeteredRun(
	input: AwayMeteredRunInput & { notWritten(path: string, cause: string): void },
): boolean {
	const { agentDir, dispatchKey, occurrences, nowMs } = input;
	if (!awayMeteredRunFits(input)) return false;
	const read = readAwayMeteredRuns(agentDir);
	// A file that does not read counts the run as reserved already.
	if (read.kind === "unreadable" || read.runs.has(dispatchKey)) return true;
	const run = occurrences.find((item) => item.executor === "away" && item.dispatchKey === dispatchKey);
	if (run && routineAwayOccurrenceMetered(input.gate, run)) return true;
	const charged = chargedRuns(occurrences, nowMs);
	try {
		writeAwayMeteredRuns(agentDir, [...[...read.runs].filter((key) => charged.has(key)), dispatchKey]);
	} catch (error) {
		input.notWritten(awayMeteredRunsFile(agentDir), error instanceof Error ? error.message : String(error));
		return false;
	}
	return true;
}
