import { describe, expect, it } from "vitest";
import {
	arenaUnitFeatures,
	buildArena,
	ScoringScratch,
	scoreProbe,
	type UnitFeatures,
} from "../../src/core/system-one/code-unit-arena.ts";

const unit = (id: number, calls: number[], windows: number[], tokenCount = 20): UnitFeatures => ({
	calls: Int32Array.from(calls).sort(),
	windows: Int32Array.from(windows).sort(),
	tokenCount,
	pathId: id,
	nameId: id,
	codeId: id,
});

const parameters = { minSimilarity: 0.35, structuralMinTokens: 50, limit: 5 };

describe("code unit arena", () => {
	it("scores a unit reached only through shared structure with its full cosine, common calls included", () => {
		// Call 0 is in 12 of 16 units: common enough that its posting is not traversed, not so common that
		// it weighs nothing. Units 0 and 1 share structure, so they meet through their windows.
		const units = [
			unit(0, [0], [101, 102, 103]),
			unit(1, [0], [101, 102, 103]),
			...Array.from({ length: 10 }, (_, index) => unit(index + 2, [0], [500 + index])),
			...Array.from({ length: 4 }, (_, index) => unit(index + 12, [9], [700 + index])),
		];
		const arena = buildArena(units, 10);
		const scored = scoreProbe(arena, arenaUnitFeatures(arena, 0), 0, parameters, new ScoringScratch(units.length));
		expect(scored.map((candidate) => [candidate.unit, candidate.callSimilarity])).toEqual([[1, 1]]);
	});

	it("ranks by IDF-weighted shared calls and never returns the probe itself", () => {
		const units = [unit(0, [1, 2], [1]), unit(1, [1, 2], [2]), unit(2, [3], [3]), unit(3, [1], [4])];
		const arena = buildArena(units, 4);
		const scratch = new ScoringScratch(units.length);
		const scored = scoreProbe(arena, arenaUnitFeatures(arena, 0), 0, parameters, scratch);
		expect(scored[0]?.unit).toBe(1);
		expect(scored.some((candidate) => candidate.unit === 0)).toBe(false);
		// The scratch is clean after a probe: a second identical probe scores identically.
		expect(scoreProbe(arena, arenaUnitFeatures(arena, 0), 0, parameters, scratch)).toEqual(scored);
	});

	it("measures structural overlap against the larger unit, only above the token minimum", () => {
		const big = Array.from({ length: 10 }, (_, index) => index + 1);
		const units = [unit(0, [], big, 60), unit(1, [], big, 60), unit(2, [], big, 10)];
		const arena = buildArena(units, 0);
		const scored = scoreProbe(arena, arenaUnitFeatures(arena, 0), 0, parameters, new ScoringScratch(3));
		expect(scored.map((candidate) => [candidate.unit, candidate.structuralSimilarity])).toEqual([[1, 1]]);
	});
});
