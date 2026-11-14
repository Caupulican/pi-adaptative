/**
 * What a bot's own session reports to the main session: what it spent since its charge watermark, as one charge the main
 * session's cost view takes whenever its usage grows (a turn's end, a worker's usage receipt), and each turn's last words,
 * the bot's summary in the roster; and the accounting that reports both, the charges exactly once across reopens.
 */

import type { Usage } from "@caupulican/pi-ai";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import type { SessionManager } from "../../kernel/session/session-manager.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import type { AgentSession } from "../agent-session.ts";
import { isUsage } from "../cost/session-usage.ts";
import { usageSince } from "../cost/usage-delta.ts";
import { deriveSpawnedUsageReportId, hasReportableUsage } from "../spawned-usage.ts";
import { isPlainRecord } from "../util/value-guards.ts";

/** One turn's charge, as the main session's ledger takes it. */
export interface BotTurnUsageReport {
	readonly agentId: string;
	readonly reportId: string;
	/** The bot's own session id. */
	readonly sessionId: string;
	readonly provider: string;
	readonly model: string;
}

/**
 * The custom entry of a bot's own transcript that marks how much of the session's cumulative usage its charges cover
 * (`BotChargeMark`). Never sent to a model.
 */
export const BOT_CHARGE_MARK_CUSTOM_TYPE = "pi_bot_charge_mark";

/** One charge of the session's spend, as the main session's ledger takes it. */
interface BotCharge {
	readonly usage: Usage;
	readonly report: BotTurnUsageReport;
}

/**
 * The watermark of a bot session's charges, kept in its own transcript so a reopen resumes from it. `through` is the
 * session's cumulative usage its charges cover. A mark written before its charge is reported carries the charge: while no
 * later mark follows it, that charge is reported again (under the same report id, which the main session's ledger takes
 * once).
 */
interface BotChargeMark {
	readonly v: 1;
	readonly through: Usage;
	readonly charge?: BotCharge;
}

function chargeMarkOf(entry: SessionEntry): BotChargeMark | undefined {
	if (entry.type !== "custom" || entry.customType !== BOT_CHARGE_MARK_CUSTOM_TYPE) return undefined;
	const data = entry.data;
	if (!isPlainRecord(data) || data.v !== 1 || !isUsage(data.through)) return undefined;
	const charge = data.charge;
	if (charge === undefined) return { v: 1, through: data.through };
	if (!isPlainRecord(charge) || !isUsage(charge.usage) || !isPlainRecord(charge.report)) return undefined;
	const { agentId, reportId, sessionId, provider, model } = charge.report;
	if (![agentId, reportId, sessionId, provider, model].every((field) => typeof field === "string")) return undefined;
	return { v: 1, through: data.through, charge: charge as unknown as BotCharge };
}

/** The newest readable charge mark of a transcript; undefined when it has none. */
function latestChargeMark(entries: readonly SessionEntry[]): BotChargeMark | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		const mark = entry ? chargeMarkOf(entry) : undefined;
		if (mark) return mark;
	}
	return undefined;
}

/**
 * The charge of what the session spent since its cumulative usage was `from`, with the cumulative usage it reaches:
 * undefined when the session has no model or spent nothing reportable since. Its report id is derived from the range it
 * covers (the session, and the cumulative usage at both ends), so the same range is always the same charge.
 */
