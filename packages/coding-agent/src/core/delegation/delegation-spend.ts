/**
 * Delegation-keyed spend: the metered cost a delegation's subtree has run, the chain of delegations an attempt's work
 * draws on (the attempt's own delegation, then its parents), and the refusal a delegation budget gave a turn. Pure over a
 * projection and the delegation records read from it. The leader controller and the request cost bounds decide with these
 * facts; nothing here judges.
 */

import { isLeaderDelegationObjectiveId } from "../orchestration/delegation-ledger.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { costRefusalTokenFor, DELEGATION_BUDGET_REFUSAL_REASONS } from "./budget-reason-codes.ts";
import { LEADER_MAX_DEPTH_CEILING } from "./leader-delegation.ts";
import { type LeaderCharter, readDelegations } from "./leader-delegation-ledger.ts";

/** The delegation facts this module reads: a delegation record satisfies it, and so does one that names a parent. */
export interface DelegationSpendRecord {
	readonly objectiveId: string;
	readonly charter: Pick<LeaderCharter, "envelope"> & { readonly parentObjectiveId?: string };
}

/** A walk visits its start record and at most `LEADER_MAX_DEPTH_CEILING` parents: no chain can be deeper than that. */
const MAX_ANCESTRY_RECORDS = LEADER_MAX_DEPTH_CEILING + 1;
const DELEGATION_BUDGET_REFUSAL_CODES: ReadonlySet<string> = new Set(Object.values(DELEGATION_BUDGET_REFUSAL_REASONS));
/** The statuses of a turn that has not ended. */
export const ACTIVE_ATTEMPT_STATUSES = new Set<AttemptRuntimeState["status"]>([
	"queued",
	"leased",
	"running",
	"suspended",
]);

/** The key a delegation's budget port lives under in its aggregate. */
export function delegationBudgetTreeKey(objectiveId: string): string {
	return `delegation:${objectiveId}`;
}

/**
 * The delegation records an objective's own record and each of its parents, self first. The walk stops at a missing
 * parent, at a repeated record, or after `MAX_ANCESTRY_RECORDS` records.
 */
export function delegationAncestry<R extends DelegationSpendRecord>(records: readonly R[], objectiveId: string): R[] {
	const byId = new Map(records.map((record) => [record.objectiveId, record]));
	const chain: R[] = [];
	const visited = new Set<string>();
	let next: string | undefined = objectiveId;
	while (next !== undefined && chain.length < MAX_ANCESTRY_RECORDS && !visited.has(next)) {
		const record = byId.get(next);
		if (!record) break;
		visited.add(next);
		chain.push(record);
		next = record.charter.parentObjectiveId;
	}
	return chain;
}

/** The objective and every record whose parent chain reaches it. */
export function delegationSubtree(records: readonly DelegationSpendRecord[], objectiveId: string): ReadonlySet<string> {
	const subtree = new Set<string>([objectiveId]);
	for (const record of records) {
		if (delegationAncestry(records, record.objectiveId).some((entry) => entry.objectiveId === objectiveId))
			subtree.add(record.objectiveId);
	}
	return subtree;
}

/** The delegation an attempt's work is filed under, when it is a leader delegation's; undefined for any other work. */
export function attemptDelegationObjectiveId(
	attempt: Pick<AttemptRuntimeState, "taskId">,
	snapshot: Pick<TaskRuntimeProjection, "tasks">,
): string | undefined {
	const objectiveId = snapshot.tasks[attempt.taskId]?.task.objectiveId;
	return objectiveId !== undefined && isLeaderDelegationObjectiveId(objectiveId) ? objectiveId : undefined;
}

/** The cost an attempt recorded: its usage accounting, else its result's usage. A figure that is not a positive number counts nothing. */
function attemptCostUsd(attempt: AttemptRuntimeState): number {
	const usd = attempt.usageAccounting?.total.costUsd ?? attempt.result?.usage.costUsd ?? 0;
	return Number.isFinite(usd) && usd > 0 ? usd : 0;
}

/** The recorded cost of the attempts that are metered. Subscription turns are not money and count nothing. */
export function sumMeteredSpendUsd(
	attempts: readonly AttemptRuntimeState[],
	isMetered: (attempt: AttemptRuntimeState) => boolean,
): number {
	return attempts.reduce((sum, attempt) => (isMetered(attempt) ? sum + attemptCostUsd(attempt) : sum), 0);
}

