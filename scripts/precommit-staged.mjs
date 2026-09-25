#!/usr/bin/env node
/**
 * Staged-scoped pre-commit gate.
 *
 * The hook used to run the repo-wide `npm run format` and the whole `npm run check` chain on every
 * commit (about two minutes, most of it on files the commit never touched). This gate looks only at
 * what is staged: the exclude/lockfile guards, biome on the staged files biome.json covers, the
 * contract-doctrine gate (already staged-aware), the browser smoke check when its inputs are staged,
 * the staged test files themselves, and one project type check when a TypeScript source is staged
 * (per-file type checking is unsound: an importer of the changed file can break). Everything else in
 * `npm run check` stays a CI and release gate.
 *
 * Two test sets join the staged test files. The tests that import a staged source file directly
 * (see affected-tests.mjs; hub modules narrow to their named tests) run in one batch per workspace:
 * the transitive set is most of the suite and stays CI's. And when the branch's last recorded CI
 * verdict is red (see ci-status.mjs), its failing test files are carried into every commit on top
 * of it: the commit is refused until they pass, so a red main is fixed before new work lands on it.
 *
 * `--dry-run` prints the plan for the current staged set without running anything.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findCommitTests } from "./affected-tests.mjs";
import { commitObligation, describeStatus, readCiStatus } from "./ci-status.mjs";
import { pinGithubOriginGhDefault } from "./github-origin.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "..");

export const BROWSER_SMOKE_INPUTS = /^(packages\/ai\/|packages\/web-ui\/|package\.json$|package-lock\.json$)/;
const TYPESCRIPT_SOURCE = /^packages\/[^/]+\/.*\.(?:ts|tsx|mts|cts)$/;
const NODE_TEST_WORKSPACES = new Set(["packages/tui"]);
const VITEST_WORKSPACES = new Set(["packages/ai", "packages/agent", "packages/coding-agent"]);

/** Translate one biome.json `files.includes` entry into a path regex (`!` and `!!` negate). */
export function globToRegExp(pattern) {
	const negated = pattern.startsWith("!");
	const body = pattern.replace(/^!+/, "");
	let source = "";
	for (let index = 0; index < body.length; index++) {
		const char = body[index];
		if (char === "*") {
			if (body[index + 1] === "*") {
				const slashFollows = body[index + 2] === "/";
				source += slashFollows ? "(?:.*/)?" : ".*";
				index += slashFollows ? 2 : 1;
			} else {
				source += "[^/]*";
			}
		} else if (char === "?") {
			source += "[^/]";
		} else {
			source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	// A directory pattern such as `.worktrees` covers everything beneath it.
	return { negated, regex: new RegExp(`^${source}(?:/.*)?$`) };
}

/** The staged paths biome would process; passing an ignored path makes biome fail outright. */
export function biomeCoveredFiles(staged, includes) {
	const rules = includes.map(globToRegExp);
	return staged.filter((path) => {
		let covered = false;
		for (const { negated, regex } of rules) {
			if (!regex.test(path)) continue;
			covered = !negated;
		}
		return covered;
	});
}

function workspaceOf(path) {
	const match = /^(packages\/[^/]+)\//.exec(path);
	return match?.[1];
}

/**
 * Split biome's staged files into the ones whose working copy equals the index (biome may format
 * them in place and the gate restages them) and the partially staged ones (unstaged hunks on top
 * of the staged content). Restaging a partially staged file would sweep its unstaged hunks into the
 * commit, so those files are only checked, on their staged content, never rewritten or restaged.
 */
export function partitionBiomeFiles(biomeFiles, unstagedChangedFiles) {
	const partial = new Set(unstagedChangedFiles);
	return {
		whole: biomeFiles.filter((path) => !partial.has(path)),
		partiallyStaged: biomeFiles.filter((path) => partial.has(path)),
	};
}

const HOOK_GIT_LOCATION_KEYS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"];

/**
 * The commit hook exports its own git location. A staged test that runs git must not inherit it,
 * or `git add` rewrites the index the hook is committing.
 */
export function withoutHookGitLocation(base = process.env) {
	const env = { ...base };
	for (const key of HOOK_GIT_LOCATION_KEYS) delete env[key];
	return env;
}

/** Where a partially staged file's staged blob is checked: a sibling with the same extension, never committed. */
export function stagedCopyPath(path) {
	const slash = path.lastIndexOf("/");
	const directory = slash === -1 ? "" : path.slice(0, slash + 1);
	const name = slash === -1 ? path : path.slice(slash + 1);
	return `${directory}.precommit-staged-${name}`;
}

/**
 * Pure planner: staged repo-relative paths plus biome includes → the gates this commit buys.
 * `findRelated(workspace, stagedFiles)` returns the repo-relative tests that import a staged source.
 */
export function planStagedGates(staged, options) {
	const files = staged.map((path) => path.replaceAll("\\", "/"));
	const plan = {
		biome: biomeCoveredFiles(files, options.biomeIncludes),
		browserSmoke: files.some((path) => BROWSER_SMOKE_INPUTS.test(path)),
		typecheck: files.some((path) => TYPESCRIPT_SOURCE.test(path)),
		tests: [],
		relatedTests: [],
	};
	for (const path of files) {
		if (/^scripts\/[^/]+\.test\.mjs$/.test(path)) {
			plan.tests.push({ cwd: ".", runner: "node-test", file: path });
			continue;
		}
		const workspace = workspaceOf(path);
		if (!workspace || !path.endsWith(".test.ts")) continue;
		const relative = path.slice(workspace.length + 1);
		// The destructive suite has its own vitest config and never runs from a hook.
		if (relative.startsWith("test-destructive/")) continue;
		if (NODE_TEST_WORKSPACES.has(workspace)) plan.tests.push({ cwd: workspace, runner: "node-test", file: relative });
		else if (VITEST_WORKSPACES.has(workspace)) plan.tests.push({ cwd: workspace, runner: "vitest", file: relative });
	}
	if (options.findRelated) {
		const stagedTests = new Set(plan.tests.map((entry) => `${entry.cwd}/${entry.file}`));
		for (const workspace of VITEST_WORKSPACES) {
			const related = options
				.findRelated(workspace, files)
				.filter((path) => !stagedTests.has(path) && !path.slice(workspace.length + 1).startsWith("test-destructive/"));
			if (related.length > 0) {
				plan.relatedTests.push({
					cwd: workspace,
					runner: "vitest",
					files: related.map((path) => path.slice(workspace.length + 1)),
				});
			}
		}
	}
	return plan;
}

/** Group carried failing tests (from a red CI verdict) into one batched run per workspace. */
export function planCarriedTests(tests, fileExists) {
	const byWorkspace = new Map();
	for (const test of tests) {
		if (!VITEST_WORKSPACES.has(test.workspace) || !fileExists(`${test.workspace}/${test.file}`)) continue;
		const files = byWorkspace.get(test.workspace) ?? [];
		files.push(test.file);
		byWorkspace.set(test.workspace, files);
	}
	return [...byWorkspace].map(([cwd, files]) => ({ cwd, runner: "vitest", files }));
}

function stagedFiles() {
	const output = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], {
		cwd: repoRoot,
		encoding: "utf8",
	});
	return output.split("\0").filter((path) => path.length > 0);
}

