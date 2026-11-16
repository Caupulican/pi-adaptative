/**
 * A bot's spend ledger, `bots/<id>/spend.json` in its home: the watermark of its charges to the root it answers
 * (`BotChargeState`) and its spend windows (`SpendWindowRecord`), one record, written atomically and private (0600). Both
 * advance in the same write: whatever the windows counted and the charges covered when a write lands is what a reopen
 * reads, with nothing between two files to disagree.
 *
 * The charge watermark reads the bot session's recorded cumulative usage (`AgentSession.getDurableCumulativeUsage`: every
 * usage entry of its transcript, spawned usage included), which a compaction does not shrink: it only appends. It names
 * the session it reads, so a bot that opens another session file starts that one's watermark and still holds the charges it fixed for
 * the first: a charge's range, report id and usage are written here before it is reported, and stay until the root's
 * file holds it.
 *
 * A record that cannot be read (the file system refused it) stays in place and is read again with each write: nothing is
 * written over it, its windows count in memory meanwhile and are merged with the file's once it reads, and no charge is
 * fixed until then. A record that does not read is set aside (`spend.json.unreadable-<time>`) and what of it reads is
 * kept: windows that did not read start empty, and a charge watermark that did not read is recovered from the charges the
 * main session holds (`BotTurnAccounting`); what of it reads is written at once as the new record. One that cannot be
 * set aside is held as one that cannot be read. The owner is told once that a record is held, and of each set-aside.
 */

import { readFileSync, renameSync } from "node:fs";
import type { Usage } from "@caupulican/pi-ai";
import { isUsage } from "../cost/session-usage.ts";
import { isMissingFileError, writeFileAtomicSync } from "../util/atomic-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { errorText } from "./bot-error-text.ts";

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
	/** The part of it made on a metered model (`isMeteredSpend`): what a dollar ceiling counts of it. */
	meteredForegroundUsd: number;
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
	/** The instance of that session's file the range reads (`botSessionInstance`). */
	readonly instance: string;
	readonly provider: string;
	readonly model: string;
	/** The bot session's cumulative usage the charge's range starts at: the root's readers take ranges once (`ChargedRanges`). */
	readonly from: Usage;
	/** The bot session's cumulative usage the charge's range ends at: how far the root holds its charges. */
	readonly through: Usage;
	/** When the range was fixed (ISO time): the day the charge counts on, in whichever root's file holds it. */
	readonly recordedAt: string;
}

export interface BotCharge {
	readonly usage: Usage;
	readonly report: BotChargeReport;
}

/** How far the bot's charges reach. */
export interface BotChargeState {
	/** The bot session whose cumulative usage `through` reads. */
	sessionId: string;
	/**
	 * The instance of that session's file `through` reads (`botSessionInstance`): a file created again under the same id
	 * is another instance, whose usage starts at zero, so it starts a watermark of its own.
	 */
	instance: string;
	/** That session's cumulative usage the charges cover: the next charge starts there. */
	through: Usage;
	/** Charges whose range is fixed and written and whose report the root's file does not hold yet, oldest first. */
	pending: BotCharge[];
}

/** What the ledger reads of its host and tells the owner (the record that does not read is told once). */
export interface BotSpendLedgerPorts {
	/** The host's clock (ms since the epoch): a record set aside is named by it. */
	now(): number;
	/**
	 * The record could not be read (`reason`), or did not read and could not be set aside (`setAsideError`): it stays in
	 * place and is read again.
	 */
	held(reason: string, setAsideError?: string): void;
	/** The record did not read (`reason`) and was set aside as `file`; `chargesKept`: its charge watermark read. */
	setAside(file: string, reason: string, chargesKept: boolean): void;
	/** The record could not be written. */
	notWritten(reason: string): void;
}

/** What of a record reads: its windows and charge watermark that read, and what did not (`problems`). */
interface ReadRecord {
	readonly windows: readonly SpendWindowRecord[];
	readonly charge: BotChargeState | undefined;
	readonly problems: readonly string[];
}

function parseWindow(value: unknown): SpendWindowRecord | undefined {
	if (!isPlainRecord(value)) return undefined;
	const { id, input, kind, foregroundUsd, meteredForegroundUsd, attemptIds, updatedAt } = value;
	if (typeof id !== "string" || typeof input !== "string" || typeof kind !== "string") return undefined;
	const dollars = (usd: unknown): usd is number => typeof usd === "number" && Number.isFinite(usd) && usd >= 0;
	if (!dollars(foregroundUsd) || !dollars(meteredForegroundUsd)) return undefined;
	if (typeof updatedAt !== "number" || !Array.isArray(attemptIds)) return undefined;
	if (!attemptIds.every((attemptId) => typeof attemptId === "string")) return undefined;
	return { id, input, kind, foregroundUsd, meteredForegroundUsd, attemptIds: [...attemptIds], updatedAt };
}

