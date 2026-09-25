import assert from "node:assert/strict";
import { test } from "node:test";
import { directImporterTests, relativeImportSpecifiers, selectCommitTests } from "./affected-tests.mjs";

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
