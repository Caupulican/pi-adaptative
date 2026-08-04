import { createCustomMessage } from "@caupulican/pi-agent-core/messages";
import type { AgentMessage } from "@caupulican/pi-agent-core/types";
import type { TextContent } from "@caupulican/pi-ai";
import { escapePromptXmlText } from "../prompt-markup.ts";
import { GOAL_CONTINUATION_TRIGGER_CUSTOM_TYPE } from "./goal-continuation-prompt.ts";
import { projectGoalRecord } from "./goal-record.ts";
import type { GoalState } from "./goal-state.ts";

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
	const budgetText = record.tokenBudget === undefined ? "unbounded" : String(record.tokenBudget);
	const remainingText = record.tokensRemaining === undefined ? "unbounded" : String(record.tokensRemaining);
	const instruction = continuationTurn
		? "Continue now: inspect authoritative current state and make concrete progress toward the full objective."
		: "This objective persists across turns; the current user message controls immediate steering without replacing it.";
	return [
		`<active_goal tokens_used="${record.tokensUsed}" token_budget="${budgetText}" tokens_remaining="${remainingText}">`,
		"<objective>",
		escapePromptXmlText(record.objective),
		"</objective>",
		instruction,
		"Use task_steps for decomposition, delegate for workers, and current tool/artifact results as evidence. Keep the goal active unless completion is proven or the same genuine blocker persists for three goal turns.",
		"</active_goal>",
	].join("\n");
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
	if (!state || state.status !== "active") return filtered;
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
