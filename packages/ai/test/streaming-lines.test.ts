import { describe, expect, it } from "vitest";
import { StreamingLineDecoder } from "../src/utils/streaming-lines.ts";

describe("StreamingLineDecoder", () => {
	it("does not break split CRLF when an empty chunk intervenes", () => {
		const decoder = new StreamingLineDecoder(100);
		expect(decoder.push("one\r")).toEqual(["one"]);
		expect(decoder.push("")).toEqual([]);
		expect(decoder.push("\ntwo\n")).toEqual(["two"]);
	});

	it("retains only the capture window while counting an oversized fragmented line", () => {
		const decoder = new StreamingLineDecoder(8, { overflow: "window", startColumn: 100 });
		for (let index = 0; index < 1000; index++) decoder.pushRecords("x".repeat(1000));
		const retained = (decoder as unknown as { parts: string[] }).parts.reduce((sum, part) => sum + part.length, 0);
		expect(retained).toBeLessThanOrEqual(10);
		expect(decoder.pushRecords("\nend\n")).toEqual([
			{ text: "xxxxxxxx", startColumn: 100, totalChars: 1_000_000 },
			{ text: "", startColumn: 3, totalChars: 3 },
		]);
		expect(decoder.finishRecord()).toBeUndefined();
	});

	it("counts overlong unterminated and empty lines without inventing a trailing line", () => {
		const decoder = new StreamingLineDecoder(0, { overflow: "window", lineEndings: "lf" });
		expect(decoder.pushRecords("long\n\nlast")).toEqual([
			{ text: "", startColumn: 0, totalChars: 4 },
			{ text: "", startColumn: 0, totalChars: 0 },
		]);
		expect(decoder.finishRecord()).toEqual({ text: "", startColumn: 0, totalChars: 4 });
		expect(decoder.finishRecord()).toBeUndefined();
	});

	it("keeps split surrogate pairs intact at both window boundaries", () => {
		const decoder = new StreamingLineDecoder(1, { overflow: "window", startColumn: 2 });
		decoder.pushRecords("a\ud83d");
		decoder.pushRecords("\ude42b");
		expect(decoder.finishRecord()).toEqual({ text: "🙂", startColumn: 1, totalChars: 4 });
	});
	it("decodes mixed line endings split across chunks", () => {
		const decoder = new StreamingLineDecoder(100);
		expect(decoder.push("one\r")).toEqual(["one"]);
		expect(decoder.push("\ntwo\n\rthree\r\nfour")).toEqual(["two", "", "three"]);
		expect(decoder.finish()).toBe("four");
	});

	it("keeps window records invariant across every two-chunk partition and empty chunks", () => {
		const source = "a🙂bc\r\n\n🙂xyz\rlast";
		for (let startColumn = 0; startColumn < 7; startColumn++) {
			for (let width = 1; width < 7; width++) {
				const options = { overflow: "window" as const, startColumn };
				const reference = new StreamingLineDecoder(width, options);
				const expected = [...reference.pushRecords(source), reference.finishRecord()];
				for (let split = 0; split <= source.length; split++) {
					const decoder = new StreamingLineDecoder(width, options);
					const actual = [
						...decoder.pushRecords(source.slice(0, split)),
						...decoder.pushRecords(""),
						...decoder.pushRecords(source.slice(split)),
						decoder.finishRecord(),
					];
					expect(actual).toEqual(expected);
					for (const record of actual) expect(record?.text.isWellFormed()).toBe(true);
				}
			}
		}
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
