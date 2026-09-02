#!/usr/bin/env node
/**
 * Contract tests may only change alongside the doctrine that they pin.
 *
 * `contracts.json` lists the test files that pin the invariants in `docs/doctrine.md`. When a
 * commit changes one of them without changing the doctrine file, this check fails: a superseded
 * rule is superseded in words first, so the record of why an invariant moved survives the test
 * that moved with it. Runs in the pre-commit `check` chain against the staged tree; with
 * `--range <base>..<head>` it checks a commit range instead (CI).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../contracts.json", import.meta.url), "utf8"));
const contracts = new Set(manifest.contracts);
const doctrine = manifest.doctrine;

const rangeIndex = process.argv.indexOf("--range");
const range = rangeIndex >= 0 ? process.argv[rangeIndex + 1] : undefined;
const args = range ? ["diff", "--name-only", range] : ["diff", "--cached", "--name-only"];
let changed;
try {
	changed = execFileSync("git", args, { encoding: "utf8" })
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
} catch (error) {
	console.error(`check-contract-doctrine: git diff failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(2);
}

const touchedContracts = changed.filter((file) => contracts.has(file));
const missingContracts = manifest.contracts.filter((file) => {
	try {
		readFileSync(new URL(`../${file}`, import.meta.url));
		return false;
	} catch {
		return true;
	}
});
if (missingContracts.length > 0) {
	console.error(`check-contract-doctrine: contracts.json lists files that do not exist:\n  ${missingContracts.join("\n  ")}`);
	process.exit(1);
}
if (touchedContracts.length > 0 && !changed.includes(doctrine)) {
	console.error(
		[
			"check-contract-doctrine: a contract test changed without a doctrine change.",
			`  changed contracts: ${touchedContracts.join(", ")}`,
			`  ${doctrine} must change in the same commit: state which invariant moved and why,`,
			"  or move the file out of contracts.json if it no longer pins an invariant.",
		].join("\n"),
	);
	process.exit(1);
}
console.log(
	touchedContracts.length > 0
		? `check-contract-doctrine: ${touchedContracts.length} contract file(s) changed with ${doctrine}.`
		: "check-contract-doctrine: no contract file changed.",
);
