/**
 * Host-side lifecycle of the worktree lane an in-process writing worker works in (see
 * worktree-sync/worker-lane.ts for what a lane is and when a worker gets one).
 *
 * - create: before a fresh writing worker is admitted, so its execution directory is the lane from the start
 *   and the immutable execution contract pins it (a restarted worker resumes in the same lane);
 * - bind: when the worker starts, the lane's registration records which worker owns it;
 * - report: when the worker ends, a claim finding names the lane and what it holds, so the parent looks there
 *   and not in the shared checkout;
 * - release: when the worker's persistent identity is retired (event-driven, never polled), the lane is
 *   released if, and only if, it is landed and clean. A lane holding work is kept and the parent is told.
 *
 * Every step but release is best-effort and never fails the worker or the transition that triggered it. Release
 * returns its outcome and throws only when the lane may still be released by a retry (a git failure, an unavailable
 * checkout); its caller owns that retry.
 */

import { randomUUID } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import { HOST_FINDING_PREFIX } from "../autonomy/host-finding-prefixes.ts";
import { boundedText, quotedSpan } from "../util/bounded-line.ts";
import type { ReleaseOutcome } from "../util/resource-release.ts";
import type { WorktreeSyncEngineDeps } from "../worktree-sync/git-engine.ts";
import {
	bindWorkerLaneByPath,
	boundLaneRepositoryKey,
	createWorkerLane,
	describeWorkerLane,
	discardUnusedWorkerLane,
	isUnderLaneRoot,
	releaseWorkerLane,
	repositoryKeyAt,
	type WorkerLaneCreation,
} from "../worktree-sync/worker-lane.ts";

export interface WorkerLaneIsolationDeps {
	/** Engine deps rooted at `cwd`, or undefined when worktree-sync is disabled. */
	engineDeps(cwd: string): WorktreeSyncEngineDeps | undefined;
	/** Tell the parent session about a lane that was kept because it holds work. */
	notifyParent(text: string): void;
	warn(message: string): void;
}

/** Reasons a worker stays in the shared checkout that are expected conditions of the checkout, not failures. */
const EXPECTED_SHARED_REASONS: ReadonlySet<string> = new Set([
	"not_a_git_repo",
	"not_on_main",
	"checkout_dirty",
	"dependencies_installed_in_checkout",
]);

/** The longest lane claim finding, inside a claim blocker's 1000-character bound. */
const MAX_LANE_FINDING_CHARS = 960;

/** Lane release refusals a later retry may not meet. */
const RETRYABLE_LANE_RELEASE_CODES: ReadonlySet<string> = new Set([
	"git_error",
	"default_branch_unresolved",
	"repository_checkout_unavailable",
]);

export class WorkerLaneIsolation {
	private readonly deps: WorkerLaneIsolationDeps;

	constructor(deps: WorkerLaneIsolationDeps) {
		this.deps = deps;
	}

