/**
 * Process-tree kill primitives.
 *
 * WHY: node's ChildProcess.killed flag is set the moment a signal is SENT, not when
 * the process dies — gating SIGKILL escalation on it (as the legacy exec path did)
 * makes escalation dead code, so a SIGTERM-trapping child survives forever. These
 * primitives escalate based on actual liveness probes instead.
 *
 * Group kill (-pid) requires the target to be a process-group leader (spawned with
 * detached: true). Both functions fall back to single-pid signaling otherwise.
 */
import { spawn } from "node:child_process";

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means it exists but we lack permission — still alive.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function signalTree(pid: number, signal: NodeJS.Signals): boolean {
	try {
		process.kill(-pid, signal);
		return true;
	} catch {
		try {
			process.kill(pid, signal);
			return true;
		} catch {
			return false;
		}
	}
}

export interface KillTreeOptions {
	/** How long to wait for SIGTERM to work before SIGKILL. Default 5000ms. */
	graceMs?: number;
}

/** Graceful tree kill: SIGTERM → poll liveness → SIGKILL. */
export async function killTree(pid: number, opts?: KillTreeOptions): Promise<"already_dead" | "terminated" | "killed"> {
	if (process.platform === "win32") {
		if (!isProcessAlive(pid)) return "already_dead";
		killTreeNow(pid);
		return "killed";
	}
	if (!isProcessAlive(pid)) return "already_dead";
	signalTree(pid, "SIGTERM");
	const graceMs = opts?.graceMs ?? 5000;
	const deadline = Date.now() + graceMs;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) return "terminated";
		await new Promise((resolve) => setTimeout(resolve, Math.min(50, graceMs)));
	}
	if (!isProcessAlive(pid)) return "terminated";
	signalTree(pid, "SIGKILL");
	return "killed";
}

/** Immediate tree kill (SIGKILL / taskkill). Port of coding-agent's killProcessTree. */
export function killTreeNow(pid: number): void {
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", detached: true, windowsHide: true });
		} catch {
			// Ignore errors if taskkill fails.
		}
	} else {
		signalTree(pid, "SIGKILL");
	}
}
