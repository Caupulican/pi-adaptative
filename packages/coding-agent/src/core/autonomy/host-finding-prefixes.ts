/**
 * The leading words of the blocker lines the host itself writes about a worker (concurrent writes, protected
 * paths, its lane, omitted findings). Producers write them and the claim gate matches them, so both read this
 * one table: renaming a prefix in one place can never silently stop the other from matching.
 */
export const HOST_FINDING_PREFIX = {
	overlap: "worker_write_overlap:",
	protectedPath: "protected_path_changed:",
	lane: "worker_lane:",
	omitted: "host_findings:",
} as const;

export const HOST_FINDING_BLOCKER_PREFIXES: readonly string[] = Object.values(HOST_FINDING_PREFIX);
