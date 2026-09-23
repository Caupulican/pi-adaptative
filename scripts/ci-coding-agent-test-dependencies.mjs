/**
 * Finds coding-agent tests that depend on a source file WITHOUT importing it, so `ci-affected.mjs`
 * can add them to a narrowed `vitest related` run alongside whatever the import-graph walk finds.
 *
 * `vitest related` only follows static import edges (see codingAgentRelatedFiles in
 * ci-affected.mjs). Two real classes of coding-agent test are invisible to that walk:
 *
 *   1. Tests that read source as TEXT — `readFileSync(new URL("../src/x.ts", import.meta.url))`,
 *      or scan a whole directory the same way (e.g. `readdirSync(new URL("../src", ...))`, which
 *      depends on everything under it, not just the one path literal).
 *   2. Tests that SPAWN a whole-program entrypoint (`cli.ts`, `main.ts`, `*-cli.ts`) as a child
 *      process — the entrypoint's own transitive behavior is anything in src, not just the one
 *      spawned file, and none of that is visible as an import of the test itself.
 *
 * This module extracts every such reference from a test file's own source text (the same two
 * literal-resolution patterns actually used in this repo: `new URL("<rel>", import.meta.url)` and
 * `resolve/join(import.meta.dirname, "<rel>")`), resolves it against the test file's own
 * directory, and classifies what it depends on. Anything it cannot classify (does not resolve to
 * an existing file or directory under packages/coding-agent/src), and any "src/..."-shaped literal
 * this scan cannot precisely resolve at all (e.g. read through a variable or a non-import.meta.url
 * base — a real example is test/no-upstream-runtime.test.ts), is treated as depending on
 * everything, per the same "widen when unsure" rule as the rest of the narrowing design — this
 * scan only ever ADDS test files to a narrowed run, never removes any.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { posix } from "node:path";

export const CODING_AGENT_SRC_ROOT = "packages/coding-agent/src";
const CODING_AGENT_WORKSPACE_PREFIX = "packages/coding-agent/";
const CODING_AGENT_TEST_ROOT = "packages/coding-agent/test";

// Mirrors isTestFile in ci-affected.mjs. Not imported from there to avoid a circular import
// (ci-affected.mjs imports this module); keep the two patterns in sync if either changes.
const IS_TEST_FILE = /\.test\.(?:ts|mts|cts|mjs|js)$/u;

const URL_REFERENCE = /new URL\(\s*(["'`])((?:\.\.?\/)[^"'`]*)\1\s*,\s*import\.meta\.url\s*\)/gu;
const DIRNAME_REFERENCE = /(?:\w+\.)?(?:resolve|join)\(\s*import\.meta\.dirname\s*,\s*(["'`])((?:\.\.?\/)[^"'`]*)\1\s*\)/gu;
const PRECISE_PATTERNS = [URL_REFERENCE, DIRNAME_REFERENCE];

// A real example (test/no-upstream-runtime.test.ts) resolves a bare "src/..." literal against a
// computed, non-import.meta.url base (`new URL(relativePath, packageRoot)`, `relativePath` itself
// coming from an array of literals) — a shape this scan cannot resolve precisely. Rather than
// growing this into a general path-flow analyzer, any src-looking string literal that is not part
// of one of the two precise patterns above is treated as an unresolvable reference: see
// hasUnresolvedSourceLiteral.
const LOOSE_SRC_LITERAL = /(["'`])((?:\.\.?\/)*src\/[^"'`]*)\1/gu;

// A plain `import ... from "../src/x.ts"` (or `require`/dynamic `import(...)`) is a real import
// edge `vitest related` already walks on its own — every coding-agent test that imports anything
// from src would otherwise match LOOSE_SRC_LITERAL and be (redundantly, but disastrously)
// always-included, since nearly every test file imports something from src. These are excluded
// from the loose scan the same way the two precise patterns are: by span, not by guessing intent.
const IMPORT_LIKE_REFERENCE = /(?:\bfrom\s+|\brequire\(\s*|\bimport\(\s*)(["'`])((?:\.\.?\/)*src\/[^"'`]*)\1/gu;

/** Every relative-path literal a test file resolves against its own directory. */
export function extractSourceReferences(testFileText) {
	const refs = [];
	for (const pattern of PRECISE_PATTERNS) {
		pattern.lastIndex = 0;
		let match = pattern.exec(testFileText);
		while (match) {
			refs.push(match[2]);
			match = pattern.exec(testFileText);
		}
	}
	return refs;
}

/**
 * True when the test file text contains a "src/..."-shaped string literal that none of the
 * precise patterns already accounted for — e.g. a literal path handed to a helper, stored in an
 * array and read through a variable, or resolved against a non-`import.meta.url` base. This scan
 * cannot know what such a literal actually resolves to, so per "widen when unsure" the owning test
 * is always included rather than silently ignored.
 */