export function botTurnCharge(
	agentId: string,
	session: Pick<AgentSession, "model" | "getCumulativeUsage" | "sessionId">,
	from: Usage,
): (BotCharge & { readonly through: Usage }) | undefined {
	const model = session.model;
	if (!model) return undefined;
	const through = structuredClone(session.getCumulativeUsage());
	const usage = usageSince(from, through);
	if (!hasReportableUsage(usage)) return undefined;
	const sessionId = session.sessionId;
	return {
		usage,
		through,
		report: {
			agentId,
			reportId: deriveSpawnedUsageReportId("bot-session", sessionId, [
				String(from.totalTokens),
				String(from.cost.total),
				String(through.totalTokens),
				String(through.cost.total),
			]),
			sessionId,
			provider: model.provider,
			model: model.id,
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
	/** Records a charge with the cost view of the root the bot answers now; throws a failure to record it. */
	charge(usage: Usage, report: BotTurnUsageReport): void;
	/** A charge was not recorded: the owner is told why (it is reported again before the next one). */
	chargeNotRecorded(reason: string): void;
	/** Records a turn's last words as the bot's outcome: its roster summary and unread mark. */
	outcome(summary: string): void;
}

/**
 * One bot session's spend and turns as its host counts them. The charge follows the session's usage entries, not its
 * turns: what the session spent since its charge watermark (`BotChargeMark`, kept in its own transcript) is charged at
 * each turn end and each time the session records spawned usage (a worker's usage receipt), so spend that lands between
 * turns, a compaction between runs, or a turn cut by a crash is charged once, whenever it lands. Each charge writes its
 * mark with the charge first, then reports it, then writes the settled mark: a crash or a refused report between the two
 * leaves the charge to be reported again under the same report id, which the root's ledger and the daily brake take once
 * (`deriveSpawnedUsageReportId`). The turn's last words written since its start are its outcome, reported once per turn on
 * the boundary every per-turn count of the session reads (`observeSessionTurns`).
 */
export class BotTurnAccounting {
	private readonly agentId: string;
	private readonly session: Pick<AgentSession, "model" | "getCumulativeUsage" | "sessionId" | "messages">;
	private readonly transcript: Pick<SessionManager, "appendCustomEntry">;
	private readonly ports: BotTurnAccountingPorts;
	/** The session's cumulative usage the charges cover: the next charge starts there. */
	private chargedThrough: Usage;
	/** A charge whose mark is written and whose report was not recorded: reported again before the next charge. */
	private unreported: BotCharge | undefined;
	/** The transcript had no mark when the session was loaded: the first is written at `resume`. */
	private unmarked: boolean;
	/** When the running turn began: its own messages are the ones written since; absent between turns. */
	private startedAt: number | undefined;

	/**
	 * Reads the watermark from the newest charge mark of `transcript`. A transcript with none (a new session, or one an
	 * earlier build charged per turn) starts at what the session has spent now: an earlier build charged its turns already.
	 */
	constructor(
		agentId: string,
		session: Pick<AgentSession, "model" | "getCumulativeUsage" | "sessionId" | "messages">,
		transcript: Pick<SessionManager, "getEntries" | "appendCustomEntry">,
		ports: BotTurnAccountingPorts,
	) {
		this.agentId = agentId;
		this.session = session;
		this.transcript = transcript;
		this.ports = ports;
		const mark = latestChargeMark(transcript.getEntries());
		this.chargedThrough = structuredClone(mark?.through ?? session.getCumulativeUsage());
		this.unreported = mark?.charge;
		this.unmarked = mark === undefined;
	}

	/**
	 * The session is ready to report (its ports reach a root): a charge a reopen found unreported is reported again, a
	 * transcript with no mark gets its first, and what the session spent since the watermark is charged.
	 */
	resume(): void {
		if (this.unmarked && hasReportableUsage(this.chargedThrough)) this.mark({ v: 1, through: this.chargedThrough });
		this.unmarked = false;
		this.charge();
	}

	/** A turn began. */
	started(): void {
		this.startedAt = Date.now();
	}

	/**
	 * The turn ended (or its session closes, a turn open or not): the spend since the last charge, then the turn's outcome
	 * when one was open.
	 */
	ended(): void {
		this.charge();
		const since = this.startedAt;
		this.startedAt = undefined;
		if (since === undefined) return;
		const summary = lastAssistantText(this.session.messages, since);
		// A turn that said nothing (it failed before an answer) records nothing: an earlier turn's answer is not news again.
		if (summary.length > 0) this.ports.outcome(summary);
	}

	/**
	 * Charges what the session spent since the watermark, once: an unreported charge first (under its own report id), then
	 * the new range's mark, its report and the settled mark. A mark that cannot be written charges nothing now; the range
	 * is charged by the next charge.
	 */
	charge(): void {
		if (this.unreported && !this.report(this.unreported)) return;
		const charge = botTurnCharge(this.agentId, this.session, this.chargedThrough);
		if (!charge) return;
		const { through, ...reported } = charge;
		if (!this.mark({ v: 1, through, charge: reported })) return;
		this.chargedThrough = through;
		this.unreported = reported;
		this.report(reported);
	}

	/** Reports a charge whose mark is written; once recorded, the settled mark follows. True when it was recorded. */
	private report(charge: BotCharge): boolean {
		try {
			this.ports.charge(charge.usage, charge.report);
		} catch (error) {
			this.ports.chargeNotRecorded(error instanceof Error ? error.message : String(error));
			return false;
		}
		this.unreported = undefined;
		this.mark({ v: 1, through: this.chargedThrough });
		return true;
	}

	/** Writes a charge mark into the session's transcript; a failure to write it is told to the owner. */
	private mark(mark: BotChargeMark): boolean {
		try {
			this.transcript.appendCustomEntry(BOT_CHARGE_MARK_CUSTOM_TYPE, mark);
			return true;
		} catch (error) {
			this.ports.chargeNotRecorded(error instanceof Error ? error.message : String(error));
			return false;
		}
	}
}
