import { describe, expect, it } from "vitest";
import { FitnessStore } from "../src/core/models/fitness-store.ts";
import type { LaneFitnessScore, ModelFitnessReport } from "../src/core/research/model-fitness.ts";
import { resolveScoutModel } from "../src/core/runtime-builder.ts";
import { createHarness } from "./suite/harness.ts";

function lane(succeeded = 3, total = 3): LaneFitnessScore {
	return { succeeded, total, outcomes: [], meanMs: 1 };
}

function report(overrides: Partial<ModelFitnessReport> = {}): ModelFitnessReport {
	return {
		trials: 3,
		research: lane(),
		worker: lane(),
		judge: {
			parsed: 3,
			planningElevated: 3,
			planningTotal: 3,
			trivialCheap: 3,
			trivialTotal: 3,
			total: 3,
			outcomes: [],
			meanMs: 1,
		},
		search: lane(),
		toolCall: lane(),
		digest: lane(),
		totalCostUsd: 0,
		...overrides,
	};
}

describe("scout auto fitness gate", () => {
	it("requires an auto-selected FastContext model to be probed", async () => {
		const harness = await createHarness({ models: [{ id: "fastcontext-local" }] });
		try {
			const resolved = await resolveScoutModel(harness.session.modelRegistry, "auto", harness.tempDir);
			expect(resolved).toEqual({
				failure: "faux/fastcontext-local unprobed — run /fitness before auto-selection",
			});
		} finally {
			harness.cleanup();
		}
	});

	it("resolves auto when research and tool-call lanes pass", async () => {
		const harness = await createHarness({ models: [{ id: "fastcontext-local" }] });
		try {
			FitnessStore.forAgentDir(harness.tempDir).save("faux/fastcontext-local", report());
			const resolved = await resolveScoutModel(harness.session.modelRegistry, "auto", harness.tempDir);
			expect("model" in resolved).toBe(true);
			if ("model" in resolved && resolved.model) expect(resolved.model.id).toBe("fastcontext-local");
		} finally {
			harness.cleanup();
		}
	});

	it("rejects auto when a required scout lane failed", async () => {
		const harness = await createHarness({ models: [{ id: "fastcontext-local" }] });
		try {
			FitnessStore.forAgentDir(harness.tempDir).save("faux/fastcontext-local", report({ research: lane(1, 3) }));
			const resolved = await resolveScoutModel(harness.session.modelRegistry, "auto", harness.tempDir);
			expect(resolved).toEqual({ failure: "faux/fastcontext-local unfit (research 1/3)" });
		} finally {
			harness.cleanup();
		}
	});

	it("leaves an explicit scout model pattern ungated", async () => {
		const harness = await createHarness({ models: [{ id: "fastcontext-local" }] });
		try {
			const resolved = await resolveScoutModel(
				harness.session.modelRegistry,
				"faux/fastcontext-local",
				harness.tempDir,
			);
			expect("model" in resolved).toBe(true);
			if ("model" in resolved && resolved.model) expect(resolved.model.id).toBe("fastcontext-local");
		} finally {
			harness.cleanup();
		}
	});
});
