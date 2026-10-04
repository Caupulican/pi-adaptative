import type { Usage } from "@caupulican/pi-ai";
import type { SessionManager } from "../../kernel/node.ts";
import type { CapabilityEnvelope, WorkerClaim, WorkerClaimStatus, WorkerRequest } from "../autonomy/contracts.ts";
import { getPrivateLaneDeniedPaths } from "../autonomy/lane-private-paths.ts";
import { isLaneTerminalStatus, type LaneRecord, type LaneTerminalStatus } from "../autonomy/lane-tracker.ts";
import { getTamperWatchedPaths, ProtectedPathWatch } from "../autonomy/protected-path-watch.ts";
import { appendLaneRecordSnapshot, getLatestLaneRecordSnapshots } from "../autonomy/session-lane-record.ts";
import {
	MAX_MANAGED_LANE_SUMMARY_BYTES,
	type ManagedLaneDispatch,
	type ManagedLaneEvent,
} from "../extensions/managed-lane-records.ts";
import type { GoalState } from "../goals/goal-state.ts";
import { validateProviderUsage } from "../orchestration/attempt-usage.ts";
import type { ExecutionGrant } from "../orchestration/contracts.ts";
import { registerInFlightWork } from "../reload-blockers.ts";
import { wrapUntrustedText } from "../security/untrusted-boundary.ts";
import { getActiveSessionBranchEntries } from "../session-snapshot.ts";
import type { WorktreeLaneLifecycle } from "../worktree-sync/lane-lifecycle.ts";
import { getLatestWorkerClaimSnapshot } from "./session-worker-claim.ts";
import {
	inconclusiveLinesIn,
	normalizeWorkerClaimForHost,
	normalizeWorkerClaimReasonCode,
	reviewManagedLaneChangedFiles,
} from "./worker-claim.ts";
import { compileManagedProcessExecutionGrant } from "./worker-execution-policy.ts";
import { ManagedLaneLifetimeInputError, type WorkerLifecycle } from "./worker-lifecycle.ts";
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
			return "blocked";
		case "dismissed":
		case "cancelled":
		case "stopped":
			return "canceled";
		default:
			return "failed";
	}
}

export function mapManagedLaneTerminalStatus(status: LaneTerminalStatus): WorkerClaimStatus {
	switch (status) {
		case "succeeded":
			return "completed";
		case "partial":
		case "budget_exhausted":
			return "partial";
		case "blocked":
			return "blocked";
		case "canceled":
			return "cancelled";
		case "failed":
		case "timeout":
			return "failed";
	}
}

export interface ManagedLaneControllerDeps {
	isDisposed(): boolean;
	getAgentDir(): string;
	getCwd(): string;
	getSessionManager(): SessionManager;
	getGoalStateSnapshot(): GoalState | undefined;
	/** Current foreground submission epoch, or undefined when none is held. Read once, at genuine
	 * dispatch-phase lane creation in `record()`, to stamp the new lane's owner epoch via
	 * `noteLaneOwnerEpoch` -- mirrors `WorkerDelegationControllerDeps.getCurrentSubmissionEpoch`. */
	getCurrentSubmissionEpoch?(): number | undefined;
	getCapabilityEnvelope(): CapabilityEnvelope | undefined;
	saveWorkerClaimSnapshot(claim: WorkerClaim, request?: WorkerRequest): string;
	/**
	 * Findings a worker could not settle, for the owner. Under a handoff they are written to the
	 * owner's follow-up document and its path is returned; with the owner in the loop, undefined.
	 */
	recordUnsettledForOwner?(items: readonly string[]): string | undefined;
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
	private readonly noteLaneOwnerEpoch: (laneId: string, ownerEpoch: number) => void;
	private readonly warn: (message: string) => void;
	private readonly worktreeLanes: WorktreeLaneLifecycle | undefined;
	private readonly deregisterByLane = new Map<string, () => void>();
	/**
	 * Parent-side fingerprints of the harness write-protected set, taken when a managed worker is dispatched and
	 * compared at its terminal report. The worker is a separate process whose own tool calls this host cannot
	 * see, and a detector inside it would be under the control of what it watches, so the comparison runs here.
	 */
	private readonly protectedPathWatches = new Map<string, ProtectedPathWatch>();
	private readonly worktreeLaneSteps = new Map<string, Promise<void>>();
	private hydrated = false;

