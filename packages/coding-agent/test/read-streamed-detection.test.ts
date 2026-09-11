import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensurePythonRuntime } from "../src/core/python-runtime.ts";
import { pythonEditByteCodec } from "../src/core/tools/edit-byte-codec.ts";
import { createReadTool } from "../src/core/tools/read.ts";

/**
 * A read above the whole-file budget streams: the decoder hands the managed codec one bounded
 * window at a time. Resolving the encoding from whichever window UTF-8 first failed in is a verdict
 * on a fraction of the file, and a later window can contradict it — the ISO-8859-1 positions
 * windows-1252 leaves undefined are exactly that contradiction. Detection is therefore a separate
 * pass over the WHOLE source, so every region of one file is read under one codec.
 */

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
	// clearAllMocks keeps a per-test mockResolvedValue in place; restore the ready runtime explicitly.
	vi.mocked(ensurePythonRuntime).mockResolvedValue({
		status: "ready",
		pythonPath: process.platform === "win32" ? "python" : "python3",
		uvPath: "synthetic-unused",
		pythonInstalled: false,
	});
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** Larger than the 1 MiB window the decoder hands the codec, so the head really hides the tail. */
const ASCII_FILLER_LINES = 12_000;
const ASCII_FILLER = `${"filler line padding to one hundred bytes so the head outgrows a decode window".padEnd(99, ".")}\n`;

function asciiHead(): Buffer {
	return Buffer.from(ASCII_FILLER.repeat(ASCII_FILLER_LINES));
}

async function fixture(bytes: Buffer, name = "streamed.txt") {
	const cwd = await mkdtemp(join(tmpdir(), "pi-read-streamed-"));
	directories.push(cwd);
	const path = join(cwd, name);
	await writeFile(path, bytes);
	return { cwd, path, bytes };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }) {
	return result.content.map((part) => part.text ?? "").join("\n");
}

/** Small enough that every fixture here streams; the fixtures themselves outgrow a decode window. */
const STREAMING_BUDGET = 64 * 1024;

describe("streamed reads resolve the encoding from the whole file", () => {
	it("reaches cp1252 bytes that sit past a megabyte of ASCII", async () => {
		const source = Buffer.concat([
			asciiHead(),
			Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x93, 0x6f, 0x6b, 0x94, 0x0a]),
		]);
		const { cwd, path } = await fixture(source);
		const tool = createReadTool(cwd, { maxTextReadBytes: STREAMING_BUDGET });
		const tail = textOf(await tool.execute("tail", { path, tail: 1 }));
		expect(tail).toContain("café “ok”");
		expect(tail).toContain("[decoded as windows-1252 per python detection]");
	});

	it("reads one file under one codec when a late byte rules windows-1252 out", async () => {
		// 0xe9 decodes as windows-1252 and as ISO-8859-1; 0x81 is one of the five positions
		// windows-1252 leaves undefined, so the whole file is ISO-8859-1 — but only the last
		// kilobyte says so, and the first window would have answered windows-1252.
		const source = Buffer.concat([
			Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
			asciiHead(),
			Buffer.from([0x81, 0x20, 0x74, 0x61, 0x69, 0x6c, 0x0a]),
		]);
		const { cwd, path } = await fixture(source);
		const tool = createReadTool(cwd, { maxTextReadBytes: STREAMING_BUDGET });
		const head = textOf(await tool.execute("head", { path, offset: 1, limit: 1 }));
		expect(head).toContain("café");
		expect(head).toContain("[decoded as latin-1 per python detection]");
		const tail = textOf(await tool.execute("tail", { path, tail: 1 }));
		expect(tail).toContain(" tail");
		expect(tail).toContain("[decoded as latin-1 per python detection]");
	});

	it("resolves a BOM-less UTF-16LE file above the budget", async () => {
		const text = `${"utf-16 line with no byte order mark at all\n".repeat(8_000)}café🙂 last\n`;
		const { cwd, path } = await fixture(Buffer.from(text, "utf16le"));
		const tool = createReadTool(cwd, { maxTextReadBytes: STREAMING_BUDGET });
		const tail = textOf(await tool.execute("tail", { path, tail: 1 }));
		expect(tail).toContain("café🙂 last");
		expect(tail).toContain("[decoded as utf-16-le per python detection]");
	});

	it("gives a whole-file read the same verdict as the streamed one", async () => {
		// The same bytes under the whole-file budget, where the codec already saw everything from
		// the first failing window onward: the detection pass must not move that answer.
		const source = Buffer.concat([
			Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
			asciiHead(),
			Buffer.from([0x81, 0x20, 0x74, 0x61, 0x69, 0x6c, 0x0a]),
		]);
		const { cwd, path } = await fixture(source);
		const tool = createReadTool(cwd, { maxTextReadBytes: 16 * 1024 * 1024 });
		const head = textOf(await tool.execute("head", { path, limit: 1 }));
		expect(head).toContain("café");
		expect(head).toContain("[decoded as latin-1 per python detection]");
	});

	it("agrees with the edit path, which sees the same bytes in one frame", async () => {
		const source = Buffer.concat([
			Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
			asciiHead(),
			Buffer.from([0x81, 0x20, 0x74, 0x61, 0x69, 0x6c, 0x0a]),
		]);
		const document = await pythonEditByteCodec.decode(source, undefined);
		expect({ encoding: document.encoding, detected: document.detected }).toEqual({
			encoding: "latin-1",
			detected: true,
		});
	});

	it("still refuses a source no codec resolves, naming where it stops being text", async () => {
		const source = Buffer.concat([asciiHead(), Buffer.from("ok\n\0rest")]);
		const { cwd, path } = await fixture(source);
		const tool = createReadTool(cwd, { maxTextReadBytes: STREAMING_BUDGET });
		await expect(tool.execute("binary", { path, tail: 1 })).rejects.toThrow(/PI_FILE_ENCODING_CORRUPTION/);
	});
});
