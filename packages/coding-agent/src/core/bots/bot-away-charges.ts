/**
 * What the turns of the bots the daemon hosts spent while no session was open: `state/bots/away-charges.json`, one
 * record per charge (its report id, so a range is charged once), naming the bot session and file instance it covers and
 * how far its range reaches. Under the owner's cost rule only metered spend counts as dollars against the away spend
 * bound (`routines.away.maxUsdPerDay`): a charge made on a subscription is kept at zero dollars, since its limit is its
 * plan's usage windows, which hold the bot's model until they reset (`bot-model-admission.ts`). A record leaves once past
 * the bound's 24-hour window, except each bot's latest, which keeps how far the daemon holds the charges of its session
 * (`botAwayChargesReach`) for a spend ledger that lost its watermark.
 *
 * Written under the file's lock, atomically and private (0600). A record file that does not parse is set aside under
 * that lock by the next write or read (`away-charges.json.unreadable-<time>`), the read saying so for its caller to
 * tell the owner once, and the charges after it are kept. A file the file system refuses, or one that could not be set
 * aside, is read as unreadable (`readBotAwayCharges`): spend that cannot be read is no room.
 */

import { readFileSync, renameSync } from "node:fs";
import type { Usage } from "@caupulican/pi-ai";
import { botAwayChargesFile } from "../agent-paths.ts";
import { isUsage } from "../cost/session-usage.ts";
import { usageReach } from "../cost/usage-delta.ts";
import { ROUTINE_AWAY_SPEND_WINDOW_MS, type RoutineAwayCharge } from "../routines/routine-contract.ts";
import { isMissingFileError, withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { errorText } from "./bot-error-text.ts";

/** One charge of a bot's spend while the daemon hosted it. */
export interface BotAwayChargeRecord {
	readonly reportId: string;
	readonly agentId: string;
	/** The bot session and the instance of its file the charge's range is of (`BotChargeReport`). */
	readonly sessionId: string;
	readonly instance: string;
	/** The cumulative usage the charge's range ends at. */
	readonly through: Usage;
	/** What it counts against the away spend bound, in micro-dollars: its metered spend, zero on a subscription. */
	readonly micros: number;
	/** When it was charged (ms since the epoch, on the daemon's clock). */
	readonly at: number;
}

function isChargeRecord(value: unknown): value is BotAwayChargeRecord {
	return (
		isPlainRecord(value) &&
		typeof value.reportId === "string" &&
		typeof value.agentId === "string" &&
		typeof value.sessionId === "string" &&
		typeof value.instance === "string" &&
		isUsage(value.through) &&
		typeof value.micros === "number" &&
		Number.isFinite(value.micros) &&
		value.micros >= 0 &&
		typeof value.at === "number" &&
		Number.isFinite(value.at)
	);
}

/** The records the file holds, or why it does not read; none when it does not exist yet. */
function readRecords(
	file: string,
): { readonly records: BotAwayChargeRecord[] } | { readonly unreadable: string; readonly malformed: boolean } {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if (isMissingFileError(error)) return { records: [] };
		return { unreadable: error instanceof Error ? error.message : String(error), malformed: false };
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return { unreadable: error instanceof Error ? error.message : String(error), malformed: true };
	}
	if (
		!isPlainRecord(value) ||
		value.version !== 1 ||
		!Array.isArray(value.charges) ||
		!value.charges.every(isChargeRecord)
	)
		return { unreadable: `${file} is not a version 1 record of bot away charges`, malformed: true };
	return { records: value.charges };
}

/** A record file that did not parse, set aside: where it went and why it did not parse. */
export interface BotAwayChargesSetAside {
	readonly file: string;
	readonly to: string;
	readonly reason: string;
}

/** Sets the file aside when it does not parse now (called under its lock); undefined when it parses or is gone. */
function setAsideMalformed(file: string, at: number): BotAwayChargesSetAside | undefined {
	const read = readRecords(file);
	if (!("unreadable" in read) || !read.malformed) return undefined;
	const to = `${file}.unreadable-${at}`;
	renameSync(file, to);
	return { file, to, reason: read.unreadable };
}

/**
 * Charges one range of a bot's spend, once per report id, dropping the records past the window that are not their bot's
 * latest. A file that does not parse is set aside first, and returned for the caller to tell; one that cannot be read
 * throws, and the charge is delivered again.
 */
export function recordBotAwayCharge(agentDir: string, charge: BotAwayChargeRecord): BotAwayChargesSetAside | undefined {
	const file = botAwayChargesFile(agentDir);
	return withFileLockSync(file, () => {
		const setAside = setAsideMalformed(file, charge.at);
		const read = readRecords(file);
		// A file the file system refuses is not set aside: its charges count once it reads again.
		if ("unreadable" in read) throw new Error(`${file} does not read: ${read.unreadable}`);
		if (read.records.some((entry) => entry.reportId === charge.reportId)) return setAside;
		const records = [...read.records, charge];
		const latest = new Map<string, BotAwayChargeRecord>();
		for (const entry of records) {
			const kept = latest.get(entry.agentId);
			if (!kept || entry.at >= kept.at) latest.set(entry.agentId, entry);
		}
		const kept = records.filter(
			(entry) => entry.at + ROUTINE_AWAY_SPEND_WINDOW_MS > charge.at || latest.get(entry.agentId) === entry,
		);
		writeFileAtomicSync(file, `${JSON.stringify({ version: 1, charges: kept }, null, 1)}\n`, { mode: 0o600 });
		return setAside;
	});
}

/**
 * The bots' charges on the away spend bound now, each until it leaves the 24-hour window, with the record file this read
 * set aside when it did not parse; or why they do not read.
 */
export function readBotAwayCharges(
	agentDir: string,
	nowMs: number,
):
	| { readonly charges: RoutineAwayCharge[]; readonly setAside?: BotAwayChargesSetAside }
	| { readonly unreadable: string } {
	const file = botAwayChargesFile(agentDir);
	let read = readRecords(file);
	let setAside: BotAwayChargesSetAside | undefined;
	if ("unreadable" in read && read.malformed) {
		try {
			setAside = withFileLockSync(file, () => setAsideMalformed(file, nowMs));
		} catch (error) {
			return { unreadable: `${read.unreadable}; it was not set aside: ${errorText(error)}` };
		}
		read = readRecords(file);
	}
	if ("unreadable" in read) return { unreadable: read.unreadable };
	const charges = read.records.flatMap((entry) => {
		const until = entry.at + ROUTINE_AWAY_SPEND_WINDOW_MS;
		return entry.micros > 0 && until > nowMs ? [{ micros: entry.micros, until }] : [];
	});
	return setAside ? { charges, setAside } : { charges };
}

/**
 * How far the daemon holds the charges of file instance `instance` of bot session `sessionId`: the furthest range end
 * its records hold; undefined when they hold none. Throws when the file does not read.
 */
export function botAwayChargesReach(agentDir: string, sessionId: string, instance: string): Usage | undefined {
	const file = botAwayChargesFile(agentDir);
	const read = readRecords(file);
	if ("unreadable" in read) throw new Error(`${file} does not read: ${read.unreadable}`);
	let reach: Usage | undefined;
	for (const entry of read.records)
		if (entry.sessionId === sessionId && entry.instance === instance)
			reach = reach ? usageReach(reach, entry.through) : entry.through;
	return reach;
}
