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
 * - land: the land gate takes the lane to main and returns what is still open (`worktree-sync/lane-landing.ts`).
 *
 * A lane belongs to the one worker its registration is bound to. A review of that worker's result runs in the same lane,
 * because the work is there and nowhere else until it lands, and owns nothing in it: bind leaves the lane with its worker,
 * the report names no lane for the review, and the review's retirement releases nothing.
 *
 * A requested lane (`create(cwd, "worktree")`) is made whether or not worktree-sync is on by default; the caller refuses a
 * requested start that gets none, and never runs it shared.
 *
 * Every step but release is best-effort and never fails the worker or the transition that triggered it. Release
 * returns its outcome and throws only when the lane may still be released by a retry (a git failure, an unavailable
 * checkout); its caller owns that retry.
 */

import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExecutionContext } from "../../kernel/index.ts";
import type { WorkerHostFinding } from "../autonomy/contracts.ts";
import { hostFinding } from "../autonomy/host-findings.ts";
import type {
	OrchestrationProfile,
	WorkerExecutionContract,
	WorkerProfileExecutionContract,
} from "../orchestration/contracts.ts";
import { parseWorkerExecutionContract } from "../orchestration/worker-execution-contract.ts";
import { quotedSpan } from "../util/bounded-line.ts";
import type { ReleaseOutcome } from "../util/resource-release.ts";
import type { AbortSyncResult, SyncLaneResult } from "../worktree-sync/codes.ts";
import {
	abortSync as abortLaneSync,
	landLane,
	syncLane as syncLaneEngine,
	type WorktreeSyncEngineDeps,
} from "../worktree-sync/git-engine.ts";
import { laneTipContained } from "../worktree-sync/lane-containment.ts";
import { type LaneLanding, landingOutcome } from "../worktree-sync/lane-landing.ts";
import {
	bindWorkerLaneByPath,
	boundLaneRepositoryKey,
	canonical,
	createWorkerLane,
	describeWorkerLane,
	discardUnusedWorkerLane,
	findLaneByDirectory,
	findLaneCheckout,
	isUnderLaneRoot,
	laneWorktreeOf,
	nativeRealPath,
	releaseWorkerLane,
	repositoryKeyAt,
	type WorkerLaneCreation,
} from "../worktree-sync/worker-lane.ts";
import type { ParentWriteOrigin } from "./parent-execution-context.ts";
import { sameWorkerApartFromPlace } from "./worker-authority-resolver.ts";
import type { WorkerDelegationRequest } from "./worker-delegation-request.ts";

export interface WorkerLaneIsolationDeps {
	/** Engine deps rooted at `cwd`; undefined only when no engine can be built. */
	engineDeps(cwd: string): WorktreeSyncEngineDeps | undefined;
	/** Whether a fresh writing worker gets a lane when its request does not ask for one (worktree-sync is enabled). */
	isolateByDefault(): boolean;
	/** Tell the parent session about a lane that was kept because it holds work, as a write of the worker's attempt. */
	notifyParent(text: string, origin?: ParentWriteOrigin): void;
	warn(message: string): void;
}

/** Reasons a worker stays in the shared checkout that are expected conditions of the checkout, not failures. */
const EXPECTED_SHARED_REASONS: ReadonlySet<string> = new Set([
	"not_a_git_repo",
	"not_on_main",
	"checkout_dirty",
	"dependencies_installed_in_checkout",
]);

/**
 * Binding answers that leave the lane with its owner: the worker now owns it, already did, or another worker does (the one
 * arriving reviews that worker's result there).
 */
const LANE_KEPT_BY_BIND: ReadonlySet<string> = new Set(["bound", "already_bound", "binding_conflict"]);

/** Lane release refusals a later retry may not meet. */
const RETRYABLE_LANE_RELEASE_CODES: ReadonlySet<string> = new Set([
	"git_error",
	"default_branch_unresolved",
	"repository_checkout_unavailable",
]);

/** Whether `target` is `base` or inside it, by path text (no filesystem access). */
function isWithin(base: string, target: string): boolean {
	const offset = relative(base, target);
	return offset === "" || (offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset));
}

