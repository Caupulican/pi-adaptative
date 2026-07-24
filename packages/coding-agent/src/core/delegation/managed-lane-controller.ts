import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type { CapabilityEnvelope, WorkerClaim, WorkerClaimStatus, WorkerRequest } from "../autonomy/contracts.ts";
import { getPrivateLaneDeniedPaths } from "../autonomy/lane-private-paths.ts";
import { isLaneTerminalStatus, type LaneRecord, type LaneTerminalStatus } from "../autonomy/lane-tracker.ts";
import { appendLaneRecordSnapshot, getLatestLaneRecordSnapshots } from "../autonomy/session-lane-record.ts";
import type { ManagedLaneDispatch, ManagedLaneEvent } from "../extensions/types.ts";
import type { GoalState } from "../goals/goal-state.ts";
import type { ExecutionGrant } from "../orchestration/contracts.ts";
import { createWorkerResultContract } from "../orchestration/worker-result-adapter.ts";
import { registerInFlightWork } from "../reload-blockers.ts";
import { getActiveSessionBranchEntries } from "../session-snapshot.ts";
import { reviewManagedLaneChangedFiles } from "./worker-claim.ts";
import { compileManagedProcessExecutionGrant } from "./worker-execution-policy.ts";
import type { WorkerLifecycle } from "./worker-lifecycle.ts";

const LEGACY_MANAGED_LEASE_TTL_MS = 24 * 60 * 60 * 1_000;
const LEGACY_MANAGED_READ_TOOLS = ["read", "grep", "find", "ls"] as const;

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
	getGoalStateSnapshot(): GoalState | undefined;
	getCapabilityEnvelope(): CapabilityEnvelope | undefined;
	saveWorkerClaimSnapshot(claim: WorkerClaim, request?: WorkerRequest): string;
}

/** Out-of-process adapter over the same durable worker lifecycle used by in-process delegation. */
export class ManagedLaneController {
	private readonly deps: ManagedLaneControllerDeps;
	private readonly lifecycle: WorkerLifecycle;
	private readonly recordTerminal: (record: LaneRecord, durableNotificationId: string) => void;
	private readonly deregisterByLane = new Map<string, () => void>();
	private hydrated = false;

	constructor(
		deps: ManagedLaneControllerDeps,
		lifecycle: WorkerLifecycle,
		recordTerminal: (record: LaneRecord, durableNotificationId: string) => void,
	) {
		this.deps = deps;
		this.lifecycle = lifecycle;
		this.recordTerminal = recordTerminal;
	}

	ensureHydrated(): void {
		if (this.hydrated) return;
		this.hydrated = true;
		const durableIds = new Set(this.lifecycle.getManagedRecords().map((record) => record.laneId));
		for (const legacy of getLatestLaneRecordSnapshots(getActiveSessionBranchEntries(this.deps.getSessionManager()))) {
			if (
				legacy.type !== "tmux-worker" ||
				(legacy.status !== "queued" && legacy.status !== "running") ||
				durableIds.has(legacy.laneId)
			) {
				continue;
			}
			this.lifecycle.prepareManaged({
				laneId: legacy.laneId,
				dispatchSequence: 1,
				instructions: legacy.label ?? `Resume externally managed lane ${legacy.laneId}`,
				profileId: legacy.profileId ?? "legacy-managed-process",
				provider: "legacy",
				authorizationId: `legacy-session-lane:${legacy.laneId}`,
				role: "implementer",
				riskBudget: { maxAttempts: 1, maxWallClockMs: LEGACY_MANAGED_LEASE_TTL_MS },
				leaseTtlMs: LEGACY_MANAGED_LEASE_TTL_MS,
				compileGrant: (target) =>
					this.compileGrant(target, legacy.laneId, {
						sequence: 1,
						instructions: legacy.label ?? `Resume externally managed lane ${legacy.laneId}`,
						profileId: legacy.profileId ?? "legacy-managed-process",
						provider: "legacy",
						authorizationId: `legacy-session-lane:${legacy.laneId}`,
						authorizationKind: "legacy-recovery",
						allowedTools: LEGACY_MANAGED_READ_TOOLS,
						writePaths: [],
						leaseTtlMs: LEGACY_MANAGED_LEASE_TTL_MS,
					}),
				...(legacy.worktreeLaneKey ? { worktreeLaneKey: legacy.worktreeLaneKey } : {}),
			});
		}
		for (const record of this.lifecycle.getManagedRecords()) {
			if (record.status === "queued" || record.status === "running") this.ensureRegistration(record.laneId);
		}
	}

	resolve(callerLaneId: string): string | undefined {
		this.ensureHydrated();
		const record = this.lifecycle.getManagedRecord(callerLaneId);
		return record && (record.status === "queued" || record.status === "running") ? callerLaneId : undefined;
	}

