/**
 * What a bot's own session reports to the main session: what it spent since its charge watermark, as one charge the main
 * session's cost view takes whenever its usage grows (a turn's end, a worker's usage receipt), and each turn's last words,
 * the bot's summary in the roster; and the accounting that reports both, the charges exactly once across reopens.
 */

import type { Usage } from "@caupulican/pi-ai";
import type { SessionManager } from "../../kernel/session/session-manager.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import { createEmptyUsage } from "../../kernel/usage.ts";
import type { AgentSession } from "../agent-session.ts";
import type { SpawnedUsageReceiptDisposition } from "../cost/spawned-usage-receipt.ts";
import { usageReach, usageSince } from "../cost/usage-delta.ts";
import { BOT_SESSION_USAGE_LABEL } from "../cost/usage-records.ts";
import { deriveSpawnedUsageReportId, hasReportableUsage } from "../spawned-usage.ts";
import { BotChargeMark, botSessionInstance } from "./bot-charge-mark.ts";
import type { BotChargesHeld, BotChargeUnread } from "./bot-charges-held.ts";
import type { BotCharge, BotChargeReport, BotChargeState, BotSpendLedger } from "./bot-spend-ledger.ts";

/** How many unreadable root files one notice names; the rest are counted. */
const UNREAD_NAMED = 3;

/** How long after a failed read-back of a watermark the next one may start. */
const RECOVERY_RETRY_MS = 60_000;

/** A cumulative usage reading's fields, in a fixed order: what a range's report id is derived from. */
function readingKey(usage: Usage): string[] {
	const { input, output, cacheRead, cacheWrite, totalTokens, cost } = usage;
	return [
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens,
		cost.input,
		cost.output,
		cost.cacheRead,
		cost.cacheWrite,
		cost.total,
	].map(String);
}

/**
 * The charge of what the session spent between its cumulative usage readings `from` and `through` (each field of
 * `through` at or past `from`'s): undefined when the session has no model or spent nothing reportable between them.
 * Its report id is derived from the range it covers (the session, the instance of its file, and every field of both ends),
 * so the same range is always the same charge, and a file created again under the same id never repeats an earlier one's; the report names the range's end, so the root holds how far the charges reach, and `recordedAt`,
 * when the range was fixed: the day it counts on, in whichever root's file holds it.
 */
export function botTurnCharge(
	agentId: string,
	session: Pick<AgentSession, "model" | "sessionId">,
	instance: string,
	from: Usage,
	through: Usage,
	recordedAt: string,
): BotCharge | undefined {
	const model = session.model;
	if (!model) return undefined;
	const usage = usageSince(from, through);
	if (!hasReportableUsage(usage)) return undefined;
	const sessionId = session.sessionId;
	return {
		usage,
		report: {
			agentId,
			reportId: deriveSpawnedUsageReportId(BOT_SESSION_USAGE_LABEL, sessionId, [
				instance,
				...readingKey(from),
				...readingKey(through),
			]),
			sessionId,
			instance,
			provider: model.provider,
			model: model.id,
			from,
			through,
			recordedAt,
		},
	};
}

/**
 * The words of the newest assistant message that has any, written at or after `since`: the outcome of the turn that
 * began then. Read by time, so a compaction during the turn does not hide its answer.
 */
export function lastAssistantText(messages: readonly AgentMessage[], since: number): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		if (message.timestamp < since) return "";
		const text = message.content
			.map((part) => (part.type === "text" ? part.text : ""))
			.join("\n")
			.trim();
		if (text.length > 0) return text;
	}
	return "";
}

