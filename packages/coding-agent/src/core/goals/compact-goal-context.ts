import { createCustomMessage } from "@caupulican/pi-agent-core/messages";
import type { AgentMessage } from "@caupulican/pi-agent-core/types";
import type { TextContent } from "@caupulican/pi-ai";
import { GOAL_CONTINUATION_TRIGGER_CUSTOM_TYPE } from "./goal-continuation-prompt.ts";
import { projectGoalRecord } from "./goal-record.ts";
import { type GoalState, isGoalExecutionActive } from "./goal-state.ts";

export const ACTIVE_GOAL_CONTEXT_CUSTOM_TYPE = "active_goal_context";
const LEGACY_GOAL_CONTINUATION_PREFIX = "Goal continuation context\n=========================";
/**
 * `task_steps` is the only tool left here: its state is deliberately NOT injected on an internal
 * (continuation) turn (see `agent-session.ts`'s `taskStepsState = options?.internalContextType ?
 * undefined : ...`), so a continuation genuinely has no other way to see current step state.
 * `get_goal` was removed from this list once `formatCompactGoalContext` below started projecting
 * everything `get_goal` provides for the common case (usage, elapsed time) directly into every
 * request -- see the turn-economics B1 investigation. Forcing a `get_goal` round trip for data
 * already in front of the model bought nothing. The one thing `get_goal` still uniquely provides
 * -- the legacy requirements/evidence ledger, for a goal managed through the OLD unified `goal`
 * tool -- deliberately stays out of this projection: see the comment on `formatCompactGoalContext`
 * below for why (its individual entries can be model-supplied, not just host-generated).
 */
const GOAL_HYDRATION_TOOLS = ["task_steps"] as const;

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
		if (message.toolName === "task_steps") completed.add(message.toolName);
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
	// Everything `get_goal` uniquely tells the model for the common case (a goal managed only
	// through the modern create_goal/get_goal/update_goal trio, which has no action that ever adds
	// a requirement or evidence record -- that ledger stays reachable only through the legacy
	// unified `goal` tool), projected here instead: budget/usage/elapsed time, always present on a
	// GoalRecord and always included. Every field lands inside this same JSON-encoded, escaped
	// object -- including blockedReason (defensive: this message is gated to
	// `isGoalExecutionActive`, so it is not expected to carry one, but a stale/legacy state should
	// not silently drop it if it does) -- because `requirementId` (and so, transitively, a
	// requirement's ledger id) can be MODEL-supplied, not only host-generated (see `goalSchema`'s
	// `requirementId` field), which is why the legacy ledger's individual open/unproven ids are
	// deliberately NOT projected here as bare text: unlike this escaped JSON block, they would be
	// unescaped content inside a section the model is told to treat as HOST-OWNED and authoritative.
	const compactRecord: Record<string, string> = { untrustedObjective: record.objective };
	if (record.tokenBudget !== undefined) {
		compactRecord.tokenBudget = String(record.tokenBudget);
		compactRecord.tokensRemaining = String(record.tokensRemaining ?? 0);
	}
	compactRecord.tokensUsed = String(record.tokensUsed);
	compactRecord.timeUsedSeconds = String(record.timeUsedSeconds);
	if (record.blockedReason) compactRecord.blockedReason = record.blockedReason;
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
