/**
 * The budget an attempt's provider requests are checked and priced against: its task tree's, and the dollar bounds over
 * it, its tree's (`costCeilingUsd` of the tree budget), its run's (`runCostBound`) and each budgeted delegation's on its
 * ancestry (`charter.envelope.budgetUsd`). This owner composes them and decides which of an attempt's spend is metered.
 * By the owner's cost rule every dollar bound counts metered spend alone and holds a metered attempt only: a subscription
 * model has no dollar bound, its spend is bounded by the plan's usage windows.
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
import {
	delegationAttempts,
	delegationCostBounds,
	delegationMailSpentUsd,
	type GoalMailSpend,
} from "./delegation-spend.ts";
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

/**
 * Whether an attempt's spend is metered (`isMeteredSpend`): its running model, else the model its contract binds, is not
 * a subscription model. A model `findModel` does not know counts as metered, which is never laxer.
 */
export function isMeteredAttemptSpend(
	attempt: AttemptRuntimeState,
	findModel: (binding: OrchestrationModelBinding) => Model<Api> | undefined,
	billing: ModelBilling,
): boolean {
	const binding = attempt.runningModel ?? attempt.dispatch.executionContract?.worker.modelBinding;
	return isMeteredSpend(binding && findModel(binding), billing);
}

/** One attempt about to run: what its budget is composed from. */
export interface AttemptBudgetInput {
	readonly attemptId: string;
	readonly initialUsage: AttemptUsageSnapshot;
	readonly snapshot: TaskRuntimeProjection;
	/** The model the attempt runs on now; a failover at its start composes again (`composeMovable`), a retry at its own. */
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
	/** The spend bots answering in sessions of their own made for a goal's mail, kept beside the session's store. */
	readonly goalMailSpentUsd: GoalMailSpend;
}

/** An attempt's budget (`RequestCostBounds.composeMovable`) that follows a model move before its first request. */
export interface MovableAttemptBudget extends SharedCapabilityBudget {
	/** Composes the attempt's budget again on the model its start failed over to. */
	moveTo(model: Model<Api>, snapshot: TaskRuntimeProjection): void;
}

export class RequestCostBounds {
	private readonly deps: RequestCostBoundsDeps;
	/** Budgets shared by the metered attempts of one bounded run over their spend, keyed by run. */
	private readonly runBudgets = new WorkerTreeBudgetCoordinator();
	/** Budgets shared by every attempt under one budgeted delegation, keyed by `delegation:<objectiveId>`. */
	private readonly delegationBudgets = new WorkerTreeBudgetCoordinator();
	/** Each task tree's cumulative budget, keyed by `workerTreeBudgetKey`. */
	private readonly treeBudgets = new WorkerTreeBudgetCoordinator();
	/** Each task tree's metered spend under its dollar ceiling, keyed as the tree's. */
	private readonly meteredTreeBudgets = new WorkerTreeBudgetCoordinator();

	/** The billing kind of a model's credential, as `isMeteredSpend` reads it. */
	private readonly billing: ModelBilling;

	constructor(deps: RequestCostBoundsDeps) {
		this.deps = deps;
		this.billing = { isUsingSubscription: (model) => deps.isSubscription(model) };
	}

	/** Whether an attempt's spend is metered (`isMeteredAttemptSpend`). */
	isMeteredAttempt(attempt: AttemptRuntimeState): boolean {
		return isMeteredAttemptSpend(attempt, this.deps.findModel, this.billing);
	}

	/** Whether spend on `model` is metered (`isMeteredSpend`). */
	isMeteredModel(model: Model<Api>): boolean {
		return isMeteredSpend(model, this.billing);
	}

	/** The dollar ceiling one attempt's own spend on `model` is held to (`costCeilingUsd`). */
	costCeilingUsd(budget: RiskBudget, model: Model<Api>): number | undefined {
		return costCeilingUsd(budget, this.isMeteredModel(model));
	}

