/** Process and worker ownership of a registered worktree lane. */

import { harnessLog } from "../../kernel/harness-log.ts";
import { judgeOwner, type ProcessOwner } from "../../kernel/reliability/owner-identity.ts";
import { isPositiveSafePid } from "../../kernel/reliability/process-tree.ts";
import { withFileLock } from "../util/atomic-file.ts";
import type { BindLaneWorkerResult, LaneRegistration } from "./codes.ts";
import type { RepoContext, WorktreeSyncEngineDeps } from "./git-engine.ts";
import { WORKTREE_LANE_KEY_PATTERN } from "./lane-binding.ts";
import { appendAuditEvent, readLane, writeLane } from "./store.ts";

/**
 * The process recorded as owning `lane`, or undefined when the record names no valid pid (it owns nothing). An owner
 * naming no host predates host recording and is judged as this host's; one without a start time is judged by pid alone.
 */
export function laneOwner(lane: LaneRegistration): ProcessOwner | undefined {
	return isPositiveSafePid(lane.owner?.pid) ? lane.owner : undefined;
}

/** Foreign sessions retain their claim until their owner is proven dead. */
export function ownerConflicts(deps: WorktreeSyncEngineDeps, lane: LaneRegistration): boolean {
	if (lane.ownerSessionId == null || lane.ownerSessionId === deps.sessionId) return false;
	const owner = laneOwner(lane);
	return owner !== undefined && judgeOwner(owner, deps) !== "dead";
}

export interface BindLaneWorkerArgs {
	laneKey: string;
	laneId: string;
	/** A handoff can replace only its source's existing binding. Ordinary dispatch requires an unbound lane. */
	expectedSource?: string;
}

export async function bindRegisteredLaneWorker(
	ctx: RepoContext,
	deps: WorktreeSyncEngineDeps,
	args: BindLaneWorkerArgs,
	expectedWorktreePath?: string,
): Promise<BindLaneWorkerResult> {
	return withFileLock(ctx.paths.lifecycleLockFile, async () => {
		const { laneKey, laneId, expectedSource } = args;
		const lane = WORKTREE_LANE_KEY_PATTERN.test(laneKey) ? await readLane(ctx.paths, laneKey) : undefined;
		if (
			lane?.laneKey !== laneKey ||
			(expectedWorktreePath !== undefined && expectedWorktreePath !== lane.worktreePath)
		) {
			return { code: "lane_not_found", message: `lane '${laneKey}' is no longer registered at its checkout` };
		}
		if (lane.status !== "active") return { code: "lane_not_active", message: `lane '${laneKey}' is ${lane.status}` };
		if (ownerConflicts(deps, lane)) {
			return { code: "lane_owner_conflict", message: `lane '${laneKey}' belongs to another live session` };
		}
		if (lane.boundLaneId === laneId) return { code: "already_bound", laneKey, laneId };
		if (lane.boundLaneId !== expectedSource) {
			return lane.boundLaneId
				? { code: "binding_conflict", laneKey, boundLaneId: lane.boundLaneId }
				: { code: "lane_unbound", message: `lane '${laneKey}' has no source worker binding` };
		}
		const at = deps.now?.() ?? new Date().toISOString();
		try {
			await writeLane(ctx.paths, { ...lane, boundLaneId: laneId, updatedAt: at }, ctx.write);
		} catch (error) {
			return { code: "store_error", message: `lane binding persistence failed: ${String(error)}` };
		}
		try {
			const event =
				expectedSource === undefined
					? { event: "lane_worker_bound", laneKey, laneId }
					: { event: "lane_worker_transferred", laneKey, laneId, previousLaneId: expectedSource };
			await appendAuditEvent(ctx.paths, event, at);
		} catch (error) {
			// The atomic binding already committed. Returning a refusal here would resume the wrong worker.
			harnessLog.log("warn", "worktree", "could not audit a committed lane binding", () => ({
				laneKey,
				error: String(error),
			}));
		}
		return { code: "bound", laneKey, laneId };
	});
}
