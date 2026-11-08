import { resolveModelCost } from "@caupulican/pi-ai/usage";
import type { RequestPreflightContext } from "../../kernel/loop-config.ts";
import { estimateProviderRequestTokens } from "../../kernel/provider-request-estimator.ts";
import { BoundedCompletionFailureError } from "../autonomy/bounded-completion.ts";
import { affordableOutputTokenLimit } from "../cost-guard.ts";
import { nativeAgentIdForAttempt } from "../orchestration/attempt-agent-identity.ts";
import {
	attemptUsageFromGatewayUsage,
	EMPTY_ATTEMPT_USAGE,
	projectAttemptUsage,
	reconcileAttemptUsage,
} from "../orchestration/attempt-usage.ts";
import {
	type AttemptUsageAccounting,
	reconcileAttemptUsageAccounting,
} from "../orchestration/attempt-usage-generations.ts";
import {
	budgetedTokens,
	type GatewayUsageSnapshot,
	type ProviderBudgetReservation,
	type SharedCapabilityBudget,
} from "../orchestration/capability-gateway.ts";
import type { AttemptUsageSnapshot, OrchestrationDispatchRequest, RiskBudget } from "../orchestration/contracts.ts";
import { intersectRiskBudgets } from "../orchestration/risk-budget.ts";

export type WorkerTreeBudgetField = "maxTokens" | "maxCostUsd" | "maxToolCalls" | "maxWallClockMs" | "maxAttempts";

const WORKER_TREE_BUDGET_REASON_CODES: Readonly<Record<WorkerTreeBudgetField, string>> = {
	maxTokens: "worker_tree_token_budget_exhausted",
	maxCostUsd: "worker_tree_cost_budget_exhausted",
	maxToolCalls: "worker_tree_tool_call_budget_exhausted",
	maxWallClockMs: "worker_tree_wall_clock_budget_exhausted",
	maxAttempts: "worker_tree_attempt_budget_exhausted",
};

export class WorkerTreeBudgetExceededError extends BoundedCompletionFailureError {
	readonly field: WorkerTreeBudgetField;

	constructor(field: WorkerTreeBudgetExceededError["field"], subject: string) {
		super(
			"budget_exhausted",
			WORKER_TREE_BUDGET_REASON_CODES[field],
			`Worker orchestration tree budget '${field}' is exhausted before ${subject}.`,
		);
		this.name = "WorkerTreeBudgetExceededError";
		this.field = field;
	}
}

interface TreeBudgetState {
	budget: RiskBudget;
	/** Each reservation is priced against the remaining `maxCostUsd` (see `createPort`). */
	pricesRequests: boolean;
	attempts: Map<string, AttemptUsageSnapshot>;
	generationUsage: Map<string, AttemptUsageAccounting>;
	reservations: Map<string, { maxTokens: number }>;
	waiters: ProviderBudgetWaiter[];
}

interface ProviderBudgetWaiter {
	attemptId: string;
	requestedMaxTokens: number;
	subject: string;
	signal?: AbortSignal;
	request?: RequestPreflightContext;
	resolve(reservation: ProviderBudgetReservation): void;
	reject(error: unknown): void;
	onAbort?: () => void;
}

export interface WorkerTreeBudgetSeed {
	attemptId: string;
	usage: AttemptUsageSnapshot;
}

export interface WorkerTreeBudgetProjection {
	agents: Readonly<Record<string, { rootAgentId: string }>>;
	attempts: Readonly<
		Record<
			string,
			{
				attemptId: string;
				taskId: string;
				agentId?: string;
				dispatch: Pick<OrchestrationDispatchRequest, "executionKind" | "logicalLaneId">;
				checkpointIds: readonly string[];
				usageAccounting?: { readonly total: AttemptUsageSnapshot };
			}
		>
	>;
	checkpoints: Readonly<Record<string, { usage?: AttemptUsageSnapshot }>>;
}

/** True when one more tree attempt can still make a provider request under `maxAttempts`. */
export function workerTreeCanAdmitAttempt(existingAttemptCount: number, maxAttempts: number | undefined): boolean {
	if (maxAttempts === undefined) return true;
	return existingAttemptCount < maxAttempts;
}

/**
 * The task whose tree an attempt draws on. A root agent draws on the task the attempt serves, so a persistent
 * specialist that takes a new task starts a fresh tree. A nested descendant (recovered lineage) has no durable link to
 * the root task that spawned it, so it draws on the task its root is running.
 */
export function workerTreeTaskId(args: {
	agentId: string;
	rootAgentId: string;
	attemptTaskId: string;
	rootAttempt: { taskId: string } | undefined;
}): string {
	return args.agentId === args.rootAgentId ? args.attemptTaskId : (args.rootAttempt?.taskId ?? args.attemptTaskId);
}

