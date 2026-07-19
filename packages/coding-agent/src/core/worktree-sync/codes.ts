/**
 * Worktree-sync SSOT for tagged result codes and shared record types.
 *
 * Every worktree-sync operation reports its outcome through one of these string-literal codes in
 * a typed result -- callers branch on `code`, NEVER on message/stderr substrings (the
 * `classifyDispatchError` substring compromise is deliberately not repeated here). Git stderr is
 * carried alongside as evidence for humans, not as a branch condition.
 */

/** Cap on `WorktreeSyncEpoch.changedPaths`; beyond it the list is truncated and overlap checks
 * treat the land as conservatively overlapping EVERYTHING (deterministic, never optimistic). */
export const EPOCH_CHANGED_PATHS_CAP = 500;

/** Branch namespace for lane branches: `pi/wt/<laneKey>`. */
export const LANE_BRANCH_PREFIX = "pi/wt/";

export type WorktreeSyncCode =
	| "ok"
	| "disabled"
	| "not_a_git_repo"
	| "default_branch_unresolved"
	| "hub_missing"
	| "invalid_lane_key"
	| "lane_exists"
	| "lane_not_found"
	| "max_lanes_reached"
	| "lane_dirty"
	| "hub_dirty"
	| "stale_lane"
	| "sync_required"
	| "sync_clean"
	| "sync_conflicts"
	| "rebase_in_progress"
	| "no_rebase_in_progress"
	| "conflict_markers_present"
	| "gate_command_unset"
	| "gate_failed"
	| "ff_failed"
	| "lock_busy"
	| "lock_takeover"
	| "main_mutation_refused"
	| "lane_unlanded_work"
	| "worktree_missing"
	| "released"
	| "reconciled"
	| "git_error";

/**
 * A refusal/failure outcome. `message` is deterministic text assembled from facts (safe to show a
 * model verbatim); `gitStderr` is bounded raw evidence; `paths` names offending files where the
 * refusal is about specific files (dirty files, conflict markers).
 */
export interface WorktreeSyncRefusal<C extends WorktreeSyncCode = WorktreeSyncCode> {
	code: C;
	message: string;
	gitStderr?: string;
	paths?: string[];
}

/** One lane registration record (`lanes/<laneKey>.json`). Identity/binding fields ONLY -- git
 * truths (freshness, dirtiness, ahead/behind) are always re-derived live, never stored here. */
export interface LaneRegistration {
	laneKey: string;
	branch: string;
	worktreePath: string;
	status: "active" | "released" | "orphaned";
	createdAt: string;
	updatedAt: string;
	goalId?: string;
	requirementId?: string;
	/** Host `LaneRecord.laneId` after dispatch correlation (tmux/in-process worker binding). */
	boundLaneId?: string;
	ownerPid?: number;
	ownerSessionId?: string;
}

/** `epoch.json` -- the integration epoch. `epoch` is monotonic messaging/audit sugar; correctness
 * always derives from git shas (`merge-base --is-ancestor`), never from this counter. */
export interface WorktreeSyncEpoch {
	epoch: number;
	mainSha: string;
	previousMainSha?: string;
	landedLaneKey?: string;
	landedAt?: string;
	changedPaths: string[];
	changedPathsTruncated: boolean;
}

/** Live, git-derived facts about one lane. Computed fresh per call -- there is no cached copy to
 * go stale, which is the point. */
export interface LaneFacts {
	laneKey: string;
	branch: string;
	worktreePath: string;
	registrationStatus: LaneRegistration["status"];
	/** Lane branch tip sha; undefined when the branch no longer exists. */
	branchSha?: string;
	/** True iff current main is an ancestor of the lane tip (`merge-base --is-ancestor`). */
	fresh: boolean;
	/** True when `status --porcelain` in the lane worktree is non-empty. */
	dirty: boolean;
	rebaseInProgress: boolean;
	aheadOfMain: number;
	behindMain: number;
	worktreePresent: boolean;
	/** Undefined when the lane has no recorded owner pid. */
	ownerAlive?: boolean;
}

export interface IntegrationLockOwner {
	pid: number;
	hostname: string;
	sessionId?: string;
	laneKey?: string;
	acquiredAt: string;
}

export type IntegrationLockAcquisition =
	| { acquired: true; takeover: boolean }
	| { acquired: false; holder?: IntegrationLockOwner; holderAlive: boolean };

/** One conflicted file in a sync stopped on conflicts. */
export interface ConflictWorklistFile {
	path: string;
	/** Both-modified is the common case; add/add and modify/delete surface as their index states. */
	kind: "both_modified" | "both_added" | "deleted_by_us" | "deleted_by_them" | "unknown";
	/** True when git rerere already replayed a recorded resolution for this file -- review, not re-resolve. */
	resolvedByRerere: boolean;
}

/** Structured conflict worklist returned when a sync/continue stops on conflicts. */
export interface ConflictWorklist {
	/** e.g. "2/5" -- rebase progress (stopped step / total steps). */
	step: string;
	stoppedAtCommit?: { sha: string; subject: string };
	files: ConflictWorklistFile[];
}

export type CreateLaneResult =
	| { code: "ok"; lane: LaneRegistration }
	| WorktreeSyncRefusal<
			| "not_a_git_repo"
			| "default_branch_unresolved"
			| "invalid_lane_key"
			| "lane_exists"
			| "max_lanes_reached"
			| "git_error"
	  >;

export type ReleaseLaneResult =
	| { code: "released"; laneKey: string }
	| WorktreeSyncRefusal<
			"not_a_git_repo" | "default_branch_unresolved" | "lane_not_found" | "lane_unlanded_work" | "git_error"
	  >;

export interface ReconcileSummary {
	code: "reconciled";
	orphanedLaneKeys: string[];
	reRegisteredLaneKeys: string[];
	ownerClearedLaneKeys: string[];
	staleLockReleased: boolean;
}

export type ReconcileResult =
	| ReconcileSummary
	| WorktreeSyncRefusal<"not_a_git_repo" | "default_branch_unresolved" | "git_error">;