/** Every turn (an attempt with an agent) filed under a delegation of the subtree rooted at `objectiveId`. */
export function delegationAttempts(
	snapshot: TaskRuntimeProjection,
	records: readonly DelegationSpendRecord[],
	objectiveId: string,
): AttemptRuntimeState[] {
	const subtree = delegationSubtree(records, objectiveId);
	return Object.values(snapshot.attempts).filter((attempt) => {
		const filed = attemptDelegationObjectiveId(attempt, snapshot);
		return attempt.agentId !== undefined && filed !== undefined && subtree.has(filed);
	});
}

/** The metered spend of a delegation's subtree. */
export function delegationSpentUsd(
	snapshot: TaskRuntimeProjection,
	records: readonly DelegationSpendRecord[],
	objectiveId: string,
	isMetered: (attempt: AttemptRuntimeState) => boolean,
): number {
	return sumMeteredSpendUsd(delegationAttempts(snapshot, records, objectiveId), isMetered);
}

/**
 * The budgeted delegations an attempt's requests are priced against: each ancestry entry that carries a `budgetUsd`,
 * self first. Each carries the full budget; the port it seeds carries the spend already made.
 */
export function delegationCostBounds(
	attempt: AttemptRuntimeState,
	snapshot: TaskRuntimeProjection,
): readonly { readonly treeKey: string; readonly maxCostUsd: number; readonly objectiveId: string }[] {
	const objectiveId = attemptDelegationObjectiveId(attempt, snapshot);
	if (objectiveId === undefined) return [];
	return delegationAncestry(readDelegations(snapshot), objectiveId).flatMap((record) => {
		const maxCostUsd = record.charter.envelope.budgetUsd;
		return maxCostUsd === undefined
			? []
			: [{ treeKey: delegationBudgetTreeKey(record.objectiveId), maxCostUsd, objectiveId: record.objectiveId }];
	});
}

/**
 * Why a delegation's own budget stops it, as code: `exhausted` once its metered turns reach `budgetUsd`, `unpriced` when a
 * terminal turn was refused by this delegation's own port for a model with no declared price, else undefined. A refusal
 * closes only the delegation whose port refused: the refusal names the port's aggregate (`costRefusalTokenFor`), so a
 * refusal raised under a descendant or by an ancestor's port leaves this record open. Its turns are the subtree's when
 * they are filed under its objective, else the `attributed` turns the caller read for it (an earlier build's, by time window).
 */
export function delegationBudgetStop(
	record: DelegationSpendRecord & { readonly filedByObjective: boolean },
	snapshot: TaskRuntimeProjection,
	records: readonly DelegationSpendRecord[],
	attributed: readonly AttemptRuntimeState[],
	isMetered: (attempt: AttemptRuntimeState) => boolean,
): "exhausted" | "unpriced" | undefined {
	const budget = record.charter.envelope.budgetUsd;
	const spent = record.filedByObjective
		? delegationSpentUsd(snapshot, records, record.objectiveId, isMetered)
		: sumMeteredSpendUsd(attributed, isMetered);
	if (budget !== undefined && spent >= budget) return "exhausted";
	const ownToken = costRefusalTokenFor(delegationBudgetTreeKey(record.objectiveId));
	const turns = record.filedByObjective ? delegationAttempts(snapshot, records, record.objectiveId) : attributed;
	const refusal = turns.find((turn) => {
		const code = turnReasonCode(turn);
		return (
			!ACTIVE_ATTEMPT_STATUSES.has(turn.status) &&
			code !== undefined &&
			DELEGATION_BUDGET_REFUSAL_CODES.has(code) &&
			(turn.result?.summary.includes(ownToken) ?? false)
		);
	});
	if (refusal === undefined) return undefined;
	return turnReasonCode(refusal) === DELEGATION_BUDGET_REFUSAL_REASONS.unpriced ? "unpriced" : "exhausted";
}

/**
 * The code a turn ended with: its result's, else the one its attempt carries. A finished turn writes its code on the
 * result only; the lane projection reads the same order.
 */
function turnReasonCode(turn: AttemptRuntimeState): string | undefined {
	return turn.result?.reasonCode ?? turn.reasonCode;
}
