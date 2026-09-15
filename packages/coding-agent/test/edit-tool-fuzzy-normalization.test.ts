import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEditTool } from "../src/core/tools/edit.ts";
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

		const tool = createEditTool(dir);
		const result = await tool.execute("tool-1", {
			path: "fuzzy.txt",
			edits: [{ oldText: "target - line", newText: "target - changed" }],
		});

		const after = await readFile(filePath, "utf8");
		expect(after).toBe("target - changed\nunrelated “quote”  \n");
		expect(result.details?.diff).toBe(generateDiffString(normalizeToLF(before), normalizeToLF(after)).diff);
	});

	it("keeps exact-match edits byte-exact outside the target", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "exact.txt");
		await writeFile(filePath, "target - line\nunrelated “quote”  \n", "utf8");

		const tool = createEditTool(dir);
		await tool.execute("tool-1", {
			path: "exact.txt",
			edits: [{ oldText: "target - line", newText: "target - changed" }],
		});

		expect(await readFile(filePath, "utf8")).toBe("target - changed\nunrelated “quote”  \n");
	});

	it("round-trips CRLF files when a fuzzy replacement is needed", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "crlf.txt");
		await writeFile(filePath, "alpha — one\r\nbeta\r\n", "utf8");

		const tool = createEditTool(dir);
		const result = await tool.execute("tool-1", {
			path: "crlf.txt",
			edits: [{ oldText: "alpha - one", newText: "alpha - two" }],
		});

		expect(await readFile(filePath, "utf8")).toBe("alpha - two\r\nbeta\r\n");
		const diff = typeof result.details?.diff === "string" ? result.details.diff : "";
		expect(diff).toContain("alpha - two");
		expect(diff).not.toMatch(/^[+-]\s*\d+ beta\r?$/m);
	});

	it("counts duplicates in the same space that matched the edit", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "duplicates.txt");
		await writeFile(filePath, "x - y\nx — y\n", "utf8");

		const tool = createEditTool(dir);
		await tool.execute("tool-1", {
			path: "duplicates.txt",
			edits: [{ oldText: "x - y", newText: "ascii changed" }],
		});

		expect(await readFile(filePath, "utf8")).toBe("ascii changed\nx — y\n");
	});

	it("still rejects ambiguous fuzzy matches", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "fuzzy-duplicates.txt");
		await writeFile(filePath, "x — y\nx – y\n", "utf8");

		const tool = createEditTool(dir);
		await expect(
			tool.execute("tool-1", {
				path: "fuzzy-duplicates.txt",
				edits: [{ oldText: "x - y", newText: "changed" }],
			}),
		).rejects.toThrow("Found 2 occurrences");
	});

	it("applies a unique indent-only rematch after exact and fuzzy fail", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "indent.ts");
		await writeFile(filePath, "function f() {\n\tconst x = 1;\n}\n", "utf8");
		const tool = createEditTool(dir);
		const result = await tool.execute("tool-1", {
			path: "indent.ts",
			edits: [{ oldText: "const x = 1;", newText: "const x = 2;" }],
		});
		expect(result.isError).not.toBe(true);
		expect(await readFile(filePath, "utf8")).toContain("const x = 2;");
	});

	it("rejects indent rematch when two blocks collapse to the same text", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "indent-dup.ts");
		await writeFile(filePath, "\tconst x = 1;\n\t\tconst x = 1;\n", "utf8");
		const tool = createEditTool(dir);
		await expect(
			tool.execute("tool-1", {
				path: "indent-dup.ts",
				edits: [{ oldText: "const x = 1;", newText: "const x = 2;" }],
			}),
		).rejects.toThrow(/Found 2 occurrences/);
	});

	it("does not indent-rematch outside the requested line range", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "indent-range.ts");
		await writeFile(filePath, "function a() {\n\tconst x = 1;\n}\nfunction b() {\n\tconst y = 1;\n}\n", "utf8");
		const tool = createEditTool(dir);
		await expect(
			tool.execute("tool-1", {
				path: "indent-range.ts",
				edits: [{ oldText: "const y = 1;", newText: "const y = 2;", range: { startLine: 1, endLine: 3 } }],
			}),
		).rejects.toThrow(/Could not find the exact text/);
	});
});
