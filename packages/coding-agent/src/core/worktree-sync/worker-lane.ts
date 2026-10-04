/**
 * Worktree lanes for in-process `delegate` workers.
 *
 * A writing worker that shares the root's checkout shares its branch, index and HEAD: its `git commit` or
 * `merge` lands on the root's branch, and two workers can race each other there. When worktree-sync is enabled
 * the host gives each fresh writing worker its own lane worktree (its own branch off main) instead, through
 * the same engine every collaboration lane uses, so the worker's repository writes can only land on its own
 * lane branch and integrate through the normal sync / land gates.
 *
 * Eligibility is a precondition of a CORRECT lane, not a policy veto: a lane is a fresh checkout of main, so it
 * is only the same code the worker would have seen when the root's checkout is on main, has no uncommitted or
 * untracked changes (they would be invisible in the lane), and keeps no installed dependencies in the checkout
 * (a fresh worktree has none, so the worker could not run the project's checks). Otherwise the worker runs in
 * the shared checkout exactly as before, with attribution (see docs/worktree-sync.md), and the reason is
 * returned so the host can state it.
 *
 * Read-only here, apart from `createLane` (the engine's own call). Nothing in this module deletes anything.
 */

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { LaneFacts, LaneRegistration } from "./codes.ts";
import {
	bindLaneWorker,
	createLane,
	deriveLaneFacts,
	type RepoContext,
	releaseLane,
	resolveRepoContext,
	type WorktreeSyncEngineDeps,
} from "./git-engine.ts";
import { listLanes } from "./store.ts";

/** Directories whose presence in the checkout means the project's dependencies are installed in-tree. */
const INSTALLED_DEPENDENCY_DIRECTORIES = ["node_modules", ".venv", "venv"] as const;

export type WorkerLaneIneligibleReason =
	| "not_a_git_repo"
	| "not_on_main"
	| "checkout_dirty"
	| "dependencies_installed_in_checkout"
	| "git_error";

export type WorkerLaneCreation =
	| { kind: "isolated"; laneKey: string; worktreePath: string }
	| { kind: "shared"; reason: WorkerLaneIneligibleReason | string; message: string };

function canonical(target: string): string {
	try {
		return realpathSync(target);
	} catch {
		return resolve(target);
	}
}

