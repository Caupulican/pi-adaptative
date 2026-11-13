/**
 * What opened the foreground run a routine tool call executes in, when the owner did not speak in it: a goal
 * continuation of the active goal, or a host input (a routine result, CI event, worker report) delivered as a turn. It is
 * read from the session branch, the same context the model that issued the call read, and only names an opener the run
 * took in; anything else (an extension's message, a peer's or channel's words, a compaction between) opens no authority.
 */
import { parentInputOf, parentWakeOf } from "../../kernel/session/parent-input-ledger.ts";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import { GOAL_CONTINUATION_TRIGGER_CUSTOM_TYPE } from "../goals/goal-continuation-prompt.ts";
import { type GoalState, isGoalExecutionActive } from "../goals/goal-state.ts";
import type { RoutineRunOpener } from "./routine-provenance.ts";

/**
 * The latest input in the branch's context decides: the walk passes answers, tool results and the host's own records, and
 * stops at the first message that came from outside the model. A parent input held for the owner's next turn is not in the
 * run's context, so it is passed over.
 */
export function routineRunOpener(
	branch: readonly SessionEntry[],
	goal: Pick<GoalState, "goalId" | "status"> | undefined,
): RoutineRunOpener | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "compaction" || entry.type === "branch_summary") return undefined;
		const customType =
			entry.type === "custom_message"
				? entry.customType
				: entry.type === "message" && entry.message.role === "custom"
					? entry.message.customType
					: undefined;
		if (entry.type === "message" && entry.message.role === "user") return undefined;
		if (customType === undefined) continue;
		if (customType === GOAL_CONTINUATION_TRIGGER_CUSTOM_TYPE)
			return goal !== undefined && isGoalExecutionActive(goal.status)
				? { kind: "goal", goalId: goal.goalId }
				: undefined;
		const wake = parentWakeOf(entry);
		if (wake) return { kind: "wake", ref: wake.wakeId };
		const input = parentInputOf(entry);
		if (input?.metadata.mode === "next-owner-turn") continue;
		return input ? { kind: "wake", ref: input.metadata.deliveryId } : undefined;
	}
	return undefined;
}
