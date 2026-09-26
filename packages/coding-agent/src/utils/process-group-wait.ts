/**
 * Shared-worktree process calls own a tracked tree.
 * A one-shot leader is a process group. The tool returns only after that group is empty.
 * A persistent shell stays the group leader, so its direct children are the tracked set.
 * procfs does not emit inotify, so a remaining member is waited on with pidfd, not a timer.
 * A tree that cannot be observed does not look successful.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
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

function groupGone(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return false;
	} catch (error) {
		if (errorCode(error) === "ESRCH") return true;
		throw new ProcessTreeUntrackedError(`process group ${pid} is not observable (${errorCode(error)})`);
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
		let stat: string;
		try {
			stat = readFileSync(`/proc/${name}/stat`, "utf8");
		} catch {
			continue;
		}
		const marker = stat.lastIndexOf(")");
		if (marker < 0) continue;
		const fields = stat
			.slice(marker + 1)
			.trim()
			.split(/\s+/);
		if (Number(fields[2]) === groupId) members.push(Number(name));
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
	pid: number,
	phase: "exit" | "cancellation",
	signal?: AbortSignal,
): Promise<"exited" | "aborted"> {
	let previousKey = "";
	while (!groupGone(pid)) {
		if (process.platform !== "linux") {
			throw new ProcessTreeUntrackedError(
				phase === "exit"
					? `process group ${pid} outlived its leader`
					: `process group ${pid} did not confirm cancellation`,
			);
		}
		const members = membersOfGroup(pid);
		if (members.length === 0) {
			if (groupGone(pid)) return "exited";
			throw new ProcessTreeUntrackedError(`process group ${pid} is live but has no readable members`);
		}
		const key = members.join(",");
		if (key === previousKey) {
			if (groupGone(pid)) return "exited";
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

async function waitForProcessGroupExit(pid: number, signal?: AbortSignal): Promise<void> {
	let abortKillOutcome: "delivered" | "gone" | "failed" | undefined;
	let abortKillErrorCode: string | undefined;
	const killGroup = (): void => {
		try {
			process.kill(-pid, "SIGKILL");
			abortKillOutcome = "delivered";
		} catch (error) {
			abortKillErrorCode = errorCode(error);
			abortKillOutcome = abortKillErrorCode === "ESRCH" ? "gone" : "failed";
		}
	};
	if (signal?.aborted) killGroup();
	else signal?.addEventListener("abort", killGroup, { once: true });
	try {
		if ((await waitForObservableProcessGroupExit(pid, "exit", signal)) === "exited") return;
		if (abortKillOutcome === "gone" || groupGone(pid)) return;
		if (abortKillOutcome !== "delivered") {
			throw new ProcessTreeUntrackedError(
				`process group ${pid} could not be killed after cancellation (${abortKillErrorCode ?? "error"})`,
			);
		}
		await waitForKilledProcessGroupExit(pid);
	} finally {
		signal?.removeEventListener("abort", killGroup);
	}
}

/** A delivered SIGKILL still needs a bounded terminal acknowledgement. */
async function waitForKilledProcessGroupExit(pid: number): Promise<void> {
	const acknowledgement = new AbortController();
	const timeout = setTimeout(() => acknowledgement.abort(), PROCESS_GROUP_KILL_ACKNOWLEDGEMENT_MS);
	timeout.unref?.();
	try {
		if ((await waitForObservableProcessGroupExit(pid, "cancellation", acknowledgement.signal)) === "exited") return;
		if (groupGone(pid)) return;
		throw new ProcessTreeUntrackedError(
			`process group ${pid} did not exit within ${PROCESS_GROUP_KILL_ACKNOWLEDGEMENT_MS}ms after cancellation`,
		);
	} finally {
		clearTimeout(timeout);
	}
}

function ownedPid(pid: number | undefined): pid is number {
	return process.platform !== "win32" && typeof pid === "number" && Number.isInteger(pid) && pid > 0;
}

export async function awaitOwnedProcessGroup(
	pid: number | undefined,
	cwd: string,
	signal?: AbortSignal,
): Promise<void> {
	if (!ownedPid(pid)) return;
	try {
		await waitForProcessGroupExit(pid, signal);
	} catch (error) {
		if (error instanceof ProcessTreeUntrackedError) noteProcessTreeUntracked(cwd);
		throw error;
	}
}

/** One deadline owner for the leader and every process that remains in its owned group. */
export async function waitForOwnedProcessTreeWithTermination(
	child: ChildProcess,
	cwd: string,
	options: ChildProcessTerminationOptions = {},
): Promise<ChildProcessTerminationResult> {
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
		await awaitOwnedProcessGroup(child.pid, cwd, lifecycle.signal);
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
): Promise<void> {
	if (process.platform !== "linux" || !ownedPid(pid)) return;
	try {
		let previousKey = "";
		for (;;) {
			if (signal?.aborted) throw new Error("aborted");
			const children = readChildPids(pid);
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
export async function reapOwnedProcessGroup(pid: number | undefined, cwd: string): Promise<void> {
	if (!ownedPid(pid)) return;
	try {
		try {
			process.kill(-pid, "SIGKILL");
		} catch (error) {
			if (errorCode(error) === "ESRCH") return;
			throw new ProcessTreeUntrackedError(`process group ${pid} is not observable (${errorCode(error)})`);
		}
		await waitForProcessGroupExit(pid);
	} catch (error) {
		if (error instanceof ProcessTreeUntrackedError) noteProcessTreeUntracked(cwd);
		throw error;
	}
}
