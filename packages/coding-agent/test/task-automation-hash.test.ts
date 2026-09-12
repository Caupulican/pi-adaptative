import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	computeContentHash,
	computeScriptFileHash,
	defaultTaskAutomationHashPort,
	MAX_SCRIPT_FILE_BYTES,
} from "../src/core/automation/task-automation-hash.ts";

describe("task-automation-hash", () => {
	let workspaceDir: string;
	let siblingDir: string;
	let externalDir: string;

	beforeEach(() => {
		const base = mkdtempSync(join(tmpdir(), "pi-hash-test-"));
		workspaceDir = join(base, "ws");
		siblingDir = join(base, "ws-sibling");
		externalDir = join(base, "external");

		mkdirSync(workspaceDir, { recursive: true });
		mkdirSync(siblingDir, { recursive: true });
		mkdirSync(externalDir, { recursive: true });
	});

	afterEach(() => {
		try {
			rmSync(join(workspaceDir, ".."), { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	describe("computeContentHash", () => {
		it("computes standard SHA-256 hex digest for string and Buffer", () => {
			const expectedEmpty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
			expect(computeContentHash("")).toBe(expectedEmpty);
			expect(computeContentHash(Buffer.from(""))).toBe(expectedEmpty);

			const content = "echo 'hello deterministic automation'";
			const hashStr = computeContentHash(content);
			const hashBuf = computeContentHash(Buffer.from(content, "utf8"));
			expect(hashStr).toBe(hashBuf);
			expect(hashStr).toMatch(/^[a-f0-9]{64}$/);
		});
	});

	describe("computeScriptFileHash - Workspace Containment & Symlinks", () => {
		it("hashes regular script in workspace root and nested subdirectories", () => {
			const rootScript = "run.sh";
			const rootContent = "echo 'root script'";
			writeFileSync(join(workspaceDir, rootScript), rootContent, "utf8");

			const nestedSubdir = join(workspaceDir, "nested", "sub");
			mkdirSync(nestedSubdir, { recursive: true });
			const nestedScript = "nested/sub/tool.sh";
			const nestedContent = "echo 'nested script'";
			writeFileSync(join(workspaceDir, nestedScript), nestedContent, "utf8");

			const hashRoot = computeScriptFileHash(rootScript, workspaceDir);
			expect(hashRoot).toBe(computeContentHash(rootContent));

			const hashNested = computeScriptFileHash(nestedScript, workspaceDir);
			expect(hashNested).toBe(computeContentHash(nestedContent));

			// Absolute paths within workspace are also allowed
			const hashAbsolute = computeScriptFileHash(join(workspaceDir, nestedScript), workspaceDir);
			expect(hashAbsolute).toBe(hashNested);
		});

		it("allows symlinks inside workspace that point to targets inside workspace", () => {
			const targetPath = join(workspaceDir, "target.sh");
			const targetContent = "echo 'inside workspace target'";
			writeFileSync(targetPath, targetContent, "utf8");

			const linkPath = join(workspaceDir, "symlink-inside.sh");
			symlinkSync("target.sh", linkPath);

			const hash = computeScriptFileHash("symlink-inside.sh", workspaceDir);
			expect(hash).toBe(computeContentHash(targetContent));
		});

		it("rejects sibling directory paths that share a prefix with workspace cwd", () => {
			// Sibling directory: e.g. /path/to/ws vs /path/to/ws-sibling
			const siblingScript = join(siblingDir, "sibling.sh");
			writeFileSync(siblingScript, "echo 'sibling content'", "utf8");

			// Relative traversal into sibling
			const relSibling = "../ws-sibling/sibling.sh";
			expect(computeScriptFileHash(relSibling, workspaceDir)).toBeUndefined();

			// Absolute path to sibling
			expect(computeScriptFileHash(siblingScript, workspaceDir)).toBeUndefined();
		});

		it("rejects symlinks inside workspace that point to targets outside workspace", () => {
			const outsideScript = join(externalDir, "escape.sh");
			writeFileSync(outsideScript, "echo 'secret external'", "utf8");

			const linkPath = join(workspaceDir, "symlink-outside.sh");
			symlinkSync(outsideScript, linkPath);

			// Symlink is in workspaceDir, but resolves outside workspaceDir
			const hash = computeScriptFileHash("symlink-outside.sh", workspaceDir);
			expect(hash).toBeUndefined();
		});

		it("rejects parent directory traversal (..)", () => {
			const parentFile = join(workspaceDir, "..", "parent.sh");
			writeFileSync(parentFile, "echo 'parent'", "utf8");

			expect(computeScriptFileHash("../parent.sh", workspaceDir)).toBeUndefined();
			expect(computeScriptFileHash("../../parent.sh", workspaceDir)).toBeUndefined();
		});

		it("rejects directories and non-existent files", () => {
			const subDir = join(workspaceDir, "subdir");
			mkdirSync(subDir);

			expect(computeScriptFileHash("subdir", workspaceDir)).toBeUndefined();
			expect(computeScriptFileHash(".", workspaceDir)).toBeUndefined();
			expect(computeScriptFileHash("non-existent.sh", workspaceDir)).toBeUndefined();
		});

		it("rejects empty or non-string inputs", () => {
			expect(computeScriptFileHash("", workspaceDir)).toBeUndefined();
			expect(computeScriptFileHash("script.sh", "")).toBeUndefined();
			expect(computeScriptFileHash(null as unknown as string, workspaceDir)).toBeUndefined();
			expect(computeScriptFileHash("script.sh", null as unknown as string)).toBeUndefined();
		});
	});

	describe("computeScriptFileHash - Strict 2 MB Size Cap", () => {
		it("accepts file at exactly MAX_SCRIPT_FILE_BYTES (2 MB)", () => {
			const file2MB = join(workspaceDir, "exact-2mb.sh");
			const buffer2MB = Buffer.alloc(MAX_SCRIPT_FILE_BYTES, 0x41); // 'A'
			writeFileSync(file2MB, buffer2MB);

			const hash = computeScriptFileHash("exact-2mb.sh", workspaceDir);
			expect(hash).toBeDefined();
			expect(hash).toBe(computeContentHash(buffer2MB));
		});

		it("rejects file exceeding MAX_SCRIPT_FILE_BYTES by even 1 byte (2 MB + 1)", () => {
			const fileOversized = join(workspaceDir, "oversized.sh");
			const bufferOversized = Buffer.alloc(MAX_SCRIPT_FILE_BYTES + 1, 0x41);
			writeFileSync(fileOversized, bufferOversized);

			const hash = computeScriptFileHash("oversized.sh", workspaceDir);
			expect(hash).toBeUndefined();
		});

		it("accepts empty file (0 bytes)", () => {
			const emptyFile = join(workspaceDir, "empty.sh");
			writeFileSync(emptyFile, "");

			const hash = computeScriptFileHash("empty.sh", workspaceDir);
			expect(hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
		});

		it("proves bounded read buffer allocation strictly capped at MAX_SCRIPT_FILE_BYTES + 1", () => {
			const filePath = join(workspaceDir, "bounded-read.sh");
			writeFileSync(filePath, "echo 'bounded read check'", "utf8");

			const allocSpy = vi.spyOn(Buffer, "allocUnsafe");
			try {
				const hash = computeScriptFileHash("bounded-read.sh", workspaceDir);
				expect(hash).toBeDefined();
				expect(allocSpy).toHaveBeenCalledWith(MAX_SCRIPT_FILE_BYTES + 1);
			} finally {
				allocSpy.mockRestore();
			}
		});
	});

	describe("defaultTaskAutomationHashPort", () => {
		it("implements TaskAutomationHashPort interface with computeFileHash and computeContentHash", () => {
			const scriptName = "port-test.sh";
			const content = "echo 'port test'";
			writeFileSync(join(workspaceDir, scriptName), content, "utf8");

			const fileHash = defaultTaskAutomationHashPort.computeFileHash(scriptName, workspaceDir);
			const contentHash = defaultTaskAutomationHashPort.computeContentHash(content);
			expect(fileHash).toBe(contentHash);
		});
	});
});
