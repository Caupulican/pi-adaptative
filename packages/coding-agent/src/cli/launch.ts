/**
 * What a launch is, decided from its arguments and environment alone. Kept free of the session
 * program so the entry point can decide before loading it: a supervised interactive launch runs the
 * session in a child process, and the parent that only supervises it must not pay for importing the
 * whole program first.
 */

import { PI_PARENT_PID_ENV, PI_PARENT_SESSION_ENV, PI_TASK_REF_ENV } from "../core/process-identity.ts";
import { getSessionRole, setTerminalSessionMode } from "../core/session-role.ts";
import { PI_WORKTREE_LANE_ENV } from "../core/worktree-sync/lane-binding.ts";
import { type Args, resolveAppMode } from "./args.ts";

/** First arguments that run a command instead of a session. */
const COMMAND_ARGUMENTS = new Set([
	"--collaboration-peer",
	"--collaboration-worker",
	"doctor",
	"install",
	"remove",
	"uninstall",
	"update",
	"list",
	"config",
	"auth",
]);

export function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

/**
 * CLI sugar over the cross-process environment contract: the flags and a launcher-provided env are
 * byte-identical downstream (the lane gate, the process-matrix worker branch, child processes).
 */
export function applyLaunchEnvironment(parsed: Args, env: NodeJS.ProcessEnv = process.env): void {
	if (parsed.worktreeLane) env[PI_WORKTREE_LANE_ENV] = parsed.worktreeLane;
	if (parsed.parentPid !== undefined) env[PI_PARENT_PID_ENV] = String(parsed.parentPid);
	if (parsed.parentSession) env[PI_PARENT_SESSION_ENV] = parsed.parentSession;
	if (parsed.taskRef) env[PI_TASK_REF_ENV] = parsed.taskRef;
	if (parsed.sessionMode) setTerminalSessionMode(parsed.sessionMode, env);
}

/**
 * Whether this launch is an operator's interactive session that runs under runtime supervision: an
 * interactive terminal session of the main role, not a command, not a listing or export, and not a
 * startup benchmark (which measures the session in-process). Reads the environment the launch will
 * have, without changing the process's own.
 */
export function isSupervisedInteractiveLaunch(
	args: readonly string[],
	parsed: Args,
	env: NodeJS.ProcessEnv,
	stdinIsTTY: boolean | undefined,
): boolean {
	if (COMMAND_ARGUMENTS.has(args[0] ?? "")) return false;
	if (parsed.diagnostics.some((diagnostic) => diagnostic.type === "error")) return false;
	if (resolveAppMode(parsed, stdinIsTTY) !== "interactive") return false;
	if (parsed.help || parsed.listModels !== undefined || parsed.export) return false;
	if (isTruthyEnvFlag(env.PI_STARTUP_BENCHMARK)) return false;
	const launchEnv = { ...env };
	applyLaunchEnvironment(parsed, launchEnv);
	return getSessionRole(launchEnv) === "main";
}
