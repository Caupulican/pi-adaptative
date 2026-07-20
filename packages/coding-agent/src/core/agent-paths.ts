/**
 * Typed path SSOT for everything machine-managed under `<agentDir>` (`~/.pi/agent/` by default,
 * `getAgentDir()` in `../config.ts`). Every writer that persists machine data (stores, caches, managed
 * runtimes/models, cross-process coordination) MUST resolve its path through one of the accessors
 * below instead of hand-rolling `join(agentDir, …)` — that ad-hoc pattern is exactly how root-level
 * stragglers like `trust.json` accumulated, and nothing stopped the next writer from doing it again.
 *
 * Canonical layout:
 * ```
 * <agentDir>/
 *   auth.json settings.json models.json keybindings.json MEMORY.md USER.md SYSTEM.md …   user CONFIG/MEMORY (root, kept)
 *   skills/ extensions/ prompts/ themes/ profiles/                                        user RESOURCES (root, kept)
 *   state/     durable machine state (model adaptation/fitness, tool performance,
 *              learning observations, trust decisions, …)                                 -- stateDir/stateFile
 *   cache/     rebuildable, safe to delete (tool-path probes, jiti transform cache, uv)    -- cacheDir/cacheFile
 *   work/      transient/scratch, delegated to work-directory.ts (tenant/run/lease)        -- re-exported below
 *   runtimes/<kind>  models/<kind>                                                         -- runtimesDir/modelsDir
 *   npm/ git/ sessions/                                                                    -- npmDir/gitDir/sessionsDir
 *   worktrees/<repo-slug>/<laneKey>   durable lane checkouts (core/worktree-sync)           -- worktreesDir
 * ```
 *
 * Every accessor takes `agentDir` as an explicit, required first argument -- deliberately mirroring
 * `work-directory.ts`'s existing `getWorkRoot(agentDir)` convention rather than defaulting to
 * `getAgentDir()` internally. Several real callers (stores' `forAgentDir`, test harnesses with a temp
 * agentDir) build paths for a NON-default agentDir; a hidden default would silently resolve the wrong
 * root for those callers instead of failing loudly. Callers operating on the process-wide default pass
 * `getAgentDir()` explicitly at the call site.
 *
 * These accessors are pure path builders -- no directory creation, no I/O. Every existing writer
 * already creates its parent directory at write time (see `util/atomic-file.ts`'s
 * `mkdirSync(dirname(filePath), { recursive: true })`), so duplicating that here would be redundant
 * and would blur the "pure function" contract readers rely on.
 */
import { join } from "node:path";
import {
	acquireWorkRun,
	createWorkRunId,
	getProcessWorkRun,
	getWorkRoot,
	getWorkRunDir,
	getWorkTenantDir,
	pruneWorkTenant,
} from "../utils/work-directory.ts";
import { getReloadCoordinationDir } from "./reload-blockers.ts";

/** `<agentDir>/<name>` -- a root-level user config/memory file (auth.json, settings.json, MEMORY.md, …). */
export function configFile(agentDir: string, name: string): string {
	return join(agentDir, name);
}

/** `<agentDir>/state` -- durable machine-managed state. Deleting it loses real history, not just cache. */
export function stateDir(agentDir: string): string {
	return join(agentDir, "state");
}

/** `<agentDir>/state/<segments…>` */
export function stateFile(agentDir: string, ...segments: string[]): string {
	return join(stateDir(agentDir), ...segments);
}

/** `<agentDir>/cache` -- rebuildable; safe to delete (the next run just re-probes/recomputes). */
export function cacheDir(agentDir: string): string {
	return join(agentDir, "cache");
}

/** `<agentDir>/cache/<segments…>` */
export function cacheFile(agentDir: string, ...segments: string[]): string {
	return join(cacheDir(agentDir), ...segments);
}

/** `<agentDir>/bin` -- managed executable helpers (fd, rg). */
export function binDir(agentDir: string): string {
	return join(agentDir, "bin");
}

/** `<agentDir>/runtimes/<kind>` -- a managed runtime install (ollama, python, prism-llamacpp, needle, …). */
export function runtimesDir(kind: string, agentDir: string): string {
	return join(agentDir, "runtimes", kind);
}

/** `<agentDir>/models/<kind>` -- downloaded model weights, grouped by provider/runtime. */
export function modelsDir(kind: string, agentDir: string): string {
	return join(agentDir, "models", kind);
}

/** `<agentDir>/sessions` -- session transcript storage (large, established; not a "loose file"). */
export function sessionsDir(agentDir: string): string {
	return join(agentDir, "sessions");
}

/** `<agentDir>/npm` -- managed npm package installs. */
export function npmDir(agentDir: string): string {
	return join(agentDir, "npm");
}

/**
 * `<agentDir>/worktrees` -- lane worktree checkouts for the worktree-sync subsystem
 * (`core/worktree-sync/`), grouped as `worktrees/<repo-slug>/<laneKey>`. These hold REAL
 * uncommitted agent work, so they are durable like `state/` -- never under transient `work/`,
 * whose retention would silently eat in-progress code.
 */
export function worktreesDir(agentDir: string): string {
	return join(agentDir, "worktrees");
}

/** `<agentDir>/git` -- managed git-sourced package installs. */
export function gitDir(agentDir: string): string {
	return join(agentDir, "git");
}

export type AgentResourceKind = "skills" | "prompts" | "themes" | "extensions" | "profiles";

/** `<agentDir>/<kind>` -- a user-managed resource directory. Root, kept: moving it breaks users. */
export function resourceDir(kind: AgentResourceKind, agentDir: string): string {
	return join(agentDir, kind);
}

/**
 * `work/` is a mature transient/scratch root with its own tenant/run/lease/retention machinery
 * (`utils/work-directory.ts`). The SSOT delegates to it wholesale instead of reimplementing -- these
 * are straight re-exports so every category (state/cache/work/runtimes/models/…) is reachable from one
 * module without duplicating `work-directory.ts`'s logic.
 */
export {
	getWorkRoot,
	getWorkTenantDir,
	getWorkRunDir,
	getProcessWorkRun,
	acquireWorkRun,
	createWorkRunId,
	pruneWorkTenant,
};
export type { AcquireWorkRunOptions, WorkRetentionOptions, WorkRunLease } from "../utils/work-directory.ts";

/**
 * `work/reload-coordination` -- cross-process reload/live-op coordination state. Already correctly
 * work-scoped (defined in `reload-blockers.ts`, its natural home given the surrounding reload-gate
 * logic there); re-exported here under the taxonomy's canonical name for SSOT discoverability.
 */
export const reloadCoordinationDir = getReloadCoordinationDir;
