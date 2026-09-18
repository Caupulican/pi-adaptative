import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerTreeBudgetCoordinator } from "../src/core/delegation/worker-tree-budget-coordinator.ts";
import { WorkerUsageAccounting } from "../src/core/delegation/worker-usage-accounting.ts";
import { EMPTY_ATTEMPT_USAGE } from "../src/core/orchestration/attempt-usage.ts";
import {
	beginAttemptUsageGeneration,
	recordAttemptGenerationUsage,
} from "../src/core/orchestration/attempt-usage-generations.ts";
import { CapabilityGateway } from "../src/core/orchestration/capability-gateway.ts";
import type { AttemptUsageSnapshot } from "../src/core/orchestration/contracts.ts";
import { createTestExecutionGrant } from "./orchestration-profile-fixture.ts";

const tokens = (totalTokens: number) => ({ ...EMPTY_ATTEMPT_USAGE, inputTokens: totalTokens, totalTokens });

function fixture() {
	const old = { leaseId: "old", fencingToken: 1 };
	const identity = { leaseId: "current", fencingToken: 2 };
	let accounting = beginAttemptUsageGeneration(undefined, old, tokens(0));
	accounting = beginAttemptUsageGeneration(accounting, identity);
	const persist = (usage: AttemptUsageSnapshot) => {
		accounting = recordAttemptGenerationUsage(accounting, identity, usage);
	};
	const record = vi.fn(persist);
	const warn = vi.fn();
	const afterRecord = vi.fn();
	const owner = new WorkerUsageAccounting({
		port: {
			identity,
			baseline: tokens(0),
			read: () => accounting,
			record,
		},
		warn,
		afterRecord,
		label: "worker fixture",
	});
	return {
		owner,
		record,
		warn,
		afterRecord,
		persist,
		snapshot: () => accounting,
		late: (usage: AttemptUsageSnapshot) => {
			accounting = recordAttemptGenerationUsage(accounting, old, usage);
		},
	};
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe("worker usage persistence lifetime", () => {
	it.each([false, true])("retries without another caller after a failed write, committed=%s", (committed) => {
		const { owner, record, persist, snapshot, warn } = fixture();
		const failure = new Error("storage unavailable");
		record.mockImplementationOnce((usage) => {
			if (committed) persist(usage);
			throw failure;
		});
		expect(() => owner.record(tokens(10))).toThrow(failure);
		expect(warn).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(250);
		expect(snapshot().total.totalTokens).toBe(10);
		expect(record.mock.calls).toEqual([[tokens(10)], [tokens(10)]]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("retains only the latest cumulative report and never copies a foreign generation correction", () => {
		const { owner, record, persist, late, snapshot } = fixture();
		record.mockImplementation(() => {
			throw new Error("storage unavailable");
		});
		const usage = tokens(10);
		expect(() => owner.record(usage)).toThrow();
		usage.inputTokens = usage.totalTokens = 900;
		expect(() => owner.record(tokens(20))).toThrow();
		late(tokens(50));
		record.mockImplementation(persist);
		vi.advanceTimersByTime(250);
		expect(record.mock.lastCall).toEqual([tokens(20)]);
		expect(snapshot().generations.current.reported).toEqual(tokens(20));
		expect(snapshot().total).toEqual(tokens(70));
		expect(vi.getTimerCount()).toBe(0);
	});

	it("invalid or decreasing reports cannot erase a pending valid report", () => {
		const { owner, record, persist, snapshot } = fixture();
		record.mockImplementationOnce(() => {
			throw new Error("storage unavailable");
		});
		expect(() => owner.record(tokens(10))).toThrow();
		expect(() => owner.record(tokens(9))).toThrow("decrease");
		expect(() => owner.record(tokens(Number.NaN))).toThrow();
		expect(record).toHaveBeenCalledOnce();
		record.mockImplementation(persist);
		vi.advanceTimersByTime(250);
		expect(snapshot().total).toEqual(tokens(10));
	});

	it("a successful caller write cancels the pending retry", () => {
		const { owner, record } = fixture();
		record.mockImplementationOnce(() => {
			throw new Error("storage unavailable");
		});
		expect(() => owner.record(tokens(10))).toThrow();
		owner.record(tokens(20));
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(60_000);
		expect(record).toHaveBeenCalledTimes(2);
	});

	it("repeated storage and diagnostic failures retain one backed-off retry until persistence succeeds", () => {
		const { owner, record, warn, persist, snapshot } = fixture();
		record.mockImplementation(() => {
			throw new Error("storage unavailable");
		});
		warn.mockImplementation(() => {
			throw new Error("diagnostics unavailable");
		});
		expect(() => owner.record(tokens(10))).toThrow("storage unavailable");
		for (const delay of [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
			const before = record.mock.calls.length;
			vi.advanceTimersByTime(delay - 1);
			expect(record).toHaveBeenCalledTimes(before);
			vi.advanceTimersByTime(1);
			expect(record).toHaveBeenCalledTimes(before + 1);
			expect(vi.getTimerCount()).toBe(1);
		}
		record.mockImplementation(persist);
		vi.advanceTimersByTime(30_000);
		expect(snapshot().total).toEqual(tokens(10));
		expect(vi.getTimerCount()).toBe(0);
	});

	it("ordinary persistence requires no timer or warning", () => {
		const { owner, record, warn } = fixture();
		owner.record(tokens(10));
		expect(owner.read().generations.current.reported).toEqual(tokens(10));
		expect(record).toHaveBeenCalledOnce();
		expect(warn).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("a failed retry publication remains retryable without charging its committed receipt twice", () => {
		const { owner, record, afterRecord, snapshot } = fixture();
		record.mockImplementationOnce(() => {
			throw new Error("storage unavailable");
		});
		afterRecord.mockImplementationOnce(() => {
			throw new Error("budget publication unavailable");
		});
		expect(() => owner.record(tokens(10))).toThrow();
		vi.advanceTimersByTime(250);
		expect(snapshot().total).toEqual(tokens(10));
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(500);
		expect(snapshot().total).toEqual(tokens(10));
		expect(afterRecord).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("publishes a background retry to already-existing sibling tree budgets", () => {
		const coordinator = new WorkerTreeBudgetCoordinator();
		const budget = { maxTokens: 100 };
		const shared = coordinator.createPort({
			rootAgentId: "root",
			attemptId: "attempt",
			budget,
			seeds: [],
			initialUsage: tokens(0),
		});
		const sibling = coordinator.createPort({
			rootAgentId: "root",
			attemptId: "sibling",
			budget,
			seeds: [],
			initialUsage: tokens(0),
		});
		const gateway = new CapabilityGateway({
			grant: createTestExecutionGrant({ objectiveId: "objective", taskId: "task", attemptId: "attempt" }),
			cwd: process.cwd(),
			now: () => 100,
			sharedBudget: shared,
		});
		const identity = { leaseId: "lease", fencingToken: 1 };
		let persisted = beginAttemptUsageGeneration(undefined, identity, tokens(0));
		const record = vi.fn((usage: AttemptUsageSnapshot) => {
			persisted = recordAttemptGenerationUsage(persisted, identity, usage);
		});
		gateway.bindUsageAccounting(
			new WorkerUsageAccounting({
				port: { identity, baseline: tokens(0), read: () => persisted, record },
				warn: vi.fn(),
				label: "worker fixture",
				afterRecord: () => gateway.publishUsage(),
			}),
		);
		record.mockImplementationOnce(() => {
			throw new Error("storage unavailable");
		});
		gateway.recordUsage({ inputTokens: 20 });
		gateway.stopUsageClock();
		expect(() => gateway.flushUsage()).toThrow("storage unavailable");
		// Siblings must see received usage even while its durable write is pending.
		expect(sibling.remainingTokens()).toBe(80);
		vi.advanceTimersByTime(250);
		expect(persisted.total.totalTokens).toBe(20);
		expect(sibling.remainingTokens()).toBe(80);
		expect(record).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("retains a successful first write when its initial publication fails", () => {
		const { owner, afterRecord, record, snapshot } = fixture();
		afterRecord.mockImplementationOnce(() => {
			throw new Error("publication unavailable");
		});
		expect(() => owner.record(tokens(10))).toThrow("publication unavailable");
		expect(snapshot().total).toEqual(tokens(10));
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(250);
		expect(snapshot().total).toEqual(tokens(10));
		expect(afterRecord).toHaveBeenCalledTimes(2);
		expect(record).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([false, true])("keeps old-generation pending usage when a resumed worker publishes: failed=%s", (failed) => {
		const coordinator = new WorkerTreeBudgetCoordinator();
		const budget = { maxTokens: 100 };
		const old = { leaseId: "old", fencingToken: 1 };
		const resumed = { leaseId: "resumed", fencingToken: 2 };
		let accounting = beginAttemptUsageGeneration(undefined, old, tokens(0));
		const sibling = coordinator.createPort({
			rootAgentId: "root",
			attemptId: "sibling",
			budget,
			seeds: [],
			initialUsage: tokens(0),
		});
		const oldRecord = vi.fn((usage: AttemptUsageSnapshot) => {
			accounting = recordAttemptGenerationUsage(accounting, old, usage);
		});
		const createGateway = (
			identity: typeof old,
			record: (usage: AttemptUsageSnapshot) => void,
		): CapabilityGateway => {
			const shared = coordinator.createPort({
				rootAgentId: "root",
				attemptId: "same-attempt",
				budget,
				seeds: [],
				initialUsage: accounting.total,
			});
			const gateway = new CapabilityGateway({
				grant: {
					...createTestExecutionGrant({ objectiveId: "o", taskId: "t", attemptId: "same-attempt" }),
					budget: { maxTokens: 30 },
				},
				cwd: process.cwd(),
				now: () => 100,
				sharedBudget: shared,
			});
			gateway.bindUsageAccounting(
				new WorkerUsageAccounting({
					port: {
						identity,
						baseline: accounting.generations[identity.leaseId].baseline,
						read: () => accounting,
						record,
					},
					warn: vi.fn(),
					label: identity.leaseId,
					afterRecord: () => gateway.publishUsage(),
				}),
			);
			return gateway;
		};
		const first = createGateway(old, oldRecord);
		if (failed)
			oldRecord.mockImplementationOnce(() => {
				throw new Error("old generation receipt write failed");
			});
		first.recordUsage({ inputTokens: 10 });
		first.stopUsageClock();
		if (failed) expect(() => first.flushUsage()).toThrow("old generation receipt write failed");
		else first.flushUsage();
		expect(sibling.remainingTokens()).toBe(90);
		// Resume initializes from durable totals, which exclude the old pending receipt on failure.
		accounting = beginAttemptUsageGeneration(accounting, resumed);
		const second = createGateway(resumed, (usage) => {
			accounting = recordAttemptGenerationUsage(accounting, resumed, usage);
		});
		second.recordUsage({ inputTokens: 20 });
		second.stopUsageClock();
		second.flushUsage();
		expect(accounting.total.totalTokens).toBe(failed ? 20 : 30);
		// Received spend is 10 + 20, even before the old generation's persistence timer runs.
		expect(sibling.remainingTokens()).toBe(70);
		expect(second.remainingAttemptTokenBudget()).toBe(0);
		expect(() => second.assertBudgetAvailable()).toThrow("Token budget exhausted");
		vi.advanceTimersByTime(250);
		expect(accounting.total.totalTokens).toBe(30);
		expect(sibling.remainingTokens()).toBe(70);
	});

	it("preserves both persistence and shared publication failures, including a falsy first error", () => {
		const shared = {
			assertBudgetAvailable: vi.fn(),
			getAttemptUsage: () => tokens(0),
			recordAttemptUsage: vi.fn(),
			remainingTokens: () => undefined,
			reserveProviderBudget: async (maxTokens: number) => ({ maxTokens, release: () => {} }),
		};
		const gateway = new CapabilityGateway({
			grant: createTestExecutionGrant({ objectiveId: "o", taskId: "t", attemptId: "a" }),
			cwd: process.cwd(),
			now: () => 100,
			sharedBudget: shared,
		});
		const identity = { leaseId: "lease", fencingToken: 1 };
		gateway.bindUsageAccounting({
			identity,
			baseline: tokens(0),
			read: () => beginAttemptUsageGeneration(undefined, identity, tokens(0)),
			record: () => {
				throw undefined;
			},
		});
		const publication = new Error("budget publication failure");
		shared.recordAttemptUsage.mockImplementation(() => {
			throw publication;
		});
		let failure: unknown;
		try {
			gateway.flushUsage();
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(AggregateError);
		expect((failure as AggregateError).errors).toEqual([undefined, publication]);
	});
});