/** Where one bot session's turns report: the root's cost view, the store's outcome, and the owner's warnings. */
export interface BotTurnAccountingPorts {
	/**
	 * Delivers a charge to the cost view of the root the bot answers now, once per report id: `persisted` once the root's
	 * file holds it (`deliverSpawnedUsageReceipt`). Throws a failure to record it.
	 */
	charge(usage: Usage, report: BotChargeReport): SpawnedUsageReceiptDisposition;
	/**
	 * How far the roots of the process hold the charges of file instance `instance` of bot session `sessionId` in the
	 * files written since `since` (ms since the epoch), the charges they hold unwritten and the files that could not be
	 * read (`botChargesHeld`); rejects when no root answers.
	 */
	chargesHeld(sessionId: string, instance: string, since: number): Promise<BotChargesHeld>;
	/** Calls `listener` with the charges the answering root's file holds as each of its writes lands; returns the unsubscribe. */
	chargesPersisted(listener: (rootSessionId: string, reportIds: readonly string[]) => void): () => void;
	/** The session of the root the bot answers now. */
	rootSessionId(): string;
	/**
	 * Whether the root the bot answers now keeps a session file: one that keeps none (`--no-session`, an in-memory SDK
	 * session) holds a charge as it holds its own spend, only while it lives: the charge is settled when it takes it.
	 */
	rootKeepsFile(): boolean;
	/**
	 * A charge was not recorded: the owner is told why, once until a charge reaches the root again (it is delivered again
	 * with the next charge).
	 */
	chargeNotRecorded(reason: string): void;
	/**
	 * A read-back read roots' files or directories as holding none of the session's charges (they could not be read): the
	 * owner is told of each once per session load, once the watermark read back is adopted, the first ones by name
	 * (`named`) and the rest counted (`more`); the ranges they hold may be charged again.
	 */
	chargesUnread(named: readonly BotChargeUnread[], more: number): void;
	/**
	 * How far the root holds the session's charges could not be marked in its transcript (`BotChargeMark`): the owner is
	 * told why, once until a mark is kept again.
	 */
	markNotKept(reason: string): void;
	/** Records a turn's last words as the bot's outcome: its roster summary and unread mark. */
	outcome(summary: string): void;
}

/**
 * One bot session's spend and turns as its host counts them. The charge follows the session's recorded cumulative usage
 * (`getDurableCumulativeUsage`: never the System One usage not recorded yet), not its turns: what the session spent past
 * the watermark of its spend ledger (`BotChargeState`) is charged at each turn end and each time the session's usage
 * grows (a worker's usage receipt), so spend that lands between turns, a compaction between runs, or a turn cut by a crash
 * is charged once, whenever it lands. The watermark only moves forward, field by field: a reading short of it in some field
 * (a history still loading, or one whose load failed) charges only the fields that passed it, and the rest once the
 * reading reaches past it, so nothing is charged twice and nothing is dropped. Each charge fixes its range first: the
 * charge (its usage, the report id its range derives, the range's end and when it was fixed) joins the ledger's pending
 * charges and the watermark moves to the range's end, in one write, before the charge is delivered; it leaves the pending
 * charges once the root's file holds it, either at once or when the root's write lands (a root holds a charge unwritten
 * until it writes its file; a root that keeps no file holds it as it holds its own spend, for as long as it lives, so the
 * charge is settled when it takes it and counts nowhere once that root ends). Every charge delivers the pending
 * ones again first, in order, so a range a root lost is appended again before any later one; the root's report-id index
 * keeps one it holds from being appended twice, and its readers take each charge's range (`from` to `through`) once
 * however often and wherever it is recorded (`ChargedRanges`). At each turn's end and at the session's close, how far the
 * root's files hold the session's charges is marked in the bot's own transcript (`BotChargeMark`). Ranges reach the root
 * in order: while an earlier one fails to be delivered, later ones are fixed and wait behind it. A reopen delivers the
 * pending charges again under their own ids. A session the ledger holds no watermark for (a new bot, a new session
 * file or one created again under the same id: each file instance has a watermark of its own, `botSessionInstance`; a
 * ledger whose watermark was lost) never starts one at what it spent: a session that recorded no reportable usage
 * starts at zero (none of its spend can have been charged), any other at the furthest of how far the roots' files hold its
 * charges (`botChargesHeld`), its transcript's mark, and the ledger's pending charges of it, the charges a live root holds
 * unwritten taken back as pending; nothing is charged until that read-back lands. The turn's last words written since its
 * start are its outcome, reported once per turn on the boundary every per-turn count of the session reads
 * (`observeSessionTurns`).
 */
