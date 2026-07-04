import type { Model } from "@caupulican/pi-ai";
import { registerFauxProvider } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { FitnessStore } from "../src/core/models/fitness-store.ts";
import type { LaneFitnessScore, ModelFitnessReport } from "../src/core/research/model-fitness.ts";
import { createHarness } from "./suite/harness.ts";

/**
 * Manual /model set is advisory-only (design doctrine: a human explicitly choosing a model may
 * accept a risk the auto-adoption flow would refuse — see fitness-probe-gate.test.ts for that
 * refusal). This exercises the two independent advisories `AgentSession.setModel` must surface
 * through the ordinary `warning` event (the same channel print/RPC modes already render as plain
 * text, never a prompt): a recorded all-lanes-failed probe, and an Ollama model whose weights
 * exceed ~90% of system RAM.
 */

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	// Fixed at 16GB so the 90%-of-RAM boundary is deterministic regardless of the machine running
	// the suite.
	return { ...actual, totalmem: () => 16 * 1024 ** 3 };
});

function lane(succeeded: number, total: number): LaneFitnessScore {
	return { succeeded, total, outcomes: [], meanMs: 0 };
}

function allFailedReport(): ModelFitnessReport {
	return {
		trials: 3,
		research: lane(0, 3),
		worker: lane(0, 3),
		judge: {
			parsed: 0,
			planningElevated: 0,
			planningTotal: 3,
			trivialCheap: 0,
			trivialTotal: 3,
			total: 6,
			outcomes: [],
			meanMs: 0,
		},
		search: lane(0, 3),
		toolCall: lane(0, 3),
		digest: lane(0, 3),
		totalCostUsd: 0,
	};
}

function partialPassReport(): ModelFitnessReport {
	const report = allFailedReport();
	return { ...report, digest: lane(2, 3) };
}

describe("AgentSession.setModel — manual choice advisories", () => {
	it("warns (but still sets the model) when the target has a recorded all-lanes-failed probe on this host", async () => {
		const harness = await createHarness({ models: [{ id: "risky-model" }] });
		try {
			const model = harness.getModel("risky-model")!;
			const canonicalRef = `${model.provider}/${model.id}`;
			FitnessStore.forAgentDir(harness.tempDir).save(canonicalRef, allFailedReport());

			await harness.session.setModel(model);

			expect(harness.session.model?.id).toBe("risky-model"); // never blocked
			const warnings = harness.eventsOfType("warning");
			expect(
				warnings.some(
					(event) =>
						event.message.includes(canonicalRef) &&
						event.message.includes("failed its fitness probe on all surfaces"),
				),
			).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("does not warn when the recorded probe was a partial or full pass", async () => {
		const harness = await createHarness({ models: [{ id: "fine-model" }] });
		try {
			const model = harness.getModel("fine-model")!;
			const canonicalRef = `${model.provider}/${model.id}`;
			FitnessStore.forAgentDir(harness.tempDir).save(canonicalRef, partialPassReport());

			await harness.session.setModel(model);

			expect(harness.eventsOfType("warning").some((event) => event.message.includes("fitness probe"))).toBe(false);
		} finally {
			harness.cleanup();
		}
	});

	it("does not warn when there is no recorded probe at all (unprobed, not failed)", async () => {
		const harness = await createHarness({ models: [{ id: "unprobed-model" }] });
		try {
			await harness.session.setModel(harness.getModel("unprobed-model")!);
			expect(harness.eventsOfType("warning").some((event) => event.message.includes("fitness probe"))).toBe(false);
		} finally {
			harness.cleanup();
		}
	});
});

describe("AgentSession.setModel — manual choice advisory: local (Ollama) model memory footprint", () => {
	function registerOllamaFaux(harness: Awaited<ReturnType<typeof createHarness>>, id: string) {
		const ollamaFaux = registerFauxProvider({ provider: "ollama", models: [{ id }] });
		harness.authStorage.setRuntimeApiKey("ollama", "faux-key");
		harness.session.modelRegistry.registerProvider("ollama", {
			baseUrl: ollamaFaux.models[0].baseUrl,
			apiKey: "faux-key",
			api: ollamaFaux.api,
			models: ollamaFaux.models.map((m) => ({
				id: m.id,
				name: m.name,
				api: m.api,
				reasoning: m.reasoning,
				input: m.input,
				cost: m.cost,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
				baseUrl: m.baseUrl,
			})),
		});
		return ollamaFaux;
	}

	/** Fake local-runtime deps that answer /api/tags with one installed model of the given size. */
	function tagsDeps(name: string, sizeBytes: number) {
		return {
			fetchFn: (async (url: string) => {
				if (String(url).includes("/api/tags")) {
					return new Response(JSON.stringify({ models: [{ name, size: sizeBytes }] }), { status: 200 });
				}
				return new Response("{}", { status: 200 });
			}) as unknown as typeof fetch,
			existsFn: () => true,
			spawnFn: () =>
				({ pid: 1, kill: () => true, unref: () => {}, on: () => undefined }) as unknown as ReturnType<
					NonNullable<import("../src/core/models/local-runtime.ts").LocalRuntimeDeps["spawnFn"]>
				>,
			sleepFn: async () => {},
		};
	}

	it("warns when the installed model's weights exceed ~90% of total system RAM (the reported OOM case)", async () => {
		const harness = await createHarness({ localRuntimeDeps: tagsDeps("big-local:latest", 15 * 1024 ** 3) }); // 15GB of 16GB
		const ollamaFaux = registerOllamaFaux(harness, "big-local:latest");
		try {
			const model = ollamaFaux.getModel("big-local:latest") as Model<string>;
			await harness.session.setModel(model);

			const warnings = harness.eventsOfType("warning");
			expect(
				warnings.some(
					(event) =>
						event.message.includes("ollama/big-local:latest") &&
						event.message.includes("RAM") &&
						event.message.toLowerCase().includes("oom"),
				),
			).toBe(true);
		} finally {
			ollamaFaux.unregister();
			harness.cleanup();
		}
	});

	it("does not warn when the installed model comfortably fits in memory", async () => {
		const harness = await createHarness({ localRuntimeDeps: tagsDeps("small-local:latest", 2 * 1024 ** 3) }); // 2GB of 16GB
		const ollamaFaux = registerOllamaFaux(harness, "small-local:latest");
		try {
			const model = ollamaFaux.getModel("small-local:latest") as Model<string>;
			await harness.session.setModel(model);

			expect(harness.eventsOfType("warning").some((event) => event.message.includes("RAM"))).toBe(false);
		} finally {
			ollamaFaux.unregister();
			harness.cleanup();
		}
	});

	it("never blocks the manual set even when the local server can't be reached to check size", async () => {
		const harness = await createHarness({
			localRuntimeDeps: {
				fetchFn: (async () => {
					throw new Error("ECONNREFUSED");
				}) as unknown as typeof fetch,
				existsFn: () => false,
				spawnFn: () =>
					({ pid: 1, kill: () => true, unref: () => {}, on: () => undefined }) as unknown as ReturnType<
						NonNullable<import("../src/core/models/local-runtime.ts").LocalRuntimeDeps["spawnFn"]>
					>,
				sleepFn: async () => {},
			},
		});
		const ollamaFaux = registerOllamaFaux(harness, "unreachable-local:latest");
		try {
			const model = ollamaFaux.getModel("unreachable-local:latest") as Model<string>;
			await expect(harness.session.setModel(model)).resolves.toBeUndefined();
			expect(harness.session.model?.id).toBe("unreachable-local:latest");
		} finally {
			ollamaFaux.unregister();
			harness.cleanup();
		}
	});
});
