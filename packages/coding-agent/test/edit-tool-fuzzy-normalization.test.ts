import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { generateDiffString, normalizeToLF } from "../src/core/tools/edit-diff.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-edit-fuzzy-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("edit tool fuzzy matching", () => {
	it("splices fuzzy replacements into the original content without normalizing unrelated bytes", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "fuzzy.txt");
		const before = "target — line\nunrelated “quote”  \n";
		await writeFile(filePath, before, "utf8");

		const definition = createEditToolDefinition(dir);
		const result = await definition.execute(
			"tool-1",
			{ path: "fuzzy.txt", edits: [{ oldText: "target - line", newText: "target - changed" }] },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		const after = await readFile(filePath, "utf8");
		expect(after).toBe("target - changed\nunrelated “quote”  \n");
		expect(result.details?.diff).toBe(generateDiffString(normalizeToLF(before), normalizeToLF(after)).diff);
	});

	it("keeps exact-match edits byte-exact outside the target", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "exact.txt");
		await writeFile(filePath, "target - line\nunrelated “quote”  \n", "utf8");

		const definition = createEditToolDefinition(dir);
		await definition.execute(
			"tool-1",
			{ path: "exact.txt", edits: [{ oldText: "target - line", newText: "target - changed" }] },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(await readFile(filePath, "utf8")).toBe("target - changed\nunrelated “quote”  \n");
	});

	it("round-trips CRLF files when a fuzzy replacement is needed", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "crlf.txt");
		await writeFile(filePath, "alpha — one\r\nbeta\r\n", "utf8");

		const definition = createEditToolDefinition(dir);
		await definition.execute(
			"tool-1",
			{ path: "crlf.txt", edits: [{ oldText: "alpha - one", newText: "alpha - two" }] },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(await readFile(filePath, "utf8")).toBe("alpha - two\r\nbeta\r\n");
	});

	it("counts duplicates in the same space that matched the edit", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "duplicates.txt");
		await writeFile(filePath, "x - y\nx — y\n", "utf8");

		const definition = createEditToolDefinition(dir);
		await definition.execute(
			"tool-1",
			{ path: "duplicates.txt", edits: [{ oldText: "x - y", newText: "ascii changed" }] },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(await readFile(filePath, "utf8")).toBe("ascii changed\nx — y\n");
	});

	it("still rejects ambiguous fuzzy matches", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "fuzzy-duplicates.txt");
		await writeFile(filePath, "x — y\nx – y\n", "utf8");

		const definition = createEditToolDefinition(dir);
		await expect(
			definition.execute(
				"tool-1",
				{ path: "fuzzy-duplicates.txt", edits: [{ oldText: "x - y", newText: "changed" }] },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow("Found 2 occurrences");
	});
});
