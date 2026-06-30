import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkPathScope, safeRealpathSync } from "../src/core/autonomy/path-scope.ts";

describe("path-scope", () => {
	let tempDir: string;
	let allowedRoot: string;
	let outsideRoot: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-path-scope-test-"));
		allowedRoot = path.join(tempDir, "allowed");
		outsideRoot = path.join(tempDir, "outside");

		fs.mkdirSync(allowedRoot, { recursive: true });
		fs.mkdirSync(outsideRoot, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	describe("checkPathScope", () => {
		it("returns inside for exact allowed root match", () => {
			const decision = checkPathScope({ root: allowedRoot }, allowedRoot);
			expect(decision.kind).toBe("inside");
		});

		it("returns inside for a file inside the allowed root", () => {
			const targetFile = path.join(allowedRoot, "file.txt");
			fs.writeFileSync(targetFile, "test");
			const decision = checkPathScope({ root: allowedRoot }, targetFile);
			expect(decision.kind).toBe("inside");
		});

		it("returns inside for a missing file under allowed dir", () => {
			const targetFile = path.join(allowedRoot, "does-not-exist.txt");
			const decision = checkPathScope({ root: allowedRoot }, targetFile);
			expect(decision.kind).toBe("inside");
		});

		it("returns outside for a file outside the allowed root", () => {
			const targetFile = path.join(outsideRoot, "file.txt");
			fs.writeFileSync(targetFile, "test");
			const decision = checkPathScope({ root: allowedRoot }, targetFile);
			expect(decision.kind).toBe("outside");
		});

		it("returns outside for a missing path with .. escaping root", () => {
			const targetFile = path.join(allowedRoot, "..", "outside", "file.txt");
			const decision = checkPathScope({ root: allowedRoot }, targetFile);
			expect(decision.kind).toBe("outside");
		});

		it("returns outside for a sibling path with a shared prefix", () => {
			const root = path.join(tempDir, "repo", "app");
			const targetFile = path.join(tempDir, "repo", "app2", "file.txt");
			fs.mkdirSync(root, { recursive: true });
			fs.mkdirSync(path.dirname(targetFile), { recursive: true });
			fs.writeFileSync(targetFile, "test");

			const decision = checkPathScope({ root }, targetFile);
			expect(decision.kind).toBe("outside");
		});

		it("safely resolves existing symlink inside root pointing outside root as outside/denied", () => {
			// Create a symlink inside allowedRoot that points to outsideRoot
			const symlinkPath = path.join(allowedRoot, "symlink-out");
			fs.symlinkSync(outsideRoot, symlinkPath, "dir");

			// Writing to the symlink directory should be blocked
			const targetFile = path.join(symlinkPath, "evil.txt");
			const decision = checkPathScope({ root: allowedRoot }, targetFile);
			expect(decision.kind).toBe("outside");
		});

		it("safely resolves symlinks pointing inside the allowed root as inside", () => {
			// Create a nested dir
			const nestedDir = path.join(allowedRoot, "nested");
			fs.mkdirSync(nestedDir);

			// Create a symlink in outsideRoot pointing to nestedDir
			const symlinkPath = path.join(outsideRoot, "symlink-in");
			fs.symlinkSync(nestedDir, symlinkPath, "dir");

			const targetFile = path.join(symlinkPath, "good.txt");
			const decision = checkPathScope({ root: allowedRoot }, targetFile);
			// It is technically inside the root because its realpath is inside allowedRoot!
			expect(decision.kind).toBe("inside");
		});

		it("respects allowedPaths within root", () => {
			const subdir1 = path.join(allowedRoot, "sub1");
			const subdir2 = path.join(allowedRoot, "sub2");
			fs.mkdirSync(subdir1);
			fs.mkdirSync(subdir2);

			const file1 = path.join(subdir1, "file1.txt");
			const file2 = path.join(subdir2, "file2.txt");

			const decision1 = checkPathScope({ root: allowedRoot, allowedPaths: [subdir1] }, file1);
			expect(decision1.kind).toBe("inside");

			const decision2 = checkPathScope({ root: allowedRoot, allowedPaths: [subdir1] }, file2);
			expect(decision2.kind).toBe("outside");
			expect(decision2.reasonCode).toBe("outside_allowed_paths");
		});

		it("deniedPaths override allowedPaths", () => {
			const subdir1 = path.join(allowedRoot, "sub1");
			const nestedDenied = path.join(subdir1, "denied");
			fs.mkdirSync(subdir1);
			fs.mkdirSync(nestedDenied);

			const goodFile = path.join(subdir1, "good.txt");
			const deniedFile = path.join(nestedDenied, "bad.txt");

			const scope = {
				root: allowedRoot,
				allowedPaths: [subdir1],
				deniedPaths: [nestedDenied],
			};

			const decisionGood = checkPathScope(scope, goodFile);
			expect(decisionGood.kind).toBe("inside");

			const decisionBad = checkPathScope(scope, deniedFile);
			expect(decisionBad.kind).toBe("denied");
			expect(decisionBad.reasonCode).toBe("matches_denied_path");
		});
	});

	describe("safeRealpathSync", () => {
		it("resolves the real path of an existing file", () => {
			const targetFile = path.join(allowedRoot, "file.txt");
			fs.writeFileSync(targetFile, "test");
			expect(safeRealpathSync(targetFile)).toBe(fs.realpathSync(targetFile));
		});

		it("resolves the real path of a non-existent file in an existing directory", () => {
			const targetFile = path.join(allowedRoot, "non-existent.txt");
			expect(safeRealpathSync(targetFile)).toBe(path.join(fs.realpathSync(allowedRoot), "non-existent.txt"));
		});

		it("resolves the real path of a deeply non-existent file", () => {
			const targetFile = path.join(allowedRoot, "a", "b", "c", "non-existent.txt");
			expect(safeRealpathSync(targetFile)).toBe(
				path.join(fs.realpathSync(allowedRoot), "a", "b", "c", "non-existent.txt"),
			);
		});
	});
});
