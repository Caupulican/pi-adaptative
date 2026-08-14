import { describe, expect, it, vi } from "vitest";
import {
	collectWorkerTreeBudgetSeeds,
	WorkerTreeBudgetCoordinator,
	type WorkerTreeBudgetExceededError,
	workerTreeCanAdmitAttempt,
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
	it("refuses a new attempt when the tree already holds the maxAttempts ceiling", () => {
		expect(workerTreeCanAdmitAttempt(0, undefined)).toBe(true);
		expect(workerTreeCanAdmitAttempt(1, 1)).toBe(false);
		expect(workerTreeCanAdmitAttempt(1, 2)).toBe(true);
		expect(workerTreeCanAdmitAttempt(2, 2)).toBe(false);
	});

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

	it("reconciles cumulative components while shrinking reservations by weighted token spend", async () => {
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
		const firstReservation = await first.reserveProviderBudget(80, "first provider request");

		first.recordAttemptUsage({
			toolCalls: 0,
			inputTokens: 10,
			outputTokens: 0,
			cacheReadTokens: 20,
			cacheWriteTokens: 0,
			totalTokens: 30,
			costUsd: 0,
			wallClockMs: 0,
		});
		first.recordAttemptUsage({
			toolCalls: 0,
			inputTokens: 0,
			outputTokens: 5,
			cacheReadTokens: 10,
			cacheWriteTokens: 0,
			totalTokens: 15,
			costUsd: 0,
			wallClockMs: 0,
		});

		const secondReservation = await second.reserveProviderBudget(100, "second provider request");
		expect(secondReservation.maxTokens).toBe(20);
		firstReservation.release();
		secondReservation.release();
		expect(second.remainingTokens()).toBe(83);
		const weightedReservation = await second.reserveProviderBudget(100, "weighted provider request");
		expect(weightedReservation.maxTokens).toBe(83);
		weightedReservation.release();
	});

	it("re-checks parked waiters after recordAttemptUsage, not only after an explicit release()", async () => {
		// Root-cause regression: recordAttemptUsage shrinks a reservation (frees tree headroom) the
		// same way release() does, but only release() used to call drainWaiters() — a waiter parked
		// on an earlier availableTokens<=0 check stayed parked until some UNRELATED event (a new
		// reserveProviderBudget call, or a different attempt's release()) happened to re-check it.
		// This pins the mechanical fix: drainWaiters() must fire from inside recordAttemptUsage too.
		const drainWaitersSpy = vi.spyOn(
			WorkerTreeBudgetCoordinator.prototype as unknown as { drainWaiters(...args: unknown[]): void },
			"drainWaiters",
		);
		const coordinator = new WorkerTreeBudgetCoordinator();
		const port = coordinator.createPort({
			rootAgentId: "root-recheck",
			attemptId: "attempt-recheck",
			budget: { maxTokens: 100 },
			seeds: [],
			initialUsage: usage(),
		});
		const callsBeforeUsage = drainWaitersSpy.mock.calls.length;

		port.recordAttemptUsage({
			toolCalls: 0,
			inputTokens: 10,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 10,
			costUsd: 0,
			wallClockMs: 0,
		});

		expect(drainWaitersSpy.mock.calls.length).toBeGreaterThan(callsBeforeUsage);
		drainWaitersSpy.mockRestore();
	});

	it("rejects a descendant reservation after durable root usage exhausts the tree token budget", async () => {
		const coordinator = new WorkerTreeBudgetCoordinator();
		const exhaustedRootUsage = usage({ inputTokens: 60, outputTokens: 40, totalTokens: 100 });
		coordinator.createPort({
			rootAgentId: "root",
			attemptId: "attempt-root",
			budget: { maxTokens: 100 },
			seeds: [{ attemptId: "attempt-root", usage: exhaustedRootUsage }],
			initialUsage: exhaustedRootUsage,
		});
		const child = coordinator.createPort({
			rootAgentId: "root",
			attemptId: "attempt-child",
			budget: { maxTokens: 100 },
			seeds: [{ attemptId: "attempt-root", usage: exhaustedRootUsage }],
			initialUsage: usage(),
		});

		expect(child.remainingTokens()).toBe(0);
		await expect(child.reserveProviderBudget(1, "child provider request")).rejects.toMatchObject({
			field: "maxTokens",
			status: "budget_exhausted",
			reasonCode: "worker_tree_token_budget_exhausted",
		} satisfies Partial<WorkerTreeBudgetExceededError>);
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
		["maxCostUsd", { maxCostUsd: 1 }, usage({ costUsd: 1 }), "worker_tree_cost_budget_exhausted"],
		["maxToolCalls", { maxToolCalls: 2 }, usage({ toolCalls: 2 }), "worker_tree_tool_call_budget_exhausted"],
		[
			"maxWallClockMs",
			{ maxWallClockMs: 50 },
			usage({ activeWallClockMs: 50 }),
			"worker_tree_wall_clock_budget_exhausted",
		],
	] as const)("enforces cumulative %s across the tree", (field, budget, spent, reasonCode) => {
		const port = new WorkerTreeBudgetCoordinator().createPort({
			rootAgentId: "root",
			attemptId: "attempt-root",
			budget,
			seeds: [],
			initialUsage: spent,
		});

		expect(() => port.assertBudgetAvailable("provider request")).toThrowError(
			expect.objectContaining<Partial<WorkerTreeBudgetExceededError>>({
				field,
				status: "budget_exhausted",
				reasonCode,
			}),
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
			expect.objectContaining<Partial<WorkerTreeBudgetExceededError>>({
				field: "maxAttempts",
				status: "budget_exhausted",
				reasonCode: "worker_tree_attempt_budget_exhausted",
			}),
		);
	});
});
