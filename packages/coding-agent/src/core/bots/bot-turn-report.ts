/**
 * What a bot's own session reports to the main session: what it spent since its charge watermark, as one charge the main
 * session's cost view takes whenever its usage grows (a turn's end, a worker's usage receipt), and each turn's last words,
 * the bot's summary in the roster; and the accounting that reports both, the charges exactly once across reopens.
 */

import type { Usage } from "@caupulican/pi-ai";
import type { AgentMessage } from "../../kernel/types.ts";
import type { AgentSession } from "../agent-session.ts";
import type { SpawnedUsageReceiptDisposition } from "../cost/spawned-usage-receipt.ts";
import { usageReach, usageSince } from "../cost/usage-delta.ts";
import { deriveSpawnedUsageReportId, hasReportableUsage } from "../spawned-usage.ts";
import type { BotCharge, BotChargeReport, BotChargeState, BotSpendLedger } from "./bot-spend-ledger.ts";

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
 * Its report id is derived from the range it covers (the session, and every field of both ends), so the same range is
 * always the same charge; the report names the range's end, so the root holds how far the charges reach.
 */
export function botTurnCharge(
	agentId: string,
	session: Pick<AgentSession, "model" | "sessionId">,
	from: Usage,
	through: Usage,
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
			reportId: deriveSpawnedUsageReportId("bot-session", sessionId, [...readingKey(from), ...readingKey(through)]),
			sessionId,
			provider: model.provider,
			model: model.id,
			through,
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
	 * How far the root the bot answers now holds the charges of bot session `sessionId` (`botChargesHeld`), asked the way
	 * a charge is delivered; rejects when no root answers or its records do not read.
	 */
	chargesHeld(sessionId: string): Promise<Usage>;
	/**
	 * A charge was not recorded: the owner is told why, once until a charge reaches the root again (it is delivered again
	 * with the next charge).
	 */
	chargeNotRecorded(reason: string): void;
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
 * charge (its usage, the report id its range derives and the range's end) joins the ledger's pending charges and the
 * watermark moves to the range's end, in one write, before the charge is delivered; it leaves the pending charges only
 * once the root's file holds it. Ranges reach the root in order: while an earlier one fails to be delivered, later ones
 * are fixed and wait behind it. A reopen delivers the pending charges again under their own ids, which the root's ledger
 * and the daily brake take once (`deriveSpawnedUsageReportId`). A session the ledger holds no watermark for (a new bot, a
 * new session file, a ledger whose watermark was lost) never starts one at what it spent: its watermark is read back from
 * how far the root holds its charges (`botChargesHeld`), charging nothing until that lands. The turn's last words
 * written since its start are its outcome, reported once per turn on the boundary every per-turn count of the session
 * reads (`observeSessionTurns`).
 */
export class BotTurnAccounting {
	private readonly agentId: string;
	private readonly session: Pick<AgentSession, "model" | "getDurableCumulativeUsage" | "sessionId" | "messages">;
	private readonly ledger: BotSpendLedger;
	private readonly ports: BotTurnAccountingPorts;
	/** When the running turn began: its own messages are the ones written since; absent between turns. */
	private startedAt: number | undefined;
	/** The session whose watermark is being read back from the root. */
	private recovering: string | undefined;
	/** A charge was not recorded and the owner was told; told again only after a charge reaches the root. */
	private notRecordedTold = false;
	private closed = false;

	constructor(
		agentId: string,
		session: BotTurnAccounting["session"],
		ledger: BotSpendLedger,
		ports: BotTurnAccountingPorts,
	) {
		this.agentId = agentId;
		this.session = session;
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

	/** The session closed: nothing is charged or written from now on (a watermark read back after it is dropped). */
	close(): void {
		this.closed = true;
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
	 * Delivers the pending charges again, then charges what the session spent past the watermark: its range is fixed in
	 * the ledger first, then delivered, unless an earlier range failed to be. A ledger that is not read or cannot be written
	 * charges nothing now; the range is charged by a later charge.
	 */
	charge(): void {
		if (this.closed || !this.ledger.readable()) return;
		const delivered = this.deliverPending();
		const state = this.watermark();
		if (!state) return;
		const { through, pending } = state;
		const charge = botTurnCharge(
			this.agentId,
			this.session,
			through,
			usageReach(through, this.session.getDurableCumulativeUsage()),
		);
		if (!charge) return;
		pending.push(charge);
		state.through = charge.report.through;
		if (!this.ledger.write()) {
			pending.pop();
			state.through = through;
			return;
		}
		if (delivered && this.deliver(charge)) this.settle([charge]);
	}

	/**
	 * This session's watermark: the ledger's when it reads this session. Otherwise it is read back from the root
	 * (`recover`) and undefined until then.
	 */
	private watermark(): BotChargeState | undefined {
		const kept = this.ledger.charge;
		const sessionId = this.session.sessionId;
		if (kept?.sessionId === sessionId) return kept;
		this.recover(sessionId);
		return undefined;
	}

	/**
	 * Starts this session's watermark at how far the root holds its charges, keeping the pending charges of the session
	 * before (they are its own ranges, delivered under their own ids), then charges past it. One that fails is tried again
	 * with the next charge; its reason is told as a charge not recorded.
	 */
	private recover(sessionId: string): void {
		if (this.recovering === sessionId) return;
		this.recovering = sessionId;
		void Promise.resolve()
			.then(() => this.ports.chargesHeld(sessionId))
			.then(
				(through) => {
					this.recovering = undefined;
					if (this.closed || this.session.sessionId !== sessionId || !this.ledger.readable()) return;
					const kept = this.ledger.charge;
					if (kept?.sessionId === sessionId) return;
					this.ledger.charge = { sessionId, through: structuredClone(through), pending: kept?.pending ?? [] };
					if (!this.ledger.write()) {
						this.ledger.charge = kept;
						return;
					}
					this.charge();
				},
				(error: unknown) => {
					this.recovering = undefined;
					if (!this.closed) this.notRecorded(error);
				},
			);
	}

	/**
	 * Delivers each pending charge again, oldest first, and drops the ones the root's file holds now. False when one failed
	 * to be delivered: the ones after it wait.
	 */
	private deliverPending(): boolean {
		const held: BotCharge[] = [];
		let delivered = true;
		for (const charge of this.ledger.charge?.pending ?? []) {
			const persisted = this.deliver(charge);
			if (persisted === undefined) {
				delivered = false;
				break;
			}
			if (persisted) held.push(charge);
		}
		if (held.length > 0) this.settle(held);
		return delivered;
	}

	/**
	 * Delivers one charge: true once the root's file holds it, false while the root holds it unwritten, undefined when it
	 * did not reach the root (a failure, or a root on another session file than the one the charge was sent to).
	 */
	private deliver(charge: BotCharge): boolean | undefined {
		let disposition: SpawnedUsageReceiptDisposition;
		try {
			disposition = this.ports.charge(charge.usage, charge.report);
		} catch (error) {
			this.notRecorded(error);
			return undefined;
		}
		if (disposition === "foreign_session") return undefined;
		this.notRecordedTold = false;
		return disposition === "persisted";
	}

	/** Tells the owner a charge was not recorded, once until a charge reaches the root again. */
	private notRecorded(error: unknown): void {
		if (this.notRecordedTold) return;
		this.notRecordedTold = true;
		this.ports.chargeNotRecorded(error instanceof Error ? error.message : String(error));
	}

	/** Drops charges the root's file holds from the pending ones and writes the ledger. */
	private settle(held: readonly BotCharge[]): void {
		const state = this.ledger.charge;
		if (state) state.pending = state.pending.filter((charge) => !held.includes(charge));
		this.ledger.write();
	}
}
