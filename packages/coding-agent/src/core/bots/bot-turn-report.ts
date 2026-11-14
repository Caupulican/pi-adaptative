/**
 * What a finished turn of a bot's own session reports: what the session spent since the last charge, as one charge the
 * main session's cost view takes, and the turn's last words, the bot's summary in the roster; and the accounting that
 * reports both once per turn.
 */

import type { Usage } from "@caupulican/pi-ai";
import type { AgentMessage } from "../../kernel/types.ts";
import type { AgentSession } from "../agent-session.ts";
import { usageSince } from "../cost/usage-delta.ts";
import { deriveSpawnedUsageReportId, hasReportableUsage } from "../spawned-usage.ts";

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
 * The charge of a turn, the session's spend since it had spent `usageBefore`: undefined when the session has no model or
 * spent nothing reportable since.
 */
export function botTurnCharge(
	agentId: string,
	session: Pick<AgentSession, "model" | "getCumulativeUsage" | "sessionId" | "messages">,
	usageBefore: Usage,
): { readonly usage: Usage; readonly report: BotTurnUsageReport } | undefined {
	const model = session.model;
	if (!model) return undefined;
	const usage = usageSince(usageBefore, session.getCumulativeUsage());
	if (!hasReportableUsage(usage)) return undefined;
	const sessionId = session.sessionId;
	return {
		usage,
		report: {
			agentId,
			// The charge's identity: the bot's session and what it had spent at the charge before.
			reportId: deriveSpawnedUsageReportId("bot-session", sessionId, [
				String(usageBefore.totalTokens),
				String(usageBefore.cost.total),
				String(session.messages.length),
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
	/** Records a turn's charge with the cost view of the root the bot answers now; throws a failure to record it. */
	charge(usage: Usage, report: BotTurnUsageReport): void;
	/** A turn's charge was not recorded: the owner is told why. */
	chargeNotRecorded(reason: string): void;
	/** Records a turn's last words as the bot's outcome: its roster summary and unread mark. */
	outcome(summary: string): void;
}

/**
 * One bot session's turns as its host counts them, on the turn boundary every per-turn count of the session reads
 * (`observeSessionTurns`): what the session spent since the last charge is the turn's charge, so spend between runs (a
 * compaction a prompt runs before its run, or one a self-compaction handoff runs) is charged with the turn it ran for or
 * at the session's close; the turn's last words written since its start are its outcome. Each is reported once.
 */
export class BotTurnAccounting {
	private readonly agentId: string;
	private readonly session: Pick<AgentSession, "model" | "getCumulativeUsage" | "sessionId" | "messages">;
	private readonly ports: BotTurnAccountingPorts;
	/** The session's cumulative usage at the last charge (or when the session was loaded): the next charge starts there. */
	private usageCharged: Usage;
	/** When the running turn began: its own messages are the ones written since; absent between turns. */
	private startedAt: number | undefined;

	constructor(
		agentId: string,
		session: Pick<AgentSession, "model" | "getCumulativeUsage" | "sessionId" | "messages">,
		ports: BotTurnAccountingPorts,
	) {
		this.agentId = agentId;
		this.session = session;
		this.ports = ports;
		this.usageCharged = structuredClone(session.getCumulativeUsage());
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
		this.reportCharge();
		const since = this.startedAt;
		this.startedAt = undefined;
		if (since === undefined) return;
		const summary = lastAssistantText(this.session.messages, since);
		// A turn that said nothing (it failed before an answer) records nothing: an earlier turn's answer is not news again.
		if (summary.length > 0) this.ports.outcome(summary);
	}

	/** The spend since the last charge is reported, once. */
	private reportCharge(): void {
		const charge = botTurnCharge(this.agentId, this.session, this.usageCharged);
		this.usageCharged = structuredClone(this.session.getCumulativeUsage());
		if (!charge) return;
		try {
			this.ports.charge(charge.usage, charge.report);
		} catch (error) {
			this.ports.chargeNotRecorded(error instanceof Error ? error.message : String(error));
		}
	}
}
