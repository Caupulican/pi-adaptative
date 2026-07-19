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

import { statSync } from "node:fs";
import type { WorktreeSyncPolicy } from "./codes.ts";
import { deriveLaneFacts, type RepoContext, resolveRepoContext, type WorktreeSyncEngineDeps } from "./git-engine.ts";
import { readEpoch, readLane } from "./store.ts";

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
	const segments = command.split(/&&|\|\||;|\|/);
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
			rest.some((token) => /^-(f|force|M|D|d|m)/.test(token)) &&
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
		if (SYNC_SAFE_GIT_SUBCOMMANDS.has(subcommand)) {
			return { verdict: "allowed_even_when_sync_required" };
		}
	}
	return { verdict: "allowed" };
}

export interface WorktreeLaneGateConfig {
	laneKey: string;
	engineDeps: () => WorktreeSyncEngineDeps;
	policy: () => WorktreeSyncPolicy;
}

export type LaneMutationCheck = { allowed: true } | { allowed: false; code: string; message: string };

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

	async checkMutation(toolName: string, bashCommand?: string): Promise<LaneMutationCheck> {
		const ctx = await this.resolveContext();
		// No repo context (deleted repo, engine failure): fail OPEN for plain tools -- the land
		// CAS still holds -- but the G10 bash rules below never depend on repo state.
		const mainBranch = ctx?.mainBranch ?? "main";

		if (toolName === "bash" && bashCommand !== undefined) {
			const verdict = classifyLaneBashCommand(bashCommand, mainBranch);
			if (verdict.verdict === "main_mutation_refused") {
				return { allowed: false, code: "main_mutation_refused", message: `worktree-sync: ${verdict.reason}` };
			}
			if (verdict.verdict === "allowed_even_when_sync_required") return { allowed: true };
		}
		if (!ctx) return { allowed: true };

		// G8: sync_required fails mutations closed. Re-derive only when the epoch moved or while
		// blocked (a successful sync clears the block on the very next check).
		if (this._cachedAllowed && !this.epochChanged(ctx)) return { allowed: true };

		const deps = this.config.engineDeps();
		const lane = await readLane(ctx.paths, this.config.laneKey);
		if (!lane || lane.status !== "active") {
			this._cachedAllowed = true;
			return { allowed: true };
		}
		// Re-derive main tip: the cached ctx pins the sha from session start.
		const fresh = await resolveRepoContext(deps);
		if ("code" in fresh) {
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
			const epoch = await readEpoch(fresh.paths);
			if (epoch?.changedPathsTruncated) {
				syncRequired = true;
			} else if (epoch) {
				const changedSet = new Set(epoch.changedPaths);
				const laneDiff = await deps.exec("git", ["diff", "--name-only", `${fresh.mainBranch}...${lane.branch}`], {
					cwd: fresh.topLevel,
					timeout: 60_000,
					maxBuffer: 1024 * 1024,
				});
				syncRequired =
					laneDiff.code === 0 &&
					laneDiff.stdout
						.split(/\r?\n/)
						.map((line) => line.trim())
						.filter(Boolean)
						.some((path) => changedSet.has(path));
			} else {
				syncRequired = false;
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
