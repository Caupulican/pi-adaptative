/**
 * The worktree-lane binding contract: a process launched with `PI_WORKTREE_LANE=<key>` is bound to
 * that lane. Dependency-free on purpose: session identity reads it on every launch path.
 */

export const PI_WORKTREE_LANE_ENV = "PI_WORKTREE_LANE";

/** A lane key: lowercase alphanumerics and inner hyphens, at most 63 characters. */
export const WORKTREE_LANE_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The lane this process is bound to, from the cross-process env contract. Invalid values are
 * ignored (never a crash on a malformed env). */
export function getBoundWorktreeLaneKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const value = env[PI_WORKTREE_LANE_ENV]?.trim();
	return value && WORKTREE_LANE_KEY_PATTERN.test(value) ? value : undefined;
}
