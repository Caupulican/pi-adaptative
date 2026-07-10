import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ToolPerformanceKey, ToolPerformanceStore } from "../src/core/tool-selection/tool-performance-store.ts";

const key: ToolPerformanceKey = { modelRef: "faux/model", intentClass: "read", tool: "read" };
const selection = {
	firstTool: true,
	disposition: "recommend" as const,
	recommendation: "read",
	shortlist: [],
	entropy: 0.1,
	margin: 0.2,
	ranked: [{ tool: "read", utility: 0.8, probability: 0.7 }],
};

const hosts = [
	{ id: "host-a", cpu: "cpu-a", cores: 4, totalMemGb: 16 },
	{ id: "host-b", cpu: "cpu-b", cores: 8, totalMemGb: 32 },
] as const;
const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function storeFor(hostIndex = 0): ToolPerformanceStore {
	const dir = mkdtempSync(join(tmpdir(), "pi-tool-performance-"));
	dirs.push(dir);
	return ToolPerformanceStore.forAgentDir(dir, { fingerprint: () => hosts[hostIndex] });
}

describe("ToolPerformanceStore", () => {
	it("keeps host fingerprints separate and updates EWMA/deviation/counters", () => {
		const first = storeFor(0);
		first.recordValidation(key, "repaired");
		first.recordValidation(key, "bounced");
		first.recordExecution({
			key,
			success: true,
			latencyMs: 100,
			inputTokenEstimate: 20,
			outputTokenEstimate: 8,
			selection,
		});
		first.recordExecution({
			key,
			success: false,
			latencyMs: 300,
			inputTokenEstimate: 40,
			outputTokenEstimate: 16,
			selection,
		});
		const stats = first.get(key);
		expect(stats.alpha).toBe(2);
		expect(stats.beta).toBe(2);
		expect(stats.sampleCount).toBe(2);
		expect(stats.repairCount).toBe(1);
		expect(stats.bounceCount).toBe(1);
		expect(stats.failureCount).toBe(1);
		expect(stats.latencyEwmaMs).toBe(150);
		expect(stats.latencyDeviationEwmaMs).toBe(50);

		const second = storeFor(1);
		expect(second.get(key).sampleCount).toBe(0);
	});

	it("bounds observations and statistics", () => {
		const store = storeFor();
		for (let index = 0; index < 1_020; index += 1) {
			store.recordExecution({
				key: { modelRef: `model-${index}`, intentClass: "other", tool: `tool-${index}` },
				success: true,
				latencyMs: index,
				selection: { ...selection, firstTool: false },
			});
		}
		const observations = store.getObservations();
		expect(observations).toHaveLength(1_000);
		const file = JSON.parse(readFileSync(join(dirs[0]!, "state/tool-performance.json"), "utf8")) as {
			hosts: Record<string, { stats: Record<string, unknown> }>;
		};
		expect(Object.keys(Object.values(file.hosts)[0]!.stats)).toHaveLength(500);
	});

	it("fails closed on corrupt storage and overwrites it on the next valid save", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-tool-performance-"));
		dirs.push(dir);
		const path = join(dir, "state/tool-performance.json");
		const store = ToolPerformanceStore.forAgentDir(dir, { fingerprint: () => hosts[0] });
		mkdirSync(join(dir, "state"), { recursive: true });
		writeFileSync(path, "not-json", "utf8");
		expect(store.get(key).sampleCount).toBe(0);
		store.recordExecution({ key, success: true, latencyMs: 1, selection });
		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: 1 });
	});

	it("keeps observations redacted and exposes metrics", () => {
		const store = storeFor();
		store.recordExecution({
			key,
			success: false,
			latencyMs: 25,
			inputTokenEstimate: 4,
			outputTokenEstimate: 6,
			selection: {
				...selection,
				firstTool: true,
				recommendation: "write",
			},
		});
		const observation = store.getObservations()[0]!;
		expect(observation).not.toHaveProperty("prompt");
		expect(observation).not.toHaveProperty("args");
		expect(observation).not.toHaveProperty("output");
		expect(store.getMetrics()).toMatchObject({
			firstToolAttempts: 1,
			firstToolSuccesses: 0,
			wrongToolOrFailureCount: 1,
			averageLatencyMs: 25,
			averageInputTokenEstimate: 4,
			averageOutputTokenEstimate: 6,
		});
	});
});
