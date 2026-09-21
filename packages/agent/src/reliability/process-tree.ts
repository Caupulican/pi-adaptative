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
import { join } from "node:path";
import { readProcessTerminationProtection } from "./process-termination-protection.ts";

const KILL_ACKNOWLEDGEMENT_MS = 1000;

/**
 * What a `kill(pid, 0)` probe established. ESRCH is the ONLY answer that proves absence; every other
 * failure means the probe could not determine anything, which is not the same as death.
 */
export type ProcessLivenessProbe = "alive" | "dead" | "unknown";
export type ProcessObservation = ProcessLivenessProbe;
export type ProcessKillProbe = (pid: number, signal: 0) => unknown;

/** Positive safe integers only. Zero, negatives, and non-integers must never reach `kill(pid, 0)`. */
export function isPositiveSafePid(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * The single raw OS liveness rule for this repository. Consumers that need to distinguish "could not
 * tell" from "confirmed gone" — recovery, ownership takeover, termination claims — must read this
 * rather than re-deriving the classification from `process.kill`.
 */
export function probeProcessLiveness(
	pid: number,
	kill: ProcessKillProbe = (target) => process.kill(target, 0),
): ProcessLivenessProbe {
	if (!isPositiveSafePid(pid)) return "unknown";
	try {
		kill(pid, 0);
		return "alive";
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return "dead";
		// EPERM means it exists but we lack permission — still alive.
		if (code === "EPERM") return "alive";
		return "unknown";
	}
}

/**
 * Conservative boolean view of {@link probeProcessLiveness}.
 *
 * BOUND: `false` means ESRCH — proven absence. `true` means "not proven absent", which covers both a
 * confirmed live process and a probe that failed for an unclassified reason. A caller must never read
 * `true` as proof of liveness, and must never treat this boolean as authority to take over an owner;
 * for that, read the three-valued probe and keep `unknown` unavailable.
 */
export function isProcessAlive(pid: number): boolean {
	return probeProcessLiveness(pid) !== "dead";
}

/**
 * What a signal attempt established about the target, never what it did to it.
 * - `delivered`: the signal was accepted for delivery. It says nothing about termination.
 * - `gone`: every attempt answered ESRCH, the only error that proves absence.
 * - `failed`: the signal could not be sent (EPERM, or any unclassified error). The target's state
 *   is unknown and must stay that way.
 */
type SignalDelivery = "delivered" | "gone" | "failed";

function classifySignalError(error: unknown): "gone" | "failed" {
	return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "failed";
}

/**
 * The handle a caller holds for a process it spawned. Ownership of a live handle, not the host's
 * ancestry, authorizes terminating that process tree; see {@link authorizeOwnedTermination}.
 */
export type OwnedProcessHandle = Pick<ChildProcess, "pid" | "exitCode" | "signalCode">;

/** Never turn a malformed PID into POSIX group/broadcast semantics or kill our own host. */
function isInvalidTerminationPid(pid: number, onDiagnostic?: (message: string) => void): boolean {
	if (!isPositiveSafePid(pid) || pid > 2_147_483_647) {
		onDiagnostic?.(`Process target ${pid} is not a valid termination PID`);
		return true;
	}
	if (pid === 1 || pid === process.pid || pid === process.ppid) {
		onDiagnostic?.(`Process target ${pid} is the system root, calling process, or direct parent`);
		return true;
	}
	return false;
}

/**
 * A pid-only request proves nothing about the target, so the host's ancestry decides: an unknown
 * ancestry refuses, and a protected ancestor or process group refuses.
 */
function isProtectedTerminationTarget(pid: number, onDiagnostic?: (message: string) => void): boolean {
	if (isInvalidTerminationPid(pid, onDiagnostic)) return true;
	const protectedIds = readProcessTerminationProtection(onDiagnostic);
	if (protectedIds === undefined) return true;
	if (protectedIds.has(pid)) {
		onDiagnostic?.(`Process target ${pid} is a protected ancestor or process group`);
		return true;
	}
	return false;
}

/**
 * A live process this process spawned cannot be its host, an ancestor, or its process group: every
 * ancestor predates the child, live PIDs are unique, and a PID still in use as a group or session
 * id is never reissued while that use lasts. Ownership of the live handle therefore authorizes the
 * tree kill by itself. Reading the host's ancestry here adds nothing but an observer that can fail,
 * and on Windows that observer is a cold PowerShell/CIM enumeration a loaded host pushes past its
 * bound, which used to refuse the harness its own children. The ancestry gate stays where it means
 * something: pid-only requests ({@link killTreeNow} with a number).
 *
 * Returns the pid to signal, or undefined when the handle is not a live, valid target.
 */
function authorizeOwnedTermination(
	child: OwnedProcessHandle,
	onDiagnostic?: (message: string) => void,
): number | undefined {
	const pid = child.pid;
	if (pid === undefined || isChildTerminal(child)) return undefined;
	return isInvalidTerminationPid(pid, onDiagnostic) ? undefined : pid;
}

/**
 * Signal the process group, falling back to the pid itself. The target is already authorized:
 * either an owned live handle or a pid that passed the ancestry gate.
 *
 * `gone` requires BOTH attempts to answer ESRCH. A missing group followed by a denied direct signal
 * (or vice versa) is a contradiction, not proof of death: the surviving evidence says the pid is
 * still there and merely unreachable, so the result stays `failed` and the caller keeps its
 * uncertainty.
 */
function signalAuthorizedTree(pid: number, signal: NodeJS.Signals): SignalDelivery {
	let groupOutcome: "gone" | "failed";
	try {
		process.kill(-pid, signal);
		return "delivered";
	} catch (err) {
		groupOutcome = classifySignalError(err);
	}
	try {
		process.kill(pid, signal);
		return "delivered";
	} catch (err) {
		return groupOutcome === "gone" && classifySignalError(err) === "gone" ? "gone" : "failed";
	}
}

function isChildTerminal(child: OwnedProcessHandle): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

/**
 * The single rule both platforms settle by once a signal has been sent and no exit event arrived.
 *
 * Only the child's own terminal state or a liveness probe may end the wait; the fact that a signal
 * was sent, or that an error event fired, is never evidence of termination. win32 and POSIX have
 * identical semantics here, so this lives in one place rather than being duplicated as a fallback.
 */
function settleFromEvidence(child: ChildProcess, pid: number, escalated: boolean): KillTreeOutcome {
	if (isChildTerminal(child)) return escalated ? "killed" : "terminated";
	if (isProcessAlive(pid)) return "failed";
	return escalated ? "killed" : "terminated";
}

export interface KillTreeOptions {
	/** How long to wait for the child's exit event after SIGTERM before SIGKILL. Default 5000ms. */
	graceMs?: number;
	/** Optional callback for diagnostic warnings during process termination. */
	onDiagnostic?: (diagnostic: string) => void;
}

export type KillTreeOutcome = "already_dead" | "terminated" | "killed" | "failed";

export interface KillTreeNowResult {
	success: boolean;
	error?: string;
}

/** Graceful tree kill: SIGTERM → child exit event or one-shot deadline → SIGKILL. */
export function killTree(child: ChildProcess, opts?: KillTreeOptions): Promise<KillTreeOutcome> {
	if (child.pid === undefined || isChildTerminal(child)) return Promise.resolve("already_dead");
	const pid = authorizeOwnedTermination(child, opts?.onDiagnostic);
	if (pid === undefined) {
		opts?.onDiagnostic?.(`Refusing to terminate invalid process target ${child.pid}`);
		return Promise.resolve("failed");
	}

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
		// A child "error" event is a failure to spawn/signal/communicate, never an exit: exitCode and
		// signalCode both stay null. Settle from evidence instead of reading it as a death.
		const onError = (err: Error) => {
			opts?.onDiagnostic?.(`Process tree ${pid} reported an error while terminating: ${err.message}`);
			settle(settleFromEvidence(child, pid, escalated));
		};

		child.once("exit", onExit);
		child.once("error", onError);
		if (isChildTerminal(child)) {
			settle("already_dead");
			return;
		}

		if (process.platform === "win32") {
			escalated = true;
			const outcome = taskkillTree(pid);
			if (!outcome.success && outcome.error) {
				opts?.onDiagnostic?.(`Windows taskkill failed: ${outcome.error}`);
			}
			acknowledgementTimer = setTimeout(() => {
				child.unref();
				const settlement = settleFromEvidence(child, pid, escalated);
				if (settlement === "failed" && outcome.success) {
					opts?.onDiagnostic?.(`Windows taskkill reported success but PID ${pid} remains alive`);
				}
				settle(settlement);
			}, KILL_ACKNOWLEDGEMENT_MS);
			acknowledgementTimer.unref();
			return;
		}

		const termDelivery = signalAuthorizedTree(pid, "SIGTERM");
		if (termDelivery === "gone") {
			settle("already_dead");
			return;
		}
		if (termDelivery === "failed") {
			// The signal could not be sent, so nothing was established about the tree. Reporting a
			// death here would be a claim the caller cannot check.
			opts?.onDiagnostic?.(`Failed to send SIGTERM to process tree ${pid}; termination is unproven`);
			settle("failed");
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
			const killDelivery = signalAuthorizedTree(pid, "SIGKILL");
			if (killDelivery === "failed") {
				// The signal never reached the GROUP, so the descendants it targets were never observed.
				// The root pid's own liveness has a narrower scope and cannot stand in for them: a group
				// can still hold live children after its leader exits. Preserve the delivery verdict.
				opts?.onDiagnostic?.(`Failed to send SIGKILL to process tree ${pid}; termination is unproven`);
				settle("failed");
				return;
			}
			if (killDelivery === "gone") {
				// Every attempt answered ESRCH: that is positive absence for the group and the pid alike.
				settle(settleFromEvidence(child, pid, escalated));
				return;
			}
			acknowledgementTimer = setTimeout(() => {
				child.unref();
				// A delivered SIGKILL is not an exit. The win32 branch already re-checks liveness here;
				// this is the same rule, not a second implementation of it.
				settle(settleFromEvidence(child, pid, escalated));
			}, KILL_ACKNOWLEDGEMENT_MS);
			acknowledgementTimer.unref();
		}, graceMs);
		escalationTimer.unref();
	});
}

