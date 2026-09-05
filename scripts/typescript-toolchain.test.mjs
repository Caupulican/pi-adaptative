import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const rootPackage = JSON.parse(readFileSync("package.json", "utf8"));

test("source CLI uses the same native TypeScript export condition as its test harness", () => {
	const launcher = readFileSync("pi-test.sh", "utf8");
	assert.match(launcher, /node --conditions=pi-source/);
	assert.doesNotMatch(launcher, /node_modules\/\.bin\/tsx|--tsconfig/);
});

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
	assert.match(source, /createRequire\(import\.meta\.url\)/);
	assert.match(
		source,
		/compilerEntrypoint = join\(dirname\(requireFromScript\.resolve\("typescript\/package\.json"\)\), "bin", "tsc"\)/,
	);
	assert.match(source, /run\(process\.execPath, \[compilerEntrypoint, \.\.\.args\]\)/);
	assert.doesNotMatch(source, /\.cmd|shell:|run\("tsgo"|falling back|native-preview/);
	assert.throws(() => readFileSync(join("scripts", "tsgo-or-tsc.mjs"), "utf8"), { code: "ENOENT" });
});

test("keeps CI and release toolchain assertions on the pinned Vite and Vitest versions", () => {
	for (const relativePath of [".github/workflows/ci.yml", ".github/workflows/build-binaries.yml"]) {
		const source = readFileSync(relativePath, "utf8");
		const assertions = [...source.matchAll(/npm ls vite@([^\s]+) vitest@([^\s]+) --depth=0/g)];
		assert.ok(assertions.length > 0, `${relativePath} must assert the native TypeScript test toolchain`);
		for (const [, vite, vitest] of assertions) {
			assert.equal(vite, rootPackage.devDependencies.vite, relativePath);
			assert.equal(vitest, rootPackage.devDependencies.vitest, relativePath);
		}
	}
});
