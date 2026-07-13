import { describe, expect, it } from "vitest";
import { StreamingLineDecoder } from "../src/utils/streaming-lines.ts";

describe("StreamingLineDecoder", () => {
	it("decodes mixed line endings split across chunks", () => {
		const decoder = new StreamingLineDecoder(100);
		expect(decoder.push("one\r")).toEqual(["one"]);
		expect(decoder.push("\ntwo\n\rthree\r\nfour")).toEqual(["two", "", "three"]);
		expect(decoder.finish()).toBe("four");
	});

	it("joins one fragmented large line only when the line completes", () => {
		const decoder = new StreamingLineDecoder(100_000);
		const fragment = "x".repeat(1_000);
		for (let index = 0; index < 50; index++) {
			expect(decoder.push(fragment)).toEqual([]);
		}
		expect(decoder.push("\n")).toEqual([fragment.repeat(50)]);
		expect(decoder.finish()).toBeUndefined();
	});

	it("bounds delimiter-less lines", () => {
		const decoder = new StreamingLineDecoder(4);
		decoder.push("1234");
		expect(() => decoder.push("5")).toThrow("4 character line limit");
	});

	it("can discard one oversized line and resume at the next delimiter", () => {
		const decoder = new StreamingLineDecoder(4, { overflow: "skip" });
		expect(decoder.push("oversized")).toEqual([]);
		expect(decoder.push(" still skipped\nok\n")).toEqual(["ok"]);
		expect(decoder.finish()).toBeUndefined();
	});
});