function readBiomeIncludes() {
	const config = JSON.parse(readFileSync(join(repoRoot, "biome.json"), "utf8"));
	return config.files?.includes ?? [];
}

function run(label, command, args, cwd = repoRoot, env = process.env) {
	const started = Date.now();
	process.stdout.write(`precommit: ${label}\n`);
	const result = spawnSync(command, args, {
		cwd: resolve(repoRoot, cwd),
		stdio: "inherit",
		env,
		shell: process.platform === "win32" && !command.endsWith(".mjs") && command !== process.execPath,
	});
	const seconds = ((Date.now() - started) / 1000).toFixed(1);
	if (result.status !== 0) {
		console.error(`❌ precommit: ${label} failed after ${seconds}s`);
		process.exit(result.status ?? 1);
	}
	process.stdout.write(`precommit: ${label} ok (${seconds}s)\n`);
}

function testCommand(entry) {
	const files = entry.files ?? [entry.file];
	if (entry.runner === "vitest") return [process.execPath, [join(repoRoot, "node_modules/vitest/vitest.mjs"), "run", ...files]];
	return [process.execPath, ["--test", ...files]];
}

function currentBranch() {
	return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
}

function isAncestorOfHead(sha) {
	return spawnSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { cwd: repoRoot }).status === 0;
}

/** Hold this commit to the branch's last recorded CI verdict (written by ci-status.mjs after a push). */
function runCarriedObligation() {
	const branch = currentBranch();
	const obligation = commitObligation(readCiStatus(branch), isAncestorOfHead);
	if (obligation.kind === "pending") {
		process.stdout.write(`precommit: CI for ${branch} is still running (${obligation.status.sha.slice(0, 9)}); its verdict applies to the next commit\n`);
		return;
	}
	if (obligation.kind === "unknown") {
		process.stdout.write(`⚠ precommit: the CI verdict for ${branch} is unknown:\n${describeStatus(obligation.status)}\n  Check it with: gh run list --workflow ci.yml --branch ${branch}\n`);
		return;
	}
	if (obligation.kind !== "red") return;
	process.stdout.write(`⚠ precommit: ${branch} is red in CI; its failing tests are carried into this commit:\n${describeStatus(obligation.status)}\n`);
	for (const entry of planCarriedTests(obligation.tests, (path) => existsSync(join(repoRoot, path)))) {
		const [command, args] = testCommand(entry);
		const label = `carried failing tests from red CI (${entry.files.length} file(s) in ${entry.cwd})`;
		process.stdout.write(`precommit: ${label}\n`);
		const result = spawnSync(command, args, { cwd: resolve(repoRoot, entry.cwd), stdio: "inherit", env: withoutHookGitLocation() });
		if (result.status !== 0) {
			console.error(
				`❌ precommit: ${branch} is red in CI (${obligation.status.url ?? obligation.status.sha}) and these tests still fail here. Fix them first: nothing lands on a red branch until its failures pass.`,
			);
			process.exit(result.status ?? 1);
		}
	}
	if (obligation.untestedFailures.length > 0) {
		process.stdout.write(
			`⚠ precommit: CI failures this hook cannot rerun (check, coverage, or a job without a report): ${obligation.untestedFailures.join("; ")}. Reproduce them before pushing.\n`,
		);
	}
}

