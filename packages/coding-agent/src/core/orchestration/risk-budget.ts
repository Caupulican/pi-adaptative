import type { RiskBudget } from "./contracts.ts";

export const RISK_BUDGET_LIMIT_FIELDS = [
	"maxTokens",
	"maxWallClockMs",
	"maxCostUsd",
	"maxAttempts",
	"maxToolCalls",
] as const;

export type RiskBudgetLimitField = (typeof RISK_BUDGET_LIMIT_FIELDS)[number];

export const RISK_BUDGET_FIELDS = [...RISK_BUDGET_LIMIT_FIELDS, "requireApprovalAboveCostUsd"] as const;

const DISCRETE_BUDGET_FIELDS: ReadonlySet<(typeof RISK_BUDGET_FIELDS)[number]> = new Set([
	"maxTokens",
	"maxWallClockMs",
	"maxAttempts",
	"maxToolCalls",
]);

export function validateRiskBudget(budget: RiskBudget, label: string): void {
	for (const field of RISK_BUDGET_FIELDS) {
		const value = budget[field];
		if (value === undefined) continue;
		if (!Number.isFinite(value) || value < 0) throw new TypeError(`${label}.${field} must be non-negative.`);
		if (DISCRETE_BUDGET_FIELDS.has(field) && !Number.isSafeInteger(value)) {
			throw new TypeError(`${label}.${field} must be a non-negative safe integer.`);
		}
	}
}

export function exceededRiskBudgetFields(requested: RiskBudget, authority: RiskBudget): RiskBudgetLimitField[] {
	return RISK_BUDGET_LIMIT_FIELDS.filter((field) => {
		const request = requested[field];
		const ceiling = authority[field];
		return request !== undefined && ceiling !== undefined && request > ceiling;
	});
}

/** Intersects independent ceilings. Undefined fields do not constrain the result. */
export function intersectRiskBudgets(...budgets: readonly RiskBudget[]): RiskBudget {
	const result: RiskBudget = {};
	for (const field of RISK_BUDGET_FIELDS) {
		const values = budgets.map((budget) => budget[field]).filter((value): value is number => value !== undefined);
		if (values.length > 0) result[field] = Math.min(...values);
	}
	const approvalThreshold = result.requireApprovalAboveCostUsd;
	if (approvalThreshold !== undefined) {
		result.maxCostUsd = Math.min(result.maxCostUsd ?? approvalThreshold, approvalThreshold);
	}
	return result;
}
