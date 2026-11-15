/**
 * Work state of the session coordinator: derives whether the session is busy, blocked, done or faulted in liveness
 * from its foreground, worker, tool, evaluation and goal owners, runs the watchdog that recovers or blocks an
 * orphaned objective, and holds the wait on running workers. The coordinator supplies its owners through one ports object.
 */

import type { AssistantMessage } from "@caupulican/pi-ai";
import type { SessionManager } from "../kernel/session/session-manager.ts";
import { isInterruptedAssistantStopReason } from "./agent-session-contracts.ts";
import type { LaneRecord } from "./autonomy/lane-tracker.ts";
import type { BackgroundLaneController } from "./background-lane-controller.ts";
import type { BackgroundToolTaskController } from "./background-tool-task-controller.ts";
import type { ForegroundRecoveryController } from "./foreground-recovery-controller.ts";
import { DEFAULT_GOAL_WORKER_WAIT_MS } from "./goals/goal-continuation-defaults.ts";
import type { GoalSessionController } from "./goals/goal-session-controller.ts";
import { type GoalState, isGoalExecutionActive } from "./goals/goal-state.ts";
import { getResumableHumanInputSnapshot } from "./human-input.ts";
import { ObjectiveExecutionInterruptedError } from "./objective-execution/current-objective-execution.ts";
import type { TaskRuntimeProjection } from "./orchestration/task-runtime.ts";
import type { SessionSemanticPlaneController } from "./session-semantic-plane-controller.ts";
import { hasRunningBackgroundedToolCall } from "./session-settlement.ts";
import {
	deriveSessionWorkState,
	type SessionWorkerFacts,
	type SessionWorkerState,
	type SessionWorkStateInput,
} from "./session-work-state.ts";

export interface AgentSessionWorkStatePorts {
	getForegroundActivity(): { sessionId: string; epoch?: number; busy: boolean };
	backgroundLanes(): BackgroundLaneController;
	backgroundToolTasks(): BackgroundToolTaskController;
	hasPendingIdleContinuation(): boolean;
	getGoalStateSnapshot(): GoalState | undefined;
	isStreaming(): boolean;
	isCompacting(): boolean;
	isRetrying(): boolean;
	foregroundRecovery(): ForegroundRecoveryController;
	semanticPlane(): SessionSemanticPlaneController;
	sessionManager(): SessionManager;
	findLastAssistantMessage(): AssistantMessage | undefined;
	goals(): GoalSessionController;
	isDisposed(): boolean;
}

export class AgentSessionWorkState {
	private readonly ports: AgentSessionWorkStatePorts;

	constructor(ports: AgentSessionWorkStatePorts) {
		this.ports = ports;
	}

	getSessionWorkState(): SessionWorkerState {
		const activity = this.ports.getForegroundActivity();
		const lanesInFlight = this.ports
			.backgroundLanes()
			.getLaneRecords()
			.filter((lane) => lane.status === "queued" || lane.status === "running");
		// The phase counts every lane in flight, a worker waiting for its retry included.
		const hasRunningWorker = lanesInFlight.length > 0;
		const hasRunningTool = hasRunningBackgroundedToolCall(this.ports.backgroundToolTasks().list());
		const hasPendingContinuation = this.ports.hasPendingIdleContinuation();
		const goalSnapshot = this.ports.getGoalStateSnapshot();
		const isBlocked = goalSnapshot?.status === "blocked";
		const isDone = goalSnapshot?.status === "completed";

		const isAwaitingUser = getResumableHumanInputSnapshot(this.ports.sessionManager())?.status === "pending";
		const isObjectiveActive = goalSnapshot ? isGoalExecutionActive(goalSnapshot.status) : false;
		const hasActiveExecutionOrOwner =
			this.ports.isStreaming() ||
			this.ports.isCompacting() ||
			this.ports.isRetrying() ||
			this.ports.foregroundRecovery().isRunActive ||
			activity.epoch !== undefined ||
			(this.ports.semanticPlane().controller?.isEvaluating ?? false) ||
			this.ports.semanticPlane().health.getHealth(true).state === "evaluating" ||
			hasRunningWorker ||
			hasRunningTool ||
			hasPendingContinuation ||
			isAwaitingUser;

		const livenessFault = Boolean(isObjectiveActive && !hasActiveExecutionOrOwner);

		const input: SessionWorkStateInput = {
			isStreaming: this.ports.isStreaming(),
			isCompacting: this.ports.isCompacting(),
			isRetrying: this.ports.isRetrying(),
			hasSubmissionLease: activity.epoch !== undefined,
			isRunActive: this.ports.foregroundRecovery().isRunActive,
			isSystemOneEvaluating: this.ports.semanticPlane().controller?.isEvaluating ?? false,
			isSemanticEvaluating: this.ports.semanticPlane().health.getHealth(true).state === "evaluating",
			hasRunningWorker,
			hasRunningTool,
			hasPendingContinuation,
			isAwaitingUser,
			isBlocked,
			isDone,
			livenessFault,
			epoch: activity.epoch,
			sessionId: this.ports.sessionManager().getSessionId(),
			objectiveId: goalSnapshot?.goalId,
		};
		return {
			...deriveSessionWorkState(input),
			...workerFacts(lanesInFlight, this.ports.backgroundLanes().getTaskRuntimeSnapshot(), input),
		};
	}

