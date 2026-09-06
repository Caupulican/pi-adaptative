import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensurePythonRuntime } from "../src/core/python-runtime.ts";
import { createReadTool } from "../src/core/tools/read.ts";

vi.mock("../src/core/python-runtime.ts", () => ({
	ensurePythonRuntime: vi.fn(async () => ({
		status: "ready",
		pythonPath: process.platform === "win32" ? "python" : "python3",
		uvPath: "synthetic-unused",
		pythonInstalled: false,
	})),
}));

const directories: string[] = [];
afterEach(async () => {
	vi.clearAllMocks();
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(bytes: Buffer) {
	const cwd = await mkdtemp(join(tmpdir(), "pi-read-encoding-"));
	directories.push(cwd);
	const path = join(cwd, "source é.py");
	await writeFile(path, bytes);
	return { cwd, path };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }) {
	return result.content.map((part) => part.text ?? "").join("\n");
}

describe("read encoding recovery", () => {
	for (const maxTextReadBytes of [1, 16 * 1024 * 1024]) {
		it.each(["utf-16-le", "utf-16-be"])(
			`decodes BOM-marked %s before slicing and tail selection (budget ${maxTextReadBytes})`,
			async (encoding) => {
				const bytes = Buffer.from("\uFEFFcafé🙂\nsecond\nlast\n", "utf16le");
				if (encoding === "utf-16-be") bytes.swap16();
				const { cwd, path } = await fixture(bytes);
				const tool = createReadTool(cwd, { maxTextReadBytes });
				expect(textOf(await tool.execute("head", { path, limit: 1 }))).toContain("café🙂");
				expect(textOf(await tool.execute("tail", { path, tail: 2, lineNumbers: true }))).toBe("2: second\n3: last");
				const window = await tool.execute("window", { path, column: 6 });
				expect(textOf(window)).toContain("🙂");
				expect(window.details).toMatchObject({ lineWindow: { startColumn: 5, endColumn: 6, totalColumns: 6 } });
				expect(await readFile(path)).toEqual(bytes);
			},
		);

		it(`decodes an explicitly identified legacy codec before outlining (budget ${maxTextReadBytes})`, async () => {
			const bytes = Buffer.from("# café\ndef résumé():\n    pass\n", "latin1");
			const { cwd, path } = await fixture(bytes);
			const input = { path, encoding: "cp1252", mode: "outline" as const };
			const result = await createReadTool(cwd, { maxTextReadBytes }).execute("outline", input);
			expect(textOf(result)).toContain("résumé");
			expect(await readFile(path)).toEqual(bytes);
		});

		it(`never substitutes malformed UTF-8 with replacement characters (budget ${maxTextReadBytes})`, async () => {
			const { cwd, path } = await fixture(Buffer.from([0x61, 0xff, 0x62]));
			await expect(createReadTool(cwd, { maxTextReadBytes }).execute("bad", { path })).rejects.toThrow(/encoding/i);
			// Negative control: a literal replacement character is valid source text.
			await writeFile(path, "a\uFFFDb");
			expect(textOf(await createReadTool(cwd, { maxTextReadBytes }).execute("valid", { path }))).toBe("a\uFFFDb");
		});
	}

	it("keeps ordinary UTF-8 reads independent of Python availability", async () => {
		const { cwd, path } = await fixture(Buffer.from("café🙂\n"));
		const tool = createReadTool(cwd, { maxTextReadBytes: 1 });
		expect(textOf(await tool.execute("utf8", { path }))).toBe("café🙂");
		expect(ensurePythonRuntime).not.toHaveBeenCalled();
	});

	it("decodes only the selected backend's bytes for a foreign UNC path", async () => {
		const path = "\\\\fixture-host\\share\\source.txt";
		const bytes = Buffer.from("\uFEFFcafé🙂\n", "utf16le");
		const tool = createReadTool("Q:\\fixture", {
			pathOptions: { flavor: "win32" },
			operations: {
				access: async (target) => {
					expect(target).toBe(path);
				},
				readFile: async (target) => {
					expect(target).toBe(path);
					return Buffer.from(bytes);
				},
			},
		});
		expect(textOf(await tool.execute("backend", { path }))).toBe("café🙂");
	});
});
