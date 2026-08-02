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
		const variants = (definition.parameters as { anyOf?: Array<{ properties?: Record<string, unknown> }> }).anyOf;
		expect(variants).toBeDefined();
		for (const variant of variants ?? []) {
			expect(variant.properties).not.toHaveProperty("oldText");
			expect(variant.properties).not.toHaveProperty("newText");
		}
	});

	it("folds top-level oldText/newText into edits", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			action: "commit",
			path: "file.txt",
			intentId: "intent-1",
			oldText: "before",
			newText: "after",
		});
		expect(prepared).toEqual({
			action: "commit",
			path: "file.txt",
			intentId: "intent-1",
			edits: [{ oldText: "before", newText: "after" }],
		});
	});

	it("appends legacy replacement to existing edits", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			action: "commit",
			path: "file.txt",
			intentId: "intent-1",
			edits: [{ oldText: "a", newText: "b" }],
			oldText: "c",
			newText: "d",
		});
		expect(prepared).toEqual({
			action: "commit",
			path: "file.txt",
			intentId: "intent-1",
			edits: [
				{ oldText: "a", newText: "b" },
				{ oldText: "c", newText: "d" },
			],
		});
	});

	it("passes through valid input unchanged", () => {
		const definition = createEditToolDefinition(process.cwd());
		const input = {
			action: "commit",
			path: "file.txt",
			intentId: "intent-1",
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
		const preparation = await definition.execute(
			"tool-prepare",
			{ action: "prepare", path: "legacy.txt" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const intentId = preparation.details?.intentId;
		if (!intentId) throw new Error("Expected edit preparation to return an intent id.");
		const prepared = definition.prepareArguments!({
			action: "commit",
			path: "legacy.txt",
			intentId,
			oldText: "before",
			newText: "after",
		});

		const result = await definition.execute("tool-1", prepared, undefined, undefined, {} as ExtensionContext);
		const resultText = result.content[0];
		if (resultText?.type !== "text") throw new Error("Expected edit result text.");
		expect(result.details?.contentRef).toMatch(/^file-content:/);
		expect(resultText.text).toContain("Successfully replaced 1 block(s) in legacy.txt.");
		expect(resultText.text).toContain(`contentRef ${result.details?.contentRef}`);
		expect(await readFile(filePath, "utf8")).toBe("after\n");
	});
});

describe("edit tool stringified edits", () => {
	it("leaves JSON-string edits for the shared validation repair layer", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			action: "commit",
			path: "file.txt",
			intentId: "intent-1",
			edits: JSON.stringify([{ oldText: "a", newText: "b" }]),
		});
		expect(prepared).toEqual({
			action: "commit",
			path: "file.txt",
			intentId: "intent-1",
			edits: JSON.stringify([{ oldText: "a", newText: "b" }]),
		});
	});

	it("leaves edits alone when the string is not valid JSON", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			action: "commit",
			path: "file.txt",
			intentId: "intent-1",
			edits: "not json",
		});
		expect(prepared).toEqual({
			action: "commit",
			path: "file.txt",
			intentId: "intent-1",
			edits: "not json",
		});
	});
});
