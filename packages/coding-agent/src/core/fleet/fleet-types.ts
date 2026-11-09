/**
 * The fleet scheduler's shared contract: what a planner, a leader or the delegate tool hands it, what it answers, and the
 * room it reports back. Every term here is a code fact; the scheduler never asks a model whether there is room.
 */

import type { TurnOriginRecord } from "../../kernel/turn-origin-stamp.ts";
import type { TaskBrief } from "../comms/comms-records.ts";
import type { OrchestrationThinkingLevel, RiskBudget } from "../orchestration/contracts.ts";
import type { WorkerReceiptOrigin } from "../orchestration/worker-receipt-origin.ts";
import type { PlacementCapacitySource } from "../placement/capacity-source.ts";
import type { Placement } from "../placement/placement-types.ts";
import type { PlanNodeDemand } from "../plan/plan-graph.ts";

export type WeightClass = "probe" | "read" | "write" | "heavy";
export type ExecutionBackend = "in_process_lane" | "child_process" | "remote";
export type FleetWaitReason =
	| "provider_room"
	| "account_window"
	| "provider_outage"
	| "machine_memory"
	| "machine_heap"
	| "machine_cpu"
	| "machine_fds"
	| "machine_disk"
	| "projection_room"
	| "cost_budget"
	| "safety_ceiling"
	| "write_reservation"
	| "dependencies"
	| "foreground"
	| "fleet_stopped"
	| "fairness"
	| "placement_room"
	| "placement_offline"
	| "objective_paused"
	| "runtime_generation"
	| "preflight";
export type FleetRefusalCode =
	| "account_window"
	| "provider_outage"
	| "budget"
	| "placement"
	| "ceiling"
	| "authority_digest_mismatch"
	| "projection_capacity"
	/** The worker's own start preparation refused it (directory, task fitness, authority, a replay conflict). */
	| "preflight";

/**
 * The blocker codes a fleet refusal carries. The full `BlockerCode` union belongs to `delegation/worker-outcome.ts`; this is
 * the subset the fleet produces, each a member of that union, so the refusal widens to it without a mapping.
 */
export type FleetBlockerCode =
	| "provider_quota"
	| "provider_transient"
	| "budget_exhausted"
	| "placement_unreachable"
	| "capacity_unavailable"
	| "owner_authority_required"
	| "preflight_failed";

/** What a plan node demands of the fleet: defined once in `plan/plan-graph.ts`, re-exported for the fleet's readers. */
export type { PlanNodeDemand };

export type FleetPriority = 0 | 1 | 2 | 3;

export interface FleetDispatch {
	/** plan:<planId>:<nodeId>:v<version> | escalation:<outcomeId>:r<rung> | adhoc:<toolCallId> */
	idempotencyKey: string;
	demand: PlanNodeDemand;
	/** At most 16 KiB. */
	instructions: string;
	brief?: TaskBrief;
	/** Repository-relative. */
	writeScope: readonly string[];
	isolation: "shared" | "worktree";
	requirementIds: readonly string[];
	/** Display mirror only. */
	dependsOnTaskIds: readonly string[];
	thinking: "inherit" | "raise_one" | OrchestrationThinkingLevel;
	/** Explicit or pinned; otherwise a route set is computed. */
	model?: { provider: string; modelId: string };
	plan?: { planId: string; version: number; nodeId: string };
	/**
	 * An escalation rung's rerun. `writeScope` and `pinned` are relative to the original attempt's own cwd (the cwd entry
	 * itself is ".") and are rebuilt against the session cwd when the rerun is requested.
	 */
	escalation?: {
		outcomeId: string;
		rung: 1 | 2;
		authorityDigest: string;
		previousPlacement: Placement;
		requirementIds: string[];
		notBefore?: string;
		supersedesTaskId?: string;
		pinned: EscalationPinnedAuthority;
	};
	/** Brokered starts. */
	delegation?: { objectiveId: string; leaderAttemptId: string };
}

/**
 * The authority an escalation's original attempt was admitted with, rebuilt into the rerun's request. What the outcome was
 * recorded under is this set plus the write and read scope; an admission that rebuilds to another authority is refused.
 */
export interface EscalationPinnedAuthority {
	/** The registered profile the original ran under; absent when it was compiled from an adaptive profile. */
	readonly profileId?: string;
	readonly parentAgentId?: string;
	readonly botSoul?: string;
	readonly readOnly: boolean;
	readonly shellReadOnly?: boolean;
	/**
	 * Where the original's cwd sat: relative to the session cwd ("." for the session root) or an absolute path outside it.
	 * The rerun is admitted with it as its workspace, so its scopes resolve where the original's did.
	 */
	readonly location: string;
	/** Read roots relative to the original's cwd; absent keeps the default read scope. */
	readonly readScope?: readonly string[];
	readonly budget: RiskBudget;
	/** Who wrote the original's words (a third party's taint): carried so a rerun never launders it. */
	readonly turnOrigin?: TurnOriginRecord;
	/** Where the original's result is delivered: carried so a rerun answers the same parent. */
	readonly receiptOrigin?: WorkerReceiptOrigin;
}