export function hasUnresolvedSourceLiteral(testFileText) {
	const excludedSpans = [];
	for (const pattern of [...PRECISE_PATTERNS, IMPORT_LIKE_REFERENCE]) {
		pattern.lastIndex = 0;
		let match = pattern.exec(testFileText);
		while (match) {
			excludedSpans.push([match.index, match.index + match[0].length]);
			match = pattern.exec(testFileText);
		}
	}
	LOOSE_SRC_LITERAL.lastIndex = 0;
	let match = LOOSE_SRC_LITERAL.exec(testFileText);
	while (match) {
		const excluded = excludedSpans.some(([start, end]) => match.index >= start && match.index < end);
		if (!excluded) return true;
		match = LOOSE_SRC_LITERAL.exec(testFileText);
	}
	return false;
}

function isWholeProgramEntrypointBasename(basename) {
	return basename === "main.ts" || /cli\.ts$/u.test(basename);
}

function isUnderCodingAgentSrc(resolved) {
	return resolved === CODING_AGENT_SRC_ROOT || resolved.startsWith(`${CODING_AGENT_SRC_ROOT}/`);
}

/**
 * Resolves one extracted literal against the test file's own directory and classifies it:
 * - `{kind: "whole"}` — a whole-program entrypoint file; depends on all of packages/coding-agent/src.
 * - `{kind: "dir", path}` — an existing directory under src; depends on everything under it.
 * - `{kind: "file", path}` — an existing single file under src.
 * - `{kind: "unresolvable", path}` — resolves under src but is neither an existing file nor
 *   directory (e.g. a stale reference, or a literal this scan mis-extracted); always included.
 * - `null` — does not resolve under packages/coding-agent/src at all; not relevant to this scan.
 */
export function classifySourceReference(testFilePath, relativeRef, { existsAsFile, existsAsDir }) {
	const testDir = posix.dirname(testFilePath);
	const resolved = posix.normalize(posix.join(testDir, relativeRef));
	if (!isUnderCodingAgentSrc(resolved)) return null;
	const basename = resolved.slice(resolved.lastIndexOf("/") + 1);
	if (isWholeProgramEntrypointBasename(basename) && existsAsFile(resolved)) return { kind: "whole" };
	if (existsAsDir(resolved)) return { kind: "dir", path: resolved };
	if (existsAsFile(resolved)) return { kind: "file", path: resolved };
	return { kind: "unresolvable", path: resolved };
}

/**
 * @param {string[]} changedCodingAgentFiles - repo-relative changed files already known to be
 *   under packages/coding-agent (any extension; a scan-relevant reference is not limited to the
 *   TypeScript-only set codingAgentRelatedFiles trusts for import-graph narrowing).
 * @param {string[]} testFiles - repo-relative packages/coding-agent/test/**\/*.test.ts paths to scan.
 * @param {(path: string) => string} readText
 * @param {{existsAsFile: (p: string) => boolean, existsAsDir: (p: string) => boolean}} fsProbe
 * @returns {string[]} workspace-relative (relative to packages/coding-agent/) test file paths to
 *   add to the narrowed `vitest related` file list.
 */
export function computeSourceScanIncludes(changedCodingAgentFiles, testFiles, readText, fsProbe) {
	const changed = new Set(changedCodingAgentFiles);
	const includes = new Set();
	for (const testFile of testFiles) {
		const text = readText(testFile);
		const relativeTest = testFile.slice(CODING_AGENT_WORKSPACE_PREFIX.length);
		if (hasUnresolvedSourceLiteral(text)) {
			includes.add(relativeTest);
			continue;
		}
		for (const ref of extractSourceReferences(text)) {
			const classified = classifySourceReference(testFile, ref, fsProbe);
			if (!classified) continue;
			const matches =
				classified.kind === "whole" ||
				classified.kind === "unresolvable" ||
				(classified.kind === "file" && changed.has(classified.path)) ||
				(classified.kind === "dir" && [...changed].some((f) => f === classified.path || f.startsWith(`${classified.path}/`)));
			if (matches) {
				includes.add(relativeTest);
				break;
			}
		}
	}
	return Array.from(includes);
}

function listTestFilesReal(root) {
	const files = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = posix.join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (IS_TEST_FILE.test(entry.name)) files.push(path);
		}
	};
	walk(posix.join(root, CODING_AGENT_TEST_ROOT));
	return files;
}

/** Real-filesystem-backed entrypoint used by ci-affected.mjs's CLI. `root` is the repo root. */
export function findCodingAgentScanIncludes(changedCodingAgentFiles, root = ".") {
	const testFiles = listTestFilesReal(root).map((path) => posix.relative(root, path));
	const readText = (path) => readFileSync(posix.join(root, path), "utf8");
	const fsProbe = {
		existsAsFile: (path) => {
			const full = posix.join(root, path);
			return existsSync(full) && statSync(full).isFile();
		},
		existsAsDir: (path) => {
			const full = posix.join(root, path);
			return existsSync(full) && statSync(full).isDirectory();
		},
	};
	return computeSourceScanIncludes(changedCodingAgentFiles, testFiles, readText, fsProbe);
}