export class BotTurnAccounting {
	private readonly agentId: string;
	private readonly session: Pick<AgentSession, "model" | "getDurableCumulativeUsage" | "sessionId" | "messages">;
	private readonly transcript: Pick<SessionManager, "getHeader">;
	private readonly mark: BotChargeMark;
	private readonly ledger: BotSpendLedger;
	private readonly ports: BotTurnAccountingPorts;
	/** When the running turn began: its own messages are the ones written since; absent between turns. */
	private startedAt: number | undefined;
	/** The session file instance whose watermark is being read back from the root. */
	private recovering: { readonly sessionId: string; readonly instance: string } | undefined;
	/** After a failed read-back: no new one starts before this time (ms since the epoch). */
	private recoverAfter = 0;
	/** The pending charges a root holds unwritten, by report id, with that root's session. */
	private readonly awaiting = new Map<string, string>();
	/**
	 * The root each charge this process fixed answered when it was fixed, by report id: a root that keeps no file settles
	 * only the charges fixed while it answers (in memory alone; a charge left from before stays for a root with a file).
	 */
	private readonly fixedFor = new Map<string, string>();
	/** The root whose writes are watched for the awaited charges, and the unsubscribe. */
	private watching: { readonly root: string; readonly stop: () => void } | undefined;
	/** How far the root's files hold this session's charges past its transcript's last mark: marked at the turn's end. */
	private unmarked: { readonly sessionId: string; readonly instance: string; readonly through: Usage } | undefined;
	/** A charge was not recorded and the owner was told; told again only after a charge reaches the root. */
	private notRecordedTold = false;
	/** The root files and directories a read-back could not read that the owner was told of: each is told once. */
	private readonly unreadTold = new Set<string>();
	/** A mark was not kept and the owner was told; told again only after a mark is kept. */
	private markNotKeptTold = false;
	private closed = false;

	constructor(
		agentId: string,
		session: BotTurnAccounting["session"],
		transcript: Pick<SessionManager, "getHeader" | "getEntries" | "getSessionId" | "appendCustomEntry">,
		ledger: BotSpendLedger,
		ports: BotTurnAccountingPorts,
	) {
		this.agentId = agentId;
		this.session = session;
		this.transcript = transcript;
		this.mark = new BotChargeMark(transcript);
		this.ledger = ledger;
		this.ports = ports;
	}

	/**
	 * The session is ready to report (its ports reach a root): the pending charges are delivered again, and what the
	 * session spent since the watermark is charged.
	 */
	resume(): void {
		this.charge();
	}

	/**
	 * The session closed: how far the root's files hold its charges is marked, then nothing is charged or written from now
	 * on (a watermark read back after it is dropped).
	 */
	close(): void {
		this.keepMark();
		this.closed = true;
		this.unwatch();
	}

	/** When the running turn began (ms since the epoch); undefined between turns. */
	get turnStartedAt(): number | undefined {
		return this.startedAt;
	}

	/** A turn began. */
	started(): void {
		this.startedAt = Date.now();
	}

	/**
	 * The turn ended (or its session closes, a turn open or not): the spend since the last charge, the mark of how far the
	 * root's files hold the charges, then the turn's outcome when one was open.
	 */
	ended(): void {
		this.charge();
		this.keepMark();
		const since = this.startedAt;
		this.startedAt = undefined;
		if (since === undefined) return;
		const summary = lastAssistantText(this.session.messages, since);
		// A turn that said nothing (it failed before an answer) records nothing: an earlier turn's answer is not news again.
		if (summary.length > 0) this.ports.outcome(summary);
	}

