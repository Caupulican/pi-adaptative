import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type { Usage } from "@caupulican/pi-ai";
import type { CapabilityEnvelope, WorkerClaim, WorkerClaimStatus, WorkerRequest } from "../autonomy/contracts.ts";
import { getPrivateLaneDeniedPaths } from "../autonomy/lane-private-paths.ts";
import { isLaneTerminalStatus, type LaneRecord, type LaneTerminalStatus } from "../autonomy/lane-tracker.ts";
import { appendLaneRecordSnapshot, getLatestLaneRecordSnapshots } from "../autonomy/session-lane-record.ts";
import type { ManagedLaneDispatch, ManagedLaneEvent } from "../extensions/types.ts";
import type { GoalState } from "../goals/goal-state.ts";
import { validateProviderUsage } from "../orchestration/attempt-usage.ts";
import type { ExecutionGrant } from "../orchestration/contracts.ts";
import { registerInFlightWork } from "../reload-blockers.ts";
import { getActiveSessionBranchEntries } from "../session-snapshot.ts";
import { getLatestWorkerClaimSnapshot } from "./session-worker-claim.ts";
import {
	normalizeWorkerClaimForHost,
	normalizeWorkerClaimReasonCode,
	reviewManagedLaneChangedFiles,
} from "./worker-claim.ts";
import { compileManagedProcessExecutionGrant } from "./worker-execution-policy.ts";
import type { WorkerLifecycle } from "./worker-lifecycle.ts";
import { finalizeWorkerClaim } from "./worker-terminal-finalizer.ts";

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
	/** Optional only for minimal host embeddings; normal AgentSession integration always supplies this. */
	addSpawnedUsage?(
		usage: Usage,
		opts: { label?: string; sourceSessionId?: string; reportId: string },
	): string | undefined;
}

/** Out-of-process adapter over the same durable worker lifecycle used by in-process delegation. */
export class ManagedLaneController {
	private readonly deps: ManagedLaneControllerDeps;
	private readonly lifecycle: WorkerLifecycle;
	private readonly recordTerminal: (record: LaneRecord, durableNotificationId: string) => void;
	private readonly warn: (message: string) => void;
	private readonly deregisterByLane = new Map<string, () => void>();
	private hydrated = false;

	constructor(
		deps: ManagedLaneControllerDeps,
		lifecycle: WorkerLifecycle,
		recordTerminal: (record: LaneRecord, durableNotificationId: string) => void,
		warn: (message: string) => void = () => {},
	) {
		this.deps = deps;
		this.lifecycle = lifecycle;
		this.recordTerminal = recordTerminal;
		this.warn = warn;
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
		let usage: Usage | undefined;
		try {
			usage = event.usage ? validateProviderUsage(event.usage, "managed lane usage") : undefined;
		} catch (error) {
			this.warn(
				`Rejected terminal report for managed worker ${event.laneId}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return undefined;
		}
		const resolvedStatus = resolveManagedLaneTerminalStatus(event.status);
		const usageReportId = usage && this.deps.addSpawnedUsage ? `managed-worker:${handle.attemptId}` : undefined;
		let claim: WorkerClaim;
		try {
			claim = normalizeWorkerClaimForHost({
				requestId: event.laneId,
				terminalAttemptId: handle.attemptId,
				status: mapManagedLaneTerminalStatus(resolvedStatus),
				summary: `Managed worker lane ${event.laneId} reported terminal status "${resolvedStatus}".`,
				changedFiles: event.changedFiles ?? [],
				...(usageReportId ? { usageReportId } : {}),
				createdAt: new Date().toISOString(),
			});
		} catch (error) {
			this.warn(
				`Rejected terminal report for managed worker ${event.laneId}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return undefined;
		}
		const review = reviewManagedLaneChangedFiles({
			changedFiles: claim.changedFiles,
			envelope: this.deps.getCapabilityEnvelope() ?? {},
			cwd: this.deps.getCwd(),
		});
		claim = normalizeWorkerClaimForHost({
			...claim,
			summary: `${claim.summary}${
				review.reviewRequired ? ` Changed files require parent review (${review.reasonCode}).` : ""
			}`,
			parentReviewRequired: review.reviewRequired,
		});
		let record: LaneRecord | undefined;
		let finalized = false;
		try {
			// Accounting must commit before the lifecycle terminal transition. A failed append leaves the
			// fenced attempt active so the same terminal event can retry with this stable report id.
			if (usage && usageReportId) {
				this.deps.addSpawnedUsage?.(usage, { label: "managed-worker", reportId: usageReportId });
			}
			if (!this.hasPersistedClaimForAttempt(claim)) this.deps.saveWorkerClaimSnapshot(claim);
			const terminal = finalizeWorkerClaim(this.lifecycle, {
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
				reasonCode: normalizeWorkerClaimReasonCode(
					review.reviewRequired ? `parent_review_required:${review.reasonCode}` : event.reasonCode,
					`managed_worker_${resolvedStatus}`,
				),
			});
			record = terminal.record;
			finalized = true;
			if (terminal.notification) this.recordTerminal(record, terminal.notification.notificationId);
			appendLaneRecordSnapshot(this.deps.getSessionManager(), record);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (finalized) {
				this.warn(
					`Managed worker ${event.laneId} finalized, but terminal projection or handoff failed: ${message}`,
				);
				return record;
			}
			this.warn(`Managed worker ${event.laneId} terminal processing failed and remains retryable: ${message}`);
			return undefined;
		} finally {
			if (finalized) this.releaseRegistration(event.laneId);
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

	/** A replay after a crash between claim append and lifecycle finalization must not duplicate the claim. */
	private hasPersistedClaimForAttempt(claim: WorkerClaim): boolean {
		if (!claim.terminalAttemptId) return false;
		const latest = getLatestWorkerClaimSnapshot(
			getActiveSessionBranchEntries(this.deps.getSessionManager()),
			claim.requestId,
		);
		return latest?.claim.terminalAttemptId === claim.terminalAttemptId;
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
