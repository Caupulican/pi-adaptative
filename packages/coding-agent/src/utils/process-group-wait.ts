/**
 * Shared-worktree process calls own a tracked tree.
 * A one-shot leader is a process group. The tool returns only after that group is empty.
 * A persistent shell stays the group leader, so its direct children are the tracked set.
 * procfs does not emit inotify, so a remaining member is waited on with pidfd, not a timer.
 * A tree that cannot be observed does not look successful.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { parseLinuxProcessStat } from "../kernel/reliability/process-termination-protection.ts";
import { isInvalidTerminationPid, isPositiveSafePid } from "../kernel/reliability/process-tree.ts";
import {
	type ChildProcessTerminationOptions,
	type ChildProcessTerminationResult,
	waitForChildProcessWithTermination,
} from "./child-process.ts";

const PYTHON = "python3";
const PROCESS_GROUP_KILL_ACKNOWLEDGEMENT_MS = 1_000;
const PIDFD_WAIT = [
	"import errno, os, select, sys",
	"poller = select.poll()",
	"open_fds = []",
	"for raw in sys.argv[1:]:",
	"    pid = int(raw)",
	"    try:",
	"        fd = os.pidfd_open(pid)",
	"    except OSError as exc:",
	"        if exc.errno == errno.ESRCH:",
	"            continue",
	"        raise SystemExit(2)",
	"    except AttributeError:",
	"        raise SystemExit(2)",
	"    poller.register(fd, select.POLLIN)",
	"    open_fds.append(fd)",
	"if not open_fds:",
	"    raise SystemExit(0)",
	"remaining = len(open_fds)",
	"while remaining:",
	"    events = poller.poll()",
	"    if not events:",
	"        raise SystemExit(2)",
	"    for fd, _mask in events:",
	"        poller.unregister(fd)",
	"        remaining -= 1",
	"        os.close(fd)",
	"raise SystemExit(0)",
	"",
].join("\n");

const untrackedDirectories = new Set<string>();
const NO_IGNORED_PROCESS_IDS: ReadonlySet<number> = new Set<number>();

export class ProcessTreeUntrackedError extends Error {
	constructor(detail: string) {
		super(`process_tree_untracked: ${detail}`);
		this.name = "ProcessTreeUntrackedError";
	}
}

export function consumeProcessTreeUntracked(cwd: string): boolean {
	let found = false;
	for (const recorded of untrackedDirectories) {
		if (recorded === cwd || recorded.startsWith(`${cwd}/`) || cwd.startsWith(`${recorded}/`)) {
			untrackedDirectories.delete(recorded);
			found = true;
		}
	}
	return found;
}

function noteProcessTreeUntracked(cwd: string): void {
	untrackedDirectories.add(cwd);
}

function errorCode(error: unknown): string {
	const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
	return typeof code === "string" ? code : "error";
}

/**
 * A process group this process created, and the only authority for signalling `-groupId`.
 *
 * The creator claims it in the same synchronous turn as `spawn(..., { detached: true })`: libuv runs
 * `setsid()` in the child before `spawn` returns and reaps children only from the event loop, so the
 * leader is still unreaped and its `/proc` record is the leader's own. A claim records the leader's
 * start time and requires pgid == sid == pid; anything else stays unproven and is never signalled.
 *
 * By the time the group is killed the leader has usually exited, so a handle-based kill refuses the
 * terminal handle and a bare-pid kill would gate an id that is not a bare pid. While any member lives
 * the kernel never reissues the id, so the residual hazard is the id being reissued after the group
 * emptied. Every group signal and probe therefore passes {@link observeOwnedGroup}: a live process
 * at the id with a different start time proves reissue, and so proves this group already ended.
 * Once the group is observed empty it is `ended` and no later signal may use the id.
 *
 * Residual (Linux): between the identity read and `kill(-id)` a group that empties and whose id is
 * reissued within that window cannot be distinguished; closing it needs `pidfd_send_signal` with
 * `PIDFD_SIGNAL_PROCESS_GROUP`, which Node does not expose. Without procfs (darwin) the claim rests
 * on the detached spawn alone.
 */
interface OwnedProcessGroup {
	readonly groupId: number;
	/** The leader's `/proc/<pid>/stat` start time at claim; undefined where procfs is absent. */
	readonly leaderStartTime: string | undefined;
	/** Why the group is not provably owned; destructive signals refuse while set. */
	readonly unproven: string | undefined;
	ended: boolean;
}

