#!/usr/bin/env node
/**
 * Staged-scoped pre-commit gate.
 *
 * The hook used to run the repo-wide `npm run format` and the whole `npm run check` chain on every
 * commit (about two minutes, most of it on files the commit never touched). This gate looks only at
 * what is staged: the exclude/lockfile guards, biome on the staged files biome.json covers, the
 * contract-doctrine gate (already staged-aware), the browser smoke check when its inputs are staged,
 * and one project type check when a TypeScript source is staged (per-file type checking is unsound:
 * an importer of the changed file can break). Everything else in `npm run check` stays a CI and
 * release gate. The conditional browser smoke check includes focused tooling tests; the hook
 * also reports the branch's last recorded CI verdict (see ci-status.mjs) as a warning.
 *
 * `--dry-run` prints the plan for the current staged set without running anything.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitObligation, describeStatus, readCiStatus } from "./ci-status.mjs";
import { pinGithubOriginGhDefault } from "./github-origin.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "..");

// AI docs and CLI identity scripts do not enter the browser bundle.
export const BROWSER_SMOKE_INPUTS =
	/^(packages\/ai\/(src\/|package\.json$|tsconfig[^/]*\.json$)|packages\/web-ui\/|package\.json$|package-lock\.json$)/;
// These generated files contain literal request metadata only. They still receive formatting and
// project type checks; reconsider this exemption if their generators start emitting runtime code.
const CLI_IDENTITY_CONFIGS = new Set([
	"packages/ai/src/providers/anthropic-client-config.generated.ts",
	"packages/ai/src/providers/antigravity-client-config.generated.ts",
	"packages/ai/src/providers/xai-client-config.generated.ts",
]);
const TYPESCRIPT_SOURCE = /^packages\/[^/]+\/.*\.(?:ts|tsx|mts|cts)$/;

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
	return {
		biome: biomeCoveredFiles(files, options.biomeIncludes),
		browserSmoke: files.some((path) => BROWSER_SMOKE_INPUTS.test(path) && !CLI_IDENTITY_CONFIGS.has(path)),
		typecheck: files.some((path) => TYPESCRIPT_SOURCE.test(path)),
	};
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
		console.error(`precommit: error: ${label} failed after ${seconds}s`);
		process.exit(result.status ?? 1);
	}
	process.stdout.write(`precommit: ${label} ok (${seconds}s)\n`);
}

function currentBranch() {
	return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
}

function isAncestorOfHead(sha) {
	return spawnSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { cwd: repoRoot }).status === 0;
}

/** Report the branch's last recorded CI verdict (written by ci-status.mjs after a push). */
function reportCiVerdict() {
	const branch = currentBranch();
	const obligation = commitObligation(readCiStatus(branch), isAncestorOfHead);
	if (obligation.kind === "pending") {
		process.stdout.write(`precommit: CI for ${branch} is still running (${obligation.status.sha.slice(0, 9)}); its verdict applies to the next commit\n`);
	} else if (obligation.kind === "unknown") {
		process.stdout.write(`precommit: warning: the CI verdict for ${branch} is unknown:\n${describeStatus(obligation.status)}\n  Check it with: gh run list --workflow ci.yml --branch ${branch}\n`);
	} else if (obligation.kind === "red") {
		process.stdout.write(`precommit: warning: ${branch} is red in CI:\n${describeStatus(obligation.status)}\n`);
	}
}

export function main(argv = process.argv.slice(2)) {
	const staged = stagedFiles();
	const plan = planStagedGates(staged, { biomeIncludes: readBiomeIncludes() });
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
					`precommit: error: ${label} failed. Stage the formatted content (format the file, then stage the hunks you mean) or stage the whole file.`,
				);
				process.exit(result.status ?? 1);
			}
		}
	}
	run("contract-doctrine gate", process.execPath, [join(scriptsDir, "check-contract-doctrine.mjs")]);
	if (plan.browserSmoke) run("browser smoke check", "npm", ["run", "check:browser-smoke"]);
	reportCiVerdict();
	if (plan.typecheck) run("project type check (staged TypeScript source)", process.execPath, [join(scriptsDir, "run-tsc.mjs"), "--noEmit"]);
	process.stdout.write(`precommit: staged gates passed in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
