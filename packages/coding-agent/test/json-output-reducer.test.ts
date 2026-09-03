/**
 * JSON reducer contract: the document keeps its shape, arrays keep their head, tail and every
 * anomalous item with one marker where the cut is, long strings are clipped with their length, and
 * small or non-JSON output passes through untouched.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyCommandFamily } from "../src/core/tools/command-family.ts";
import { isAnomalousItem, jsonOutputReducer, reduceJsonOutput } from "../src/core/tools/json-output-reducer.ts";

const fixtures = join(import.meta.dirname, "fixtures", "tool-output");
const request = { tool: "bash", command: "gh api repos/o/r/items", text: "", exitCode: 0, level: "standard" as const };

describe("isAnomalousItem", () => {
	it("flags errors and non-ok statuses, not plain records", () => {
		expect(isAnomalousItem({ id: 1, status: "ok" })).toBe(false);
		expect(isAnomalousItem({ id: 1, status: "failed" })).toBe(true);
		expect(isAnomalousItem({ id: 1, error: "boom" })).toBe(true);
		expect(isAnomalousItem({ id: 1, error: null, errors: [] })).toBe(false);
		expect(isAnomalousItem({ id: 1, status: 500 })).toBe(true);
		expect(isAnomalousItem({ id: 1, status: 200, conclusion: "success" })).toBe(false);
		expect(isAnomalousItem({ id: 1, level: "error" })).toBe(true);
		expect(isAnomalousItem("text")).toBe(false);
	});
});

describe("reduceJsonOutput", () => {
	it("keeps head, tail, anomalies and one marker in a long array, clipping long strings", () => {
		const items = Array.from({ length: 100 }, (_, index) => ({
			id: index,
			status: index === 57 ? "failed" : "ok",
			payload: "x".repeat(300),
		}));
		const raw = `${JSON.stringify({ items }, null, 2)}\n`;
		const reduced = reduceJsonOutput(raw);
		expect(reduced).toBeDefined();
		const parsed = JSON.parse(reduced!.text) as { items: unknown[] };
		expect(parsed.items).toHaveLength(6);
		expect(parsed.items.slice(0, 3).map((item) => (item as { id: number }).id)).toEqual([0, 1, 2]);
		expect(parsed.items[3]).toBe("[… 95 more items]");
		expect(parsed.items[4]).toMatchObject({ id: 57, status: "failed" });
		expect(parsed.items[5]).toMatchObject({ id: 99 });
		expect((parsed.items[0] as { payload: string }).payload).toBe(`${"x".repeat(120)}… [+180 chars]`);
		expect(reduced!.omittedItems).toBe(95);
		expect(reduced!.text.length).toBeLessThan(raw.length * 0.1);
		expect(reduced!.text.endsWith("\n")).toBe(true);
	});

	it("keeps compact documents compact and short arrays whole", () => {
		const raw = JSON.stringify({ list: [1, 2, 3, 4, 5, 6], note: "n".repeat(3000) });
		const reduced = reduceJsonOutput(raw);
		expect(reduced).toBeDefined();
		expect(reduced!.text.includes("\n")).toBe(false);
		expect(JSON.parse(reduced!.text)).toMatchObject({ list: [1, 2, 3, 4, 5, 6] });
		expect(reduced!.clippedStrings).toBe(1);
	});

	it("passes through small documents, non-JSON text and documents with nothing to cut", () => {
		expect(reduceJsonOutput('{"a":1}')).toBeUndefined();
		expect(reduceJsonOutput(`not json ${"x".repeat(3000)}`)).toBeUndefined();
		const flat = JSON.stringify({
			rows: Array.from({ length: 5 }, (_, index) => ({ id: index, v: "s".repeat(100) })),
		});
		expect(reduceJsonOutput(`${flat}${" ".repeat(3000)}`)).toBeUndefined();
	});

	it("reduces the fixture list and applies through the registered reducer", () => {
		const raw = readFileSync(join(fixtures, "json-list.json"), "utf-8");
		const classification = classifyCommandFamily(request.command);
		expect(jsonOutputReducer.applies(classification, { ...request, text: raw })).toBe(true);
		expect(jsonOutputReducer.applies(classification, { ...request, text: "plain\n" })).toBe(false);
		const reduced = jsonOutputReducer.reduce(classification, { ...request, text: raw });
		expect(reduced).toBeDefined();
		expect(reduced!.text.length).toBeLessThan(raw.length * 0.5);
		expect(JSON.parse(reduced!.text)).toHaveProperty("items");
	});

	it("is deterministic", () => {
		const raw = readFileSync(join(fixtures, "json-list.json"), "utf-8");
		expect(reduceJsonOutput(raw)).toEqual(reduceJsonOutput(raw));
	});
});