/** Whether `target` is `root` or inside it, on canonical paths. */
function isInside(root: string, target: string): boolean {
	const base = canonical(root);
	const candidate = canonical(target);
	return candidate === base || candidate.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

/**
 * Create a lane for a fresh writing worker rooted at `deps.cwd`, or say why the worker stays in the shared
 * checkout. A creation refusal from the engine (`max_lanes_reached`, a git error) is returned the same way:
 * the worker is never refused, only left in the shared checkout with the reason stated.
 */
export async function createWorkerLane(
	deps: WorktreeSyncEngineDeps,
	requirementId: string,
): Promise<WorkerLaneCreation> {
	const context = await resolveRepoContext(deps);
	if ("code" in context) {
		return {
			kind: "shared",
			reason: context.code === "not_a_git_repo" ? "not_a_git_repo" : "git_error",
			message: context.message,
		};
	}
	if (!context.hubPath || canonical(context.hubPath) !== canonical(context.topLevel)) {
		return {
			kind: "shared",
			reason: "not_on_main",
			message: `the checkout is not on ${context.mainBranch}, so a lane would start from different code`,
		};
	}
	if (INSTALLED_DEPENDENCY_DIRECTORIES.some((name) => existsSync(join(context.topLevel, name)))) {
		return {
			kind: "shared",
			reason: "dependencies_installed_in_checkout",
			message: "installed dependencies live in the checkout and a fresh lane would not have them",
		};
	}
	const status = await deps.exec("git", ["status", "--porcelain"], {
		cwd: context.topLevel,
		timeout: 60_000,
		signal: deps.signal,
		maxBuffer: 1024 * 1024,
	});
	if (status.code !== 0) {
		return { kind: "shared", reason: "git_error", message: (status.stderr || status.stdout).trim().slice(0, 300) };
	}
	if (status.stdout.trim().length > 0) {
		return {
			kind: "shared",
			reason: "checkout_dirty",
			message: "the checkout has uncommitted or untracked changes a lane would not contain",
		};
	}
	const created = await createLane(deps, { requirementId });
	if (created.code !== "ok") return { kind: "shared", reason: created.code, message: created.message };
	return { kind: "isolated", laneKey: created.lane.laneKey, worktreePath: created.lane.worktreePath };
}

interface LaneAt {
	context: RepoContext;
	lane: LaneRegistration;
}

/** The repository `worktreePath` belongs to and the active lane registered for that worktree, if any. */
async function resolveLaneAt(deps: WorktreeSyncEngineDeps, worktreePath: string): Promise<LaneAt | undefined> {
	const context = await resolveRepoContext({ ...deps, cwd: worktreePath });
	if ("code" in context) return undefined;
	const wanted = canonical(worktreePath);
	const lane = (await listLanes(context.paths)).find(
		(entry) => entry.status === "active" && canonical(entry.worktreePath) === wanted,
	);
	return lane ? { context, lane } : undefined;
}

/**
 * A checkout of the repository that survives the lane's removal: the main checkout, else the directory holding
 * `.git`. The lane's own directory is the one thing a release deletes, so the engine cannot run from it.
 */
function repositoryCheckout(context: RepoContext): string | undefined {
	return context.hubPath ?? (basename(context.gitCommonDir) === ".git" ? dirname(context.gitCommonDir) : undefined);
}

/** Release the lane through the engine from the repository's own checkout. */
async function releaseLaneFromRepository(
	deps: WorktreeSyncEngineDeps,
	found: LaneAt,
	args: { expectBoundLaneId?: string },
): Promise<{ laneKey: string; code: string; message?: string }> {
	const checkout = repositoryCheckout(found.context);
	if (!checkout) return { laneKey: found.lane.laneKey, code: "repository_checkout_unavailable" };
	const released = await releaseLane({ ...deps, cwd: checkout }, { laneKey: found.lane.laneKey, ...args });
	return {
		laneKey: found.lane.laneKey,
		code: released.code,
		...("message" in released ? { message: released.message } : {}),
	};
}

/** The registered lane whose worktree is `worktreePath`, looked up in the repository that worktree belongs to. */
export async function findLaneByPath(
	deps: WorktreeSyncEngineDeps,
	worktreePath: string,
): Promise<LaneRegistration | undefined> {
	return (await resolveLaneAt(deps, worktreePath))?.lane;
}

/** Whether `candidate` lies under the directory lane worktrees are created in (a cheap check, no git). */
export function isUnderLaneRoot(deps: WorktreeSyncEngineDeps, candidate: string): boolean {
	return isInside(deps.worktreesBaseDir, candidate) && canonical(candidate) !== canonical(deps.worktreesBaseDir);
}

/** Record which worker owns the lane at `worktreePath`. Idempotent; a lane already bound elsewhere is left alone. */
export async function bindWorkerLaneByPath(
	deps: WorktreeSyncEngineDeps,
	worktreePath: string,
	laneId: string,
): Promise<{ laneKey: string; code: string } | undefined> {
	const lane = await findLaneByPath(deps, worktreePath);
	if (!lane) return undefined;
	const bound = await bindLaneWorker({ ...deps, cwd: worktreePath }, { laneKey: lane.laneKey, laneId });
	return { laneKey: lane.laneKey, code: bound.code };
}

export interface WorkerLaneState {
	laneKey: string;
	branch: string;
	worktreePath: string;
	facts: LaneFacts;
}

/** Live git facts of the lane at `worktreePath` (dirty, commits ahead of main), or undefined when it is not a lane. */
export async function describeWorkerLane(
	deps: WorktreeSyncEngineDeps,
	worktreePath: string,
): Promise<WorkerLaneState | undefined> {
	const found = await resolveLaneAt(deps, worktreePath);
	if (!found) return undefined;
	return {
		laneKey: found.lane.laneKey,
		branch: found.lane.branch,
		worktreePath: found.lane.worktreePath,
		facts: await deriveLaneFacts({ ...deps, cwd: worktreePath }, found.context, found.lane),
	};
}

/**
 * Release the lane bound to worker `laneId` once that worker is retired: only a lane that is fully landed and
 * clean goes (the engine's release without the discard confirmation, so a lane holding work is kept and named).
 */
export async function releaseWorkerLane(
	deps: WorktreeSyncEngineDeps,
	worktreePath: string,
	laneId: string,
): Promise<{ laneKey: string; code: string; message?: string } | undefined> {
	const found = await resolveLaneAt(deps, worktreePath);
	if (!found) return undefined;
	// A lane never bound (its worker was cancelled or failed before starting) is released like a bound one: the
	// retired worker's pinned directory is what links them, and release still requires it landed and clean. A lane
	// bound to a different worker is left alone.
	return releaseLaneFromRepository(deps, found, found.lane.boundLaneId ? { expectBoundLaneId: laneId } : {});
}

/**
 * Remove a lane no worker ever used (a fresh, clean lane created for a worker that never started). A lane
 * already bound to a worker is in use and is never touched here.
 */
export async function discardUnusedWorkerLane(
	deps: WorktreeSyncEngineDeps,
	worktreePath: string,
): Promise<{ laneKey?: string; code: string; message?: string }> {
	const found = await resolveLaneAt(deps, worktreePath);
	if (!found) return { code: "lane_not_found" };
	if (found.lane.boundLaneId) return { laneKey: found.lane.laneKey, code: "lane_in_use" };
	return releaseLaneFromRepository(deps, found, {});
}

/** Identity of the repository `directory` belongs to (its canonical git common directory), or undefined. */
export async function repositoryKeyAt(deps: WorktreeSyncEngineDeps, directory: string): Promise<string | undefined> {
	const context = await resolveRepoContext({ ...deps, cwd: directory });
	return "code" in context ? undefined : canonical(context.gitCommonDir);
}

/**
 * The repository of the lane at `worktreePath`, only when the lane's registration is bound to worker `laneId`.
 * The bound lane record is what ties a specialist to its lane: a lane bound to another worker, or to none,
 * answers nothing, so one worker's lane can never stand in for another's.
 */
export async function boundLaneRepositoryKey(
	deps: WorktreeSyncEngineDeps,
	worktreePath: string,
	laneId: string,
): Promise<string | undefined> {
	const found = await resolveLaneAt(deps, worktreePath);
	return found?.lane.boundLaneId === laneId ? canonical(found.context.gitCommonDir) : undefined;
}