	constructor(
		deps: ManagedLaneControllerDeps,
		lifecycle: WorkerLifecycle,
		recordTerminal: (record: LaneRecord, durableNotificationId: string) => void,
		warn: (message: string) => void = () => {},
		noteLaneOwnerEpoch: (laneId: string, ownerEpoch: number) => void = () => {},
		worktreeLanes?: WorktreeLaneLifecycle,
	) {
		this.deps = deps;
		this.lifecycle = lifecycle;
		this.recordTerminal = recordTerminal;
		this.warn = warn;
		this.noteLaneOwnerEpoch = noteLaneOwnerEpoch;
		this.worktreeLanes = worktreeLanes;
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
		if (this.deps.isDisposed()) throw new Error("Cannot record a managed lane after its owning session is disposed.");
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
				...(event.worktreeLaneKey && event.worktreeLanePath ? { worktreeLanePath: event.worktreeLanePath } : {}),
			});
			if (!prepared.created) return undefined;
			this.watchProtectedPaths(event.laneId, event.worktreeLanePath);
			this.ensureRegistration(event.laneId);
			appendLaneRecordSnapshot(this.deps.getSessionManager(), prepared.record);
			// Genuine dispatch (guarded by `prepared.created` above -- a replayed/idempotent dispatch of
			// an already-durable lane returns `undefined` earlier and never reaches here). Capture the
			// owner epoch exactly once, at this same creation moment, never on a later terminal report
			// for the same laneId.
			const ownerEpoch = this.deps.getCurrentSubmissionEpoch?.();
			if (ownerEpoch !== undefined) this.noteLaneOwnerEpoch(event.laneId, ownerEpoch);
			if (event.worktreeLaneKey) {
				const worktreeLaneKey = event.worktreeLaneKey;
				const worktreeLanePath = event.worktreeLanePath;
				this.runWorktreeLaneStep(event.laneId, () =>
					this.worktreeLanes?.bind(worktreeLaneKey, event.laneId, worktreeLanePath),
				);
			}
			return prepared.record;
		}

		if (event.phase === "lifecycle") {
			// "retained" is the state every dispatched lane already starts in, so only a closure carries
			// new information. Nothing here touches the turn: no claim, no usage, no parent handoff.
			if (event.agentLifecycle !== "retired") return undefined;
			// The lane key is read from the host-retained dispatch, never from this closure report.
			const dispatched = this.lifecycle.getManagedAttempt(event.laneId)?.dispatch;
			const worktreeLaneKey = dispatched?.worktreeLaneKey;
			const worktreeLanePath = dispatched?.worktreeLanePath;
			let record: LaneRecord | undefined;
			try {
				record = this.lifecycle.retireManaged(event.laneId, event.dispatchSequence);
			} catch (error) {
				// Only an unattributable REPORT is dropped -- it names no generation this lane can own.
				// A durable runtime or store failure keeps propagating: swallowing it here would let the
				// producer mark this closure published when nothing was persisted.
				if (!(error instanceof ManagedLaneLifetimeInputError)) throw error;
				this.warn(`Rejected lifetime report for managed worker ${event.laneId}: ${error.message}`);
				return undefined;
			}
			if (record) appendLaneRecordSnapshot(this.deps.getSessionManager(), record);
			this.releaseRegistration(event.laneId);
			if (worktreeLaneKey) {
				this.runWorktreeLaneStep(event.laneId, () =>
					this.worktreeLanes?.retire(worktreeLaneKey, event.laneId, worktreeLanePath),
				);
			}
			return record;
		}

		const attempt = this.lifecycle.getManagedAttempt(event.laneId);
		const handle = this.lifecycle.getManagedHandle(event.laneId);
		if (!attempt || !handle) throw new Error(`Unknown managed worker '${event.laneId}'.`);
		if (event.dispatchSequence !== undefined && event.dispatchSequence !== attempt.dispatch.dispatchSequence)
			throw new Error(`Managed worker '${event.laneId}' terminal sequence does not match its current dispatch.`);
		if (attempt.status !== "leased" && attempt.status !== "running") return undefined;
		let usage: Usage | undefined;
		const resolvedStatus = resolveManagedLaneTerminalStatus(event.status);
		let usageReportId: string | undefined;
		let claim: WorkerClaim;
		try {
			usage = event.usage ? validateProviderUsage(event.usage, "managed lane usage") : undefined;
			usageReportId = usage && this.deps.addSpawnedUsage ? `managed-worker:${handle.attemptId}` : undefined;
			const descriptor = Object.getOwnPropertyDescriptor(event, "summary");
			if (descriptor && !("value" in descriptor))
				throw new Error("Managed terminal summary must not be an accessor.");
			const summary: unknown = descriptor?.value;
			if (
				summary !== undefined &&
				(typeof summary !== "string" ||
					summary.length > MAX_MANAGED_LANE_SUMMARY_BYTES ||
					Buffer.byteLength(summary, "utf8") > MAX_MANAGED_LANE_SUMMARY_BYTES)
			)
				throw new Error(
					`Managed terminal summary exceeds ${MAX_MANAGED_LANE_SUMMARY_BYTES} UTF-8 bytes or is not text.`,
				);
			claim = normalizeWorkerClaimForHost({
				requestId: event.laneId,
				terminalAttemptId: handle.attemptId,
				status: mapManagedLaneTerminalStatus(resolvedStatus),
				summary: `Managed worker lane ${event.laneId} reported terminal status "${resolvedStatus}".${summary ? `\n${wrapUntrustedText(summary, `managed-worker:${event.laneId}`, { nonce: handle.attemptId })}` : ""}`,
				changedFiles: event.changedFiles ?? [],
				...(usageReportId ? { usageReportId } : {}),
				createdAt: new Date().toISOString(),
			});
		} catch (error) {
			this.warn(
				`Rejected terminal report for managed worker ${event.laneId}: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw error;
		}
		const tamper = this.protectedPathWatches.get(event.laneId)?.finishBlockers() ?? [];
		const review = reviewManagedLaneChangedFiles({
			changedFiles: claim.changedFiles,
			envelope: this.deps.getCapabilityEnvelope() ?? {},
			cwd: this.deps.getCwd(),
		});
		// An out-of-process lane leaves no transcript the host can judge its findings from, and its own
		// narrative is not a receipt: what it marks inconclusive goes to the owner as reported.
		const inconclusive = inconclusiveLinesIn(typeof event.summary === "string" ? event.summary : undefined);
		for (const item of inconclusive) this.warn(`Managed worker ${event.laneId} could not settle: ${item}`);
		const ownerFollowUp = inconclusive.length > 0 ? this.deps.recordUnsettledForOwner?.(inconclusive) : undefined;
		claim = normalizeWorkerClaimForHost({
			...claim,
			summary: `${claim.summary}${
				review.reviewRequired ? ` Changed files require parent review (${review.reasonCode}).` : ""
			}`,
			parentReviewRequired: review.reviewRequired || inconclusive.length > 0 || tamper.length > 0,
			...(tamper.length > 0 ? { blockers: [...(claim.blockers ?? []), ...tamper] } : {}),
			...(inconclusive.length > 0 ? { inconclusive } : {}),
			...(ownerFollowUp ? { ownerFollowUp } : {}),
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
				accepted: resolvedStatus === "succeeded" && claim.parentReviewRequired !== true,
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
			throw error;
		} finally {
			if (finalized) {
				this.releaseRegistration(event.laneId);
				this.protectedPathWatches.delete(event.laneId);
			}
		}
		return record;
	}

	/** Take the dispatch-time fingerprint for one managed worker. Detection only: it can never fail a dispatch. */
	private watchProtectedPaths(laneId: string, worktreeLanePath?: string): void {
		try {
			const watch = new ProtectedPathWatch({
				workerId: laneId,
				// A lane's repository is the one whose hooks and config its worker could change.
				paths: getTamperWatchedPaths(worktreeLanePath ?? this.deps.getCwd(), this.deps.getAgentDir()),
			});
			watch.start();
			this.protectedPathWatches.set(laneId, watch);
		} catch (error) {
			this.warn(
				`Protected-path watch for managed worker ${laneId} unavailable: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * Lane bookkeeping is best-effort and must never fail the ledger transition that triggered it. Steps
	 * of one managed lane run in the order their reports arrived: a closure that follows a dispatch
	 * closely must find the lane already bound to this worker, never race the binding.
	 */
	private runWorktreeLaneStep(laneId: string, step: () => Promise<void> | undefined): void {
		const previous = this.worktreeLaneSteps.get(laneId) ?? Promise.resolve();
		const next: Promise<void> = previous
			.then(step)
			.catch((error: unknown) => {
				this.warn(
					`Managed worker ${laneId} worktree lane step failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			})
			.finally(() => {
				if (this.worktreeLaneSteps.get(laneId) === next) this.worktreeLaneSteps.delete(laneId);
			});
		this.worktreeLaneSteps.set(laneId, next);
	}

	release(): void {
		for (const laneId of [...this.deregisterByLane.keys()]) this.releaseRegistration(laneId);
		this.protectedPathWatches.clear();
	}

	private ensureRegistration(laneId: string): void {
		if (this.deregisterByLane.has(laneId)) return;
		this.deregisterByLane.set(laneId, registerInFlightWork(this.deps.getAgentDir(), "lane", `tmux:${laneId}`));
	}

	private releaseRegistration(laneId: string): void {
		const deregister = this.deregisterByLane.get(laneId);
		this.deregisterByLane.delete(laneId);
		try {
			deregister?.();
		} catch (error) {
			try {
				this.warn(
					`Managed worker ${laneId} reload-blocker deregistration failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			} catch {
				// Teardown must keep releasing sibling registrations even when diagnostics fail.
			}
		}
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
