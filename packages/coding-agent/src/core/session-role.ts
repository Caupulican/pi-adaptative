/**
 * Session-role identity: distinguishes a MAIN session (an interactive/direct `pi` session) from a
 * WORKER session (lane-bound or explicitly dispatched) — the seam every worker-scoped UAC ceiling
 * and zero-footprint store gates on (see runtime-builder.ts's `isAllowedTool`, the worktree_sync
 * tool's worker scoping, and the read-only store options threaded through the persistence layer).
 *
 * A session is a worker iff EITHER:
 * - `PI_SESSION_ROLE=worker` is set (an explicit launcher declaration),
 * - a valid `PI_PARENT_PID` declares this process as a managed child, or
 * - it is bound to a worktree-sync lane (`PI_WORKTREE_LANE`; see worktree-sync/runtime.ts) — a
 *   lane-bound session is a worker by construction, regardless of how it was launched.
 *
 * `PI_SESSION_ROLE=main` is deliberately NOT an escalation: it can never override a bound lane.
 * There is no environment value a lane-bound process can set to shed the worker ceiling — the env
 * var is additive evidence for "worker", never a downgrade signal.
 */

import { getParentPid } from "./process-identity.ts";
import { getBoundWorktreeLaneKey } from "./worktree-sync/runtime.ts";

export type SessionRole = "main" | "worker";
export type TerminalSessionMode = "user" | "worker";

export const PI_SESSION_ROLE_ENV = "PI_SESSION_ROLE";

export function isTerminalSessionMode(value: string): value is TerminalSessionMode {
	return value === "user" || value === "worker";
}

/** Apply the terminal audience declaration without bypassing worker inference or UAC ceilings. */
export function setTerminalSessionMode(mode: TerminalSessionMode, env: NodeJS.ProcessEnv = process.env): void {
	if (mode === "worker") {
		env[PI_SESSION_ROLE_ENV] = "worker";
	} else if (env[PI_SESSION_ROLE_ENV] !== "worker") {
		env[PI_SESSION_ROLE_ENV] = "main";
	}
}

/** Derive this process's session role from the environment (env-injectable for tests). */
export function getSessionRole(env: NodeJS.ProcessEnv = process.env): SessionRole {
	if (env[PI_SESSION_ROLE_ENV] === "worker") return "worker";
	if (getParentPid(env) !== undefined) return "worker";
	if (getBoundWorktreeLaneKey(env) !== undefined) return "worker";
	return "main";
}

/** True iff this process is a worker session (lane-bound or explicitly declared). */
export function isWorkerSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return getSessionRole(env) === "worker";
}

/**
 * Tools a worker session may never activate: agent launchers plus root-owned reflection, memory,
 * and machine credential state. The legacy `goal` tool is excluded because its composite action
 * surface can dispatch workers; the non-dispatching create/get/update lifecycle tools remain
 * eligible. `bash` and `python` remain available as explicit host-trust boundaries; the structural
 * path envelope does not confine arbitrary process code, and banning one execution route while
 * retaining the other would not create a meaningful filesystem boundary.
 */
export const WORKER_FORBIDDEN_TOOLS: ReadonlySet<string> = new Set([
	"goal",
	"secret_store",
	"memory",
	"delegate",
	"improvement_loop",
	"model_fitness",
	"tmux_agent_manager",
	"context_scout",
]);