/** Windows tree kill for an authorized pid: synchronous `taskkill /F /T`. */
function taskkillTree(pid: number): KillTreeNowResult {
	const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
	const result = spawnSync(taskkill, ["/F", "/T", "/PID", String(pid)], {
		stdio: "ignore",
		timeout: 10_000,
		windowsHide: true,
	});
	if (result.error) {
		return { success: false, error: result.error.message };
	}
	if (result.status !== 0) {
		return { success: false, error: `taskkill exited with code ${result.status}` };
	}
	return { success: true };
}

/**
 * Immediate tree kill (SIGKILL / synchronous taskkill).
 *
 * An owned live handle is authorized by ownership; a bare pid must pass the ancestry gate, which
 * refuses the host, its ancestors, its process groups, and any target whose ancestry cannot be read.
 */
export function killTreeNow(target: number | OwnedProcessHandle): KillTreeNowResult {
	let refusal: string | undefined;
	const onDiagnostic = (message: string) => {
		refusal = message;
	};
	let pid: number | undefined;
	if (typeof target === "number") {
		pid = isProtectedTerminationTarget(target, onDiagnostic) ? undefined : target;
		if (pid === undefined) {
			return {
				success: false,
				error: `Refusing to terminate protected, invalid, or unverified process target ${target}${refusal ? `: ${refusal}` : ""}`,
			};
		}
	} else {
		if (target.pid !== undefined && isChildTerminal(target)) {
			return { success: false, error: `Owned process ${target.pid} already exited; nothing was signalled` };
		}
		pid = authorizeOwnedTermination(target, onDiagnostic);
		if (pid === undefined) {
			return {
				success: false,
				error: `Refusing to terminate invalid owned process target ${target.pid}${refusal ? `: ${refusal}` : ""}`,
			};
		}
	}
	if (process.platform === "win32") return taskkillTree(pid);
	// `success` means the signal was delivered, never that the tree is proven gone; the caller still
	// owns confirming termination.
	const success = signalAuthorizedTree(pid, "SIGKILL") === "delivered";
	return { success, ...(success ? {} : { error: "Failed to send SIGKILL" }) };
}
