/**
 * Whether a shared checkout currently holds work this session did not produce.
 *
 * Several pi sessions run in one worktree. A command that discards the whole tree destroys their
 * uncommitted work with no reflog to recover from, so the edge needs to know whether any of that
 * work is present right now. Discarding only your own changes is the session's own business and
 * never reaches the operator, which is why this asks about ownership and not about dirtiness.
 */
import { execFile } from "node:child_process";
import { parsePorcelainZ } from "./delivery-proof.ts";

const STATUS_TIMEOUT_MS = 5_000;
const STATUS_MAX_BYTES = 4 * 1024 * 1024;

/** Repo-relative paths with uncommitted changes, or undefined when the status could not be read. */
export async function dirtyWorktreePaths(cwd: string, signal?: AbortSignal): Promise<string[] | undefined> {
	return new Promise((resolve) => {
		execFile(
			"git",
			["status", "--porcelain=v1", "-z"],
			{
				cwd,
				encoding: "utf8",
				timeout: STATUS_TIMEOUT_MS,
				maxBuffer: STATUS_MAX_BYTES,
				...(signal ? { signal } : {}),
				env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
			},
			(error, stdout) => {
				if (error) {
					resolve(undefined);
					return;
				}
				resolve(parsePorcelainZ(stdout));
			},
		);
	});
}

/**
 * True when at least one dirty path is outside `writtenPaths`.
 *
 * An unreadable status answers false: the edge must not start asking about a state nobody could
 * establish. A clean tree, and a tree whose every change this session wrote, are both false.
 */
export async function hasUnownedWorktreeChanges(
	cwd: string,
	writtenPaths: readonly string[],
	signal?: AbortSignal,
): Promise<boolean> {
	const dirty = await dirtyWorktreePaths(cwd, signal);
	if (dirty === undefined || dirty.length === 0) return false;
	const owned = new Set(writtenPaths);
	return dirty.some((path) => !owned.has(path));
}
