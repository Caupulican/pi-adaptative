/** Durable scoped executor admission holds, shared by the goal reducer and readiness projection. */
import { createHash } from "node:crypto";
import { isPlainRecord, isStringArray } from "../../kernel/utils/value-guards.ts";
import type { GoalState, Requirement } from "./goal-state.ts";
import { requirementKey } from "./requirement-proof.ts";

export interface RequirementExecutorRefusal {
	definitionKey: string;
	reason: string;
	retryAt: string;
	attempts: number;
}

export interface ExecutorRefusedEvent {
	type: "executor_refused";
	scopeKey?: string;
	ids: readonly string[];
	definitions: readonly string[];
	reason: string;
	retryAt: string;
	now: string;
}

export function isRequirementExecutorRefusal(value: unknown): value is RequirementExecutorRefusal {
	return (
		isPlainRecord(value) &&
		typeof value.definitionKey === "string" &&
		typeof value.reason === "string" &&
		typeof value.retryAt === "string" &&
		Number.isFinite(Date.parse(value.retryAt)) &&
		Number.isSafeInteger(value.attempts) &&
		Number(value.attempts) > 0
	);
}

export function isExecutorRefusedEvent(value: Record<string, unknown>): boolean {
	return (
		(value.scopeKey === undefined || typeof value.scopeKey === "string") &&
		isStringArray(value.ids) &&
		isStringArray(value.definitions) &&
		value.ids.length === value.definitions.length &&
		typeof value.reason === "string" &&
		typeof value.retryAt === "string" &&
		Number.isFinite(Date.parse(value.retryAt))
	);
}

export function applyExecutorRefusal(requirements: readonly Requirement[], event: ExecutorRefusedEvent): Requirement[] {
	const keys = new Map(event.ids.map((id, index) => [id, event.definitions[index]!]));
	return requirements.map((requirement) => {
		const definitionKey = keys.get(requirement.id);
		if (definitionKey === undefined || definitionKey !== requirementKey(requirement) || requirement.status !== "open")
			return requirement;
		const attempts =
			requirement.executorRefusal?.definitionKey === definitionKey ? requirement.executorRefusal.attempts + 1 : 1;
		return {
			...requirement,
			executorRefusal: { definitionKey, reason: event.reason, retryAt: event.retryAt, attempts },
			...(attempts >= 3
				? { status: "blocked" as const, blockedReason: `Executor admission refused three times: ${event.reason}` }
				: {}),
		};
	});
}

/** A historical hold cannot exhaust a different requirement definition. */
export function executorAdmissionExhausted(requirement: Requirement): boolean {
	const refusal = requirement.executorRefusal;
	return !!refusal && refusal.attempts >= 3 && refusal.definitionKey === requirementKey(requirement);
}

/** Exact objective scope for refusals that cannot be assigned to an open criterion. */
export function goalExecutorScopeKey(goal: GoalState): string {
	return createHash("sha256")
		.update(JSON.stringify([goal.goalId, goal.userGoal, goal.requirements.map(requirementKey)]))
		.digest("hex");
}

export function applyGoalExecutorRefusal(state: GoalState, event: ExecutorRefusedEvent): void {
	if (!event.scopeKey || event.scopeKey !== goalExecutorScopeKey(state)) return;
	const attempts = state.executorRefusal?.definitionKey === event.scopeKey ? state.executorRefusal.attempts + 1 : 1;
	state.executorRefusal = { definitionKey: event.scopeKey, reason: event.reason, retryAt: event.retryAt, attempts };
	if (attempts >= 3) {
		state.status = "blocked";
		state.blockedBy = "system";
		state.blockedReason = `Executor admission refused three times for the objective scope: ${event.reason}`;
	}
}

export function currentGoalExecutorRefusal(state: GoalState, nowMs: number): RequirementExecutorRefusal | undefined {
	const refusal = state.executorRefusal;
	return refusal && refusal.definitionKey === goalExecutorScopeKey(state) && Date.parse(refusal.retryAt) > nowMs
		? refusal
		: undefined;
}

/** Owner recovery releases only the requirement blocks established by executor admission. */
export function clearExecutorRefusal({ executorRefusal, ...requirement }: Requirement): Requirement {
	return executorRefusal && requirement.blockedReason?.startsWith("Executor admission refused three times:")
		? { ...requirement, status: "open", blockedReason: undefined }
		: requirement;
}
