/**
 * Lane gate: G8/G10 enforcement for a LANE-BOUND `pi` session (launched with
 * `PI_WORKTREE_LANE=<key>`). RuntimeBuilder wraps the session's file-mutation tools (edit /
 * write / bash) with {@link WorktreeLaneGate.checkMutation}; a lane that the active policy marks
 * sync_required fails closed with the exact recovery step until it rebases main.
 *
 * Honesty boundary (unchanged from the tmux trust model): this is HARD for pi children -- the
 * wrapper lives under the tool layer, not in the prompt -- and cooperative-only for foreign
 * CLIs, whose backstop is the land CAS (G3): stale work simply cannot land.
 *
 * Determinism: the gate re-derives from git only when the epoch file actually changed (mtime
 * fence) or while blocked; verdicts in between are cached. No polling, no timers.
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { WorktreeSyncPolicy } from "./codes.ts";
import { deriveLaneFacts, type RepoContext, resolveRepoContext, type WorktreeSyncEngineDeps } from "./git-engine.ts";
import { readLane } from "./store.ts";

export type LaneBashVerdict =
	| { verdict: "allowed" }
	| { verdict: "allowed_even_when_sync_required" }
	| { verdict: "main_mutation_refused"; reason: string };

const SYNC_SAFE_GIT_SUBCOMMANDS = new Set([
	"status",
	"diff",
	"log",
	"show",
	"add",
	"commit",
	"stash",
	"rev-parse",
	"ls-files",
	"blame",
	"grep",
]);

const MAIN_MUTATING_GIT_SUBCOMMANDS = new Set(["merge", "rebase", "reset", "commit", "branch", "update-ref", "push"]);

/**
 * Classify one bash command line for a lane-bound session (G10 + the sync_required allowlist).
 * Tokenization is whitespace-naive by design -- deterministic and reviewable; shell-quoting
 * tricks can evade it, which is the documented cooperative boundary (the land CAS cannot be
 * evaded). Command POSITION still matters: `git` only begins an invocation at the start of the
 * command or immediately after a shell separator (`&&`, `||`, `;`, `|`) -- a bare `git` token
 * elsewhere (e.g. as a plain argument to `echo`) is not an invocation. Rules:
 * - `git push` anywhere: refused (main moves only through the land gate; pushing is owner-only).
 * - `git -C <path>` / `--git-dir` combined with a mutating subcommand: refused (escaping the
 *   lane worktree to operate on another checkout, e.g. the hub).
 * - `git branch -f/-M/-D <main>` / `git update-ref refs/heads/<main>`: refused.
 * - Everything else: allowed; a read/commit-shaped git subcommand additionally stays allowed
 *   while the lane is sync_required (committing WIP is the prescribed step BEFORE syncing).
 */
