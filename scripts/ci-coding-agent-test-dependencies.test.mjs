import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import test from "node:test";
import {
	classifySourceReference,
	computeSourceScanIncludes,
	extractSourceReferences,
	findCodingAgentScanIncludes,
	hasUnresolvedSourceLiteral,
} from "./ci-coding-agent-test-dependencies.mjs";

// A fsProbe backed by an in-memory set of paths, for pure unit tests that never touch the real
// filesystem.
function fakeFs({ files = [], dirs = [] } = {}) {
	const fileSet = new Set(files);
	const dirSet = new Set(dirs);
	return {
		existsAsFile: (path) => fileSet.has(path),
		existsAsDir: (path) => dirSet.has(path),
	};
}

test("extractSourceReferences finds new URL(...) and resolve/join(import.meta.dirname, ...) literals", () => {
	const text = `
		const a = readFileSync(new URL("../src/core/foo.ts", import.meta.url), "utf8");
		const b = resolve(import.meta.dirname, "../src/cli.ts");
		const c = path.join(import.meta.dirname, "../src/bar.ts");
		const d = new URL('../src/quoted.ts', import.meta.url);
		const e = "not a reference";
	`;
	assert.deepEqual(extractSourceReferences(text).sort(), ["../src/bar.ts", "../src/cli.ts", "../src/core/foo.ts", "../src/quoted.ts"].sort());
});

test("extractSourceReferences ignores unrelated calls and non-relative literals", () => {
	assert.deepEqual(extractSourceReferences('join(pkgDir, "main.ts")'), []);
	assert.deepEqual(extractSourceReferences('new URL("https://example.com", base)'), []);
	assert.deepEqual(extractSourceReferences("no references here at all"), []);
});

test("classifySourceReference ignores references outside packages/coding-agent/src", () => {
	const fs = fakeFs({ files: ["packages/coding-agent/test/fixtures/x.json"] });
	assert.equal(classifySourceReference("packages/coding-agent/test/a.test.ts", "./fixtures/x.json", fs), null);
	assert.equal(classifySourceReference("packages/coding-agent/test/a.test.ts", "../../../tsconfig.json", fs), null);
});

test("classifySourceReference resolves a whole-program entrypoint basename to kind 'whole'", () => {
	const fs = fakeFs({ files: ["packages/coding-agent/src/cli.ts", "packages/coding-agent/src/bun/cli.ts", "packages/coding-agent/src/main.ts"] });
	assert.deepEqual(classifySourceReference("packages/coding-agent/test/a.test.ts", "../src/cli.ts", fs), { kind: "whole" });
	assert.deepEqual(classifySourceReference("packages/coding-agent/test/a.test.ts", "../src/bun/cli.ts", fs), { kind: "whole" });
	assert.deepEqual(classifySourceReference("packages/coding-agent/test/a.test.ts", "../src/main.ts", fs), { kind: "whole" });
});

test("classifySourceReference resolves an existing directory to kind 'dir'", () => {
	const fs = fakeFs({ dirs: ["packages/coding-agent/src", "packages/coding-agent/src/core"] });
	assert.deepEqual(classifySourceReference("packages/coding-agent/test/a.test.ts", "../src", fs), {
		kind: "dir",
		path: "packages/coding-agent/src",
	});
	assert.deepEqual(classifySourceReference("packages/coding-agent/test/nested/b.test.ts", "../../src/core", fs), {
		kind: "dir",
		path: "packages/coding-agent/src/core",
	});
});

test("classifySourceReference resolves an existing single file to kind 'file'", () => {
	const fs = fakeFs({ files: ["packages/coding-agent/src/core/extensions/loader.ts"] });
	assert.deepEqual(classifySourceReference("packages/coding-agent/test/a.test.ts", "../src/core/extensions/loader.ts", fs), {
		kind: "file",
		path: "packages/coding-agent/src/core/extensions/loader.ts",
	});
});

test("classifySourceReference falls back to 'unresolvable' when nothing on disk matches", () => {
	const fs = fakeFs({});
	assert.deepEqual(classifySourceReference("packages/coding-agent/test/a.test.ts", "../src/gone.ts", fs), {
		kind: "unresolvable",
		path: "packages/coding-agent/src/gone.ts",
	});
});

