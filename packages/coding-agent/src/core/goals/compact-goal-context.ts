import { createCustomMessage } from "@caupulican/pi-agent-core/messages";
import type { AgentMessage } from "@caupulican/pi-agent-core/types";
import type { TextContent } from "@caupulican/pi-ai";
import { GOAL_CONTINUATION_TRIGGER_CUSTOM_TYPE } from "./goal-continuation-prompt.ts";
import { projectGoalRecord } from "./goal-record.ts";
import { type GoalState, isGoalExecutionActive } from "./goal-state.ts";

export const ACTIVE_GOAL_CONTEXT_CUSTOM_TYPE = "active_goal_context";
const LEGACY_GOAL_CONTINUATION_PREFIX = "Goal continuation context\n=========================";
const GOAL_HYDRATION_TOOLS = ["get_goal", "task_steps"] as const;

type GoalHydrationTool = (typeof GOAL_HYDRATION_TOOLS)[number];

export interface GoalContextProjection {
	continuationTurn: boolean;
	missingHydrationTools: GoalHydrationTool[];
}

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

function latestContinuationTriggerIndex(messages: AgentMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (
			(message.role === "custom" && message.customType === GOAL_CONTINUATION_TRIGGER_CUSTOM_TYPE) ||
			messageText(message).startsWith(LEGACY_GOAL_CONTINUATION_PREFIX)
		) {
			return i;
		}
	}
	return -1;
}

function missingContinuationHydrationTools(messages: AgentMessage[], triggerIndex: number): GoalHydrationTool[] {
	if (triggerIndex < 0) return [];
	const completed = new Set<GoalHydrationTool>();
	for (let i = triggerIndex + 1; i < messages.length; i++) {
		const message = messages[i];
		if (message.role !== "toolResult" || message.isError) continue;
		if (message.toolName === "get_goal" || message.toolName === "task_steps") completed.add(message.toolName);
	}
	return GOAL_HYDRATION_TOOLS.filter((toolName) => !completed.has(toolName));
}

/** Capture continuation-only facts before historical goal payloads are removed for context GC. */
export function captureGoalContextProjection(messages: AgentMessage[]): GoalContextProjection {
	const triggerIndex = latestContinuationTriggerIndex(messages);
	return {
		continuationTurn: triggerIndex >= 0,
		missingHydrationTools: missingContinuationHydrationTools(messages, triggerIndex),
	};
}

export function formatCompactGoalContext(
	state: GoalState,
	continuationTurn: boolean,
	missingHydrationTools: readonly (typeof GOAL_HYDRATION_TOOLS)[number][] = continuationTurn
		? GOAL_HYDRATION_TOOLS
		: [],
): string {
	const record = projectGoalRecord(state);
	const instruction = continuationTurn ? "Continue objective." : "User steers.";
	const recoveryInstruction =
		continuationTurn && state.stallTurns > 0
			? `RECOVERY REQUIRED: ${state.stallTurns} turns without authoritative progress. Inspect evidence; change approach/tool/route. Do not repeat unchanged work or ask owner without a proven approval boundary.`
			: undefined;
	const hydrationInstruction =
		missingHydrationTools.length > 0
			? `Hydrate missing state once this continuation: ${missingHydrationTools.join("; ")}. Never repeat a successful hydration call already present in current context.`
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
		hydrationInstruction,
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
export function injectCompactGoalContext(
	messages: AgentMessage[],
	state: GoalState | undefined,
	projection: GoalContextProjection = captureGoalContextProjection(messages),
): AgentMessage[] {
	const filtered = messages.filter((message) => !isGoalContextMessage(message));
	if (!state || !isGoalExecutionActive(state.status)) return filtered;
	return [
		...filtered,
		createCustomMessage(
			ACTIVE_GOAL_CONTEXT_CUSTOM_TYPE,
			formatCompactGoalContext(state, projection.continuationTurn, projection.missingHydrationTools),
			false,
			{ goalId: state.goalId, revision: state.revision ?? 0 },
			new Date().toISOString(),
		),
	];
}
