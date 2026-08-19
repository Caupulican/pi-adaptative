import { AgentBusyError } from "@caupulican/pi-agent-core/agent";
import type {
	AgentSessionEvent,
	GoalContinuationLoopOptions,
	GoalContinuationLoopResult,
	PromptOptions,
} from "../agent-session.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { GoalRuntimeSnapshot, GoalRuntimeSnapshotSettings } from "./goal-runtime-snapshot.ts";

export interface GoalAutoContinueControllerDeps {
	isDisposed(): boolean;
	isGoalToolActive(): boolean;
	getSettingsManager(): SettingsManager;
	getGoalRuntimeSnapshot(settings: GoalRuntimeSnapshotSettings): GoalRuntimeSnapshot;
	hasInFlightLaneForGoal(goalId: string): boolean;
	continueGoalLoop(options: GoalContinuationLoopOptions): Promise<GoalContinuationLoopResult>;
	isForegroundBusy(): boolean;
	waitForForegroundIdle(): Promise<void>;
	markGoalToolUnavailable(): void;
	emit(event: AgentSessionEvent): void;
}

/** Owns the single-flight goal continuation loop and its foreground-idle timer. */
export class GoalAutoContinueController {
	private _timer: ReturnType<typeof setTimeout> | undefined;
	private _isContinuing = false;
	private readonly deps: GoalAutoContinueControllerDeps;

	constructor(deps: GoalAutoContinueControllerDeps) {
		this.deps = deps;
	}

	clearTimer(): void {
		if (this._timer !== undefined) {
			clearTimeout(this._timer);
			this._timer = undefined;
		}
	}

	scheduleFromIdle(options?: PromptOptions): void {
		if (options?.autoContinueGoal === false || this._isContinuing || this.deps.isDisposed()) return;

		const { maxStallTurns, goalAutoContinue, goalAutoContinueDelayMs } = this.deps
			.getSettingsManager()
			.getAutonomySettings();
		if (!goalAutoContinue) return;
		const snapshot = this.deps.getGoalRuntimeSnapshot({ maxStallTurns });
		if (snapshot.continuation.action !== "continue") return;
		const activeGoalId = snapshot.goalState?.goalId;
		if (activeGoalId !== undefined && this.deps.hasInFlightLaneForGoal(activeGoalId)) return;

		this.clearTimer();
		this._timer = setTimeout(() => {
			this._timer = undefined;
			void this.runScheduled();
		}, goalAutoContinueDelayMs);
		const timer = this._timer;
		if (typeof timer === "object" && timer && "unref" in timer) {
			const { unref } = timer as { unref?: () => void };
			unref?.call(timer);
		}
	}

	async continueExclusive(options: GoalContinuationLoopOptions): Promise<GoalContinuationLoopResult> {
		if (this._isContinuing) return this.skippedResult(options, "already_continuing");
		const initialGuard = this.unavailableResult(options);
		if (initialGuard) return initialGuard;
		this._isContinuing = true;
		try {
			while (true) {
				if (this.deps.isForegroundBusy()) await this.deps.waitForForegroundIdle();
				const postWaitGuard = this.unavailableResult(options);
				if (postWaitGuard) return postWaitGuard;
				try {
					return await this.deps.continueGoalLoop(options);
				} catch (error) {
					// A different foreground owner can acquire the Agent after the idle event but before
					// prompt admission. Wait for that exact run and retry without terminalizing the goal.
					if (!(error instanceof AgentBusyError)) throw error;
				}
			}
		} finally {
			this._isContinuing = false;
		}
	}

	private unavailableResult(options: GoalContinuationLoopOptions): GoalContinuationLoopResult | undefined {
		if (this.deps.isDisposed()) return this.skippedResult(options, "session_disposed");
		if (this.deps.isGoalToolActive()) return undefined;
		this.deps.markGoalToolUnavailable();
		return this.skippedResult(options, "goal_tool_unavailable");
	}

	private async runScheduled(): Promise<void> {
		if (this._isContinuing || this.deps.isDisposed()) return;
		const { maxStallTurns, goalContinueTurns, goalContinueMaxWallClockMinutes, goalAutoContinue } = this.deps
			.getSettingsManager()
			.getAutonomySettings();
		if (!goalAutoContinue) return;
		const snapshot = this.deps.getGoalRuntimeSnapshot({ maxStallTurns });
		if (snapshot.continuation.action !== "continue") return;
		try {
			const result = await this.continueExclusive({
				maxTurns: goalContinueTurns,
				maxStallTurns,
				maxWallClockMinutes: goalContinueMaxWallClockMinutes,
			});
			if (result.stopReason === "turn_interrupted") return;
			if (!this.deps.isDisposed()) {
				const nextSnapshot = this.deps.getGoalRuntimeSnapshot({ maxStallTurns });
				if (nextSnapshot.continuation.action === "continue") {
					this.scheduleFromIdle();
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.deps.emit({ type: "warning", message: `Goal auto-continuation failed: ${message}` });
		}
	}

	private skippedResult(
		options: GoalContinuationLoopOptions,
		stopReason: "already_continuing" | "session_disposed" | "goal_tool_unavailable",
	): GoalContinuationLoopResult {
		return {
			turnsSubmitted: 0,
			stopReason,
			finalSnapshot: this.deps.getGoalRuntimeSnapshot({ maxStallTurns: options.maxStallTurns }),
		};
	}
}
