/**
 * What a finished turn of a bot's own session reports: what the session spent since the turn began, as one charge the
 * main session's cost view takes, and the turn's last words, the bot's summary in the roster.
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
 * The charge of the turn that began when the session had spent `usageBefore`: undefined when the session has no model or
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
			// The turn's identity: the bot's session and what it had spent when the turn began.
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
