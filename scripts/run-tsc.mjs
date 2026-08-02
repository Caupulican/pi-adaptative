#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const compilerEntrypoint = join(repoRoot, "node_modules", "typescript", "bin", "tsc");

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
