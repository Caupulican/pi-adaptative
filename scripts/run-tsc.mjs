#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);

/**
 * Resolve the compiler the way Node resolves any dependency, from this script's own location. A
 * path built from the script's parent directory only exists in the primary checkout: a linked
 * worktree has the tracked `scripts/` but no `node_modules` of its own, so the hardcoded path
 * aborted there while `typescript` was resolvable one directory up. Resolution walks the same
 * chain npm installed into, so hoisting and worktrees both land on the single installed compiler.
 * `typescript/bin/tsc` is not in the package's export map; the manifest is, and the bin sits beside it.
 */
const requireFromScript = createRequire(import.meta.url);
let compilerEntrypoint;
try {
	compilerEntrypoint = join(dirname(requireFromScript.resolve("typescript/package.json")), "bin", "tsc");
} catch (error) {
	console.error(`TypeScript 7 compiler could not be resolved (${error.message}). Run npm install --ignore-scripts.`);
	process.exit(1);
}

function run(bin, commandArgs) {
	return spawnSync(bin, commandArgs, {
		cwd: process.cwd(),
		env: process.env,
		encoding: "utf8",
		stdio: "inherit",
	});
}

if (!existsSync(compilerEntrypoint)) {
	console.error(`TypeScript 7 compiler not found at ${compilerEntrypoint}. Run npm install --ignore-scripts.`);
	process.exit(1);
}

const result = run(process.execPath, [compilerEntrypoint, ...args]);
if (result.error) {
	console.error(result.error.message);
	process.exit(1);
}
if (result.signal) {
	console.error(`TypeScript compiler terminated by signal ${result.signal}`);
	process.exit(1);
}
process.exit(result.status ?? 1);
