import { AsyncLocalStorage } from "node:async_hooks";
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
	onContinuationActivity?(): void;
}

type GoalAutoContinueScheduleSettings = Pick<
	ReturnType<SettingsManager["getAutonomySettings"]>,
	"goalAutoContinue" | "goalAutoContinueDelayMs" | "maxStallTurns"
>;

type GoalAutoContinueTimerPlan = { action: "clear" } | { action: "arm"; delayMs: number };

const INITIAL_SCHEDULED_FAILURE_RETRY_MS = 1_000;
const MAX_SCHEDULED_FAILURE_RETRY_MS = 60_000;

/**
 * The continuation waits for the foreground and is itself foreground work.
 * Its own wait and prompt run inside this store so they do not observe that bit.
 * Callers outside the store still see the armed continuation.
 */
const ownIdleContinuationAdmission = new AsyncLocalStorage<true>();

export function isOwnIdleContinuationAdmission(): boolean {
	return ownIdleContinuationAdmission.getStore() === true;
}

/** Owns the single-flight goal continuation loop and its foreground-idle timer. */
export class GoalAutoContinueController {
	private _timer: ReturnType<typeof setTimeout> | undefined;
	private _isContinuing = false;
	private _disposed = false;
	private _scheduledFailureRetryMs = INITIAL_SCHEDULED_FAILURE_RETRY_MS;
	private _schedulerSettings: GoalAutoContinueScheduleSettings | undefined;
	private _unsubscribeSettingsChanges: (() => void) | undefined;
	private readonly deps: GoalAutoContinueControllerDeps;

	constructor(deps: GoalAutoContinueControllerDeps) {
		this.deps = deps;
	}

	/**
	 * True while an idle continuation is armed or already running. A run is NOT settled in that
	 * window: the debounce timer will drive another turn without any new input, so a settled
	 * notification sent now would be contradicted moments later.
	 */
	hasPendingContinuation(): boolean {
		return this._timer !== undefined || this._isContinuing;
	}

	clearTimer(): void {
		this.cancelTimer(true);
	}

	dispose(): void {
		if (this._disposed) return;
		this._disposed = true;
		this._unsubscribeSettingsChanges?.();
		this._unsubscribeSettingsChanges = undefined;
		this.clearTimer();
	}

	scheduleFromIdle(options?: PromptOptions): void {
		if (options?.autoContinueGoal === false || this._isContinuing || this._disposed || this.deps.isDisposed()) return;

		const settingsManager = this.deps.getSettingsManager();
		const settings = settingsManager.getAutonomySettings();
		this.ensureSettingsSubscription(settingsManager, settings);
		if (settings.goalAutoContinue && !this.deps.isGoalToolActive() && this.tryMarkGoalToolUnavailable()) {
			this.clearTimer();
			return;
		}
		const plan = this.planTimer(settings);
		if (plan.action === "clear") {
			this.clearTimer();
			return;
		}
		this._scheduledFailureRetryMs = INITIAL_SCHEDULED_FAILURE_RETRY_MS;
		this.armTimer(plan.delayMs);
	}

	/** Reconcile a permanent live tool-surface transition with any admitted continuation. */
	reconcileToolAvailability(resumeGoalToolAvailable?: () => boolean): void {
		if (this._disposed || this.deps.isDisposed()) return;
		if (this.deps.isGoalToolActive()) {
			let resumed = false;
			try {
				resumed = resumeGoalToolAvailable?.() === true;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.deps.emit({
					type: "warning",
					message: `Goal continuation capability restoration failed: ${message}`,
				});
				return;
			}
			if (!resumed) return;
			try {
				this.scheduleFromIdle();
			} catch (error) {
				this.handleScheduledFailure(error);
			}
			return;
		}
		if (this.tryMarkGoalToolUnavailable()) this.clearTimer();
	}

	private tryMarkGoalToolUnavailable(): boolean {
		try {
			// Persist the terminal durable state before publishing that the timer is gone. If
			// persistence fails, retain the last admitted wake so its callback can retry.
			this.deps.markGoalToolUnavailable();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.deps.emit({
				type: "warning",
				message: `Goal continuation capability reconciliation failed: ${message}`,
			});
			return false;
		}
		return true;
	}

