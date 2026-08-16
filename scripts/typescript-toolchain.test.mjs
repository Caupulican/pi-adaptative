import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const rootPackage = JSON.parse(readFileSync("package.json", "utf8"));

test("pins the stable TypeScript 7 compiler without the preview package", () => {
	assert.equal(rootPackage.devDependencies.typescript, "7.0.2");
	assert.equal(rootPackage.devDependencies["@typescript/native-preview"], undefined);
	assert.equal(rootPackage.devDependencies["@typescript/typescript6"], undefined);

	for (const relativePath of ["packages/agent/package.json", "packages/coding-agent/package.json"]) {
		const packageJson = JSON.parse(readFileSync(relativePath, "utf8"));
		assert.equal(packageJson.devDependencies.typescript, "7.0.2", relativePath);
	}
});

test("ports import analysis to the TypeScript 7 API", () => {
	const source = readFileSync(join("scripts", "check-ts-relative-imports.mjs"), "utf8");
	assert.match(source, /from "typescript\/unstable\/sync"/);
	assert.match(source, /from "typescript\/unstable\/ast"/);
	assert.doesNotMatch(source, /from "typescript"/);
	assert.doesNotMatch(source, /@typescript\/typescript6|@typescript\/native-preview/);
});

test("has one compiler execution path with no legacy fallback", () => {
	const source = readFileSync(join("scripts", "run-tsc.mjs"), "utf8");
	assert.match(source, /const compilerEntrypoint = join\(repoRoot, "node_modules", "typescript", "bin", "tsc"\)/);
	assert.match(source, /run\(process\.execPath, \[compilerEntrypoint, \.\.\.args\]\)/);
	assert.doesNotMatch(source, /\.cmd|shell:|run\("tsgo"|falling back|native-preview/);
	assert.throws(() => readFileSync(join("scripts", "tsgo-or-tsc.mjs"), "utf8"), { code: "ENOENT" });
});

test("keeps CI and release toolchain assertions on the pinned Vite version", () => {
	const pinnedVite = rootPackage.devDependencies.vite;
	assert.deepEqual(
		[..."npm ls vite@8.2.1 vitest@4.1.10 --depth=0".matchAll(/npm ls vite@([^\s]+)/g)].map((match) => match[1]),
		["8.2.1"],
	);
	for (const relativePath of [".github/workflows/ci.yml", ".github/workflows/build-binaries.yml"]) {
		const source = readFileSync(relativePath, "utf8");
		const assertedVersions = [...source.matchAll(/npm ls vite@([^\s]+)/g)].map((match) => match[1]);
		assert.ok(assertedVersions.length > 0, `${relativePath} must assert the native Vite toolchain`);
		assert.deepEqual([...new Set(assertedVersions)], [pinnedVite], relativePath);
	}
});
