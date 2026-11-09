/**
 * Whether a lane's tip is contained in main, or in another lane's branch: a read-only question the merge join asks of the
 * lanes it lands (`plan/plan-merge.ts`). It takes no lock: the land gate decides under its own lock, and this answer is
 * only ever read before a landing or after a stale refusal.
 */

import type { WorktreeSyncEngineDeps } from "./git-engine.ts";
import { resolveRepoContext, runGit } from "./git-engine.ts";
import { readLane } from "./store.ts";

export interface LaneTipContainedArgs {
	readonly laneKey: string;
	/** The lane whose branch must contain this lane's tip; main when omitted. */
	readonly intoLaneKey?: string;
}

async function branchSha(deps: WorktreeSyncEngineDeps, topLevel: string, branch: string): Promise<string | undefined> {
	const result = await runGit(deps, topLevel, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
	if (result.code !== 0) return undefined;
	return result.stdout.trim() || undefined;
}

/**
 * Whether the tip of lane `laneKey` is an ancestor of (or equal to) main, or of the branch of `intoLaneKey`. A fast-forward land
 * moves main to the tip, so a tip main contains has landed, every commit of the lane included. A tip another lane's branch
 * contains was carried into that lane. `undefined` when there is no such lane; a git failure throws.
 */
export async function laneTipContained(
	deps: WorktreeSyncEngineDeps,
	args: LaneTipContainedArgs,
): Promise<boolean | undefined> {
	const ctx = await resolveRepoContext(deps);
	if ("code" in ctx) return undefined;
	const lane = await readLane(ctx.paths, args.laneKey);
	if (!lane || lane.status === "released") return undefined;
	const intoBranch =
		args.intoLaneKey === undefined ? ctx.mainBranch : (await readLane(ctx.paths, args.intoLaneKey))?.branch;
	if (intoBranch === undefined) return undefined;
	const tip = await branchSha(deps, ctx.topLevel, lane.branch);
	const target = await branchSha(deps, ctx.topLevel, intoBranch);
	if (!tip || !target) return false;
	const result = await runGit(deps, ctx.topLevel, ["merge-base", "--is-ancestor", tip, target]);
	if (result.code === 0) return true;
	if (result.code === 1) return false;
	throw new Error(`git merge-base --is-ancestor failed for lane '${args.laneKey}' (exit ${result.code})`);
}
