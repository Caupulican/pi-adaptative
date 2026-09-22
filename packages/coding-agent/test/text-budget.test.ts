import { describe, expect, test } from "vitest";
import { shareTextBudget } from "../src/core/util/text-budget.ts";

describe("shareTextBudget", () => {
	test("keeps every line when the list already fits", () => {
		const lines = ["a: one", "b: two", "c: three"];
		expect(shareTextBudget(lines, 200)).toEqual(lines);
	});

	test("the last line of a long list survives a budget the first lines could have eaten", () => {
		const lines = [`huge: ${"x".repeat(400)}`, `huge: ${"y".repeat(400)}`, "tail: never push to main"];
		const fitted = shareTextBudget(lines, 120);
		expect(fitted).toHaveLength(3);
		expect(fitted[2]).toBe("tail: never push to main");
		expect(fitted.join("\n").length).toBeLessThanOrEqual(120);
		expect(fitted[0]?.endsWith(" …")).toBe(true);
	});

	test("a short line hands its unused share to the long ones", () => {
		const generous = shareTextBudget(["s: hi", `l: ${"z".repeat(200)}`], 120);
		const even = shareTextBudget([`l1: ${"z".repeat(200)}`, `l2: ${"z".repeat(200)}`], 120);
		expect((generous[1] as string).length).toBeGreaterThan((even[1] as string).length);
	});

	test("a budget too small for the list keeps the longest prefix that fits", () => {
		expect(shareTextBudget(["abc", "de", "fghi"], 6)).toEqual(["abc", "de"]);
		expect(shareTextBudget(["abc"], 0)).toEqual([]);
		expect(shareTextBudget([], 100)).toEqual([]);
	});
});
