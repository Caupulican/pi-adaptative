import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyEncodingPreservation,
	isConsistentlyCRLF,
	isValidUTF8,
	utf8ByteLength,
} from "../src/core/tools/file-encoding-policy.ts";
import { createEditTool, createWriteTool } from "../src/index.ts";

describe("File Encoding Policy - Unit Tests", () => {
	describe("isValidUTF8", () => {
		it("should return true for valid UTF-8 text", () => {
			const buf = Buffer.from("Hello world! 🚀", "utf-8");
			expect(isValidUTF8(buf)).toBe(true);
		});

		it("should return false for invalid UTF-8 (arbitrary binary data)", () => {
			const buf = Buffer.from([0xff, 0xfe, 0x80, 0xbf]);
			expect(isValidUTF8(buf)).toBe(false);
		});
	});

	describe("isConsistentlyCRLF", () => {
		it("should return true for CRLF only endings", () => {
			expect(isConsistentlyCRLF("line1\r\nline2\r\n")).toBe(true);
		});

		it("should return false for LF only endings", () => {
			expect(isConsistentlyCRLF("line1\nline2\n")).toBe(false);
		});

		it("should return false for mixed line endings", () => {
			expect(isConsistentlyCRLF("line1\r\nline2\n")).toBe(false);
		});
	});

	describe("applyEncodingPreservation", () => {
		it("should preserve existing UTF-8 BOM", () => {
			const existing = "\uFEFFline1\n";
			const replacement = "new content";
			const result = applyEncodingPreservation(existing, replacement);
			expect(result.startsWith("\uFEFF")).toBe(true);
			expect(result).toBe("\uFEFFnew content");
		});

		it("should preserve CRLF for LF-only replacement", () => {
			const existing = "line1\r\nline2\r\n";
			const replacement = "new1\nnew2\n";
			const result = applyEncodingPreservation(existing, replacement);
			expect(result).toBe("new1\r\nnew2\r\n");
		});

		it("should not double-add BOM if new content already has BOM", () => {
			const existing = "\uFEFFline1\n";
			const replacement = "\uFEFFnew content";
			const result = applyEncodingPreservation(existing, replacement);
			expect(result).toBe("\uFEFFnew content");
		});

		it("should report accurate UTF-8 byte count", () => {
			expect(utf8ByteLength("🚀")).toBe(4);
			expect(utf8ByteLength("hello")).toBe(5);
		});
	});
});

describe("File Encoding Policy - Tool Integration Tests", () => {
	let testDir: string;
	let editTool: ReturnType<typeof createEditTool>;
	let writeTool: ReturnType<typeof createWriteTool>;

	beforeEach(() => {
		testDir = join(tmpdir(), `pi-encoding-integration-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		editTool = createEditTool(testDir);
		writeTool = createWriteTool(testDir);
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("edit tool should refuse non-UTF-8 files", async () => {
		const filePath = join(testDir, "binary.dat");
		writeFileSync(filePath, Buffer.from([0xff, 0xfe, 0x80, 0xbf]));

		await expect(
			editTool.execute("test-call-1", {
				path: "binary.dat",
				edits: [{ oldText: "test", newText: "best" }],
			}),
		).rejects.toThrow(/Binary or non-UTF-8 text cannot be safely edited/);
	});

	it("edit tool should preserve BOM", async () => {
		const filePath = join(testDir, "bom.txt");
		writeFileSync(filePath, "\uFEFFhello world\n", "utf-8");

		await editTool.execute("test-call-2", {
			path: "bom.txt",
			edits: [{ oldText: "hello", newText: "bye" }],
		});

		const content = readFileSync(filePath, "utf-8");
		expect(content.startsWith("\uFEFF")).toBe(true);
		expect(content).toBe("\uFEFFbye world\n");
	});

	it("edit tool should preserve CRLF", async () => {
		const filePath = join(testDir, "crlf.txt");
		writeFileSync(filePath, "line1\r\nline2\r\n", "utf-8");

		await editTool.execute("test-call-3", {
			path: "crlf.txt",
			edits: [{ oldText: "line2", newText: "line3" }],
		});

		const content = readFileSync(filePath, "utf-8");
		expect(content).toBe("line1\r\nline3\r\n");
	});

	it("write tool should preserve BOM when overwriting", async () => {
		const filePath = join(testDir, "write-bom.txt");
		writeFileSync(filePath, "\uFEFFinitial\n", "utf-8");

		await writeTool.execute("test-call-4", {
			path: "write-bom.txt",
			content: "overwrite content",
		});

		const content = readFileSync(filePath, "utf-8");
		expect(content.startsWith("\uFEFF")).toBe(true);
		expect(content).toBe("\uFEFFoverwrite content");
	});

	it("write tool should preserve CRLF when overwriting with LF content", async () => {
		const filePath = join(testDir, "write-crlf.txt");
		writeFileSync(filePath, "line1\r\nline2\r\n", "utf-8");

		await writeTool.execute("test-call-5", {
			path: "write-crlf.txt",
			content: "new1\nnew2\n",
		});

		const content = readFileSync(filePath, "utf-8");
		expect(content).toBe("new1\r\nnew2\r\n");
	});

	it("write tool should report UTF-8 byte count", async () => {
		const result = await writeTool.execute("test-call-6", {
			path: "bytes.txt",
			content: "🚀",
		});
		const text = result.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");
		expect(text).toContain("Successfully wrote 4 bytes");
	});
});
