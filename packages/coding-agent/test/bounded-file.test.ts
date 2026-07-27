import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBoundedTextFile, readBoundedTextFileSync } from "../src/core/util/bounded-file.ts";

const roots: string[] = [];

function fixtureFile(content: string): string {
	const root = mkdtempSync(join(tmpdir(), "pi-bounded-file-"));
	roots.push(root);
	const file = join(root, "state.json");
	writeFileSync(file, content);
	return file;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("readBoundedTextFileSync", () => {
	it("returns an exact file at the byte boundary", () => {
		expect(readBoundedTextFileSync(fixtureFile("four"), 4, "Test state")).toBe("four");
	});

	it("rejects an oversized durable file before exposing its content", () => {
		expect(() => readBoundedTextFileSync(fixtureFile("oversized"), 4, "Test state")).toThrow(
			"Test state exceeds its byte limit",
		);
	});

	it("rejects invalid byte limits", () => {
		expect(() => readBoundedTextFileSync(fixtureFile("state"), -1, "Test state")).toThrow(TypeError);
	});
});

describe("readBoundedTextFile", () => {
	it("returns an exact file at the byte boundary", async () => {
		await expect(readBoundedTextFile(fixtureFile("four"), 4, "Test state")).resolves.toBe("four");
	});

	it("rejects an oversized durable file before exposing its content", async () => {
		await expect(readBoundedTextFile(fixtureFile("oversized"), 4, "Test state")).rejects.toThrow(
			"Test state exceeds its byte limit",
		);
	});
});
