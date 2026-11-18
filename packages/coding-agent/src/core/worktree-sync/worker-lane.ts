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

import { existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { findRepositoryGitPaths, safeRealpathSync } from "../autonomy/path-scope.ts";
import type { LaneFacts, LaneRegistration } from "./codes.ts";
import {
	createLane,
	deriveLaneFacts,
	type RepoContext,
	releaseLane,
	resolveRepoContext,
	type WorktreeSyncEngineDeps,
} from "./git-engine.ts";
import { WORKTREE_LANE_KEY_PATTERN } from "./lane-binding.ts";
import { bindRegisteredLaneWorker } from "./lane-ownership.ts";
import { listLanes, readLane, readLaneSync, type SyncStorePaths, syncStorePaths } from "./store.ts";

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

/**
 * `target`'s real path through the operating system's resolver (`safeRealpathSync` native: symlinks followed, Windows
 * 8.3 short names expanded, a not-yet-created tail kept), or undefined when it is not resolvable (a symlink loop, more
 * hops than it follows). Never throws.
 */
export function nativeRealPath(target: string): string | undefined {
	try {
		return safeRealpathSync(target, { native: true });
	} catch {
		return undefined;
	}
}

/** `target`'s real path (`nativeRealPath`), or its resolved path when that is not resolvable. */
export function canonical(target: string): string {
	return nativeRealPath(target) ?? resolve(target);
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

/** The active registered lane for a checkout identity or exact worktree path, if any. */
async function resolveLaneAt(
	deps: WorktreeSyncEngineDeps,
	worktreePath: string,
	containingCheckout = false,
): Promise<LaneAt | undefined> {
	const context = await resolveRepoContext({ ...deps, cwd: worktreePath });
	if ("code" in context) return undefined;
	const lane = await activeRegistrationAt(context.paths, containingCheckout ? context.topLevel : worktreePath);
	return lane ? { context, lane } : undefined;
}

async function activeRegistrationAt(paths: SyncStorePaths, checkout: string): Promise<LaneRegistration | undefined> {
	const wanted = canonical(checkout);
	const key = basename(wanted);
	const matches = (lane: LaneRegistration) => lane.status === "active" && canonical(lane.worktreePath) === wanted;
	// Created lanes use their key as the directory name. Reconciled worktrees may live at a custom path.
	const named = WORKTREE_LANE_KEY_PATTERN.test(key) ? await readLane(paths, key) : undefined;
	return named && matches(named) ? named : (await listLanes(paths)).find(matches);
}

/** A live lane in a linked checkout, including one parked under a previously configured worktree root. */
export async function registeredLinkedLane(directory: string): Promise<LaneRegistration | undefined> {
	const repo = findRepositoryGitPaths(directory);
	if (!repo?.commonDir || repo.gitDirs.length < 2) return undefined;
	return activeRegistrationAt(syncStorePaths(repo.commonDir), repo.root);
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
	args: { expectBoundLaneId: string | null },
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

/** The active lane whose registered worktree contains `directory`, resolved through its git checkout identity. */
export async function findLaneByDirectory(
	deps: WorktreeSyncEngineDeps,
	directory: string,
): Promise<LaneRegistration | undefined> {
	return (await resolveLaneAt(deps, directory, true))?.lane;
}

/**
 * The active lane whose registered worktree contains `directory`, with the checkout a session at `sessionCwd` moves its
 * paths into it from: the registration's `sourceCheckout`. A registration without one (written before it was recorded)
 * names no checkout, and the hub it was made from may have moved since or be checked out nowhere now: the session's own
 * checkout is read instead when it belongs to the lane's repository (the same git common dir), since the paths moved are
 * the session's; else the hub of the repository's current context. `checkout` is undefined when none is known; the lane
 * is still returned. Undefined when `directory` is in no lane.
 */
export async function findLaneCheckout(
	deps: WorktreeSyncEngineDeps,
	directory: string,
	sessionCwd: string,
): Promise<{ lane: LaneRegistration; checkout: string | undefined } | undefined> {
	const found = await resolveLaneAt(deps, directory, true);
	if (!found || found.lane.sourceCheckout) return found && { lane: found.lane, checkout: found.lane.sourceCheckout };
	const session = await resolveRepoContext({ ...deps, cwd: sessionCwd });
	const checkout = unrecordedSourceCheckout(
		found.context.gitCommonDir,
		"code" in session ? undefined : session,
		found.context.hubPath,
	);
	return { lane: found.lane, checkout };
}

/**
 * The checkout a session moves its paths into a lane from when the lane's registration names none: the session's own
 * checkout (`session.topLevel`) when it belongs to the lane's repository (`laneCommonDir`, the same git common dir), since
 * the paths moved are the session's; else `hub`, the repository's main checkout now (undefined when not known).
 */
function unrecordedSourceCheckout(
	laneCommonDir: string,
	session: { readonly gitCommonDir: string; readonly topLevel: string } | undefined,
	hub: string | undefined,
): string | undefined {
	return session && canonical(session.gitCommonDir) === canonical(laneCommonDir) ? session.topLevel : hub;
}

/** The lane a session's paths move into and the checkout they move from, or why that is not known (`unplaced`). */
export type LaneSourceRead = { readonly laneRoot: string; readonly checkout: string } | { readonly unplaced: string };

/**
 * The checkout the lane at `laneRoot` (a lane worktree's root, `laneWorktreeOf`) was made from, read synchronously from its
 * registration (`sourceCheckout`), with the registration's own worktree path: what `findLaneCheckout` reads, without git.
 * The registration is found through the worktree's `.git` pointer to the repository's common dir and the lane key the
 * layout names it by. A registration written before the checkout was recorded falls back as `findLaneCheckout` does
 * (`unrecordedSourceCheckout`): the checkout of a session at `sessionCwd` in the lane's repository; the hub, which only
 * git names, is not read here. `unplaced` says, in English, why no checkout is known: the git layout or the registration
 * does not read, the registration is not the active lane at `laneRoot`, or it names no checkout and the session works in
 * another repository.
 */
export function readLaneSource(laneRoot: string, sessionCwd: string): LaneSourceRead {
	const commonDir = findRepositoryGitPaths(laneRoot)?.commonDir;
	if (!commonDir) return { unplaced: "the lane's git directory does not read" };
	const lane = readLaneSync(syncStorePaths(commonDir), basename(laneRoot));
	if (!lane) return { unplaced: "the lane's registration is missing or does not read" };
	if (lane.status !== "active") return { unplaced: `the lane's registration is ${lane.status}` };
	if (canonical(lane.worktreePath) !== canonical(laneRoot))
		return { unplaced: "the lane's registration names another worktree" };
	if (lane.sourceCheckout) return { laneRoot: lane.worktreePath, checkout: lane.sourceCheckout };
	const session = findRepositoryGitPaths(sessionCwd);
	const checkout = unrecordedSourceCheckout(
		commonDir,
		session?.commonDir === undefined ? undefined : { gitCommonDir: session.commonDir, topLevel: session.root },
		undefined,
	);
	return checkout
		? { laneRoot: lane.worktreePath, checkout }
		: {
				unplaced:
					"the lane's registration was written before the checkout it was made from was recorded, and the session works outside the lane's repository (its main checkout is read only through git)",
			};
}

/** Whether `candidate` lies under the directory lane worktrees are created in (a cheap check, no git). */
export function isUnderLaneRoot(deps: WorktreeSyncEngineDeps, candidate: string): boolean {
	return isInside(deps.worktreesBaseDir, candidate) && canonical(candidate) !== canonical(deps.worktreesBaseDir);
}

/**
 * The lane worktree `candidate` lies in, by the layout lanes are created in (`<worktreesBaseDir>/<repository slug>/<lane
 * key>`, git-engine.ts `createLane`): a cheap check, no git. Undefined outside that layout.
 */
export function laneWorktreeOf(deps: WorktreeSyncEngineDeps, candidate: string): string | undefined {
	if (!isUnderLaneRoot(deps, candidate)) return undefined;
	const [slug, laneKey] = relative(canonical(deps.worktreesBaseDir), canonical(candidate)).split(sep);
	return slug && laneKey ? join(deps.worktreesBaseDir, slug, laneKey) : undefined;
}

/** Bind an unclaimed checkout, or transfer its binding from an expected source worker. */
export async function bindWorkerLaneByPath(
	deps: WorktreeSyncEngineDeps,
	directory: string,
	laneId: string,
	expectedSource?: string,
): Promise<{ laneKey: string; code: string; message?: string } | undefined> {
	const found = await resolveLaneAt(deps, directory, true);
	if (!found) return undefined;
	const bound = await bindRegisteredLaneWorker(
		found.context,
		deps,
		{ laneKey: found.lane.laneKey, laneId, expectedSource },
		found.lane.worktreePath,
	);
	return {
		laneKey: found.lane.laneKey,
		code: bound.code,
		...("message" in bound ? { message: bound.message } : {}),
		...(bound.code === "binding_conflict" ? { message: `bound to worker ${bound.boundLaneId}` } : {}),
	};
}

export interface WorkerLaneState {
	laneKey: string;
	branch: string;
	worktreePath: string;
	/** The worker the lane's registration is bound to: the one it was made for. Absent until that worker starts. */
	boundLaneId?: string;
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
		...(found.lane.boundLaneId ? { boundLaneId: found.lane.boundLaneId } : {}),
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
	return releaseLaneFromRepository(deps, found, { expectBoundLaneId: found.lane.boundLaneId ? laneId : null });
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
	const released = await releaseLaneFromRepository(deps, found, { expectBoundLaneId: null });
	return released.code === "lane_bound_elsewhere" ? { ...released, code: "lane_in_use" } : released;
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
