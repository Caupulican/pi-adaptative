import { basename, dirname, relative, sep } from "node:path";
import { Minimatch, minimatch } from "minimatch";
import { afterEach, describe, expect, it, vi } from "vitest";
import { matchesResourceProfilePattern } from "../src/core/settings-manager.ts";
import { matchesCompiledPattern } from "../src/core/util/minimatch-cache.ts";
import { resolvePath } from "../src/utils/paths.ts";

// package-manager.ts's matchesAnyPattern and settings-manager.ts's matchesResourceProfilePattern both
// used to call the functional `minimatch(candidate, pattern)`, which re-parses `pattern` into a fresh
// Minimatch instance on every call. Both now route through `matchesCompiledPattern`, which compiles each
// unique pattern once and reuses it. These tests assert (1) matching behavior is byte-identical to the
// functional form across a matrix that includes negation, extglob, dot-files, and windows-ish paths, and
// (2) the compiled-pattern cache really does compile each unique pattern exactly once.

afterEach(() => {
	vi.restoreAllMocks();
});

describe("matchesCompiledPattern parity with functional minimatch", () => {
	const matrix: Array<{ label: string; candidate: string; pattern: string }> = [
		{ label: "plain extension glob (match)", candidate: "foo.ts", pattern: "*.ts" },
		{ label: "plain extension glob (no match)", candidate: "foo.js", pattern: "*.ts" },
		{ label: "globstar directory match", candidate: "src/core/file.ts", pattern: "src/**/*.ts" },
		{ label: "globstar directory no match", candidate: "lib/core/file.ts", pattern: "src/**/*.ts" },
		{ label: "globstar matches zero dirs", candidate: "file.ts", pattern: "**/*.ts" },
		{ label: "negation excludes match", candidate: "foo.ts", pattern: "!*.ts" },
		{ label: "negation lets non-match through", candidate: "foo.js", pattern: "!*.ts" },
		{ label: "extglob one-or-more (single rep)", candidate: "a.ts", pattern: "+(a|b).ts" },
		{ label: "extglob one-or-more (repeated)", candidate: "ab.ts", pattern: "+(a|b).ts" },
		{ label: "extglob one-or-more (no match)", candidate: "c.ts", pattern: "+(a|b).ts" },
		{ label: "extglob optional present", candidate: "color.ts", pattern: "colo?(u)r.ts" },
		{ label: "extglob optional absent", candidate: "colour.ts", pattern: "colo?(u)r.ts" },
		{ label: "dotfile: bare star does not match leading dot", candidate: ".env", pattern: "*.env" },
		{ label: "dotfile: dot-prefixed pattern matches", candidate: ".env", pattern: ".*" },
		{ label: "dotfile: dot-prefixed pattern rejects non-dotfile", candidate: "foo.env", pattern: ".*" },
		{ label: "character class match", candidate: "file1.ts", pattern: "file[0-9].ts" },
		{ label: "character class no match", candidate: "fileA.ts", pattern: "file[0-9].ts" },
		{
			label: "windows-ish backslash path, literal pattern",
			candidate: "src\\core\\file.ts",
			pattern: "src\\core\\file.ts",
		},
		{
			label: "windows-ish backslash path vs posix pattern",
			candidate: "src\\core\\file.ts",
			pattern: "src/core/*.ts",
		},
		{ label: "comment-style pattern matches nothing (truthy candidate)", candidate: "foo.ts", pattern: "#comment" },
		{ label: "comment-style pattern matches nothing (empty candidate)", candidate: "", pattern: "#comment" },
		{ label: "empty pattern matches only empty string (empty candidate)", candidate: "", pattern: "" },
		{ label: "empty pattern matches only empty string (non-empty candidate)", candidate: "foo", pattern: "" },
		{ label: "brace expansion", candidate: "file.ts", pattern: "file.{ts,tsx}" },
		{ label: "brace expansion no match", candidate: "file.jsx", pattern: "file.{ts,tsx}" },
	];

	for (const { label, candidate, pattern } of matrix) {
		it(`matches ${label}`, () => {
			expect(matchesCompiledPattern(candidate, pattern)).toBe(minimatch(candidate, pattern));
		});
	}
});

