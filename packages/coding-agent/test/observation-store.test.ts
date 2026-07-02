import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
