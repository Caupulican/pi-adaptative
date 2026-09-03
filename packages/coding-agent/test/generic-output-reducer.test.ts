/**
 * Generic stage contract: only what a terminal never showed as information is removed (ANSI, frames
 * overwritten by `\r`, trailing whitespace, surplus blank lines) and repetition is collapsed with a
 * count; every distinct line survives verbatim and the result is byte-stable.
 */
import { describe, expect, it } from "vitest";
import { reduceGenericOutput, resolveCarriageReturns } from "../src/core/tools/generic-output-reducer.ts";

describe("resolveCarriageReturns", () => {
	it("keeps what the terminal would show after overwriting frames", () => {
		expect(resolveCarriageReturns("Downloading  10%\rDownloading  55%\rDownloading 100%")).toBe("Downloading 100%");
		expect(resolveCarriageReturns("long first frame\rshort")).toBe("shortfirst frame");
		expect(resolveCarriageReturns("plain")).toBe("plain");
	});
});

describe("reduceGenericOutput", () => {
	it("strips ANSI, resolves frames, trims trailing whitespace and collapses blank runs", () => {
		const text = "\u001b[1mBuilding\u001b[0m   \n\n\n\nstep 1\r\nstep [====    ] 40%\rstep [========] 100%\n\ndone\n";
		expect(reduceGenericOutput(text)).toEqual({
			text: "Building\n\nstep 1\nstep [========] 100%\n\ndone\n",
			omittedLines: 2,
			changed: true,
		});
	});

	it("collapses three or more identical consecutive lines and keeps shorter runs verbatim", () => {
		expect(reduceGenericOutput("a\na\nb\nb\nb\nc\n")).toEqual({
			text: "a\na\nb\n[line repeated 3 times]\nc\n",
			omittedLines: 2,
			changed: true,
		});
		expect(reduceGenericOutput("a\na\nb\nb\nc\n", "compact").text).toBe(
			"a\n[line repeated 2 times]\nb\n[line repeated 2 times]\nc\n",
		);
	});

	it("reports no change for clean output", () => {
		const clean = "line one\nline two\n\nline three\n";
		expect(reduceGenericOutput(clean)).toEqual({ text: clean, omittedLines: 0, changed: false });
		expect(reduceGenericOutput("")).toEqual({ text: "", omittedLines: 0, changed: false });
	});

	it("keeps output without a trailing newline without adding one", () => {
		expect(reduceGenericOutput("x  \ny").text).toBe("x\ny");
	});

	it("is deterministic", () => {
		const text = Array.from({ length: 200 }, (_, index) => (index % 7 === 0 ? "\u001b[31mfail\u001b[0m" : "ok")).join(
			"\n",
		);
		expect(reduceGenericOutput(text)).toEqual(reduceGenericOutput(text));
	});
});
