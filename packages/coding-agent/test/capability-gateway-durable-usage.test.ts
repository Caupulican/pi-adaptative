import { describe, expect, it, vi } from "vitest";
import { LaneToolUsage } from "../src/core/autonomy/lane-tool-usage.ts";
import { EMPTY_ATTEMPT_USAGE, providerUsageFromAttemptUsage } from "../src/core/orchestration/attempt-usage.ts";
import {
	beginAttemptUsageGeneration,
	recordAttemptGenerationUsage,
} from "../src/core/orchestration/attempt-usage-generations.ts";
import { CapabilityGateway } from "../src/core/orchestration/capability-gateway.ts";
import type { AttemptUsageSnapshot } from "../src/core/orchestration/contracts.ts";
import { createTestExecutionGrant } from "./orchestration-profile-fixture.ts";

const tokens = (totalTokens: number) => ({ ...EMPTY_ATTEMPT_USAGE, inputTokens: totalTokens, totalTokens });

function fixture() {
	const clock = { ms: 100 };
	const old = { leaseId: "old", fencingToken: 1 };
	const current = { leaseId: "current", fencingToken: 2 };
	let accounting = beginAttemptUsageGeneration(undefined, old, tokens(10));
	accounting = beginAttemptUsageGeneration(accounting, current);
	const grant = createTestExecutionGrant({ objectiveId: "objective", taskId: "task", attemptId: "attempt" });
	grant.budget = { maxTokens: 100 };
	const gateway = new CapabilityGateway({ grant, cwd: process.cwd(), now: () => clock.ms });
	const record = vi.fn((usage: AttemptUsageSnapshot) => {
		accounting = recordAttemptGenerationUsage(accounting, current, usage);
	});
	gateway.bindUsageAccounting({
		identity: current,
		baseline: accounting.generations.current.baseline,
		read: () => accounting,
		record,
	});
	return {
		gateway,
		clock,
		record,
		getAccounting: () => accounting,
		late: (value: number) => {
			accounting = recordAttemptGenerationUsage(accounting, old, tokens(value));
		},
	};
}

describe("gateway generation-attributed usage", () => {
	it("uses canonical corrections for budgets without copying them into local reports", () => {
		const { gateway, late, getAccounting } = fixture();
		gateway.recordUsage({ inputTokens: 20 });
		gateway.flushUsage();
		late(60);
		expect(gateway.getUsage().totalTokens).toBe(80);
		expect(gateway.remainingAttemptTokenBudget()).toBe(20);
		gateway.recordUsage({ inputTokens: 20 });
		gateway.flushUsage();
		expect(getAccounting().generations.current.reported.totalTokens).toBe(50);
		expect(getAccounting().total.totalTokens).toBe(100);
		expect(() => gateway.assertBudgetAvailable()).toThrow("Token budget exhausted");
	});

	it.each([false, true])(
		"retries a cumulative tool receipt without adding its delta again: committed=%s",
		(committed) => {
			const { gateway, record, getAccounting } = fixture();
			const write = record.getMockImplementation()!;
			record.mockImplementationOnce((usage) => {
				if (committed) write(usage);
				throw new Error("receipt write interrupted");
			});
			const tool = new LaneToolUsage((delta) => gateway.recordUsage(delta));
			tool.bindCheckpoint(() => gateway.flushUsage());
			const receipt = providerUsageFromAttemptUsage(tokens(20));
			expect(() => tool.report("review", receipt)).toThrow("receipt write interrupted");
			expect(gateway.getUsage().totalTokens).toBe(30);
			tool.report("review", receipt);
			expect(getAccounting().total.totalTokens).toBe(30);
			expect(getAccounting().generations.current.reported.totalTokens).toBe(30);
			expect(record).toHaveBeenCalledTimes(2);
		},
	);

	it.each([false, true])("retains failed close without copying a foreign correction: committed=%s", (committed) => {
		const { gateway, record, late, getAccounting } = fixture();
		const write = record.getMockImplementation()!;
		let unavailable = true;
		record.mockImplementation((usage) => {
			if (unavailable) {
				if (committed) write(usage);
				throw new Error("receipt write interrupted");
			}
			write(usage);
		});
		const tool = new LaneToolUsage((delta) => gateway.recordUsage(delta));
		tool.bindCheckpoint(() => gateway.flushUsage());
		const receipt = providerUsageFromAttemptUsage(tokens(20));
		expect(() => tool.report("review", receipt)).toThrow("receipt write interrupted");
		gateway.stopUsageClock();
		expect(() => tool.close()).toThrow("receipt write interrupted");
		// A previous generation's late bill changes the total, never this owner's cumulative report.
		late(60);
		expect(gateway.getUsage().totalTokens).toBe(80);
		unavailable = false;
		tool.close();
		tool.settle("review", receipt);
		expect(getAccounting().total.totalTokens).toBe(80);
		expect(getAccounting().generations.current.reported.totalTokens).toBe(30);
		expect(record).toHaveBeenCalledTimes(3);
	});

	it("freezes active time while retaining billed receipts delivered after shutdown", () => {
		const { gateway, clock, getAccounting } = fixture();
		clock.ms = 140;
		gateway.stopUsageClock();
		clock.ms = 10_000;
		gateway.recordUsage({ inputTokens: 20 });
		gateway.flushUsage();
		expect(getAccounting().total).toEqual({ ...tokens(30), activeWallClockMs: 40 });
		expect(gateway.getUsage().wallClockMs).toBe(40);
	});

	it("refuses a second accounting owner or rebasing counters after work was charged", () => {
		const { gateway } = fixture();
		const identity = { leaseId: "lease", fencingToken: 1 };
		const port = {
			identity,
			baseline: tokens(0),
			read: () => beginAttemptUsageGeneration(undefined, identity, tokens(0)),
			record: vi.fn(),
		};
		expect(() => gateway.bindUsageAccounting(port)).toThrow("already");
		const pristine = new CapabilityGateway({
			grant: createTestExecutionGrant({ objectiveId: "o", taskId: "t", attemptId: "a" }),
			cwd: process.cwd(),
		});
		pristine.recordUsage({ inputTokens: 1 });
		expect(() => pristine.bindUsageAccounting(port)).toThrow("before");
	});
});
