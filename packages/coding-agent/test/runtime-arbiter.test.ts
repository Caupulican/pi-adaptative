import { describe, expect, it } from "vitest";
import {
	AdvisoryRuntimeResidencyAdapter,
	OllamaRuntimeResidencyAdapter,
	planRuntimeResidency,
	type ResidencyControl,
	type RuntimeResidencyAdapter,
	RuntimeResidencyArbiter,
	type RuntimeResidentModel,
	TransformersRuntimeResidencyAdapter,
} from "../src/core/models/runtime-arbiter.ts";

function resident(overrides: Partial<RuntimeResidentModel>): RuntimeResidentModel {
	return {
		adapterId: "runtime-a",
		model: "resident",
		bytes: 1_000,
		lastUsedAtMs: 0,
		priority: 1,
		residencyControl: "keep-alive",
		...overrides,
	};
}

class FauxRuntimeAdapter implements RuntimeResidencyAdapter {
	readonly id: string;
	readonly residencyControl: ResidencyControl;
	private readonly residents: Set<string>;

	constructor(id: string, residencyControl: ResidencyControl, residentModels: string[] = []) {
		this.id = id;
		this.residencyControl = residencyControl;
		this.residents = new Set(residentModels);
	}

	async list(): Promise<RuntimeResidentModel[]> {
		return [...this.residents].map((model, index) =>
			resident({ adapterId: this.id, model, lastUsedAtMs: index, residencyControl: this.residencyControl }),
		);
	}

	async ensureResident(model: string): Promise<void> {
		this.residents.add(model);
	}

	async release(model: string): Promise<void> {
		if (this.residencyControl !== "advisory") this.residents.delete(model);
	}
}

