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
 * `--dry-run` prints the plan for the current staged set without running anything.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

/** Where a partially staged file's staged blob is checked: a sibling with the same extension, never committed. */
export function stagedCopyPath(path) {
	const slash = path.lastIndexOf("/");
	const directory = slash === -1 ? "" : path.slice(0, slash + 1);
	const name = slash === -1 ? path : path.slice(slash + 1);
	return `${directory}.precommit-staged-${name}`;
}

/** Pure planner: staged repo-relative paths plus biome includes → the gates this commit buys. */
export function planStagedGates(staged, options) {
	const files = staged.map((path) => path.replaceAll("\\", "/"));
	const plan = {
		biome: biomeCoveredFiles(files, options.biomeIncludes),
		browserSmoke: files.some((path) => BROWSER_SMOKE_INPUTS.test(path)),
		typecheck: files.some((path) => TYPESCRIPT_SOURCE.test(path)),
		tests: [],
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
	return plan;
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

function run(label, command, args, cwd = repoRoot) {
	const started = Date.now();
	process.stdout.write(`precommit: ${label}\n`);
	const result = spawnSync(command, args, {
		cwd: resolve(repoRoot, cwd),
		stdio: "inherit",
		env: process.env,
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
	if (entry.runner === "vitest") return [process.execPath, [join(repoRoot, "node_modules/vitest/vitest.mjs"), "run", entry.file]];
	return [process.execPath, ["--test", entry.file]];
}

export function main(argv = process.argv.slice(2)) {
	const staged = stagedFiles();
	const plan = planStagedGates(staged, { biomeIncludes: readBiomeIncludes() });
	if (argv.includes("--dry-run")) {
		process.stdout.write(`${JSON.stringify({ staged, plan }, null, 2)}\n`);
		return;
	}
	const started = Date.now();
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
		run(`${entry.runner} ${entry.cwd}/${entry.file}`, command, args, entry.cwd);
	}
	if (plan.typecheck) run("project type check (staged TypeScript source)", process.execPath, [join(scriptsDir, "run-tsc.mjs"), "--noEmit"]);
	process.stdout.write(`✅ precommit: staged gates passed in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