	private planTimer(settings: ReturnType<SettingsManager["getAutonomySettings"]>): GoalAutoContinueTimerPlan {
		const { maxStallTurns, goalAutoContinue, goalAutoContinueDelayMs } = settings;
		if (!goalAutoContinue) return { action: "clear" };
		const snapshot = this.deps.getGoalRuntimeSnapshot({ maxStallTurns });
		const continuation = snapshot.continuation;
		const resumeAtMs = continuation.resumeAt === undefined ? Number.NaN : Date.parse(continuation.resumeAt);
		const waitingForWorkerDeadline =
			continuation.action === "waiting" &&
			continuation.reasonCode === "worker_in_flight" &&
			Number.isFinite(resumeAtMs);
		if (continuation.action !== "continue" && !waitingForWorkerDeadline) return { action: "clear" };
		const activeGoalId = snapshot.goalState?.goalId;
		if (
			activeGoalId !== undefined &&
			this.deps.hasInFlightLaneForGoal(activeGoalId) &&
			continuation.reasonCode !== "worker_wait_timeout" &&
			!waitingForWorkerDeadline
		) {
			return { action: "clear" };
		}
		return {
			action: "arm",
			delayMs: waitingForWorkerDeadline ? Math.max(0, resumeAtMs - Date.now()) : goalAutoContinueDelayMs,
		};
	}

	private armTimer(delayMs: number, notify = true): void {
		// Acquire the replacement before releasing the last valid timer. Planning or allocation
		// failure therefore cannot erase the only event that owns future goal progress.
		const timer = setTimeout(() => {
			if (this._timer !== timer) return;
			this._timer = undefined;
			void this.runScheduled()
				.then(() => {
					this._scheduledFailureRetryMs = INITIAL_SCHEDULED_FAILURE_RETRY_MS;
				})
				.catch((error: unknown) => this.handleScheduledFailure(error))
				.finally(() => this.deps.onContinuationActivity?.());
		}, delayMs);
		const previous = this._timer;
		this._timer = timer;
		if (previous !== undefined) clearTimeout(previous);
		if (notify) this.deps.onContinuationActivity?.();
		if (typeof timer === "object" && timer && "unref" in timer) {
			const { unref } = timer as { unref?: () => void };
			unref?.call(timer);
		}
	}

	async continueExclusive(options: GoalContinuationLoopOptions): Promise<GoalContinuationLoopResult> {
		if (this._isContinuing) return this.skippedResult(options, "already_continuing");
		const initialGuard = this.unavailableResult(options);
		if (initialGuard) return initialGuard;
		return ownIdleContinuationAdmission.run(true, () => this.continueAdmitted(options));
	}

