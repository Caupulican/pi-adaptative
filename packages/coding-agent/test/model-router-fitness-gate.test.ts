import { describe, expect, it } from "vitest";
import {
	evaluateSurfaceFitness,
	type FitnessGatedSurface,
	laneMeetsFitnessBar,
} from "../src/core/model-router/fitness-gate.ts";
import type { LaneFitnessScore, ModelFitnessReport } from "../src/core/research/model-fitness.ts";

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

describe("model router fitness gate doctrine", () => {
	it("applies the shared ceil two-thirds bar", () => {
		expect(laneMeetsFitnessBar(1, 3)).toBe(false);
		expect(laneMeetsFitnessBar(2, 3)).toBe(true);
		expect(laneMeetsFitnessBar(3, 4)).toBe(true);
		expect(laneMeetsFitnessBar(2, 4)).toBe(false);
		expect(laneMeetsFitnessBar(0, 0)).toBe(false);
	});

	it("splits unprobed models by Class A proof-required vs Class B subtractive surfaces", () => {
		const classB: FitnessGatedSurface[] = ["router_cheap", "router_medium", "router_expensive", "router_judge"];
		for (const surface of classB) {
			expect(evaluateSurfaceFitness(surface, undefined)).toEqual({ fit: true, probed: false });
		}
		expect(evaluateSurfaceFitness("executor", undefined)).toEqual({ fit: false, reason: "unprobed" });
		expect(evaluateSurfaceFitness("curation", undefined)).toEqual({ fit: false, reason: "unprobed" });
		expect(evaluateSurfaceFitness("scout_auto", undefined)).toEqual({ fit: false, reason: "unprobed" });
	});

	it("maps each surface to its doctrine lane set", () => {
		expect(evaluateSurfaceFitness("router_cheap", report({ worker: lane(0, 3) }))).toEqual({
			fit: true,
			probed: true,
		});
		expect(evaluateSurfaceFitness("router_cheap", report({ research: lane(1, 3) }))).toMatchObject({
			fit: false,
			lane: "research",
		});
		expect(evaluateSurfaceFitness("router_medium", report({ research: lane(0, 3) }))).toEqual({
			fit: true,
			probed: true,
		});
		expect(evaluateSurfaceFitness("router_medium", report({ worker: lane(1, 3) }))).toMatchObject({
			fit: false,
			lane: "worker",
		});
		expect(evaluateSurfaceFitness("router_expensive", report({ worker: lane(1, 3) }))).toMatchObject({
			fit: false,
			lane: "worker",
		});
		expect(
			evaluateSurfaceFitness("router_judge", report({ judge: { ...report().judge, parsed: 1, total: 3 } })),
		).toMatchObject({ fit: false, lane: "judge", succeeded: 1, total: 3 });
		expect(evaluateSurfaceFitness("executor", report({ toolCall: lane(1, 3) }))).toMatchObject({
			fit: false,
			lane: "toolCall",
		});
		expect(evaluateSurfaceFitness("curation", report({ digest: lane(1, 3) }))).toMatchObject({
			fit: false,
			lane: "digest",
		});
		expect(
			evaluateSurfaceFitness("scout_auto", report({ research: lane(3, 3), toolCall: lane(1, 3) })),
		).toMatchObject({
			fit: false,
			lane: "toolCall",
		});
	});

	it("treats a zero-total required lane as failed", () => {
		expect(evaluateSurfaceFitness("router_cheap", report({ research: lane(0, 0) }))).toEqual({
			fit: false,
			reason: "lane_failed",
			lane: "research",
			succeeded: 0,
			total: 0,
		});
	});

	it("captures the FastContext-shaped report: cheap and scout pass, solver tiers fail worker", () => {
		const fastContext = report({ worker: lane(0, 3), research: lane(3, 3), toolCall: lane(3, 3) });
		expect(evaluateSurfaceFitness("router_cheap", fastContext)).toEqual({ fit: true, probed: true });
		expect(evaluateSurfaceFitness("scout_auto", fastContext)).toEqual({ fit: true, probed: true });
		expect(evaluateSurfaceFitness("router_medium", fastContext)).toMatchObject({ fit: false, lane: "worker" });
		expect(evaluateSurfaceFitness("router_expensive", fastContext)).toMatchObject({ fit: false, lane: "worker" });
	});
});
