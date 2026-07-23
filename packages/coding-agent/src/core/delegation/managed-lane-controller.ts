import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type { CapabilityEnvelope, WorkerClaim, WorkerClaimStatus, WorkerRequest } from "../autonomy/contracts.ts";
import {
	isLaneTerminalStatus,
	type LaneRecord,
	type LaneTerminalStatus,
	type LaneTracker,
} from "../autonomy/lane-tracker.ts";
import { ManagedLaneRegistry } from "../autonomy/managed-lane-registry.ts";
import type { ManagedLaneEvent } from "../extensions/types.ts";
import { reviewManagedLaneChangedFiles } from "./worker-claim.ts";

export function resolveManagedLaneTerminalStatus(status: string | undefined): LaneTerminalStatus {
	if (isLaneTerminalStatus(status)) return status;
	switch (status) {
		case "done":
		case "completed":
			return "succeeded";
		case "blocked":
			return "failed";
		case "dismissed":
		case "cancelled":
			return "canceled";
		default:
			return "failed";
	}
}

export function mapManagedLaneTerminalStatus(status: LaneTerminalStatus): WorkerClaimStatus {
	switch (status) {
		case "succeeded":
			return "completed";
		case "canceled":
			return "cancelled";
		case "failed":
		case "timeout":
		case "budget_exhausted":
			return "failed";
	}
}

export interface ManagedLaneControllerDeps {
	isDisposed(): boolean;
	getAgentDir(): string;
	getCwd(): string;
	getSessionManager(): SessionManager;
	getCapabilityEnvelope(): CapabilityEnvelope | undefined;
	saveWorkerClaimSnapshot(claim: WorkerClaim, request?: WorkerRequest): string;
}

/** Owns out-of-process managed-lane identity, lifecycle persistence, claim review, and closeout. */
export class ManagedLaneController {
	private readonly deps: ManagedLaneControllerDeps;
	private readonly registry: ManagedLaneRegistry;
	private readonly recordTerminal: (record: LaneRecord) => void;

	constructor(deps: ManagedLaneControllerDeps, lanes: LaneTracker, recordTerminal: (record: LaneRecord) => void) {
		this.deps = deps;
		this.registry = new ManagedLaneRegistry({
			agentDir: deps.getAgentDir(),
			lanes,
			sessionManager: deps.getSessionManager(),
		});
		this.recordTerminal = recordTerminal;
	}

	ensureHydrated(): void {
		this.registry.ensureHydrated();
	}

	resolve(callerLaneId: string): string | undefined {
		return this.registry.resolve(callerLaneId);
	}

	record(event: ManagedLaneEvent): LaneRecord | undefined {
		if (this.deps.isDisposed()) return undefined;
		if (event.phase === "dispatch") {
			return this.registry.start({
				laneId: event.laneId,
				goalId: event.goalId,
				worktreeLaneKey: event.worktreeLaneKey,
			});
		}

		const resolvedStatus = resolveManagedLaneTerminalStatus(event.status);
		const record = this.registry.finish(event.laneId, {
			status: resolvedStatus,
			reasonCode: event.reasonCode,
			costUsd: event.usage?.cost.total,
		});
		if (!record) return undefined;
		const changedFiles = event.changedFiles ? [...event.changedFiles] : [];
		const review = reviewManagedLaneChangedFiles({
			changedFiles,
			envelope: this.deps.getCapabilityEnvelope() ?? {},
			cwd: this.deps.getCwd(),
		});
		const claim: WorkerClaim = {
			requestId: record.laneId,
			status: mapManagedLaneTerminalStatus(resolvedStatus),
			summary: `Managed tmux-worker lane ${record.laneId} reported terminal status "${event.status ?? "unknown"}"${
				event.reasonCode ? ` (${event.reasonCode})` : ""
			}.${review.reviewRequired ? ` Changed files require parent review (${review.reasonCode}).` : ""}`,
			changedFiles,
			parentReviewRequired: review.reviewRequired,
			createdAt: new Date().toISOString(),
		};
		try {
			this.deps.saveWorkerClaimSnapshot(claim);
		} finally {
			this.recordTerminal(record);
		}
		return record;
	}

	release(): void {
		this.registry.release();
	}
}