/** The key one task's tree budget lives under, durable seeds and in-memory aggregate alike. */
export function workerTreeBudgetKey(treeTaskId: string): string {
	return `task:${treeTaskId}`;
}

/**
 * Rebuild every durable attempt of one task's tree, including attempts with no usage checkpoint yet. The root agent's
 * attempts count only for `treeTaskId` (a persistent specialist's earlier tasks are not charged to a new one); a
 * descendant agent's attempts all count, because recovered nested lineage records no per-task link.
 */
export function collectWorkerTreeBudgetSeeds(
	snapshot: WorkerTreeBudgetProjection,
	rootAgentId: string,
	treeTaskId: string,
): WorkerTreeBudgetSeed[] {
	const seeds: WorkerTreeBudgetSeed[] = [];
	for (const attempt of Object.values(snapshot.attempts)) {
		const attemptAgentId = nativeAgentIdForAttempt(attempt);
		if (!attemptAgentId || snapshot.agents[attemptAgentId]?.rootAgentId !== rootAgentId) continue;
		if (attemptAgentId === rootAgentId && attempt.taskId !== treeTaskId) continue;
		const usage = projectAttemptUsage(attempt, snapshot.checkpoints);
		seeds.push({ attemptId: attempt.attemptId, usage: usage ?? EMPTY_ATTEMPT_USAGE });
	}
	return seeds;
}

/**
 * An attempt's agent tree budget further bounded by the budget of the run it serves (see
 * `ParentExecutionPolicy.runCostBound`): both are checked before each provider request, both record the attempt's
 * usage, and a request holds a reservation in both. The attempt's own usage and token headroom stay the tree's.
 */
export function boundedByRunBudget(tree: SharedCapabilityBudget, run: SharedCapabilityBudget): SharedCapabilityBudget {
	return {
		assertBudgetAvailable: (subject) => {
			tree.assertBudgetAvailable(subject);
			run.assertBudgetAvailable(subject);
		},
		getAttemptUsage: () => tree.getAttemptUsage(),
		recordAttemptUsage: (usage, accounting) => {
			tree.recordAttemptUsage(usage, accounting);
			run.recordAttemptUsage(usage, accounting);
		},
		remainingTokens: () => tree.remainingTokens(),
		reserveProviderBudget: async (requestedMaxTokens, subject, signal, request) => {
			const treeReservation = await tree.reserveProviderBudget(requestedMaxTokens, subject, signal, request);
			let runReservation: ProviderBudgetReservation;
			try {
				runReservation = await run.reserveProviderBudget(treeReservation.maxTokens, subject, signal, request);
			} catch (error) {
				treeReservation.release();
				throw error;
			}
			return {
				maxTokens: Math.min(treeReservation.maxTokens, runReservation.maxTokens),
				release: () => {
					runReservation.release();
					treeReservation.release();
				},
			};
		},
	};
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new Error("Worker provider budget reservation was aborted.");
}

/**
 * A run's cost bound refused a request before it was sent (`budget_exhausted`, terminal: a retry would price the same
 * request against the same remainder).
 */
export class WorkerRunCostRefusal extends BoundedCompletionFailureError {
	constructor(reasonCode: "worker_run_model_unpriced" | "worker_run_cost_budget_exhausted", message: string) {
		super("budget_exhausted", reasonCode, message);
		this.name = "WorkerRunCostRefusal";
	}
}

/** One in-memory aggregate reconstructed from durable checkpoints whenever a tree is first used. */
export class WorkerTreeBudgetCoordinator {
	private readonly trees = new Map<string, TreeBudgetState>();

