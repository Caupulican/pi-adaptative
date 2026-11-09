/**
 * The cost bounds an attempt's provider requests are priced against: its run's (`runCostBound`) and each budgeted
 * delegation on its ancestry (`charter.envelope.budgetUsd`). This owner composes them over the attempt's tree budget and
 * decides which of an attempt's spend is metered. A subscription model has no dollar bound: its spend is bounded by the
 * allowance, never by a budget in dollars.
 */

import type { Api, Model } from "@caupulican/pi-ai";
import { EMPTY_ATTEMPT_USAGE, projectAttemptUsage } from "../orchestration/attempt-usage.ts";
import type { SharedCapabilityBudget } from "../orchestration/capability-gateway.ts";
import type { AttemptUsageSnapshot, OrchestrationModelBinding } from "../orchestration/contracts.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { DELEGATION_BUDGET_REFUSAL_REASONS } from "./budget-reason-codes.ts";
import { delegationAttempts, delegationCostBounds } from "./delegation-spend.ts";
import { readDelegations } from "./leader-delegation-ledger.ts";
import type { ParentExecutionPolicy } from "./parent-execution-context.ts";
import { boundedByRunBudget, WorkerTreeBudgetCoordinator } from "./worker-tree-budget-coordinator.ts";

export interface RequestCostBoundsDeps {
	/** The host's run bound; absent, no run is bounded. */
	readonly runCostBound?: ParentExecutionPolicy["runCostBound"];
	readonly isSubscription: (model: Model<Api>) => boolean;
	readonly findModel: (binding: OrchestrationModelBinding) => Model<Api> | undefined;
}

export class RequestCostBounds {
	private readonly deps: RequestCostBoundsDeps;
	/** Budgets shared by every attempt of one bounded run, keyed by run. */
	private readonly runBudgets = new WorkerTreeBudgetCoordinator();
	/** Budgets shared by every attempt under one budgeted delegation, keyed by `delegation:<objectiveId>`. */
	private readonly delegationBudgets = new WorkerTreeBudgetCoordinator();

	constructor(deps: RequestCostBoundsDeps) {
		this.deps = deps;
	}

	/**
	 * Whether an attempt's spend is metered: its running model (else the model its contract binds) is not a subscription
	 * model. A model the registry does not know counts as metered, which is never laxer.
	 */
	isMeteredAttempt(attempt: AttemptRuntimeState): boolean {
		const binding = attempt.runningModel ?? attempt.dispatch.executionContract?.worker.modelBinding;
		if (!binding) return true;
		const model = this.deps.findModel(binding);
		return model === undefined || !this.deps.isSubscription(model);
	}

	/**
	 * The budget one attempt's provider requests are checked and recorded against: its tree's, bounded by its run's and by
	 * each budgeted delegation on its ancestry, self first. A subscription model gets no delegation port. Every port is
	 * seeded from the projection, so spend made before this start is already counted. With no extra port this is
	 * `treeBudget` itself.
	 */
	compose(
		attemptId: string,
		initialUsage: AttemptUsageSnapshot,
		snapshot: TaskRuntimeProjection,
		model: Model<Api>,
		treeBudget: SharedCapabilityBudget,
	): SharedCapabilityBudget {
		const attempt = snapshot.attempts[attemptId];
		const ports: SharedCapabilityBudget[] = [];
		const run = this.runBudgetPort(attempt, attemptId, initialUsage, snapshot);
		if (run) ports.push(run);
		if (attempt && !this.deps.isSubscription(model)) {
			const records = readDelegations(snapshot);
			for (const bound of delegationCostBounds(attempt, snapshot)) {
				ports.push(
					this.delegationBudgets.createPort({
						treeKey: bound.treeKey,
						attemptId,
						budget: { maxCostUsd: bound.maxCostUsd },
						pricesRequests: true,
						refusalReasons: DELEGATION_BUDGET_REFUSAL_REASONS,
						seeds: delegationAttempts(snapshot, records, bound.objectiveId)
							.filter((candidate) => this.isMeteredAttempt(candidate))
							.map((candidate) => ({
								attemptId: candidate.attemptId,
								usage: projectAttemptUsage(candidate, snapshot.checkpoints) ?? EMPTY_ATTEMPT_USAGE,
							})),
						initialUsage,
					}),
				);
			}
		}
		return ports.reduce((folded, port) => boundedByRunBudget(folded, port), treeBudget);
	}

	/**
	 * The budget the attempt's run shares with its other attempts (`runCostBound`), seeded from every durable attempt of
	 * that run; undefined when the host bounds no run.
	 */
	private runBudgetPort(
		attempt: AttemptRuntimeState | undefined,
		attemptId: string,
		initialUsage: AttemptUsageSnapshot,
		snapshot: TaskRuntimeProjection,
	): SharedCapabilityBudget | undefined {
		const runCostBound = this.deps.runCostBound;
		if (!runCostBound) return undefined;
		const bound = attempt ? runCostBound(attempt, snapshot) : undefined;
		if (!bound) return undefined;
		const seeds = Object.values(snapshot.attempts)
			.filter((candidate) => runCostBound(candidate, snapshot)?.runId === bound.runId)
			.map((candidate) => ({
				attemptId: candidate.attemptId,
				usage: projectAttemptUsage(candidate, snapshot.checkpoints) ?? EMPTY_ATTEMPT_USAGE,
			}));
		return this.runBudgets.createPort({
			treeKey: bound.runId,
			attemptId,
			budget: { maxCostUsd: bound.maxCostUsd },
			pricesRequests: true,
			seeds,
			initialUsage,
		});
	}
}
