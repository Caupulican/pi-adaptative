#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);

/**
 * Resolve each compiler the way Node resolves any dependency, from this script's own location. A
 * path built from the script's parent directory only exists in the primary checkout: a linked
 * worktree has the tracked `scripts/` but no `node_modules` of its own, so the hardcoded path
 * aborted there while the compiler was resolvable one directory up. Resolution walks the same
 * chain npm installed into, so hoisting and worktrees both land on the single installed compiler.
 * `bin/*` entries are not in the packages' export maps; the manifest is, and the bin sits beside it.
 */
const requireFromScript = createRequire(import.meta.url);

function packageDirectory(specifier, from = requireFromScript) {
	try {
		return dirname(from.resolve(`${specifier}/package.json`));
	} catch {
		return undefined;
	}
}

/**
 * tsrs (the Rust port of the TypeScript 7 compiler) ships its native binary in one per-platform
 * optional dependency, and npm installs only the one matching the host. A host that has none of
 * them (tsrs publishes no Windows or darwin-x64 binary) cannot run tsrs; the pinned `typescript`
 * compiler is the same TypeScript 7 front end and produces the same declarations and emit there.
 */
function resolveTsrsEntrypoint() {
	const tsrsDirectory = packageDirectory("tsrs");
	if (!tsrsDirectory) return undefined;
	const manifest = JSON.parse(readFileSync(join(tsrsDirectory, "package.json"), "utf8"));
	const requireFromTsrs = createRequire(join(tsrsDirectory, "package.json"));
	const hasPlatformBinary = Object.keys(manifest.optionalDependencies ?? {}).some(
		(name) => packageDirectory(name, requireFromTsrs) !== undefined,
	);
	return hasPlatformBinary ? join(tsrsDirectory, "bin", "tsrs") : undefined;
}

let compilerName = "tsrs";
let compilerEntrypoint = resolveTsrsEntrypoint();
if (!compilerEntrypoint) {
	compilerName = "typescript";
	const typescriptDirectory = packageDirectory("typescript");
	if (!typescriptDirectory) {
		console.error("No TypeScript compiler could be resolved (tsrs has no binary for this host and typescript is missing). Run npm install --ignore-scripts.");
		process.exit(1);
	}
	compilerEntrypoint = join(typescriptDirectory, "bin", "tsc");
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
	console.error(`${compilerName} compiler not found at ${compilerEntrypoint}. Run npm install --ignore-scripts.`);
	process.exit(1);
}

const result = run(process.execPath, [compilerEntrypoint, ...args]);
if (result.error) {
	console.error(result.error.message);
	process.exit(1);
}
if (result.signal) {
	console.error(`${compilerName} compiler terminated by signal ${result.signal}`);
	process.exit(1);
}
process.exit(result.status ?? 1);
