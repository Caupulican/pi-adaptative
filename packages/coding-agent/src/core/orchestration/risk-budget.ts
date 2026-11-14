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

export const RISK_BUDGET_FIELDS = [...RISK_BUDGET_LIMIT_FIELDS, "maxMeteredCostUsd"] as const;

/**
 * The legacy name of `maxMeteredCostUsd`, read from profiles and durable records written before the rename and never
 * written: a budget that sets both names is refused.
 */
const LEGACY_METERED_COST_FIELD = "requireApprovalAboveCostUsd";

const DISCRETE_BUDGET_FIELDS: ReadonlySet<(typeof RISK_BUDGET_FIELDS)[number]> = new Set([
	"maxTokens",
	"maxWallClockMs",
	"maxAttempts",
	"maxToolCalls",
]);

function assertKnownRiskBudgetFields(budget: Record<string, unknown>, label: string): void {
	const unknownField = Object.keys(budget).find(
		(field) => !RISK_BUDGET_FIELDS.includes(field as (typeof RISK_BUDGET_FIELDS)[number]),
	);
	if (unknownField) throw new TypeError(`${label} contains an unsupported field.`);
}

/** Parse raw durable budget input without cloning untrusted values; a field under its former name reads under its current one. */
export function parseRiskBudget(value: unknown, label: string): RiskBudget {
	if (!isPlainRecord(value)) throw new TypeError(`${label} must be an object.`);
	const { [LEGACY_METERED_COST_FIELD]: legacyMetered, ...current } = value;
	if (legacyMetered !== undefined && current.maxMeteredCostUsd !== undefined)
		throw new TypeError(`${label} sets both maxMeteredCostUsd and its legacy name ${LEGACY_METERED_COST_FIELD}.`);
	assertKnownRiskBudgetFields(current, label);
	const budget: RiskBudget = {};
	for (const field of RISK_BUDGET_FIELDS) {
		const candidate = field === "maxMeteredCostUsd" ? (current[field] ?? legacyMetered) : current[field];
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
	const meteredCeiling = result.maxMeteredCostUsd;
	if (meteredCeiling !== undefined) {
		result.maxCostUsd = Math.min(result.maxCostUsd ?? meteredCeiling, meteredCeiling);
	}
	return result;
}
