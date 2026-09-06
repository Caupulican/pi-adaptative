import { describe, expect, it, vi } from "vitest";
import { decodeReadText, decodeTextChunks } from "../src/core/tools/file-text-decoder.ts";

vi.mock("../src/core/python-runtime.ts", () => ({
	ensurePythonRuntime: vi.fn(async () => ({
		status: "ready",
		pythonPath: process.platform === "win32" ? "python" : "python3",
		uvPath: "synthetic-unused",
		pythonInstalled: false,
	})),
}));

async function decoded(chunks: Iterable<Buffer> | AsyncIterable<Buffer>, encoding?: string, signal?: AbortSignal) {
	const parts: string[] = [];
	for await (const text of decodeTextChunks(chunks, encoding, signal)) parts.push(text);
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
		{ bytes: Buffer.from([0x61, 0x62, 0x63, 0x64, 0xc3]), encoding: undefined },
		{ bytes: Buffer.from("\uFEFFabc", "utf16le"), encoding: "cp1252" },
		{ bytes: Buffer.from("YWJj"), encoding: "base64_codec" },
	])("does not certify incomplete, conflicting, or non-text data: %j", async ({ bytes, encoding }) => {
		await expect(decoded([bytes], encoding)).rejects.toThrow(/encoding|codec/i);
	});

	it("retains a UTF-16 surrogate pair across the native 1 MiB scan boundary", async () => {
		const text = `${"a".repeat(524286)}🙂last`;
		const bytes = Buffer.from(`\uFEFF${text}`, "utf16le");
		expect(await decodeReadText(bytes)).toBe(text);
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
		for await (const text of decodeTextChunks(source())) {
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
		const iterator = decodeTextChunks(source(), undefined, controller.signal);
		expect((await iterator.next()).value).toBe("abcd");
		controller.abort();
		await expect(iterator.next()).rejects.toThrow(/abort/i);
		expect({ reads, closed }).toEqual({ reads: 1, closed: true });
	});
});
