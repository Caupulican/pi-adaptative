import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensurePythonRuntime } from "../src/core/python-runtime.ts";
import { createEditTool } from "../src/core/tools/edit.ts";
import { pythonEditByteCodec } from "../src/core/tools/edit-byte-codec.ts";
import { computeEditsPlannedDiff } from "../src/core/tools/edit-diff.ts";
import { FileMutationIntentController } from "../src/core/tools/file-mutation-intent.ts";
import { createWriteTool } from "../src/core/tools/write.ts";
import { memoryFileBackend } from "./fixtures/memory-file-backend.ts";

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

async function fixture(bytes: Buffer) {
	const cwd = await mkdtemp(join(tmpdir(), "pi-encoding-recovery-"));
	directories.push(cwd);
	const path = join(cwd, "source é.txt");
	await writeFile(path, bytes);
	const intentController = new FileMutationIntentController();
	return { cwd, path, intentController, tool: createEditTool(cwd, { intentController }) };
}

describe("managed edit encoding recovery", () => {
	it.each(["utf-16-le", "utf-16-be"])(
		"recovers a BOM-marked %s file and preserves exact copy references",
		async (encoding) => {
			const before = Buffer.from("café🙂\r\ntarget\nlast\r", "utf16le");
			const after = Buffer.from("café🙂\r\nchanged\nlast\r", "utf16le");
			if (encoding === "utf-16-be") {
				before.swap16();
				after.swap16();
			}
			const bom = Buffer.from(encoding === "utf-16-be" ? [0xfe, 0xff] : [0xff, 0xfe]);
			const { tool, path, cwd, intentController } = await fixture(Buffer.concat([bom, before]));
			expect(await computeEditsPlannedDiff(path, [{ oldText: "target", newText: "changed" }], cwd)).toHaveProperty(
				"diff",
				expect.stringContaining("changed"),
			);
			const result = await tool.execute("recover", { path, edits: [{ oldText: "target", newText: "changed" }] });
			const expected = Buffer.concat([bom, after]);
			expect(await readFile(path)).toEqual(expected);
			expect(result.details).toMatchObject({ encodingRecovery: { codec: "python", encoding, verified: true } });
			const details = result.details as { contentRef: string };
			const copy = join(cwd, "copy.txt");
			await createWriteTool(cwd, { intentController }).execute("copy", {
				path: copy,
				contentRef: details.contentRef,
			});
			expect(await readFile(copy)).toEqual(expected);
		},
	);

	it("uses an explicit legacy codec without rewriting untouched bytes or line endings", async () => {
		const before = Buffer.from([0x93, 0xe9, 0x94, 13, 10, ...Buffer.from("target\nlast\r")]);
		const { tool, path } = await fixture(before);
		await tool.execute("recover", { path, encoding: "cp1252", edits: [{ oldText: "target", newText: "café" }] });
		expect(await readFile(path)).toEqual(
			Buffer.from([0x93, 0xe9, 0x94, 13, 10, 99, 97, 102, 0xe9, 10, ...Buffer.from("last\r")]),
		);
	});

	it("retains the codec with a path-retarget payload and rejects changing it", async () => {
		const { tool, path, cwd, intentController } = await fixture(Buffer.from("targeté", "latin1"));
		try {
			let failure: unknown;
			try {
				await tool.execute("missing", {
					path: join(cwd, "missing"),
					encoding: "cp1252",
					edits: [{ oldText: "target", newText: "café" }],
				});
			} catch (error) {
				failure = error;
			}
			const payloadRef = String(failure).match(/file-mutation:[\da-f-]+/)?.[0];
			if (!payloadRef) throw new Error("Missing retained payload");
			await expect(tool.execute("wrong-codec", { path, payloadRef, encoding: "latin1" })).rejects.toThrow(
				/retained source encoding/,
			);
			await tool.execute("retarget", { path, payloadRef });
			expect(await readFile(path)).toEqual(Buffer.from("caféé", "latin1"));
		} finally {
			await intentController.dispose();
		}
	});

	it("preserves BOM-less UTF-16 and mixed endings with explicit encoding and disjoint spans", async () => {
		const before = "🙂\r\none\ntwo\rlast";
		const { tool, path } = await fixture(Buffer.from(before, "utf16le"));
		await tool.execute("recover", {
			path,
			encoding: "utf-16-le",
			edits: [
				{ oldText: "one\ntwo", newText: "ONE\nTWO" },
				{ oldText: "last", newText: "LAST" },
			],
		});
		expect(await readFile(path)).toEqual(Buffer.from("🙂\r\nONE\nTWO\rLAST", "utf16le"));
	});

	it.each([false, true])("recovers UTF-32 with byte order bigEndian=$0", async (bigEndian) => {
		const encode = (text: string) => {
			const points = [...text];
			const bytes = Buffer.alloc(points.length * 4);
			points.forEach((point, index) => {
				if (bigEndian) bytes.writeUInt32BE(point.codePointAt(0) ?? 0, index * 4);
				else bytes.writeUInt32LE(point.codePointAt(0) ?? 0, index * 4);
			});
			return bytes;
		};
		const { tool, path } = await fixture(encode("\uFEFF🙂\r\ntarget\n"));
		await tool.execute("recover", { path, edits: [{ oldText: "target", newText: "changed" }] });
		expect(await readFile(path)).toEqual(encode("\uFEFF🙂\r\nchanged\n"));
	});

	it("does not certify a backend that acknowledges but drops the encoded write", async () => {
		const before = Buffer.from("\uFEFFtarget", "utf16le");
		const { cwd, path, intentController } = await fixture(before);
		const tool = createEditTool(cwd, { intentController, operations: { readFile, writeFile: async () => {} } });
		await expect(
			tool.execute("recover", { path, edits: [{ oldText: "target", newText: "changed" }] }),
		).rejects.toThrow(/write verification failed/);
		expect(await readFile(path)).toEqual(before);
	});

	it("keeps verification bytes independent of an adapter mutating its input buffer", async () => {
		const { cwd, path, intentController } = await fixture(Buffer.from("\uFEFFtarget", "utf16le"));
		const tool = createEditTool(cwd, {
			intentController,
			operations: {
				readFile,
				writeFile: async (target, content) => {
					if (!Buffer.isBuffer(content)) throw new Error("Expected recovery bytes");
					content.fill(0);
					await writeFile(target, content);
				},
			},
		});
		await expect(
			tool.execute("mutated-input", { path, edits: [{ oldText: "target", newText: "changed" }] }),
		).rejects.toThrow(/write verification failed/);
	});

	it("rereads a stale encoded source and retains the external bytes when its anchor survives", async () => {
		const before = Buffer.from("\uFEFFtarget\r\n", "utf16le");
		const { cwd, path, intentController } = await fixture(before);
		let reads = 0;
		const tool = createEditTool(cwd, {
			intentController,
			operations: {
				readFile: async (target) => {
					const bytes = await readFile(target);
					if (++reads === 1) await writeFile(target, Buffer.from("\uFEFFexternal\ntarget\r\n", "utf16le"));
					return bytes;
				},
				writeFile,
			},
		});
		await tool.execute("recover", { path, edits: [{ oldText: "target", newText: "changed" }] });
		expect(await readFile(path)).toEqual(Buffer.from("\uFEFFexternal\nchanged\r\n", "utf16le"));
	});

	it.each([
		{ encoding: "cp1252", newText: "🙂", bytes: Buffer.from("targeté", "latin1") },
		{ encoding: "cp1252", newText: "changed", bytes: Buffer.from("\uFEFFtarget", "utf16le") },
		{ encoding: "cp1252", newText: "changed", bytes: Buffer.from("ok\n\0rest") },
	])(
		"does not mutate for unavailable encoding evidence or an unsafe conversion: $encoding",
		async ({ encoding, newText, bytes }) => {
			const { tool, path } = await fixture(bytes);
			await expect(
				tool.execute("recover", { path, encoding, edits: [{ oldText: "target", newText }] }),
			).rejects.toThrow(/encoding|codec|BOM/i);
			expect(await readFile(path)).toEqual(bytes);
		},
	);

	it("does not start recovery or mutate after cancellation", async () => {
		const bytes = Buffer.from("\uFEFFtarget", "utf16le");
		const { tool, path } = await fixture(bytes);
		const controller = new AbortController();
		controller.abort();
		await expect(
			tool.execute("recover", { path, edits: [{ oldText: "target", newText: "changed" }] }, controller.signal),
		).rejects.toThrow(/abort/i);
		expect(await readFile(path)).toEqual(bytes);
	});

	it("uses only backend bytes for a foreign UNC target", async () => {
		const path = "\\\\fixture-host\\share\\é\\file.txt";
		const backend = memoryFileBackend("win32");
		backend.seed(path, "metadata");
		let bytes = Buffer.from("\uFEFFtarget\r\n", "utf16le");
		const intentController = new FileMutationIntentController({
			pathOptions: { flavor: "win32" },
			operations: {
				...backend.operations,
				hashFile: async () => createHash("sha256").update(bytes).digest("hex"),
			},
		});
		const tool = createEditTool("Q:\\synthetic", {
			intentController,
			operations: {
				readFile: async (target) => {
					expect(target).toBe(path);
					return Buffer.from(bytes);
				},
				writeFile: async (target, content) => {
					expect(target).toBe(path);
					expect(Buffer.isBuffer(content)).toBe(true);
					bytes = Buffer.from(content);
					backend.seed(path, "changed metadata");
				},
			},
		});
		await tool.execute("foreign", { path, edits: [{ oldText: "target", newText: "changed" }] });
		expect(bytes).toEqual(Buffer.from("\uFEFFchanged\r\n", "utf16le"));
	});

	it("leaves the source unchanged when the managed runtime is unavailable", async () => {
		const bytes = Buffer.from("\uFEFFtarget", "utf16le");
		const { tool, path } = await fixture(bytes);
		vi.mocked(ensurePythonRuntime).mockResolvedValueOnce({ status: "offline", reason: "Synthetic offline runtime" });
		await expect(
			tool.execute("unavailable", { path, edits: [{ oldText: "target", newText: "changed" }] }),
		).rejects.toThrow(/requires Python.*offline/);
		expect(await readFile(path)).toEqual(bytes);
	});

	it.each([
		[{ start: 1, end: 2, replacement: "X" }],
		[{ start: 2, end: 99, replacement: "X" }],
		[
			{ start: 2, end: 4, replacement: "X" },
			{ start: 3, end: 4, replacement: "Y" },
		],
	])("independently rejects invalid or split-character codec spans: %j", async (...splices) => {
		const document = await pythonEditByteCodec.decode(Buffer.from("\uFEFF🙂target", "utf16le"), undefined);
		await expect(document.encode(splices)).rejects.toThrow(/could not verify preservation/);
		// Negative control: the same decoded document can still encode a valid plan.
		expect(await document.encode([{ start: 2, end: 8, replacement: "changed" }])).toEqual(
			Buffer.from("\uFEFF🙂changed", "utf16le"),
		);
	});

	it("refuses a noncanonical encoding round-trip instead of normalizing the original bytes", async () => {
		// UTF-7 permits the shifted spelling of ASCII 'a'; its canonical encoder emits plain 'a'.
		await expect(pythonEditByteCodec.decode(Buffer.from("+AGE-target"), "utf-7")).rejects.toThrow(
			/could not verify preservation/,
		);
	});
});