	/**
	 * `pricesRequests`: the aggregate bounds one run's real spend. Each provider request is priced before it is sent:
	 * an unpriced model is refused, a request whose input alone costs more than the remaining `maxCostUsd` is refused,
	 * and the granted output tokens are capped so input plus the whole output fits the remainder. A cost-bounded
	 * aggregate holds one reservation at a time, so the remainder is exact. Without it, `maxCostUsd` is checked against
	 * settled spend only, as it always was.
	 */
	createPort(args: {
		/** Identity of the aggregate: `workerTreeBudgetKey(task)` for a task's tree, a run id for a run's. */
		treeKey: string;
		attemptId: string;
		budget: RiskBudget;
		seeds: readonly WorkerTreeBudgetSeed[];
		initialUsage: AttemptUsageSnapshot;
		pricesRequests?: boolean;
	}): SharedCapabilityBudget {
		let state = this.trees.get(args.treeKey);
		if (!state) {
			state = {
				budget: structuredClone(args.budget),
				pricesRequests: args.pricesRequests === true,
				attempts: new Map(),
				generationUsage: new Map(),
				reservations: new Map(),
				waiters: [],
			};
			this.trees.set(args.treeKey, state);
		} else {
			state.budget = intersectRiskBudgets(state.budget, args.budget);
		}
		for (const seed of args.seeds) {
			state.attempts.set(
				seed.attemptId,
				reconcileAttemptUsage(state.attempts.get(seed.attemptId) ?? EMPTY_ATTEMPT_USAGE, seed.usage),
			);
		}
		state.attempts.set(
			args.attemptId,
			reconcileAttemptUsage(state.attempts.get(args.attemptId) ?? EMPTY_ATTEMPT_USAGE, args.initialUsage),
		);
		const tree = state;
		return {
			assertBudgetAvailable: (subject) => this.assertAvailable(tree, subject),
			getAttemptUsage: () => structuredClone(tree.attempts.get(args.attemptId) ?? EMPTY_ATTEMPT_USAGE),
			recordAttemptUsage: (usage, accounting) => this.recordAttemptUsage(tree, args.attemptId, usage, accounting),
			remainingTokens: () => {
				const maximum = tree.budget.maxTokens;
				return maximum === undefined
					? undefined
					: Math.max(0, maximum - this.budgetedTokens(tree) - this.reservedTokens(tree));
			},
			reserveProviderBudget: (requestedMaxTokens, subject, signal, request) =>
				this.reserveProviderBudget(tree, args.attemptId, requestedMaxTokens, subject, signal, request),
		};
	}

	private recordAttemptUsage(
		state: TreeBudgetState,
		attemptId: string,
		usage: GatewayUsageSnapshot,
		accounting?: AttemptUsageAccounting,
	): void {
		const previous = state.attempts.get(attemptId);
		const publication = attemptUsageFromGatewayUsage(usage);
		const attributed = accounting
			? reconcileAttemptUsageAccounting(state.generationUsage.get(attemptId), accounting)
			: undefined;
		// Anonymous recovery evidence is a floor, never another additive generation.
		const merged = reconcileAttemptUsage(
			previous ?? EMPTY_ATTEMPT_USAGE,
			attributed ? reconcileAttemptUsage(publication, attributed.total) : publication,
		);
		if (attributed) state.generationUsage.set(attemptId, attributed);
		state.attempts.set(attemptId, merged);
		const reservation = state.reservations.get(attemptId);
		if (reservation && previous) {
			reservation.maxTokens = Math.max(
				0,
				reservation.maxTokens - Math.max(0, budgetedTokens(merged) - budgetedTokens(previous)),
			);
		}
		// Shrinking a reservation to match actual (rather than speculatively requested) usage frees
		// tree token headroom the same way release() does — waiters parked on an earlier
		// availableTokens<=0 check must see it too, or they stay parked despite available budget.
		this.drainWaiters(state);
	}

	private reserveProviderBudget(
		state: TreeBudgetState,
		attemptId: string,
		requestedMaxTokens: number,
		subject: string,
		signal?: AbortSignal,
		request?: RequestPreflightContext,
	): Promise<ProviderBudgetReservation> {
		if (!Number.isSafeInteger(requestedMaxTokens) || requestedMaxTokens <= 0) {
			return Promise.reject(new Error("Worker provider token reservation must be a positive safe integer."));
		}
		if (signal?.aborted) return Promise.reject(abortReason(signal));
		return new Promise<ProviderBudgetReservation>((resolve, reject) => {
			const waiter: ProviderBudgetWaiter = {
				attemptId,
				requestedMaxTokens,
				subject,
				...(signal ? { signal } : {}),
				...(request ? { request } : {}),
				resolve,
				reject,
			};
			if (signal) {
				waiter.onAbort = () => {
					const index = state.waiters.indexOf(waiter);
					if (index < 0) return;
					state.waiters.splice(index, 1);
					reject(abortReason(signal));
					this.drainWaiters(state);
				};
				signal.addEventListener("abort", waiter.onAbort, { once: true });
			}
			state.waiters.push(waiter);
			this.drainWaiters(state);
		});
	}

