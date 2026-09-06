import assert from "node:assert";
import { describe, it } from "node:test";
import { isLegacyMultilineNewline, matchesKey, setKittyProtocolActive } from "../src/keys.ts";

describe("isLegacyMultilineNewline", () => {
	it("covers editor sequences keys cannot express as a single KeyId", () => {
		setKittyProtocolActive(false);
		assert.strictEqual(isLegacyMultilineNewline("\n"), true);
		assert.strictEqual(isLegacyMultilineNewline("\x1b\r"), true);
		assert.strictEqual(isLegacyMultilineNewline("\x1b[13;2~"), true);
		assert.strictEqual(isLegacyMultilineNewline("\n extra"), true);
		assert.strictEqual(isLegacyMultilineNewline("\x1bX\r"), true);
		assert.strictEqual(isLegacyMultilineNewline("a"), false);
		assert.strictEqual(isLegacyMultilineNewline("\r"), false);
	});

	it("does not replace named shift+enter matching", () => {
		setKittyProtocolActive(true);
		assert.strictEqual(matchesKey("\n", "shift+enter"), true);
		assert.strictEqual(matchesKey("\r", "shift+enter"), false);
		setKittyProtocolActive(false);
	});
});