	/**
	 * Watchdog for orphaned objectives (F2 / OC-03):
	 * Detects an active objective with no owner, worker, evaluation, or continuation.
	 * Bounded recovery schedules an idle continuation pass; otherwise transitions to blocked.
	 */
	checkOrphanedObjectiveWatchdog(): boolean {
		const workState = this.getSessionWorkState();
		if (!workState.livenessFault) return false;

		// Bounded recovery: try scheduling continuation from idle
		if (!isInterruptedAssistantStopReason(this.ports.findLastAssistantMessage()?.stopReason)) {
			this.ports.backgroundLanes().scheduleGoalAutoContinueFromIdle();
			if (this.ports.backgroundLanes().hasPendingIdleContinuation()) {
				return false;
			}
		}

		// Recovery exhausted or not allowed: block explicitly
		return this.ports
			.goals()
			.markLivenessFaultBlocked(
				workState.faultReason ??
					"Liveness fault: objective has no active owner, worker, evaluation, or continuation",
			);
	}

	/**
	 * The objective loop's wait: every captured running attempt, in-process or managed, until one of them leaves
	 * "running", the goal's worker-wait bound elapses, the loop is cancelled or the session is disposed. Only a
	 * captured terminal is observed; the loop re-reads readiness after a terminal or the bound, and stops on disposal.
	 */
	async waitForObjectiveWorkers(context: unknown, signal?: AbortSignal): Promise<void> {
		const attempts =
			context &&
			typeof context === "object" &&
			Array.isArray((context as { inFlightAttempts?: unknown }).inFlightAttempts)
				? ((context as { inFlightAttempts: readonly { attemptId: string }[] }).inFlightAttempts ?? [])
				: [];
		if (!attempts.length) return;
		const outcome = await this.ports.backgroundLanes().waitForRunningAttempts(
			attempts.map((attempt) => attempt.attemptId),
			{ timeoutMs: DEFAULT_GOAL_WORKER_WAIT_MS, ...(signal ? { signal } : {}) },
		);
		// A disposed session ends the loop, whichever event settled the wait first.
		if (outcome.kind === "disposed" || this.ports.isDisposed())
			throw new ObjectiveExecutionInterruptedError("session_disposed");
	}
}

/**
 * The facts of the lanes in flight (`SessionWorkerFacts`), each worker lane read by its attempt in `snapshot`: leased or
 * running is running; suspended until a retry waits for it; queued, suspended for another reason or awaiting its result's
 * verification is other work. A lane with no attempt, or whose attempt the projection does not hold, counts as running.
 */
function workerFacts(
	lanes: readonly LaneRecord[],
	snapshot: TaskRuntimeProjection | undefined,
	input: SessionWorkStateInput,
): SessionWorkerFacts {
	let running = false;
	let other = false;
	let until: number | undefined;
	for (const lane of lanes) {
		const attempt = lane.attemptId === undefined ? undefined : snapshot?.attempts[lane.attemptId];
		const retryAt =
			attempt?.status === "suspended" && attempt.retry ? Date.parse(attempt.retry.notBefore) : Number.NaN;
		if (!attempt || attempt.status === "leased" || attempt.status === "running") running = true;
		else if (Number.isFinite(retryAt)) until = Math.min(until ?? retryAt, retryAt);
		else other = true;
	}
	return {
		hasRunningWorker: running,
		busyBesideWorkers: deriveSessionWorkState({ ...input, hasRunningWorker: false }).busy,
		workerLanes:
			lanes.length === 0
				? { kind: "none" }
				: running || other || until === undefined
					? { kind: "active" }
					: { kind: "retries", until },
	};
}
