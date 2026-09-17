import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateToolPromotion } from "../src/core/tool-selection/promotion.ts";
import { ToolPerformanceStore } from "../src/core/tool-selection/tool-performance-store.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const host = { id: "host", cpu: "fixture", cores: 1, totalMemGb: 1 };
const key = { modelRef: "model", intentClass: "read" as const, tool: "read" };
const storageKey = "model\0read\0read";
const at = "2026-09-17T00:00:00.000Z";
const stats = {
	...key,
	alpha: 4,
	beta: 1,
	sampleCount: 3,
	repairCount: 0,
	bounceCount: 0,
	failureCount: 0,
	lastUsedAt: at,
};
const agreement = {
	modelRef: key.modelRef,
	intentClass: key.intentClass,
	sampleCount: 3,
	agreementCount: 3,
	hintActiveSampleCount: 1,
	hintActiveAgreementCount: 1,
	lastUpdatedAt: at,
};
const observation = {
	at,
	...key,
	actualTool: "read",
	firstTool: true,
	succeeded: true,
	disposition: "recommend",
	recommendation: "read",
	shortlist: [],
	entropy: 0,
	margin: 0.8,
	ranked: [{ tool: "read", utility: 0.8, probability: 1 }],
	latencyMs: 1,
};

function fixture(data: {
	stats?: Record<string, unknown>;
	observations?: unknown[];
	intentAgreement?: Record<string, unknown>;
}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-performance-boundaries-"));
	dirs.push(dir);
	const path = join(dir, "performance.json");
	writeFileSync(
		path,
		JSON.stringify({
			version: 1,
			hosts: { host: { host, stats: {}, observations: [], intentAgreement: {}, ...data } },
		}),
	);
	return new ToolPerformanceStore(path, { fingerprint: () => host, readOnly: true });
}

describe("persisted tool-performance boundaries", () => {
	it.each([
		["sampleCount", 3.5],
		["sampleCount", -1],
		["sampleCount", 4],
		["alpha", 0],
		["alpha", 4.5],
		["beta", -1],
		["failureCount", 4],
		["repairCount", -1],
		["bounceCount", 0.5],
		["latencyEwmaMs", -1],
		["latencyDeviationEwmaMs", "bad"],
		["inputTokenEstimateEwma", null],
		["outputTokenEstimateEwma", -1],
		["lastUsedAt", "invalid"],
	])("rejects malformed %s=%s before using it as promotion evidence", (field, value) => {
		const store = fixture({ stats: { [storageKey]: { ...stats, [field]: value } } });
		expect(store.getStatsForModel("model")).toEqual([]);
		expect(evaluateToolPromotion(store.getStatsForIntent("model", "read")).tool).toBeUndefined();
	});

	it.each([
		["sampleCount", -1],
		["agreementCount", 4],
		["hintActiveSampleCount", 4],
		["hintActiveAgreementCount", 2],
		["agreementCount", 0.5],
		["lastUpdatedAt", "invalid"],
	])("rejects impossible agreement %s=%s", (field, value) => {
		const store = fixture({ intentAgreement: { "model\0read": { ...agreement, [field]: value } } });
		expect(store.getAllIntentAgreements()).toEqual([]);
	});

	it.each([
		{ latencyMs: -1 },
		{ inputTokenEstimate: -1 },
		{ outputTokenEstimate: -1 },
		{ ranked: [{ tool: "read", utility: 0.8, probability: 2 }] },
		{ entropy: -1 },
		{ shortlist: ["a", "b", "c", "d"] },
		{ ranked: Array.from({ length: 7 }, () => ({ tool: "read", utility: 1, probability: 0.1 })) },
	])("rejects malformed observation fields %j", (fields) => {
		const store = fixture({ observations: [{ ...observation, ...fields }] });
		expect(store.getObservations()).toEqual([]);
	});

	it("does not read records through mismatched storage identities", () => {
		const store = fixture({
			stats: { [storageKey]: { ...stats, tool: "other" } },
			intentAgreement: { "model\0read": { ...agreement, modelRef: "other" } },
		});
		expect(store.get(key).sampleCount).toBe(0);
		expect(store.getStatsForModel("model")).toEqual([]);
		expect(store.getAllIntentAgreements()).toEqual([]);
	});

	it("bounds read-side statistics and agreements before any mutation", () => {
		const store = fixture({
			stats: Object.fromEntries(
				Array.from({ length: 550 }, (_, index) => [
					`model\0read\0tool-${index}`,
					{ ...stats, tool: `tool-${index}`, lastUsedAt: new Date(index).toISOString() },
				]),
			),
			intentAgreement: Object.fromEntries(
				Array.from({ length: 550 }, (_, index) => [
					`model-${index}\0read`,
					{ ...agreement, modelRef: `model-${index}`, lastUpdatedAt: new Date(index).toISOString() },
				]),
			),
		});
		expect(store.getStatsForModel("model")).toHaveLength(500);
		expect(store.getAllIntentAgreements()).toHaveLength(500);
		expect(store.getStatsForModel("model").some((entry) => entry.tool === "tool-0")).toBe(false);
		expect(store.getStatsForModel("model").some((entry) => entry.tool === "tool-549")).toBe(true);
	});

	it("keeps valid records and a negative utility/margin observation", () => {
		const store = fixture({
			stats: { [storageKey]: stats },
			intentAgreement: { "model\0read": agreement },
			observations: [
				{
					...observation,
					disposition: "abstain",
					margin: -0.1,
					ranked: [{ tool: "read", utility: -0.1, probability: 1 }],
				},
			],
		});
		expect(evaluateToolPromotion(store.getStatsForIntent("model", "read")).tool).toBe("read");
		expect(store.getAllIntentAgreements()).toEqual([agreement]);
		expect(store.getObservations()).toHaveLength(1);
	});
});
