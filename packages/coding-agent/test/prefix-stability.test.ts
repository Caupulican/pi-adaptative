import { describe, expect, it } from "vitest";
import {
	frozenPrefixLength,
	quantizeRecentBoundary,
	resolveRecentBoundaryStride,
} from "../src/core/context/prefix-stability.ts";

describe("frozenPrefixLength", () => {
	it("reproduces sentPrefixCount exactly when the target's leading messages are untouched", () => {
		const source = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
		// A well-behaved transform: the first 3 entries keep their exact object identity, a new one
		// is appended after.
		const target = [...source.slice(0, 3), { id: "new" }];
		expect(frozenPrefixLength(source, 3, target)).toBe(3);
	});

	it("clamps to sentPrefixCount when it is smaller than both arrays", () => {
		const source = [{ id: "a" }, { id: "b" }, { id: "c" }];
		const target = [...source];
		expect(frozenPrefixLength(source, 1, target)).toBe(1);
	});

	it("clamps to source.length when sentPrefixCount overshoots it", () => {
		const source = [{ id: "a" }, { id: "b" }];
		const target = [...source, { id: "c" }];
		expect(frozenPrefixLength(source, 100, target)).toBe(2);
	});

	it("clamps to target.length when target is shorter than the mark", () => {
		const source = [{ id: "a" }, { id: "b" }, { id: "c" }];
		const target = source.slice(0, 1);
		expect(frozenPrefixLength(source, 3, target)).toBe(1);
	});

	it("degrades to the longest matching run when a transform disturbs the marked prefix", () => {
		const a = { id: "a" };
		const b = { id: "b" };
		const c = { id: "c" };
		const source = [a, b, c];
		// A disruptive transform removed `b` from the middle of the still-unsent-when-this-plan-
		// started prefix, shifting `c` into its place -- position 1 no longer matches by reference.
		const target = [a, c];
		expect(frozenPrefixLength(source, 3, target)).toBe(1);
	});

	it("returns 0 when the very first message no longer matches (e.g. a prepend)", () => {
		const a = { id: "a" };
		const b = { id: "b" };
		const source = [a, b];
		const target = [{ id: "prepended" }, a, b];
		expect(frozenPrefixLength(source, 2, target)).toBe(0);
	});

	it("returns 0 for sentPrefixCount 0 regardless of how much the arrays share", () => {
		const source = [{ id: "a" }, { id: "b" }];
		const target = [...source];
		expect(frozenPrefixLength(source, 0, target)).toBe(0);
	});

	it("treats a negative or non-finite sentPrefixCount as 0 rather than throwing", () => {
		const source = [{ id: "a" }];
		const target = [...source];
		expect(frozenPrefixLength(source, -5, target)).toBe(0);
		expect(frozenPrefixLength(source, Number.NaN, target)).toBe(0);
	});
});

// Existing coverage for the sibling boundary helpers lived only indirectly through context-gc's own
// tests; a couple of direct cases here document the contract this module's newest function
// (frozenPrefixLength, above) now shares a file with.
describe("quantizeRecentBoundary / resolveRecentBoundaryStride", () => {
	it("quantizes onto the resolved stride", () => {
		const stride = resolveRecentBoundaryStride(24);
		expect(stride).toBe(12);
		expect(quantizeRecentBoundary(23, stride)).toBe(12);
		expect(quantizeRecentBoundary(24, stride)).toBe(24);
	});
});
