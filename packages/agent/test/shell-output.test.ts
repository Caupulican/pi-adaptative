import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeBinaryOutput } from "../src/utils/shell-output.ts";

describe("sanitizeBinaryOutput", () => {
	it("removes lone surrogates, DEL, and C1 controls while preserving valid pairs", () => {
		assert.equal(sanitizeBinaryOutput(`a${String.fromCharCode(0xd800)}b`), "ab");
		assert.equal(sanitizeBinaryOutput(`a${String.fromCharCode(0x7f)}b`), "ab");
		assert.equal(sanitizeBinaryOutput(`a${String.fromCharCode(0x85)}b`), "ab");
		assert.equal(sanitizeBinaryOutput("ok 🎉"), "ok 🎉");
	});
});
