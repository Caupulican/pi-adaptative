/**
 * The fleet's remote-machine backend contract and its admit decision: ordered code exits over a linked machine's status,
 * room and the job placement's commit.
 */

import type { PlacementCapacitySource } from "../placement/capacity-source.ts";
import type { AdmitDecision, FleetDispatch, FleetRefusal, WeightClass } from "./fleet-types.ts";

export type RemoteRefusalCode =
	| "unlinked"
	| "held"
	| "writes"
	| "no_facts"
	| "jobs_disabled"
	| "too_long"
	| "secret"
	| "project_missing";

export interface RemoteMachineStatus {
	readonly linked: boolean;
	readonly held: boolean;
	readonly online: boolean;
	readonly offlineHoldMs: number;
}

export type RemoteCommit =
	| { readonly kind: "placed"; readonly taskId: string; readonly attemptId: string; readonly laneId: string }
	| { readonly kind: "not_prepared" }
	| { readonly kind: "attempt_unknown" }
	| { readonly kind: "runtime_replacing" };

export interface RemoteBackendPort {
	status(machineId: string): RemoteMachineStatus;
	prepare(
		dispatch: FleetDispatch,
		machineId: string,
		signal?: AbortSignal,
	): Promise<
		{ readonly ok: true } | { readonly ok: false; readonly code: RemoteRefusalCode; readonly detail: string }
	>;
	commit(dispatch: FleetDispatch, machineId: string): RemoteCommit;
	release(idempotencyKey: string): void;
	/** True when `taskId` is a job this session placed (it is cancelled); false leaves it to the local lanes. */
	cancel(taskId: string, reasonCode: string): boolean;
}

export const REMOTE_RETRY_MS = 30_000;

/** The refusal when no remote backend is registered with the fleet. */
export const REMOTE_NO_BACKEND: FleetRefusal = {
	kind: "refused",
	reason: "placement",
	blocker: "placement_unreachable",
	detail: "no remote backend is registered",
};

/** A remote refusal as the fleet's refusal: its class, its blocker and, for a backoff, when it is worth another try. */
export function remoteRefusal(code: RemoteRefusalCode, detail: string, now: number): FleetRefusal {
	switch (code) {
		case "writes":
		case "too_long":
		case "secret":
			return { kind: "refused", reason: "preflight", blocker: "preflight_failed", detail };
		case "jobs_disabled":
		case "no_facts":
			return {
				kind: "refused",
				reason: "placement",
				blocker: "capacity_unavailable",
				retryAt: now + REMOTE_RETRY_MS,
				retryAtBasis: "backoff",
				detail,
			};
		case "unlinked":
		case "held":
		case "project_missing":
			return { kind: "refused", reason: "placement", blocker: "placement_unreachable", detail };
	}
}

/**
 * The admit decision for a job placed on a linked machine. Exits, in order: no backend; not linked; on hold; online with no
 * free slot; the placement's commit (not prepared, an older build's job, the runtime replacing); then placed, online (run)
 * or offline (queued within the offline hold).
 */
export function decideRemoteAdmit(input: {
	readonly port: RemoteBackendPort | undefined;
	readonly source: PlacementCapacitySource | undefined;
	readonly dispatch: FleetDispatch;
	readonly machineId: string;
	readonly now: number;
	readonly weight: WeightClass;
}): AdmitDecision {
	const { port, source, dispatch, machineId, now, weight } = input;
	if (!port) return REMOTE_NO_BACKEND;
	const status = port.status(machineId);
	if (!status.linked) return remoteRefusal("unlinked", "that machine is not linked with this one", now);
	if (status.held) return remoteRefusal("held", "the machine is on hold; /remote release lifts it", now);
	if (status.online && (source?.room().slots ?? 0) < 1)
		return {
			kind: "refused",
			reason: "placement",
			blocker: "capacity_unavailable",
			retryAt: now + REMOTE_RETRY_MS,
			retryAtBasis: "backoff",
			detail: `machine:${machineId} has no free slot`,
		};
	const commit = port.commit(dispatch, machineId);
	if (commit.kind === "not_prepared")
		return {
			kind: "refused",
			reason: "preflight",
			blocker: "preflight_failed",
			detail: "this remote dispatch was not prepared, or its preparation was released",
		};
	if (commit.kind === "attempt_unknown")
		return {
			kind: "refused",
			reason: "preflight",
			blocker: "preflight_failed",
			detail: "this job was placed by an older build; its attempt is unknown here",
		};
	if (commit.kind === "runtime_replacing")
		return {
			kind: "refused",
			reason: "placement",
			blocker: "capacity_unavailable",
			retryAt: now + REMOTE_RETRY_MS,
			retryAtBasis: "backoff",
			detail: "the runtime is being replaced; the job is kept prepared",
		};
	if (!status.online)
		return {
			kind: "queued",
			taskId: commit.taskId,
			attemptId: commit.attemptId,
			laneId: commit.laneId,
			reason: "placement_offline",
			detail: "the machine is offline; the job waits for it within the offline hold",
			retryAt: now + status.offlineHoldMs,
		};
	return {
		kind: "run",
		taskId: commit.taskId,
		attemptId: commit.attemptId,
		laneId: commit.laneId,
		backend: "remote",
		accountKey: `machine:${machineId}`,
		modelRef: "link/remote-job",
		weight,
	};
}
