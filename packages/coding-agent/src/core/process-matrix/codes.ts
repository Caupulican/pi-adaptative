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
 *   collaboration-dispatched agent. A worker knows its parent's pid and winds down gracefully -- never
 *   silently -- when that parent disappears.
 */

import type { AgentIdentityContract } from "../orchestration/contracts.ts";

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
	agent: AgentIdentityContract;
	taskRef?: string;
	taskSummary?: string;
	lastCode: ProcessStatus;
}

/** Durable terminal notification outbox for one worker process. */
export interface ProcessTerminalHandoff {
	code: number | null;
	signal: string | null;
	observedAt: string;
	notificationDeliveredAt?: string;
}

/** One process-matrix entry: one file under `state/process-matrix/<entryId>.json` (see `store.ts`). */
export interface ProcessMatrixEntry {
	entryId: string;
	role: ProcessRole;
	agent: AgentIdentityContract;
	pid: number;
	hostname: string;
	startedAt: string;
	heartbeatAt: string;
	status: ProcessStatus;
	/** Worker-only: the pid of the process that launched this one. */
	parentPid?: number;
	parentSessionId?: string;
	tmuxSession?: string;
	tmuxPanePid?: number;
	taskRef?: string;
	taskSummary?: string;
	windDownReason?: WindDownReason;
	resumable?: ResumablePayload;
	terminal?: ProcessTerminalHandoff;
}

/** What a master decides to do about one orphaned worker during the startup scan. */
export type CleanupAction = "adopt" | "cleanup" | "leave";

/**
 * What a worker learns by re-reading its OWN fresh matrix entry (a master may have written an
 * adoption or a cooperative-cleanup request into it -- see `docs/process-matrix.md`).
 */
export type WorkerDirective = { code: "adopt"; parentPid: number } | { code: "user_cleanup" } | { code: "none" };

/**
 * Why a worker cannot treat its recorded parent as supervising it. Branch on `code`, never on text.
 * - `no_parent_session`: the launch recorded no parent session, so pid liveness cannot be bound to an identity.
 * - `process_gone`: the parent pid is not alive.
 * - `session_entry_missing`: the parent session has no master entry (pruned, or never registered).
 * - `session_entry_not_running`: the parent session's master entry is closed or otherwise not `running`.
 * - `process_identity_mismatch`: the master entry names another pid or session than the recorded parent.
 * - `heartbeat_stale`: the parent pid and entry look right, but its heartbeat is older than the bound
 *   (a long event-loop stall or a suspended host: the parent may resume).
 */
export type ParentLossCode =
	| "no_parent_session"
	| "process_gone"
	| "session_entry_missing"
	| "session_entry_not_running"
	| "process_identity_mismatch"
	| "heartbeat_stale";

export type ParentLiveness = { alive: true } | { alive: false; code: ParentLossCode };

/** One live orphan shown to the owner before any cleanup directive is written. */
export interface OrphanCleanupRequest {
	entryId: string;
	pid: number;
	parentPid?: number;
	taskRef?: string;
	taskSummary?: string;
}

/** `approved` only for an explicit yes; a refusal, a timeout, an unavailable owner or an abort is never approval. */
export type OwnerCleanupDecision = "approved" | "declined" | "unanswered";

/** Outcome of a `reconcileMatrix` pass: which entries survive and which were pruned, and why. */
export interface ReconcileMatrixResult {
	code: "reconciled";
	kept: ProcessMatrixEntry[];
	prunedEntryIds: string[];
	recoveredEntryIds: string[];
}