const ownedProcessGroups = new WeakMap<ChildProcess, OwnedProcessGroup>();

type OwnedGroupKill = { outcome: "delivered" } | { outcome: "gone" } | { outcome: "failed"; detail: string };

function isAbsentProcessError(error: unknown): boolean {
	const code = errorCode(error);
	return code === "ENOENT" || code === "ESRCH";
}

function observeLeader(child: ChildProcess, pid: number): OwnedProcessGroup {
	const unproven = (reason: string): OwnedProcessGroup => ({
		groupId: pid,
		leaderStartTime: undefined,
		unproven: reason,
		ended: false,
	});
	if (isInvalidTerminationPid(pid)) return unproven(`leader ${pid} is not a valid termination target`);
	if (child.exitCode !== null || child.signalCode !== null) {
		return unproven(`leader ${pid} was reaped before its group was claimed`);
	}
	if (process.platform !== "linux")
		return { groupId: pid, leaderStartTime: undefined, unproven: undefined, ended: false };
	let text: string;
	try {
		text = readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch (error) {
		return unproven(`leader ${pid} is not observable (${errorCode(error)})`);
	}
	const stat = parseLinuxProcessStat(pid, text);
	if (!stat) return unproven(`leader ${pid} has a malformed stat record`);
	if (stat.groupId !== pid || stat.sessionId !== pid) {
		return unproven(
			`leader ${pid} does not lead its own process group (pgid ${stat.groupId}, sid ${stat.sessionId})`,
		);
	}
	return { groupId: pid, leaderStartTime: stat.startTime, unproven: undefined, ended: false };
}

/**
 * Record the group a detached spawn just created. Must run in the same synchronous turn as `spawn`.
 * Idempotent per handle; a no-op on Windows and for a spawn that produced no pid.
 */
export function claimOwnedProcessGroup(child: ChildProcess): void {
	if (process.platform === "win32" || ownedProcessGroups.has(child)) return;
	const pid = child.pid;
	if (pid === undefined) return;
	ownedProcessGroups.set(child, observeLeader(child, pid));
}

/** The one identity rule every signal and probe of `-groupId` passes. Throws when it cannot tell. */
function observeOwnedGroup(group: OwnedProcessGroup): "present" | "ended" {
	if (group.ended) return "ended";
	if (group.leaderStartTime === undefined) return "present";
	let text: string;
	try {
		text = readFileSync(`/proc/${group.groupId}/stat`, "utf8");
	} catch (error) {
		// The leader is reaped; surviving members still reserve the id, so the group is unchanged.
		if (isAbsentProcessError(error)) return "present";
		throw new ProcessTreeUntrackedError(`process group ${group.groupId} is not observable (${errorCode(error)})`);
	}
	const stat = parseLinuxProcessStat(group.groupId, text);
	if (!stat) throw new ProcessTreeUntrackedError(`process group ${group.groupId} has a malformed leader record`);
	if (stat.startTime === group.leaderStartTime) return "present";
	group.ended = true;
	return "ended";
}

function groupGone(group: OwnedProcessGroup): boolean {
	if (observeOwnedGroup(group) === "ended") return true;
	try {
		process.kill(-group.groupId, 0);
		return false;
	} catch (error) {
		if (errorCode(error) !== "ESRCH") {
			throw new ProcessTreeUntrackedError(`process group ${group.groupId} is not observable (${errorCode(error)})`);
		}
		group.ended = true;
		return true;
	}
}

/** The single destructive group signal. Never throws: abort listeners call it synchronously. */
function killOwnedGroup(group: OwnedProcessGroup): OwnedGroupKill {
	if (group.unproven !== undefined) {
		return { outcome: "failed", detail: `process group ${group.groupId} is not provably owned: ${group.unproven}` };
	}
	let refusal: string | undefined;
	if (
		isInvalidTerminationPid(group.groupId, (message) => {
			refusal = message;
		})
	) {
		return { outcome: "failed", detail: refusal ?? `process group ${group.groupId} is not a valid target` };
	}
	try {
		if (observeOwnedGroup(group) === "ended") return { outcome: "gone" };
	} catch (error) {
		return { outcome: "failed", detail: error instanceof Error ? error.message : String(error) };
	}
	try {
		process.kill(-group.groupId, "SIGKILL");
		return { outcome: "delivered" };
	} catch (error) {
		if (errorCode(error) !== "ESRCH") {
			return {
				outcome: "failed",
				detail: `process group ${group.groupId} could not be signalled (${errorCode(error)})`,
			};
		}
		group.ended = true;
		return { outcome: "gone" };
	}
}

function membersOfGroup(groupId: number): number[] {
	let names: string[];
	try {
		names = readdirSync("/proc");
	} catch (error) {
		throw new ProcessTreeUntrackedError(`cannot read /proc (${errorCode(error)})`);
	}
	const members: number[] = [];
	for (const name of names) {
		if (!/^\d+$/.test(name)) continue;
		let text: string;
		try {
			text = readFileSync(`/proc/${name}/stat`, "utf8");
		} catch {
			continue;
		}
		if (parseLinuxProcessStat(Number(name), text)?.groupId === groupId) members.push(Number(name));
	}
	return members;
}

function readChildPids(pid: number): number[] {
	try {
		const text = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8");
		return text
			.split(/\s+/)
			.map((value) => Number(value))
			.filter((value) => Number.isInteger(value) && value > 0);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return [];
		throw new ProcessTreeUntrackedError(`cannot read children of ${pid} (${errorCode(error)})`);
	}
}

function waitForPidExitEvent(pids: readonly number[], signal?: AbortSignal): Promise<void> {
	if (pids.length === 0) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const child = spawn(PYTHON, ["-c", PIDFD_WAIT, ...pids.map((pid) => String(pid))], {
			stdio: "ignore",
			windowsHide: true,
		});
		let settled = false;
		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			if (error) reject(error);
			else resolve();
		};
		const onAbort = (): void => finish(new Error("aborted"));
		if (signal?.aborted) {
			finish(new Error("aborted"));
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		child.once("error", () => finish(new ProcessTreeUntrackedError("process exit event is unavailable")));
		child.once("exit", (code) => {
			if (settled) return;
			if (code === 0) finish();
			else finish(new ProcessTreeUntrackedError("process exit event is unavailable"));
		});
	});
}

