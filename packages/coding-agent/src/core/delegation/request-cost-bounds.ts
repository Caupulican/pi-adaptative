/**
 * The budget an attempt's provider requests are checked and priced against: its task tree's, and the cost bounds over it,
 * its run's (`runCostBound`), each budgeted delegation on its ancestry (`charter.envelope.budgetUsd`) and the tree's metered
 * ceiling (`maxMeteredCostUsd`). This owner composes them and decides which of an attempt's spend is metered. A
 * subscription model has no metered or delegation dollar bound: its spend is bounded by the plan's usage windows.
 */

import type { Api, Model } from "@caupulican/pi-ai";
import { harnessLog } from "../../kernel/harness-log.ts";
import { EMPTY_ATTEMPT_USAGE, projectAttemptUsage } from "../orchestration/attempt-usage.ts";
import type { SharedCapabilityBudget } from "../orchestration/capability-gateway.ts";
import type {
	AttemptUsageSnapshot,
	OrchestrationDispatchRequest,
	OrchestrationModelBinding,
	RiskBudget,
} from "../orchestration/contracts.ts";
import { costCeilingUsd, isMeteredSpend, type ModelBilling } from "../orchestration/risk-budget.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { DELEGATION_BUDGET_REFUSAL_REASONS } from "./budget-reason-codes.ts";
import { delegationAttempts, delegationCostBounds } from "./delegation-spend.ts";
import { readDelegations } from "./leader-delegation-ledger.ts";
import type { ParentExecutionPolicy } from "./parent-execution-context.ts";
import {
	boundedByRunBudget,
	collectWorkerTreeBudgetSeeds,
	cumulativeWorkerTreeBudget,
	WorkerTreeBudgetCoordinator,
	type WorkerTreeBudgetSeed,
	workerTreeBudgetKey,
	workerTreeTaskId,
} from "./worker-tree-budget-coordinator.ts";

/** One attempt about to run: what its budget is composed from. */
export interface AttemptBudgetInput {
	readonly attemptId: string;
	readonly initialUsage: AttemptUsageSnapshot;
	readonly snapshot: TaskRuntimeProjection;
	/** The model the attempt runs on now; a failover move composes again on the next. */
	readonly model: Model<Api>;
	readonly agent: { readonly agentId: string; readonly rootAgentId: string };
	readonly attemptTaskId: string;
	/** The root agent's current turn, whose contract's authority budget the tree shares. */
	readonly rootTurn: OrchestrationDispatchRequest | undefined;
	readonly grantBudget: RiskBudget;
	readonly profileBudget: RiskBudget;
}

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
	/** Each task tree's cumulative budget, keyed by `workerTreeBudgetKey`. */
	private readonly treeBudgets = new WorkerTreeBudgetCoordinator();
	/** Each task tree's metered spend under its `maxMeteredCostUsd`, keyed as the tree's. */
	private readonly meteredTreeBudgets = new WorkerTreeBudgetCoordinator();

	/** The billing kind of a model's credential, as `isMeteredSpend` reads it. */
	private readonly billing: ModelBilling;

	constructor(deps: RequestCostBoundsDeps) {
		this.deps = deps;
		this.billing = { isUsingSubscription: (model) => deps.isSubscription(model) };
	}

	/**
	 * Whether an attempt's spend is metered: its running model (else the model its contract binds) is not a subscription
	 * model. A model the registry does not know counts as metered, which is never laxer.
	 */
	isMeteredAttempt(attempt: AttemptRuntimeState): boolean {
		const binding = attempt.runningModel ?? attempt.dispatch.executionContract?.worker.modelBinding;
		return isMeteredSpend(binding && this.deps.findModel(binding), this.billing);
	}

	/** The dollar ceiling one attempt's own spend on `model` is held to (`costCeilingUsd`). */
	costCeilingUsd(budget: RiskBudget, model: Model<Api>): number | undefined {
		return costCeilingUsd(budget, isMeteredSpend(model, this.billing));
	}

	/**
	 * The budget one attempt's provider requests are checked and recorded against: its tree's, bounded by its run's, by its
	 * tree's metered ceiling and by each budgeted delegation on its ancestry, self first. A subscription model gets neither
	 * the metered nor a delegation port. Every port is seeded from the projection, so spend made before this start is
	 * already counted.
	 */
	compose(input: AttemptBudgetInput): SharedCapabilityBudget {
		const { attemptId, initialUsage, snapshot, model } = input;
		const treeBudget = cumulativeWorkerTreeBudget(
			input.rootTurn?.executionContract?.worker.authority.budget ?? input.grantBudget,
			input.rootTurn?.executionContract?.worker.profile.budget ?? input.profileBudget,
		);
		const treeTaskId = workerTreeTaskId({
			agentId: input.agent.agentId,
			rootAgentId: input.agent.rootAgentId,
			attemptTaskId: input.attemptTaskId,
			rootAttempt: input.rootTurn,
		});
		const treeKey = workerTreeBudgetKey(treeTaskId);
		const treeSeeds = collectWorkerTreeBudgetSeeds(snapshot, input.agent.rootAgentId, treeTaskId);
		harnessLog.debug("delegation", "a worker tree budget was seeded from its own task", {
			taskId: treeTaskId,
			attemptId,
			seeds: treeSeeds.length,
		});
		const tree = this.treeBudgets.createPort({
			treeKey,
			attemptId,
			budget: treeBudget,
			seeds: treeSeeds,
			initialUsage,
		});
		const attempt = snapshot.attempts[attemptId];
		const ports: SharedCapabilityBudget[] = [];
		const run = this.runBudgetPort(attempt, attemptId, initialUsage, snapshot);
		if (run) ports.push(run);
		const metered = isMeteredSpend(model, this.billing);
		const meteredTree = metered && this.meteredTreePort(treeKey, treeBudget.maxMeteredCostUsd, treeSeeds, input);
		if (meteredTree) ports.push(meteredTree);
		if (attempt && metered) {
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
		return ports.reduce((folded, port) => boundedByRunBudget(folded, port), tree);
	}

	/**
	 * The tree's metered spend held to its `maxMeteredCostUsd`: only metered attempts seed it, and each request of a metered
	 * attempt is priced against it before it is sent. Undefined when the tree sets no metered ceiling.
	 */
	private meteredTreePort(
		treeKey: string,
		maxMeteredCostUsd: number | undefined,
		seeds: readonly WorkerTreeBudgetSeed[],
		input: AttemptBudgetInput,
	): SharedCapabilityBudget | undefined {
		if (maxMeteredCostUsd === undefined) return undefined;
		return this.meteredTreeBudgets.createPort({
			treeKey,
			attemptId: input.attemptId,
			budget: { maxCostUsd: maxMeteredCostUsd },
			pricesRequests: true,
			seeds: seeds.filter((seed) => {
				const attempt = input.snapshot.attempts[seed.attemptId];
				return attempt === undefined || this.isMeteredAttempt(attempt);
			}),
			initialUsage: input.initialUsage,
		});
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
