/**
 * The reason codes budget bounds report, and the exact sets their readers classify by: a worker tree's exhausted
 * fields, a run's and a budgeted delegation's cost refusals, the grant's own checks, and the token a cost refusal
 * carries for the aggregate it refused. Constants and types only, so the lane projection, the worker runner and the
 * leader's spend reader classify a reason code without loading the budget coordinator.
 */

import type { GatewayDecisionCode } from "../orchestration/capability-gateway.ts";
import type { WorkerTreeBudgetField } from "./worker-tree-budget-coordinator.ts";

export const WORKER_TREE_BUDGET_REASON_CODES: Readonly<Record<WorkerTreeBudgetField, string>> = {
	maxTokens: "worker_tree_token_budget_exhausted",
	maxCostUsd: "worker_tree_cost_budget_exhausted",
	maxToolCalls: "worker_tree_tool_call_budget_exhausted",
	maxWallClockMs: "worker_tree_wall_clock_budget_exhausted",
	maxAttempts: "worker_tree_attempt_budget_exhausted",
};

/** The refusal codes a priced aggregate reports: an unpriced model, and a remainder its request cannot fit. */
export interface BudgetRefusalReasons {
	readonly unpriced: string;
	readonly exhausted: string;
}

/** The refusal codes of a run's cost bound (`ParentExecutionPolicy.runCostBound`). */
export const RUN_BUDGET_REFUSAL_REASONS = {
	unpriced: "worker_run_model_unpriced",
	exhausted: "worker_run_cost_budget_exhausted",
} as const satisfies BudgetRefusalReasons;

/** The refusal codes of a budgeted delegation (`charter.envelope.budgetUsd`): the leader controller closes on them. */
export const DELEGATION_BUDGET_REFUSAL_REASONS = {
	unpriced: "worker_delegation_model_unpriced",
	exhausted: "worker_delegation_cost_budget_exhausted",
} as const satisfies BudgetRefusalReasons;

/** The grant's own checks: the capability gateway denies a tool call or a provider request with these. */
const GRANT_BUDGET_REASON_CODES: readonly GatewayDecisionCode[] = [
	"tool_call_budget_exhausted",
	"token_budget_exhausted",
	"cost_budget_exhausted",
	"wall_clock_budget_exhausted",
];

/** The claim-level cost check of a finished worker: its claim ended over the owner's cost cap (`worker-runner`). */
export const CLAIM_COST_BUDGET_REASON_CODE = "cost_budget_exceeded";

/**
 * Every reason code under which a budget stopped a worker attempt. Exact codes only: a reason that merely mentions a
 * budget (a goal's stop, a routine's refusal) is not one of them.
 */
export const BUDGET_EXHAUSTED_REASON_CODES: ReadonlySet<string> = new Set([
	"budget_exhausted",
	"attempt_budget_exhausted",
	...Object.values(WORKER_TREE_BUDGET_REASON_CODES),
	RUN_BUDGET_REFUSAL_REASONS.exhausted,
	DELEGATION_BUDGET_REFUSAL_REASONS.exhausted,
	...GRANT_BUDGET_REASON_CODES,
	CLAIM_COST_BUDGET_REASON_CODE,
]);

/**
 * The refusal codes of a model with no declared price. A cost bound refuses such a request before it is sent: the worker
 * never ran, so the refusal is a failure to run, not a spent budget.
 */
export const UNPRICED_BUDGET_REASON_CODES: ReadonlySet<string> = new Set([
	RUN_BUDGET_REFUSAL_REASONS.unpriced,
	DELEGATION_BUDGET_REFUSAL_REASONS.unpriced,
]);

/**
 * The token a cost refusal carries for the aggregate it refused: the aggregate's key in brackets. A reader names an
 * aggregate by this exact token, so a key never matches another key it prefixes.
 */
export function costRefusalTokenFor(treeKey: string): string {
	return `[${treeKey}]`;
}
