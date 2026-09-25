/**
 * The branch's recorded CI verdict, as the status bar shows it.
 *
 * A pre-push watcher (this repository's scripts/ci-status.mjs, or any tool writing the same record)
 * leaves `<git-common-dir>/pi-ci/<branch>.json` with the verdict of the last pushed commit's CI run.
 * This reads it for display: git directories are resolved once per working directory, and each read
 * is one small HEAD file plus the record itself, re-parsed only when its modification time changes.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export type CiVerdictState = "running" | "green" | "red" | "unknown";

export interface CiStatusView {
	readonly state: CiVerdictState;
	/** Failing test files the red run named (0 when it named none or is not red). */
	readonly failingTests: number;
	readonly branch: string;
}

interface GitDirs {
	readonly gitDir: string;
	readonly commonDir: string;
}

const gitDirsByCwd = new Map<string, GitDirs | null>();
const recordCache = new Map<string, { mtimeMs: number; view: CiStatusView | undefined }>();

function gitDirs(cwd: string): GitDirs | null {
	const cached = gitDirsByCwd.get(cwd);
	if (cached !== undefined) return cached;
	let dirs: GitDirs | null = null;
	try {
		const [gitDir, commonDir] = execFileSync("git", ["rev-parse", "--git-dir", "--git-common-dir"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		})
			.trim()
			.split("\n");
		if (gitDir && commonDir) dirs = { gitDir: resolve(cwd, gitDir), commonDir: resolve(cwd, commonDir) };
	} catch {
		// Not a git working tree: there is no CI record to show.
	}
	gitDirsByCwd.set(cwd, dirs);
	return dirs;
}

/** The record's meaning for display. Pure. */
export function ciStatusViewFromRecord(record: unknown, branch: string): CiStatusView | undefined {
	if (!record || typeof record !== "object") return undefined;
	const value = record as { state?: unknown; conclusion?: unknown; failingTests?: unknown };
	const failing = Array.isArray(value.failingTests) ? value.failingTests.length : 0;
	if (value.state === "pending") return { state: "running", failingTests: 0, branch };
	if (value.state !== "completed") return { state: "unknown", failingTests: 0, branch };
	return value.conclusion === "success"
		? { state: "green", failingTests: 0, branch }
		: { state: "red", failingTests: failing, branch };
}

/** The current branch's recorded CI verdict, or undefined when there is none to show. */
export function readCiStatusView(cwd: string): CiStatusView | undefined {
	const dirs = gitDirs(cwd);
	if (!dirs) return undefined;
	let head: string;
	try {
		head = readFileSync(join(dirs.gitDir, "HEAD"), "utf8").trim();
	} catch {
		return undefined;
	}
	const branch = head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : undefined;
	if (!branch) return undefined;
	const path = join(dirs.commonDir, "pi-ci", `${branch.replaceAll("/", "__")}.json`);
	if (!existsSync(path)) return undefined;
	let mtimeMs: number;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		return undefined;
	}
	const cached = recordCache.get(path);
	if (cached?.mtimeMs === mtimeMs) return cached.view;
	let view: CiStatusView | undefined;
	try {
		view = ciStatusViewFromRecord(JSON.parse(readFileSync(path, "utf8")), branch);
	} catch {
		view = { state: "unknown", failingTests: 0, branch };
	}
	recordCache.set(path, { mtimeMs, view });
	return view;
}