async function waitForObservableProcessGroupExit(
	group: OwnedProcessGroup,
	phase: "exit" | "cancellation",
	signal?: AbortSignal,
): Promise<"exited" | "aborted"> {
	const pid = group.groupId;
	let previousKey = "";
	while (!groupGone(group)) {
		if (process.platform !== "linux") {
			throw new ProcessTreeUntrackedError(
				phase === "exit"
					? `process group ${pid} outlived its leader`
					: `process group ${pid} did not confirm cancellation`,
			);
		}
		const members = membersOfGroup(pid);
		if (members.length === 0) {
			if (groupGone(group)) return "exited";
			throw new ProcessTreeUntrackedError(`process group ${pid} is live but has no readable members`);
		}
		const key = members.join(",");
		if (key === previousKey) {
			if (groupGone(group)) return "exited";
			throw new ProcessTreeUntrackedError(`process group ${pid} remained after its ${phase} event`);
		}
		previousKey = key;
		try {
			await waitForPidExitEvent(members, signal);
		} catch (error) {
			if (signal?.aborted) return "aborted";
			throw error;
		}
	}
	return "exited";
}

async function waitForProcessGroupExit(group: OwnedProcessGroup, signal?: AbortSignal): Promise<void> {
	let abortKill: OwnedGroupKill | undefined;
	const killGroup = (): void => {
		abortKill = killOwnedGroup(group);
	};
	if (signal?.aborted) killGroup();
	else signal?.addEventListener("abort", killGroup, { once: true });
	try {
		if ((await waitForObservableProcessGroupExit(group, "exit", signal)) === "exited") return;
		if (abortKill?.outcome === "gone" || groupGone(group)) return;
		if (abortKill?.outcome !== "delivered") {
			throw new ProcessTreeUntrackedError(
				`process group ${group.groupId} could not be killed after cancellation: ${abortKill?.outcome === "failed" ? abortKill.detail : "no kill was attempted"}`,
			);
		}
		await waitForKilledProcessGroupExit(group);
	} finally {
		signal?.removeEventListener("abort", killGroup);
	}
}

