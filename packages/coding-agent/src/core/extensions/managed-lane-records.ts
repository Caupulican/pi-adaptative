import type { Usage } from "@caupulican/pi-ai";

/**
 * Report for an out-of-process managed lane (e.g. a tmux worker) at dispatch or terminal. `laneId` is
 * a stable identifier the CALLER chooses (e.g. a tmux job id or slug) and reuses unchanged across both
 * reports of the same lane. The host preserves it as the canonical durable lane identity so goal
 * bindings and terminal reports remain correlated across controller reloads.
 *
 * External status, changed files, usage, and provider execution remain caller claims. Dispatch authority
 * is different: the host compiles the claimed tool/path/budget scope into a typed execution grant and
 * persists it before the extension may start the process. This proves the host authorization boundary,
 * not that a third-party child CLI enforces the same scope internally.
 */
export interface ManagedLaneDispatch {
	/** Monotonic turn number for this logical lane. */
	sequence: number;
	/** Exact task instruction dispatched to the external worker. */
	instructions: string;
	/** Owner-selected immutable execution profile identity. */
	profileId: string;
	/** Provider/launcher identity used by the external process. */
	provider: string;
	/** Immutable host-derived profile identity covering this launch or follow-up. */
	authorizationId: string;
	/** How the worker authority was materialized. */
	authorizationKind: "profile-derived" | "legacy-recovery";
	/** Exact child tool surface requested at launch. */
	allowedTools: readonly string[];
	/** Exact write path claims requested at launch. */
	writePaths: readonly string[];
	/** Advisory cross-process cost ceiling when supplied by the immutable profile. */
	maxCostUsd?: number;
	/** Lease duration for this externally supervised turn. */
	leaseTtlMs: number;
}

export const MAX_MANAGED_LANE_SUMMARY_BYTES = 8 * 1024;

/** A managed lane's report marks each finding it could not settle on its own summary line. */
export const INCONCLUSIVE_LINE_PREFIX = "INCONCLUSIVE:";

export type ManagedLaneEvent =
	| (ManagedLaneEventBase & {
			phase: "dispatch";
			dispatch: ManagedLaneDispatch;
	  })
	| (ManagedLaneEventBase & {
			phase: "terminal";
			/** Exact dispatch turn for persistent agents; stale terminal reports are rejected before mutation. */
			dispatchSequence?: number;
			status?: string;
			/** Untrusted terminal evidence or question; must fit MAX_MANAGED_LANE_SUMMARY_BYTES UTF-8 bytes. */
			summary?: string;
			reasonCode?: string;
			changedFiles?: readonly string[];
			/**
			 * Terminal-only usage claim for this managed lane's out-of-process work (e.g. a tmux worker's own
			 * usage report). ADVISORY, same trust level as every other field on this event — the host attributes
			 * `usage.cost.total` onto the completed lane's `costUsd` verbatim, with NO re-pricing (the caller's
			 * model is unknown to the host, so re-pricing is both impossible and unnecessary). Ignored on
			 * `phase: "dispatch"`.
			 */
			usage?: Usage;
	  })
	| (ManagedLaneEventBase & {
			/**
			 * Lifetime of the external process itself, which is a different fact from the lifetime of the
			 * work it ran: a turn can reach terminal on a process that stays open, and a process can close
			 * long after its last turn settled. Reported separately so a closure never re-finishes a task.
			 */
			phase: "lifecycle";
			/** Dispatch turn this statement was observed against; a stale generation is rejected. */
			dispatchSequence?: number;
			agentLifecycle: "retained" | "retired";
	  });

export interface ManagedLaneEventBase {
	laneId: string;
	/** Goal this managed lane's work is bound to, if any — tags the tracked lane for goal orchestration. */
	goalId?: string;
	/**
	 * Worktree-sync lane key this managed lane was dispatched into. A caller claim like every other
	 * field here, so it is never verified authority by itself: the managed-lane ledger binds it to the lane
	 * at dispatch and a closure releases a lane only when that binding matches (`expectBoundLaneId`), so the
	 * claim can never release another lane.
	 */
	worktreeLaneKey?: string;
	/**
	 * The lane's own worktree path, reported with the lane key. It only tells the host which repository the lane
	 * belongs to (a task directory can sit in another repository than the session's), so the lane is bound and
	 * released there. A caller claim like the key: a wrong path can never release a lane, because release still
	 * requires the lane registered in that repository to be bound to this exact worker.
	 */
	worktreeLanePath?: string;
}
