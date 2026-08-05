import type { GatewayUsageSnapshot, SharedCapabilityBudget } from "../orchestration/capability-gateway.ts";
import type { AttemptUsageSnapshot, RiskBudget } from "../orchestration/contracts.ts";
import { intersectRiskBudgets } from "../orchestration/risk-budget.ts";

export class WorkerTreeBudgetExceededError extends Error {
	readonly field: "maxTokens" | "maxCostUsd" | "maxToolCalls" | "maxWallClockMs" | "maxAttempts";

	constructor(field: WorkerTreeBudgetExceededError["field"], subject: string) {
		super(`Worker orchestration tree budget '${field}' is exhausted before ${subject}.`);
		this.name = "WorkerTreeBudgetExceededError";
		this.field = field;
	}
}

interface TreeBudgetState {
	budget: RiskBudget;
	attempts: Map<string, GatewayUsageSnapshot>;
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

const EMPTY_ATTEMPT_USAGE: AttemptUsageSnapshot = {
	toolCalls: 0,
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalTokens: 0,
	costUsd: 0,
	activeWallClockMs: 0,
};

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

function gatewayUsage(usage: AttemptUsageSnapshot): GatewayUsageSnapshot {
	return {
		toolCalls: usage.toolCalls,
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		cacheReadTokens: usage.cacheReadTokens,
		cacheWriteTokens: usage.cacheWriteTokens,
		totalTokens: usage.totalTokens,
		costUsd: usage.costUsd,
		wallClockMs: usage.activeWallClockMs,
	};
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
			state = { budget: structuredClone(args.budget), attempts: new Map() };
			this.trees.set(args.rootAgentId, state);
		} else {
			state.budget = intersectRiskBudgets(state.budget, args.budget);
		}
		for (const seed of args.seeds) state.attempts.set(seed.attemptId, gatewayUsage(seed.usage));
		state.attempts.set(args.attemptId, gatewayUsage(args.initialUsage));
		const tree = state;
		return {
			assertBudgetAvailable: (subject) => this.assertAvailable(tree, subject),
			recordAttemptUsage: (usage) => tree.attempts.set(args.attemptId, structuredClone(usage)),
			remainingTokens: () => {
				const maximum = tree.budget.maxTokens;
				return maximum === undefined ? undefined : Math.max(0, maximum - this.totalTokens(tree));
			},
		};
	}

	private totalTokens(state: TreeBudgetState): number {
		return [...state.attempts.values()].reduce((total, usage) => total + usage.totalTokens, 0);
	}

	private assertAvailable(state: TreeBudgetState, subject: string): void {
		const usages = [...state.attempts.values()];
		if (state.budget.maxAttempts !== undefined && usages.length > state.budget.maxAttempts) {
			throw new WorkerTreeBudgetExceededError("maxAttempts", subject);
		}
		if (state.budget.maxTokens !== undefined && this.totalTokens(state) >= state.budget.maxTokens) {
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
			usages.reduce((total, usage) => total + usage.wallClockMs, 0) >= state.budget.maxWallClockMs
		) {
			throw new WorkerTreeBudgetExceededError("maxWallClockMs", subject);
		}
	}
}
