/** Goal snapshot admission binds allocation to durable objective identity before opening the declared work unit. */
import type { SessionManager } from "../../kernel/node.ts";
import type {
	GoalCompletionPresentation,
	GoalExecutionCustody,
} from "../objective-execution/current-objective-execution.ts";
import { goalObjectiveId } from "../orchestration/goal-objective-id.ts";
import { getGoalStateRevision, matchesGoalStateRevision } from "./goal-lifecycle.ts";
import type { GoalSessionControllerDeps } from "./goal-session-controller.ts";
import type { GoalState } from "./goal-state.ts";

import {
	appendGoalStateSnapshot,
	clearGoalStateJournal,
	GOAL_STATE_CUSTOM_TYPE,
	getLatestGoalStateSnapshot,
} from "./session-goal-state.ts";

/** Even an append that reports an error may already have published its entry. */
function writeWithCustody(
	manager: SessionManager,
	custody: GoalExecutionCustody,
	write: () => string,
	published?: (entryId: string, current: GoalState | undefined) => void,
): string {
	let entryId: string | undefined;
	try {
		entryId = write();
		return entryId;
	} finally {
		let current: GoalState | undefined;
		try {
			current = getLatestGoalStateSnapshot(manager);
			if (entryId !== undefined) published?.(entryId, current);
		} finally {
			custody.changed(current);
		}
	}
}

export function clearSessionGoal(
	manager: SessionManager,
	custody: GoalExecutionCustody,
	state: GoalState,
	now: string,
	synchronize: (state: GoalState) => void,
): string {
	return writeWithCustody(manager, custody, () =>
		clearGoalStateJournal(manager, state, now, (terminal) => {
			custody.changed(terminal);
			synchronize(terminal);
		}),
	);
}

export function saveSessionGoal(
	manager: SessionManager,
	state: GoalState,
	previous: GoalState | undefined,
	custody: GoalExecutionCustody,
	deps: Pick<GoalSessionControllerDeps, "hasDurableGoalObjective" | "runtimeFacts">,
	presentation?: GoalCompletionPresentation,
) {
	if (presentation) custody.assertCompleting(presentation, previous, state);
	return writeWithCustody(
		manager,
		custody,
		() =>
			appendGoalStateSnapshot(manager, state, previous, {
				hasDurableObjective: (id: string) =>
					deps.hasDurableGoalObjective?.(id) ??
					Boolean(deps.runtimeFacts().taskRuntime?.objectives[goalObjectiveId(id)]),
			}),
		presentation
			? (entryId, current) => {
					if (
						!current ||
						manager.getLatestCustomEntryOnBranch(GOAL_STATE_CUSTOM_TYPE)?.id !== entryId ||
						!matchesGoalStateRevision(current, getGoalStateRevision(state))
					)
						throw new Error("Could not confirm the completed goal journal entry on the admitted branch.");
					custody.published(presentation, previous, current);
				}
			: undefined,
	);
}
