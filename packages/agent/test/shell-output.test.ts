import { describe, expect, it } from "vitest";
import { sanitizeBinaryOutput } from "../src/utils/shell-output.ts";

describe("sanitizeBinaryOutput", () => {
	it("removes lone surrogates, DEL, and C1 controls while preserving valid pairs", () => {
		expect(sanitizeBinaryOutput(`a${String.fromCharCode(0xd800)}b`)).toBe("ab");
		expect(sanitizeBinaryOutput(`a${String.fromCharCode(0x7f)}b`)).toBe("ab");
		expect(sanitizeBinaryOutput(`a${String.fromCharCode(0x85)}b`)).toBe("ab");
		expect(sanitizeBinaryOutput("ok 🎉")).toBe("ok 🎉");
	});
});
