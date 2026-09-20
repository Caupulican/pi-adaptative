#!/usr/bin/env node
/**
 * Runs the canonical test-harness isolation suites.
 *
 * The suite list lives in `test-harness-contract.mjs` and is validated before the run, so a bad
 * entry reports itself instead of surfacing as a missing-module error from `node --test`.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertTestHarnessContract, TEST_HARNESS_ISOLATION_TESTS } from "./test-harness-contract.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let tests;
try {
	tests = assertTestHarnessContract();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}

const absent = tests.filter((entry) => !existsSync(join(repositoryRoot, entry)));
if (absent.length > 0) {
	console.error(
		`Test-harness isolation contract names suite(s) that do not exist:\n  - ${absent.join("\n  - ")}\n` +
			"Update scripts/test-harness-contract.mjs when a suite is renamed or removed.",
	);
	process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...tests], {
	cwd: repositoryRoot,
	stdio: "inherit",
});

if (result.error) {
	console.error(result.error.message);
	process.exit(1);
}
process.exit(result.status ?? 1);
