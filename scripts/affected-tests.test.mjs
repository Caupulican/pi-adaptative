import assert from "node:assert/strict";
import { test } from "node:test";
import { createPackageResolver, directImporterTests, relativeImportSpecifiers, selectCommitTests } from "./affected-tests.mjs";

const sources = {
	"packages/x/test/a.test.ts": 'import { a } from "../src/core/a.ts";\nvi.mock("../src/core/b.js");',
	"packages/x/test/nested/c.test.ts": 'const m = await import("../../src/core/c");',
	"packages/x/test/unrelated.test.ts": 'import { z } from "@scope/pkg";\nimport { y } from "./helpers.ts";',
};
const read = (path) => sources[path];
const tests = Object.keys(sources);

test("relative imports, dynamic imports and vi.mock specifiers are all edges", () => {
	assert.deepEqual(relativeImportSpecifiers(sources["packages/x/test/a.test.ts"]), ["../src/core/a.ts", "../src/core/b.js"]);
});

test("a test is selected when it directly imports a changed source, with .js and extensionless specifiers", () => {
	assert.deepEqual(directImporterTests(["packages/x/src/core/a.ts"], tests, read), ["packages/x/test/a.test.ts"]);
	assert.deepEqual(directImporterTests(["packages/x/src/core/b.ts"], tests, read), ["packages/x/test/a.test.ts"]);
	assert.deepEqual(directImporterTests(["packages/x/src/core/c.ts"], tests, read), ["packages/x/test/nested/c.test.ts"]);
	assert.deepEqual(directImporterTests(["packages/x/src/core/none.ts"], tests, read), []);
});

test("a hub module narrows to the tests named after it", () => {
	const hubTests = Array.from({ length: 4 }, (_, index) => `packages/x/test/t${index}.test.ts`).concat(
		"packages/x/test/hub-module.test.ts",
	);
	const hubRead = () => 'import { h } from "../src/hub-module.ts";';
	assert.deepEqual(selectCommitTests(["packages/x/src/hub-module.ts"], hubTests, hubRead, 3), [
		"packages/x/test/hub-module.test.ts",
	]);
	assert.equal(selectCommitTests(["packages/x/src/hub-module.ts"], hubTests, hubRead, 10).length, 5);
});

test("a package specifier reaches the module behind its entry point, through re-exporting barrels", () => {
	const files = {
		"packages/core/src/node.ts": 'export * from "./session/index.ts";\nexport { tool } from "./tool.ts";',
		"packages/core/src/session/index.ts": 'export * from "./manager.ts";',
		"packages/core/src/session/manager.ts": "export const manager = 1;",
		"packages/core/src/tool.ts": "export const tool = 1;",
		"packages/core/src/other.ts": "export const other = 1;",
		"packages/app/test/uses-node.test.ts": 'import { manager } from "@scope/core/node";',
		"packages/app/test/uses-root.test.ts": 'import { other } from "@scope/core";',
	};
	const readText = (path) => files[path];
	const resolvePackage = createPackageResolver([
		{
			name: "@scope/core",
			directory: "packages/core",
			exports: { ".": { "pi-source": "./src/other.ts" }, "./node": { "pi-source": "./src/node.ts" } },
		},
	]);
	const tests = ["packages/app/test/uses-node.test.ts", "packages/app/test/uses-root.test.ts"];
	assert.deepEqual(directImporterTests(["packages/core/src/session/manager.ts"], tests, readText, resolvePackage), [
		"packages/app/test/uses-node.test.ts",
	]);
	assert.deepEqual(directImporterTests(["packages/core/src/tool.ts"], tests, readText, resolvePackage), [
		"packages/app/test/uses-node.test.ts",
	]);
	assert.deepEqual(directImporterTests(["packages/core/src/other.ts"], tests, readText, resolvePackage), [
		"packages/app/test/uses-root.test.ts",
	]);
	// An unknown package or an export the map does not name selects nothing.
	assert.equal(createPackageResolver([])("@scope/core/node"), undefined);
});
