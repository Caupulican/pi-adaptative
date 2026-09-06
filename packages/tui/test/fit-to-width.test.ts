import assert from "node:assert";
import { describe, it } from "node:test";
import { fitToWidth, sliceByColumn, visibleWidth } from "../src/utils.ts";

describe("fitToWidth", () => {
	it("clips overflow without ellipsis and pads when requested", () => {
		assert.strictEqual(fitToWidth("hello", 5), "hello");
		assert.strictEqual(fitToWidth("hello", 8), "hello");
		assert.strictEqual(fitToWidth("hello", 8, true), "hello   ");
		assert.strictEqual(fitToWidth("hello world", 5), "hello");
		assert.strictEqual(visibleWidth(fitToWidth("hello world", 8, true)), 8);
		assert.strictEqual(fitToWidth("hello world", 5), sliceByColumn("hello world", 0, 5, true));
	});

	it("returns empty for non-positive width as a negative control", () => {
		assert.strictEqual(fitToWidth("hello", 0, true), "");
		assert.strictEqual(fitToWidth("hello", -2), "");
	});
});
