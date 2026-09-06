import assert from "node:assert";
import { describe, it } from "node:test";
import { getCenteredVisibleRange } from "../src/list-window.ts";

describe("getCenteredVisibleRange", () => {
	it("computes a bounded centered window", () => {
		assert.deepStrictEqual(getCenteredVisibleRange(2, 20, 8), { startIndex: 0, endIndex: 8 });
		assert.deepStrictEqual(getCenteredVisibleRange(10, 20, 8), { startIndex: 6, endIndex: 14 });
		assert.deepStrictEqual(getCenteredVisibleRange(19, 20, 8), { startIndex: 12, endIndex: 20 });
	});

	it("returns an empty range when there is nothing to show", () => {
		assert.deepStrictEqual(getCenteredVisibleRange(0, 0, 8), { startIndex: 0, endIndex: 0 });
		assert.deepStrictEqual(getCenteredVisibleRange(3, 10, 0), { startIndex: 0, endIndex: 0 });
	});
});