	/**
	 * Delivers the pending charges again, then charges what the session spent past the watermark: its range is fixed in
	 * the ledger first, then delivered, unless an earlier range failed to be. A ledger that is not read or cannot be written
	 * charges nothing now; the range is charged by a later charge.
	 */
	charge(): void {
		if (this.closed || !this.ledger.readable()) return;
		const keepsFile = this.ports.rootKeepsFile();
		const delivered = this.deliverPending(keepsFile);
		const state = this.watermark();
		if (!state) return;
		const { instance, through, pending } = state;
		const charge = botTurnCharge(
			this.agentId,
			this.session,
			instance,
			through,
			usageReach(through, this.session.getDurableCumulativeUsage().usage),
			new Date().toISOString(),
		);
		if (!charge) return;
		pending.push(charge);
		state.through = charge.report.through;
		if (!this.ledger.write()) {
			pending.pop();
			state.through = through;
			return;
		}
		this.fixedFor.set(charge.report.reportId, this.ports.rootSessionId());
		if (delivered && this.deliver(charge, keepsFile)) this.settled([charge], keepsFile);
	}

	/** The instance of this session's file (`botSessionInstance`). */
	private instance(): string {
		return botSessionInstance(this.transcript);
	}

	/**
	 * This session's watermark: the ledger's when it reads this session's file instance. Otherwise it is read back
	 * (`recover`) and undefined until then.
	 */
	private watermark(): BotChargeState | undefined {
		const kept = this.ledger.charge;
		const sessionId = this.session.sessionId;
		const instance = this.instance();
		if (kept?.sessionId === sessionId && kept.instance === instance) return kept;
		this.recover(sessionId, instance);
		return undefined;
	}

	/**
	 * Starts this session's watermark (see the class comment), then charges past it. A session that recorded no reportable
	 * usage starts at zero at once; any other is read back from the roots' files changed since the session began. A read-back
	 * that fails is tried again with the first charge a minute or more later; its reason is told as a charge not recorded.
	 */
	private recover(sessionId: string, instance: string): void {
		const recovering = this.recovering;
		if ((recovering?.sessionId === sessionId && recovering.instance === instance) || Date.now() < this.recoverAfter)
			return;
		const reading = this.session.getDurableCumulativeUsage();
		if (reading.settled && !hasReportableUsage(reading.usage)) {
			this.adopt(sessionId, instance, { through: createEmptyUsage(), unwritten: [] });
			return;
		}
		this.recovering = { sessionId, instance };
		// The roots' files written since the session's file began (its instance), or since its last mark: one not written
		// since holds none of its charges past the mark (a range read again anyway is taken once by the root's readers,
		// `ChargedRanges`).
		const began = Date.parse(instance);
		const since = Math.max(Number.isFinite(began) ? began : 0, this.mark.markedAt() ?? 0);
		void Promise.resolve()
			.then(() => this.ports.chargesHeld(sessionId, instance, since))
			.then(
				(held) => {
					this.recovering = undefined;
					if (this.closed) return;
					if (this.session.sessionId !== sessionId || this.instance() !== instance || !this.ledger.readable())
						return;
					if (!this.adopt(sessionId, instance, held)) return;
					// Told only once the watermark it lowered is adopted: a read-back dropped changes nothing.
					const newly = held.unread.filter(({ key }) => !this.unreadTold.has(key));
					for (const { key } of newly) this.unreadTold.add(key);
					if (newly.length > 0)
						this.ports.chargesUnread(newly.slice(0, UNREAD_NAMED), Math.max(0, newly.length - UNREAD_NAMED));
					this.charge();
				},
				(error: unknown) => {
					this.recovering = undefined;
					this.recoverAfter = Date.now() + RECOVERY_RETRY_MS;
					if (!this.closed) this.notRecorded(error);
				},
			);
	}

