import { expect, it } from "vitest";
import {
	accumulateCurrentSessionCostsFromEntries,
	aggregateCurrentSessionCostsFromEntries,
	createCurrentSessionCostAccumulator,
	projectPendingSemanticCost,
} from "../src/core/cost/cost-summary.ts";
import { aggregateDailyUsageFromEntries, formatDailyUsageBreakdown } from "../src/core/cost/daily-usage.ts";
import { computeSessionTaskAndModelMetrics } from "../src/core/cost/task-cost-metrics.ts";
import { USAGE_RECEIPT_CUSTOM_TYPE } from "../src/core/cost/usage-receipt.ts";
import {
	resolveEffectiveEntryCost,
	SEMANTIC_USAGE_CUSTOM_TYPE,
	type SemanticUsageReport,
} from "../src/core/cost/usage-records.ts";
import type { SessionEntry } from "../src/kernel/session/session-entries.ts";
import { createEmptyUsage } from "../src/kernel/usage.ts";

const window = { startMs: Date.parse("2026-11-20T00:00:00.000Z"), endMs: Date.parse("2026-11-21T00:00:00.000Z") };

it("preserves pending pricing uncertainty through canonical transfer without inventing spend", () => {
	const entry = semantic("pending-unpriced", 0) as Extract<SessionEntry, { type: "custom" }>;
	const report = entry.data as SemanticUsageReport;
	const pending = projectPendingSemanticCost(createCurrentSessionCostAccumulator(), [report]);
	expect(pending).toMatchObject({ currentCost: 0, apiEquivalentPartial: true });
	const canonical = accumulateCurrentSessionCostsFromEntries(createCurrentSessionCostAccumulator(), [entry]);
	expect(projectPendingSemanticCost(canonical, [report])).toMatchObject({
		currentCost: 0,
		apiEquivalentPartial: true,
	});
	const free = { ...report, priceKnown: true as const };
	expect(projectPendingSemanticCost(createCurrentSessionCostAccumulator(), [free]).apiEquivalentPartial).not.toBe(
		true,
	);
	const paid = { ...report, usage: { ...report.usage, cost: { ...report.usage.cost, total: 1 } } };
	const paidEntry = { ...entry, data: paid };
	const charged = accumulateCurrentSessionCostsFromEntries(createCurrentSessionCostAccumulator(), [paidEntry]);
	expect(projectPendingSemanticCost(charged, [paid]).currentCost).toBe(1);
});

function semantic(id: string, cost: number, priced = false): SessionEntry {
	const usage = createEmptyUsage();
	usage.input = usage.totalTokens = 10;
	usage.cost.input = usage.cost.total = cost;
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-11-20T00:00:00.000Z",
		customType: SEMANTIC_USAGE_CUSTOM_TYPE,
		data: {
			reportId: id,
			usage,
			provider: "fixture-provider",
			model: "same-model",
			attempt: 1,
			...(priced ? { costStatus: "catalog_priced" } : {}),
		},
	};
}

it("keeps an unpriced call visible when another call on the same model has a recorded charge", () => {
	const entries = [semantic("priced", 1), semantic("unpriced", 0)];
	const metrics = computeSessionTaskAndModelMetrics({ entries });
	expect(metrics.models).toHaveLength(1);
	expect(metrics.models[0]).toMatchObject({ calls: 2, costUsd: 1, unpricedCalls: 1 });
	expect(metrics.apiEquivalentPartial).toBe(true);
	expect(aggregateDailyUsageFromEntries(entries, window).apiEquivalentPartial).toBe(true);
	expect(formatDailyUsageBreakdown(aggregateDailyUsageFromEntries(entries, window))).toContain(
		"pricing or model attribution",
	);
	expect(aggregateCurrentSessionCostsFromEntries(entries)).toMatchObject({
		currentCost: 1,
		apiEquivalentPartial: true,
	});
});

it("preserves affirmative zero pricing instead of treating every zero-dollar response as missing", () => {
	const entries = [semantic("free", 0, true)];
	const metrics = computeSessionTaskAndModelMetrics({ entries });
	expect(metrics.models[0]).toMatchObject({ costUsd: 0, unpricedCalls: 0 });
	expect(metrics.apiEquivalentPartial).toBe(false);
	expect(aggregateDailyUsageFromEntries(entries, window).apiEquivalentPartial).not.toBe(true);
	expect(aggregateCurrentSessionCostsFromEntries(entries).apiEquivalentPartial).not.toBe(true);
});

it.each([undefined, 0])("distinguishes an absent receipt price from an explicit zero (%s)", (costUsd) => {
	const entry: SessionEntry = {
		type: "custom",
		id: "remote",
		parentId: null,
		timestamp: "2026-11-20T00:00:00.000Z",
		customType: USAGE_RECEIPT_CUSTOM_TYPE,
		data: { reportId: "remote", label: "remote job", totalTokens: 10, ...(costUsd !== undefined ? { costUsd } : {}) },
	};
	expect(computeSessionTaskAndModelMetrics({ entries: [entry] }).apiEquivalentPartial).toBe(costUsd === undefined);
	expect(aggregateDailyUsageFromEntries([entry], window).apiEquivalentPartial === true).toBe(costUsd === undefined);
	expect(aggregateCurrentSessionCostsFromEntries([entry]).apiEquivalentPartial === true).toBe(costUsd === undefined);
});

it("reconstructs the API estimate of an uncharged Antigravity response at positive catalog rates", () => {
	const usage = createEmptyUsage();
	usage.input = usage.totalTokens = 100;
	const cost = resolveEffectiveEntryCost(usage, {
		provider: "google-antigravity",
		model: "gemini-2.5-flash",
		kind: "semantic",
		costStatus: "catalog_priced",
	});
	expect(cost?.total).toBeGreaterThan(0);
	expect(cost).toMatchObject({ reportedTotal: 0, estimated: true, pricingComplete: true });
	expect(
		resolveEffectiveEntryCost(usage, { provider: "google-antigravity", model: "gemini-2.5-flash", kind: "spawned" }),
	).toMatchObject({ total: 0, pricingComplete: false });
});
