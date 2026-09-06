import assert from "node:assert";
import { describe, it } from "node:test";
import { isMouseSequence, parseMouseSequence } from "../src/mouse.ts";

describe("parseMouseSequence", () => {
	it("identifies mouse escape sequence prefixes", () => {
		assert.strictEqual(isMouseSequence("\x1b[<0;1;1M"), true);
		assert.strictEqual(isMouseSequence("\x1b[<64;10;5M"), true);
		assert.strictEqual(isMouseSequence("\x1b[A"), false);
		assert.strictEqual(isMouseSequence("hello"), false);
	});

	it("decodes wheel up and wheel down", () => {
		const wheelUp = parseMouseSequence("\x1b[<64;50;4M");
		assert.deepStrictEqual(wheelUp, {
			action: "scroll",
			button: "wheelUp",
			column: 49,
			row: 3,
			rawButton: 64,
		});

		const wheelDown = parseMouseSequence("\x1b[<65;2;6M");
		assert.deepStrictEqual(wheelDown, {
			action: "scroll",
			button: "wheelDown",
			column: 1,
			row: 5,
			rawButton: 65,
		});
	});

	it("decodes left click press and release", () => {
		const press = parseMouseSequence("\x1b[<0;2;19M");
		assert.deepStrictEqual(press, {
			action: "down",
			button: "left",
			column: 1,
			row: 18,
			rawButton: 0,
		});

		const release = parseMouseSequence("\x1b[<0;2;19m");
		assert.deepStrictEqual(release, {
			action: "up",
			button: "left",
			column: 1,
			row: 18,
			rawButton: 0,
		});
	});

	it("decodes left drag motion", () => {
		const drag = parseMouseSequence("\x1b[<32;7;19M");
		assert.deepStrictEqual(drag, {
			action: "drag",
			button: "left",
			column: 6,
			row: 18,
			rawButton: 32,
		});
	});

	it("returns undefined for non-mouse sequences", () => {
		assert.strictEqual(parseMouseSequence("\x1b[A"), undefined);
		assert.strictEqual(parseMouseSequence(""), undefined);
		assert.strictEqual(parseMouseSequence("foo"), undefined);
	});
});
