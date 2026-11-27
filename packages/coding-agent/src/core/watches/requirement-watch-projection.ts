/** Selects current requirement waits before applying latest-watch precedence. */
import type { GoalBoundWatch } from "../goals/goal-continuation-controller.ts";
import { GITHUB_WATCH_POLL_MS } from "./github-watch-poller.ts";
import type { SessionWatchRecord, SessionWatchRequirement } from "./session-watch-ledger.ts";

export function projectRequirementWatches(input: {
	records: readonly SessionWatchRecord[];
	goalId: string;
	nowMs: number;
	isCurrent(binding: SessionWatchRequirement): boolean;
	deadlineDue(record: SessionWatchRecord): number | undefined;
}): GoalBoundWatch[] {
	const latest = new Map<string, SessionWatchRecord>();
	for (const record of input.records) {
		const bound = record.forRequirement;
		if (bound?.goalId !== input.goalId || !input.isCurrent(bound)) continue;
		const held = latest.get(bound.requirementId);
		if (!held || held.armedAt <= record.armedAt) latest.set(bound.requirementId, record);
	}
	return [...latest].map(([requirementId, record]) => {
		const { watchId, status, expiresAt } = record;
		const binding = { requirementId, definitionKey: record.forRequirement?.definitionKey, watchId };
		if (status === "live" && input.nowMs < expiresAt)
			return { ...binding, status, remainingMs: expiresAt - input.nowMs };
		const deadlineDue = input.deadlineDue(record);
		if (deadlineDue !== undefined)
			return {
				...binding,
				status,
				remainingMs: deadlineDue > input.nowMs ? deadlineDue - input.nowMs : GITHUB_WATCH_POLL_MS,
			};
		return { ...binding, status: status === "live" ? "timed-out" : status };
	});
}
