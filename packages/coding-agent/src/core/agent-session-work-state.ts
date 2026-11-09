/**
 * Work state of the session coordinator: derives whether the session is busy, blocked, done or faulted in liveness
 * from its foreground, worker, tool, evaluation and goal owners, runs the watchdog that recovers or blocks an
 * orphaned objective, and holds the wait on running workers. The coordinator supplies its owners through one ports object.
 */

import type { AssistantMessage } from "@caupulican/pi-ai";
import type { SessionManager } from "../kernel/session/session-manager.ts";
import { isInterruptedAssistantStopReason } from "./agent-session-contracts.ts";
import type { BackgroundLaneController } from "./background-lane-controller.ts";
import type { BackgroundToolTaskController } from "./background-tool-task-controller.ts";
import type { ForegroundRecoveryController } from "./foreground-recovery-controller.ts";
import { DEFAULT_GOAL_WORKER_WAIT_MS } from "./goals/goal-continuation-defaults.ts";
import type { GoalSessionController } from "./goals/goal-session-controller.ts";
import { type GoalState, isGoalExecutionActive } from "./goals/goal-state.ts";
import { getResumableHumanInputSnapshot } from "./human-input.ts";
import { ObjectiveExecutionInterruptedError } from "./objective-execution/current-objective-execution.ts";
import type { SessionSemanticPlaneController } from "./session-semantic-plane-controller.ts";
import { hasRunningBackgroundedToolCall } from "./session-settlement.ts";
import { deriveSessionWorkState, type SessionWorkState } from "./session-work-state.ts";

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

	getSessionWorkState(): SessionWorkState {
		const activity = this.ports.getForegroundActivity();
		const hasRunningWorker = this.ports
			.backgroundLanes()
			.getLaneRecords()
			.some((lane) => lane.status === "queued" || lane.status === "running");
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

		return deriveSessionWorkState({
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
		});
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
