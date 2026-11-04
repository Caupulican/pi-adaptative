import type { AgentMessage } from "../../kernel/index.ts";
import { LEDGER_READ_TOOL_NAME, ledgerEntryGating } from "./ledger-catalog.ts";

/**
 * Host enforcement of the rule ledger: a call to a tool that a rule governs is blocked until that rule is in
 * context. The block reason is deliberately short: the harness folds a block into a bounded failure record, so
 * the rule itself cannot ride in it. The model reads the rule with `ledger_read`, which returns it whole as an
 * ordinary tool result, and the retry then passes. Compaction replaces old messages, so the rule is required
 * again afterwards.
 */
export function ledgerGateReason(
	toolName: string,
	activeToolNames: readonly string[],
	messages: readonly AgentMessage[],
): string | undefined {
	const entry = ledgerEntryGating(toolName);
	if (!entry || !activeToolNames.includes(LEDGER_READ_TOOL_NAME)) return undefined;
	const idLine = `LEDGER-ID: ${entry.id}`;
	const read = messages.some(
		(message) =>
			message.role === "toolResult" &&
			message.toolName === LEDGER_READ_TOOL_NAME &&
			!message.isError &&
			message.content.some((block) => block.type === "text" && block.text.split("\n", 1)[0] === idLine),
	);
	if (read) return undefined;
	return `Ledger rule ${entry.id} not read in this context: call ${LEDGER_READ_TOOL_NAME}("${entry.topic}"), then repeat this call and cite the id.`;
}
