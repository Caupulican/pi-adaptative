/**
 * Worktree-lane lifecycle for externally managed (collaboration) workers: bind a lane to the
 * managed worker at dispatch, and dispose of it when the worker's process closes.
 *
 * Event-driven only: both entry points are called from the managed-lane ledger's own `dispatch` and
 * `lifecycle: retired` reports -- nothing here polls or inspects process output to learn that work
 * ended. Disposal never discards work: it is the engine's `releaseLane` WITHOUT the discard
 * confirmation, so a lane releases only when it is bound to this worker, its branch is fully landed and
 * its checkout clean;
 * anything else stays on disk and is reported to the parent, who alone may confirm a discard (G11).
 */

import { basename, dirname } from "node:path";
import { bindLaneWorker, releaseLane, resolveRepoContext, type WorktreeSyncEngineDeps } from "./git-engine.ts";

export interface WorktreeLaneLifecycleDeps {
	/**
	 * Engine deps rooted at `cwd`, or at the owning session's directory when none is given; undefined when
	 * worktree-sync is disabled. A lane lives in the repository its worktree was created from, which a task
	 * directory can make a different repository than the session's own, so the lane's recorded path decides.
	 */
	engineDeps(cwd?: string): WorktreeSyncEngineDeps | undefined;
	/** Report a lane that was kept (unlanded or dirty) to the parent session. */
	notifyParent(text: string): void;
	warn(message: string): void;
}

export class WorktreeLaneLifecycle {
	private readonly deps: WorktreeLaneLifecycleDeps;

	constructor(deps: WorktreeLaneLifecycleDeps) {
		this.deps = deps;
	}

	/**
	 * Record which managed worker owns the lane, at the dispatch that created that worker. `lanePath` is the lane's
	 * worktree as the dispatch recorded it; it locates the repository, and the lane is still looked up by key there.
	 */
	async bind(laneKey: string, laneId: string, lanePath?: string): Promise<void> {
		const engine = this.deps.engineDeps(lanePath);
		if (!engine) return;
		const bound = await bindLaneWorker(engine, { laneKey, laneId });
		if (bound.code === "bound" || bound.code === "already_bound") return;
		this.deps.warn(
			`worktree lane '${laneKey}' could not be bound to worker ${laneId}: [${bound.code}] ${"message" in bound ? bound.message : `bound to ${bound.boundLaneId}`}`,
		);
	}

	/**
	 * The worker's process closed: release its lane if (and only if) nothing would be lost. The lane is released in
	 * the repository the dispatch recorded (`lanePath`), never in whatever repository the session is in now. The
	 * path is a caller claim: a wrong one finds no lane, or a lane bound to another worker, and releases nothing.
	 */
	async retire(laneKey: string, laneId: string, lanePath?: string): Promise<void> {
		const repository = lanePath ? await this.repositoryCheckout(lanePath) : undefined;
		const engine = this.deps.engineDeps(repository);
		if (!engine) return;
		const released = await releaseLane(engine, { laneKey, expectBoundLaneId: laneId });
		if (released.code === "released") return;
		if (released.code === "lane_unlanded_work") {
			this.deps.notifyParent(
				`Worker ${laneId} closed and its worktree lane '${laneKey}' was kept: ${released.message}`,
			);
			return;
		}
		this.deps.warn(
			`worktree lane '${laneKey}' of closed worker ${laneId} was not released: [${released.code}] ${released.message}`,
		);
	}

	/**
	 * A checkout of the lane's repository that survives the lane's removal: the lane's own worktree is deleted by
	 * the release, so the engine cannot run from it. Resolved while the lane still exists; undefined when the lane
	 * path no longer leads to a repository (the session's directory is then used, as before).
	 */
	private async repositoryCheckout(lanePath: string): Promise<string | undefined> {
		const probe = this.deps.engineDeps(lanePath);
		if (!probe) return undefined;
		const context = await resolveRepoContext(probe);
		if ("code" in context) return undefined;
		if (context.hubPath) return context.hubPath;
		return basename(context.gitCommonDir) === ".git" ? dirname(context.gitCommonDir) : undefined;
	}
}
