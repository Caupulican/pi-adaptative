import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendBoundedJsonLine,
	appendBoundedJsonLineSync,
	type BoundedJsonlLimits,
} from "../src/core/util/bounded-jsonl.ts";

const cleanups: string[] = [];
const SMALL_LIMITS: BoundedJsonlLimits = { maxBytes: 180, targetBytes: 100, maxRecords: 3 };

function tempFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-bounded-jsonl-"));
	cleanups.push(dir);
	return join(dir, "state", "events.jsonl");
}

afterEach(() => {
	for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("bounded JSONL", () => {
	it("sync append retains only the newest low-water tail after crossing the byte bound", () => {
		const filePath = tempFile();
		for (let index = 0; index < 12; index++) {
			appendBoundedJsonLineSync(filePath, { index, text: "x".repeat(20) }, SMALL_LIMITS);
		}

		const content = readFileSync(filePath, "utf-8");
		const records = content
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { index: number });
		expect(Buffer.byteLength(content, "utf-8")).toBeLessThanOrEqual(SMALL_LIMITS.maxBytes);
		expect(records.length).toBeLessThanOrEqual(SMALL_LIMITS.maxRecords);
		expect(records.at(-1)?.index).toBe(11);
	});

	it("async concurrent appends serialize complete records without loss", async () => {
		const filePath = tempFile();
		const limits: BoundedJsonlLimits = { maxBytes: 16 * 1024, targetBytes: 8 * 1024, maxRecords: 100 };
		await Promise.all(Array.from({ length: 20 }, (_, index) => appendBoundedJsonLine(filePath, { index }, limits)));

		const records = readFileSync(filePath, "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { index: number });
		expect(records).toHaveLength(20);
		expect(new Set(records.map((record) => record.index)).size).toBe(20);
	});

	it("rejects values and limits that cannot form a bounded JSON record", async () => {
		const filePath = tempFile();
		expect(() => appendBoundedJsonLineSync(filePath, undefined, SMALL_LIMITS)).toThrow("JSON-serializable");
		await expect(
			appendBoundedJsonLine(filePath, { ok: true }, { ...SMALL_LIMITS, targetBytes: 181 }),
		).rejects.toThrow("targetBytes <= maxBytes");
	});
});
