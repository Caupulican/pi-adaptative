import { describe, expect, it } from "vitest";
import {
	collectWorkerTreeBudgetSeeds,
	WorkerTreeBudgetCoordinator,
	type WorkerTreeBudgetExceededError,
} from "../src/core/delegation/worker-tree-budget-coordinator.ts";
import type { AttemptUsageSnapshot } from "../src/core/orchestration/contracts.ts";

function usage(overrides: Partial<AttemptUsageSnapshot> = {}): AttemptUsageSnapshot {
	return {
		toolCalls: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
		costUsd: 0,
		activeWallClockMs: 0,
		...overrides,
	};
}

describe("WorkerTreeBudgetCoordinator", () => {
	it("reconstructs attempts that ended before their first durable usage checkpoint", () => {
		expect(
			collectWorkerTreeBudgetSeeds(
				{
					agents: {
						root: { rootAgentId: "root" },
						child: { rootAgentId: "root" },
						other: { rootAgentId: "other" },
					},
					attempts: {
						"attempt-root": { attemptId: "attempt-root", agentId: "root", dispatch: {}, checkpointIds: [] },
						"attempt-child": {
							attemptId: "attempt-child",
							agentId: "child",
							dispatch: {},
							checkpointIds: ["checkpoint-child"],
						},
						"attempt-other": {
							attemptId: "attempt-other",
							agentId: "other",
							dispatch: {},
							checkpointIds: [],
						},
					},
					checkpoints: { "checkpoint-child": { usage: usage({ totalTokens: 12 }) } },
				},
				"root",
			),
		).toEqual([
			{ attemptId: "attempt-root", usage: usage() },
			{ attemptId: "attempt-child", usage: usage({ totalTokens: 12 }) },
		]);
	});

	it("replaces cumulative attempt snapshots without double-counting durable replay", () => {
		const coordinator = new WorkerTreeBudgetCoordinator();
		const rootUsage = usage({ totalTokens: 60 });
		const root = coordinator.createPort({
			rootAgentId: "root",
			attemptId: "attempt-root",
			budget: { maxTokens: 100 },
			seeds: [{ attemptId: "attempt-root", usage: rootUsage }],
			initialUsage: rootUsage,
		});

		expect(root.remainingTokens()).toBe(40);
		root.recordAttemptUsage({
			toolCalls: 0,
			inputTokens: 0,
			outputTokens: 70,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 70,
			costUsd: 0,
			wallClockMs: 0,
		});
		expect(root.remainingTokens()).toBe(30);

		const child = coordinator.createPort({
			rootAgentId: "root",
			attemptId: "attempt-child",
			budget: { maxTokens: 100 },
			seeds: [{ attemptId: "attempt-root", usage: usage({ totalTokens: 70 }) }],
			initialUsage: usage(),
		});
		expect(child.remainingTokens()).toBe(30);
	});

	it.each([
		["maxCostUsd", { maxCostUsd: 1 }, usage({ costUsd: 1 })],
		["maxToolCalls", { maxToolCalls: 2 }, usage({ toolCalls: 2 })],
		["maxWallClockMs", { maxWallClockMs: 50 }, usage({ activeWallClockMs: 50 })],
	] as const)("enforces cumulative %s across the tree", (field, budget, spent) => {
		const port = new WorkerTreeBudgetCoordinator().createPort({
			rootAgentId: "root",
			attemptId: "attempt-root",
			budget,
			seeds: [],
			initialUsage: spent,
		});

		expect(() => port.assertBudgetAvailable("provider request")).toThrowError(
			expect.objectContaining<Partial<WorkerTreeBudgetExceededError>>({ field }),
		);
	});

	it("counts attempts globally while allowing the admitted final attempt to run", () => {
		const coordinator = new WorkerTreeBudgetCoordinator();
		coordinator.createPort({
			rootAgentId: "root",
			attemptId: "attempt-root",
			budget: { maxAttempts: 1 },
			seeds: [],
			initialUsage: usage(),
		});
		const child = coordinator.createPort({
			rootAgentId: "root",
			attemptId: "attempt-child",
			budget: { maxAttempts: 1 },
			seeds: [],
			initialUsage: usage(),
		});

		expect(() => child.assertBudgetAvailable("provider request")).toThrowError(
			expect.objectContaining<Partial<WorkerTreeBudgetExceededError>>({ field: "maxAttempts" }),
		);
	});
});
