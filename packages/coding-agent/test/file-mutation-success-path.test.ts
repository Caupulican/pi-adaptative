import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { FileMutationIntentController } from "../src/core/tools/file-mutation-intent.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";

const format = vi.hoisted(() => ({
	formatMutatedSourceText: vi.fn((content: string) => `FORMATTED:${content}`),
}));

vi.mock("../src/core/tools/file-mutation-format.ts", () => format);

const tempDirs: string[] = [];

async function createPackageSrcFile(): Promise<{ cwd: string; relativePath: string; absolutePath: string }> {
	const cwd = await mkdtemp(join(tmpdir(), "pi-file-mutation-success-"));
	tempDirs.push(cwd);
	const relativePath = "packages/foo/src/sample.ts";
	const absolutePath = join(cwd, relativePath);
	await mkdir(join(cwd, "packages/foo/src"), { recursive: true });
	await writeFile(absolutePath, "const x = 1;\n", "utf8");
	return { cwd, relativePath, absolutePath };
}

afterEach(async () => {
	format.formatMutatedSourceText.mockClear();
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("successful file mutations skip biome formatting", () => {
	it.each(["\n", "\r\n"])("preserves BOM and untouched bytes with %j newlines", async (newline) => {
		const { cwd, relativePath, absolutePath } = await createPackageSrcFile();
		await writeFile(absolutePath, `\uFEFFconst x = 1;${newline}const untouched={a:1}${newline}`);
		const intentController = new FileMutationIntentController();
		const tool = wrapToolDefinition(createEditToolDefinition(cwd, { intentController }));
		const result = await tool.execute("edit-1", {
			path: relativePath,
			edits: [{ oldText: "const x = 1;", newText: "const x={a:1,b:2}" }],
		});
		expect(format.formatMutatedSourceText).not.toHaveBeenCalled();
		const expected = `\uFEFFconst x={a:1,b:2}${newline}const untouched={a:1}${newline}`;
		expect(await readFile(absolutePath, "utf8")).toBe(expected);
		expect(result.details?.patch).toContain("+const x={a:1,b:2}");
		expect(result.details?.patch).not.toContain("+const untouched");
		await wrapToolDefinition(createWriteToolDefinition(cwd, { intentController })).execute("copy-1", {
			path: "copy.ts",
			contentRef: result.details?.contentRef ?? "missing",
		});
		expect(await readFile(join(cwd, "copy.ts"), "utf8")).toBe(expected);
	});

	it("creates a new file with the requested write bytes without invoking the formatter", async () => {
		const { cwd } = await createPackageSrcFile();
		const relativePath = "packages/foo/src/created.ts";
		const tool = wrapToolDefinition(createWriteToolDefinition(cwd));
		const result = await tool.execute("write-1", { path: relativePath, content: "const y={a:1,b:2}\n" });
		expect(format.formatMutatedSourceText).not.toHaveBeenCalled();
		expect(await readFile(join(cwd, relativePath), "utf8")).toBe("const y={a:1,b:2}\n");
		expect(result.details.byteCount).toBe(Buffer.byteLength("const y={a:1,b:2}\n"));
		await tool.execute("copy-2", { path: "copy.ts", contentRef: result.details.contentRef ?? "missing" });
		expect(await readFile(join(cwd, "copy.ts"), "utf8")).toBe("const y={a:1,b:2}\n");
	});
});