	record(event: ManagedLaneEvent): LaneRecord | undefined {
		if (this.deps.isDisposed()) return undefined;
		this.ensureHydrated();
		if (event.phase === "dispatch") {
			const goal = this.deps.getGoalStateSnapshot();
			const prepared = this.lifecycle.prepareManaged({
				laneId: event.laneId,
				dispatchSequence: event.dispatch.sequence,
				instructions: event.dispatch.instructions,
				profileId: event.dispatch.profileId,
				provider: event.dispatch.provider,
				authorizationId: event.dispatch.authorizationId,
				leaseTtlMs: event.dispatch.leaseTtlMs,
				compileGrant: (target) => this.compileGrant(target, event.laneId, event.dispatch),
				role: "implementer",
				riskBudget: { maxAttempts: 1, maxWallClockMs: event.dispatch.leaseTtlMs },
				...(goal && Array.isArray(goal.requirements) && (!event.goalId || goal.goalId === event.goalId)
					? { goal }
					: {}),
				...(event.goalId ? { goalId: event.goalId } : {}),
				...(event.worktreeLaneKey ? { worktreeLaneKey: event.worktreeLaneKey } : {}),
			});
			if (!prepared.created) return undefined;
			this.ensureRegistration(event.laneId);
			appendLaneRecordSnapshot(this.deps.getSessionManager(), prepared.record);
			return prepared.record;
		}

		const attempt = this.lifecycle.getManagedAttempt(event.laneId);
		const handle = this.lifecycle.getManagedHandle(event.laneId);
		if (!attempt || !handle || (attempt.status !== "leased" && attempt.status !== "running")) return undefined;
		const resolvedStatus = resolveManagedLaneTerminalStatus(event.status);
		const changedFiles = event.changedFiles ? [...event.changedFiles] : [];
		const review = reviewManagedLaneChangedFiles({
			changedFiles,
			envelope: this.deps.getCapabilityEnvelope() ?? {},
			cwd: this.deps.getCwd(),
		});
		const claim: WorkerClaim = {
			requestId: event.laneId,
			status: mapManagedLaneTerminalStatus(resolvedStatus),
			summary: `Managed worker lane ${event.laneId} reported terminal status "${event.status ?? "unknown"}"${
				event.reasonCode ? ` (${event.reasonCode})` : ""
			}.${review.reviewRequired ? ` Changed files require parent review (${review.reasonCode}).` : ""}`,
			changedFiles,
			parentReviewRequired: review.reviewRequired,
			createdAt: new Date().toISOString(),
		};
		let record: LaneRecord | undefined;
		try {
			this.deps.saveWorkerClaimSnapshot(claim);
		} finally {
			try {
				const usage = event.usage;
				record = this.lifecycle.finish(
					createWorkerResultContract({
						handle,
						claim,
						accepted: resolvedStatus === "succeeded" && !review.reviewRequired,
						costUsd: usage?.cost.total,
						cwd: this.deps.getCwd(),
						...(usage
							? {
									inputTokens: usage.input,
									outputTokens: usage.output,
									totalTokens: usage.totalTokens,
								}
							: {}),
						wallClockMs: Math.max(0, Date.now() - Date.parse(attempt.createdAt)),
						toolCalls: 0,
						reasonCode: review.reviewRequired
							? `parent_review_required:${review.reasonCode}`
							: (event.reasonCode ?? `managed_worker_${resolvedStatus}`),
					}),
				);
				const notification = this.lifecycle.getTerminalNotification(event.laneId);
				if (notification) this.recordTerminal(record, notification.notificationId);
				appendLaneRecordSnapshot(this.deps.getSessionManager(), record);
			} finally {
				this.releaseRegistration(event.laneId);
			}
		}
		return record;
	}

	release(): void {
		for (const deregister of this.deregisterByLane.values()) deregister();
		this.deregisterByLane.clear();
	}

	private ensureRegistration(laneId: string): void {
		if (this.deregisterByLane.has(laneId)) return;
		this.deregisterByLane.set(laneId, registerInFlightWork(this.deps.getAgentDir(), "lane", `tmux:${laneId}`));
	}

	private releaseRegistration(laneId: string): void {
		this.deregisterByLane.get(laneId)?.();
		this.deregisterByLane.delete(laneId);
	}

	private compileGrant(
		target: { objectiveId: string; taskId: string; attemptId: string },
		laneId: string,
		dispatch: ManagedLaneDispatch,
	): ExecutionGrant {
		const compiled = compileManagedProcessExecutionGrant({
			target,
			laneId,
			authorizationId: dispatch.authorizationId,
			role: "implementer",
			allowedTools: dispatch.allowedTools,
			writePaths: dispatch.writePaths,
			cwd: this.deps.getCwd(),
			deniedPaths: getPrivateLaneDeniedPaths(this.deps.getCwd(), this.deps.getAgentDir()),
			budget: {
				maxAttempts: 1,
				maxWallClockMs: dispatch.leaseTtlMs,
				...(dispatch.maxCostUsd !== undefined ? { maxCostUsd: dispatch.maxCostUsd } : {}),
			},
		});
		if (!compiled.ok) {
			throw new Error(`Managed worker '${laneId}' execution grant was denied: ${compiled.reasonCodes.join(", ")}`);
		}
		return compiled.grant;
	}
}