	private async continueAdmitted(options: GoalContinuationLoopOptions): Promise<GoalContinuationLoopResult> {
		this._isContinuing = true;
		this.deps.onContinuationActivity?.();
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
			this.deps.onContinuationActivity?.();
		}
	}

	private unavailableResult(options: GoalContinuationLoopOptions): GoalContinuationLoopResult | undefined {
		if (this._disposed || this.deps.isDisposed()) return this.skippedResult(options, "session_disposed");
		if (this.deps.isGoalToolActive()) return undefined;
		this.deps.markGoalToolUnavailable();
		return this.skippedResult(options, "goal_tool_unavailable");
	}

	private async runScheduled(): Promise<void> {
		if (this._isContinuing || this._disposed || this.deps.isDisposed()) return;
		const { maxStallTurns, goalContinueTurns, goalContinueMaxWallClockMinutes, goalAutoContinue } = this.deps
			.getSettingsManager()
			.getAutonomySettings();
		if (!goalAutoContinue) return;
		const snapshot = this.deps.getGoalRuntimeSnapshot({ maxStallTurns });
		if (snapshot.continuation.action !== "continue") {
			// The deadline may move while this timer is armed (a fresher bound worker, clock correction,
			// or an early host wake). Re-evaluate through the single scheduler instead of dropping the
			// only event that can make the never-hang recovery branch reachable.
			if (
				snapshot.continuation.action === "waiting" &&
				snapshot.continuation.reasonCode === "worker_in_flight" &&
				snapshot.continuation.resumeAt !== undefined
			) {
				this.scheduleFromIdle();
			}
			return;
		}
		let interrupted = false;
		try {
			const result = await this.continueExclusive({
				maxTurns: goalContinueTurns,
				maxStallTurns,
				maxWallClockMinutes: goalContinueMaxWallClockMinutes,
			});
			if (result.stopReason === "turn_interrupted") {
				interrupted = true;
			}
		} catch (error) {
			this.emitContinuationFailure(error);
		}
		if (!interrupted && !this._disposed && !this.deps.isDisposed()) {
			const nextSnapshot = this.deps.getGoalRuntimeSnapshot({ maxStallTurns });
			if (nextSnapshot.continuation.action === "continue") {
				this.scheduleFromIdle();
			}
		}
	}

	private emitContinuationFailure(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.deps.emit({ type: "warning", message: `Goal auto-continuation failed: ${message}` });
	}

	private handleScheduledFailure(error: unknown): void {
		this.emitContinuationFailure(error);
		if (this._disposed || this.deps.isDisposed()) return;
		try {
			// A settings transition can run synchronously inside the failing read after this
			// callback has consumed its timer. Respect a proven disable; an unreadable setting is
			// unknown and retains liveness through the bounded retry below.
			if (!this.deps.getSettingsManager().getAutonomySettings().goalAutoContinue) return;
		} catch {
			// Preserve the retry when current policy cannot be read; the next wake re-evaluates it.
		}
		const delayMs = this._scheduledFailureRetryMs;
		this._scheduledFailureRetryMs = Math.min(MAX_SCHEDULED_FAILURE_RETRY_MS, delayMs * 2);
		try {
			// Keep the retry admission atomic with the callback's final activity publication so
			// observers never see a transient settled state between failure and recovery.
			this.armTimer(delayMs, false);
		} catch (retryError) {
			const message = retryError instanceof Error ? retryError.message : String(retryError);
			this.deps.emit({
				type: "warning",
				message: `Goal auto-continuation recovery timer failed: ${message}`,
			});
		}
	}

	private cancelTimer(notify: boolean): boolean {
		if (this._timer === undefined) return false;
		clearTimeout(this._timer);
		this._timer = undefined;
		if (notify) this.deps.onContinuationActivity?.();
		return true;
	}

	private ensureSettingsSubscription(
		settingsManager: SettingsManager,
		settings: ReturnType<SettingsManager["getAutonomySettings"]>,
	): void {
		this._schedulerSettings = this.schedulerSettings(settings);
		if (
			this._unsubscribeSettingsChanges !== undefined ||
			this._disposed ||
			typeof settingsManager.subscribeChanges !== "function"
		) {
			return;
		}
		this._unsubscribeSettingsChanges = settingsManager.subscribeChanges(() => this.reconcileSettingsChange());
	}

	private reconcileSettingsChange(): void {
		if (this._disposed) return;
		const settings = this.deps.getSettingsManager().getAutonomySettings();
		const next = this.schedulerSettings(settings);
		const previous = this._schedulerSettings;
		if (
			previous !== undefined &&
			previous.goalAutoContinue === next.goalAutoContinue &&
			previous.goalAutoContinueDelayMs === next.goalAutoContinueDelayMs &&
			previous.maxStallTurns === next.maxStallTurns
		) {
			return;
		}
		if (!next.goalAutoContinue || this.deps.isDisposed()) {
			this._schedulerSettings = next;
			this.clearTimer();
			return;
		}
		if (this._isContinuing) {
			this._schedulerSettings = next;
			return;
		}

		try {
			this.scheduleFromIdle();
		} catch (error) {
			// SettingsManager deliberately contains listener failures. Preserve the last valid
			// timer and prior reconciliation mark so an exact repeat can retry the current
			// settings instead of silently losing ownership.
			this._schedulerSettings = previous;
			const message = error instanceof Error ? error.message : String(error);
			this.deps.emit({
				type: "warning",
				message: `Goal auto-continuation settings reconciliation failed: ${message}`,
			});
		}
	}

	private schedulerSettings(
		settings: ReturnType<SettingsManager["getAutonomySettings"]>,
	): GoalAutoContinueScheduleSettings {
		return {
			goalAutoContinue: settings.goalAutoContinue,
			goalAutoContinueDelayMs: settings.goalAutoContinueDelayMs,
			maxStallTurns: settings.maxStallTurns,
		};
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
