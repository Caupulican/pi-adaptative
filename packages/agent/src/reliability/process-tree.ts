/**
 * Process-tree kill primitives.
 *
 * WHY: node's ChildProcess.killed flag is set when a signal is sent, not when the
 * process exits. Graceful escalation therefore follows the spawned child's exit
 * event and a one-shot deadline; it never polls PID liveness.
 *
 * Group kill (-pid) requires the target to be a process-group leader (spawned with
 * detached: true). Both functions fall back to single-pid signaling otherwise.
 */
import { type ChildProcess, spawnSync } from "node:child_process";

const KILL_ACKNOWLEDGEMENT_MS = 1000;

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

function isChildTerminal(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

export interface KillTreeOptions {
	/** How long to wait for the child's exit event after SIGTERM before SIGKILL. Default 5000ms. */
	graceMs?: number;
}

export type KillTreeOutcome = "already_dead" | "terminated" | "killed";

/** Graceful tree kill: SIGTERM → child exit event or one-shot deadline → SIGKILL. */
export function killTree(child: ChildProcess, opts?: KillTreeOptions): Promise<KillTreeOutcome> {
	const pid = child.pid;
	if (pid === undefined || isChildTerminal(child)) return Promise.resolve("already_dead");

	return new Promise((resolve) => {
		let settled = false;
		let escalated = false;
		let escalationTimer: NodeJS.Timeout | undefined;
		let acknowledgementTimer: NodeJS.Timeout | undefined;

		const cleanup = () => {
			if (escalationTimer) clearTimeout(escalationTimer);
			if (acknowledgementTimer) clearTimeout(acknowledgementTimer);
			child.removeListener("exit", onExit);
			child.removeListener("error", onError);
		};
		const settle = (outcome: KillTreeOutcome) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(outcome);
		};
		const onExit = () => settle(escalated ? "killed" : "terminated");
		const onError = () => settle(escalated ? "killed" : "already_dead");

		child.once("exit", onExit);
		child.once("error", onError);
		if (isChildTerminal(child)) {
			settle("already_dead");
			return;
		}

		if (process.platform === "win32") {
			escalated = true;
			killTreeNow(pid);
			acknowledgementTimer = setTimeout(() => {
				child.unref();
				settle("killed");
			}, KILL_ACKNOWLEDGEMENT_MS);
			acknowledgementTimer.unref();
			return;
		}

		if (!signalTree(pid, "SIGTERM")) {
			settle("already_dead");
			return;
		}
		const graceMs = Math.max(0, opts?.graceMs ?? 5000);
		escalationTimer = setTimeout(() => {
			escalationTimer = undefined;
			if (isChildTerminal(child)) {
				settle("terminated");
				return;
			}
			escalated = true;
			if (!signalTree(pid, "SIGKILL")) {
				settle("terminated");
				return;
			}
			acknowledgementTimer = setTimeout(() => {
				child.unref();
				settle("killed");
			}, KILL_ACKNOWLEDGEMENT_MS);
			acknowledgementTimer.unref();
		}, graceMs);
		escalationTimer.unref();
	});
}

/** Immediate tree kill (SIGKILL / synchronous taskkill). */
export function killTreeNow(pid: number): void {
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
			stdio: "ignore",
			timeout: 10_000,
			windowsHide: true,
		});
	} else {
		signalTree(pid, "SIGKILL");
	}
}
