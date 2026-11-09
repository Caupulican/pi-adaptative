import { resolveModelCost } from "@caupulican/pi-ai/usage";
import type { RequestPreflightContext } from "../../kernel/loop-config.ts";
import { estimateProviderRequestTokens } from "../../kernel/provider-request-estimator.ts";
import { BoundedCompletionFailureError } from "../autonomy/bounded-completion.ts";
import { affordableOutputTokenLimit, estimateTurnCostUsd } from "../cost-guard.ts";
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
import {
	type BudgetRefusalReasons,
	costRefusalTokenFor,
	RUN_BUDGET_REFUSAL_REASONS,
	WORKER_TREE_BUDGET_REASON_CODES,
} from "./budget-reason-codes.ts";
import { WorkerRunCostRefusal } from "./worker-run-cost-refusal.ts";

export type WorkerTreeBudgetField = "maxTokens" | "maxCostUsd" | "maxToolCalls" | "maxWallClockMs" | "maxAttempts";

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

/** A granted reservation: the output tokens its request may still emit, and the dollar ceiling it still reserves. */
interface ReservationState {
	maxTokens: number;
	/** The worst case of the granted tokens not yet settled as usage; zero unless the aggregate prices requests. */
	reservedUsd: number;
}

/** A waiter's grant: its output tokens, and the dollar ceiling they reserve (zero when unpriced). */
interface ReservationGrant {
	readonly maxTokens: number;
	readonly reservedUsd: number;
}

interface TreeBudgetState {
	/** The aggregate's key. A cost refusal carries it as its typed `treeKey`, and names it in its message (`costRefusalTokenFor`). */
	treeKey: string;
	budget: RiskBudget;
	/** Each request is priced before it is sent, and its dollar ceiling is reserved while it runs (see `createPort`). */
	pricesRequests: boolean;
	refusalReasons: BudgetRefusalReasons;
	attempts: Map<string, AttemptUsageSnapshot>;
	generationUsage: Map<string, AttemptUsageAccounting>;
	/** One reservation per attempt: the attempt's request in flight. */
	reservations: Map<string, ReservationState>;
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
 * Whether the aggregate holds one reservation at a time. A wall-clock bound counts settled wall-clock only, and a cost
 * bound no request is priced against has no dollar ceiling to sum; a priced cost bound sums its reservations instead.
 */
function serializesReservations(state: TreeBudgetState): boolean {
	return state.budget.maxWallClockMs !== undefined || (state.budget.maxCostUsd !== undefined && !state.pricesRequests);
}

/** One in-memory aggregate reconstructed from durable checkpoints whenever a tree is first used. */
export class WorkerTreeBudgetCoordinator {
	private readonly trees = new Map<string, TreeBudgetState>();

