import type { Api, Model } from "@caupulican/pi-ai";
import { isPlainRecord } from "../util/value-guards.ts";
import type { RiskBudget } from "./contracts.ts";

export const RISK_BUDGET_LIMIT_FIELDS = [
	"maxTokens",
	"maxWallClockMs",
	"maxCostUsd",
	"maxAttempts",
	"maxToolCalls",
	"maxMeteredCostUsd",
] as const;

export type RiskBudgetLimitField = (typeof RISK_BUDGET_LIMIT_FIELDS)[number];

export const RISK_BUDGET_FIELDS = RISK_BUDGET_LIMIT_FIELDS;

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
	return result;
}

/** The billing kind of a model's credential: a subscription (a plan with usage windows) or metered (an API key). */
export interface ModelBilling {
	isUsingSubscription(model: Model<Api>): boolean;
}

/**
 * Whether spend on `model` is metered, read from the billing kind of the model's credential. Spend that is no model's own
 * (`model` undefined: a System One request) is metered.
 */
export function isMeteredSpend(model: Model<Api> | undefined, billing: ModelBilling): boolean {
	return model === undefined || !billing.isUsingSubscription(model);
}

/**
 * The dollar ceiling spend is held to: `maxCostUsd`, and also `maxMeteredCostUsd` when the spend is metered
 * (`isMeteredSpend`). A subscription's limit is its plan's usage windows, so the metered ceiling never stops it. Undefined
 * when neither ceiling applies.
 */
export function costCeilingUsd(
	budget: Pick<RiskBudget, "maxCostUsd" | "maxMeteredCostUsd">,
	metered: boolean,
): number | undefined {
	const ceilings = [budget.maxCostUsd, metered ? budget.maxMeteredCostUsd : undefined].filter(
		(ceiling): ceiling is number => ceiling !== undefined,
	);
	return ceilings.length > 0 ? Math.min(...ceilings) : undefined;
}

/** The dollar ceilings a session's capability envelope sets, as the budget `costCeilingUsd` reads. */
export function envelopeCostBudget(
	envelope: { readonly maxEstimatedUsd?: number; readonly maxMeteredEstimatedUsd?: number } | undefined,
): Pick<RiskBudget, "maxCostUsd" | "maxMeteredCostUsd"> {
	return {
		...(envelope?.maxEstimatedUsd !== undefined ? { maxCostUsd: envelope.maxEstimatedUsd } : {}),
		...(envelope?.maxMeteredEstimatedUsd !== undefined ? { maxMeteredCostUsd: envelope.maxMeteredEstimatedUsd } : {}),
	};
}

/** A budget's dollar ceilings as a capability envelope carries them, read back by `envelopeCostBudget`. */
export function envelopeCostCeilings(budget: Pick<RiskBudget, "maxCostUsd" | "maxMeteredCostUsd">): {
	maxEstimatedUsd?: number;
	maxMeteredEstimatedUsd?: number;
} {
	return {
		...(budget.maxCostUsd !== undefined ? { maxEstimatedUsd: budget.maxCostUsd } : {}),
		...(budget.maxMeteredCostUsd !== undefined ? { maxMeteredEstimatedUsd: budget.maxMeteredCostUsd } : {}),
	};
}

/**
 * A session envelope's dollar ceiling on spend made on `model` (`costCeilingUsd` of `envelopeCostBudget`): its metered
 * ceiling too when the spend is metered (`isMeteredSpend`; `model` undefined is System One spend).
 */
export function envelopeCeilingUsd(
	envelope: { readonly maxEstimatedUsd?: number; readonly maxMeteredEstimatedUsd?: number } | undefined,
	model: Model<Api> | undefined,
	billing: ModelBilling,
): number | undefined {
	return costCeilingUsd(envelopeCostBudget(envelope), isMeteredSpend(model, billing));
}