	/**
	 * Writes the watermark of file instance `instance` of `sessionId` read back as `held`: the furthest of the roots' files,
	 * the transcript's mark and the pending charges of that instance, the ones a live root holds unwritten taken back as
	 * pending before the pending charges kept (those of the session or file instance before stay: they are their own
	 * ranges, delivered under their own ids). True once written.
	 */
	private adopt(sessionId: string, instance: string, held: Pick<BotChargesHeld, "through" | "unwritten">): boolean {
		const kept = this.ledger.charge;
		if (kept?.sessionId === sessionId && kept.instance === instance) return false;
		const keptPending = kept?.pending ?? [];
		const keptIds = new Set(keptPending.map((charge) => charge.report.reportId));
		let through = usageReach(held.through, this.mark.reach() ?? held.through);
		for (const { report } of keptPending)
			if (report.sessionId === sessionId && report.instance === instance)
				through = usageReach(through, report.through);
		const taken: BotCharge[] = [];
		for (const { usage, reportId, provider, model, from, through: end, recordedAt } of held.unwritten) {
			through = usageReach(through, end);
			if (keptIds.has(reportId)) continue;
			taken.push({
				usage,
				report: {
					agentId: this.agentId,
					reportId,
					sessionId,
					instance,
					provider,
					model,
					from,
					through: end,
					recordedAt,
				},
			});
		}
		this.ledger.charge = {
			sessionId,
			instance,
			through: structuredClone(through),
			pending: [...taken, ...keptPending],
		};
		if (this.ledger.write()) return true;
		this.ledger.charge = kept;
		return false;
	}

	/**
	 * Delivers each pending charge again, oldest first, and drops the ones the root's file holds now: one the answering root
	 * holds is found through its report-id index and not appended again, and one a root lost (a reopen of its file drops
	 * what it never wrote) is appended again before any later one. A root that keeps no file is given only the charges
	 * fixed while it answers: any other (one a root with a file of an earlier process left, or one taken back from another
	 * root's unwritten entries) waits for a root with a file, never counted in this one's views. False when one failed to be
	 * delivered: the ones after it wait.
	 */
	private deliverPending(keepsFile: boolean): boolean {
		const held: BotCharge[] = [];
		let delivered = true;
		const root = this.ports.rootSessionId();
		for (const charge of this.ledger.charge?.pending ?? []) {
			if (!keepsFile && this.fixedFor.get(charge.report.reportId) !== root) continue;
			const persisted = this.deliver(charge, keepsFile);
			if (persisted === undefined) {
				delivered = false;
				break;
			}
			if (persisted) held.push(charge);
		}
		if (held.length > 0) this.settled(held, keepsFile);
		return delivered;
	}

	/**
	 * Settles charges the root holds for good; a root that keeps no file took them now, so the mark is kept at once: a crash
	 * before the turn's end then does not charge their ranges again.
	 */
	private settled(held: readonly BotCharge[], keepsFile: boolean): void {
		if (this.settle(held) && !keepsFile) this.keepMark();
	}

	/**
	 * Delivers one charge: true once the root holds it for good (its file holds it, or it keeps no file and the charge was
	 * fixed while it answers: it holds the charge as it holds its own spend, while it lives, and the charge is settled at
	 * take, `deliverPending`), false while the root holds it unwritten
	 * (its write is awaited), undefined when it did not reach the root (a failure, or a root on another session file than
	 * the one the charge was sent to).
	 */
	private deliver(charge: BotCharge, keepsFile: boolean): boolean | undefined {
		let disposition: SpawnedUsageReceiptDisposition;
		try {
			disposition = this.ports.charge(charge.usage, charge.report);
		} catch (error) {
			this.notRecorded(error);
			return undefined;
		}
		if (disposition === "foreign_session") return undefined;
		this.notRecordedTold = false;
		if (disposition === "persisted" || !keepsFile) return true;
		this.awaitWrite(charge.report.reportId);
		return false;
	}

