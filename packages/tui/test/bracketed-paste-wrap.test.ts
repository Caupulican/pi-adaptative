import assert from "node:assert";
import { describe, it } from "node:test";
import { wrapBracketedPaste } from "../src/bracketed-paste.ts";

describe("wrapBracketedPaste", () => {
	it("wraps payload in the bracketed-paste envelope", () => {
		assert.strictEqual(wrapBracketedPaste("hello"), "\x1b[200~hello\x1b[201~");
	});

	it("does not treat unwrapped text as an envelope", () => {
		assert.notStrictEqual(wrapBracketedPaste("hello"), "hello");
	});
});
