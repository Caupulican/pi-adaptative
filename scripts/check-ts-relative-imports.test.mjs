import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";

const checker = resolve("scripts/check-ts-relative-imports.mjs");
const temporaryDirectories = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

function createProject(files) {
	const directory = mkdtempSync(join(tmpdir(), "pi-ts-imports-"));
	temporaryDirectories.push(directory);
	writeFileSync(join(directory, "tsconfig.json"), JSON.stringify({ include: ["included.ts"] }));
	for (const [file, content] of Object.entries(files)) writeFileSync(join(directory, file), content);
	return directory;
}

function runChecker(directory) {
	return spawnSync(process.execPath, [checker], {
		cwd: directory,
		encoding: "utf8",
	});
}

test("reports every relative JavaScript module specifier parsed by TypeScript 7", () => {
	const directory = createProject({
		"included.ts": [
			'import value from "./static.js";',
			'export { value } from "../exported.js?raw";',
			'void import("./dynamic.js#fragment");',
			'type Imported = import("./typed.js").Imported;',
		].join("\n"),
	});

	const result = runChecker(directory);
	assert.equal(result.status, 1, result.stderr);
	for (const specifier of ["./static.js", "../exported.js?raw", "./dynamic.js#fragment", "./typed.js"]) {
		assert.match(result.stderr, new RegExp(specifier.replace(/[.?]/g, "\\$&")));
	}
});

test("uses the configured project boundary and rejects no negative controls", () => {
	const directory = createProject({
		"included.ts": [
			'import value from "package.js";',
			'import local from "./local.ts";',
			'const ordinaryString = "./not-an-import.js";',
			'// import("./comment.js")',
		].join("\n"),
		"outside.ts": 'import hidden from "./outside.js";',
	});

	const result = runChecker(directory);
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
