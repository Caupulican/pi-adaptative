import { describe, expect, it } from "vitest";
import { ModelAdaptationStore } from "../src/core/models/adaptation-store.ts";
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
			ModelAdaptationStore.forAgentDir(harness.tempDir).setToolProbe("faux/fastcontext-local", {
				version: 1,
				status: "native",
				nativeGrade: "task",
				probedAt: new Date().toISOString(),
			});
			const resolved = await resolveScoutModel(harness.session.modelRegistry, "auto", harness.tempDir);
			expect("model" in resolved).toBe(true);
			if ("model" in resolved && resolved.model) expect(resolved.model.id).toBe("fastcontext-local");
		} finally {
			harness.cleanup();
		}
	});

	it("rejects auto when JSON tool intent passed but the real tool probe found no protocol", async () => {
		const harness = await createHarness({ models: [{ id: "fastcontext-local" }] });
		try {
			FitnessStore.forAgentDir(harness.tempDir).save("faux/fastcontext-local", report());
			ModelAdaptationStore.forAgentDir(harness.tempDir).setToolProbe("faux/fastcontext-local", {
				version: 1,
				status: "none",
				nativeGrade: "absent",
				probedAt: new Date().toISOString(),
			});

			await expect(resolveScoutModel(harness.session.modelRegistry, "auto", harness.tempDir)).resolves.toEqual({
				failure: "faux/fastcontext-local unfit (real tool execution: none)",
			});
		} finally {
			harness.cleanup();
		}
	});

	it("routes an auto scout through its calibrated phone protocol when native calls are absent", async () => {
		const harness = await createHarness({ models: [{ id: "fastcontext-local" }] });
		try {
			FitnessStore.forAgentDir(harness.tempDir).save("faux/fastcontext-local", report());
			const adaptations = ModelAdaptationStore.forAgentDir(harness.tempDir);
			adaptations.setToolProbe("faux/fastcontext-local", {
				version: 1,
				status: "text-protocol",
				variant: "fenced-json",
				nativeGrade: "absent",
				probedAt: new Date().toISOString(),
			});
			adaptations.setProtocol("faux/fastcontext-local", {
				version: 1,
				status: "calibrated",
				variant: "fenced-json",
				calibratedAt: new Date().toISOString(),
			});

			const resolved = await resolveScoutModel(harness.session.modelRegistry, "auto", harness.tempDir);

			expect("model" in resolved && resolved.textToolCallProtocol).toEqual({ variant: "fenced-json" });
		} finally {
			harness.cleanup();
		}
	});

	it("keeps a proven-native auto scout native even when the global phone override is enabled", async () => {
		const harness = await createHarness({ models: [{ id: "fastcontext-local" }] });
		try {
			FitnessStore.forAgentDir(harness.tempDir).save("faux/fastcontext-local", report());
			ModelAdaptationStore.forAgentDir(harness.tempDir).setToolProbe("faux/fastcontext-local", {
				version: 1,
				status: "native",
				nativeGrade: "task",
				probedAt: new Date().toISOString(),
			});

			const resolved = await resolveScoutModel(
				harness.session.modelRegistry,
				"auto",
				harness.tempDir,
				() => false,
				true,
			);

			expect("model" in resolved && resolved.textToolCallProtocol).toBeUndefined();
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

	it("rejects exhausted scout models with an S5 unavailable failure", async () => {
		const harness = await createHarness({ models: [{ id: "fastcontext-local" }] });
		try {
			const resolved = await resolveScoutModel(
				harness.session.modelRegistry,
				"faux/fastcontext-local",
				harness.tempDir,
				(model) => model.id === "fastcontext-local",
			);
			expect(resolved).toEqual({ failure: "faux/fastcontext-local exhausted: quota" });
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
