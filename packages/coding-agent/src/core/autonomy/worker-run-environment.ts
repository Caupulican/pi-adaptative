/**
 * The environment one in-process worker's commands run in.
 *
 * A worker is zero-footprint: its shell leaves nothing behind outside its own scope and holds none of
 * the owner's secrets. Three structural guarantees live here instead of in a prompt:
 * - scratch: TMPDIR/TMP/TEMP (and the explainer output directory) point at a per-worker directory inside
 *   the leased process scratch run, removed when the worker's tool surface is disposed;
 * - secrets: variables whose name marks them as a credential never reach a worker's commands (a command's
 *   output reaches the transcript, so a secret in its environment is one `env` away from the model);
 * - ownership: every command carries a per-run marker, inherited by every descendant including processes
 *   that re-parent to init after a double fork, so disposal can find and end exactly this worker's tree.
 * The session role and parent pid are exported too, so a `pi` started from a worker's shell is itself a
 * worker (cooperative attribution; an OS-level sandbox is the structural fix for a process that unsets them).
 * Git commits a worker makes carry the worker as their committer (environment only, never git config), so
 * delivery history always shows who committed.
 */

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { killTreeNow } from "../../kernel/reliability/process-tree.ts";
import { PI_PARENT_PID_ENV } from "../process-identity.ts";
import { createProcessScratchDirectory, removeProcessScratchDirectory } from "../process-scratch.ts";
import { PI_SESSION_ROLE_ENV } from "../session-role.ts";
import type { BashSpawnHook } from "../tools/bash.ts";
import { sanitizeWorkerLabel, WORKER_LABEL_ENV, workerCommitterEnvironment } from "./worker-git-identity.ts";

/** Per-run ownership marker exported to every command a worker runs. */
export const WORKER_RUN_MARKER_ENV = "PI_WORKER_RUN";
/** Directory the explainer skills write their artifacts into; inside the worker's scratch directory. */
export const WORKER_EXPLAINERS_DIR_ENV = "PI_EXPLAINERS_DIR";
export { WORKER_LABEL_ENV };

const SCRATCH_PREFIX = "worker-";
const SECRET_NAME_PATTERN =
	/(?:^|_)(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?|PRIVATE_?KEY|ACCESS_?KEY)(?:_|$)/;

/**
 * The owner's explicit credential grant: a comma-separated list of variable names in the host's launch
 * environment (never a project file, so a repository cannot grant itself a secret) that a worker's
 * commands keep, e.g. `PI_WORKER_PASS_ENV=GH_TOKEN` so a worker can run `gh`. Everything else that names a
 * credential stays stripped.
 */
export const WORKER_PASS_ENV_ENV = "PI_WORKER_PASS_ENV";

function grantedEnvironmentNames(env: NodeJS.ProcessEnv): Set<string> {
	return new Set(
		(env[WORKER_PASS_ENV_ENV] ?? "")
			.split(",")
			.map((name) => name.trim().toUpperCase())
			.filter((name) => name.length > 0),
	);
}

/** Whether an environment variable name marks a credential (matched on whole `_`-separated words). */
export function isSecretEnvironmentName(name: string): boolean {
	return SECRET_NAME_PATTERN.test(name.toUpperCase());
}

/** The names in `env` a worker's commands must not inherit (credential-named, minus the owner's grant). */
export function secretEnvironmentNames(env: NodeJS.ProcessEnv = process.env): string[] {
	const granted = grantedEnvironmentNames(env);
	return Object.keys(env).filter((name) => isSecretEnvironmentName(name) && !granted.has(name.toUpperCase()));
}

export interface WorkerRunEnvironment {
	/** Random per-run marker value (see {@link WORKER_RUN_MARKER_ENV}). */
	readonly marker: string;
	/** Per-worker scratch directory every command uses as its temp directory. */
	readonly scratchDirectory: string;
	/** Names the worker's python commands must not inherit. */
	readonly omittedEnvironmentVariables: readonly string[];
	/** The attribution variables (scratch, marker, role, label, committer identity) for tools that build their own environment. */
	readonly attributionEnvironment: Readonly<NodeJS.ProcessEnv>;
	/** Shell spawn hook that applies scratch, secret stripping, ownership marker and role. */
	readonly spawnHook: BashSpawnHook;
	/** End every process still carrying the marker, then remove the scratch directory. */
	dispose(): void;
}

