/**
 * `/session`: the block that reports what the session holds, its messages, its tokens, its cost and the model router's
 * state. It only reads the session and draws one block, so it stands apart from the flows that change the session.
 */

import { type Container, Spacer, Text } from "@caupulican/pi-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import { hasCostSummarySignal } from "../../core/cost/cost-summary.ts";
import { interfaceText } from "../../core/language/interface-text.ts";
import { theme } from "../../presentation/theme-model.ts";
import { formatCostReport } from "./report-commands.ts";

export interface SessionInfoCommandHost {
	readonly session: {
		getSessionStats: () => ReturnType<AgentSession["getSessionStats"]>;
		getCostSummary: () => ReturnType<AgentSession["getCostSummary"]>;
		getModelRouterStatus: (formatLabel: (label: string) => string) => string;
	};
	readonly sessionManager: { getSessionName: () => string | undefined };
	readonly chatContainer: Container;
	readonly ui: { requestRender: () => void };
}

export function handleSessionCommand(host: SessionInfoCommandHost): void {
	const words = interfaceText().sessions.info;
	const stats = host.session.getSessionStats();
	const sessionName = host.sessionManager.getSessionName();
	const label = (word: string) => theme.fg("dim", word);

	const lines = [theme.bold(words.title), ""];
	if (sessionName) {
		lines.push(`${label(words.name)} ${sessionName}`);
	}
	lines.push(
		`${label(words.file)} ${stats.sessionFile ?? words.inMemory}`,
		`${label(words.id)} ${stats.sessionId}`,
		"",
		theme.bold(words.messages),
		`${label(words.user)} ${stats.userMessages}`,
		`${label(words.assistant)} ${stats.assistantMessages}`,
		`${label(words.toolCalls)} ${stats.toolCalls}`,
		`${label(words.toolResults)} ${stats.toolResults}`,
		`${label(words.total)} ${stats.totalMessages}`,
		"",
		theme.bold(words.tokens),
		`${label(words.input)} ${stats.tokens.input.toLocaleString()}`,
		`${label(words.output)} ${stats.tokens.output.toLocaleString()}`,
	);
	if (stats.tokens.cacheRead > 0) {
		lines.push(`${label(words.cacheRead)} ${stats.tokens.cacheRead.toLocaleString()}`);
	}
	if (stats.tokens.cacheWrite > 0) {
		lines.push(`${label(words.cacheWrite)} ${stats.tokens.cacheWrite.toLocaleString()}`);
	}
	lines.push(`${label(words.total)} ${stats.tokens.total.toLocaleString()}`);

	const costs = host.session.getCostSummary();
	const costLines = hasCostSummarySignal(costs)
		? ["", theme.bold(words.cost), formatCostReport(costs), "", theme.bold(words.modelRouter)]
		: ["", "", theme.bold(words.modelRouter)];
	const info = [...lines, ...costLines, host.session.getModelRouterStatus(label)].join("\n");

	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new Text(info, 1, 0));
	host.ui.requestRender();
}
