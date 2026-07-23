import type {
	AgentSessionEvent,
	GoalContinuationLoopOptions,
	GoalContinuationLoopResult,
	PromptOptions,
} from "../agent-session.ts";
import { type ModelCapabilityProfile, scaleContinuationBudgetsForCapability } from "../model-capability.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { GoalRuntimeSnapshot, GoalRuntimeSnapshotSettings } from "./goal-runtime-snapshot.ts";

export interface GoalAutoContinueControllerDeps {
	isDisposed(): boolean;
	isGoalToolActive(): boolean;
	getSettingsManager(): SettingsManager;
	getModelCapabilityProfile(): ModelCapabilityProfile;
	getGoalRuntimeSnapshot(settings: GoalRuntimeSnapshotSettings): GoalRuntimeSnapshot;
	hasInFlightLaneForGoal(goalId: string): boolean;
	continueGoalLoop(options: GoalContinuationLoopOptions): Promise<GoalContinuationLoopResult>;
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
		if (!this.deps.getModelCapabilityProfile().backgroundLanesEnabled) return;

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
		if (this.deps.isDisposed()) return this.skippedResult(options, "session_disposed");
		if (!this.deps.isGoalToolActive()) return this.skippedResult(options, "goal_tool_unavailable");
		this._isContinuing = true;
		try {
			return await this.deps.continueGoalLoop(options);
		} finally {
			this._isContinuing = false;
		}
	}

	private async runScheduled(): Promise<void> {
		if (this._isContinuing || this.deps.isDisposed()) return;
		const { maxStallTurns, goalContinueTurns, goalContinueMaxWallClockMinutes, goalAutoContinue } = this.deps
			.getSettingsManager()
			.getAutonomySettings();
		if (!goalAutoContinue) return;
		const snapshot = this.deps.getGoalRuntimeSnapshot({ maxStallTurns });
		if (snapshot.continuation.action !== "continue") return;
		const scaled = scaleContinuationBudgetsForCapability(this.deps.getModelCapabilityProfile(), {
			maxTurns: goalContinueTurns,
			maxWallClockMinutes: goalContinueMaxWallClockMinutes,
		});
		try {
			await this.continueExclusive({
				maxTurns: scaled.maxTurns,
				maxStallTurns,
				maxWallClockMinutes: scaled.maxWallClockMinutes,
			});
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
