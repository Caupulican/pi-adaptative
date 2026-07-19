import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ObservationStore, observationKey } from "../src/core/learning/observation-store.ts";

/**
 * G6 evidence-strength store: bounded, durable observation counts that let the learning gate
 * accumulate repeated evidence for the same lesson across passes and sessions.
 */
describe("ObservationStore", () => {
	let agentDir: string;
	const filePath = () => join(agentDir, "state", "learning-observations.json");

	beforeEach(() => {
		agentDir = join(tmpdir(), `pi-observations-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (agentDir && existsSync(agentDir)) rmSync(agentDir, { recursive: true, force: true });
	});

	it("increment accumulates and persists across store instances", () => {
		const key = observationKey("memory", "Add MEMORY memory: always run checks");

		const first = ObservationStore.forAgentDir(agentDir);
		expect(first.get(key)).toBe(0);
		expect(first.increment(key)).toBe(1);
		expect(first.increment(key)).toBe(2);

		// A fresh instance reads the same on-disk count (survives session boundaries).
		const reopened = ObservationStore.forAgentDir(agentDir);
		expect(reopened.get(key)).toBe(2);
		expect(reopened.increment(key)).toBe(3);
	});

	it("readOnly:true increments the pure-read equivalent without ever creating the state file (D4)", () => {
		const key = observationKey("memory", "readonly lesson");
		const readOnlyStore = ObservationStore.forAgentDir(agentDir, { readOnly: true });

		expect(readOnlyStore.get(key)).toBe(0);
		expect(readOnlyStore.increment(key)).toBe(1);
		// Nothing was ever persisted, so a repeat increment sees the same base+1, not an accumulating count.
		expect(readOnlyStore.increment(key)).toBe(1);
		expect(existsSync(filePath())).toBe(false);

		// readOnly:false (the default outside a worker session) is unaffected.
		const writableStore = ObservationStore.forAgentDir(agentDir);
		expect(writableStore.increment(key)).toBe(1);
		expect(writableStore.increment(key)).toBe(2);
		expect(existsSync(filePath())).toBe(true);
	});

	it("normalization collapses whitespace and case so reworded variants share a key", () => {
		const canonical = observationKey("memory", "Add MEMORY memory: Always Run Checks");
		const spaced = observationKey("memory", "add   memory    memory:\tALWAYS run   checks");
		const padded = observationKey("memory", "  add memory memory: always run checks\n");
		expect(spaced).toBe(canonical);
		expect(padded).toBe(canonical);

		// A different layer is a different lesson even with identical text.
		expect(observationKey("skill", "Always Run Checks")).not.toBe(observationKey("memory", "Always Run Checks"));

		// The store treats those variants as one accumulating lesson.
		const store = ObservationStore.forAgentDir(agentDir);
		store.increment(canonical);
		expect(store.increment(spaced)).toBe(2);
		expect(store.increment(padded)).toBe(3);
	});

	it("caps per-key counts at 100", () => {
		const store = ObservationStore.forAgentDir(agentDir);
		const key = observationKey("memory", "hot lesson");
		let last = 0;
		for (let i = 0; i < 130; i += 1) last = store.increment(key);
		expect(last).toBe(100);
		expect(store.get(key)).toBe(100);
	});

	it("evicts the least-recently-incremented key past the 500-key bound", () => {
		const store = ObservationStore.forAgentDir(agentDir);
		// Explicit, strictly-increasing timestamps make eviction order deterministic.
		const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0) + i * 1000).toISOString();

		const oldestKey = observationKey("memory", "lesson-0");
		for (let i = 0; i < 500; i += 1) {
			store.increment(observationKey("memory", `lesson-${i}`), at(i));
		}
		expect(store.get(oldestKey)).toBe(1);

		// The 501st distinct key pushes past the bound and evicts the least-recently-incremented key.
		store.increment(observationKey("memory", "lesson-500"), at(500));
		expect(store.get(oldestKey)).toBe(0);
		expect(store.get(observationKey("memory", "lesson-500"))).toBe(1);
		expect(store.get(observationKey("memory", "lesson-1"))).toBe(1);

		const parsed = JSON.parse(readFileSync(filePath(), "utf-8")) as { observations: Record<string, unknown> };
		expect(Object.keys(parsed.observations)).toHaveLength(500);
	});

	it("recovers from a corrupt or wrong-shaped file as a fresh store without throwing", () => {
		mkdirSync(join(agentDir, "state"), { recursive: true });
		writeFileSync(filePath(), "{ not valid json ]", "utf-8");

		const store = ObservationStore.forAgentDir(agentDir);
		const key = observationKey("memory", "resilient lesson");
		expect(store.get(key)).toBe(0);
		expect(store.increment(key)).toBe(1);

		// The next read sees the rewritten, well-formed file.
		expect(ObservationStore.forAgentDir(agentDir).get(key)).toBe(1);

		// A JSON-valid but wrong-shaped file also degrades to a fresh store.
		writeFileSync(filePath(), JSON.stringify({ version: 1, observations: [] }), "utf-8");
		expect(ObservationStore.forAgentDir(agentDir).get(key)).toBe(0);
	});

	/**
	 * Two REAL OS threads incrementing the SAME key concurrently must not lose an increment —
	 * `increment()`'s load-mutate-save now runs under one exclusive lock (the shared atomic-file
	 * helper) instead of racing unlocked reads/writes.
	 */
	it("two OS threads incrementing the same key concurrently never lose an increment", async () => {
		const modulePath = new URL("../src/core/learning/observation-store.ts", import.meta.url).pathname;
		const workerPath = join(agentDir, "increment-worker.mjs");
		writeFileSync(
			workerPath,
			`import { ObservationStore } from ${JSON.stringify(modulePath)};
import { parentPort, workerData } from "node:worker_threads";
const { agentDir, key, iterations } = workerData;
const observationStore = ObservationStore.forAgentDir(agentDir);
for (let i = 0; i < iterations; i++) observationStore.increment(key);
parentPort.postMessage({ done: true });
`,
			"utf-8",
		);

		const key = observationKey("memory", "hammered lesson");
		const iterationsPerWorker = 40; // total stays under MAX_COUNT (100) so the cap never masks a loss
		const workers = [1, 2].map(
			() =>
				new Worker(pathToFileURL(workerPath), { workerData: { agentDir, key, iterations: iterationsPerWorker } }),
		);
		await Promise.all(
			workers.map(
				(worker) =>
					new Promise<void>((resolve, reject) => {
						worker.on("message", () => resolve());
						worker.on("error", reject);
					}),
			),
		);
		await Promise.all(workers.map((worker) => worker.terminate()));

		expect(ObservationStore.forAgentDir(agentDir).get(key)).toBe(iterationsPerWorker * 2);
	}, 20_000);
});