function parseCharge(value: unknown): BotCharge | undefined {
	if (!isPlainRecord(value) || !isUsage(value.usage) || !isPlainRecord(value.report)) return undefined;
	const { agentId, reportId, sessionId, instance, provider, model, from, through, recordedAt } = value.report;
	if (
		typeof agentId !== "string" ||
		typeof reportId !== "string" ||
		typeof sessionId !== "string" ||
		typeof instance !== "string" ||
		typeof provider !== "string" ||
		typeof model !== "string" ||
		!isUsage(from) ||
		!isUsage(through) ||
		typeof recordedAt !== "string"
	)
		return undefined;
	return {
		usage: value.usage,
		report: { agentId, reportId, sessionId, instance, provider, model, from, through, recordedAt },
	};
}

function parseChargeState(value: unknown): BotChargeState | undefined {
	if (!isPlainRecord(value) || !Array.isArray(value.pending)) return undefined;
	const { sessionId, instance, through } = value;
	if (typeof sessionId !== "string" || typeof instance !== "string" || !isUsage(through)) return undefined;
	const pending = value.pending.map(parseCharge);
	if (!pending.every((charge): charge is BotCharge => charge !== undefined)) return undefined;
	return { sessionId, instance, through, pending };
}

/** What of the record `text` reads (see `ReadRecord`). */
function readRecord(text: string): ReadRecord {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return { windows: [], charge: undefined, problems: [errorText(error)] };
	}
	if (!isPlainRecord(value) || value.v !== 1 || !Array.isArray(value.windows))
		return { windows: [], charge: undefined, problems: ["not a bot spend record"] };
	const problems: string[] = [];
	const windows = value.windows.flatMap((item) => parseWindow(item) ?? []);
	const unread = value.windows.length - windows.length;
	if (unread > 0) problems.push(`${unread} of its spend windows did not read`);
	const charge = value.charge === undefined ? undefined : parseChargeState(value.charge);
	if (value.charge !== undefined && !charge) problems.push("its charge watermark did not read");
	return { windows, charge, problems };
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
	/** The file is in place and was not read: nothing is written over it, and it is read again (`readable`). */
	private held = false;
	/** The owner was told the record is held in place. */
	private toldHeld = false;

	constructor(file: string, ports: BotSpendLedgerPorts) {
		this.file = file;
		this.ports = ports;
		this.read();
	}

	/**
	 * Whether the ledger holds what its file holds (none, when there is no file): a held record is read again first. While
	 * it is not, the windows count in memory and no charge is fixed.
	 */
	readable(): boolean {
		if (this.held) this.read();
		return !this.held;
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
		if (!this.readable()) {
			this.dirty = true;
			return false;
		}
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
	 * Reads the record (see the module comment): one that cannot be read, or that does not read and cannot be set aside, is
	 * held; what reads is merged with the windows counted meanwhile.
	 */
	private read(): void {
		let text: string;
		try {
			text = readFileSync(this.file, "utf8");
		} catch (error) {
			if (isMissingFileError(error)) {
				this.held = false;
				return;
			}
			this.hold(errorText(error));
			return;
		}
		const record = readRecord(text);
		if (record.problems.length > 0) {
			const reason = record.problems.join("; ");
			const aside = `${this.file}.unreadable-${this.ports.now()}`;
			try {
				renameSync(this.file, aside);
			} catch (error) {
				this.hold(reason, errorText(error));
				return;
			}
			this.held = false;
			this.merge(record);
			this.ports.setAside(aside, reason, record.charge !== undefined);
			// What of it read is written at once as the new record, so a crash before the next spend keeps it.
			this.write();
			return;
		}
		this.held = false;
		this.merge(record);
	}

	/** The record stays in place, read again with the next write; the owner is told once while it does. */
	private hold(reason: string, setAsideError?: string): void {
		this.held = true;
		if (this.toldHeld) return;
		this.toldHeld = true;
		this.ports.held(reason, setAsideError);
	}

	/**
	 * Takes what the record read: its charge watermark (none is fixed while the record is held, so there is none in memory
	 * to keep), and its windows, each merged with the one counted in memory meanwhile under the same id.
	 */
	private merge(record: ReadRecord): void {
		if (record.charge) this.charge = record.charge;
		for (const window of record.windows) {
			const counted = this.windows.get(window.id);
			if (!counted) {
				this.windows.set(window.id, window);
				continue;
			}
			counted.foregroundUsd += window.foregroundUsd;
			counted.meteredForegroundUsd += window.meteredForegroundUsd;
			for (const attemptId of window.attemptIds)
				if (!counted.attemptIds.includes(attemptId)) counted.attemptIds.push(attemptId);
			counted.updatedAt = Math.max(counted.updatedAt, window.updatedAt);
			this.dirty = true;
		}
	}
}