describe("matchesResourceProfilePattern parity with the pre-cache functional path", () => {
	// Re-implements settings-manager.ts's ORIGINAL matchesResourceProfilePattern body using the functional
	// minimatch directly, to prove the live (now-cached) implementation still returns the same verdicts for
	// the same inputs — i.e. the call-site swap didn't change matching semantics.
	function legacyMatchesResourceProfilePattern(resourcePath: string, patterns: string[], baseDir = ""): boolean {
		if (patterns.length === 0) return false;
		const toPosix = (p: string) => p.split(sep).join("/");
		const resolvedBase = baseDir ? resolvePath(baseDir) : "";
		const rel = resolvedBase ? toPosix(relative(resolvedBase, resourcePath)) : toPosix(resourcePath);
		const name = basename(resourcePath);
		const filePathPosix = toPosix(resourcePath);
		const parentDir = dirname(resourcePath);
		const parentRel = resolvedBase ? toPosix(relative(resolvedBase, parentDir)) : toPosix(parentDir);
		const parentName = basename(parentDir);
		const parentDirPosix = toPosix(parentDir);

		return patterns.some((pattern) => {
			const normalizedPattern = toPosix(pattern);
			return (
				minimatch(rel, normalizedPattern) ||
				minimatch(name, normalizedPattern) ||
				minimatch(filePathPosix, normalizedPattern) ||
				minimatch(parentRel, normalizedPattern) ||
				minimatch(parentName, normalizedPattern) ||
				minimatch(parentDirPosix, normalizedPattern)
			);
		});
	}

	const cases: Array<{ label: string; resourcePath: string; patterns: string[]; baseDir?: string }> = [
		{ label: "single glob include", resourcePath: "/repo/src/skills/foo.ts", patterns: ["*.ts"] },
		{ label: "no patterns", resourcePath: "/repo/src/skills/foo.ts", patterns: [] },
		{
			label: "relative-to-baseDir match",
			resourcePath: "/repo/src/skills/foo.ts",
			patterns: ["src/skills/*.ts"],
			baseDir: "/repo",
		},
		{
			label: "negation pattern",
			resourcePath: "/repo/src/skills/foo.ts",
			patterns: ["!*.ts"],
			baseDir: "/repo",
		},
		{
			label: "extglob pattern",
			resourcePath: "/repo/skills/foobar.ts",
			patterns: ["+(foo|bar)*.ts"],
			baseDir: "/repo",
		},
		{
			label: "dotfile pattern",
			resourcePath: "/repo/.pi/skills/.env",
			patterns: [".*"],
			baseDir: "/repo/.pi/skills",
		},
		{
			label: "parent-directory-name match",
			resourcePath: "/repo/legacy/foo.ts",
			patterns: ["legacy"],
			baseDir: "/repo",
		},
		{
			label: "multiple patterns, later one matches",
			resourcePath: "/repo/src/skills/foo.ts",
			patterns: ["*.md", "*.json", "*.ts"],
			baseDir: "/repo",
		},
	];

	for (const { label, resourcePath, patterns, baseDir } of cases) {
		it(`agrees on: ${label}`, () => {
			expect(matchesResourceProfilePattern(resourcePath, patterns, baseDir)).toBe(
				legacyMatchesResourceProfilePattern(resourcePath, patterns, baseDir),
			);
		});
	}
});

describe("compiled-pattern cache", () => {
	it("compiles each unique pattern exactly once no matter how many candidates/calls reuse it", () => {
		const makeSpy = vi.spyOn(Minimatch.prototype, "make");

		const uniquePatterns = ["cache-count-a/*.ts", "cache-count-b/**/*.js", "cache-count-c.md"];
		const candidates = ["x", "cache-count-a/file.ts", "cache-count-b/deep/file.js", "cache-count-c.md"];

		// Fire many redundant calls: every pattern against every candidate, twice over.
		for (let pass = 0; pass < 2; pass++) {
			for (const pattern of uniquePatterns) {
				for (const candidate of candidates) {
					matchesCompiledPattern(candidate, pattern);
				}
			}
		}

		expect(makeSpy).toHaveBeenCalledTimes(uniquePatterns.length);
	});

	it("keys distinct option objects separately instead of reusing a mismatched compiled pattern", () => {
		const makeSpy = vi.spyOn(Minimatch.prototype, "make");
		const pattern = "*.cacheoptsenv";
		const candidate = ".cacheoptsenv";

		// Same pattern, default options vs {dot:true} must NOT reuse the same compiled Minimatch, since
		// options change matching semantics (dotfile handling here).
		const withoutDot = matchesCompiledPattern(candidate, pattern);
		const withDot = matchesCompiledPattern(candidate, pattern, { dot: true });

		expect(withoutDot).toBe(false);
		expect(withDot).toBe(true);
		expect(makeSpy).toHaveBeenCalledTimes(2);

		// Calling either variant again must not compile a third time.
		matchesCompiledPattern(candidate, pattern);
		matchesCompiledPattern(candidate, pattern, { dot: true });
		expect(makeSpy).toHaveBeenCalledTimes(2);
	});
});
