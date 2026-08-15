import { describe, expect, it } from "vitest";
import { createShellOutputDecoder } from "../src/core/tools/shell-output-decoder.ts";

describe("Windows-compatible shell output decoding", () => {
	it("preserves UTF-8 split across chunks and recovers Windows-1252 bytes", () => {
		const decoder = createShellOutputDecoder(true);
		const unicode = Buffer.from("ação 日本 €\n", "utf8");
		const split = unicode.indexOf(0xe6) + 2;

		expect(decoder.decode(unicode.subarray(0, split), { stream: true })).toBe("ação ");
		expect(decoder.decode(unicode.subarray(split), { stream: true })).toBe("日本 €\n");
		expect(decoder.decode(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x80]), { stream: true })).toBe("café €");
		expect(decoder.decode()).toBe("");
	});

	it("preserves Unicode across every possible two-chunk boundary", () => {
		const expected = "ação 日本 € — naïve";
		const bytes = Buffer.from(expected, "utf8");
		for (let split = 0; split <= bytes.length; split += 1) {
			const decoder = createShellOutputDecoder(true);
			const decoded =
				decoder.decode(bytes.subarray(0, split), { stream: true }) +
				decoder.decode(bytes.subarray(split), { stream: true }) +
				decoder.decode();
			expect(decoded, `split=${split}`).toBe(expected);
		}
	});

	it("flushes an incomplete legacy lead byte instead of replacing it", () => {
		const decoder = createShellOutputDecoder(true);
		expect(decoder.decode(Buffer.from([0x6f, 0x6c, 0xe1]), { stream: true })).toBe("ol");
		expect(decoder.decode()).toBe("á");
	});

	it("keeps strict UTF-8 behavior outside the Windows shell", () => {
		const decoder = createShellOutputDecoder(false);
		expect(decoder.decode(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toBe("caf�");
	});
});
