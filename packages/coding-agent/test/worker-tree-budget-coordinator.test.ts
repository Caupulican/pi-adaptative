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
			seeds: [{ attemptId: "attempt-root", usage: usage() }],
			initialUsage: usage(),
		});
		expect(child.remainingTokens()).toBe(30);
	});

	it("reserves one cumulative token remainder across concurrent provider requests", async () => {
		const coordinator = new WorkerTreeBudgetCoordinator();
		const first = coordinator.createPort({
			rootAgentId: "root",
			attemptId: "attempt-first",
			budget: { maxTokens: 100 },
			seeds: [],
			initialUsage: usage(),
		});
		const second = coordinator.createPort({
			rootAgentId: "root",
			attemptId: "attempt-second",
			budget: { maxTokens: 100 },
			seeds: [],
			initialUsage: usage(),
		});

		const firstReservation = await first.reserveProviderBudget(100, "first provider request");
		let secondSettled = false;
		const secondReservation = second.reserveProviderBudget(100, "second provider request").then((reservation) => {
			secondSettled = true;
			return reservation;
		});
		await Promise.resolve();
		expect(secondSettled).toBe(false);

		first.recordAttemptUsage({
			toolCalls: 0,
			inputTokens: 60,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 60,
			costUsd: 0,
			wallClockMs: 0,
		});
		firstReservation.release();
		const admittedSecond = await secondReservation;
		expect(admittedSecond.maxTokens).toBe(40);
		admittedSecond.release();
	});

	it("serializes concurrent provider requests when cost is a cumulative unknown", async () => {
		const coordinator = new WorkerTreeBudgetCoordinator();
		const first = coordinator.createPort({
			rootAgentId: "root",
			attemptId: "attempt-first",
			budget: { maxCostUsd: 1 },
			seeds: [],
			initialUsage: usage(),
		});
		const second = coordinator.createPort({
			rootAgentId: "root",
			attemptId: "attempt-second",
			budget: { maxCostUsd: 1 },
			seeds: [],
			initialUsage: usage(),
		});

		const firstReservation = await first.reserveProviderBudget(10, "first provider request");
		let secondSettled = false;
		const secondReservation = second.reserveProviderBudget(10, "second provider request").then((reservation) => {
			secondSettled = true;
			return reservation;
		});
		await Promise.resolve();
		expect(secondSettled).toBe(false);

		firstReservation.release();
		const admittedSecond = await secondReservation;
		expect(admittedSecond.maxTokens).toBe(10);
		admittedSecond.release();
	});

	it("does not strand an eligible provider request behind an aborted same-attempt waiter", async () => {
		const coordinator = new WorkerTreeBudgetCoordinator();
		const first = coordinator.createPort({
			rootAgentId: "root",
			attemptId: "attempt-first",
			budget: { maxTokens: 100 },
			seeds: [],
			initialUsage: usage(),
		});
		const second = coordinator.createPort({
			rootAgentId: "root",
			attemptId: "attempt-second",
			budget: { maxTokens: 100 },
			seeds: [],
			initialUsage: usage(),
		});

		const firstReservation = await first.reserveProviderBudget(40, "first provider request");
		const abort = new AbortController();
		const blockedSameAttempt = first.reserveProviderBudget(10, "replayed first request", abort.signal);
		let secondSettled = false;
		const secondReservation = second.reserveProviderBudget(60, "second provider request").then((reservation) => {
			secondSettled = true;
			return reservation;
		});
		try {
			abort.abort(new Error("cancelled replay"));
			await expect(blockedSameAttempt).rejects.toThrow("cancelled replay");
			await Promise.resolve();
			expect(secondSettled).toBe(true);
		} finally {
			firstReservation.release();
			const admittedSecond = await secondReservation;
			admittedSecond.release();
		}
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
