/**
 * The work a goal did, as git records it: the change from the last commit before the goal started to
 * the working tree, commits made during the goal included. System One's completion check judges this
 * text; a manifest of paths and hashes gives it nothing to read.
 */

import { execFileSync } from "node:child_process";

/** What the completion check reads of the work. */
export interface WorkDiff {
	/** The commit the work is measured from. */
	readonly base: string;
	/** `git diff <base>`, bounded. */
	readonly patch: string;
	/** Characters of the patch left out to keep the check bounded; 0 when complete. */
	readonly omittedChars: number;
	/** New files git does not track yet, which `git diff` does not show. */
	readonly untracked: readonly string[];
}

/** Enough for any focused change; larger work is judged on its first part and the file list. */
const PATCH_LIMIT = 24_000;
const UNTRACKED_LIMIT = 50;

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "ignore"],
		maxBuffer: 64 * 1024 * 1024,
	});
}

/**
 * The work since `startedAt` in the repository at `cwd`, or undefined when `cwd` is not a git
 * repository with a commit before that time (then there is no base to measure from).
 */
export function readWorkDiff(cwd: string, startedAt: string): WorkDiff | undefined {
	let base: string;
	try {
		base = git(cwd, ["rev-list", "-1", `--before=${startedAt}`, "HEAD"]).trim();
	} catch {
		return undefined;
	}
	if (!base) return undefined;
	const full = git(cwd, ["diff", "--no-color", "--no-ext-diff", base]);
	const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard"])
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	return {
		base,
		patch: full.slice(0, PATCH_LIMIT),
		omittedChars: Math.max(0, full.length - PATCH_LIMIT),
		untracked: untracked.slice(0, UNTRACKED_LIMIT),
	};
}