	private drainWaiters(state: TreeBudgetState): void {
		while (state.waiters.length > 0) {
			const waiter = state.waiters[0];
			if (!waiter) return;
			try {
				this.assertAvailable(state, waiter.subject);
			} catch (error) {
				state.waiters.shift();
				this.detachAbort(waiter);
				waiter.reject(error);
				continue;
			}
			if (state.reservations.has(waiter.attemptId)) return;
			if (
				(state.budget.maxCostUsd !== undefined || state.budget.maxWallClockMs !== undefined) &&
				state.reservations.size > 0
			) {
				return;
			}
			const availableTokens =
				state.budget.maxTokens === undefined
					? waiter.requestedMaxTokens
					: Math.max(0, state.budget.maxTokens - this.budgetedTokens(state) - this.reservedTokens(state));
			if (availableTokens <= 0) return;
			let maxTokens = Math.min(waiter.requestedMaxTokens, availableTokens);
			if (state.pricesRequests && state.budget.maxCostUsd !== undefined) {
				let affordable: number;
				try {
					affordable = this.affordableOutputTokens(state, state.budget.maxCostUsd, waiter);
				} catch (error) {
					state.waiters.shift();
					this.detachAbort(waiter);
					waiter.reject(error);
					continue;
				}
				maxTokens = Math.min(maxTokens, affordable);
			}
			state.waiters.shift();
			this.detachAbort(waiter);
			const reservationState = { maxTokens };
			state.reservations.set(waiter.attemptId, reservationState);
			let released = false;
			waiter.resolve({
				maxTokens,
				release: () => {
					if (released) return;
					released = true;
					if (state.reservations.get(waiter.attemptId) === reservationState) {
						state.reservations.delete(waiter.attemptId);
					}
					this.drainWaiters(state);
				},
			});
		}
	}

	/**
	 * The most output tokens the request can be granted under the remaining cost bound; throws when it cannot be sent
	 * at all. Called with no other reservation held, so settled spend is the whole spend so far.
	 */
	private affordableOutputTokens(state: TreeBudgetState, maxCostUsd: number, waiter: ProviderBudgetWaiter): number {
		const request = waiter.request;
		if (!request)
			throw new WorkerRunCostRefusal(
				"worker_run_cost_budget_exhausted",
				`The run's cost bound cannot price ${waiter.subject}: the request was not offered for pricing.`,
			);
		if (request.model.costDefaulted)
			throw new WorkerRunCostRefusal(
				"worker_run_model_unpriced",
				`The run's cost bound cannot be enforced for ${request.model.provider}/${request.model.id}: the model has no declared price. A run with a cost bound needs a priced model.`,
			);
		const spentUsd = [...state.attempts.values()].reduce((total, usage) => total + usage.costUsd, 0);
		const remainingUsd = Math.max(0, maxCostUsd - spentUsd);
		const inputTokens = estimateProviderRequestTokens(request.context, request.model);
		const affordable = affordableOutputTokenLimit({
			inputTokens,
			maxOutputTokens: Math.min(request.maxTokens ?? request.model.maxTokens, request.model.maxTokens),
			cost: resolveModelCost(request.model, inputTokens),
			remainingUsd,
		});
		if (affordable < 1)
			throw new WorkerRunCostRefusal(
				"worker_run_cost_budget_exhausted",
				`The run's remaining cost bound ($${remainingUsd.toFixed(4)}) cannot cover ${waiter.subject}: its input alone (about ${inputTokens} tokens) costs more.`,
			);
		return affordable;
	}

	private detachAbort(waiter: ProviderBudgetWaiter): void {
		if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
	}

	private budgetedTokens(state: TreeBudgetState): number {
		return [...state.attempts.values()].reduce((total, usage) => total + budgetedTokens(usage), 0);
	}

	private reservedTokens(state: TreeBudgetState): number {
		return [...state.reservations.values()].reduce((total, reservation) => total + reservation.maxTokens, 0);
	}

	private assertAvailable(state: TreeBudgetState, subject: string): void {
		const usages = [...state.attempts.values()];
		if (state.budget.maxAttempts !== undefined && usages.length > state.budget.maxAttempts) {
			throw new WorkerTreeBudgetExceededError("maxAttempts", subject);
		}
		if (state.budget.maxTokens !== undefined && this.budgetedTokens(state) >= state.budget.maxTokens) {
			throw new WorkerTreeBudgetExceededError("maxTokens", subject);
		}
		if (
			state.budget.maxCostUsd !== undefined &&
			usages.reduce((total, usage) => total + usage.costUsd, 0) >= state.budget.maxCostUsd
		) {
			throw new WorkerTreeBudgetExceededError("maxCostUsd", subject);
		}
		if (
			state.budget.maxToolCalls !== undefined &&
			usages.reduce((total, usage) => total + usage.toolCalls, 0) >= state.budget.maxToolCalls
		) {
			throw new WorkerTreeBudgetExceededError("maxToolCalls", subject);
		}
		if (
			state.budget.maxWallClockMs !== undefined &&
			usages.reduce((total, usage) => total + usage.activeWallClockMs, 0) >= state.budget.maxWallClockMs
		) {
			throw new WorkerTreeBudgetExceededError("maxWallClockMs", subject);
		}
	}
}
