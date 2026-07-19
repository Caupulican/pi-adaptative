/**
 * Worktree-sync git engine: every git-touching operation of the subsystem, built on one injected
 * `exec` seam (the `improvement-loop.ts` pattern) so each function is unit-testable with a
 * scripted exec fake and integration-testable against real git.
 *
 * Doctrine (see docs/worktree-sync.md):
 * - Git is the single source of truth. Freshness ("is current main an ancestor of the lane
 *   tip?"), dirtiness, ahead/behind, and rebase-in-progress are RE-DERIVED per call -- the JSON
 *   store (`store.ts`) contributes identity/binding only and is rebuildable via {@link reconcile}.
 * - Policy refusals are RETURNED as tagged codes (`codes.ts`), never thrown; git's own stderr
 *   rides along as evidence, never as a branch condition.
 * - Nothing here deletes user work silently: releasing a lane with unlanded commits or dirty
 *   files requires the explicit discard confirmation, and reconcile only marks orphans.
 */

import { existsSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";
import { type ExecResult, execCommand } from "../exec.ts";
import {
	type CreateLaneResult,
	LANE_BRANCH_PREFIX,
	type LaneFacts,
	type LaneRegistration,
	type ReconcileResult,
	type ReleaseLaneResult,
	type WorktreeSyncRefusal,
} from "./codes.ts";
import {
	appendAuditEvent,
	defaultIsPidAlive,
	listLanes,
	readLane,
	readLockHolder,
	releaseIntegrationLock,
	repoSlug,
	type SyncStorePaths,
	syncStorePaths,
	writeLane,
} from "./store.ts";

export type WorktreeSyncExec = (
	command: string,
	args: string[],
	options: { cwd: string; timeout?: number; signal?: AbortSignal; maxBuffer?: number },
) => Promise<ExecResult>;

export interface WorktreeSyncEngineOptions {
	/** Overrides default-branch resolution; unset resolves local `main`, then `master` (D13). */
	mainBranchOverride?: string;
	/** Active-lane ceiling; `create_lane` refuses beyond it. */
	maxLanes: number;
}

export interface WorktreeSyncEngineDeps {
	exec: WorktreeSyncExec;
	/** Session cwd -- any directory inside the repo (hub checkout or a lane worktree). */
	cwd: string;
	/** Base for lane checkouts (`agent-paths.worktreesDir(agentDir)`); engine appends `<repo-slug>/<laneKey>`. */
	worktreesBaseDir: string;
	options: WorktreeSyncEngineOptions;
	signal?: AbortSignal;
	now?: () => string;
	pid?: number;
	sessionId?: string;
	/** Injectable fs probe for deterministic tests. Default: `existsSync`. */
	fileExists?: (path: string) => boolean;
	/** Injectable same-host pid liveness for deterministic tests. */
	isPidAlive?: (pid: number) => boolean;
}

export interface RepoContext {
	topLevel: string;
	gitCommonDir: string;
	mainBranch: string;
	mainSha: string;
	paths: SyncStorePaths;
	slug: string;
	/** Checkout where the main branch is checked out (the hub); undefined when main is not checked out. */
	hubPath?: string;
}

const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 1024 * 1024;
const LANE_KEY_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Production exec: `exec.ts`'s bounded `execCommand` (rolling-tail output, timeout, abort). */
export function createDefaultWorktreeSyncExec(): WorktreeSyncExec {
	return (command, args, options) =>
		execCommand(command, args, options.cwd, {
			timeout: options.timeout,
			signal: options.signal,
			maxBuffer: options.maxBuffer,
		});
}

function runGit(deps: WorktreeSyncEngineDeps, cwd: string, args: string[]): Promise<ExecResult> {
	return deps.exec("git", args, { cwd, timeout: GIT_TIMEOUT_MS, signal: deps.signal, maxBuffer: GIT_MAX_BUFFER });
}

function nowIso(deps: WorktreeSyncEngineDeps): string {
	return (deps.now ?? (() => new Date().toISOString()))();
}

function fileExists(deps: WorktreeSyncEngineDeps, path: string): boolean {
	return (deps.fileExists ?? existsSync)(path);
}

function gitError(message: string, result: ExecResult): WorktreeSyncRefusal<"git_error"> {
	return { code: "git_error", message, gitStderr: (result.stderr || result.stdout).trim().slice(0, 4000) };
}

export function laneBranch(laneKey: string): string {
	return `${LANE_BRANCH_PREFIX}${laneKey}`;
}

export interface WorktreeListEntry {
	path: string;
	headSha?: string;
	/** Full ref (`refs/heads/x`) when a branch is checked out; undefined for detached/bare. */
	branchRef?: string;
}

/** Parse `git worktree list --porcelain` blocks. */
export function parseWorktreeList(output: string): WorktreeListEntry[] {
	const entries: WorktreeListEntry[] = [];
	let current: WorktreeListEntry | undefined;
	for (const line of output.split(/\r?\n/)) {
		if (line.startsWith("worktree ")) {
			if (current) entries.push(current);
			current = { path: line.slice("worktree ".length) };
		} else if (line.startsWith("HEAD ") && current) {
			current.headSha = line.slice("HEAD ".length);
		} else if (line.startsWith("branch ") && current) {
			current.branchRef = line.slice("branch ".length);
		} else if (line.trim() === "" && current) {
			entries.push(current);
			current = undefined;
		}
	}
	if (current) entries.push(current);
	return entries;
}

async function revParseBranch(deps: WorktreeSyncEngineDeps, cwd: string, branch: string): Promise<string | undefined> {
	const result = await runGit(deps, cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
	if (result.code !== 0) return undefined;
	const sha = result.stdout.trim();
	return sha || undefined;
}

export async function resolveRepoContext(
	deps: WorktreeSyncEngineDeps,
): Promise<RepoContext | WorktreeSyncRefusal<"not_a_git_repo" | "default_branch_unresolved" | "git_error">> {
	const roots = await runGit(deps, deps.cwd, [
		"rev-parse",
		"--path-format=absolute",
		"--show-toplevel",
		"--git-common-dir",
	]);
	if (roots.code !== 0) {
		return {
			code: "not_a_git_repo",
			message: `worktree-sync requires a git repository; ${deps.cwd} is not inside one`,
			gitStderr: roots.stderr.trim().slice(0, 1000),
		};
	}
	const [topLevel, gitCommonDir] = roots.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (!topLevel || !gitCommonDir) {
		return gitError("git rev-parse returned no toplevel/common-dir", roots);
	}

	// D13: explicit resolution order -- override, `main`, `master`. Never guess further.
	const candidates = deps.options.mainBranchOverride ? [deps.options.mainBranchOverride] : ["main", "master"];
	let mainBranch: string | undefined;
	let mainSha: string | undefined;
	for (const candidate of candidates) {
		const sha = await revParseBranch(deps, topLevel, candidate);
		if (sha) {
			mainBranch = candidate;
			mainSha = sha;
			break;
		}
	}
	if (!mainBranch || !mainSha) {
		return {
			code: "default_branch_unresolved",
			message: deps.options.mainBranchOverride
				? `configured main branch '${deps.options.mainBranchOverride}' does not exist locally`
				: "no local 'main' or 'master' branch; set the worktree-sync main branch explicitly",
		};
	}

	const worktrees = await runGit(deps, topLevel, ["worktree", "list", "--porcelain"]);
	if (worktrees.code !== 0) return gitError("git worktree list failed", worktrees);
	const hub = parseWorktreeList(worktrees.stdout).find((entry) => entry.branchRef === `refs/heads/${mainBranch}`);

	return {
		topLevel,
		gitCommonDir,
		mainBranch,
		mainSha,
		paths: syncStorePaths(gitCommonDir),
		slug: repoSlug(topLevel, gitCommonDir),
		hubPath: hub?.path,
	};
}

/**
 * Live git facts for one lane. `fresh` is THE freshness definition of the whole subsystem
 * (G3/G9): current main is an ancestor of the lane tip. Everything is re-derived; nothing is
 * read back from a cache that could disagree with git.
 */
export async function deriveLaneFacts(
	deps: WorktreeSyncEngineDeps,
	ctx: RepoContext,
	lane: LaneRegistration,
): Promise<LaneFacts> {
	const branchSha = await revParseBranch(deps, ctx.topLevel, lane.branch);

	let fresh = false;
	let aheadOfMain = 0;
	let behindMain = 0;
	if (branchSha) {
		const ancestry = await runGit(deps, ctx.topLevel, ["merge-base", "--is-ancestor", ctx.mainSha, branchSha]);
		fresh = ancestry.code === 0;
		const counts = await runGit(deps, ctx.topLevel, [
			"rev-list",
			"--left-right",
			"--count",
			`${ctx.mainBranch}...${lane.branch}`,
		]);
		if (counts.code === 0) {
			const [left, right] = counts.stdout.trim().split(/\s+/);
			behindMain = Number.parseInt(left ?? "0", 10) || 0;
			aheadOfMain = Number.parseInt(right ?? "0", 10) || 0;
		}
	}

	let worktreePresent = fileExists(deps, lane.worktreePath);
	let dirty = false;
	let rebaseInProgress = false;
	if (worktreePresent) {
		const status = await runGit(deps, lane.worktreePath, ["status", "--porcelain"]);
		if (status.code === 0) {
			dirty = status.stdout.trim().length > 0;
			const gitPaths = await runGit(deps, lane.worktreePath, [
				"rev-parse",
				"--path-format=absolute",
				"--git-path",
				"rebase-merge",
				"--git-path",
				"rebase-apply",
			]);
			if (gitPaths.code === 0) {
				rebaseInProgress = gitPaths.stdout
					.split(/\r?\n/)
					.map((line) => line.trim())
					.filter(Boolean)
					.some((path) => fileExists(deps, path));
			}
		} else {
			// The directory exists but is not a usable worktree (e.g. pruned metadata): not present.
			worktreePresent = false;
		}
	}

	const isAlive =
		deps.isPidAlive ?? ((pid: number) => defaultIsPidAlive({ pid, hostname: osHostname(), acquiredAt: "" }));

	return {
		laneKey: lane.laneKey,
		branch: lane.branch,
		worktreePath: lane.worktreePath,
		registrationStatus: lane.status,
		branchSha,
		fresh,
		dirty,
		rebaseInProgress,
		aheadOfMain,
		behindMain,
		worktreePresent,
		...(lane.ownerPid !== undefined ? { ownerAlive: isAlive(lane.ownerPid) } : {}),
	};
}

/** One-time repo git config (D7): shared rerere + zdiff3 conflict hunks -- the deterministic
 * conflict-resolution substrate for every lane (the rr-cache lives in the common dir, so one
 * resolution replays identically in all worktrees). Idempotent; only actual changes are audited. */
export async function ensureRepoGitConfig(deps: WorktreeSyncEngineDeps, ctx: RepoContext): Promise<void> {
	const wanted: Array<[string, string]> = [
		["rerere.enabled", "true"],
		["rerere.autoUpdate", "true"],
		["merge.conflictStyle", "zdiff3"],
	];
	const changed: string[] = [];
	for (const [key, value] of wanted) {
		const current = await runGit(deps, ctx.topLevel, ["config", "--get", key]);
		if (current.code === 0 && current.stdout.trim() === value) continue;
		const set = await runGit(deps, ctx.topLevel, ["config", key, value]);
		if (set.code === 0) changed.push(`${key}=${value}`);
	}
	if (changed.length > 0) {
		await appendAuditEvent(ctx.paths, { event: "config_set", changed }, nowIso(deps));
	}
}

function sanitizeScope(scope: string): string {
	const cleaned = scope
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
	return cleaned || "adhoc";
}

export interface CreateLaneArgs {
	laneKey?: string;
	goalId?: string;
	requirementId?: string;
}

export async function createLane(deps: WorktreeSyncEngineDeps, args: CreateLaneArgs = {}): Promise<CreateLaneResult> {
	const ctx = await resolveRepoContext(deps);
	if ("code" in ctx) return ctx;

	if (args.laneKey !== undefined && !LANE_KEY_RE.test(args.laneKey)) {
		return {
			code: "invalid_lane_key",
			message: `laneKey '${args.laneKey}' is invalid: lowercase alphanumerics and inner dashes, max 63 chars`,
		};
	}

	const lanes = await listLanes(ctx.paths);
	const activeCount = lanes.filter((lane) => lane.status === "active").length;
	if (activeCount >= deps.options.maxLanes) {
		return {
			code: "max_lanes_reached",
			message: `active lane limit reached (${activeCount}/${deps.options.maxLanes}); release a lane first`,
		};
	}

	const taken = new Set(lanes.filter((lane) => lane.status !== "released").map((lane) => lane.laneKey));
	const isFree = async (candidate: string): Promise<boolean> => {
		if (taken.has(candidate)) return false;
		if (await revParseBranch(deps, ctx.topLevel, laneBranch(candidate))) return false;
		if (fileExists(deps, join(deps.worktreesBaseDir, ctx.slug, candidate))) return false;
		return true;
	};

	let laneKey: string;
	if (args.laneKey !== undefined) {
		if (!(await isFree(args.laneKey))) {
			return {
				code: "lane_exists",
				message: `lane '${args.laneKey}' already exists (registration, branch, or checkout)`,
			};
		}
		laneKey = args.laneKey;
	} else {
		// Deterministic allocation: lowest free `<scope>-<n>` (scope = goalId or "adhoc").
		const scope = sanitizeScope(args.goalId ?? "adhoc");
		let n = 1;
		while (!(await isFree(`${scope}-${n}`))) n++;
		laneKey = `${scope}-${n}`;
	}

	await ensureRepoGitConfig(deps, ctx);

	const branch = laneBranch(laneKey);
	const worktreePath = join(deps.worktreesBaseDir, ctx.slug, laneKey);
	const add = await runGit(deps, ctx.topLevel, ["worktree", "add", "-b", branch, worktreePath, ctx.mainBranch]);
	if (add.code !== 0) return gitError(`git worktree add failed for lane '${laneKey}'`, add);

	const at = nowIso(deps);
	const lane: LaneRegistration = {
		laneKey,
		branch,
		worktreePath,
		status: "active",
		createdAt: at,
		updatedAt: at,
		...(args.goalId !== undefined ? { goalId: args.goalId } : {}),
		...(args.requirementId !== undefined ? { requirementId: args.requirementId } : {}),
		ownerPid: deps.pid ?? process.pid,
		...(deps.sessionId !== undefined ? { ownerSessionId: deps.sessionId } : {}),
	};
	await writeLane(ctx.paths, lane);
	await appendAuditEvent(ctx.paths, { event: "lane_created", laneKey, branch, baseSha: ctx.mainSha }, at);
	return { code: "ok", lane };
}

export interface ReleaseLaneArgs {
	laneKey: string;
	/** Required as exactly "yes-discard-lane" to release a lane with unlanded commits or dirty files (G11). */
	confirm?: string;
}

export async function releaseLane(deps: WorktreeSyncEngineDeps, args: ReleaseLaneArgs): Promise<ReleaseLaneResult> {
	const ctx = await resolveRepoContext(deps);
	if ("code" in ctx) return ctx;

	const lane = await readLane(ctx.paths, args.laneKey);
	if (!lane) return { code: "lane_not_found", message: `no registered lane '${args.laneKey}'` };
	if (lane.status === "released") return { code: "released", laneKey: lane.laneKey };

	const facts = await deriveLaneFacts(deps, ctx, lane);
	let landed = true;
	if (facts.branchSha) {
		const ancestry = await runGit(deps, ctx.topLevel, ["merge-base", "--is-ancestor", facts.branchSha, ctx.mainSha]);
		landed = ancestry.code === 0;
	}
	const unlandedWork = (facts.branchSha !== undefined && !landed) || facts.dirty;
	const discardConfirmed = args.confirm === "yes-discard-lane";
	if (unlandedWork && !discardConfirmed) {
		return {
			code: "lane_unlanded_work",
			message:
				`lane '${lane.laneKey}' has ${facts.dirty ? "uncommitted changes" : ""}` +
				`${facts.dirty && !landed ? " and " : ""}${!landed ? `${facts.aheadOfMain} unlanded commit(s)` : ""}; ` +
				`land it first, or pass confirm:"yes-discard-lane" to discard`,
		};
	}

	if (facts.worktreePresent) {
		const removeArgs = ["worktree", "remove", ...(unlandedWork ? ["--force"] : []), lane.worktreePath];
		const remove = await runGit(deps, ctx.topLevel, removeArgs);
		if (remove.code !== 0) return gitError(`git worktree remove failed for lane '${lane.laneKey}'`, remove);
	}
	if (facts.branchSha) {
		const del = await runGit(deps, ctx.topLevel, ["branch", unlandedWork ? "-D" : "-d", lane.branch]);
		if (del.code !== 0) return gitError(`git branch delete failed for lane '${lane.laneKey}'`, del);
	}
	await runGit(deps, ctx.topLevel, ["worktree", "prune"]);

	const at = nowIso(deps);
	await writeLane(ctx.paths, { ...lane, status: "released", updatedAt: at });
	await appendAuditEvent(
		ctx.paths,
		{ event: "lane_released", laneKey: lane.laneKey, ...(unlandedWork ? { discarded: true } : {}) },
		at,
	);
	return { code: "released", laneKey: lane.laneKey };
}

/**
 * Startup/repair pass (mirrors the tmux session reconcile): diff the registry against git
 * reality, mark orphans (never delete -- G11), re-register lane worktrees git still knows that
 * the registry lost (a deleted store is fully rebuildable), self-heal orphan registrations whose
 * worktree+branch actually exist, clear dead owners, and release a provably-stale lock.
 */
export async function reconcile(deps: WorktreeSyncEngineDeps): Promise<ReconcileResult> {
	const ctx = await resolveRepoContext(deps);
	if ("code" in ctx) return ctx;

	const worktreesResult = await runGit(deps, ctx.topLevel, ["worktree", "list", "--porcelain"]);
	if (worktreesResult.code !== 0) return gitError("git worktree list failed", worktreesResult);
	const worktrees = parseWorktreeList(worktreesResult.stdout);

	const lanes = await listLanes(ctx.paths);
	const isAlive =
		deps.isPidAlive ?? ((pid: number) => defaultIsPidAlive({ pid, hostname: osHostname(), acquiredAt: "" }));
	const at = nowIso(deps);

	const orphanedLaneKeys: string[] = [];
	const reRegisteredLaneKeys: string[] = [];
	const ownerClearedLaneKeys: string[] = [];

	for (const lane of lanes) {
		if (lane.status === "released") continue;
		let next = lane;

		const branchSha = await revParseBranch(deps, ctx.topLevel, lane.branch);
		const present = branchSha !== undefined && fileExists(deps, lane.worktreePath);
		if (lane.status === "active" && !present) {
			next = { ...next, status: "orphaned", updatedAt: at };
			orphanedLaneKeys.push(lane.laneKey);
			await appendAuditEvent(ctx.paths, { event: "lane_orphaned", laneKey: lane.laneKey }, at);
		} else if (lane.status === "orphaned" && present) {
			// Self-heal: the checkout and branch are back (or never really left) -- active again.
			next = { ...next, status: "active", updatedAt: at };
			reRegisteredLaneKeys.push(lane.laneKey);
			await appendAuditEvent(ctx.paths, { event: "lane_reregistered", laneKey: lane.laneKey }, at);
		}

		if (next.ownerPid !== undefined && !isAlive(next.ownerPid)) {
			const { ownerPid: _pid, ownerSessionId: _session, ...rest } = next;
			next = { ...rest, updatedAt: at };
			ownerClearedLaneKeys.push(lane.laneKey);
		}

		if (next !== lane) await writeLane(ctx.paths, next);
	}

	// Lane worktrees git knows but the registry does not: rebuild identity from git facts.
	const registered = new Set(lanes.map((lane) => lane.laneKey));
	for (const entry of worktrees) {
		const ref = entry.branchRef;
		if (!ref?.startsWith(`refs/heads/${LANE_BRANCH_PREFIX}`)) continue;
		const laneKey = ref.slice(`refs/heads/${LANE_BRANCH_PREFIX}`.length);
		if (registered.has(laneKey) || !LANE_KEY_RE.test(laneKey)) continue;
		if (!fileExists(deps, entry.path)) continue;
		await writeLane(ctx.paths, {
			laneKey,
			branch: `${LANE_BRANCH_PREFIX}${laneKey}`,
			worktreePath: entry.path,
			status: "active",
			createdAt: at,
			updatedAt: at,
		});
		reRegisteredLaneKeys.push(laneKey);
		await appendAuditEvent(ctx.paths, { event: "lane_reregistered", laneKey }, at);
	}

	// Provably-stale integration lock: dead same-host owner (never a foreign or live one).
	let staleLockReleased = false;
	const holder = await readLockHolder(ctx.paths);
	if (holder && holder.hostname === osHostname() && !isAlive(holder.pid)) {
		await releaseIntegrationLock(ctx.paths, { now: deps.now });
		staleLockReleased = true;
	}

	await appendAuditEvent(
		ctx.paths,
		{
			event: "reconcile_summary",
			orphaned: orphanedLaneKeys,
			reRegistered: reRegisteredLaneKeys,
			ownersCleared: ownerClearedLaneKeys,
			staleLockReleased,
		},
		at,
	);
	return { code: "reconciled", orphanedLaneKeys, reRegisteredLaneKeys, ownerClearedLaneKeys, staleLockReleased };
}