/** Whether `target` is `base` or inside it by path text, or else by real path when both are resolvable. */
function placedWithin(base: string, target: string): boolean {
	if (isWithin(base, target)) return true;
	const [realBase, realTarget] = [nativeRealPath(base), nativeRealPath(target)];
	return realBase !== undefined && realTarget !== undefined && isWithin(realBase, realTarget);
}

/**
 * The path `entry` names inside the lane at `laneRoot` when it lies under `root`, the top of the checkout the lane was made
 * from: the same place in the lane. A relative `entry` is stated against `base` (`root` unless given). Places are compared
 * by path text first, then, when the text places it in neither, by real path (`nativeRealPath`), so a path spelled through a
 * symlink, or a Windows 8.3 short name (`RUNNER~1`), to the checkout or the lane keeps its place; a path whose real path is not resolvable keeps the text answer. A
 * path already inside the lane, or outside `root`, is returned unchanged. Every move of a worker into its lane uses this
 * one translation: a saved contract, a request's write paths, the grants derived from them and the parent's ceiling.
 */
export function relocatedInto(root: string, laneRoot: string, entry: string, base = root): string {
	const resolved = resolve(base, entry);
	if (isWithin(laneRoot, resolved)) return resolved;
	if (isWithin(root, resolved)) return resolve(laneRoot, relative(root, resolved));
	if (placedWithin(laneRoot, resolved)) return resolved;
	const [top, real] = [nativeRealPath(root), nativeRealPath(resolved)];
	return top !== undefined && real !== undefined && isWithin(top, real)
		? resolve(laneRoot, relative(top, real))
		: entry;
}

/** Where a worker is placed in a lane (`WorkerLaneIsolation.placementAt`). */
export interface WorkerLanePlacementAt {
	readonly laneRoot: string;
	/** The top of the checkout the lane was made from: the root request and contract paths are moved from. */
	readonly checkout: string;
	/** The directory the worker works in: the session directory's place in the lane. */
	readonly directory: string;
}

/** The lane directory's engine deps and lane key; undefined when `cwd` is not a lane. */
interface LaneAt {
	readonly engine: WorktreeSyncEngineDeps;
	readonly laneKey: string;
	readonly worktreePath: string;
}

/**
 * Where a worker started from `sessionCwd` is placed in the lane at `laneRoot` made from `checkout`: the session's place
 * relative to the checkout's top, as `relocatedInto` moves a path (a session in repo/sub works in lane/sub). A session at
 * the checkout's top, or outside it, works at the lane's root.
 */
function placementIn(laneRoot: string, checkout: string, sessionCwd: string): WorkerLanePlacementAt {
	const moved = relocatedInto(checkout, laneRoot, sessionCwd);
	return { laneRoot, checkout, directory: moved === sessionCwd ? laneRoot : moved };
}

export class WorkerLaneIsolation {
	private readonly deps: WorkerLaneIsolationDeps;
	/**
	 * The checkout each lane placed in this process moves the session's paths from, by the lane's real root read while
	 * the lane exists (`sourceKey`): what `laneOf` places a parent's ceiling by, from the resolution that placed the worker
	 * (`placementAt`). A placement that resolves no checkout removes the entry, and so does the lane's discard or release.
	 */
	private readonly laneSources = new Map<string, { readonly laneRoot: string; readonly checkout: string }>();

	constructor(deps: WorkerLaneIsolationDeps) {
		this.deps = deps;
	}

