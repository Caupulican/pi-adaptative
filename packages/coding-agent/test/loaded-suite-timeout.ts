/** Budget for a filesystem-heavy fixture running under full release-gate contention. */
const LOADED_SUITE_TIMEOUT_MS = 90_000;

/**
 * Timeout for filesystem-heavy fixtures that run under full release-gate contention.
 *
 * Shared CI runners perform the same loaded-suite work with several workers competing for one disk,
 * so a fixture's wall-clock cost there is a property of the runner, not of the fixture. The
 * session-root-mailbox backpressure proof (1,344 durable transactions by construction) took 8.9s on
 * one ubuntu shard and 20.3s on the next run of the same commit, against a 15s budget calibrated to
 * a fast local disk. Native Windows showed the same shape first, which is why this used to apply to
 * Windows only. The budget exists to catch a hang, not to grade a disk, so every platform gets the
 * loaded budget; an explicitly larger budget is kept as given.
 */
export function loadedSuiteTimeout(existingTimeout?: number): number {
	return Math.max(existingTimeout ?? 0, LOADED_SUITE_TIMEOUT_MS);
}