	/**
	 * The budget one attempt's provider requests are checked and recorded against: its tree's (its limits other than
	 * dollars), bounded by its run's, by its tree's dollar ceiling and by each budgeted delegation on its ancestry, self
	 * first. A subscription model gets no dollar port. Every port is seeded from the projection, so spend made before this
	 * start is already counted.
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
		// The tree's dollar ceilings hold its metered spend alone (`meteredTreePort`), never its whole spend.
		const { maxCostUsd: _treeCostUsd, maxMeteredCostUsd: _treeMeteredCostUsd, ...treeLimits } = treeBudget;
		const tree = this.treeBudgets.createPort({
			treeKey,
			attemptId,
			budget: treeLimits,
			seeds: treeSeeds,
			initialUsage,
		});
		const attempt = snapshot.attempts[attemptId];
		const metered = this.isMeteredModel(model);
		const ports: SharedCapabilityBudget[] = this.runBudgetPorts(attempt, attemptId, initialUsage, snapshot, metered);
		const meteredTree = metered && this.meteredTreePort(treeKey, costCeilingUsd(treeBudget, true), treeSeeds, input);
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
						seeds: [
							...delegationAttempts(snapshot, records, bound.objectiveId)
								.filter((candidate) => this.isMeteredAttempt(candidate))
								.map((candidate) => ({
									attemptId: candidate.attemptId,
									usage: projectAttemptUsage(candidate, snapshot.checkpoints) ?? EMPTY_ATTEMPT_USAGE,
								})),
							// The bots that answered the subtree's mail in sessions of their own spent outside this session's attempts.
							{
								attemptId: `goal-mail:${bound.objectiveId}`,
								usage: {
									...EMPTY_ATTEMPT_USAGE,
									costUsd: delegationMailSpentUsd(records, bound.objectiveId, this.deps.goalMailSpentUsd),
								},
							},
						],
						initialUsage,
					}),
				);
			}
		}
		return ports.reduce((folded, port) => boundedByRunBudget(folded, port), tree);
	}

	/**
	 * `compose`, for an attempt whose start may fail over to another model before its first provider request (its
	 * credential did not resolve): `moveTo` composes it again on that model, so a move from a subscription model to a
	 * metered one is held by the metered bounds, and its run reserved on the host's wider bound, before it spends.
	 */
	composeMovable(input: AttemptBudgetInput): MovableAttemptBudget {
		let current = this.compose(input);
		return {
			assertBudgetAvailable: (subject) => current.assertBudgetAvailable(subject),
			getAttemptUsage: () => current.getAttemptUsage(),
			recordAttemptUsage: (usage, accounting) => current.recordAttemptUsage(usage, accounting),
			remainingTokens: () => current.remainingTokens(),
			remainingContextTokens: () => current.remainingContextTokens(),
			reserveProviderBudget: (requestedMaxTokens, subject, signal, request) =>
				current.reserveProviderBudget(requestedMaxTokens, subject, signal, request),
			moveTo: (model, snapshot) => {
				current = this.compose({ ...input, model, snapshot });
			},
		};
	}

	/**
	 * The tree's metered spend held to its dollar ceiling (`costCeilingUsd`): only metered attempts seed it, and each request
	 * of a metered attempt is priced against it before it is sent. Undefined when the tree sets no dollar ceiling.
	 */
	private meteredTreePort(
		treeKey: string,
		maxCostUsd: number | undefined,
		seeds: readonly WorkerTreeBudgetSeed[],
		input: AttemptBudgetInput,
	): SharedCapabilityBudget | undefined {
		if (maxCostUsd === undefined) return undefined;
		return this.meteredTreeBudgets.createPort({
			treeKey,
			attemptId: input.attemptId,
			budget: { maxCostUsd },
			pricesRequests: true,
			seeds: seeds.filter((seed) => {
				const attempt = input.snapshot.attempts[seed.attemptId];
				return attempt === undefined || this.isMeteredAttempt(attempt);
			}),
			initialUsage: input.initialUsage,
		});
	}

	/**
	 * The budget a metered attempt's run shares with the run's other metered attempts (`runCostBound`): the run's metered
	 * spend, seeded from every durable metered attempt of the run, each request priced against it (one on a model with no
	 * price is refused). None when the host bounds no run or sets it no dollar bound, or when the attempt is not metered
	 * (`metered`): its plan's usage windows hold it.
	 */
	private runBudgetPorts(
		attempt: AttemptRuntimeState | undefined,
		attemptId: string,
		initialUsage: AttemptUsageSnapshot,
		snapshot: TaskRuntimeProjection,
		metered: boolean,
	): SharedCapabilityBudget[] {
		// Asked for every attempt: the host counts the attempt to its run as it answers (`BotSpendWindows.runCostBound`), and
		// reserves a metered attempt's run on a wider bound of its own (a run away's day bound).
		const bound = attempt ? this.deps.runCostBound?.(attempt, snapshot, metered) : undefined;
		if (!metered || bound?.maxCostUsd === undefined) return [];
		const seeds = Object.values(snapshot.attempts)
			.filter((candidate) => bound.includes(candidate) && this.isMeteredAttempt(candidate))
			.map((candidate) => ({
				attemptId: candidate.attemptId,
				usage: projectAttemptUsage(candidate, snapshot.checkpoints) ?? EMPTY_ATTEMPT_USAGE,
			}));
		return [
			this.runBudgets.createPort({
				treeKey: bound.runId,
				attemptId,
				budget: { maxCostUsd: bound.maxCostUsd },
				pricesRequests: true,
				seeds,
				initialUsage,
			}),
		];
	}
}
