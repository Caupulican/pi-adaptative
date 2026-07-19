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

import { existsSync, readFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";
import { type ExecResult, execCommand } from "../exec.ts";
import {
	type AbortSyncResult,
	type ConflictWorklist,
	type ConflictWorklistFile,
	type ContinueSyncResult,
	type CreateLaneResult,
	EPOCH_CHANGED_PATHS_CAP,
	LANE_BRANCH_PREFIX,
	type LandResult,
	type LaneFacts,
	type LaneRegistration,
	type LaneStatusEntry,
	type ReconcileResult,
	type ReleaseLaneResult,
	type SyncLaneResult,
	type SyncStatusResult,
	type WorktreeSyncPolicy,
	type WorktreeSyncRefusal,
} from "./codes.ts";
import {
	acquireIntegrationLock,
	appendAuditEvent,
	defaultIsPidAlive,
	listLanes,
	readEpoch,
	readLane,
	readLockHolder,
	releaseIntegrationLock,
	repoSlug,
	type SyncStorePaths,
	syncStorePaths,
	writeEpoch,
	writeLane,
} from "./store.ts";

export type WorktreeSyncExec = (
	command: string,
	args: string[],
	options: { cwd: string; timeout?: number; signal?: AbortSignal; maxBuffer?: number; env?: NodeJS.ProcessEnv },
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
	/** Injectable file reader (conflict-marker scan, rebase progress). Default: `readFileSync`,
	 * returning undefined on any read error. */
	readFile?: (path: string) => string | undefined;
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
			env: options.env,
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
			rebaseInProgress = await isRebaseActive(deps, lane.worktreePath);
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

/** Lane worktrees git knows about that the registry does not (yet) track: a valid `pi/wt/<key>`
 * branch, key not already registered, checkout still present. One derivation shared by the
 * write-free no-op guard below and the re-registration pass, rather than two copies of the same
 * filter. */
function findUnregisteredLaneWorktrees(
	deps: WorktreeSyncEngineDeps,
	worktrees: WorktreeListEntry[],
	registered: Set<string>,
): Array<{ laneKey: string; path: string }> {
	const found: Array<{ laneKey: string; path: string }> = [];
	for (const entry of worktrees) {
		const ref = entry.branchRef;
		if (!ref?.startsWith(`refs/heads/${LANE_BRANCH_PREFIX}`)) continue;
		const laneKey = ref.slice(`refs/heads/${LANE_BRANCH_PREFIX}`.length);
		if (registered.has(laneKey) || !LANE_KEY_RE.test(laneKey)) continue;
		if (!fileExists(deps, entry.path)) continue;
		found.push({ laneKey, path: entry.path });
	}
	return found;
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
	const registered = new Set(lanes.map((lane) => lane.laneKey));
	const unregisteredWorktrees = findUnregisteredLaneWorktrees(deps, worktrees, registered);

	// Write-free fast path: worktree-sync now starts in every session, so a mere session open in a
	// git repo must never create `<git-common-dir>/pi-worktree-sync/`. When the store does not exist
	// yet and git shows nothing to recover, there is genuinely nothing to reconcile -- one early
	// determination, then skip every write below (writeLane/appendAuditEvent/releaseIntegrationLock)
	// rather than guarding each call individually. Once the store exists, or findings occur, behavior
	// is unchanged below (including the reconcile_summary audit append).
	if (!fileExists(deps, ctx.paths.root) && unregisteredWorktrees.length === 0) {
		return {
			code: "reconciled",
			orphanedLaneKeys: [],
			reRegisteredLaneKeys: [],
			ownerClearedLaneKeys: [],
			staleLockReleased: false,
		};
	}

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
	for (const { laneKey, path } of unregisteredWorktrees) {
		await writeLane(ctx.paths, {
			laneKey,
			branch: `${LANE_BRANCH_PREFIX}${laneKey}`,
			worktreePath: path,
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

/** Rebase env for every rebase-driving call: never let git open an editor mid-automation. */
function rebaseEnv(): NodeJS.ProcessEnv {
	return { ...process.env, GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" };
}

function runGitEnv(deps: WorktreeSyncEngineDeps, cwd: string, args: string[]): Promise<ExecResult> {
	return deps.exec("git", args, {
		cwd,
		timeout: GIT_TIMEOUT_MS,
		signal: deps.signal,
		maxBuffer: GIT_MAX_BUFFER,
		env: rebaseEnv(),
	});
}

function readFileMaybe(deps: WorktreeSyncEngineDeps, path: string): string | undefined {
	if (deps.readFile) return deps.readFile(path);
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return undefined;
	}
}

/** A rebase is in progress iff the worktree's rebase-merge or rebase-apply state dir exists. */
async function isRebaseActive(deps: WorktreeSyncEngineDeps, worktreePath: string): Promise<boolean> {
	const gitPaths = await runGit(deps, worktreePath, [
		"rev-parse",
		"--path-format=absolute",
		"--git-path",
		"rebase-merge",
		"--git-path",
		"rebase-apply",
	]);
	if (gitPaths.code !== 0) return false;
	return gitPaths.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.some((path) => fileExists(deps, path));
}

/** Paths with local modifications (`status --porcelain`), rename targets included. Capped. */
async function dirtyPaths(deps: WorktreeSyncEngineDeps, worktreePath: string): Promise<string[]> {
	const status = await runGit(deps, worktreePath, ["status", "--porcelain"]);
	if (status.code !== 0) return [];
	return status.stdout
		.split(/\r?\n/)
		.filter((line) => line.length > 3)
		.map((line) => {
			const path = line.slice(3);
			const renameArrow = path.indexOf(" -> ");
			return renameArrow >= 0 ? path.slice(renameArrow + 4) : path;
		})
		.slice(0, 100);
}

async function unmergedFiles(deps: WorktreeSyncEngineDeps, worktreePath: string): Promise<string[]> {
	const diff = await runGit(deps, worktreePath, ["diff", "--name-only", "--diff-filter=U"]);
	if (diff.code !== 0) return [];
	return diff.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

/** Conflict kind per path from `git ls-files -u` index stages (1=base, 2=ours, 3=theirs). */
async function unmergedKinds(
	deps: WorktreeSyncEngineDeps,
	worktreePath: string,
): Promise<Map<string, ConflictWorklistFile["kind"]>> {
	const lsFiles = await runGit(deps, worktreePath, ["ls-files", "-u"]);
	const stagesByPath = new Map<string, Set<string>>();
	if (lsFiles.code === 0) {
		for (const line of lsFiles.stdout.split(/\r?\n/)) {
			const match = line.match(/^\d+ [0-9a-f]+ ([123])\t(.+)$/);
			if (!match?.[1] || !match[2]) continue;
			const stages = stagesByPath.get(match[2]) ?? new Set<string>();
			stages.add(match[1]);
			stagesByPath.set(match[2], stages);
		}
	}
	const kinds = new Map<string, ConflictWorklistFile["kind"]>();
	for (const [path, stages] of stagesByPath) {
		const has = (stage: string) => stages.has(stage);
		if (has("1") && has("2") && has("3")) kinds.set(path, "both_modified");
		else if (!has("1") && has("2") && has("3")) kinds.set(path, "both_added");
		else if (has("1") && !has("2") && has("3")) kinds.set(path, "deleted_by_us");
		else if (has("1") && has("2") && !has("3")) kinds.set(path, "deleted_by_them");
		else kinds.set(path, "unknown");
	}
	return kinds;
}

/** Rebase progress ("<done>/<total>") plus the commit the rebase stopped at, from the rebase
 * state files (merge backend: msgnum/end/stopped-sha; apply backend: next/last). */
async function rebaseProgress(
	deps: WorktreeSyncEngineDeps,
	worktreePath: string,
): Promise<{ step: string; stoppedAtCommit?: { sha: string; subject: string } }> {
	const gitPaths = await runGit(deps, worktreePath, [
		"rev-parse",
		"--path-format=absolute",
		"--git-path",
		"rebase-merge",
		"--git-path",
		"rebase-apply",
	]);
	let step = "?";
	let stoppedSha: string | undefined;
	if (gitPaths.code === 0) {
		const [mergeDir, applyDir] = gitPaths.stdout
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
		const readCounter = (dir: string | undefined, doneName: string, totalName: string): string | undefined => {
			if (!dir) return undefined;
			const done = readFileMaybe(deps, join(dir, doneName))?.trim();
			const total = readFileMaybe(deps, join(dir, totalName))?.trim();
			return done && total ? `${done}/${total}` : undefined;
		};
		step = readCounter(mergeDir, "msgnum", "end") ?? readCounter(applyDir, "next", "last") ?? "?";
		stoppedSha = mergeDir ? readFileMaybe(deps, join(mergeDir, "stopped-sha"))?.trim() : undefined;
	}
	if (!stoppedSha) return { step };
	const subject = await runGit(deps, worktreePath, ["log", "-1", "--format=%s", stoppedSha]);
	return {
		step,
		stoppedAtCommit: { sha: stoppedSha, subject: subject.code === 0 ? subject.stdout.trim() : "" },
	};
}

/**
 * Build the structured conflict worklist (G9's input): the agent edits exactly these files, then
 * calls `continue` -- staging, marker verification, and rebase continuation are harness work.
 * Files rerere auto-resolved never appear here (they are staged, not unmerged) -- the mechanical
 * drive loop below continues past fully-replayed stops without involving the agent at all, so
 * `resolvedByRerere` marks nothing today and is reserved for partial-replay surfacing.
 */
async function buildWorklist(
	deps: WorktreeSyncEngineDeps,
	worktreePath: string,
	unmerged: string[],
): Promise<ConflictWorklist> {
	const kinds = await unmergedKinds(deps, worktreePath);
	const progress = await rebaseProgress(deps, worktreePath);
	return {
		step: progress.step,
		...(progress.stoppedAtCommit ? { stoppedAtCommit: progress.stoppedAtCommit } : {}),
		files: unmerged.map((path) => ({
			path,
			kind: kinds.get(path) ?? "unknown",
			resolvedByRerere: false,
		})),
	};
}

const CONFLICT_MARKER_RE = /^(?:<{7}|={7}|>{7}|\|{7})/m;

/**
 * Mechanically drive an in-progress rebase forward: finish it, stop at the next REAL conflict
 * (returning its worklist), auto-continue stops that rerere fully replayed, and skip steps that
 * provably reduced to nothing (their changes already landed). Bounded; never guesses -- an
 * unrecognized stop state surfaces as git_error with the evidence.
 */
async function driveRebase(
	deps: WorktreeSyncEngineDeps,
	ctx: RepoContext,
	lane: LaneRegistration,
): Promise<
	| { code: "sync_clean"; laneKey: string; autoContinued: number }
	| { code: "sync_conflicts"; laneKey: string; worklist: ConflictWorklist }
	| WorktreeSyncRefusal<"git_error">
> {
	const worktreePath = lane.worktreePath;
	let autoContinued = 0;
	for (let iteration = 0; iteration <= 1000; iteration++) {
		if (!(await isRebaseActive(deps, worktreePath))) {
			await appendAuditEvent(
				ctx.paths,
				{ event: "sync_completed", laneKey: lane.laneKey, autoContinued },
				nowIso(deps),
			);
			return { code: "sync_clean", laneKey: lane.laneKey, autoContinued };
		}
		const unmerged = await unmergedFiles(deps, worktreePath);
		if (unmerged.length > 0) {
			const worklist = await buildWorklist(deps, worktreePath, unmerged);
			await appendAuditEvent(
				ctx.paths,
				{ event: "sync_conflicts", laneKey: lane.laneKey, step: worklist.step, files: worklist.files.length },
				nowIso(deps),
			);
			return { code: "sync_conflicts", laneKey: lane.laneKey, worklist };
		}
		// Stopped with nothing unmerged: rerere fully replayed the resolution (auto-staged via
		// rerere.autoUpdate) or the step reduced to nothing. Continue mechanically.
		const cont = await runGitEnv(deps, worktreePath, ["rebase", "--continue"]);
		autoContinued++;
		if (cont.code === 0) continue;
		if ((await unmergedFiles(deps, worktreePath)).length > 0) continue;
		if (!(await isRebaseActive(deps, worktreePath))) continue;
		const staged = await runGit(deps, worktreePath, ["diff", "--cached", "--quiet"]);
		const unstaged = await runGit(deps, worktreePath, ["diff", "--quiet"]);
		if (staged.code === 0 && unstaged.code === 0) {
			// Provably-empty step: its changes are already on main. Skipping is the one correct move.
			const skip = await runGitEnv(deps, worktreePath, ["rebase", "--skip"]);
			if (skip.code !== 0 && (await isRebaseActive(deps, worktreePath))) {
				return gitError("git rebase --skip failed on a provably-empty step", skip);
			}
			continue;
		}
		return gitError("git rebase --continue failed in an unrecognized state", cont);
	}
	return {
		code: "git_error",
		message: "rebase drive exceeded 1000 mechanical steps; aborting the drive (rebase left in progress)",
	};
}

export interface SyncLaneArgs {
	laneKey: string;
}

/**
 * Rebase current main into the lane branch, locally (the awareness half of "perfect sync"; the
 * land gate is the enforcement half). Pins the main sha it derived so a concurrent land cannot
 * change this sync's meaning mid-flight (D-pinned-sha). Conflicts leave the rebase in progress
 * and return a structured worklist; `continueSync` verifies and drives on.
 */
export async function syncLane(deps: WorktreeSyncEngineDeps, args: SyncLaneArgs): Promise<SyncLaneResult> {
	const ctx = await resolveRepoContext(deps);
	if ("code" in ctx) return ctx;
	const lane = await readLane(ctx.paths, args.laneKey);
	if (!lane || lane.status === "released") {
		return { code: "lane_not_found", message: `no active lane '${args.laneKey}'` };
	}
	const facts = await deriveLaneFacts(deps, ctx, lane);
	if (!facts.worktreePresent) {
		return { code: "worktree_missing", message: `lane '${lane.laneKey}' checkout missing at ${lane.worktreePath}` };
	}
	if (facts.rebaseInProgress) {
		return {
			code: "rebase_in_progress",
			message: `lane '${lane.laneKey}' has a rebase in progress; resolve and call continue, or abort_sync`,
		};
	}
	if (facts.fresh) {
		return { code: "sync_clean", laneKey: lane.laneKey, alreadyFresh: true, autoContinued: 0 };
	}
	if (facts.dirty) {
		return {
			code: "lane_dirty",
			message: `lane '${lane.laneKey}' has uncommitted changes; commit them on the lane branch, then sync`,
			paths: await dirtyPaths(deps, lane.worktreePath),
		};
	}

	await appendAuditEvent(
		ctx.paths,
		{ event: "sync_started", laneKey: lane.laneKey, ontoSha: ctx.mainSha },
		nowIso(deps),
	);
	const rebase = await runGitEnv(deps, lane.worktreePath, ["rebase", ctx.mainSha]);
	if (rebase.code === 0) {
		await appendAuditEvent(
			ctx.paths,
			{ event: "sync_completed", laneKey: lane.laneKey, autoContinued: 0 },
			nowIso(deps),
		);
		return { code: "sync_clean", laneKey: lane.laneKey, alreadyFresh: false, autoContinued: 0 };
	}
	if (!(await isRebaseActive(deps, lane.worktreePath))) {
		return gitError(`git rebase failed to start for lane '${lane.laneKey}'`, rebase);
	}
	const driven = await driveRebase(deps, ctx, lane);
	if (driven.code === "sync_clean") return { ...driven, alreadyFresh: false };
	return driven;
}

export interface ContinueSyncArgs {
	laneKey: string;
}

/**
 * G9: verify the agent's conflict resolution mechanically (zero conflict markers by byte-scan --
 * the agent never self-certifies), stage it, and drive the rebase on. More conflicts return the
 * next worklist; completion returns sync_clean.
 */
export async function continueSync(deps: WorktreeSyncEngineDeps, args: ContinueSyncArgs): Promise<ContinueSyncResult> {
	const ctx = await resolveRepoContext(deps);
	if ("code" in ctx) return ctx;
	const lane = await readLane(ctx.paths, args.laneKey);
	if (!lane || lane.status === "released") {
		return { code: "lane_not_found", message: `no active lane '${args.laneKey}'` };
	}
	if (!fileExists(deps, lane.worktreePath)) {
		return { code: "worktree_missing", message: `lane '${lane.laneKey}' checkout missing at ${lane.worktreePath}` };
	}
	if (!(await isRebaseActive(deps, lane.worktreePath))) {
		return { code: "no_rebase_in_progress", message: `lane '${lane.laneKey}' has no rebase in progress; use sync` };
	}

	const unmerged = await unmergedFiles(deps, lane.worktreePath);
	const withMarkers = unmerged.filter((path) => {
		const content = readFileMaybe(deps, join(lane.worktreePath, path));
		return content !== undefined && CONFLICT_MARKER_RE.test(content);
	});
	if (withMarkers.length > 0) {
		return {
			code: "conflict_markers_present",
			message: `${withMarkers.length} file(s) still contain conflict markers; resolve them fully, then continue`,
			paths: withMarkers,
		};
	}
	if (unmerged.length > 0) {
		const add = await runGit(deps, lane.worktreePath, ["add", "-A"]);
		if (add.code !== 0) return gitError("git add -A failed while staging conflict resolutions", add);
	}
	const cont = await runGitEnv(deps, lane.worktreePath, ["rebase", "--continue"]);
	if (cont.code === 0 && !(await isRebaseActive(deps, lane.worktreePath))) {
		await appendAuditEvent(
			ctx.paths,
			{ event: "sync_completed", laneKey: lane.laneKey, autoContinued: 0 },
			nowIso(deps),
		);
		return { code: "sync_clean", laneKey: lane.laneKey, autoContinued: 0 };
	}
	return driveRebase(deps, ctx, lane);
}

export interface AbortSyncArgs {
	laneKey: string;
}

/** Abort an in-progress sync rebase: the lane returns to its pre-sync tip -- still stale, and
 * honestly reported as such by status. */
export async function abortSync(deps: WorktreeSyncEngineDeps, args: AbortSyncArgs): Promise<AbortSyncResult> {
	const ctx = await resolveRepoContext(deps);
	if ("code" in ctx) return ctx;
	const lane = await readLane(ctx.paths, args.laneKey);
	if (!lane || lane.status === "released") {
		return { code: "lane_not_found", message: `no active lane '${args.laneKey}'` };
	}
	if (!(await isRebaseActive(deps, lane.worktreePath))) {
		return { code: "no_rebase_in_progress", message: `lane '${lane.laneKey}' has no rebase in progress` };
	}
	const abort = await runGitEnv(deps, lane.worktreePath, ["rebase", "--abort"]);
	if (abort.code !== 0) return gitError("git rebase --abort failed", abort);
	await appendAuditEvent(ctx.paths, { event: "sync_aborted", laneKey: lane.laneKey }, nowIso(deps));
	return { code: "ok", laneKey: lane.laneKey };
}

export interface LandLaneArgs {
	laneKey: string;
	/** "on" runs gateCommand (G4); "off" is the owner-level opt-out, recorded per land event. */
	gate: "on" | "off";
	gateCommand?: string;
	gateTimeoutMs?: number;
}

const DEFAULT_GATE_TIMEOUT_MS = 900_000;

/**
 * The land gate -- the ONLY door to main (G1-G7). Serialized under the integration lock; every
 * precondition is re-derived INSIDE the lock (the compare-and-swap that makes the whole system
 * race-free: even if every notification failed, a stale lane cannot land). Main only ever moves
 * by ff-only merge of an already-rebased lane branch; a successful land bumps the epoch and
 * broadcasts in the same critical section.
 */
export async function landLane(deps: WorktreeSyncEngineDeps, args: LandLaneArgs): Promise<LandResult> {
	const ctx = await resolveRepoContext(deps);
	if ("code" in ctx) return ctx;
	const lane = await readLane(ctx.paths, args.laneKey);
	if (!lane || lane.status === "released") {
		return { code: "lane_not_found", message: `no active lane '${args.laneKey}'` };
	}
	if (args.gate === "on" && !args.gateCommand?.trim()) {
		return {
			code: "gate_command_unset",
			message:
				'no gate command configured; set worktreeSync.gateCommand (or worktreeSync.gate: "off" as an owner-level opt-out)',
		};
	}

	const acquisition = await acquireIntegrationLock(
		ctx.paths,
		{
			pid: deps.pid ?? process.pid,
			hostname: osHostname(),
			...(deps.sessionId !== undefined ? { sessionId: deps.sessionId } : {}),
			laneKey: lane.laneKey,
		},
		{
			now: deps.now,
			...(deps.isPidAlive
				? { isPidAlive: (owner) => (deps.isPidAlive as (pid: number) => boolean)(owner.pid) }
				: {}),
		},
	);
	if (!acquisition.acquired) {
		return {
			code: "lock_busy",
			message: acquisition.holder
				? `integration lock held by pid ${acquisition.holder.pid}${acquisition.holder.laneKey ? ` (lane '${acquisition.holder.laneKey}')` : ""}; retry after it lands`
				: "integration lock held; retry shortly",
			...(acquisition.holder ? { holder: acquisition.holder } : {}),
		};
	}

	try {
		// Everything below happens INSIDE the lock: re-derive, never trust pre-lock derivations.
		const mainShaNow = await revParseBranch(deps, ctx.topLevel, ctx.mainBranch);
		if (!mainShaNow) {
			return { code: "default_branch_unresolved", message: `main branch '${ctx.mainBranch}' vanished mid-land` };
		}
		if (!fileExists(deps, lane.worktreePath)) {
			return {
				code: "worktree_missing",
				message: `lane '${lane.laneKey}' checkout missing at ${lane.worktreePath}`,
			};
		}
		if (await isRebaseActive(deps, lane.worktreePath)) {
			return {
				code: "rebase_in_progress",
				message: `lane '${lane.laneKey}' has a rebase in progress; finish (continue) or abort_sync before landing`,
			};
		}
		const laneDirty = await dirtyPaths(deps, lane.worktreePath);
		if (laneDirty.length > 0) {
			return {
				code: "lane_dirty",
				message: `lane '${lane.laneKey}' has uncommitted changes; commit everything on the lane branch first (G2)`,
				paths: laneDirty,
			};
		}
		const tipSha = await revParseBranch(deps, ctx.topLevel, lane.branch);
		if (!tipSha) return { code: "git_error", message: `lane branch '${lane.branch}' has no commits/ref` };
		if (tipSha === mainShaNow) {
			// A no-op land would bump the epoch for nothing (notification churn for every lane).
			return {
				code: "nothing_to_land",
				message: `lane '${lane.laneKey}' has no commits beyond main; nothing to land`,
			};
		}
		const ancestry = await runGit(deps, ctx.topLevel, ["merge-base", "--is-ancestor", mainShaNow, tipSha]);
		if (ancestry.code !== 0) {
			return {
				code: "stale_lane",
				message: `lane '${lane.laneKey}' does not contain current main (${mainShaNow.slice(0, 12)}); sync first (G3)`,
			};
		}
		if (!ctx.hubPath) {
			return {
				code: "hub_missing",
				message: `main branch '${ctx.mainBranch}' is not checked out in any worktree; landing needs the hub checkout (G5)`,
			};
		}

		const changedResult = await runGit(deps, ctx.topLevel, ["diff", "--name-only", `${mainShaNow}..${tipSha}`]);
		if (changedResult.code !== 0)
			return gitError("git diff --name-only failed while computing the land set", changedResult);
		const changed = changedResult.stdout
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);

		// G6, overlap-based: an ff merge only touches the land's changed files, and git itself
		// refuses to clobber local modifications -- so the deterministic pre-check refuses exactly
		// when hub-dirty paths intersect the incoming change set (not on unrelated hub dirt).
		const hubDirty = await dirtyPaths(deps, ctx.hubPath);
		const changedSet = new Set(changed);
		const endangered = hubDirty.filter((path) => changedSet.has(path));
		if (endangered.length > 0) {
			return {
				code: "hub_dirty",
				message: `hub checkout has local modifications to ${endangered.length} file(s) this land would update; commit/stash them first (G6)`,
				paths: endangered.slice(0, 50),
			};
		}

		if (args.gate === "on") {
			const gateCommand = (args.gateCommand ?? "").trim();
			const shell = process.platform === "win32" ? "cmd" : "sh";
			const shellFlag = process.platform === "win32" ? "/c" : "-c";
			const gateRun = await deps.exec(shell, [shellFlag, gateCommand], {
				cwd: lane.worktreePath,
				timeout: args.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS,
				signal: deps.signal,
				maxBuffer: GIT_MAX_BUFFER,
			});
			if (gateRun.code !== 0) {
				const tail = `${gateRun.stdout}\n${gateRun.stderr}`.trim().slice(-4000);
				return {
					code: "gate_failed",
					message: `gate command failed (exit ${gateRun.code}) at lane tip ${tipSha.slice(0, 12)} (G4)`,
					gitStderr: tail,
				};
			}
		}

		const ff = await runGit(deps, ctx.hubPath, ["merge", "--ff-only", lane.branch]);
		if (ff.code !== 0) {
			// Unreachable by construction (G3 guarantees ff-ability) but checked, never assumed.
			return gitError(`git merge --ff-only refused for lane '${lane.laneKey}' (G5)`, ff);
		}

		const previous = await readEpoch(ctx.paths);
		const epochNumber = (previous?.epoch ?? 0) + 1;
		const at = nowIso(deps);
		await writeEpoch(ctx.paths, {
			epoch: epochNumber,
			mainSha: tipSha,
			previousMainSha: mainShaNow,
			landedLaneKey: lane.laneKey,
			landedAt: at,
			changedPaths: changed.slice(0, EPOCH_CHANGED_PATHS_CAP),
			changedPathsTruncated: changed.length > EPOCH_CHANGED_PATHS_CAP,
		});
		await appendAuditEvent(
			ctx.paths,
			{
				event: "epoch_advanced",
				epoch: epochNumber,
				laneKey: lane.laneKey,
				mainSha: tipSha,
				previousMainSha: mainShaNow,
				changedFiles: changed.length,
				gate: args.gate === "on" ? "passed" : "off",
			},
			at,
		);
		return {
			code: "ok",
			laneKey: lane.laneKey,
			epoch: epochNumber,
			mainSha: tipSha,
			gate: args.gate === "on" ? "passed" : "off",
		};
	} finally {
		await releaseIntegrationLock(ctx.paths, { now: deps.now });
	}
}

export interface SyncStatusArgs {
	policy: WorktreeSyncPolicy;
}

/**
 * The deterministic full picture (the tool's `status` action): epoch, hub, lock, and per-lane
 * live facts with the policy derivation (stale / syncRequired / overlap). The `advice` line is
 * assembled from codes -- never model-generated -- so every agent reads the same situation the
 * same way.
 */
export async function buildSyncStatus(deps: WorktreeSyncEngineDeps, args: SyncStatusArgs): Promise<SyncStatusResult> {
	const ctx = await resolveRepoContext(deps);
	if ("code" in ctx) return ctx;

	const epochRecord = await readEpoch(ctx.paths);
	const epochNumber = epochRecord?.epoch ?? 0;
	const changedSet = new Set(epochRecord?.changedPaths ?? []);
	const changedTruncated = epochRecord?.changedPathsTruncated === true;

	const holder = await readLockHolder(ctx.paths);
	const isAlive =
		deps.isPidAlive ?? ((pid: number) => defaultIsPidAlive({ pid, hostname: osHostname(), acquiredAt: "" }));

	let hub: { path: string; clean: boolean } | undefined;
	if (ctx.hubPath) {
		hub = { path: ctx.hubPath, clean: (await dirtyPaths(deps, ctx.hubPath)).length === 0 };
	}

	const lanes: LaneStatusEntry[] = [];
	for (const lane of await listLanes(ctx.paths)) {
		if (lane.status === "released") continue;
		const facts = await deriveLaneFacts(deps, ctx, lane);
		let laneChanged: string[] = [];
		if (facts.branchSha) {
			const diff = await runGit(deps, ctx.topLevel, ["diff", "--name-only", `${ctx.mainBranch}...${lane.branch}`]);
			if (diff.code === 0) {
				laneChanged = diff.stdout
					.split(/\r?\n/)
					.map((line) => line.trim())
					.filter(Boolean)
					.slice(0, EPOCH_CHANGED_PATHS_CAP);
			}
		}
		const overlap = changedTruncated ? laneChanged : laneChanged.filter((path) => changedSet.has(path));
		const stale = !facts.fresh;
		const syncRequired =
			stale &&
			facts.registrationStatus === "active" &&
			(args.policy === "on_land_mandatory" || (args.policy === "overlap_mandatory" && overlap.length > 0));
		lanes.push({
			...facts,
			...(lane.goalId !== undefined ? { goalId: lane.goalId } : {}),
			...(lane.requirementId !== undefined ? { requirementId: lane.requirementId } : {}),
			...(lane.boundLaneId !== undefined ? { boundLaneId: lane.boundLaneId } : {}),
			stale,
			syncRequired,
			overlapWithLastLand: overlap.slice(0, 50),
		});
	}

	const inRebase = lanes.filter((lane) => lane.rebaseInProgress).map((lane) => lane.laneKey);
	const mustSync = lanes.filter((lane) => lane.syncRequired && !lane.rebaseInProgress).map((lane) => lane.laneKey);
	let advice: string | undefined;
	if (inRebase.length > 0) {
		advice = `lane(s) ${inRebase.join(", ")} have a rebase in progress: resolve conflicts and call continue (or abort_sync)`;
	} else if (mustSync.length > 0) {
		advice = `lane(s) ${mustSync.join(", ")} must rebase main (epoch ${epochNumber}${epochRecord?.landedLaneKey ? ` landed by ${epochRecord.landedLaneKey}` : ""}): call sync`;
	} else if (holder) {
		advice = `integration lock held by pid ${holder.pid}${holder.laneKey ? ` (lane '${holder.laneKey}')` : ""}`;
	} else if (lanes.length > 0) {
		advice = "all lanes fresh";
	}

	return {
		code: "ok",
		mainBranch: ctx.mainBranch,
		mainSha: ctx.mainSha,
		epoch: epochNumber,
		...(hub ? { hub } : {}),
		lock: {
			held: holder !== undefined,
			...(holder ? { holder, holderAlive: isAlive(holder.pid) } : {}),
		},
		lanes,
		...(advice ? { advice } : {}),
	};
}
