/**
 * The routine facts a chat names: what a routine's schedule says in a few words, and the routine a chat command names,
 * refused when it belongs to the main session. A chat draws both, and so does the routine output that reads them.
 */

import type { PersistentBotTeamStore } from "../../core/delegation/persistent-bot-team-store.ts";
import { formatDurationIntervalMs } from "../../core/delegation/persistent-bot-team-store.ts";
import { interfaceText } from "../../core/language/interface-text.ts";
import type { RoutineDefinitionView } from "../../core/routines/routine-contract.ts";
import { describeWatchCondition } from "../../core/routines/watch-contract.ts";

/** A routine's schedule in a few words. */
export function routineScheduleLabel(routine: RoutineDefinitionView): string {
	const words = interfaceText().chat.routine;
	switch (routine.schedule.kind) {
		case "interval":
			return words.every(formatDurationIntervalMs(routine.schedule.intervalMs));
		case "once":
			return words.onceAt(new Date(routine.schedule.at).toISOString());
		case "calendar":
			return words.calendar(routine.schedule.cron, routine.schedule.timeZone);
		case "event": {
			const schedule = routine.schedule;
			if (schedule.source === "watch") return describeWatchCondition(schedule.condition);
			if (schedule.source === "github") {
				const scope = [
					schedule.pullRequest === undefined ? undefined : `#${schedule.pullRequest}`,
					schedule.branch === undefined ? undefined : words.branch(schedule.branch),
					schedule.ownPullRequests ? words.ownPullRequests : undefined,
					schedule.authors === undefined
						? undefined
						: words.by(schedule.authors.map((login) => `@${login}`).join(", ")),
				].filter((part) => part !== undefined);
				return words.github(schedule.kinds.join("/"), scope.join("; "));
			}
			return words.ci(schedule.conclusions.join("/"), schedule.workflowPath);
		}
	}
}

/** The routine a chat command names; a main-session routine is its owner's business, never a chat's. */
export function chatRoutine(store: PersistentBotTeamStore, routineId: string): RoutineDefinitionView | undefined {
	const routine = store.getRoutine(routineId);
	if (routine?.target.kind === "session") throw new Error(interfaceText().chat.routine.mainSessionOnly);
	return routine;
}
