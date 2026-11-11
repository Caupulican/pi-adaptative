/**
 * Scheduling of the retention pass: one idle timer on the `retention` owner, the throttle between passes (waived under
 * pressure and for a truncated prune's continuation), the single-flight run with its warnings, and the store-full notice
 * with the external holds that the pass computed. The pass (retention-pass.ts) decides what is released.
 */

import type { TimerPort } from "../../kernel/timer-port.ts";
import type { HarnessNoticeObservation } from "../harness-notice.ts";
import { describeObjectiveLimit } from "./retention.ts";
import {
	isUnderRetentionPressure,
	type RetentionPassDeps,
	type RetentionPassResult,
	runRetentionPass,
} from "./retention-pass.ts";
import type { OrchestrationProjectionCapacity } from "./task-runtime-state.ts";

/** The idle delay before a pass may run, so it never starts on the turn that just settled. */
export const RETENTION_IDLE_DELAY_MS = 5_000;
/** The least time between two passes, unless the store is under pressure or a truncated prune continues. */
export const RETENTION_MIN_INTERVAL_MS = 600_000;
/** The share of a limit at which the store counts as full, for the notice. */
const STORE_FULL_SHARE = 0.9;

function nearFull(capacity: OrchestrationProjectionCapacity): boolean {
	const { counts, limits } = capacity;
	return (
		counts.objectives >= limits.objectives * STORE_FULL_SHARE ||
		counts.tasks >= limits.tasks * STORE_FULL_SHARE ||
		counts.attempts >= limits.attempts * STORE_FULL_SHARE ||
		counts.agents >= limits.agents * STORE_FULL_SHARE ||
		counts.notifications >= limits.notifications * STORE_FULL_SHARE
	);
}

export interface RetentionControllerDeps {
	/** The `retention` owner's port: its idle delay and the throttle clock. */
	readonly timers: TimerPort;
	readonly isDisposed: () => boolean;
	readonly isChildSession: () => boolean;
	readonly isForegroundBusy: () => boolean;
	readonly hasWorkerState: () => boolean;
	readonly closedObjectiveDays: () => number;
	/** The projection's capacity; undefined when the session has no worker state. */
	readonly capacity: () => OrchestrationProjectionCapacity | undefined;
	readonly pass: () => Omit<RetentionPassDeps, "warn">;
	readonly observeNotice: (read: () => HarnessNoticeObservation | undefined) => void;
	readonly warn: (message: string) => void;
}

export class OrchestrationRetentionController {
	private readonly deps: RetentionControllerDeps;
	private _timer: unknown;
	private _running = false;
	private _lastRunAt: number | undefined;
	/** Set when a truncated prune asked for its continuation; the next run then skips the throttle. */
	private _continuing = false;
	private readonly _reported = new Set<string>();

	constructor(deps: RetentionControllerDeps) {
		this.deps = deps;
	}

	/** Arms one idle run unless one is armed or running; the run re-checks every gate when it fires. */
	scheduleFromIdle(): void {
		if (this._timer !== undefined || this._running) return;
		if (this.deps.isDisposed() || this.deps.isChildSession() || !this.deps.hasWorkerState()) return;
		if (this.deps.closedObjectiveDays() === 0) return;
		this.arm(RETENTION_IDLE_DELAY_MS);
	}

	clearTimer(): void {
		if (this._timer === undefined) return;
		this.deps.timers.clearTimeout(this._timer);
		this._timer = undefined;
	}

	/** The single-flight run. Errors never escape: they are reported once through `warn`. */
	runOnce(): RetentionPassResult | undefined {
		if (this._running) return undefined;
		this._running = true;
		try {
			return this.run();
		} catch (error) {
			this.warnOnce(`Orchestration retention: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		} finally {
			this._running = false;
		}
	}

	private arm(delayMs: number): void {
		const timer = this.deps.timers.setTimeout(() => {
			if (this._timer !== timer) return;
			this._timer = undefined;
			this.runOnce();
		}, delayMs);
		const previous = this._timer;
		this._timer = timer;
		if (previous !== undefined) this.deps.timers.clearTimeout(previous);
	}

	private run(): RetentionPassResult | undefined {
		const continuing = this._continuing;
		this._continuing = false;
		if (this.deps.isDisposed() || this.deps.isChildSession() || this.deps.isForegroundBusy()) return undefined;
		if (!this.deps.hasWorkerState() || this.deps.closedObjectiveDays() === 0) return undefined;
		const capacity = this.deps.capacity();
		if (capacity === undefined) return undefined;
		const now = this.deps.timers.now();
		const throttled = this._lastRunAt !== undefined && now - this._lastRunAt < RETENTION_MIN_INTERVAL_MS;
		if (throttled && !continuing && !isUnderRetentionPressure(capacity)) return undefined;
		this._lastRunAt = now;
		const passDeps = this.deps.pass();
		const result = runRetentionPass({ ...passDeps, warn: (message) => this.warnOnce(message) });
		if (result.kind === "pruned" && result.truncated) {
			this._continuing = true;
			this.arm(0);
		}
		this.observeStore(result, passDeps);
		return result;
	}

	/** Holds the store-full notice while a pass finds nothing to release in a nearly full store; clears it below 90%. */
	private observeStore(result: RetentionPassResult, passDeps: Omit<RetentionPassDeps, "warn">): void {
		const capacity = this.deps.capacity();
		if (capacity === undefined) return;
		if (!nearFull(capacity)) {
			this.deps.observeNotice(() => "clear");
			return;
		}
		if (result.kind !== "nothing") return;
		const state = passDeps.runtime().getSnapshot();
		const text = describeObjectiveLimit(state, result.external);
		this.deps.observeNotice(() => ({ reason: "store-full-held", text }));
	}

	/** Reports one text once for the controller's life: a damaged archive or a repeated failure is not repeated. */
	private warnOnce(message: string): void {
		if (this._reported.has(message)) return;
		this._reported.add(message);
		this.deps.warn(message);
	}
}