describe("runtime residency arbiter", () => {
	it("fits a request that is already within the host RAM budget", () => {
		expect(
			planRuntimeResidency({
				budgetBytes: 4_000,
				residents: [resident({ model: "a", bytes: 1_000 })],
				request: { model: "b", bytes: 1_000, role: "active", priority: 10, nowMs: 10 },
			}),
		).toMatchObject({ status: "fits", evict: [] });
	});

	it("evicts by role-aware priority and LRU while preserving the active pinned model", () => {
		const active = resident({ model: "active", bytes: 2_000, priority: 100, pinned: true, lastUsedAtMs: 1 });
		const bench = resident({ model: "bench", bytes: 2_000, priority: 0, lastUsedAtMs: 2 });
		const router = resident({ model: "router", bytes: 2_000, priority: 5, lastUsedAtMs: 0 });

		const plan = planRuntimeResidency({
			budgetBytes: 5_000,
			residents: [active, bench, router],
			request: { model: "next", bytes: 2_000, role: "active", priority: 10, nowMs: 10, pinActiveModel: "active" },
		});

		expect(plan.status).toBe("fits");
		expect(plan.evict.map((entry) => entry.model)).toEqual(["bench", "router"]);
	});

	it("refuses when only pinned, advisory, or dwell-protected residents could make room", () => {
		const plan = planRuntimeResidency({
			budgetBytes: 2_000,
			residents: [
				resident({ model: "active", bytes: 1_500, pinned: true }),
				resident({ model: "external", bytes: 1_500, residencyControl: "advisory" }),
				resident({ model: "fresh", bytes: 1_500, lastUsedAtMs: 950 }),
			],
			request: { model: "next", bytes: 1_500, role: "active", priority: 10, nowMs: 1_000, minDwellMs: 100 },
		});

		expect(plan).toMatchObject({ status: "refuse", reason: "insufficient-evictable-memory" });
	});

	it("refuses ping-pong plans inside the minimum dwell window", () => {
		const plan = planRuntimeResidency({
			budgetBytes: 2_000,
			residents: [resident({ model: "b", bytes: 1_500 })],
			request: {
				model: "a",
				bytes: 1_500,
				role: "active",
				priority: 10,
				nowMs: 1_050,
				minDwellMs: 100,
				recentEvictions: [{ evicted: "a", loaded: "b", atMs: 1_000 }],
			},
		});

		expect(plan).toMatchObject({ status: "refuse", reason: "anti-thrash" });
	});

	it("plans pipeline reservations as an all-or-nothing fit", () => {
		const fits = planRuntimeResidency({
			budgetBytes: 10_000,
			residents: [],
			request: {
				model: "muscle-9b",
				bytes: 7_500,
				role: "active",
				priority: 10,
				nowMs: 1,
				reservations: [{ model: "brain-1.7b", bytes: 1_500, priority: 8 }],
			},
		});
		const refuses = planRuntimeResidency({
			budgetBytes: 8_000,
			residents: [],
			request: {
				model: "muscle-9b",
				bytes: 7_500,
				role: "active",
				priority: 10,
				nowMs: 1,
				reservations: [{ model: "brain-1.7b", bytes: 1_500, priority: 8 }],
			},
		});

		expect(fits.status).toBe("fits");
		expect(refuses).toMatchObject({ status: "refuse" });
	});

	it("exercises adapter contract shapes against faux full, keep-alive, and advisory runtimes", async () => {
		const full = new FauxRuntimeAdapter("full", "full", ["sidecar"]);
		const keepAlive = new FauxRuntimeAdapter("keep", "keep-alive", ["ollama-model"]);
		const advisory = new FauxRuntimeAdapter("external", "advisory", ["external-model"]);

		await full.release("sidecar");
		await keepAlive.ensureResident("new-ollama-model");
		await advisory.release("external-model");

		expect((await full.list()).map((entry) => entry.model)).toEqual([]);
		expect((await keepAlive.list()).map((entry) => entry.model).sort()).toEqual(["new-ollama-model", "ollama-model"]);
		expect((await advisory.list()).map((entry) => entry.model)).toEqual(["external-model"]);
	});

	it("adapts real Ollama, Transformers, and external residency contract shapes", async () => {
		const loaded = new Set(["ollama-a"]);
		const ollama = new OllamaRuntimeResidencyAdapter("ollama", {
			listResidentModels: async () => [...loaded].map((name) => ({ name, sizeBytes: 2_000 })),
			ensureResident: async (model) => {
				loaded.add(model);
				return { ok: true };
			},
			releaseResident: async (model) => {
				loaded.delete(model);
				return { ok: true };
			},
		});
		let sidecarRunning = true;
		const transformers = new TransformersRuntimeResidencyAdapter(
			"transformers",
			{
				detect: async () => ({ serverUp: sidecarRunning }) as never,
				start: async () => {
					sidecarRunning = true;
					return { started: true, reason: "started" };
				},
				stop: () => {
					sidecarRunning = false;
					return { stopped: true };
				},
			},
			"sidecar-model",
			1_000,
		);
		const external = new AdvisoryRuntimeResidencyAdapter("external", [
			{ model: "external-model", bytes: 3_000, lastUsedAtMs: 0, priority: 0 },
		]);

		expect((await ollama.list())[0]).toMatchObject({ residencyControl: "keep-alive" });
		expect((await transformers.list())[0]).toMatchObject({ residencyControl: "full", model: "sidecar-model" });
		await external.release("external-model");
		expect((await external.list())[0]).toMatchObject({ residencyControl: "advisory" });
	});

	it("applies arbiter evictions and refuses synthetic 10GB reservations honestly", async () => {
		const ollama = new FauxRuntimeAdapter("ollama", "keep-alive", ["resident-9b"]);
		const transformers = new FauxRuntimeAdapter("transformers", "full");
		const arbiter = new RuntimeResidencyArbiter({ budgetBytes: 10_000, adapters: [ollama, transformers] });

		const fit = await arbiter.ensureResident("transformers", {
			model: "brain-1.7b",
			bytes: 1_500,
			role: "router",
			priority: 8,
			nowMs: 10,
			reservations: [{ model: "muscle-9b", bytes: 8_300, priority: 10 }],
		});
		expect(fit.status).toBe("fits");
		expect(fit.evict.map((entry) => entry.model)).toEqual(["resident-9b"]);
		expect((await ollama.list()).map((entry) => entry.model)).toEqual([]);
		expect((await transformers.list()).map((entry) => entry.model)).toEqual(["brain-1.7b"]);

		const refuse = await new RuntimeResidencyArbiter({
			budgetBytes: 10_000,
			adapters: [new FauxRuntimeAdapter("ollama", "keep-alive")],
		}).ensureResident("ollama", {
			model: "muscle-9b",
			bytes: 9_000,
			role: "active",
			priority: 10,
			nowMs: 10,
			reservations: [{ model: "brain-1.7b", bytes: 1_700, priority: 8 }],
		});
		expect(refuse).toMatchObject({ status: "refuse", reason: "insufficient-evictable-memory" });
	});

	it("keeps identical model names distinct across runtime adapters when planning memory", async () => {
		const first = new FauxRuntimeAdapter("ollama-11434", "keep-alive", ["same-model"]);
		const second = new FauxRuntimeAdapter("ollama-22345", "keep-alive");
		const arbiter = new RuntimeResidencyArbiter({ budgetBytes: 1_000, adapters: [first, second] });

		const plan = await arbiter.ensureResident("ollama-22345", {
			model: "same-model",
			bytes: 1_000,
			role: "active",
			priority: 10,
			nowMs: 1,
		});

		expect(plan.status).toBe("fits");
		expect(plan.evict).toMatchObject([{ adapterId: "ollama-11434", model: "same-model" }]);
		expect((await second.list()).map((entry) => entry.model)).toEqual(["same-model"]);
	});

	it("can admit without synchronously loading and skips redundant loads for resident models", async () => {
		const adapter = new FauxRuntimeAdapter("ollama", "keep-alive", ["warm"]);
		const arbiter = new RuntimeResidencyArbiter({ budgetBytes: 10_000, adapters: [adapter] });

		await arbiter.ensureResident("ollama", {
			model: "cold",
			bytes: 1_000,
			role: "active",
			priority: 10,
			nowMs: 1,
			loadModel: false,
		});
		expect((await adapter.list()).map((entry) => entry.model)).toEqual(["warm"]);

		await arbiter.ensureResident("ollama", {
			model: "warm",
			bytes: 1_000,
			role: "active",
			priority: 10,
			nowMs: 2,
		});
		expect((await adapter.list()).map((entry) => entry.model)).toEqual(["warm"]);
	});
});