	/**
	 * `pricesRequests`: the aggregate bounds real spend. Each provider request is priced before it is sent: an unpriced
	 * model is refused. A request is granted the output tokens that fit the remainder under `maxCostUsd`, where the
	 * remainder is `maxCostUsd - settled spend - sum(reserved dollar ceilings)`. Each granted reservation records the
	 * dollar ceiling of its tokens (the request's estimated input plus the granted output at the model's output price),
	 * so concurrent reservations are summed and their ceilings never add up past the bound. A request that cannot fit
	 * while other reservations are held waits, and is refused only when nothing is reserved. Without it, `maxCostUsd` is
	 * checked against settled spend only, and such a bound serializes its requests: with no dollar ceiling per
	 * reservation, one request cannot be bounded against another that is still running.
	 *
	 * `refusalReasons`: the codes a pricing refusal reports; absent, the run's codes.
	 */
	createPort(args: {
		/** Identity of the aggregate: `workerTreeBudgetKey(task)` for a task's tree, a run id for a run's. */
		treeKey: string;
		attemptId: string;
		budget: RiskBudget;
		seeds: readonly WorkerTreeBudgetSeed[];
		initialUsage: AttemptUsageSnapshot;
		pricesRequests?: boolean;
		refusalReasons?: BudgetRefusalReasons;
	}): SharedCapabilityBudget {
		let state = this.trees.get(args.treeKey);
		if (!state) {
			state = {
				treeKey: args.treeKey,
				budget: structuredClone(args.budget),
				pricesRequests: args.pricesRequests === true,
				refusalReasons: args.refusalReasons ?? RUN_BUDGET_REFUSAL_REASONS,
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
			// The cost this usage adds is settled spend now, so the reservation gives up the same dollars: a cost is
			// counted once, either as spend or as a reserved ceiling.
			reservation.reservedUsd = Math.max(
				0,
				reservation.reservedUsd - Math.max(0, merged.costUsd - previous.costUsd),
			);
		}
		// Shrinking a reservation to match actual (rather than speculatively requested) usage frees the tree token
		// headroom and the dollar ceiling the same way release() does — waiters parked on an earlier check must see it
		// too, or they stay parked despite available budget.
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

	/**
	 * Grants the waiters in arrival order while the aggregate has room, and never skips a waiter: the first one that must
	 * wait holds every later one. A waiter is refused (rejected) when the aggregate's own bound is spent, or when its request
	 * cannot be priced or cannot fit with nothing reserved. Every release and every shrink to actual usage drains again.
	 */
	private drainWaiters(state: TreeBudgetState): void {
		while (state.waiters.length > 0) {
			const waiter = state.waiters[0];
			if (!waiter) return;
			try {
				this.assertAvailable(state, waiter.subject);
			} catch (error) {
				this.refuseHeadWaiter(state, waiter, error);
				continue;
			}
			if (state.reservations.has(waiter.attemptId)) return;
			if (serializesReservations(state) && state.reservations.size > 0) return;
			const availableTokens =
				state.budget.maxTokens === undefined
					? waiter.requestedMaxTokens
					: Math.max(0, state.budget.maxTokens - this.budgetedTokens(state) - this.reservedTokens(state));
			if (availableTokens <= 0) return;
			let grant: ReservationGrant | undefined;
			try {
				grant = this.grantReservation(state, waiter, availableTokens);
			} catch (error) {
				this.refuseHeadWaiter(state, waiter, error);
				continue;
			}
			if (!grant) return;
			state.waiters.shift();
			this.detachAbort(waiter);
			const reservationState: ReservationState = { maxTokens: grant.maxTokens, reservedUsd: grant.reservedUsd };
			state.reservations.set(waiter.attemptId, reservationState);
			let released = false;
			waiter.resolve({
				maxTokens: grant.maxTokens,
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

	private refuseHeadWaiter(state: TreeBudgetState, waiter: ProviderBudgetWaiter, error: unknown): void {
		state.waiters.shift();
		this.detachAbort(waiter);
		waiter.reject(error);
	}

	/**
	 * The grant of one waiter's request. Without a priced cost bound the grant is the requested tokens within the token
	 * headroom. Under a priced cost bound the request is priced: its output tokens are capped so that the estimated input
	 * plus the granted output fits the remainder `maxCostUsd - settled spend - sum(reserved ceilings)`, and the grant
	 * reserves that worst case. Undefined parks the waiter when nothing is affordable while a reservation is held: that
	 * reservation settles or shrinks, and the aggregate drains again. Throws the refusal of a request that was not offered
	 * for pricing, of an unpriced model, and of a request whose input cannot fit when nothing is reserved.
	 */
	private grantReservation(
		state: TreeBudgetState,
		waiter: ProviderBudgetWaiter,
		availableTokens: number,
	): ReservationGrant | undefined {
		const requestedTokens = Math.min(waiter.requestedMaxTokens, availableTokens);
		const maxCostUsd = state.budget.maxCostUsd;
		if (!state.pricesRequests || maxCostUsd === undefined) return { maxTokens: requestedTokens, reservedUsd: 0 };
		const request = waiter.request;
		const reasons = state.refusalReasons;
		const token = costRefusalTokenFor(state.treeKey);
		if (!request)
			throw new WorkerRunCostRefusal(
				state.treeKey,
				reasons.exhausted,
				`The cost bound ${token} cannot price ${waiter.subject}: the request was not offered for pricing.`,
			);
		if (request.model.costDefaulted)
			throw new WorkerRunCostRefusal(
				state.treeKey,
				reasons.unpriced,
				`The cost bound ${token} cannot be enforced for ${request.model.provider}/${request.model.id}: the model has no declared price. A cost bound needs a priced model.`,
			);
		const spentUsd = [...state.attempts.values()].reduce((total, usage) => total + usage.costUsd, 0);
		const remainingUsd = Math.max(0, maxCostUsd - spentUsd - this.reservedCostUsd(state));
		const inputTokens = estimateProviderRequestTokens(request.context, request.model);
		const cost = resolveModelCost(request.model, inputTokens);
		const affordable = affordableOutputTokenLimit({
			inputTokens,
			maxOutputTokens: Math.min(request.maxTokens ?? request.model.maxTokens, request.model.maxTokens),
			cost,
			remainingUsd,
		});
		if (affordable < 1) {
			if (state.reservations.size > 0) return undefined;
			throw new WorkerRunCostRefusal(
				state.treeKey,
				reasons.exhausted,
				`The remaining cost bound ${token} ($${remainingUsd.toFixed(4)}) cannot cover ${waiter.subject}: its input alone (about ${inputTokens} tokens) costs more.`,
			);
		}
		const maxTokens = Math.min(requestedTokens, affordable);
		return { maxTokens, reservedUsd: estimateTurnCostUsd({ inputTokens, maxOutputTokens: maxTokens, cost }) };
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

	private reservedCostUsd(state: TreeBudgetState): number {
		return [...state.reservations.values()].reduce((total, reservation) => total + reservation.reservedUsd, 0);
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
