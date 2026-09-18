import { describe, expect, it } from "vitest";
import { EMPTY_ATTEMPT_USAGE } from "../src/core/orchestration/attempt-usage.ts";
import {
	beginAttemptUsageGeneration,
	projectPendingAttemptGenerationUsage,
	reconcileAttemptUsageAccounting,
	recordAttemptGenerationUsage,
	totalAttemptGenerationUsage,
} from "../src/core/orchestration/attempt-usage-generations.ts";

const first = { leaseId: "lease-1", fencingToken: 1 };
const resumed = { leaseId: "lease-2", fencingToken: 2 };
const usage = (tokens: number) => ({ ...EMPTY_ATTEMPT_USAGE, inputTokens: tokens, totalTokens: tokens });

describe("durable attempt usage generations", () => {
	it.each([false, true])("combines pending generations independently of arrival order: reverse=%s", (reverse) => {
		const original = beginAttemptUsageGeneration(undefined, first, usage(5));
		const registered = beginAttemptUsageGeneration(original, resumed);
		const oldPending = projectPendingAttemptGenerationUsage(original, first, usage(15));
		const newPending = projectPendingAttemptGenerationUsage(registered, resumed, usage(25));
		const [left, right] = reverse ? [newPending, oldPending] : [oldPending, newPending];
		const merged = reconcileAttemptUsageAccounting(left, right);
		expect(merged.total).toEqual(usage(35));
		expect(reconcileAttemptUsageAccounting(merged, left)).toEqual(merged);
		expect(reconcileAttemptUsageAccounting(merged, registered)).toEqual(merged);
		expect(original.total).toEqual(usage(5));
		expect(registered.total).toEqual(usage(5));
		// A stale local counter cannot erase an already durable charge.
		expect(projectPendingAttemptGenerationUsage(merged, first, usage(5))).toEqual(merged);
	});

	it("does not sum baselines when the older charge persisted before resume", () => {
		const older = recordAttemptGenerationUsage(
			beginAttemptUsageGeneration(undefined, first, usage(5)),
			first,
			usage(15),
		);
		const newer = projectPendingAttemptGenerationUsage(
			beginAttemptUsageGeneration(older, resumed),
			resumed,
			usage(35),
		);
		expect(reconcileAttemptUsageAccounting(older, newer).total).toEqual(usage(35));
	});

	it("rejects conflicting provenance and totals without mutating either publication", () => {
		const original = beginAttemptUsageGeneration(undefined, first, usage(5));
		const conflictingBaseline = beginAttemptUsageGeneration(undefined, first, usage(6));
		const conflictingFence = beginAttemptUsageGeneration(undefined, { ...first, fencingToken: 2 }, usage(5));
		const reusedFence = beginAttemptUsageGeneration(undefined, { ...resumed, fencingToken: 1 }, usage(5));
		for (const incoming of [conflictingBaseline, conflictingFence, reusedFence, { ...original, total: usage(9) }]) {
			const before = structuredClone({ original, incoming });
			expect(() => reconcileAttemptUsageAccounting(original, incoming)).toThrow();
			expect({ original, incoming }).toEqual(before);
		}
		const merged = reconcileAttemptUsageAccounting(undefined, original);
		original.generations[first.leaseId].reported.inputTokens = 99;
		expect(merged.generations[first.leaseId].reported.inputTokens).toBe(5);
	});

	it("rejects overflow from individually valid pending generations", () => {
		const registered = beginAttemptUsageGeneration(beginAttemptUsageGeneration(undefined, first, usage(0)), resumed);
		const older = projectPendingAttemptGenerationUsage(registered, first, usage(Number.MAX_SAFE_INTEGER));
		const newer = projectPendingAttemptGenerationUsage(registered, resumed, usage(1));
		expect(() => reconcileAttemptUsageAccounting(older, newer)).toThrow();
		expect(older.total.totalTokens).toBe(Number.MAX_SAFE_INTEGER);
		expect(newer.total.totalTokens).toBe(1);
	});

	it("derives every usage field identically across interleaved reporting orders", () => {
		const baseline = {
			toolCalls: 1,
			inputTokens: 10,
			outputTokens: 20,
			cacheReadTokens: 30,
			cacheWriteTokens: 40,
			totalTokens: 200,
			costUsd: 0.1,
			activeWallClockMs: 100,
		};
		const firstReport = {
			toolCalls: 2,
			inputTokens: 11,
			outputTokens: 22,
			cacheReadTokens: 33,
			cacheWriteTokens: 44,
			totalTokens: 210,
			costUsd: 0.2,
			activeWallClockMs: 110,
		};
		const resumedReport = {
			toolCalls: 4,
			inputTokens: 20,
			outputTokens: 40,
			cacheReadTokens: 60,
			cacheWriteTokens: 80,
			totalTokens: 300,
			costUsd: 0.4,
			activeWallClockMs: 200,
		};
		const registered = beginAttemptUsageGeneration(beginAttemptUsageGeneration(undefined, first, baseline), resumed);
		const forward = recordAttemptGenerationUsage(
			recordAttemptGenerationUsage(registered, first, firstReport),
			resumed,
			resumedReport,
		);
		const reverse = recordAttemptGenerationUsage(
			recordAttemptGenerationUsage(registered, resumed, resumedReport),
			first,
			firstReport,
		);
		expect(forward).toEqual(reverse);
		expect(forward.total).toEqual({
			toolCalls: 5,
			inputTokens: 21,
			outputTokens: 42,
			cacheReadTokens: 63,
			cacheWriteTokens: 84,
			totalTokens: 310,
			costUsd: 0.5,
			activeWallClockMs: 210,
		});
		expect(totalAttemptGenerationUsage(JSON.parse(JSON.stringify(forward.generations)))).toEqual(forward.total);
	});

	it("retains late charges across a resume without counting either generation twice", () => {
		let accounting = beginAttemptUsageGeneration(undefined, first, usage(0));
		accounting = recordAttemptGenerationUsage(accounting, first, usage(100));
		accounting = beginAttemptUsageGeneration(accounting, resumed);
		expect(accounting.generations[resumed.leaseId].baseline.totalTokens).toBe(100);
		accounting = recordAttemptGenerationUsage(accounting, resumed, usage(150));
		accounting = recordAttemptGenerationUsage(accounting, first, usage(110));
		expect(accounting.total.totalTokens).toBe(160);
		expect(recordAttemptGenerationUsage(accounting, first, usage(110))).toBe(accounting);
		accounting = recordAttemptGenerationUsage(accounting, resumed, usage(180));
		expect(accounting.total.totalTokens).toBe(190);
	});

	it("uses recovery evidence only when creating accounting, never as an unattributed later charge", () => {
		let accounting = beginAttemptUsageGeneration(undefined, first, usage(120));
		accounting = recordAttemptGenerationUsage(accounting, first, usage(130));
		expect(accounting.total.totalTokens).toBe(130);
		const before = structuredClone(accounting);
		// A transcript total can include the pending first-generation report. Merging it here
		// and then accepting that report would charge the same provider usage twice.
		expect(() => beginAttemptUsageGeneration(accounting, resumed, usage(150))).toThrow(
			"Recovery baseline is only valid before accounting begins",
		);
		expect(accounting).toEqual(before);
		accounting = beginAttemptUsageGeneration(accounting, resumed);
		accounting = recordAttemptGenerationUsage(accounting, first, usage(150));
		accounting = recordAttemptGenerationUsage(accounting, resumed, usage(140));
		expect(accounting.total.totalTokens).toBe(160);
	});

	it("preserves the registered baseline when registration is replayed after usage changes", () => {
		let accounting = beginAttemptUsageGeneration(undefined, first, usage(10));
		accounting = recordAttemptGenerationUsage(accounting, first, usage(30));
		expect(beginAttemptUsageGeneration(accounting, first)).toBe(accounting);
		expect(beginAttemptUsageGeneration(accounting, first, usage(10))).toBe(accounting);
		expect(() => beginAttemptUsageGeneration(accounting, first, usage(30))).toThrow("conflicting baseline");
		expect(accounting.generations[first.leaseId].baseline.totalTokens).toBe(10);
	});

	it("rejects unregistered and mismatched generation identities without changing accounting", () => {
		const accounting = beginAttemptUsageGeneration(undefined, first, usage(0));
		const before = structuredClone(accounting);
		expect(() => recordAttemptGenerationUsage(accounting, resumed, usage(100))).toThrow("not registered");
		expect(() => recordAttemptGenerationUsage(accounting, { ...first, fencingToken: 2 }, usage(100))).toThrow(
			"does not match",
		);
		expect(() => beginAttemptUsageGeneration(accounting, { ...first, fencingToken: 2 })).toThrow("does not match");
		expect(() => beginAttemptUsageGeneration(accounting, { ...resumed, fencingToken: 1 })).toThrow(
			"already registered",
		);
		expect(accounting).toEqual(before);
	});

	it("rejects malformed, decreasing and overflowing reports atomically", () => {
		let accounting = beginAttemptUsageGeneration(undefined, first, usage(0));
		accounting = recordAttemptGenerationUsage(accounting, first, usage(10));
		const before = structuredClone(accounting);
		expect(() => recordAttemptGenerationUsage(accounting, first, usage(9))).toThrow("cannot decrease");
		expect(() => recordAttemptGenerationUsage(accounting, first, usage(Number.NaN))).toThrow();
		expect(accounting).toEqual(before);
		accounting = recordAttemptGenerationUsage(accounting, first, usage(Number.MAX_SAFE_INTEGER - 1));
		accounting = beginAttemptUsageGeneration(accounting, resumed);
		accounting = recordAttemptGenerationUsage(accounting, resumed, usage(Number.MAX_SAFE_INTEGER));
		const full = structuredClone(accounting);
		expect(() => recordAttemptGenerationUsage(accounting, first, usage(Number.MAX_SAFE_INTEGER))).toThrow();
		expect(accounting).toEqual(full);
	});
});
