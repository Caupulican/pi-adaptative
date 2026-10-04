/**
 * Scratch directories owned by this process. They live in one leased work run under the agent
 * directory instead of the shared OS temp directory, so a process that dies without running its exit
 * handlers (SIGKILL, power loss) leaves a run whose lease marker names a dead pid. The next process
 * that opens a scratch run sweeps every such run that is past {@link FRESH_RUN_GRACE_MS}, so abandoned
 * scratch is bounded by the next start rather than by a 30-day retention. The sweep never removes a run
 * with a live lease; the grace only covers a run another process has just created and not yet leased
 * (a sweep with no grace could delete it between its mkdir and its lease marker, as processes that
 * start together, a root and its workers, routinely do).
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import { acquireWorkRun, removeWorkRun, type WorkRunLease } from "../utils/work-directory.ts";

const SCRATCH_CATEGORY = "scratch";
const SCRATCH_TENANT = "process";

/** A run younger than this is never swept, leased or not: its creator may not have leased it yet. */
const FRESH_RUN_GRACE_MS = 30_000;

let lease: WorkRunLease | undefined;
let exitCleanupRegistered = false;

function processScratchRun(): WorkRunLease {
	// The run directory can vanish under a long-lived process (the work root was cleared); lease a new one.
	if (lease && existsSync(lease.path)) return lease;
	lease = acquireWorkRun({
		agentDir: getAgentDir(),
		category: SCRATCH_CATEGORY,
		tenant: SCRATCH_TENANT,
		// A run without a live lease belongs to a dead owner: sweep it.
		retention: { maxAgeMs: FRESH_RUN_GRACE_MS },
	});
	if (!exitCleanupRegistered) {
		exitCleanupRegistered = true;
		process.once("exit", () => {
			try {
				if (lease) removeWorkRun(lease);
			} catch {
				// Process shutdown cannot safely retry filesystem cleanup.
			}
		});
	}
	return lease;
}

/** A fresh private directory inside this process's leased scratch run. */
export function createProcessScratchDirectory(prefix: string): string {
	return mkdtempSync(join(processScratchRun().path, prefix));
}

/** Remove a directory returned by {@link createProcessScratchDirectory}. */
export function removeProcessScratchDirectory(path: string): void {
	rmSync(path, { recursive: true, force: true });
}
