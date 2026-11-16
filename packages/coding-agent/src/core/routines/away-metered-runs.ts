/**
 * The runs and channel turns away reserved on the away spend bound (`routines.away.maxUsdPerDay`) after their admission. A run whose
 * pinned models are subscription logins is admitted reserving nothing (`routineAwayRunMetered`); while the day bound has
 * no room for it, its attempts are held off metered models (`awayMeteredRunHold`), and when an attempt of it starts on a
 * metered model (it failed over while there was room), the daemon reserves the run's full per-run bound here before that
 * attempt's first request, so its metered spend stays inside the day bound. From then on the run is charged as a metered
 * run is (`routineAwayCharge`): its full per-run bound while it runs or is uncertain, then its settled spend, or the
 * reservation while that spend is unread. A channel turn away the daemon serves on a subscription (`quota`) is reserved
 * the same way when its session fails over to a metered model (`awayChannelTurnKey`, kept until the turn's charge leaves
 * the day's window), and is charged as a metered turn from then on (`away-channels.ts`). A file of its own
 * (`awayMeteredRunsFile`), so the routine store's records and the channel journals keep the shape older readers accept.
 * The daemon, the one process that runs and charges work away, writes it, and drops the keys the bound no longer charges
 * each time it reads it; a file that does not read counts every run and subscription turn away as reserved.
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

/** The reservation key of a channel turn away (`channel-turn:<until>:<channel>:<batch>`); a run's key is its dispatch key. */
const CHANNEL_TURN_KEY = "channel-turn:";

/** The key a channel turn away is reserved under: kept until `untilMs`, when its charge leaves the day's window. */
export function awayChannelTurnKey(channel: string, batchId: string, untilMs: number): string {
	return `${CHANNEL_TURN_KEY}${untilMs}:${channel}:${batchId}`;
}

/** The reservations as read once, now, for one pass over many charges; a file that does not read counts every key. */
export function awayMeteredReservations(agentDir: string): (key: string) => boolean {
	const read = readAwayMeteredRuns(agentDir);
	return (key) => read.kind === "unreadable" || read.runs.has(key);
}

/** The gate's `reservedMetered`, read at each call, so a reservation made after the gate was built counts. */
export function awayMeteredRunReserved(agentDir: string): (dispatchKey: string) => boolean {
	return (dispatchKey) => awayMeteredReservations(agentDir)(dispatchKey);
}

/** The dispatch keys of the runs away the bound still charges (`routineAwayCharged`). */
function chargedRuns(occurrences: readonly RoutineOccurrence[], nowMs: number): ReadonlySet<string> {
	return new Set(
		occurrences.flatMap((item) =>
			item.executor === "away" && item.dispatchKey && routineAwayCharged(item, nowMs) ? [item.dispatchKey] : [],
		),
	);
}

/** Whether a reservation still charges the bound: a run's while the bound charges the run, a channel turn's until its window ends. */
function reservationKept(key: string, charged: ReadonlySet<string>, nowMs: number): boolean {
	if (!key.startsWith(CHANNEL_TURN_KEY)) return charged.has(key);
	return Number.parseInt(key.slice(CHANNEL_TURN_KEY.length), 10) > nowMs;
}

/**
 * Writes `keys` as reserved: true when they are (now, or already, or the file does not read and counts them reserved),
 * false when the write failed (`notWritten` tells why). Keys the bound no longer charges are dropped as it writes.
 */
function writeReservations(
	agentDir: string,
	keys: readonly string[],
	charging: { readonly occurrences: readonly RoutineOccurrence[]; readonly nowMs: number },
	notWritten: (path: string, cause: string) => void,
): boolean {
	const read = readAwayMeteredRuns(agentDir);
	if (read.kind === "unreadable" || keys.every((key) => read.runs.has(key))) return true;
	const charged = chargedRuns(charging.occurrences, charging.nowMs);
	const kept = [...read.runs].filter((key) => reservationKept(key, charged, charging.nowMs));
	try {
		writeAwayMeteredRuns(agentDir, [...new Set([...kept, ...keys])]);
	} catch (error) {
		notWritten(awayMeteredRunsFile(agentDir), error instanceof Error ? error.message : String(error));
		return false;
	}
	return true;
}

/**
 * The daemon's read of the reservations at each pass: drops the keys the bound no longer charges, and returns
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
	const kept = [...read.runs].filter((key) => reservationKept(key, charged, nowMs));
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
 * Why the away day bound holds a run away's metered spend: it has no room for one more run (`full`; a run the store
 * does not hold has none, as nothing could charge it), or charges on it do not read (`unread`: the gate's
 * `otherCharges`), so whether it has room is unknown.
 */
export type AwayMeteredRunHold = "full" | "unread";

/**
 * Why the run away of `dispatchKey` may not spend metered dollars now (`AwayMeteredRunHold`); undefined when it may: it
 * is charged as a metered run already (admitted metered, or reserved by an earlier attempt), or the away day bound has
 * room for one more run.
 */
export function awayMeteredRunHold(input: AwayMeteredRunInput): AwayMeteredRunHold | undefined {
	const { dispatchKey, occurrences, nowMs } = input;
	const run = occurrences.find((item) => item.executor === "away" && item.dispatchKey === dispatchKey);
	if (!run) return "full";
	const charging = { ...input.gate, reservedMetered: awayMeteredRunReserved(input.agentDir) };
	if (routineAwayOccurrenceMetered(charging, run)) return undefined;
	const room = routineAwaySpendRoom(occurrences, charging, nowMs);
	return room.fits(0) ? undefined : room.unread ? "unread" : "full";
}

/** Why a metered attempt's run away was not reserved: the day bound holds it (`AwayMeteredRunHold`), or the write failed. */
export type AwayMeteredRunRefusal = AwayMeteredRunHold | "unwritten";

/**
 * Reserves the run away of `dispatchKey` on the away spend bound as an attempt of it starts on a metered model:
 * undefined when its metered spend is reserved (now, or already), else why not: the bound holds it
 * (`awayMeteredRunHold`), or the reservation could not be written (`unwritten`, `notWritten` telling why). Keys whose
 * run the bound no longer charges are dropped as it writes.
 */
export function reserveAwayMeteredRun(
	input: AwayMeteredRunInput & { notWritten(path: string, cause: string): void },
): AwayMeteredRunRefusal | undefined {
	const { agentDir, dispatchKey, occurrences } = input;
	const hold = awayMeteredRunHold(input);
	if (hold) return hold;
	const run = occurrences.find((item) => item.executor === "away" && item.dispatchKey === dispatchKey);
	if (run && routineAwayOccurrenceMetered(input.gate, run)) return undefined;
	return writeReservations(agentDir, [dispatchKey], input, input.notWritten) ? undefined : "unwritten";
}

/**
 * Reserves the channel turns away of `keys` (`awayChannelTurnKey`) on the away spend bound as their session fails over
 * to a metered model; the caller decided they fit. False when the reservation could not be written (`notWritten`).
 */
export function reserveAwayChannelTurns(input: {
	readonly agentDir: string;
	readonly keys: readonly string[];
	readonly occurrences: readonly RoutineOccurrence[];
	readonly nowMs: number;
	notWritten(path: string, cause: string): void;
}): boolean {
	return writeReservations(input.agentDir, input.keys, input, input.notWritten);
}
