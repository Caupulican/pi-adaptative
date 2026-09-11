import { afterEach, describe, expect, it, vi } from "vitest";
import { execCommand } from "../src/core/exec.ts";
import { pythonEditByteCodec } from "../src/core/tools/edit-byte-codec.ts";
import { decodeTextChunks } from "../src/core/tools/file-text-decoder.ts";
import { spawnProcess } from "../src/utils/child-process.ts";

vi.mock("../src/utils/child-process.ts", { spy: true });
vi.mock("../src/core/exec.ts", { spy: true });
vi.mock("../src/core/python-runtime.ts", () => ({
	ensurePythonRuntime: vi.fn(async () => ({
		status: "ready",
		pythonPath: process.platform === "win32" ? "python" : "python3",
		uvPath: "synthetic-unused",
		pythonInstalled: false,
	})),
}));

afterEach(() => vi.clearAllMocks());

const fixturePath = "/fixture/source.txt";

describe("encoded read process ownership", () => {
	it("uses one bounded helper for the entire read, not one process per chunk", async () => {
		const bytes = Buffer.from("\uFEFFcafé🙂\r\nlast", "utf16le");
		const pieces = [...bytes].map((byte) => Buffer.from([byte]));
		let text = "";
		for await (const part of decodeTextChunks(pieces, fixturePath)) text += part;
		expect(text).toBe("café🙂\r\nlast");
		expect(spawnProcess).toHaveBeenCalledTimes(1);
		expect(execCommand).not.toHaveBeenCalled();
		const child = vi.mocked(spawnProcess).mock.results[0].value;
		expect(child.exitCode).toBe(0);
	});

	it("keeps native UTF-8 reads process-free", async () => {
		let text = "";
		for await (const part of decodeTextChunks([Buffer.from("café")], fixturePath)) text += part;
		expect(text).toBe("café");
		expect(spawnProcess).not.toHaveBeenCalled();
		expect(execCommand).not.toHaveBeenCalled();
	});

	it("preserves source I/O failure identity while reaping the helper", async () => {
		const failure = new Error("synthetic backend I/O failure");
		async function* source() {
			yield Buffer.from("\uFEFFfirst", "utf16le");
			throw failure;
		}
		const reader = decodeTextChunks(source(), fixturePath);
		expect(await reader.next()).toEqual({ value: "first", done: false });
		await expect(reader.next()).rejects.toBe(failure);
		const child = vi.mocked(spawnProcess).mock.results[0].value;
		expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
	});

	it("reaps its helper and closes the source when the consumer returns early", async () => {
		let closed = false;
		async function* source() {
			try {
				yield Buffer.from("\uFEFFfirst", "utf16le");
				throw new Error("must not pull another source chunk");
			} finally {
				closed = true;
			}
		}
		for await (const text of decodeTextChunks(source(), fixturePath)) {
			expect(text).toBe("first");
			break;
		}
		expect(closed).toBe(true);
		expect(spawnProcess).toHaveBeenCalledTimes(1);
		const child = vi.mocked(spawnProcess).mock.results[0].value;
		expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
	});
});

describe("managed codec encoding detection", () => {
	it.each([
		{ name: "strict UTF-8", bytes: Buffer.from("café🙂\nlast\n"), encoding: "utf-8" },
		{
			name: "windows-1252 curly quotes",
			bytes: Buffer.concat([Buffer.from("caf"), Buffer.from([0xe9, 0x20, 0x93, 0x6f, 0x6b, 0x94, 0x0a])]),
			encoding: "windows-1252",
		},
		{
			name: "latin-1 for bytes windows-1252 leaves undefined",
			bytes: Buffer.concat([Buffer.from("plain "), Buffer.from([0x81, 0x8d, 0x8f, 0x90, 0x9d, 0x0a])]),
			encoding: "latin-1",
		},
		{ name: "BOM-less UTF-16LE", bytes: Buffer.from("café🙂\nlast\n", "utf16le"), encoding: "utf-16-le" },
		{
			name: "BOM-less UTF-16BE",
			bytes: Buffer.from("café🙂\nlast\n", "utf16le").swap16(),
			encoding: "utf-16-be",
		},
	])("resolves $name without a declaration", async ({ bytes, encoding }) => {
		const document = await pythonEditByteCodec.decode(bytes, undefined);
		expect({ encoding: document.encoding, detected: document.detected }).toEqual({ encoding, detected: true });
	});

	it("keeps a declared encoding out of the detection path", async () => {
		const bytes = Buffer.concat([Buffer.from("caf"), Buffer.from([0xe9, 0x0a])]);
		const document = await pythonEditByteCodec.decode(bytes, "cp1252");
		expect({ encoding: document.encoding, detected: document.detected }).toEqual({
			encoding: "cp1252",
			detected: false,
		});
	});

	it("requires evidence for NUL-bearing bytes that are not UTF-16", async () => {
		await expect(pythonEditByteCodec.decode(Buffer.from("ok\n\0rest"), undefined)).rejects.toThrow(
			/Source encoding is unknown or malformed/,
		);
	});

	it("names the first unrepresentable replacement character instead of writing bytes", async () => {
		const bytes = Buffer.concat([Buffer.from("caf"), Buffer.from([0xe9, 0x0a])]);
		const document = await pythonEditByteCodec.decode(bytes, undefined);
		await expect(document.encode([{ start: 0, end: 3, replacement: "a → b" }])).rejects.toThrow(
			/cannot be represented in windows-1252.*→|→.*windows-1252/s,
		);
		// Negative control: a representable replacement still encodes in the detected codec.
		expect(await document.encode([{ start: 0, end: 3, replacement: "kaf" }])).toEqual(
			Buffer.concat([Buffer.from("kaf"), Buffer.from([0xe9, 0x0a])]),
		);
	});
});
