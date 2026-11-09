/**
 * The local placement's half of `FleetScheduler.admit`: the port the worker controller's start phases implement, and the
 * ordered exits that turn the fleet's room and a materialized start into an `AdmitDecision`.
 *
 * Before materializing, the binding room term decides whether the dispatch may wait queued (FS 3.1):
 *
 * 1. room now, or a blocker an in-process event clears (no reopen time): materialize (it runs, or queues on that event);
 * 2. a known reopen within `fleet.queueHorizonMs`: materialize; the queued node's wake is armed at the reopen;
 * 3. an exhausted budget period (a day or goal budget): refused, `retryAt` at the period boundary (none for a goal);
 * 4. a reopen beyond the horizon: refused with that reopen as `retryAt`;
 * 5. otherwise: materialize (queued on fairness). Uncertainty never becomes a refusal.
 *
 * A materialized start answers `run` when its attempt holds a slot, `queued` (with the dispatch queue's wait reason)
 * when it waits, and a refusal when the controller declined it.
 */

import type { Api, Model } from "@caupulican/pi-ai";
import type {
	AdmitDecision,
	FleetDispatch,
	FleetRefusal,
	FleetWaitReason,
	PlanNodeDemand,
	RoomTerm,
	WeightClass,
} from "./fleet-types.ts";

/** A start the controller materialized for a fleet dispatch, as the fleet reads it. */
export type FleetLocalStart =
	| { readonly started: false; readonly skipReason: string }
	| {
			readonly started: true;
			readonly laneId: string;
			readonly attemptId: string;
			/** The attempt holds a running slot now. */
			readonly running: boolean;
			readonly modelRef?: string;
			readonly provider?: string;
			/** The dispatch queue's wait state while it waits. */
			readonly wait?: { readonly reason: string; readonly detail?: string };
	  };

/** What the fleet asks of the worker controller's start phases (`delegation/worker-start-phases.ts`). */
export interface FleetLocalStartPort {
	/** The asynchronous preparation; idempotent on the dispatch's key while prepared. */
	prepare(dispatch: FleetDispatch, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; skipReason: string }>;
	/** The model a prepared fresh start will run on; undefined for a replay, a reuse, or nothing prepared. */
	preparedModel(idempotencyKey: string): Model<Api> | undefined;
	/** The synchronous materialization of a prepared dispatch; undefined when nothing is prepared under its key. */
	materialize(dispatch: FleetDispatch): FleetLocalStart | undefined;
	/** Releases one prepared dispatch, or all of them. */
	release(idempotencyKey?: string): void;
}

/** The skip reason of a prepared start a runtime replacement held back; the dispatch stays prepared. */
export const LOCAL_START_RUNTIME_REPLACING = "runtime_generation_replacing";

/** Skip reasons that mean the fleet's own bounds held the start, not the worker's preparation. */
const CEILING_SKIP_REASONS =
	/^(worker_dispatch_queue_full|worker_delegation_already_running|worker_fleet_|worker_identity_|runtime_generation_)/;

export function refusalForSkip(skipReason: string): FleetRefusal {
	return CEILING_SKIP_REASONS.test(skipReason)
		? { kind: "refused", reason: "ceiling", blocker: "capacity_unavailable", detail: skipReason }
		: { kind: "refused", reason: "preflight", blocker: "preflight_failed", detail: skipReason };
}

/** The class a dispatch is charged as: the planner's heavy flag, then writes; reads otherwise. */
export function weightOf(demand: PlanNodeDemand, writeScope: readonly string[]): WeightClass {
	if (demand.heavy) return "heavy";
	return demand.writes || writeScope.length > 0 ? "write" : "read";
}

/**
 * The refusal exits (3 and 4) for a dispatch whose binding term holds no room, or undefined when it may wait queued.
 * `term` is the binding term of the dispatch's room.
 */
export function horizonRefusal(term: RoomTerm, now: number, horizonMs: number): FleetRefusal | undefined {
	if (term.retryAt === undefined) {
		return term.waitKey.startsWith("budget:goal:")
			? {
					kind: "refused",
					reason: "budget",
					blocker: "budget_exhausted",
					retryAtBasis: "budget_period",
					detail: term.detail,
				}
			: undefined;
	}
	if (term.retryAt - now <= horizonMs) return undefined;
	if (term.waitKey === "budget:day")
		return {
			kind: "refused",
			reason: "budget",
			blocker: "budget_exhausted",
			retryAt: term.retryAt,
			retryAtBasis: "budget_period",
			detail: term.detail,
		};
	const account = term.reason === "account_window" || term.reason === "provider_room";
	return {
		kind: "refused",
		reason: account ? "account_window" : "ceiling",
		blocker: account ? "provider_quota" : "capacity_unavailable",
		retryAt: term.retryAt,
		retryAtBasis: account ? "recorded_reset" : "backoff",
		detail: term.detail,
	};
}

/** The dispatch queue's wait reason as a fleet wait reason; capacity waits name the binding room term when known. */
export function fleetWaitReason(reason: string, bindingTerm: FleetWaitReason | undefined): FleetWaitReason {
	switch (reason) {
		case "capacity":
			return bindingTerm ?? "fairness";
		case "dependencies":
		case "write_reservation":
		case "foreground":
		case "runtime_generation":
		case "preflight":
			return reason;
		case "objective":
			return "objective_paused";
		default:
			return "fairness";
	}
}

export interface LocalDecisionFacts {
	readonly weight: WeightClass;
	accountKey(provider: string): string;
	/** The binding room term's reason a waiting lane was last filed under. */
	waitReason(laneId: string): FleetWaitReason | undefined;
	/** The room term that held the dispatch when it was materialized, if any. */
	readonly binding?: RoomTerm;
	etaMs(): number | undefined;
}

/** The decision for one materialized start. */
export function decisionForStart(start: FleetLocalStart, facts: LocalDecisionFacts): AdmitDecision {
	if (!start.started) return refusalForSkip(start.skipReason);
	const ids = { taskId: start.laneId, attemptId: start.attemptId, laneId: start.laneId };
	if (start.running)
		return {
			kind: "run",
			...ids,
			backend: "in_process_lane",
			accountKey: start.provider ? facts.accountKey(start.provider) : "",
			modelRef: start.modelRef ?? "",
			weight: facts.weight,
		};
	const eta = facts.etaMs();
	const { binding } = facts;
	const reason = fleetWaitReason(start.wait?.reason ?? "capacity", facts.waitReason(start.laneId) ?? binding?.reason);
	const reopensAt = binding && binding.reason === reason ? binding.retryAt : undefined;
	return {
		kind: "queued",
		...ids,
		reason,
		detail:
			start.wait?.detail ??
			(binding?.reason === reason ? binding.detail : undefined) ??
			"waits for its turn in the fleet queue",
		...(eta !== undefined && Number.isFinite(eta) ? { etaMs: eta } : {}),
		...(reopensAt !== undefined ? { retryAt: reopensAt } : {}),
	};
}
