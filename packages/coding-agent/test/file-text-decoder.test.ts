import { afterEach, describe, expect, it, vi } from "vitest";
import { ensurePythonRuntime } from "../src/core/python-runtime.ts";
import { decodeReadText, decodeTextChunks } from "../src/core/tools/file-text-decoder.ts";

vi.mock("../src/core/python-runtime.ts", () => ({
	ensurePythonRuntime: vi.fn(async () => ({
		status: "ready",
		pythonPath: process.platform === "win32" ? "python" : "python3",
		uvPath: "synthetic-unused",
		pythonInstalled: false,
	})),
}));

const fixturePath = "/fixture/source.pas";

// clearAllMocks keeps a per-test mockResolvedValue in place; restore the ready runtime explicitly.
afterEach(() => {
	vi.mocked(ensurePythonRuntime).mockResolvedValue({
		status: "ready",
		pythonPath: process.platform === "win32" ? "python" : "python3",
		uvPath: "synthetic-unused",
		pythonInstalled: false,
	});
});

async function decoded(chunks: Iterable<Buffer> | AsyncIterable<Buffer>, encoding?: string, signal?: AbortSignal) {
	const parts: string[] = [];
	for await (const text of decodeTextChunks(chunks, fixturePath, encoding, signal)) parts.push(text);
	return parts.join("");
}

const expected = "café🙂\r\nnext\rlast\n";
const utf32 = Buffer.alloc([...`\uFEFF${expected}`].length * 4);
[...`\uFEFF${expected}`].forEach((point, index) => {
	utf32.writeUInt32LE(point.codePointAt(0) ?? 0, index * 4);
});
const fixtures = [
	{ name: "UTF-8", bytes: Buffer.from(`\uFEFF${expected}`), expected },
	{ name: "UTF-16LE", bytes: Buffer.from(`\uFEFF${expected}`, "utf16le"), expected },
	{ name: "UTF-16BE", bytes: Buffer.from(`\uFEFF${expected}`, "utf16le").swap16(), expected },
	{ name: "UTF-32LE", bytes: utf32, expected },
	{ name: "UTF-32BE", bytes: Buffer.from(utf32).swap32(), expected },
	{ name: "stateful UTF-7", bytes: Buffer.from("+AGE-+AOk-\n"), expected: "aé\n", encoding: "utf-7" },
];

