import { createCustomMessage } from "@caupulican/pi-agent-core/messages";
import type { AgentMessage } from "@caupulican/pi-agent-core/types";
import type { TextContent } from "@caupulican/pi-ai";
import { GOAL_CONTINUATION_TRIGGER_CUSTOM_TYPE } from "./goal-continuation-prompt.ts";
import { projectGoalRecord } from "./goal-record.ts";
import { type GoalState, isGoalExecutionActive } from "./goal-state.ts";

export const ACTIVE_GOAL_CONTEXT_CUSTOM_TYPE = "active_goal_context";
const LEGACY_GOAL_CONTINUATION_PREFIX = "Goal continuation context\n=========================";

function messageText(message: AgentMessage): string {
	if (message.role !== "user") return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function isGoalContextMessage(message: AgentMessage): boolean {
	if (message.role === "custom") {
		return (
			message.customType === GOAL_CONTINUATION_TRIGGER_CUSTOM_TYPE ||
			message.customType === ACTIVE_GOAL_CONTEXT_CUSTOM_TYPE
		);
	}
	return messageText(message).startsWith(LEGACY_GOAL_CONTINUATION_PREFIX);
}

export function formatCompactGoalContext(state: GoalState, continuationTurn: boolean): string {
	const record = projectGoalRecord(state);
	const instruction = continuationTurn
		? "Continue now: pursue full objective."
		: "current user message steers this turn.";
	const recoveryInstruction =
		continuationTurn && state.stallTurns > 0
			? `RECOVERY REQUIRED: ${state.stallTurns} consecutive turns made no authoritative progress. Inspect failure evidence and use a different approach, tool, or route; do not repeat the unchanged operation. Do not ask the owner unless a true approval boundary is proven.`
			: undefined;
	const compactRecord =
		record.tokenBudget === undefined
			? { untrustedObjective: record.objective }
			: { untrustedObjective: record.objective, tokenBudget: String(record.tokenBudget) };
	const encodedRecord = JSON.stringify(compactRecord).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
	return [
		"ACTIVE GOAL — HOST-OWNED CONTINUATION",
		encodedRecord,
		instruction,
		recoveryInstruction,
		"get_goal; task_steps for decomposition.",
		"Bound worker/tool waits: inspect authoritative status; stale or timed-out work must be recovered or reassigned, never escalated to the owner merely because it timed out.",
		"Blocked requirements are not terminal by themselves: verify each blocker, reopen recoverable work, and ask the owner only for a proven owner/approval boundary.",
		'Progress: update_goal status "active".',
		'update_goal with status "complete" after requirement-by-requirement audit; "blocked" only when the same verified owner/approval boundary or capability impossibility persists for 3 consecutive no-progress goal turns despite distinct recovery approaches, and no meaningful progress is possible without owner input or external change; else continue.',
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

/**
 * Replace every historical goal continuation payload with one current compact projection. The
 * projection exists only in the provider request returned from context assembly; it is never
 * appended to the transcript or session log.
 */
export function injectCompactGoalContext(messages: AgentMessage[], state: GoalState | undefined): AgentMessage[] {
	const continuationTurn = messages.some(
		(message) =>
			(message.role === "custom" && message.customType === GOAL_CONTINUATION_TRIGGER_CUSTOM_TYPE) ||
			messageText(message).startsWith(LEGACY_GOAL_CONTINUATION_PREFIX),
	);
	const filtered = messages.filter((message) => !isGoalContextMessage(message));
	if (!state || !isGoalExecutionActive(state.status)) return filtered;
	return [
		...filtered,
		createCustomMessage(
			ACTIVE_GOAL_CONTEXT_CUSTOM_TYPE,
			formatCompactGoalContext(state, continuationTurn),
			false,
			{ goalId: state.goalId, revision: state.revision ?? 0 },
			new Date().toISOString(),
		),
	];
}