export type AdmitDecision =
	| {
			kind: "run";
			taskId: string;
			attemptId: string;
			laneId: string;
			backend: ExecutionBackend;
			accountKey: string;
			modelRef: string;
			weight: WeightClass;
	  }
	| {
			kind: "queued";
			taskId: string;
			attemptId: string;
			laneId: string;
			reason: FleetWaitReason;
			detail: string;
			etaMs?: number;
			/** When the room term holding it reopens, when known (a recorded reset, a budget period, a spend window). */
			retryAt?: number;
	  }
	| FleetRefusal;

export interface FleetRefusal {
	readonly kind: "refused";
	readonly reason: FleetRefusalCode;
	readonly blocker: FleetBlockerCode;
	readonly retryAt?: number;
	readonly retryAtBasis?: "recorded_reset" | "budget_period" | "backoff";
	readonly detail: string;
}

/** The answer of `prepare`: the dispatch is prepared and `admit` materializes it synchronously, or it is refused. */
export type PrepareDecision = { readonly kind: "prepared" } | FleetRefusal;

export type FleetScope =
	| { kind: "lane"; laneId: string }
	| { kind: "plan"; planId: string }
	| { kind: "subtree"; subtreeId: string }
	| { kind: "objective"; objectiveId: string }
	| { kind: "all" };

export interface RoomQuery {
	objectiveId: string;
	subtreeId?: string;
	weight: WeightClass;
}

export interface RoomSnapshot {
	readonly runnableNow: number;
	readonly readyWindowFree: number;
	readonly queued: number;
	readonly throughputPerMin: number;
	etaMs(additional: number): number;
	readonly limitedBy?: FleetWaitReason;
	readonly perAccount: readonly { accountKey: string; room: number; retryAt?: number }[];
	readonly revision: number;
}

export interface ShareSpec {
	subtreeId: string;
	parentSubtreeId: string;
	weight: number;
	maxConcurrent?: number;
}

export interface FleetScheduler {
	/**
	 * The asynchronous half of a local start, run before `admit`: admission resolution, the worker's directory and task
	 * fitness, its authority and contract. Idempotent on the dispatch's key (a second call while one is prepared, or after
	 * its task exists, answers `prepared` again). A prepared dispatch that is never admitted is released by `cancel`,
	 * `stop` or the scheduler's disposal. Non-local placements prepare nothing and answer `prepared`.
	 */
	prepare(dispatch: FleetDispatch, placement: Placement, signal?: AbortSignal): Promise<PrepareDecision>;
	/**
	 * Synchronous and idempotent on the dispatch's key; queued and run mean the task and attempt are materialized. A local
	 * dispatch must be prepared first; an unprepared one is refused with reason `preflight`.
	 */
	admit(dispatch: FleetDispatch, placement: Placement): AdmitDecision;
	cancel(scope: FleetScope, reasonCode: string): void;
	stop(): void;
	resume(): void;
	room(query: RoomQuery): RoomSnapshot;
	/** Fires when `runnableNow` crosses zero, doubles or halves; coalesced per microtask. */
	subscribeRoom(query: RoomQuery, onChange: (snapshot: RoomSnapshot) => void): () => void;
	/** A DRR subtree flow. */
	openShare(spec: ShareSpec): void;
	/** Cancels the share's queued members. */
	closeShare(subtreeId: string, reasonCode: string): void;
	registerCapacitySource(source: PlacementCapacitySource): () => void;
}

/** DRR cost of one dispatch of a class: a heavy node spends eight probes' worth of its flow's quantum. */
/**
 * The fleet subtree a worker lane is charged to: its parent agent's id, or the session root subtree "" when it has no
 * parent. The one derivation the queue's lane flow and a plan step's demand both read, so a prepared dispatch and its
 * queued lane always carry the same subtree.
 */
export function laneSubtreeId(parentAgentId: string | undefined): string {
	return parentAgentId ?? "";
}

export const WEIGHT_CLASS_COST: Readonly<Record<WeightClass, number>> = { probe: 1, read: 2, write: 4, heavy: 8 };

/** One term of the room formula: how many more nodes it admits, the wait key that wakes it, and when it reopens. */
export interface RoomTerm {
	readonly reason: FleetWaitReason;
	readonly room: number;
	/** The resource a waiter on this term is indexed under: `account:<key>`, `machine:memory`, `ceiling:running`, ... */
	readonly waitKey: string;
	readonly retryAt?: number;
	/** Plain words for the binding term, read by a status view; ids and counts only. */
	readonly detail: string;
}

/** The fleet's answer for one local dispatch: room, or the binding term it waits on. */
export type FleetRoomDecision =
	| { readonly ok: true; readonly room: number }
	| { readonly ok: false; readonly term: RoomTerm };
