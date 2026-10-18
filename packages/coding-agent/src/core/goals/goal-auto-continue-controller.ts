import { AsyncLocalStorage } from "node:async_hooks";
import { AgentBusyError } from "../../kernel/agent.ts";
import type {
	AgentSessionEvent,
	GoalContinuationLoopOptions,
	GoalContinuationLoopResult,
	PromptOptions,
} from "../agent-session.ts";
import type { AutonomySettings } from "../settings/settings-schema.ts";
import { SYSTEM_TIMER_PORT, type TimerPort } from "../util/timer-port.ts";
import type { GoalRuntimeSnapshot, GoalRuntimeSnapshotSettings } from "./goal-runtime-snapshot.ts";

/** The settings this module reads, declared by the module itself; the composition root passes the SettingsManager. */
export interface GoalAutoContinueControllerSettingsSource {
	getAutonomySettings(): Required<AutonomySettings>;
	subscribeChanges(listener: () => void): () => void;
}

export interface GoalAutoContinueControllerDeps {
	isDisposed(): boolean;
	isGoalToolActive(): boolean;
	getSettingsManager(): GoalAutoContinueControllerSettingsSource;
	getGoalRuntimeSnapshot(settings: GoalRuntimeSnapshotSettings): GoalRuntimeSnapshot;
	hasInFlightLaneForGoal(goalId: string): boolean;
	continueGoalLoop(options: GoalContinuationLoopOptions): Promise<GoalContinuationLoopResult>;
	isForegroundBusy(): boolean;
	waitForForegroundIdle(): Promise<void>;
	markGoalToolUnavailable(): void;
	emit(event: AgentSessionEvent): void;
	onContinuationActivity?(): void;
	/**
	 * The `goal-continuation` port the wake is armed on (the continuation delay, a worker-deadline resume, the
	 * scheduled-failure retry). Defaults to the system timers.
	 */
	timers?: TimerPort;
}

type GoalAutoContinueScheduleSettings = Pick<
	ReturnType<GoalAutoContinueControllerSettingsSource["getAutonomySettings"]>,
	"goalAutoContinue" | "goalAutoContinueDelayMs" | "maxStallTurns"
>;

/**
 * `workerDeadline` is the never-hang wake owned by a goal waiting on a bound worker; `continuation`
 * submits the next pass. Only the former is armed unconditionally when a pass ends.
 */
type GoalAutoContinueTimerPlan =
	| { action: "clear" }
	| { action: "arm"; delayMs: number; wake: "workerDeadline" | "continuation" };

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
	private _timer: unknown;
	private _isContinuing = false;
	/** Set when a wake was requested while a pass ran; consumed when that pass ends. */
	private _replanAfterPass = false;
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
		if (options?.autoContinueGoal === false || this._disposed || this.deps.isDisposed()) return;
		// A wake requested while a pass runs (an objective terminal's restart, a transient-failure
		// resume) cannot arm now; the pass's end owns it instead of dropping the only event that
		// continues the goal.
		if (this._isContinuing) {
			this._replanAfterPass = true;
			return;
		}
		this.planAndArm("any");
	}

	private planAndArm(wakes: "any" | "workerDeadline"): void {
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
		if (wakes === "workerDeadline" && plan.wake !== "workerDeadline") return;
		this._scheduledFailureRetryMs = INITIAL_SCHEDULED_FAILURE_RETRY_MS;
		this.armTimer(plan.delayMs);
	}

	/**
	 * Every pass, whichever entry point admitted it, ends here. A goal left waiting on a bound worker
	 * always gets its never-hang deadline wake; a further pass is armed only when something asked for
	 * one during the pass, so an explicit turn limit keeps its meaning.
	 */
	private armAfterPass(replanRequested: boolean): void {
		if (this._disposed || this.deps.isDisposed()) return;
		// The pass's own admission store ends with the pass: a timer armed here must not carry it into
		// its callback, where busy and settled checks would no longer see the armed continuation.
		ownIdleContinuationAdmission.exit(() => {
			try {
				this.planAndArm(replanRequested ? "any" : "workerDeadline");
			} catch (error) {
				this.handleScheduledFailure(error);
			}
		});
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

	private planTimer(
		settings: ReturnType<GoalAutoContinueControllerSettingsSource["getAutonomySettings"]>,
	): GoalAutoContinueTimerPlan {
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
		// The worker deadline is stamped and decided on the goal state's clock (the system clock the runtime snapshot reads),
		// so its remaining delay is measured on that clock too. An alarm that fires before it (a host driving this port, a
		// clock correction) only re-plans: `runScheduled` arms the wake again for what is left.
		return waitingForWorkerDeadline
			? { action: "arm", delayMs: Math.max(0, resumeAtMs - Date.now()), wake: "workerDeadline" }
			: { action: "arm", delayMs: goalAutoContinueDelayMs, wake: "continuation" };
	}

	private armTimer(delayMs: number, notify = true): void {
		// Acquire the replacement before releasing the last valid timer. Planning or allocation
		// failure therefore cannot erase the only event that owns future goal progress.
		// The port's alarms never hold the process open: an armed continuation is not work a run waits behind.
		const timers = this.deps.timers ?? SYSTEM_TIMER_PORT;
		const timer = timers.setTimeout(() => {
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
		if (previous !== undefined) timers.clearTimeout(previous);
		if (notify) this.deps.onContinuationActivity?.();
	}

	async continueExclusive(options: GoalContinuationLoopOptions): Promise<GoalContinuationLoopResult> {
		if (this._isContinuing) return this.skippedResult(options, "already_continuing");
		const initialGuard = this.unavailableResult(options);
		if (initialGuard) return initialGuard;
		return ownIdleContinuationAdmission.run(true, () => this.continueAdmitted(options));
	}

	private async continueAdmitted(options: GoalContinuationLoopOptions): Promise<GoalContinuationLoopResult> {
		this._isContinuing = true;
		this._replanAfterPass = false;
		this.deps.onContinuationActivity?.();
		// An owner interrupt ends autonomy until the owner acts again; nothing is armed after it.
		let interrupted = false;
		try {
			while (true) {
				if (this.deps.isForegroundBusy()) await this.deps.waitForForegroundIdle();
				const postWaitGuard = this.unavailableResult(options);
				if (postWaitGuard) return postWaitGuard;
				try {
					const result = await this.deps.continueGoalLoop(options);
					interrupted = result.stopReason === "turn_interrupted";
					return result;
				} catch (error) {
					// A different foreground owner can acquire the Agent after the idle event but before
					// prompt admission. Wait for that exact run and retry without terminalizing the goal.
					if (!(error instanceof AgentBusyError)) throw error;
				}
			}
		} finally {
			this._isContinuing = false;
			const replanRequested = this._replanAfterPass;
			this._replanAfterPass = false;
			if (!interrupted) this.armAfterPass(replanRequested);
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
		(this.deps.timers ?? SYSTEM_TIMER_PORT).clearTimeout(this._timer);
		this._timer = undefined;
		if (notify) this.deps.onContinuationActivity?.();
		return true;
	}

	private ensureSettingsSubscription(
		settingsManager: GoalAutoContinueControllerSettingsSource,
		settings: ReturnType<GoalAutoContinueControllerSettingsSource["getAutonomySettings"]>,
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
			this._replanAfterPass = true;
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
		settings: ReturnType<GoalAutoContinueControllerSettingsSource["getAutonomySettings"]>,
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