	/** Waits for the answering root's write to hold the charge `reportId`, which it holds unwritten. */
	private awaitWrite(reportId: string): void {
		const root = this.ports.rootSessionId();
		this.awaiting.set(reportId, root);
		if (this.watching?.root === root) return;
		this.unwatch();
		this.watching = {
			root,
			// Taken up once the root's write has returned: the ledger and the bot's transcript are never written inside it.
			stop: this.ports.chargesPersisted((written, reportIds) =>
				queueMicrotask(() => this.written(written, reportIds)),
			),
		};
	}

	/**
	 * The root `rootSessionId` wrote its file, holding the charges `reportIds`: the awaited ones among them are settled. One
	 * the write did not hold (a reopen of the root's file dropped it) stays pending and is delivered again with the next
	 * charge.
	 */
	private written(rootSessionId: string, reportIds: readonly string[]): void {
		if (this.closed) return;
		const ids = new Set(reportIds);
		const held = (this.ledger.charge?.pending ?? []).filter(
			({ report }) => this.awaiting.get(report.reportId) === rootSessionId && ids.has(report.reportId),
		);
		if (held.length > 0) this.settle(held);
	}

	private unwatch(): void {
		this.watching?.stop();
		this.watching = undefined;
	}

	/** Tells the owner a charge was not recorded, once until a charge reaches the root again. */
	private notRecorded(error: unknown): void {
		if (this.notRecordedTold) return;
		this.notRecordedTold = true;
		this.ports.chargeNotRecorded(error instanceof Error ? error.message : String(error));
	}

	/**
	 * Drops charges the root holds for good from the pending ones and writes the ledger; the range end up to which every
	 * charge of this session is held now is marked in its transcript at the turn's end (`keepMark`). A ledger that cannot be
	 * written keeps them pending, unsettled, to be delivered again with the next charge. True when the mark moved.
	 */
	private settle(held: readonly BotCharge[]): boolean {
		const state = this.ledger.charge;
		if (!state) return false;
		const pending = state.pending;
		state.pending = pending.filter((charge) => !held.includes(charge));
		if (!this.ledger.write()) {
			state.pending = pending;
			return false;
		}
		for (const charge of held) {
			this.awaiting.delete(charge.report.reportId);
			this.fixedFor.delete(charge.report.reportId);
		}
		if (this.awaiting.size === 0) this.unwatch();
		const sessionId = this.session.sessionId;
		const instance = this.instance();
		let settled: Usage | undefined;
		for (const charge of pending) {
			if (charge.report.sessionId !== sessionId || charge.report.instance !== instance) continue;
			if (!held.includes(charge)) break;
			settled = charge.report.through;
		}
		if (!settled) return false;
		const unmarked = this.unmarked;
		const kept = unmarked?.sessionId === sessionId && unmarked.instance === instance ? unmarked.through : undefined;
		this.unmarked = { sessionId, instance, through: kept ? usageReach(kept, settled) : settled };
		return true;
	}

	/**
	 * Marks in the bot's transcript how far the root's files hold this session's charges, when that moved since the last
	 * mark; a failure is told once until a mark is kept (the ledger stands as written; the mark is tried again at the next
	 * turn end).
	 */
	private keepMark(): void {
		const unmarked = this.unmarked;
		if (this.closed || unmarked === undefined) return;
		if (unmarked.sessionId !== this.session.sessionId || unmarked.instance !== this.instance()) {
			this.unmarked = undefined;
			return;
		}
		try {
			this.mark.advance(unmarked.through);
			this.unmarked = undefined;
			this.markNotKeptTold = false;
		} catch (error) {
			if (this.markNotKeptTold) return;
			this.markNotKeptTold = true;
			this.ports.markNotKept(error instanceof Error ? error.message : String(error));
		}
	}
}
