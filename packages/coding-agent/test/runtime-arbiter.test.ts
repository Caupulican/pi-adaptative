import { describe, expect, it } from "vitest";
import {
	planRuntimeResidency,
	type ResidencyControl,
	type RuntimeResidencyAdapter,
	type RuntimeResidentModel,
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
});
