/** Durable owner activation time, independent of bounded audit events and system progress. */
import type { GoalEvent, GoalState } from "./goal-state.ts";

export function laterOwnerActivation(current: string | undefined, candidate: string | undefined): string | undefined {
	if (candidate === undefined || !Number.isFinite(Date.parse(candidate))) return current;
	return current === undefined || Date.parse(candidate) > Date.parse(current) ? candidate : current;
}

export function recordOwnerActivation(current: string | undefined, event: GoalEvent): string | undefined {
	return event.type === "edit_goal" ||
		event.type === "correct_completed_goal" ||
		(event.type === "resume_goal" && event.source !== "system")
		? laterOwnerActivation(current, event.now)
		: current;
}

export function goalOwnerActivationAt(
	state: Pick<GoalState, "ownerActivatedAt" | "createdAt" | "events">,
): string | undefined {
	let at = laterOwnerActivation(state.ownerActivatedAt, state.createdAt);
	if (state.ownerActivatedAt === undefined) for (const event of state.events) at = recordOwnerActivation(at, event);
	return at;
}

export function isOptionalOwnerActivation(value: unknown): boolean {
	return value === undefined || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}
