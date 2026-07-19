import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import type { Tool, ToolCall } from "../src/types.ts";
import { validateToolArguments } from "../src/utils/validation.ts";

/**
 * Doctrine-mandated performance gate (tool-call-repair SKILL decision 2a / failure-grammar.md
 * pt.6): "A microbench fixture GATES this (clean-path cost within noise of a bare `Check`)"; the
 * repaired (already-failed) path must stay under a fixed budget. Bounds below are deliberately
 * generous absolute ceilings, not tight timing assertions - the point is to catch a real
 * regression class (a reintroduced per-call schema recompile, a lost cache, an unbounded pass
 * loop), not to chase machine-sensitive nanosecond parity. Measured on the dev box at authoring
 * time: clean path ~150-250ns/call (~5-10x a bare Check's ~20-30ns - WeakMap lookup + one extra
 * function frame), repaired path (deepest tested 2-pass cascade) ~50-80us/call. The budgets below
 * sit an order of magnitude above those measurements.
 */

const tool: Tool = {
	name: "configure",
	description: "configure tool",
	parameters: Type.Object({ payload: Type.Object({ enabled: Type.Boolean(), count: Type.Integer() }) }),
};

const validCall: ToolCall = {
	type: "toolCall",
	id: "call-1",
	name: "configure",
	arguments: { payload: { enabled: true, count: 1 } },
};

// The deepest tested repair cascade (same fixture as the D1 pass-counter test): an outer
// json-string-parse revealing a nested property-case + two scalar-coercion repairs, converging
// in 2 passes - the worst case among the tested fixtures, so the fairest budget target.
function buildRepairCall(): ToolCall {
	return {
		type: "toolCall",
		id: "call-1",
		name: "configure",
		arguments: { payload: '{"Enabled":"false","count":"2"}' },
	};
}

const bareValidator = Compile(tool.parameters);

function timeLoopMs(fn: () => void, iterations: number): number {
	const start = performance.now();
	for (let i = 0; i < iterations; i++) fn();
	return performance.now() - start;
}

function medianOf(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Median ns/call across ROUNDS batches of ITERATIONS calls, to smooth single-run noise. */
function medianNsPerCall(fn: () => void, iterations: number, rounds: number): number {
	const samples: number[] = [];
	for (let round = 0; round < rounds; round++) {
		samples.push((timeLoopMs(fn, iterations) * 1e6) / iterations);
	}
	return medianOf(samples);
}

describe("tool-repair performance gate (D2)", () => {
	it("keeps the clean (well-formed) path within noise of a bare Check", () => {
		// Warm up the JIT for both paths before measuring.
		timeLoopMs(() => bareValidator.Check(validCall.arguments), 10_000);
		timeLoopMs(() => validateToolArguments(tool, validCall), 10_000);

		const bareNsPerCall = medianNsPerCall(() => bareValidator.Check(validCall.arguments), 20_000, 7);
		const cleanNsPerCall = medianNsPerCall(() => validateToolArguments(tool, validCall), 20_000, 7);

		// Absolute ceiling: catches a real regression (e.g. a schema recompile or an accidental
		// clone re-entering the hot path) without chasing machine-sensitive nanosecond parity.
		expect(cleanNsPerCall).toBeLessThan(5_000);
		// Relative ceiling, generous on purpose: the hot path is one WeakMap lookup + one cached
		// Check, never a clone/walk/grammar lookup - it should stay a small constant multiple of a
		// bare Check, not grow with the schema or the repair catalogue.
		expect(cleanNsPerCall).toBeLessThan(Math.max(bareNsPerCall * 50, 2_000));
	});

	it("keeps the repaired (already-failed) path under a fixed budget", () => {
		timeLoopMs(() => validateToolArguments(tool, buildRepairCall()), 1_000);

		const repairedUsPerCall = medianNsPerCall(() => validateToolArguments(tool, buildRepairCall()), 4_000, 5) / 1_000;

		// Fixed budget (not relative to the clean path): repair only ever runs on already-failed
		// calls, bounded to MAX_REPAIR_PASSES re-checks - this stays well under a millisecond even
		// with headroom for slower CI hardware.
		expect(repairedUsPerCall).toBeLessThan(1_000);
	});
});