	/**
	 * A lane for a fresh writing worker whose task directory is `cwd`. `undefined` when worktree-sync is disabled
	 * or the worker stays in the shared checkout; an unexpected reason (a git error, the lane ceiling) is warned.
	 */
	async create(cwd: string): Promise<Extract<WorkerLaneCreation, { kind: "isolated" }> | undefined> {
		const engine = this.deps.engineDeps(cwd);
		if (!engine) return undefined;
		let created: WorkerLaneCreation;
		try {
			created = await createWorkerLane(engine, `worker:${randomUUID()}`);
		} catch (error) {
			this.deps.warn(`Worker lane isolation unavailable: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
		if (created.kind === "isolated") return created;
		if (!EXPECTED_SHARED_REASONS.has(created.reason)) {
			this.deps.warn(
				`Worker lane isolation unavailable [${created.reason}]: ${created.message}. The worker runs in the shared checkout.`,
			);
		}
		return undefined;
	}

	/**
	 * Remove the lane at `worktreePath` when no worker ever used it (the worker could not be moved into it, or its
	 * start was refused), so a failed start leaves no lane behind. A lane bound to a worker is never removed here.
	 */
	async discard(worktreePath: string): Promise<void> {
		const engine = this.deps.engineDeps(worktreePath);
		if (!engine || !isUnderLaneRoot(engine, worktreePath)) return;
		try {
			const discarded = await discardUnusedWorkerLane(engine, worktreePath);
			if (discarded.code !== "released" && discarded.code !== "lane_not_found" && discarded.code !== "lane_in_use") {
				this.deps.warn(
					`Unused worker lane '${discarded.laneKey ?? worktreePath}' was not removed: [${discarded.code}] ${discarded.message ?? ""}`,
				);
			}
		} catch (error) {
			this.deps.warn(`Unused worker lane removal failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** Whether `directory` is the lane's worktree or inside it. */
	isInsideLane(worktreePath: string, directory: string): boolean {
		const offset = relative(worktreePath, directory);
		return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
	}

	/** Whether `directory` lies in the area lane worktrees are created in (a cheap check, no git). */
	isLaneDirectory(directory: string): boolean {
		const engine = this.deps.engineDeps(directory);
		return engine !== undefined && isUnderLaneRoot(engine, directory);
	}

	/** The repository `directory` belongs to, as a comparable key (undefined when it is not in one). */
	async repositoryKey(directory: string): Promise<string | undefined> {
		const engine = this.deps.engineDeps(directory);
		if (!engine) return undefined;
		try {
			return await repositoryKeyAt(engine, directory);
		} catch {
			return undefined;
		}
	}

	/**
	 * The repository the lane at `directory` was made from, when the lane's registration is bound to worker
	 * `agentId`; undefined for any other lane, so matching can never cross lanes between workers.
	 */
	async boundLaneRepositoryKey(directory: string, agentId: string): Promise<string | undefined> {
		const engine = this.deps.engineDeps(directory);
		if (!engine || !isUnderLaneRoot(engine, directory)) return undefined;
		try {
			return await boundLaneRepositoryKey(engine, directory, agentId);
		} catch {
			return undefined;
		}
	}

	/** Record `agentId` as the owner of the lane at `cwd`, when `cwd` is a lane. */
	async bind(cwd: string, agentId: string): Promise<void> {
		const engine = this.deps.engineDeps(cwd);
		if (!engine || !isUnderLaneRoot(engine, cwd)) return;
		try {
			const bound = await bindWorkerLaneByPath(engine, cwd, agentId);
			if (bound && bound.code !== "bound" && bound.code !== "already_bound") {
				this.deps.warn(`Worker ${agentId}'s worktree lane '${bound.laneKey}' could not be bound: [${bound.code}].`);
			}
		} catch (error) {
			this.deps.warn(`Worker lane bind failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * The claim finding for a worker that worked in a lane and left changes there; `undefined` when `cwd` is not
	 * a lane or the lane holds nothing. Bounded to fit a claim blocker.
	 */
	async claimFinding(cwd: string): Promise<string | undefined> {
		const engine = this.deps.engineDeps(cwd);
		if (!engine || !isUnderLaneRoot(engine, cwd)) return undefined;
		try {
			const state = await describeWorkerLane(engine, cwd);
			if (!state || (!state.facts.dirty && state.facts.aheadOfMain === 0)) return undefined;
			const holds = [
				...(state.facts.dirty ? ["uncommitted changes"] : []),
				...(state.facts.aheadOfMain > 0 ? [`${state.facts.aheadOfMain} commit(s) ahead of main`] : []),
			].join(" and ");
			const line = `${HOST_FINDING_PREFIX.lane} this worker worked in its own worktree lane '${state.laneKey}' (${quotedSpan(state.worktreePath)}, branch ${state.branch}), not the shared checkout; its changes are there: ${holds}. Review with worktree_sync git_diff laneKey=${state.laneKey}; integrate with git_add and git_commit (laneKey), sync, then land; release_lane when done.`;
			// Never cut inside the quoted lane key or the quoted lane path; the kept tail starts at a path separator when one
			// is in reach.
			return boundedText(line, MAX_LANE_FINDING_CHARS);
		} catch (error) {
			this.deps.warn(`Worker lane report failed: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	/**
	 * The worker `agentId` was retired: release the lane at `cwd` if (and only if) nothing would be lost. A lane that
	 * is gone (or none) is released. A lane holding work is kept for the parent, who is told (abandoned to its
	 * `release_lane`). A lane bound to another worker or owner is superseded and warned. Anything else (a git error, an
	 * unavailable checkout, a throw) rejects, so the caller retains and retries the release.
	 */
	async release(cwd: string, agentId: string): Promise<ReleaseOutcome> {
		const engine = this.deps.engineDeps(cwd);
		if (!engine || !isUnderLaneRoot(engine, cwd)) return { kind: "released" };
		const released = await releaseWorkerLane(engine, cwd, agentId);
		if (!released || released.code === "released" || released.code === "lane_not_found") return { kind: "released" };
		if (released.code === "lane_unlanded_work") {
			const cause = released.message ?? "it holds work";
			this.deps.notifyParent(
				`Worker ${agentId} was retired and its worktree lane '${released.laneKey}' was kept: ${cause}`,
			);
			return {
				kind: "abandoned",
				cause,
				reaper: `the parent's worktree_sync release_lane laneKey=${released.laneKey}`,
			};
		}
		const detail = `Retired worker ${agentId}'s worktree lane '${released.laneKey}' was not released: [${released.code}]${released.message ? ` ${released.message}` : ""}`;
		if (released.code === "lane_bound_elsewhere" || released.code === "lane_owner_conflict") {
			this.deps.warn(detail);
			return { kind: "superseded", detail };
		}
		// A git failure, an unresolved default branch or an unavailable checkout may pass: the caller retries.
		if (RETRYABLE_LANE_RELEASE_CODES.has(released.code)) throw new Error(detail);
		// Anything else (the lane's repository is no longer one) no retry can change: the lane registry's reconcile owns it.
		this.deps.warn(detail);
		return { kind: "abandoned", cause: detail, reaper: "worktree_sync reconcile" };
	}
}
