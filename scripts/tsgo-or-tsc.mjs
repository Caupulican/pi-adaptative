#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const useShell = process.platform === "win32";

function commandLine(bin, commandArgs) {
	return [bin, ...commandArgs].map((part) => (part.includes(" ") ? JSON.stringify(part) : part)).join(" ");
}

function resolveBin(bin) {
	const exe = process.platform === "win32" ? `${bin}.cmd` : bin;
	const localBin = path.join(repoRoot, "node_modules", ".bin", exe);
	return fs.existsSync(localBin) ? localBin : bin;
}

function run(bin, commandArgs) {
	return spawnSync(resolveBin(bin), commandArgs, {
		cwd: process.cwd(),
		env: process.env,
		encoding: "utf8",
		stdio: "pipe",
		shell: useShell,
	});
}

function writeOutput(result) {
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
}

function exitFrom(result) {
	if (result.error) {
		console.error(result.error.message);
		process.exit(1);
	}
	if (result.signal) {
		console.error(`${commandLine("tsc", args)} terminated by signal ${result.signal}`);
		process.exit(1);
	}
	process.exit(result.status ?? 1);
}

function isTsgoPlatformFailure(result) {
	if (result.error && result.error.code === "ENOENT") return true;
	const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
	return /Unable to resolve @typescript\/native-preview-[\w-]+/.test(output) || /platform is unsupported/.test(output);
}

const tsgo = run("tsgo", args);
if (!tsgo.error && tsgo.status === 0) {
	writeOutput(tsgo);
	process.exit(0);
}

if (!isTsgoPlatformFailure(tsgo)) {
	writeOutput(tsgo);
	exitFrom(tsgo);
}

const reason = tsgo.error?.code === "ENOENT" ? "tsgo binary not found" : "tsgo native preview binary unavailable for this platform";
console.warn(`[tsgo-or-tsc] ${reason}; falling back to ${commandLine("tsc", args)}.`);

const tsc = run("tsc", args);
writeOutput(tsc);
exitFrom(tsc);