describe("incremental source text decoding", () => {
	it.each(fixtures)(
		"retains $name characters and endings across one-byte boundaries",
		async (fixture) => {
			const chunks = [...fixture.bytes].flatMap((byte) => [Buffer.alloc(0), Buffer.from([byte])]);
			expect(await decoded(chunks, fixture.encoding)).toBe(fixture.expected);
		},
		15_000,
	);

	it.each(fixtures)("produces the same $name result for deterministic irregular chunks", async (fixture) => {
		const chunks: Buffer[] = [];
		let cursor = 0;
		let stride = 3;
		while (cursor < fixture.bytes.length) {
			chunks.push(fixture.bytes.subarray(cursor, cursor + stride));
			cursor += stride;
			stride = ((stride * 7) % 13) + 1;
		}
		expect(await decoded(chunks, fixture.encoding)).toBe(fixture.expected);
	});

	it.each([
		{ bytes: Buffer.from([0xff, 0xfe, 0x61]), encoding: undefined },
		{ bytes: Buffer.from("\uFEFFabc", "utf16le"), encoding: "cp1252" },
		{ bytes: Buffer.from("YWJj"), encoding: "base64_codec" },
	])("does not certify incomplete, conflicting, or non-text data: %j", async ({ bytes, encoding }) => {
		await expect(decoded([bytes], encoding)).rejects.toThrow(/encoding|codec/i);
	});

	it.each([
		{ name: "one chunk", stride: 0 },
		{ name: "one-byte chunks", stride: 1 },
	])("resolves undeclared single-byte source text through the codec ($name)", async ({ stride }) => {
		// "line1\nline2\ncafé\n" as windows-1252: the 0xe9 opening line 3 is undecodable as UTF-8.
		const bytes = Buffer.concat([Buffer.from("line1\nline2\ncaf"), Buffer.from([0xe9, 0x0a])]);
		const source = stride === 0 ? [bytes] : [...bytes].map((byte) => Buffer.from([byte]));
		expect(await decoded(source)).toBe("line1\nline2\ncafé\n");
	});

	it("hands an ASCII prefix to the codec when the first undecodable byte arrives late", async () => {
		const bytes = Buffer.concat([Buffer.from("ascii header\n"), Buffer.from([0xe9, 0x0a])]);
		expect(await decoded([bytes.subarray(0, 8), bytes.subarray(8)])).toBe("ascii header\né\n");
	});

	it("reports the first undecodable byte when no codec can be resolved", async () => {
		const failure = await decoded([Buffer.from("ok\n\0rest")]).then(
			() => undefined,
			(error: unknown) => error,
		);
		const message = (failure as Error).message;
		expect(message).toContain("PI_FILE_ENCODING_CORRUPTION");
		expect(message).toContain(`${fixturePath} at line 2, byte offset 3`);
		expect(failure).not.toHaveProperty("failureCode", "read_encoding_required");
	});

	it("asks for an encoding only when the managed Python codec is unavailable", async () => {
		vi.mocked(ensurePythonRuntime).mockResolvedValue({ status: "offline", reason: "Synthetic offline runtime" });
		const bytes = Buffer.concat([Buffer.from("line1\nline2\ncaf"), Buffer.from([0xe9, 0x0a])]);
		const failure = await decoded([bytes]).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(failure).toMatchObject({ failureCode: "read_encoding_required", errorKind: "tool_failure" });
		expect((failure as Error).message).toBe(
			`PI_READ_ENCODING_REQUIRED: ${fixturePath} is not valid UTF-8 (first invalid byte at line 3, byte offset 15) and the managed Python codec is unavailable (Synthetic offline runtime). Run pi doctor to provision Python, or pass encoding.`,
		);
	});

	it("keeps codec failures for an explicitly named encoding out of the read-encoding class", async () => {
		const failure = await decoded([Buffer.from("\uFEFFabc", "utf16le")], "cp1252").then(
			() => undefined,
			(error: unknown) => error,
		);
		expect((failure as Error).message).toContain("PI_FILE_ENCODING_CORRUPTION");
		expect(failure).not.toHaveProperty("failureCode", "read_encoding_required");
	});

	it("retains a UTF-16 surrogate pair across the native 1 MiB scan boundary", async () => {
		const text = `${"a".repeat(524286)}🙂last`;
		const bytes = Buffer.from(`\uFEFF${text}`, "utf16le");
		expect(await decodeReadText(bytes, fixturePath)).toBe(text);
	});

	it("does not pull a backend after cancellation before iteration", async () => {
		const controller = new AbortController();
		controller.abort();
		let pulls = 0;
		async function* source() {
			pulls++;
			yield Buffer.from("abcd");
		}
		await expect(decoded(source(), undefined, controller.signal)).rejects.toThrow(/abort/i);
		expect(pulls).toBe(0);
	});

	it("closes an encoded backend iterator when a consumer stops early", async () => {
		let closed = false;
		let reads = 0;
		async function* source() {
			try {
				reads++;
				yield Buffer.from("\uFEFFfirst", "utf16le");
				reads++;
				yield Buffer.from("second", "utf16le");
			} finally {
				closed = true;
			}
		}
		for await (const text of decodeTextChunks(source(), fixturePath)) {
			expect(text).toBe("first");
			break;
		}
		expect({ reads, closed }).toEqual({ reads: 1, closed: true });
	});

	it("retains backend I/O errors instead of reclassifying them as encoding failures", async () => {
		const failure = new Error("synthetic backend failure");
		async function* source() {
			yield Buffer.from("abcd");
			throw failure;
		}
		await expect(decoded(source())).rejects.toBe(failure);
	});

	it("does not pull another source chunk after cancellation between yielded chunks", async () => {
		const controller = new AbortController();
		let reads = 0;
		let closed = false;
		async function* source() {
			try {
				reads++;
				yield Buffer.from("abcd");
				reads++;
				yield Buffer.from("efgh");
			} finally {
				closed = true;
			}
		}
		const iterator = decodeTextChunks(source(), fixturePath, undefined, controller.signal);
		expect((await iterator.next()).value).toBe("abcd");
		controller.abort();
		await expect(iterator.next()).rejects.toThrow(/abort/i);
		expect({ reads, closed }).toEqual({ reads: 1, closed: true });
	});
});
