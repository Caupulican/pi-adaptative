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
	const instruction = continuationTurn ? "Continue objective." : "User steers.";
	const recoveryInstruction =
		continuationTurn && state.stallTurns > 0
			? `RECOVERY REQUIRED: ${state.stallTurns} turns without authoritative progress. Inspect evidence; change approach/tool/route. Do not repeat unchanged work or ask owner without a proven approval boundary.`
			: undefined;
	const compactRecord =
		record.tokenBudget === undefined
			? { untrustedObjective: record.objective }
			: { untrustedObjective: record.objective, tokenBudget: String(record.tokenBudget) };
	const encodedRecord = JSON.stringify(compactRecord).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
	return [
		"ACTIVE GOAL — HOST-OWNED",
		encodedRecord,
		instruction,
		recoveryInstruction,
		"get_goal; task_steps",
		"Recover/reassign timeouts; verify/reopen blocks.",
		"update_goal: complete=audited requirements; blocked=proven owner/approval boundary or impossible capability after 3 no-progress turns and distinct recoveries requiring owner/external change; else continue.",
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
