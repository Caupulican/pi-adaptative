import { describe, expect, it } from "vitest";
import { paintChangedTerminalRows } from "../src/terminal-render-diff.ts";

describe("differential terminal row output", () => {
	it("skips a stable text row within the previous viewport", () => {
		const previous = ["a", "stable middle row", "b"];
		const next = ["x", previous[1]!, "y"];
		expect(paintChangedTerminalRows(previous, next, 0, 2, 40, true)).toBe("x\r\x1b[2By");
	});

	it("keeps sequential writes for a viewport shift or a cheap empty gap", () => {
		const previous = ["a", "stable middle row", "b"];
		const next = ["x", previous[1]!, "y"];
		expect(paintChangedTerminalRows(previous, next, 0, 2, 40, false)).toBe("x\r\nstable middle row\r\ny");
		expect(paintChangedTerminalRows(["a", "", "b"], ["x", "", "y"], 0, 2, 40, true)).toBe("x\r\n\r\ny");
	});

	it("clears the tail of a shortened row before jumping over an unchanged row", () => {
		const previous = ["old text", "stable middle row", "b"];
		const next = ["x", previous[1]!, "y"];
		expect(paintChangedTerminalRows(previous, next, 0, 2, 40, true)).toBe("x\x1b[K\r\x1b[2By");
	});
});
