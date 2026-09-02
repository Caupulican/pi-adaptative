import { createCustomMessage } from "@caupulican/pi-agent-core/messages";
import type { AgentMessage } from "@caupulican/pi-agent-core/types";
import type { TextContent } from "@caupulican/pi-ai";
import { GOAL_CONTINUATION_TRIGGER_CUSTOM_TYPE } from "./goal-continuation-prompt.ts";
import { projectGoalRecord } from "./goal-record.ts";
import { type GoalState, isGoalExecutionActive } from "./goal-state.ts";

export const ACTIVE_GOAL_CONTEXT_CUSTOM_TYPE = "active_goal_context";
const LEGACY_GOAL_CONTINUATION_PREFIX = "Goal continuation context\n=========================";
/**
 * History: this file used to instruct the model to "hydrate" state itself, once per continuation,
 * for whichever tools' state wasn't otherwise visible on an internal (continuation) turn -- a
 * `GOAL_HYDRATION_TOOLS` list with a `missingHydrationTools` projection field, checked against the
 * transcript for a completed hydration call since the last continuation trigger.
 *
 * `get_goal` was the first removed: once `formatCompactGoalContext` below started projecting
 * everything `get_goal` provides for the common case (usage, elapsed time) directly into every
 * request -- see the turn-economics B1 investigation -- forcing a `get_goal` round trip for data
 * already in front of the model bought nothing. The one thing `get_goal` still uniquely provides
 * -- the legacy requirements/evidence ledger, for a goal managed through the OLD unified `goal`
 * tool -- deliberately stays out of this projection: see the comment on `formatCompactGoalContext`
 * below for why (its individual entries can be model-supplied, not just host-generated).
 *
 * `task_steps` was the last one: it used to be genuinely ungated-uninjectable on a continuation
 * turn (`agent-session.ts` built its `task_steps_context` message only when `!internalContextType`),
 * so hydrate-yourself was the only way a continuation could ever see current step state. The
 * turn-economics B6 investigation closed that the same way B1 closed `get_goal` -- by removing the
 * gate instead of compensating for it -- so `task_steps_context` is now built unconditionally in
 * `agent-session.ts`, on every prompt including continuations. With both tools directly visible,
 * nothing needs hydrating; the whole mechanism (this list, the projection field, the transcript
 * scan) is gone rather than left in place with zero members.
 */

export interface GoalContextProjection {
	continuationTurn: boolean;
}

function messageText(message: AgentMessage): string {
	if (message.role !== "user") return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

/**
 * A continuation payload the model must not see twice: the host's continuation trigger, or the
 * legacy prose payload. The active goal context record is NOT one of them: it is a transient
 * record (agent-core transient-records.ts), appended once per change and left in place. Stripping
 * a record the provider had already read shortened every later request in the middle, and the
 * provider re-prefilled everything after that point on every request of a goal loop.
 */
function isGoalContinuationPayload(message: AgentMessage): boolean {
	if (message.role === "custom") return message.customType === GOAL_CONTINUATION_TRIGGER_CUSTOM_TYPE;
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

/** Capture continuation-only facts before historical goal payloads are removed for context GC. */
export function captureGoalContextProjection(messages: AgentMessage[]): GoalContextProjection {
	return { continuationTurn: latestContinuationTriggerIndex(messages) >= 0 };
}

export function formatCompactGoalContext(state: GoalState, continuationTurn: boolean): string {
	const record = projectGoalRecord(state);
	const instruction = continuationTurn ? "Continue objective." : "User steers.";
	const recoveryInstruction =
		continuationTurn && state.stallTurns > 0
			? `RECOVERY REQUIRED: ${state.stallTurns} turns without authoritative progress. Inspect evidence; change approach/tool/route. Do not repeat unchanged work or ask owner without a proven approval boundary.`
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
		"Recover/reassign timeouts; verify/reopen blocks.",
		"update_goal: complete=audited requirements; blocked=proven owner/approval boundary or impossible capability after 3 no-progress turns and distinct recoveries requiring owner/external change; else continue.",
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

/**
 * Strip every historical goal continuation payload and offer one current compact projection as a
 * host transient. The request planner records the projection durably when it changes and leaves
 * earlier records where they were; context GC packs the superseded ones.
 */
export function injectCompactGoalContext(
	messages: AgentMessage[],
	state: GoalState | undefined,
	projection: GoalContextProjection = captureGoalContextProjection(messages),
): AgentMessage[] {
	const filtered = messages.filter((message) => !isGoalContinuationPayload(message));
	if (!state || !isGoalExecutionActive(state.status)) return filtered;
	return [
		...filtered,
		createCustomMessage(
			ACTIVE_GOAL_CONTEXT_CUSTOM_TYPE,
			formatCompactGoalContext(state, projection.continuationTurn),
			false,
			{ goalId: state.goalId, revision: state.revision ?? 0 },
			new Date().toISOString(),
		),
	];
}
