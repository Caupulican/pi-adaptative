/**
 * A bot's spend ledger, `bots/<id>/spend.json` in its home: the watermark of its charges to the root it answers
 * (`BotChargeState`) and its spend windows (`SpendWindowRecord`), one record, written atomically and private (0600). Both
 * advance in the same write: whatever the windows counted and the charges covered when a write lands is what a reopen
 * reads, with nothing between two files to disagree.
 *
 * The charge watermark reads the bot session's cumulative usage (`AgentSession.getCumulativeUsage`: every usage entry of
 * its transcript, spawned usage included), which a compaction does not shrink: it only appends. It names the session it
 * reads, so a bot that opens another session file starts that one's watermark and still holds the charges it fixed for
 * the first: a charge's range, report id and usage are written here before it is reported, and stay until the root's
 * file holds it.
 *
 * A record that does not read is set aside (`.unreadable`) and the owner told; the windows then start empty and the
 * charges from what the session has spent at that open.
 */

import { existsSync, readFileSync, renameSync } from "node:fs";
import type { Usage } from "@caupulican/pi-ai";
import { isUsage } from "../cost/session-usage.ts";
import { writeFileAtomicSync } from "../util/atomic-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";

/** One window as it is kept (`BotSpendWindows`). */
export interface SpendWindowRecord {
	/** `<session id>/<entry id>`: the window's identity, and the run id its workers' spend bound shares. */
	readonly id: string;
	/** The input that opened it: the owner input id it delivered, else its transcript entry's id. */
	readonly input: string;
	/** What kind of input opened it (`TurnOriginKind`), or `transcript` for the transcript's first entry. */
	readonly kind: string;
	/** The session's own spend while serving it, in dollars. */
	foregroundUsd: number;
	/** The attempts found to serve it (their spend is read from the delegation ledger, never kept here). */
	attemptIds: string[];
	/** When it last changed (ms since the epoch): the oldest windows are dropped first. */
	updatedAt: number;
}

/** One charge of the bot session's spend, as the root's ledger takes it. */
export interface BotChargeReport {
	readonly agentId: string;
	/** Derived from the range the charge covers: the same range is always the same charge. */
	readonly reportId: string;
	/** The bot's own session id. */
	readonly sessionId: string;
	readonly provider: string;
	readonly model: string;
}

export interface BotCharge {
	readonly usage: Usage;
	readonly report: BotChargeReport;
}

/** How far the bot's charges reach. */
export interface BotChargeState {
	/** The bot session whose cumulative usage `through` reads. */
	sessionId: string;
	/** That session's cumulative usage the charges cover: the next charge starts there. */
	through: Usage;
	/** Charges whose range is fixed and written and whose report the root's file does not hold yet, oldest first. */
	pending: BotCharge[];
}

/** What the ledger tells the owner. */
export interface BotSpendLedgerPorts {
	/** The record could not be read, in the owner's words. */
	notRead(reason: string): void;
	/** The record could not be written, in the owner's words. */
	notWritten(reason: string): void;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseWindow(value: unknown): SpendWindowRecord | undefined {
	if (!isPlainRecord(value)) return undefined;
	const { id, input, kind, foregroundUsd, attemptIds, updatedAt } = value;
	if (typeof id !== "string" || typeof input !== "string" || typeof kind !== "string") return undefined;
	if (typeof foregroundUsd !== "number" || !Number.isFinite(foregroundUsd) || foregroundUsd < 0) return undefined;
	if (typeof updatedAt !== "number" || !Array.isArray(attemptIds)) return undefined;
	if (!attemptIds.every((attemptId) => typeof attemptId === "string")) return undefined;
	return { id, input, kind, foregroundUsd, attemptIds: [...attemptIds], updatedAt };
}

function parseCharge(value: unknown): BotCharge | undefined {
	if (!isPlainRecord(value) || !isUsage(value.usage) || !isPlainRecord(value.report)) return undefined;
	const { agentId, reportId, sessionId, provider, model } = value.report;
	if (
		typeof agentId !== "string" ||
		typeof reportId !== "string" ||
		typeof sessionId !== "string" ||
		typeof provider !== "string" ||
		typeof model !== "string"
	)
		return undefined;
	return { usage: value.usage, report: { agentId, reportId, sessionId, provider, model } };
}

function parseChargeState(value: unknown): BotChargeState | undefined {
	if (!isPlainRecord(value) || typeof value.sessionId !== "string" || !isUsage(value.through)) return undefined;
	if (!Array.isArray(value.pending)) return undefined;
	const pending = value.pending.map(parseCharge);
	if (!pending.every((charge): charge is BotCharge => charge !== undefined)) return undefined;
	return { sessionId: value.sessionId, through: value.through, pending };
}

/** The bot's spend ledger (see the module comment): its one reader and writer. */
export class BotSpendLedger {
	/** The windows kept, by id. */
	readonly windows = new Map<string, SpendWindowRecord>();
	/** The charge watermark; undefined until the bot's session first sets it. */
	charge: BotChargeState | undefined;
	private readonly file: string;
	private readonly ports: BotSpendLedgerPorts;
	/** A change not yet written. */
	private dirty = false;
	/** A write failed and the owner was told; told again only after a write succeeds. */
	private writeFailed = false;

	constructor(file: string, ports: BotSpendLedgerPorts) {
		this.file = file;
		this.ports = ports;
		try {
			this.read();
		} catch (error) {
			ports.notRead(errorText(error));
		}
	}

	/** A change to write with the next write. */
	touch(): void {
		this.dirty = true;
	}

	/** Writes the changes not yet written, if any; true when nothing is left unwritten. */
	flush(): boolean {
		return this.dirty ? this.write() : true;
	}

	/**
	 * Writes the whole record now; true when it is written. A failure is told once until a write succeeds, and the changes
	 * stay to be written with the next.
	 */
	write(): boolean {
		try {
			writeFileAtomicSync(
				this.file,
				`${JSON.stringify({ v: 1, charge: this.charge, windows: [...this.windows.values()] })}\n`,
				{ mode: 0o600 },
			);
			this.dirty = false;
			this.writeFailed = false;
			return true;
		} catch (error) {
			this.dirty = true;
			if (!this.writeFailed) this.ports.notWritten(errorText(error));
			this.writeFailed = true;
			return false;
		}
	}

	/**
	 * Reads the record. One that does not read is set aside (renamed `.unreadable`) and thrown, so it is reported once and
	 * the next write starts a new one; a file that cannot be read is thrown and kept.
	 */
	private read(): void {
		if (!existsSync(this.file)) return;
		const text = readFileSync(this.file, "utf8");
		try {
			const value: unknown = JSON.parse(text);
			if (!isPlainRecord(value) || value.v !== 1 || !Array.isArray(value.windows))
				throw new Error("not a bot spend record");
			const charge = value.charge === undefined ? undefined : parseChargeState(value.charge);
			if (value.charge !== undefined && !charge) throw new Error("its charge watermark does not read");
			const windows = value.windows.map((item) => {
				const window = parseWindow(item);
				if (!window) throw new Error("a spend window does not read");
				return window;
			});
			this.charge = charge;
			for (const window of windows) this.windows.set(window.id, window);
		} catch (error) {
			renameSync(this.file, `${this.file}.unreadable`);
			throw new Error(`${this.file} was set aside as ${this.file}.unreadable: ${errorText(error)}`);
		}
	}
}
