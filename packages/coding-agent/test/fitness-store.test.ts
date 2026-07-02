import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { currentHostFingerprint, FitnessStore, type HostFingerprint } from "../src/core/models/fitness-store.ts";
import type { ModelFitnessReport } from "../src/core/research/model-fitness.ts";

function report(overrides: Partial<ModelFitnessReport> = {}): ModelFitnessReport {
	const lane = { succeeded: 3, total: 3, outcomes: ["ok", "ok", "ok"], meanMs: 100 };
	return {
		trials: 3,
		research: { ...lane },
		worker: { ...lane },
		search: { ...lane },
		toolCall: { ...lane },
		digest: { ...lane },
		judge: {
			parsed: 6,
			planningElevated: 3,
			planningTotal: 3,
			trivialCheap: 2,
			trivialTotal: 3,
			total: 6,
			outcomes: [],
			meanMs: 100,
		},
		totalCostUsd: 0,
		...overrides,
	};
}

function fingerprint(id: string): () => HostFingerprint {
	return () => ({ id, cpu: "test-cpu", cores: 6, totalMemGb: 9 });
}

describe("FitnessStore", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-fitness-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("persists reports keyed by host and reads them back per host", () => {
		const path = join(tempDir, "state", "model-fitness.json");
		const hostA = new FitnessStore(path, { fingerprint: fingerprint("host-a") });
		const hostB = new FitnessStore(path, { fingerprint: fingerprint("host-b") });

		hostA.save("ollama/pi-lifter", report(), "T1");
		hostB.save("ollama/pi-lifter", report({ trials: 5 }), "T2");

		const forA = hostA.getForHost();
		expect(forA).toHaveLength(1);
		expect(forA[0]?.report.trials).toBe(3);
		expect(forA[0]?.host.id).toBe("host-a");

		const forB = hostB.getForHost();
		expect(forB[0]?.report.trials).toBe(5);

		// Cross-host view sees both, distinctly keyed — the 8B can belong to another machine.
		expect(hostA.getAll()).toHaveLength(2);
	});

	it("keeps only the latest report per model per host", () => {
		const store = new FitnessStore(join(tempDir, "f.json"), { fingerprint: fingerprint("host-a") });
		store.save("m", report(), "T1");
		store.save("m", report({ trials: 7 }), "T2");

		const stored = store.getForHost();
		expect(stored).toHaveLength(1);
		expect(stored[0]?.report.trials).toBe(7);
		expect(stored[0]?.at).toBe("T2");
	});

	it("tolerates a corrupt store file by starting fresh", () => {
		const path = join(tempDir, "f.json");
		writeFileSync(path, "{not json");
		const store = new FitnessStore(path, { fingerprint: fingerprint("host-a") });

		expect(store.getForHost()).toEqual([]);
		store.save("m", report(), "T1");
		expect(store.getForHost()).toHaveLength(1);
	});

	it("derives a stable, readable fingerprint for the current host", () => {
		const first = currentHostFingerprint();
		const second = currentHostFingerprint();
		expect(first.id).toBe(second.id);
		expect(first.id).toMatch(/-\d+c-\d+g$/);
		expect(first.cores).toBeGreaterThan(0);
	});
});
