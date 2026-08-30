import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-edit-legacy-input-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("edit tool prepareArguments", () => {
	it("keeps legacy fields out of the public schema", () => {
		const definition = createEditToolDefinition(process.cwd());
		const alternatives = (definition.parameters as { anyOf?: Array<{ properties?: Record<string, unknown> }> }).anyOf;
		expect(alternatives).toHaveLength(2);
		for (const alternative of alternatives ?? []) {
			expect(alternative.properties).not.toHaveProperty("oldText");
			expect(alternative.properties).not.toHaveProperty("newText");
			expect(alternative.properties).not.toHaveProperty("action");
			expect(alternative.properties).not.toHaveProperty("intentId");
		}
		expect(alternatives?.some((alternative) => alternative.properties?.payloadRef !== undefined)).toBe(true);
	});

	it("folds top-level oldText/newText into edits", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			oldText: "before",
			newText: "after",
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: [{ oldText: "before", newText: "after" }],
		});
	});

	it("appends legacy replacement to existing edits", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			edits: [{ oldText: "a", newText: "b" }],
			oldText: "c",
			newText: "d",
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: [
				{ oldText: "a", newText: "b" },
				{ oldText: "c", newText: "d" },
			],
		});
	});

	it("passes through valid input unchanged", () => {
		const definition = createEditToolDefinition(process.cwd());
		const input = {
			path: "file.txt",
			edits: [{ oldText: "a", newText: "b" }],
		};
		const prepared = definition.prepareArguments!(input);
		expect(prepared).toBe(input);
	});

	it("passes through non-object input unchanged", () => {
		const definition = createEditToolDefinition(process.cwd());
		expect(definition.prepareArguments!(null)).toBe(null);
		expect(definition.prepareArguments!(undefined)).toBe(undefined);
		expect(definition.prepareArguments!("garbage")).toBe("garbage");
	});

	it("prepared args execute correctly", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "legacy.txt");
		await writeFile(filePath, "before\n", "utf8");

		const definition = createEditToolDefinition(dir);
		const prepared = definition.prepareArguments!({
			path: "legacy.txt",
			oldText: "before",
			newText: "after",
		});

		const result = await definition.execute("tool-1", prepared, undefined, undefined, {} as ExtensionContext);
		const resultText = result.content[0];
		if (resultText?.type !== "text") throw new Error("Expected edit result text.");
		expect(result.details?.contentRef).toMatch(/^file-content:/);
		expect(resultText.text).toContain("Successfully replaced 1 block(s) in legacy.txt.");
		expect(resultText.text).not.toContain("do not call edit again");
		expect(resultText.text).toContain(`contentRef ${result.details?.contentRef}`);
		expect(await readFile(filePath, "utf8")).toBe("after\n");
	});

	it("wraps single-object edits into an array (F18)", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			edits: { oldText: "singleOld", newText: "singleNew" },
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: [{ oldText: "singleOld", newText: "singleNew" }],
		});
	});

	it("executes single-object edits correctly (F18)", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "single.txt");
		await writeFile(filePath, "hello world\n", "utf8");

		const definition = createEditToolDefinition(dir);
		const prepared = definition.prepareArguments!({
			path: "single.txt",
			edits: { oldText: "world", newText: "friend" },
		});

		await definition.execute("tool-2", prepared, undefined, undefined, {} as ExtensionContext);
		expect(await readFile(filePath, "utf8")).toBe("hello friend\n");
	});

	it("rejects malformed edit object during execution (negative control)", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "malformed.txt");
		await writeFile(filePath, "initial\n", "utf8");

		const definition = createEditToolDefinition(dir);
		const prepared = definition.prepareArguments!({
			path: "malformed.txt",
			edits: { invalid: true },
		});

		await expect(
			definition.execute("tool-3", prepared, undefined, undefined, {} as ExtensionContext),
		).rejects.toThrow("Edit tool input is invalid");
	});
});

describe("edit tool stringified edits", () => {
	it("leaves JSON-string edits for the shared validation repair layer", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			edits: JSON.stringify([{ oldText: "a", newText: "b" }]),
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: JSON.stringify([{ oldText: "a", newText: "b" }]),
		});
	});

	it("leaves edits alone when the string is not valid JSON", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			edits: "not json",
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: "not json",
		});
	});
});
