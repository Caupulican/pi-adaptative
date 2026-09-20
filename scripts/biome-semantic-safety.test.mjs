/**
 * Formatting must never change semantics.
 *
 * `noExtraBooleanCast` strips the `Boolean()` wrapper from `A && Boolean(X ?? Y)` and, because
 * `&&` and `??` cannot legally mix unparenthesized, re-parenthesizes around the conjunction:
 * `(A && X) ?? Y`. That is a different predicate, it shipped once from a supposedly
 * formatting-only write, and every unit test stayed green.
 *
 * Two independent defenses are asserted here:
 *   1. `npm run format` invokes the formatter only, so no lint fix can run from it at all;
 *   2. the repository's own lint configuration disables `noExtraBooleanCast`, so even the paths
 *      that do apply fixes (the pre-commit hook writes with `biome check --write`) cannot
 *      perform this rewrite.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const biomeBin = join(repoRoot, "node_modules/@biomejs/biome/bin/biome");
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const biomeConfig = JSON.parse(readFileSync(join(repoRoot, "biome.json"), "utf8"));

/** The exact source shape that was silently rewritten into a different predicate. */
const SEMANTIC_PROBE = `export function authorize(
	authority: { allowShellExecution: boolean },
	request: { scriptContent?: string; command?: string },
): boolean {
	if (!authority.allowShellExecution && Boolean(request.scriptContent ?? request.command)) {
		return false;
	}
	return true;
}
`;

/** The rewritten predicate this test exists to keep out of the tree. */
const MANGLED = "(!authority.allowShellExecution && request.scriptContent) ?? request.command";

/** The rewrite may be re-wrapped across lines, so shapes are compared whitespace-insensitively. */
function flatten(source) {
	return source.replace(/\s+/g, " ");
}

const workspaces = [];

after(() => {
	for (const dir of workspaces) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * Writes the probe into a throwaway workspace carrying the repository's real linter configuration.
 * `files.includes` is dropped so the probe is actually processed; every rule setting is the
 * repository's own, which is what the assertions are about.
 */
function probeWorkspace() {
	const dir = mkdtempSync(join(tmpdir(), "biome-semantic-safety-"));
	workspaces.push(dir);
	const { files: _ignored, ...config } = biomeConfig;
	writeFileSync(join(dir, "biome.json"), JSON.stringify(config, null, "\t"));
	const probePath = join(dir, "probe.ts");
	writeFileSync(probePath, SEMANTIC_PROBE);
	return probePath;
}

function runBiome(args, cwd) {
	return execFileSync(process.execPath, [biomeBin, ...args], { cwd, encoding: "utf8", stdio: "pipe" });
}

test("npm run format is formatter-only", () => {
	assert.equal(
		packageJson.scripts.format,
		"biome format --write .",
		"`format` must invoke the formatter, never `biome check --write`, which applies lint fixes",
	);
	assert.match(
		packageJson.scripts.check,
		/biome check --error-on-warnings \./,
		"lint validation stays a separate, non-writing gate",
	);
});

test("the repository configuration disables the noExtraBooleanCast autofix", () => {
	assert.equal(
		biomeConfig.linter.rules.complexity?.noExtraBooleanCast,
		"off",
		"noExtraBooleanCast rewrites Boolean(a ?? b) inside a conjunction into a different predicate",
	);
});

test("formatter-only writes leave Boolean(a ?? b) semantics intact", () => {
	const probePath = probeWorkspace();
	runBiome(["format", "--write", probePath], dirname(probePath));
	const formatted = readFileSync(probePath, "utf8");
	assert.ok(
		flatten(formatted).includes("Boolean(request.scriptContent ?? request.command)"),
		`formatter rewrote the predicate:\n${formatted}`,
	);
	assert.ok(!flatten(formatted).includes(MANGLED), `formatter produced the mangled predicate:\n${formatted}`);
});

test("lint-fixing writes under the repository configuration leave the predicate intact", () => {
	const probePath = probeWorkspace();
	runBiome(["check", "--write", probePath], dirname(probePath));
	const written = readFileSync(probePath, "utf8");
	assert.ok(
		flatten(written).includes("Boolean(request.scriptContent ?? request.command)"),
		`biome check --write rewrote the predicate:\n${written}`,
	);
	assert.ok(!flatten(written).includes(MANGLED), `biome check --write produced the mangled predicate:\n${written}`);
});

test("the probe is a real reproducer: the rewrite happens with the rule enabled", () => {
	const dir = mkdtempSync(join(tmpdir(), "biome-semantic-safety-control-"));
	workspaces.push(dir);
	writeFileSync(
		join(dir, "biome.json"),
		JSON.stringify({ linter: { enabled: true, rules: { preset: "recommended" } } }, null, "\t"),
	);
	const probePath = join(dir, "probe.ts");
	writeFileSync(probePath, SEMANTIC_PROBE);
	runBiome(["check", "--write", probePath], dir);
	assert.ok(
		flatten(readFileSync(probePath, "utf8")).includes(MANGLED),
		"the control case no longer reproduces the rewrite; re-derive the probe before trusting the guards above",
	);
});

test("the mangled shape is absent from the tree", () => {
	// `git grep` exits 1 when nothing matches, which is the clean outcome here.
	const search = spawnSync(
		"git",
		["grep", "-nE", String.raw`&& [A-Za-z_.?]+\) \?\?`, "--", "packages/*/src", "packages/*/test"],
		{ cwd: repoRoot, encoding: "utf8" },
	);
	assert.ok(search.status === 0 || search.status === 1, `git grep failed: ${search.stderr}`);
	assert.equal(search.stdout.trim(), "", `found the mangled Boolean/nullish shape:\n${search.stdout}`);
});