test("computeSourceScanIncludes adds a text-reading test when its exact referenced file changed", () => {
	const testFiles = ["packages/coding-agent/test/reads-loader.test.ts"];
	const readText = () => 'const x = readFileSync(new URL("../src/core/extensions/loader.ts", import.meta.url), "utf8");';
	const fs = fakeFs({ files: ["packages/coding-agent/src/core/extensions/loader.ts"] });
	assert.deepEqual(
		computeSourceScanIncludes(["packages/coding-agent/src/core/extensions/loader.ts"], testFiles, readText, fs),
		["test/reads-loader.test.ts"],
	);
	// A different, unrelated changed file must not pull this test in.
	assert.deepEqual(computeSourceScanIncludes(["packages/coding-agent/src/other.ts"], testFiles, readText, fs), []);
});

test("computeSourceScanIncludes adds a directory-scanning test for any change under the scanned directory", () => {
	const testFiles = ["packages/coding-agent/test/scans-src.test.ts"];
	const readText = () => 'const root = new URL("../src", import.meta.url);';
	const fs = fakeFs({ dirs: ["packages/coding-agent/src"] });
	assert.deepEqual(
		computeSourceScanIncludes(["packages/coding-agent/src/anything/deep.ts"], testFiles, readText, fs),
		["test/scans-src.test.ts"],
	);
	assert.deepEqual(computeSourceScanIncludes(["packages/coding-agent/test/unrelated.test.ts"], testFiles, readText, fs), []);
});

test("computeSourceScanIncludes always adds a whole-program-spawning test when any src file changed", () => {
	const testFiles = ["packages/coding-agent/test/spawns-cli.test.ts"];
	const readText = () => 'const cliPath = resolve(import.meta.dirname, "../src/cli.ts"); spawn(process.execPath, [cliPath]);';
	const fs = fakeFs({ files: ["packages/coding-agent/src/cli.ts"] });
	// Any src change at all triggers it, not only a change to cli.ts itself.
	assert.deepEqual(computeSourceScanIncludes(["packages/coding-agent/src/unrelated/deep.ts"], testFiles, readText, fs), [
		"test/spawns-cli.test.ts",
	]);
});

test("computeSourceScanIncludes always adds a test with an unresolvable reference (widen, never guess)", () => {
	const testFiles = ["packages/coding-agent/test/computed-path.test.ts"];
	const readText = () => 'readFileSync(new URL("../src/deleted-or-computed.ts", import.meta.url));';
	const fs = fakeFs({});
	assert.deepEqual(computeSourceScanIncludes(["packages/coding-agent/src/anything.ts"], testFiles, readText, fs), [
		"test/computed-path.test.ts",
	]);
});

test("computeSourceScanIncludes leaves a test with no source references alone", () => {
	const testFiles = ["packages/coding-agent/test/plain.test.ts"];
	const readText = () => 'import { thing } from "../src/thing.ts";';
	const fs = fakeFs({ files: ["packages/coding-agent/src/thing.ts"] });
	// A plain import is already covered by vitest related's own import-graph walk; this scan only
	// looks for new URL(...)/resolve(import.meta.dirname, ...) references, so a plain import
	// statement produces no reference here at all.
	assert.deepEqual(computeSourceScanIncludes(["packages/coding-agent/src/thing.ts"], testFiles, readText, fs), []);
});

test("hasUnresolvedSourceLiteral ignores plain import/require/dynamic-import statements", () => {
	assert.equal(hasUnresolvedSourceLiteral('import { thing } from "../src/thing.ts";'), false);
	assert.equal(hasUnresolvedSourceLiteral('const x = require("../src/thing.ts");'), false);
	assert.equal(hasUnresolvedSourceLiteral('const x = await import("../src/thing.ts");'), false);
});

test("hasUnresolvedSourceLiteral ignores literals already covered by the two precise patterns", () => {
	assert.equal(hasUnresolvedSourceLiteral('readFileSync(new URL("../src/thing.ts", import.meta.url));'), false);
	assert.equal(hasUnresolvedSourceLiteral('resolve(import.meta.dirname, "../src/thing.ts");'), false);
});

test("hasUnresolvedSourceLiteral flags a src-shaped literal it cannot precisely resolve", () => {
	// The real shape from test/no-upstream-runtime.test.ts: literals stored in an array and read
	// through a variable, or a new URL(...) base that is not import.meta.url.
	assert.equal(hasUnresolvedSourceLiteral('const files = ["src/cli/args.ts", "src/config.ts"];'), true);
	assert.equal(hasUnresolvedSourceLiteral('const packageRoot = new URL("..", import.meta.url);\nreadFileSync(new URL("src/config.ts", packageRoot));'), true);
});

