import { describe, expect, it } from "vitest";
import { reduceJsonOutput, suggestJqProjection } from "../src/core/tools/json-output-reducer.ts";
import { formatOutputReductionNotice, reduceToolOutput } from "../src/core/tools/output-reduction.ts";
import "../src/core/tools/output-reducers.ts";

const largeKey = (prefix: string) => `${prefix}_${"field".repeat(18)}`;

describe("columnar JSON tool output", () => {
	it("keeps all rows when they fit and preserves scalar types, row order and escaped values", () => {
		const columns = ["label", "count", "active", "result", "remark"].map(largeKey);
		const rows = [
			['quote:" newline:\n tab:\t slash:\\', 1.25, false, null, "日本語"],
			["second", 2, true, "7", "text"],
			["third", -3, null, 7, ""],
			["fourth", 4, false, true, "text"],
			["fifth", 5, true, false, "text"],
			["sixth", 6, null, null, "end"],
		];
		const source = JSON.stringify(
			rows.map((row, index) => {
				const entries = columns.map((column, cell) => [column, row[cell]]);
				return Object.fromEntries(index % 2 === 0 ? entries : entries.reverse());
			}),
			null,
			2,
		);
		const reduced = reduceJsonOutput(source);
		expect(reduced).toMatchObject({ omittedItems: 0, clippedStrings: 0, omittedLines: 0 });
		expect(JSON.parse(reduced!.text)).toEqual({ $format: "columnar-json", columns, rows });
	});

	it("prefers all records to the ordinary head and tail sample when the shared columns make them fit", () => {
		const columns = ["name", "age", "enabled", "optional"].map(largeKey);
		const rows = Array.from({ length: 12 }, (_, id) => [id, id + 20, id % 2 === 0, null]);
		const input = JSON.stringify(
			rows.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]]))),
		);
		const reduced = reduceJsonOutput(input);
		expect(reduced).toMatchObject({ omittedItems: 0, omittedLines: 0 });
		expect(JSON.parse(reduced!.text)).toEqual({ $format: "columnar-json", columns, rows });
	});

	it("keeps sampled anomalies in original order and gives the omitted count and original indices", () => {
		const detailKey = largeKey("payload");
		const idKey = largeKey("identifier");
		const values = Array.from({ length: 30 }, (_, index) => ({
			[idKey]: index,
			[detailKey]: "x".repeat(100),
			status: index === 8 || index === 17 ? "error" : "ok",
		}));
		const reduced = reduceJsonOutput(JSON.stringify(values, null, 2));
		const expected = [0, 1, 2, 8, 17, 29];
		expect(reduced).toMatchObject({ omittedItems: 24, clippedStrings: 0 });
		expect(JSON.parse(reduced!.text)).toEqual({
			$format: "columnar-json",
			columns: [idKey, detailKey, "status"],
			rows: expected.map((index) => [index, values[index]![detailKey], values[index]!.status]),
			sourceRowIndices: expected,
			omittedRows: 24,
		});
	});

	it("leaves mixed or nested rows in the normal JSON shape and retains an own __proto__ field", () => {
		const input = {
			["__proto__"]: { marker: true },
			rows: Array.from({ length: 12 }, (_, index) => ({ id: index, nested: { text: "x".repeat(300) } })),
		};
		const reduced = reduceJsonOutput(JSON.stringify(input, null, 2));
		const result = JSON.parse(reduced!.text);
		expect(Object.hasOwn(result, "__proto__")).toBe(true);
		expect(Object.getOwnPropertyDescriptor(result, "__proto__")?.value).toEqual({ marker: true });
		expect(result.rows).toBeInstanceOf(Array);
		expect(result.rows.at(-1).id).toBe(11);
	});

	it.each([
		'"value":9007199254740993',
		'"value":1.234567890123456789',
		'"value":1e-1000',
		'"value":-0',
		'"value":1,"\\u0076alue":2',
	])("declines a lossy input containing %s", (entry) => {
		const input = `{${entry},"padding":${JSON.stringify("x".repeat(2_200))}}`;
		expect(reduceJsonOutput(input)).toBeUndefined();
	});

	it("keeps untrusted document keys out of the recovery command", () => {
		const key = "x'$(touch rogue)\u000a";
		const text = JSON.stringify({ [key]: Array.from({ length: 20 }, (_, id) => ({ id, body: "x".repeat(150) })) });
		const reduced = reduceToolOutput({
			tool: "bash",
			command: "cat report.json",
			text,
			exitCode: 0,
			level: "standard",
		});
		expect(reduced?.details.recoveryHint).toBe(
			"jq -c 'to_entries[] | select(.value | type == \"array\") | .value[]'",
		);
		expect(reduced?.text).toContain("touch rogue");
	});

	it("retains compact jq projections for safe list and object keys", () => {
		const items = [{ id: 42, status: "ok", "unsafe'key": "ignored", end: "ignored" }];
		expect(suggestJqProjection(items)).toBe(".[] | {id,status}");
		expect(suggestJqProjection({ items })).toBe(".items[] | {id,status}");
	});

	it("reports a clipped string even when no physical lines were removed and no artifact is needed", () => {
		const metadata = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`meta${index}`, "y".repeat(160)]));
		const text = JSON.stringify({ ...metadata, body: "x".repeat(600) });
		const reduced = reduceToolOutput({ tool: "python", command: "python", text, exitCode: 0, level: "standard" });
		expect(reduced?.details).toMatchObject({
			omittedLines: 0,
			omittedItems: 0,
			clippedStrings: 1,
			persistRaw: false,
		});
		expect(formatOutputReductionNotice(reduced!.details)).toContain("1 JSON string clipped");
	});

	it("leaves a minor local saving below the pipeline's material threshold", () => {
		const fields = ["abcdefghijklmnopqrst", "qrstuvwxyzabcdefghij", "lmnopqrstuvabcdefghi"];
		const text = JSON.stringify(
			Array.from({ length: 4 }, (_, index) =>
				Object.fromEntries(fields.map((field) => [field, String(index).repeat(230)])),
			),
		);
		expect(reduceJsonOutput(text)).toBeDefined();
		expect(
			reduceToolOutput({ tool: "bash", command: "cat report.json", text, exitCode: 0, level: "standard" }),
		).toBeUndefined();
	});
});
