import { beforeAll, describe, expect, it } from "vitest";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

describe("extended thinking-level theme colors", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("uses the highest-intensity border color for max and ultra", () => {
		const xhigh = theme.getThinkingBorderColor("xhigh")("border");

		expect(theme.getThinkingBorderColor("max")("border")).toBe(xhigh);
		expect(theme.getThinkingBorderColor("ultra")("border")).toBe(xhigh);
	});
});
