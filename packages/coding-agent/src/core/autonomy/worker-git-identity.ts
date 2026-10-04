/**
 * The git identity every worker's repository writes carry.
 *
 * A worker's commits, rebases, merges, stashes and ref moves record the worker as the committer (the
 * reflog entry of a ref move names the committer too), so delivery history always shows who wrote it. The
 * identity travels in the environment only: it is never written to a git config file, so it cannot leak
 * into the owner's repository configuration and ends with the process or command that carries it.
 *
 * Two carriers cover every route a worker has to git:
 * - an in-process `delegate` worker's commands get it through the worker run environment (bash, python
 *   and run_process alike);
 * - a worker process (a lane-bound or collaboration `pi` child) exports it once at startup, so its shell,
 *   python, run_process and the `worktree_sync` engine's own git calls all inherit it.
 */

import { getOrchestrationAgentId } from "../process-identity.ts";
import { isWorkerSession } from "../session-role.ts";

/** Label of the worker the commands belong to, exported for attribution. */
export const WORKER_LABEL_ENV = "PI_WORKER_LABEL";
export const WORKER_COMMITTER_EMAIL = "pi-worker@localhost";
const MAX_WORKER_LABEL_LENGTH = 64;

/** A printable, bounded single-line label; control characters and newlines never reach a git identity. */
export function sanitizeWorkerLabel(label: string): string {
	return (
		label
			.replace(/[^\x20-\x7e]/g, "")
			.trim()
			.slice(0, MAX_WORKER_LABEL_LENGTH) || "worker"
	);
}

/** `GIT_COMMITTER_*` naming the worker. The label is sanitized here, so callers pass it as they know it. */
export function workerCommitterEnvironment(label: string): { GIT_COMMITTER_NAME: string; GIT_COMMITTER_EMAIL: string } {
	return {
		GIT_COMMITTER_NAME: `pi-worker ${sanitizeWorkerLabel(label)}`,
		GIT_COMMITTER_EMAIL: WORKER_COMMITTER_EMAIL,
	};
}

/**
 * `--author` value naming a worker, for a commit another session makes on the worker's behalf (the root committing
 * the work a worker left in its lane): the worker is the author, the committing session stays the committer.
 */
export function workerAuthorIdentity(label: string): string {
	return `pi-worker ${sanitizeWorkerLabel(label)} <${WORKER_COMMITTER_EMAIL}>`;
}

/**
 * Export the committer identity into this worker process's own environment. A no-op for a main session,
 * which commits as its owner. The label is the orchestration agent id the launcher assigned, else an
 * explicitly exported label, else the process id, so concurrent worker processes are always distinguishable.
 */
export function exportWorkerCommitterIdentity(env: NodeJS.ProcessEnv = process.env): boolean {
	if (!isWorkerSession(env)) return false;
	const label = getOrchestrationAgentId(env) ?? env[WORKER_LABEL_ENV]?.trim() ?? `pid-${process.pid}`;
	env[WORKER_LABEL_ENV] = sanitizeWorkerLabel(label);
	Object.assign(env, workerCommitterEnvironment(label));
	return true;
}