export function classifyLaneBashCommand(command: string, mainBranch: string): LaneBashVerdict {
	// This classifier is defense-in-depth, not a shell parser. Refuse compound
	// syntax before any segment can return an allow verdict; otherwise `git
	// status; git push` is approved by the first safe segment.
	if (/[|;&<>$`(){}\n\r]/u.test(command)) {
		return {
			verdict: "main_mutation_refused",
			reason: "compound shell syntax is refused in a lane; use typed worktree_sync actions",
		};
	}
	if (/^\s*["']git["']\s/u.test(command)) {
		return {
			verdict: "main_mutation_refused",
			reason: "quoted command names are refused in a lane; use the typed Git actions",
		};
	}
	const segments = [command];
	let allowedWhenSyncRequired = false;
	for (const segment of segments) {
		const tokens = segment.trim().split(/\s+/).filter(Boolean);
		if (tokens[0] !== "git") continue;
		let j = 1;
		let escapesWorktree = false;
		// Skip git global options to find the subcommand; -C/--git-dir mark checkout escape.
		while (j < tokens.length) {
			const token = tokens[j] ?? "";
			if (token === "-C" || token === "--git-dir" || token === "--work-tree") {
				escapesWorktree = true;
				j += 2;
				continue;
			}
			if (token.startsWith("-C") && token !== "-C") {
				escapesWorktree = true;
				j += 1;
				continue;
			}
			if (token.startsWith("--git-dir=") || token.startsWith("--work-tree=")) {
				escapesWorktree = true;
				j += 1;
				continue;
			}
			if (token.startsWith("-")) {
				j += 1;
				continue;
			}
			break;
		}
		const subcommand = tokens[j] ?? "";
		const rest = tokens.slice(j + 1);
		if (subcommand === "push") {
			return {
				verdict: "main_mutation_refused",
				reason:
					"git push is refused in a lane session; landing is the only integration path and pushing stays an owner action",
			};
		}
		if (escapesWorktree && MAIN_MUTATING_GIT_SUBCOMMANDS.has(subcommand)) {
			return {
				verdict: "main_mutation_refused",
				reason: `git -C/--git-dir with '${subcommand}' escapes the lane worktree; operate only on this lane (G10)`,
			};
		}
		if (
			subcommand === "branch" &&
			rest.some((token) => /^(?:-f|--force|-M|-m|-D|-d)$/.test(token)) &&
			rest.includes(mainBranch)
		) {
			return {
				verdict: "main_mutation_refused",
				reason: `git branch may not move/delete '${mainBranch}' from a lane; main moves only through the land gate (G10)`,
			};
		}
		if (subcommand === "update-ref" && rest.some((token) => token === `refs/heads/${mainBranch}`)) {
			return {
				verdict: "main_mutation_refused",
				reason: `git update-ref may not touch refs/heads/${mainBranch} from a lane (G10)`,
			};
		}
		if (SYNC_SAFE_GIT_SUBCOMMANDS.has(subcommand)) allowedWhenSyncRequired = true;
	}
	return allowedWhenSyncRequired ? { verdict: "allowed_even_when_sync_required" } : { verdict: "allowed" };
}

/** Symlink-safe resolution of a path that may not exist yet: realpath the NEAREST EXISTING
 * ancestor, then re-append the not-yet-existing tail literally (a not-yet-created file's own
 * missing final component can never itself be a symlink escape). */
function resolveSymlinkSafe(targetPath: string): string {
	if (existsSync(targetPath)) {
		try {
			return realpathSync(targetPath);
		} catch {
			return targetPath;
		}
	}
	const tail: string[] = [basename(targetPath)];
	let ancestor = dirname(targetPath);
	while (!existsSync(ancestor)) {
		const parent = dirname(ancestor);
		if (parent === ancestor) break; // reached the filesystem root without finding one
		tail.unshift(basename(ancestor));
		ancestor = parent;
	}
	let realAncestor: string;
	try {
		realAncestor = realpathSync(ancestor);
	} catch {
		realAncestor = ancestor;
	}
	return join(realAncestor, ...tail);
}

/** Symlink-safe containment check (G-path): does `targetPath` resolve inside `worktreePath`? */
export function isPathOutsideLane(targetPath: string, worktreePath: string): boolean {
	let realRoot: string;
	try {
		realRoot = realpathSync(worktreePath);
	} catch {
		realRoot = worktreePath;
	}
	const resolvedTarget = resolveSymlinkSafe(targetPath);
	return resolvedTarget !== realRoot && !resolvedTarget.startsWith(realRoot + sep);
}

/** Resolve a user-supplied relative lane path and reject symlink/parent escapes. */
export function resolveLaneMutationPath(worktreePath: string, candidate: string): string | undefined {
	const target = resolve(worktreePath, candidate);
	return isPathOutsideLane(target, worktreePath) ? undefined : target;
}

export interface WorktreeLaneGateConfig {
	laneKey: string;
	engineDeps: () => WorktreeSyncEngineDeps;
	policy: () => WorktreeSyncPolicy;
	/** Worker launches use a hard shell envelope: only lane-safe Git/WIP commands and the owner-configured
	 * exact gate command may pass through bash. Interactive lane sessions retain the legacy cooperative
	 * command surface while the typed worktree_sync actions are used for hard worker mutations. */
	hardShell?: boolean;
	trustedGateCommand?: () => string | undefined;
}

export type LaneMutationCheck = { allowed: true } | { allowed: false; code: string; message: string };

async function changedPaths(
	deps: WorktreeSyncEngineDeps,
	cwd: string,
	base: string,
	ref: string,
): Promise<Set<string> | undefined> {
	const result = await deps.exec("git", ["diff", "--name-only", `${base}..${ref}`, "--"], {
		cwd,
		timeout: 60_000,
		maxBuffer: 1024 * 1024,
	});
	if (result.code !== 0) return undefined;
	return new Set(
		result.stdout
			.split(/\r?\n/u)
			.map((path) => path.trim())
			.filter(Boolean),
	);
}

function hardShellCommandAllowed(command: string, mainBranch: string, trustedGateCommand?: string): boolean {
	const trimmed = command.trim();
	if (trustedGateCommand && trimmed === trustedGateCommand.trim()) return true;
	if (!/^git(?:\s|$)/u.test(trimmed)) return false;
	const verdict = classifyLaneBashCommand(trimmed, mainBranch);
	if (verdict.verdict === "main_mutation_refused") return false;
	const tokens = trimmed.split(/\s+/u);
	const subcommand = tokens[1] ?? "";
	if (!SYNC_SAFE_GIT_SUBCOMMANDS.has(subcommand) && subcommand !== "commit") return false;
	// Git path operands must not escape the lane checkout. The typed worktree
	// actions are the authoritative route for path-sensitive add/diff operations;
	// this final check prevents the common absolute/parent escape in the shell floor.
	return !tokens.slice(2).some((token) => token.startsWith("/") || token.startsWith("..") || token.includes("/../"));
}

/**
 * The G8 gate object RuntimeBuilder holds per lane-bound session. `checkMutation` is called by
 * the wrapped edit/write/bash tools before every mutating execution.
 */
export class WorktreeLaneGate {
	private readonly config: WorktreeLaneGateConfig;
	private _ctx: RepoContext | undefined;
	private _epochFileMtimeMs: number | undefined;
	private _cachedAllowed = false;

	constructor(config: WorktreeLaneGateConfig) {
		this.config = config;
	}

	private async resolveContext(): Promise<RepoContext | undefined> {
		if (this._ctx) return this._ctx;
		const ctx = await resolveRepoContext(this.config.engineDeps());
		if ("code" in ctx) return undefined;
		this._ctx = ctx;
		return ctx;
	}

	/** Cheap fence: has the epoch file changed since the last allowed verdict? */
	private epochChanged(ctx: RepoContext): boolean {
		let mtimeMs: number | undefined;
		try {
			mtimeMs = statSync(ctx.paths.epochFile).mtimeMs;
		} catch {
			mtimeMs = undefined;
		}
		if (mtimeMs === this._epochFileMtimeMs) return false;
		this._epochFileMtimeMs = mtimeMs;
		return true;
	}

	async checkMutation(toolName: string, bashCommand?: string, targetPath?: string): Promise<LaneMutationCheck> {
		const ctx = await this.resolveContext();
		// No repo context (deleted repo, engine failure): fail OPEN for plain tools -- the land
		// CAS still holds -- but the G10 bash rules below never depend on repo state.
		const mainBranch = ctx?.mainBranch ?? "main";
		if (this.config.hardShell && !ctx) {
			return {
				allowed: false,
				code: "lane_state_unavailable",
				message: "worktree-sync: lane state is unavailable; hard worker mutations fail closed",
			};
		}

		if (toolName === "bash" && bashCommand !== undefined) {
			if (
				this.config.hardShell &&
				!hardShellCommandAllowed(bashCommand, mainBranch, this.config.trustedGateCommand?.())
			) {
				return {
					allowed: false,
					code: "main_mutation_refused",
					message:
						"worktree-sync: unrestricted bash is unavailable in a hard worker lane; use typed worktree_sync actions",
				};
			}
			const verdict = classifyLaneBashCommand(bashCommand, mainBranch);
			if (verdict.verdict === "main_mutation_refused") {
				return { allowed: false, code: "main_mutation_refused", message: `worktree-sync: ${verdict.reason}` };
			}
			if (verdict.verdict === "allowed_even_when_sync_required") return { allowed: true };
		}
		if (!ctx) return { allowed: true };

		// G-path: an edit/write target must resolve INSIDE this lane's worktree (symlink-safe),
		// checked BEFORE the staleness cache so a cached "allowed" verdict never short-circuits past
		// it. No active lane record: existing fail-open stands (mirrors the readLane check below).
		if ((toolName === "edit" || toolName === "write") && targetPath !== undefined) {
			const laneForPath = await readLane(ctx.paths, this.config.laneKey);
			if (laneForPath?.status === "active" && isPathOutsideLane(targetPath, laneForPath.worktreePath)) {
				return {
					allowed: false,
					code: "path_outside_lane",
					message: `worktree-sync: '${targetPath}' resolves outside lane '${this.config.laneKey}' worktree (${laneForPath.worktreePath}); edit/write only inside your lane checkout`,
				};
			}
		}

		// G8: sync_required fails mutations closed. Re-derive only when the epoch moved or while
		// blocked (a successful sync clears the block on the very next check).
		if (this._cachedAllowed && !this.epochChanged(ctx)) return { allowed: true };

		const deps = this.config.engineDeps();
		const lane = await readLane(ctx.paths, this.config.laneKey);
		if (!lane || lane.status !== "active") {
			if (this.config.hardShell) {
				return {
					allowed: false,
					code: "lane_state_unavailable",
					message:
						"worktree-sync: hard worker lane registration is missing or inactive; reconcile before mutating",
				};
			}
			this._cachedAllowed = true;
			return { allowed: true };
		}
		// Re-derive main tip: the cached ctx pins the sha from session start.
		const fresh = await resolveRepoContext(deps);
		if ("code" in fresh) {
			if (this.config.hardShell) {
				return {
					allowed: false,
					code: "lane_state_unavailable",
					message: "worktree-sync: Git context is unavailable; hard worker mutation refused",
				};
			}
			this._cachedAllowed = true;
			return { allowed: true };
		}
		this._ctx = fresh;
		const facts = await deriveLaneFacts(deps, fresh, lane);
		if (facts.fresh) {
			this._cachedAllowed = true;
			return { allowed: true };
		}

		const policy = this.config.policy();
		let syncRequired = policy === "on_land_mandatory";
		if (policy === "overlap_mandatory") {
			// Epoch files are notification/diagnostic state only. Derive both sides from the
			// current merge base so an overlap from land N remains enforced after unrelated land N+1.
			const mergeBase = await deps.exec("git", ["merge-base", fresh.mainBranch, lane.branch], {
				cwd: fresh.topLevel,
				timeout: 60_000,
				maxBuffer: 1024 * 1024,
			});
			if (mergeBase.code !== 0 || !mergeBase.stdout.trim()) {
				syncRequired = true;
			} else {
				const base = mergeBase.stdout.trim().split(/\s+/u)[0];
				const lanePaths = await changedPaths(deps, fresh.topLevel, base, lane.branch);
				const mainPaths = await changedPaths(deps, fresh.topLevel, base, fresh.mainBranch);
				if (!lanePaths || !mainPaths) {
					syncRequired = true;
				} else {
					syncRequired = [...lanePaths].some((path) => mainPaths.has(path));
				}
			}
		}
		if (policy === "land_time_only") syncRequired = false;

		if (!syncRequired) {
			this._cachedAllowed = true;
			return { allowed: true };
		}
		this._cachedAllowed = false;
		return {
			allowed: false,
			code: "sync_required",
			message:
				`worktree-sync: lane '${this.config.laneKey}' must rebase main before further mutations ` +
				`(main moved past this lane). Commit any WIP (git add/commit stay available), then call ` +
				`worktree_sync {"action":"sync"}, resolve conflicts if any, and continue. (sync_required)`,
		};
	}
}
