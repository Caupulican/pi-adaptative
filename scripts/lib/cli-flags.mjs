/**
 * Shared CLI integer-flag parsing for the profiling scripts (scripts/profile-coding-agent-node.mjs
 * and scripts/profile-coding-agent-turn.mjs), which otherwise hand-roll the identical validation
 * independently - flagged by the production clone gate (scripts/check-production-clones.mjs).
 *
 * The two callers differ only in their lower bound: `--runs`/`--warmup` may be 0 (a warmup of 0 is
 * "no warmup", a valid choice), while `--turns` must be at least 1 (a zero-turn profiling run is
 * meaningless). `min` expresses that without duplicating the surrounding validation.
 */
export function parseIntegerFlag(value, name, { min = 0 } = {}) {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < min) {
		throw new Error(`Invalid ${name}: ${value}`);
	}
	return parsed;
}

/**
 * Universal `--help`/`-h` escape hatch shared by both profiling scripts' argv loops. Sets
 * `options.help` and reports whether `arg` was the help flag, so a caller's `for` loop can write
 * `if (tryConsumeHelpFlag(arg, options)) continue;` as its first check instead of re-declaring the
 * same two-line conditional in every script.
 */
export function tryConsumeHelpFlag(arg, options) {
	if (arg !== "--help" && arg !== "-h") return false;
	options.help = true;
	return true;
}