export function main(argv = process.argv.slice(2)) {
	const staged = stagedFiles();
	const plan = planStagedGates(staged, {
		biomeIncludes: readBiomeIncludes(),
		findRelated: (workspace, files) => findCommitTests(repoRoot, workspace, files),
	});
	if (argv.includes("--dry-run")) {
		process.stdout.write(`${JSON.stringify({ staged, plan }, null, 2)}\n`);
		return;
	}
	const started = Date.now();
	const ghPin = pinGithubOriginGhDefault({ cwd: repoRoot });
	if (ghPin.setOrigin || ghPin.unset.length) {
		process.stdout.write(`precommit: gh default pinned to origin (${ghPin.slug})\n`);
	}
	run("info-exclude guard", process.execPath, [join(scriptsDir, "check-info-exclude-staged.mjs")]);
	run("lockfile guard", process.execPath, [join(scriptsDir, "check-lockfile-commit.mjs")]);
	if (plan.biome.length > 0) {
		const biomeBin = join(repoRoot, "node_modules/@biomejs/biome/bin/biome");
		const unstagedChanged = execFileSync("git", ["diff", "--name-only", "-z", "--", ...plan.biome], {
			cwd: repoRoot,
			encoding: "utf8",
		})
			.split("\0")
			.map((line) => line.trim().replaceAll("\\", "/"))
			.filter(Boolean);
		const { whole, partiallyStaged } = partitionBiomeFiles(plan.biome, unstagedChanged);
		if (whole.length > 0) {
			run(`biome on ${whole.length} staged file(s)`, process.execPath, [biomeBin, "check", "--write", "--error-on-warnings", ...whole]);
			// Formatting mutates the working tree; restage exactly the files it may have touched.
			const present = whole.filter((path) => existsSync(join(repoRoot, path)));
			if (present.length > 0) execFileSync("git", ["add", "--", ...present], { cwd: repoRoot, stdio: "inherit" });
		}
		// A partially staged file is checked on its STAGED content and never rewritten or restaged:
		// `git add` here would commit the unstaged hunks too. Formatting it is the author's move. The
		// staged blob is checked as a temporary sibling file (same directory, same extension) because
		// biome's stdin mode reports "contents aren't fixed" even when its output equals its input.
		for (const path of partiallyStaged) {
			const staged = execFileSync("git", ["show", `:${path}`], { cwd: repoRoot });
			const label = `biome on staged content of partially staged ${path}`;
			process.stdout.write(`precommit: ${label}\n`);
			const stagedCopy = stagedCopyPath(path);
			writeFileSync(join(repoRoot, stagedCopy), staged);
			let result;
			try {
				result = spawnSync(process.execPath, [biomeBin, "check", "--error-on-warnings", stagedCopy], {
					cwd: repoRoot,
					stdio: "inherit",
					env: process.env,
				});
			} finally {
				rmSync(join(repoRoot, stagedCopy), { force: true });
			}
			if (result.status !== 0) {
				console.error(
					`❌ precommit: ${label} failed. Stage the formatted content (format the file, then stage the hunks you mean) or stage the whole file.`,
				);
				process.exit(result.status ?? 1);
			}
		}
	}
	run("contract-doctrine gate", process.execPath, [join(scriptsDir, "check-contract-doctrine.mjs")]);
	if (plan.browserSmoke) run("browser smoke check", "npm", ["run", "check:browser-smoke"]);
	for (const entry of plan.tests) {
		const [command, args] = testCommand(entry);
		run(`${entry.runner} ${entry.cwd}/${entry.file}`, command, args, entry.cwd, withoutHookGitLocation());
	}
	for (const entry of plan.relatedTests) {
		const [command, args] = testCommand(entry);
		run(`tests importing staged source (${entry.files.length} file(s) in ${entry.cwd})`, command, args, entry.cwd, withoutHookGitLocation());
	}
	runCarriedObligation();
	if (plan.typecheck) run("project type check (staged TypeScript source)", process.execPath, [join(scriptsDir, "run-tsc.mjs"), "--noEmit"]);
	process.stdout.write(`✅ precommit: staged gates passed in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
