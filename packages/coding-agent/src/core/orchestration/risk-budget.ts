import { Type } from "typebox";
import { isPlainRecord } from "../util/value-guards.ts";
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

/** One model-facing schema for every explicit worker/profile budget boundary. */
export function createRiskBudgetSchema() {
	// Shape belongs to the tool schema. Numeric range and integer invariants belong to
	// parseRiskBudget so every caller follows the same authoritative validation path.
	return Type.Object(
		{
			maxTokens: Type.Optional(Type.Number()),
			maxWallClockMs: Type.Optional(Type.Number()),
			maxCostUsd: Type.Optional(Type.Number()),
			maxAttempts: Type.Optional(Type.Number()),
			maxToolCalls: Type.Optional(Type.Number()),
			requireApprovalAboveCostUsd: Type.Optional(Type.Number()),
		},
		{ additionalProperties: false },
	);
}

function assertKnownRiskBudgetFields(budget: Record<string, unknown>, label: string): void {
	const unknownField = Object.keys(budget).find(
		(field) => !RISK_BUDGET_FIELDS.includes(field as (typeof RISK_BUDGET_FIELDS)[number]),
	);
	if (unknownField) throw new TypeError(`${label} contains an unsupported field.`);
}

/** Parse raw durable budget input without cloning untrusted values. */
export function parseRiskBudget(value: unknown, label: string): RiskBudget {
	if (!isPlainRecord(value)) throw new TypeError(`${label} must be an object.`);
	assertKnownRiskBudgetFields(value, label);
	const budget: RiskBudget = {};
	for (const field of RISK_BUDGET_FIELDS) {
		const candidate = value[field];
		if (candidate === undefined) continue;
		if (typeof candidate !== "number") throw new TypeError(`${label}.${field} must be a number.`);
		budget[field] = candidate;
	}
	validateRiskBudget(budget, label);
	return budget;
}

export function validateRiskBudget(budget: RiskBudget, label: string): void {
	if (!isPlainRecord(budget)) throw new TypeError(`${label} must be an object.`);
	assertKnownRiskBudgetFields(budget, label);
	for (const field of RISK_BUDGET_FIELDS) {
		const value = (budget as RiskBudget)[field];
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
