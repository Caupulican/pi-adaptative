import { BoundedCompletionFailureError } from "../autonomy/bounded-completion.ts";
import {
	attemptUsageFromGatewayUsage,
	EMPTY_ATTEMPT_USAGE,
	reconcileAttemptUsage,
} from "../orchestration/attempt-usage.ts";
import {
	budgetedTokens,
	type GatewayUsageSnapshot,
	type ProviderBudgetReservation,
	type SharedCapabilityBudget,
} from "../orchestration/capability-gateway.ts";
import type { AttemptUsageSnapshot, RiskBudget } from "../orchestration/contracts.ts";
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
	attempts: Map<string, AttemptUsageSnapshot>;
	reservations: Map<string, { maxTokens: number }>;
	waiters: ProviderBudgetWaiter[];
}

interface ProviderBudgetWaiter {
	attemptId: string;
	requestedMaxTokens: number;
	subject: string;
	signal?: AbortSignal;
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
				agentId?: string;
				dispatch: { logicalLaneId?: string };
				checkpointIds: readonly string[];
			}
		>
	>;
	checkpoints: Readonly<Record<string, { usage?: AttemptUsageSnapshot }>>;
}

/** Rebuild every durable tree attempt, including attempts with no usage checkpoint yet. */
export function collectWorkerTreeBudgetSeeds(
	snapshot: WorkerTreeBudgetProjection,
	rootAgentId: string,
): WorkerTreeBudgetSeed[] {
	const seeds: WorkerTreeBudgetSeed[] = [];
	for (const attempt of Object.values(snapshot.attempts)) {
		const attemptAgentId = attempt.agentId ?? attempt.dispatch.logicalLaneId;
		if (!attemptAgentId || snapshot.agents[attemptAgentId]?.rootAgentId !== rootAgentId) continue;
		const usage = [...attempt.checkpointIds]
			.reverse()
			.map((checkpointId) => snapshot.checkpoints[checkpointId]?.usage)
			.find((candidate): candidate is AttemptUsageSnapshot => candidate !== undefined);
		seeds.push({ attemptId: attempt.attemptId, usage: usage ?? EMPTY_ATTEMPT_USAGE });
	}
	return seeds;
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new Error("Worker provider budget reservation was aborted.");
}

/** One in-memory aggregate reconstructed from durable checkpoints whenever a root is first used. */
export class WorkerTreeBudgetCoordinator {
	private readonly trees = new Map<string, TreeBudgetState>();

	createPort(args: {
		rootAgentId: string;
		attemptId: string;
		budget: RiskBudget;
		seeds: readonly WorkerTreeBudgetSeed[];
		initialUsage: AttemptUsageSnapshot;
	}): SharedCapabilityBudget {
		let state = this.trees.get(args.rootAgentId);
		if (!state) {
			state = { budget: structuredClone(args.budget), attempts: new Map(), reservations: new Map(), waiters: [] };
			this.trees.set(args.rootAgentId, state);
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
			recordAttemptUsage: (usage) => this.recordAttemptUsage(tree, args.attemptId, usage),
			remainingTokens: () => {
				const maximum = tree.budget.maxTokens;
				return maximum === undefined
					? undefined
					: Math.max(0, maximum - this.budgetedTokens(tree) - this.reservedTokens(tree));
			},
			reserveProviderBudget: (requestedMaxTokens, subject, signal) =>
				this.reserveProviderBudget(tree, args.attemptId, requestedMaxTokens, subject, signal),
		};
	}

	private recordAttemptUsage(state: TreeBudgetState, attemptId: string, usage: GatewayUsageSnapshot): void {
		const previous = state.attempts.get(attemptId);
		const merged = reconcileAttemptUsage(previous ?? EMPTY_ATTEMPT_USAGE, attemptUsageFromGatewayUsage(usage));
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
			const maxTokens = Math.min(waiter.requestedMaxTokens, availableTokens);
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
