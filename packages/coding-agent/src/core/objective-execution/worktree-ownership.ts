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

/** What `git status` said about a checkout: its dirty paths, that it is not a repository, or nothing. */
export type WorktreeStatus =
	| { readonly kind: "paths"; readonly paths: string[] }
	| { readonly kind: "no_repository" }
	| { readonly kind: "unreadable"; readonly reason: string };

/** The checkout's repo-relative dirty paths, as `git status` reports them. */
export async function readWorktreeStatus(cwd: string, signal?: AbortSignal): Promise<WorktreeStatus> {
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
			(error, stdout, stderr) => {
				if (!error) {
					resolve({ kind: "paths", paths: parsePorcelainZ(stdout) });
					return;
				}
				if (/not a git repository/i.test(String(stderr))) {
					resolve({ kind: "no_repository" });
					return;
				}
				resolve({ kind: "unreadable", reason: error.message });
			},
		);
	});
}

/**
 * True when the checkout may hold work this session did not write: at least one dirty path is
 * outside `writtenPaths`, or the status could not be read. A discard is irreversible, so a state
 * nobody could establish counts as holding such work and the edge asks (the authority line's rule for
 * an irreversible operation on an unknown state). A clean tree, a tree whose every change this
 * session wrote, and a directory that is not a repository are false.
 */
export async function mayHoldUnownedWorktreeChanges(
	cwd: string,
	writtenPaths: readonly string[],
	signal?: AbortSignal,
): Promise<boolean> {
	const status = await readWorktreeStatus(cwd, signal);
	if (status.kind === "no_repository") return false;
	if (status.kind === "unreadable") return true;
	const owned = new Set(writtenPaths);
	return status.paths.some((path) => !owned.has(path));
}