/**
 * Processes (other than this one) whose environment carries `marker`. Linux only: `/proc/<pid>/environ`
 * is readable for this user's own processes, which is exactly the set a worker's commands run as.
 * macOS and Windows end a worker's shell tree through the owned shell handle at disposal; a daemon that
 * re-parents there is the documented residual.
 */
function findMarkedProcessIds(marker: string): number[] {
	if (process.platform !== "linux") return [];
	const needle = `${WORKER_RUN_MARKER_ENV}=${marker}`;
	const found: number[] = [];
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		const pid = Number(entry);
		if (pid === process.pid) continue;
		try {
			if (readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").includes(needle)) found.push(pid);
		} catch {
			// Another user's process, or one that exited between the listing and the read.
		}
	}
	return found;
}

/**
 * Authority for ending marked processes: the marker is a random per-run value that only this worker's
 * commands inherit, so a process carrying it was started by this worker, and the bare-pid ancestry gate in
 * `killTreeNow` still refuses the host, its ancestors and any target whose ancestry cannot be read.
 */
function reapMarkedProcesses(marker: string): string[] {
	const reaped: string[] = [];
	for (const pid of findMarkedProcessIds(marker)) {
		reaped.push(describeProcess(pid));
		killTreeNow(pid);
	}
	return reaped;
}

/** `pid: command line` (bounded) for a process about to be ended, so the owner can see what a worker left running. */
function describeProcess(pid: number): string {
	try {
		const command = readFileSync(`/proc/${pid}/cmdline`, "latin1").split("\0").join(" ").trim();
		return `${pid}: ${command.slice(0, 120) || "(no command line)"}`;
	} catch {
		return `${pid}: (exited)`;
	}
}

/**
 * `onReaped` receives a description of every process still running when the worker ended. Workers are
 * zero-footprint, so those processes are ended, but never silently: the owner is told what was left
 * running and that a durable long-running process belongs to the root's own background runs.
 */
export function createWorkerRunEnvironment(
	label: string,
	onReaped?: (processes: readonly string[]) => void,
): WorkerRunEnvironment {
	const workerLabel = sanitizeWorkerLabel(label);
	const marker = randomUUID();
	const scratchDirectory = createProcessScratchDirectory(SCRATCH_PREFIX);
	// Everything a worker's command carries by host decision, whichever tool launches it: scratch, ownership
	// marker, role, label and the committer identity. Never a credential.
	const attributionEnvironment: NodeJS.ProcessEnv = {
		TMPDIR: scratchDirectory,
		TMP: scratchDirectory,
		TEMP: scratchDirectory,
		[WORKER_EXPLAINERS_DIR_ENV]: join(scratchDirectory, "pi-explainers"),
		[WORKER_RUN_MARKER_ENV]: marker,
		[PI_SESSION_ROLE_ENV]: "worker",
		[PI_PARENT_PID_ENV]: String(process.pid),
		[WORKER_LABEL_ENV]: workerLabel,
		...workerCommitterEnvironment(workerLabel),
	};
	const spawnHook: BashSpawnHook = (context) => {
		const env: NodeJS.ProcessEnv = { ...context.env };
		const stripped = new Set(secretEnvironmentNames(env));
		for (const name of Object.keys(env)) if (stripped.has(name)) delete env[name];
		return { ...context, env: { ...env, ...attributionEnvironment } };
	};
	return {
		marker,
		scratchDirectory,
		omittedEnvironmentVariables: secretEnvironmentNames(),
		attributionEnvironment,
		spawnHook,
		dispose: () => {
			try {
				const reaped = reapMarkedProcesses(marker);
				if (reaped.length > 0) onReaped?.(reaped);
			} finally {
				removeProcessScratchDirectory(scratchDirectory);
			}
		},
	};
}
