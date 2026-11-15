/**
 * What a bot's own session reports to the main session: what it spent since its charge watermark, as one charge the main
 * session's cost view takes whenever its usage grows (a turn's end, a worker's usage receipt), and each turn's last words,
 * the bot's summary in the roster; and the accounting that reports both, the charges exactly once across reopens.
 */

import type { Usage } from "@caupulican/pi-ai";
import type { AgentMessage } from "../../kernel/types.ts";
import type { AgentSession } from "../agent-session.ts";
import type { SpawnedUsageReceiptDisposition } from "../cost/spawned-usage-receipt.ts";
import { usageSince } from "../cost/usage-delta.ts";
import { deriveSpawnedUsageReportId, hasReportableUsage } from "../spawned-usage.ts";
import type { BotCharge, BotChargeReport, BotChargeState, BotSpendLedger } from "./bot-spend-ledger.ts";

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
	/**
	 * Delivers a charge to the cost view of the root the bot answers now, once per report id: `persisted` once the root's
	 * file holds it (`deliverSpawnedUsageReceipt`). Throws a failure to record it.
	 */
	charge(usage: Usage, report: BotChargeReport): SpawnedUsageReceiptDisposition;
	/** A charge was not recorded: the owner is told why (it is delivered again with the next charge). */
	chargeNotRecorded(reason: string): void;
	/** Records a turn's last words as the bot's outcome: its roster summary and unread mark. */
	outcome(summary: string): void;
}

/**
 * One bot session's spend and turns as its host counts them. The charge follows the session's cumulative usage, not its
 * turns: what the session spent since the watermark of its spend ledger (`BotChargeState`) is charged at each turn end
 * and each time the session records spawned usage (a worker's usage receipt), so spend that lands between turns, a
 * compaction between runs, or a turn cut by a crash is charged once, whenever it lands. Each charge fixes its range first:
 * the charge (its usage and the report id its range derives) joins the ledger's pending charges and the watermark moves
 * to the range's end, in one write, before the charge is delivered; it leaves the pending charges only once the root's
 * file holds it. A reopen delivers the pending charges again under their own ids, which the root's ledger and the daily
 * brake take once (`deriveSpawnedUsageReportId`), and charges only what the session spent past the watermark, under a new
 * range's id. The turn's last words written since its start are its outcome, reported once per turn on the boundary
 * every per-turn count of the session reads (`observeSessionTurns`).
 */
export class BotTurnAccounting {
	private readonly agentId: string;
	private readonly session: Pick<
		AgentSession,
		"model" | "getCumulativeUsage" | "isAccountingHistoryLoading" | "sessionId" | "messages"
	>;
	private readonly ledger: BotSpendLedger;
	private readonly ports: BotTurnAccountingPorts;
	/** When the running turn began: its own messages are the ones written since; absent between turns. */
	private startedAt: number | undefined;

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
	 * Delivers the pending charges again, then charges what the session spent since the watermark: its range is fixed in
	 * the ledger first, then delivered. A ledger that cannot be written charges nothing now; the range is charged by the
	 * next charge. A reading below the watermark (the session's accounting history still loading) charges nothing until it
	 * reaches it.
	 */
	charge(): void {
		this.deliverPending();
		const state = this.watermark();
		if (!state) return;
		const now = this.session.getCumulativeUsage();
		const { through, pending } = state;
		if (now.totalTokens < through.totalTokens || now.cost.total < through.cost.total) return;
		const charge = botTurnCharge(this.agentId, this.session, through);
		if (!charge) return;
		const { through: reached, ...fixed } = charge;
		pending.push(fixed);
		state.through = reached;
		if (!this.ledger.write()) {
			pending.pop();
			state.through = through;
			return;
		}
		if (this.deliver(fixed)) this.settle([fixed]);
	}

	/**
	 * This session's watermark: the ledger's when it reads this session. A ledger with none (a new bot, a record set
	 * aside) or one that reads another session (a bot that opened a new session file) starts this session's at what it has
	 * spent now, keeping the pending charges of the one before (an earlier build charged what this session spent before),
	 * once the session's historical accounting has loaded: a reading taken before it lands can be short of what the
	 * session spent, and the difference would be charged again. Undefined while it loads; its load's end charges again
	 * (`usage_updated`).
	 */
	private watermark(): BotChargeState | undefined {
		const kept = this.ledger.charge;
		const sessionId = this.session.sessionId;
		if (kept?.sessionId === sessionId) return kept;
		if (this.session.isAccountingHistoryLoading()) return undefined;
		const state = {
			sessionId,
			through: structuredClone(this.session.getCumulativeUsage()),
			pending: kept?.pending ?? [],
		};
		this.ledger.charge = state;
		this.ledger.write();
		return state;
	}

	/** Delivers each pending charge again, oldest first, and drops the ones the root's file holds now. */
	private deliverPending(): void {
		const held: BotCharge[] = [];
		for (const charge of this.ledger.charge?.pending ?? []) {
			const persisted = this.deliver(charge);
			if (persisted === undefined) break;
			if (persisted) held.push(charge);
		}
		if (held.length > 0) this.settle(held);
	}

	/** Delivers one charge: true once the root's file holds it, false while it does not yet, undefined when it failed. */
	private deliver(charge: BotCharge): boolean | undefined {
		try {
			return this.ports.charge(charge.usage, charge.report) === "persisted";
		} catch (error) {
			this.ports.chargeNotRecorded(error instanceof Error ? error.message : String(error));
			return undefined;
		}
	}

	/** Drops charges the root's file holds from the pending ones and writes the ledger. */
	private settle(held: readonly BotCharge[]): void {
		const state = this.ledger.charge;
		if (state) state.pending = state.pending.filter((charge) => !held.includes(charge));
		this.ledger.write();
	}
}
