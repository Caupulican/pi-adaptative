/**
 * The branch's recorded CI verdict, as the status bar shows it.
 *
 * A pre-push watcher (this repository's scripts/ci-status.mjs, or any tool writing the same record)
 * leaves `<git-common-dir>/pi-ci/<branch>.json` with the verdict of the last pushed commit's CI run.
 * This reads it for display: git directories are resolved once per working directory, and each read
 * is one small HEAD file plus the record itself, re-parsed only when its modification time changes.
 *
 * A record can be left `pending` by a watcher that died (a killed shell, a restarted machine): the CI run
 * finished long ago and the bar would say "running" for ever. A pending record whose watcher is gone (its pid
 * is dead, or, for a record without one, it is older than any CI run lasts) is STALE: it shows as unknown and the
 * repository's CI script is asked to reconcile it against GitHub in the background (it corrects the record on disk
 * exactly as the watcher would have), and the bar redraws on the event.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export type CiVerdictState = "running" | "green" | "red" | "unknown";

export interface CiStatusView {
	readonly state: CiVerdictState;
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

/** A pending record older than this with no live watcher behind it has nothing left to wait for. */
const PENDING_STALE_AFTER_MS = 15 * 60_000;
/** A reconcile that found the run still going is asked again no sooner than this. */
const RECONCILE_COOLDOWN_MS = 2 * 60_000;

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but is not ours to signal.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Whether a `pending` record's watcher is gone: its recorded pid is dead, or (no pid) it outlived any CI run. */
function isStalePending(record: unknown, now: number): boolean {
	const value = record as { pid?: unknown; startedAt?: unknown };
	if (typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0) return !processAlive(value.pid);
	const started = typeof value.startedAt === "string" ? Date.parse(value.startedAt) : Number.NaN;
	return Number.isFinite(started) && now - started > PENDING_STALE_AFTER_MS;
}

/** The record's meaning for display. Pure. */
export function ciStatusViewFromRecord(record: unknown, branch: string, now = Date.now()): CiStatusView | undefined {
	if (!record || typeof record !== "object") return undefined;
	const value = record as { state?: unknown; conclusion?: unknown };
	if (value.state === "pending") return { state: isStalePending(record, now) ? "unknown" : "running", branch };
	if (value.state !== "completed") return { state: "unknown", branch };
	return value.conclusion === "success" ? { state: "green", branch } : { state: "red", branch };
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
		const record = JSON.parse(readFileSync(path, "utf8")) as unknown;
		view = ciStatusViewFromRecord(record, branch);
		if (view?.state === "unknown" && isPendingRecord(record)) reconcileStaleRecord(dirs.commonDir, path, branch);
	} catch {
		view = { state: "unknown", branch };
	}
	// A stale record is re-read until its reconcile rewrites it (the write changes the mtime).
	recordCache.set(path, { mtimeMs, view });
	return view;
}

function isPendingRecord(record: unknown): boolean {
	return (
		!!record &&
		typeof record === "object" &&
		(record as { state?: unknown }).state === "pending" &&
		typeof (record as { sha?: unknown }).sha === "string"
	);
}

const reconcileAttempts = new Map<string, number>();
const listeners = new Set<() => void>();

/** Called when a reconcile corrected a record, so the bar can redraw. Returns the unsubscribe. */
export function onCiStatusChange(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/**
 * Asks the repository's own CI script to correct a pending record whose watcher is gone (it looks at what GitHub
 * says about that commit and rewrites the record, one owner for the rule), at most once per cooldown. When the file
 * changes the bar redraws. A repository without the script, a missing or signed-out `gh`, or a run still going
 * leaves the record as it is (shown as unknown) until the next attempt.
 */
function reconcileStaleRecord(commonDir: string, path: string, branch: string): void {
	const now = Date.now();
	const last = reconcileAttempts.get(path);
	if (last !== undefined && now - last < RECONCILE_COOLDOWN_MS) return;
	reconcileAttempts.set(path, now);
	const script = join(resolve(commonDir, ".."), "scripts", "ci-status.mjs");
	if (!existsSync(script)) return;
	execFile(process.execPath, [script, "reconcile", branch], { timeout: 60_000 }, (error) => {
		if (error) return;
		for (const listener of [...listeners]) listener();
	});
}
