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

async function fixture(bytes: Buffer, name = "source é.py") {
	const cwd = await mkdtemp(join(tmpdir(), "pi-read-encoding-"));
	directories.push(cwd);
	const path = join(cwd, name);
	await writeFile(path, bytes);
	return { cwd, path };
}

/** "café “ok”" written by a Windows toolchain: 0xe9 is ISO-8859-1, 0x93/0x94 are windows-1252 only. */
const cp1252Source = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x93, 0x6f, 0x6b, 0x94, 0x0a]);
const cp1252Text = "café “ok”";

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

		it(`reports where undeclared non-UTF-8 bytes start instead of substituting them (budget ${maxTextReadBytes})`, async () => {
			// "line1\nline2\ncaf\u00E9\n" written as windows-1252: the 0xe9 at byte 15 opens line 3.
			const { cwd, path } = await fixture(
				Buffer.concat([Buffer.from("line1\nline2\ncaf"), Buffer.from([0xe9, 0x0a])]),
			);
			const tool = createReadTool(cwd, { maxTextReadBytes });
			const failure = await tool.execute("bad", { path }).then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(failure).toMatchObject({
				failureCode: "read_encoding_required",
				errorKind: "tool_failure",
				outputSignature: expect.stringMatching(/\S/),
			});
			const message = (failure as Error).message;
			expect(message).toContain("PI_READ_ENCODING_REQUIRED");
			expect(message).toContain(path);
			expect(message).toContain("line 3, byte offset 15");
			expect(message).toContain("windows-1252");
			expect(message).toContain(".editorconfig");
			expect(message).not.toContain("\uFFFD");
			// The signature identifies the same undecodable position across attempts.
			const repeated = await tool.execute("bad-again", { path }).catch((error: unknown) => error);
			expect((repeated as { outputSignature: string }).outputSignature).toBe(
				(failure as { outputSignature: string }).outputSignature,
			);
			// Negative control: a literal replacement character is valid source text.
			await writeFile(path, "a\uFFFDb");
			expect(textOf(await createReadTool(cwd, { maxTextReadBytes }).execute("valid", { path }))).toBe("a\uFFFDb");
		});

		it(`decodes a charset declared in .editorconfig and names the declaration (budget ${maxTextReadBytes})`, async () => {
			const { cwd, path } = await fixture(cp1252Source, "unit.pas");
			await writeFile(join(cwd, ".editorconfig"), "root = true\n\n[*.pas]\ncharset = latin1\n");
			const tool = createReadTool(cwd, { maxTextReadBytes });
			const result = await tool.execute("declared", { path });
			expect(textOf(result)).toBe(`${cp1252Text}\n[decoded as windows-1252 per .editorconfig]`);
			expect(result.details).toMatchObject({
				encoding: { name: "windows-1252", source: join(cwd, ".editorconfig") },
			});
			// Whole-file, sliced, outline and counted reads share the declaration.
			expect(textOf(await tool.execute("tail", { path, tail: 1 }))).toContain(cp1252Text);
			expect(textOf(await tool.execute("outline", { path, mode: "outline" }))).not.toContain("\uFFFD");
		});

		it(`keeps an explicit encoding argument ahead of the declaration (budget ${maxTextReadBytes})`, async () => {
			const { cwd, path } = await fixture(cp1252Source, "unit.pas");
			await writeFile(join(cwd, ".editorconfig"), "root = true\n\n[*.pas]\ncharset = cp437\n");
			const result = await createReadTool(cwd, { maxTextReadBytes }).execute("explicit", {
				path,
				encoding: "cp1252",
			});
			expect(textOf(result)).toBe(cp1252Text);
			expect(result.details?.encoding).toBeUndefined();
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