	/**
	 * A lane for a fresh writing worker whose task directory is `cwd`. Without a `requested` lane it is made only when
	 * worktree-sync is on by default. When no lane is made the answer says why, in words the caller can pass on: a worker
	 * that did not ask for a lane stays in the shared checkout, and a start that asked for one is refused with the reason.
	 * An unexpected reason (a git error, the lane ceiling) is warned.
	 */
	async create(cwd: string, requested?: "worktree"): Promise<WorkerLaneCreation> {
		if (requested !== "worktree" && !this.deps.isolateByDefault())
			return { kind: "shared", reason: "isolation_off", message: "worktree lanes are off for workers here" };
		const engine = this.deps.engineDeps(cwd);
		if (!engine)
			return { kind: "shared", reason: "no_engine", message: "worktree lanes are not available in this session" };
		let created: WorkerLaneCreation;
		try {
			created = await createWorkerLane(engine, `worker:${randomUUID()}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.deps.warn(`Worker lane isolation unavailable: ${message}`);
			return { kind: "shared", reason: "git_error", message };
		}
		if (created.kind === "isolated") return created;
		if (!EXPECTED_SHARED_REASONS.has(created.reason)) {
			this.deps.warn(
				`Worker lane isolation unavailable [${created.reason}]: ${created.message}. The worker runs in the shared checkout.`,
			);
		}
		return created;
	}

	/**
	 * Remove the lane at `worktreePath` when no worker ever used it (the worker could not be moved into it, or its
	 * start was refused), so a failed start leaves no lane behind. A lane bound to a worker is never removed here.
	 */
	async discard(worktreePath: string): Promise<void> {
		const engine = this.deps.engineDeps(worktreePath);
		if (!engine || !isUnderLaneRoot(engine, worktreePath)) return;
		try {
			const key = this.sourceKey(engine, worktreePath);
			const root = await this.laneRootAt(worktreePath);
			if (!root) return;
			const discarded = await discardUnusedWorkerLane(engine, root);
			if (key && (discarded.code === "released" || discarded.code === "lane_not_found"))
				this.laneSources.delete(key);
			if (discarded.code !== "released" && discarded.code !== "lane_not_found" && discarded.code !== "lane_in_use") {
				this.deps.warn(
					`Unused worker lane '${discarded.laneKey ?? worktreePath}' was not removed: [${discarded.code}] ${discarded.message ?? ""}`,
				);
			}
		} catch (error) {
			this.deps.warn(`Unused worker lane removal failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Lands the lane at `cwd` through the land gate (its gate per the owner's settings) and returns what is still open.
	 * `undefined` when `cwd` is no lane. Engine errors propagate to the caller.
	 */
	async land(
		cwd: string,
		gate: { readonly mode: "on" | "off"; readonly command?: string },
	): Promise<LaneLanding | undefined> {
		const found = await this.laneAt(cwd);
		if (!found) return undefined;
		const result = await landLane(found.engine, {
			laneKey: found.laneKey,
			gate: gate.mode,
			...(gate.command ? { gateCommand: gate.command } : {}),
		});
		return landingOutcome(found.laneKey, result);
	}

	/**
	 * Rebases main into the lane at `cwd` (the engine's sync). A conflict leaves the rebase in progress: `abortSync` returns the
	 * lane to its tip before the sync. `undefined` when `cwd` is no lane.
	 */
	async sync(cwd: string): Promise<SyncLaneResult | undefined> {
		const found = await this.laneAt(cwd);
		return found ? syncLaneEngine(found.engine, { laneKey: found.laneKey }) : undefined;
	}

	/** Aborts the sync in progress in the lane at `cwd`. `undefined` when `cwd` is no lane. */
	async abortSync(cwd: string): Promise<AbortSyncResult | undefined> {
		const found = await this.laneAt(cwd);
		return found ? abortLaneSync(found.engine, { laneKey: found.laneKey }) : undefined;
	}

	/**
	 * Whether the lane at `cwd` has its tip in main, or in the lane at `into` when given. Read-only. A tip main contains has
	 * landed; `undefined` when `cwd` (or `into`) is no lane. Only a lane the land gate reported stale is asked this: a clean
	 * lane with no commits also has its tip in main, and that does not mean it has landed anything.
	 */
	async tipContained(cwd: string, into?: string): Promise<boolean | undefined> {
		const found = await this.laneAt(cwd);
		if (!found) return undefined;
		let intoLaneKey: string | undefined;
		if (into !== undefined) {
			const other = await this.laneAt(into);
			if (!other) return undefined;
			intoLaneKey = other.laneKey;
		}
		return laneTipContained(found.engine, {
			laneKey: found.laneKey,
			...(intoLaneKey !== undefined ? { intoLaneKey } : {}),
		});
	}

	/** Whether `directory` is the lane's worktree or inside it. */
	isInsideLane(worktreePath: string, directory: string): boolean {
		return isWithin(worktreePath, directory);
	}

	/**
	 * Whether the admission redone for the lane compiled the worker the first admission chose: the lane changes where the
	 * worker works and nothing else about it.
	 */
	carriesSameWorker(shared: OrchestrationProfile, inLane: OrchestrationProfile): boolean {
		return sameWorkerApartFromPlace(shared, inLane);
	}

	/** The key of the lane at `cwd`; undefined when `cwd` is not a lane. */
	async laneKeyAt(cwd: string): Promise<string | undefined> {
		return (await this.laneAt(cwd))?.laneKey;
	}

	/** The engine deps and key of the lane at `cwd`; undefined when `cwd` is not a lane. */
	private async laneAt(cwd: string): Promise<LaneAt | undefined> {
		const engine = this.deps.engineDeps(cwd);
		if (!engine || !isUnderLaneRoot(engine, cwd)) return undefined;
		const lane = await findLaneByDirectory(engine, cwd);
		return lane ? { engine, laneKey: lane.laneKey, worktreePath: lane.worktreePath } : undefined;
	}

	/** The key of the lane `directory` lies in among `laneSources`: its real root, read while the lane exists. */
	private sourceKey(engine: WorktreeSyncEngineDeps, directory: string): string | undefined {
		const laneRoot = laneWorktreeOf(engine, directory);
		return laneRoot && canonical(laneRoot);
	}

	/**
	 * Where a worker started from `sessionCwd` is placed in the lane `directory` lies in (`placementIn`), from the lane's
	 * registration: its root and the checkout the session's paths move from (`findLaneCheckout`). Undefined when
	 * `directory` is in no lane or no checkout is known: the worker is then not moved into the lane.
	 */
	async placementAt(directory: string, sessionCwd: string): Promise<WorkerLanePlacementAt | undefined> {
		const engine = this.deps.engineDeps(directory);
		const key = engine && isUnderLaneRoot(engine, directory) ? this.sourceKey(engine, directory) : undefined;
		if (!engine || !key) return undefined;
		const found = await findLaneCheckout(engine, directory, sessionCwd);
		if (!found?.checkout) {
			this.laneSources.delete(key);
			return undefined;
		}
		this.laneSources.set(key, { laneRoot: found.lane.worktreePath, checkout: found.checkout });
		return placementIn(found.lane.worktreePath, found.checkout, sessionCwd);
	}

	/**
	 * A request moved into the lane `laneDirectory` lies in (`placementAt`): its execution context, at the session
	 * directory's place in the lane (at `laneDirectory` itself when `keepDirectory`, a prior worker's own directory), and its
	 * paths relocated relative to the checkout's top (`relocateRequest`). Throws when the lane or its checkout cannot be
	 * resolved: the request is then not moved, and its caller keeps the shared checkout or refuses the start.
	 */
	async placeRequest(
		request: Pick<WorkerDelegationRequest, "authority" | "savedIntent">,
		sessionCwd: string,
		laneDirectory: string,
		contextFor: (directory: string) => Promise<ExecutionContext>,
		keepDirectory = false,
	): Promise<Pick<WorkerDelegationRequest, "authority" | "savedIntent" | "executionContext">> {
		const placed = await this.placementAt(laneDirectory, sessionCwd);
		if (!placed) throw new Error("the lane, or the checkout it was made from, cannot be resolved");
		const executionContext = await contextFor(keepDirectory ? laneDirectory : placed.directory);
		const moved = this.relocateRequest(request, placed.checkout, executionContext, placed.laneRoot, sessionCwd);
		return { executionContext, ...moved };
	}

	/** The authoritative lane root for a directory in that lane; undefined when the registration cannot be resolved. */
	async laneRootAt(cwd: string): Promise<string | undefined> {
		return (await this.laneAt(cwd))?.worktreePath;
	}

	/**
	 * The mover of the session's paths into the lane `directory` lies in, which places a worker's parent ceiling: from the
	 * checkout `placementAt` resolved when it placed the worker (`relocatedInto`, a path keeps its
	 * place relative to the checkout's top); none to make for a session working in that lane itself. Synchronous, no git.
	 * Undefined when `directory` is in no lane; "unplaced" when this process has not resolved the lane's checkout (a worker
	 * admitted again after a restart before its lane was read).
	 */
	laneOf(directory: string, sessionCwd: string): ((entry: string) => string) | "unplaced" | undefined {
		const engine = this.deps.engineDeps(directory);
		const laneRoot = engine && laneWorktreeOf(engine, directory);
		if (!engine || !laneRoot) return undefined;
		if (placedWithin(laneRoot, sessionCwd)) return (entry) => entry;
		const key = this.sourceKey(engine, directory);
		const source = key ? this.laneSources.get(key) : undefined;
		return source ? (entry) => relocatedInto(source.checkout, source.laneRoot, entry) : "unplaced";
	}

	/** Whether `directory` lies in the area lane worktrees are created in (a cheap check, no git). */
	isLaneDirectory(directory: string): boolean {
		const engine = this.deps.engineDeps(directory);
		return engine !== undefined && isUnderLaneRoot(engine, directory);
	}

	/**
	 * A request's workspace path, granted write paths and saved intent, moved into the lane `context` names. Every path keeps
	 * its place relative to `root`, the top of the checkout the lane was made from (`placementAt`), so a path under the
	 * session's subdirectory lands under the same subdirectory of the lane. A relative request path is stated against `base`,
	 * the session directory the request resolves it from (`root` unless given); a saved contract's against its own directory.
	 * `laneRoot` stays the same even when `context.cwd` is a nested workspace inside the lane. Returns only the fields the
	 * request carries, so a caller spreads it over the request.
	 */
	relocateRequest(
		request: Pick<WorkerDelegationRequest, "authority" | "savedIntent">,
		root: string,
		context: ExecutionContext,
		laneRoot = context.cwd,
		base = root,
	): Pick<WorkerDelegationRequest, "authority" | "savedIntent"> {
		const path = request.authority?.path;
		const writePaths = request.authority?.writePaths;
		return {
			...(request.authority && (path !== undefined || writePaths !== undefined)
				? {
						authority: {
							...request.authority,
							...(path !== undefined ? { path: relocatedInto(root, laneRoot, path, base) } : {}),
							...(writePaths !== undefined
								? { writePaths: writePaths.map((entry) => relocatedInto(root, laneRoot, entry, base)) }
								: {}),
						},
					}
				: {}),
			...(request.savedIntent
				? {
						savedIntent: {
							...request.savedIntent,
							executionContract: this.relocateContract(
								request.savedIntent.executionContract,
								context,
								root,
								laneRoot,
							),
						},
					}
				: {}),
		};
	}

	/**
	 * Translate an admitted workspace into the lane the host created for it, preserving all other grants: each path keeps
	 * its place relative to `root`, the top of the checkout the lane at `laneRoot` was made from.
	 */
	relocateContract(
		contract: WorkerExecutionContract,
		context: ExecutionContext,
		root: string,
		laneRoot: string,
	): WorkerExecutionContract {
		const original = contract.worker.authority.cwd;
		if (!original || !this.isLaneDirectory(context.cwd))
			throw new Error("Worker lane relocation lacks a managed destination.");
		const translate = (entry: string): string => relocatedInto(root, laneRoot, entry, original);
		const move = (profile: WorkerProfileExecutionContract): WorkerProfileExecutionContract => {
			const cwd = profile.authority.cwd;
			if (!cwd || translate(cwd) === cwd) return profile;
			return {
				...profile,
				profile: {
					...profile.profile,
					workspacePath: translate(cwd),
					...(profile.profile.writePaths ? { writePaths: profile.profile.writePaths.map(translate) } : {}),
				},
				authority: {
					...profile.authority,
					cwd: translate(cwd),
					readPaths: profile.authority.readPaths.map(translate),
					writePaths: profile.authority.writePaths.map(translate),
					deniedPaths: [
						...new Set([...profile.authority.deniedPaths, ...profile.authority.deniedPaths.map(translate)]),
					],
				},
				executionContext: { ...context, cwd: translate(cwd) },
			};
		};
		return parseWorkerExecutionContract({
			...contract,
			worker: move(contract.worker),
			...(contract.verifier ? { verifier: move(contract.verifier) } : {}),
		});
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
			const laneRoot = await this.laneRootAt(directory);
			return laneRoot ? await boundLaneRepositoryKey(engine, laneRoot, agentId) : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Record `agentId` as the owner of the lane at `cwd`, when `cwd` is a lane no worker owns yet. A lane bound to another
	 * worker stays that worker's: the one arriving reviews the work in it and takes nothing over.
	 */
	async bind(cwd: string, agentId: string): Promise<void> {
		const engine = this.deps.engineDeps(cwd);
		if (!engine || !isUnderLaneRoot(engine, cwd)) return;
		try {
			const laneRoot = await this.laneRootAt(cwd);
			if (!laneRoot) return;
			const bound = await bindWorkerLaneByPath(engine, laneRoot, agentId);
			if (bound && !LANE_KEPT_BY_BIND.has(bound.code)) {
				this.deps.warn(`Worker ${agentId}'s worktree lane '${bound.laneKey}' could not be bound: [${bound.code}].`);
			}
		} catch (error) {
			this.deps.warn(`Worker lane bind failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * The claim finding for worker `agentId` when it worked in its lane and left changes there; `undefined` when `cwd` is
	 * not a lane, the lane holds nothing, or the lane is another worker's (the changes in it are that worker's, and its own
	 * claim names them). Bounded to fit a claim blocker.
	 */
	async claimFinding(cwd: string, agentId: string): Promise<WorkerHostFinding | undefined> {
		const engine = this.deps.engineDeps(cwd);
		if (!engine || !isUnderLaneRoot(engine, cwd)) return undefined;
		try {
			const laneRoot = await this.laneRootAt(cwd);
			if (!laneRoot) return undefined;
			const state = await describeWorkerLane(engine, laneRoot);
			if (!state || (state.boundLaneId !== undefined && state.boundLaneId !== agentId)) return undefined;
			if (!state.facts.dirty && state.facts.aheadOfMain === 0) return undefined;
			const holds = [
				...(state.facts.dirty ? ["uncommitted changes"] : []),
				...(state.facts.aheadOfMain > 0 ? [`${state.facts.aheadOfMain} commit(s) ahead of main`] : []),
			].join(" and ");
			const text = `this worker worked in its own worktree lane '${state.laneKey}' (${quotedSpan(state.worktreePath)}, branch ${state.branch}), not the shared checkout; its changes are there: ${holds}. Review with worktree_sync git_diff laneKey=${state.laneKey}; integrate with git_add and git_commit (laneKey), sync, then land; release_lane when done.`;
			// Never cut inside the quoted lane key or the quoted lane path; the kept tail starts at a path separator when one
			// is in reach.
			return hostFinding("lane", text);
		} catch (error) {
			this.deps.warn(`Worker lane report failed: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	/**
	 * The worker `agentId` was retired: release the lane at `cwd` if (and only if) nothing would be lost. A lane that
	 * is gone (or none) is released. A lane holding work is kept for the parent, who is told (abandoned to its
	 * `release_lane`). A lane bound to another worker is that worker's and is superseded here without a word: `agentId`
	 * reviewed the work in it, or its own lane is long gone and the directory holds a later one. A lane owned by another live
	 * session is superseded and warned. Anything else (a git error, an unavailable checkout, a throw) rejects, so the caller
	 * retains and retries the release.
	 */
	async release(cwd: string, agentId: string, attemptId: string): Promise<ReleaseOutcome> {
		const engine = this.deps.engineDeps(cwd);
		if (!engine || !isUnderLaneRoot(engine, cwd)) return { kind: "released" };
		const key = this.sourceKey(engine, cwd);
		const laneRoot = await this.laneRootAt(cwd);
		const released = laneRoot ? await releaseWorkerLane(engine, laneRoot, agentId) : undefined;
		if (!released || released.code === "released" || released.code === "lane_not_found") {
			if (key) this.laneSources.delete(key);
			return { kind: "released" };
		}
		if (released.code === "lane_unlanded_work") {
			const cause = released.message ?? "it holds work";
			this.deps.notifyParent(
				`Worker ${agentId} was retired and its worktree lane '${released.laneKey}' was kept: ${cause}`,
				{ attemptId },
			);
			return {
				kind: "abandoned",
				cause,
				reaper: `the parent's worktree_sync release_lane laneKey=${released.laneKey}`,
			};
		}
		const detail = `Retired worker ${agentId}'s worktree lane '${released.laneKey}' was not released: [${released.code}]${released.message ? ` ${released.message}` : ""}`;
		if (released.code === "lane_bound_elsewhere") return { kind: "superseded", detail };
		if (released.code === "lane_owner_conflict") {
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