/** A delivered SIGKILL still needs a bounded terminal acknowledgement. */
async function waitForKilledProcessGroupExit(group: OwnedProcessGroup): Promise<void> {
	const acknowledgement = new AbortController();
	const timeout = setTimeout(() => acknowledgement.abort(), PROCESS_GROUP_KILL_ACKNOWLEDGEMENT_MS);
	timeout.unref?.();
	try {
		if ((await waitForObservableProcessGroupExit(group, "cancellation", acknowledgement.signal)) === "exited") return;
		if (groupGone(group)) return;
		throw new ProcessTreeUntrackedError(
			`process group ${group.groupId} did not exit within ${PROCESS_GROUP_KILL_ACKNOWLEDGEMENT_MS}ms after cancellation`,
		);
	} finally {
		clearTimeout(timeout);
	}
}

async function awaitOwnedProcessGroup(child: ChildProcess, cwd: string, signal?: AbortSignal): Promise<void> {
	const group = ownedProcessGroups.get(child);
	if (!group) return;
	try {
		await waitForProcessGroupExit(group, signal);
	} catch (error) {
		if (error instanceof ProcessTreeUntrackedError) noteProcessTreeUntracked(cwd);
		throw error;
	}
}

/**
 * One deadline owner for the leader and every process that remains in its owned group. Callers pass
 * the handle in the same synchronous turn as its detached spawn; this claims the group first.
 */
export async function waitForOwnedProcessTreeWithTermination(
	child: ChildProcess,
	cwd: string,
	options: ChildProcessTerminationOptions = {},
): Promise<ChildProcessTerminationResult> {
	claimOwnedProcessGroup(child);
	const lifecycle = new AbortController();
	let requestedReason: "aborted" | "timeout" | undefined;
	let timeout: NodeJS.Timeout | undefined;
	const requestTermination = (reason: "aborted" | "timeout"): void => {
		if (requestedReason !== undefined) return;
		requestedReason = reason;
		lifecycle.abort();
	};
	const onAbort = (): void => requestTermination("aborted");
	if (options.signal?.aborted) onAbort();
	else options.signal?.addEventListener("abort", onAbort, { once: true });
	if (options.timeoutMs !== undefined) {
		timeout = setTimeout(() => requestTermination("timeout"), Math.max(0, options.timeoutMs));
		timeout.unref();
	}
	try {
		const terminal = await waitForChildProcessWithTermination(child, {
			signal: lifecycle.signal,
			killGraceMs: options.killGraceMs,
			onDiagnostic: options.onDiagnostic,
		});
		await awaitOwnedProcessGroup(child, cwd, lifecycle.signal);
		return { code: terminal.code, reason: requestedReason ?? terminal.reason };
	} finally {
		if (timeout) clearTimeout(timeout);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

export async function awaitOwnedProcessDescendants(
	pid: number | undefined,
	cwd: string,
	signal?: AbortSignal,
	ignoredPids: ReadonlySet<number> = NO_IGNORED_PROCESS_IDS,
): Promise<void> {
	if (process.platform !== "linux" || !isPositiveSafePid(pid)) return;
	try {
		let previousKey = "";
		for (;;) {
			if (signal?.aborted) throw new Error("aborted");
			const children = readChildPids(pid).filter((childPid) => !ignoredPids.has(childPid));
			if (children.length === 0) return;
			const key = children.join(",");
			if (key === previousKey) {
				throw new ProcessTreeUntrackedError(`descendants of ${pid} remained after their exit event`);
			}
			previousKey = key;
			await waitForPidExitEvent(children, signal);
		}
	} catch (error) {
		if (signal?.aborted) throw new Error("aborted");
		if (error instanceof ProcessTreeUntrackedError) noteProcessTreeUntracked(cwd);
		throw error;
	}
}

/** The shell itself is gone, so anything left in its group is no longer a tracked session. */
export async function reapOwnedProcessGroup(child: ChildProcess, cwd: string): Promise<void> {
	if (process.platform === "win32" || child.pid === undefined) return;
	try {
		const group = ownedProcessGroups.get(child);
		if (!group) throw new ProcessTreeUntrackedError(`process group ${child.pid} was never claimed by its creator`);
		const kill = killOwnedGroup(group);
		if (kill.outcome === "gone") return;
		if (kill.outcome === "failed") throw new ProcessTreeUntrackedError(kill.detail);
		await waitForProcessGroupExit(group);
	} catch (error) {
		if (error instanceof ProcessTreeUntrackedError) noteProcessTreeUntracked(cwd);
		throw error;
	}
}
