import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditTool } from "../src/core/tools/edit.ts";
import { recallDetectedFileEncoding } from "../src/core/tools/file-encoding-metadata.ts";
import { FileMutationIntentController } from "../src/core/tools/file-mutation-intent.ts";

// Exercise the packaged codec with a real local interpreter, never uv downloads or a provider.
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
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(bytes: Buffer, name = "unit.pas") {
	const cwd = await mkdtemp(join(tmpdir(), "pi-detected-encoding-"));
	directories.push(cwd);
	const path = join(cwd, name);
	await writeFile(path, bytes);
	const intentController = new FileMutationIntentController();
	return { cwd, path, intentController, tool: createEditTool(cwd, { intentController }) };
}

/** "unit café;" plus curly quotes: 0xe9 is ISO-8859-1, 0x93/0x94 exist only in windows-1252. */
function cp1252Source(word: string): Buffer {
	return Buffer.concat([
		Buffer.from("unit caf"),
		Buffer.from([0xe9]),
		Buffer.from(";\r\nbegin\r\n  "),
		Buffer.from([0x93]),
		Buffer.from(word, "latin1"),
		Buffer.from([0x94]),
		Buffer.from("\r\nend.\r\n"),
	]);
}

describe("edit resolves an undeclared encoding through the managed Python codec", () => {
	it("detects windows-1252, preserves untouched bytes, and names the detection", async () => {
		const { tool, path } = await fixture(cp1252Source("target"));
		const result = await tool.execute("detected", { path, edits: [{ oldText: "target", newText: "café" }] });
		expect(await readFile(path)).toEqual(cp1252Source("café"));
		expect(result.details).toMatchObject({
			encodingRecovery: {
				codec: "python",
				encoding: "windows-1252",
				verified: true,
				source: "python detection",
			},
		});
		expect(result.content.map((part) => ("text" in part ? part.text : "")).join("\n")).toContain(
			"[edited through the python codec as windows-1252 (python detection)]",
		);
	});

	it("detects a BOM-less UTF-16LE source from its NUL pattern", async () => {
		const before = Buffer.from("café🙂\r\ntarget\nlast\r", "utf16le");
		const { tool, path } = await fixture(before, "resource.rc");
		const result = await tool.execute("detected", { path, edits: [{ oldText: "target", newText: "changed" }] });
		expect(await readFile(path)).toEqual(Buffer.from("café🙂\r\nchanged\nlast\r", "utf16le"));
		expect(result.details).toMatchObject({
			encodingRecovery: { encoding: "utf-16-le", source: "python detection" },
		});
	});

	it("detects latin-1 when the source carries bytes windows-1252 leaves undefined", async () => {
		// 0x81 0x8d 0x8f 0x90 0x9d are the five undefined windows-1252 positions.
		const before = Buffer.concat([Buffer.from("target "), Buffer.from([0x81, 0x8d, 0x8f, 0x90, 0x9d, 0x0a])]);
		const { tool, path } = await fixture(before, "legacy.txt");
		const result = await tool.execute("detected", { path, edits: [{ oldText: "target", newText: "changed" }] });
		expect(await readFile(path)).toEqual(
			Buffer.concat([Buffer.from("changed "), Buffer.from([0x81, 0x8d, 0x8f, 0x90, 0x9d, 0x0a])]),
		);
		expect(result.details).toMatchObject({
			encodingRecovery: { encoding: "latin-1", source: "python detection" },
		});
	});

	it("refuses a replacement the detected encoding cannot represent before touching the file", async () => {
		const before = cp1252Source("target");
		const { tool, path } = await fixture(before);
		const failure = await tool
			.execute("unrepresentable", { path, edits: [{ oldText: "target", newText: "a → b" }] })
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		const message = (failure as Error).message;
		expect(message).toContain("PI_FILE_ENCODING_CORRUPTION");
		expect(message).toContain("→");
		expect(message).toContain("windows-1252");
		expect(await readFile(path)).toEqual(before);
	});

	it("reuses a detected encoding for the next edit of the same file", async () => {
		const { tool, path } = await fixture(cp1252Source("target"));
		await tool.execute("first", { path, edits: [{ oldText: "target", newText: "second" }] });
		expect(recallDetectedFileEncoding(path, (await stat(path)).mtimeMs)).toBe("windows-1252");
		const again = await tool.execute("again", { path, edits: [{ oldText: "second", newText: "third" }] });
		expect(await readFile(path)).toEqual(cp1252Source("third"));
		expect(again.details).toMatchObject({
			encodingRecovery: { encoding: "windows-1252", source: "python detection" },
		});
	});
});
