/**
 * Process-matrix SSOT for tagged result codes and shared record types.
 *
 * Every process-matrix lifecycle transition is expressed as one of the string-literal codes/status
 * values below -- callers (the runtime, the master orphan scan, the worker watcher) branch on
 * `code`/`status`, NEVER on a message/substring (the same doctrine as `worktree-sync/codes.ts`).
 *
 * The matrix tracks two roles:
 * - `master`: the top-level interactive/direct session (or the root of a launch chain).
 * - `worker`: a session launched with a known parent (`PI_PARENT_PID`/`--parent-pid`), e.g. a
 *   tmux-dispatched agent. A worker knows its parent's pid and winds down gracefully -- never
 *   silently -- when that parent disappears.
 */

export type ProcessRole = "master" | "worker";

/**
 * - `running` -- normal operation.
 * - `winding_down` -- a lifecycle transition is in progress (parent lost, parent shutdown, or a
 *   cooperative user-requested cleanup); the process is finishing up before exit.
 * - `resumable` -- wound down leaving a payload describing how to pick the task back up.
 * - `adopted` -- claimed by a new parent after the original parent was lost (retained by
 *   `reconcileMatrix` alongside `resumable`, TTL-gated).
 * - `closed` -- terminal; safe to prune.
 */
export type ProcessStatus = "running" | "winding_down" | "resumable" | "adopted" | "closed";

export type WindDownReason = "parent_lost" | "parent_shutdown" | "user_cleanup";

/** What a wound-down worker leaves behind so its task can be picked back up. */
export interface ResumablePayload {
	laneKey?: string;
	taskSummary?: string;
	lastCode: ProcessStatus;
}

/** One process-matrix entry: one file under `state/process-matrix/<entryId>.json` (see `store.ts`). */
export interface ProcessMatrixEntry {
	entryId: string;
	role: ProcessRole;
	pid: number;
	sessionId: string;
	hostname: string;
	startedAt: string;
	heartbeatAt: string;
	status: ProcessStatus;
	/** Worker-only: the pid of the process that launched this one. */
	parentPid?: number;
	parentSessionId?: string;
	laneKey?: string;
	tmuxSession?: string;
	tmuxPanePid?: number;
	taskRef?: string;
	windDownReason?: WindDownReason;
	resumable?: ResumablePayload;
}

/** What a master decides to do about one orphaned worker during the startup scan. */
export type CleanupAction = "adopt" | "cleanup" | "leave";

/**
 * What a worker learns by re-reading its OWN fresh matrix entry (a master may have written an
 * adoption or a cooperative-cleanup request into it -- see `docs/process-matrix.md`).
 */
export type WorkerDirective = { code: "adopt"; parentPid: number } | { code: "user_cleanup" } | { code: "none" };

/** Outcome of a `reconcileMatrix` pass: which entries survive and which were pruned, and why. */
export interface ReconcileMatrixResult {
	code: "reconciled";
	kept: ProcessMatrixEntry[];
	prunedEntryIds: string[];
}