test("computeSourceScanIncludes always includes a test with an unresolved loose literal", () => {
	const testFiles = ["packages/coding-agent/test/computed-array.test.ts"];
	const readText = () => 'const files = ["src/config.ts"];';
	assert.deepEqual(computeSourceScanIncludes(["packages/coding-agent/src/unrelated.ts"], testFiles, readText, fakeFs({})), [
		"test/computed-array.test.ts",
	]);
});

// Real repository files, per the review request: prove the scanner recognizes the actual patterns
// used in this codebase, not just synthetic examples. Each test returns early (skips, does not
// fail) if the named file has moved or been renamed since — that is a fixture-maintenance issue,
// not evidence the scanner itself regressed.
const REPO_ROOT = new URL("..", import.meta.url).pathname;
function readRepoFile(relative) {
	return readFileSync(REPO_ROOT + relative, "utf8");
}
const realFsProbe = {
	existsAsFile: (path) => existsSync(REPO_ROOT + path) && statSync(REPO_ROOT + path).isFile(),
	existsAsDir: (path) => existsSync(REPO_ROOT + path) && statSync(REPO_ROOT + path).isDirectory(),
};

test("real example: extension-loader-boundary.test.ts reads packages/coding-agent/src/core/extensions/loader.ts as text", () => {
	const path = "packages/coding-agent/test/extension-loader-boundary.test.ts";
	if (!existsSync(REPO_ROOT + path)) return; // file moved/renamed; not this scanner's concern
	const refs = extractSourceReferences(readRepoFile(path));
	assert.ok(refs.includes("../src/core/extensions/loader.ts"), refs.join(", "));
	const classified = classifySourceReference(path, "../src/core/extensions/loader.ts", realFsProbe);
	assert.deepEqual(classified, { kind: "file", path: "packages/coding-agent/src/core/extensions/loader.ts" });
	assert.deepEqual(
		computeSourceScanIncludes(["packages/coding-agent/src/core/extensions/loader.ts"], [path], readRepoFile, realFsProbe),
		["test/extension-loader-boundary.test.ts"],
	);
});

test("real example: stdout-cleanliness.test.ts spawns src/cli.ts, so it depends on all of src", () => {
	const path = "packages/coding-agent/test/stdout-cleanliness.test.ts";
	if (!existsSync(REPO_ROOT + path)) return;
	const refs = extractSourceReferences(readRepoFile(path));
	assert.ok(refs.includes("../src/cli.ts"), refs.join(", "));
	const classified = classifySourceReference(path, "../src/cli.ts", realFsProbe);
	assert.deepEqual(classified, { kind: "whole" });
	assert.deepEqual(
		computeSourceScanIncludes(["packages/coding-agent/src/some/totally/unrelated/file.ts"], [path], readRepoFile, realFsProbe),
		["test/stdout-cleanliness.test.ts"],
	);
});

test("real example: sqlite-compile-graph.test.ts scans the whole src directory for node:sqlite imports", () => {
	const path = "packages/coding-agent/test/sqlite-compile-graph.test.ts";
	if (!existsSync(REPO_ROOT + path)) return;
	const refs = extractSourceReferences(readRepoFile(path));
	assert.ok(refs.includes("../src"), refs.join(", "));
	const classified = classifySourceReference(path, "../src", realFsProbe);
	assert.deepEqual(classified, { kind: "dir", path: "packages/coding-agent/src" });
	assert.deepEqual(
		computeSourceScanIncludes(["packages/coding-agent/src/utils/deeply/nested/file.ts"], [path], readRepoFile, realFsProbe),
		["test/sqlite-compile-graph.test.ts"],
	);
});

test("real example: no-upstream-runtime.test.ts reads an array of src literals through a computed URL base", () => {
	const path = "packages/coding-agent/test/no-upstream-runtime.test.ts";
	if (!existsSync(REPO_ROOT + path)) return;
	// This is exactly the shape the precise patterns cannot resolve (a variable-held literal
	// against `new URL(relativePath, packageRoot)`, not `import.meta.url`/`import.meta.dirname`).
	assert.equal(hasUnresolvedSourceLiteral(readRepoFile(path)), true);
	assert.deepEqual(
		computeSourceScanIncludes(["packages/coding-agent/src/totally/unrelated.ts"], [path], readRepoFile, realFsProbe),
		["test/no-upstream-runtime.test.ts"],
	);
});

test("findCodingAgentScanIncludes (real filesystem) picks up the extension-loader-boundary real example", () => {
	const includes = findCodingAgentScanIncludes(["packages/coding-agent/src/core/extensions/loader.ts"]);
	assert.ok(includes.includes("test/extension-loader-boundary.test.ts"), includes.join(", "));
});
