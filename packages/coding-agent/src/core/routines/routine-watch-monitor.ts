/**
 * Arms the session's watch routines and reports what they observe to the routine store. A watch costs no model call
 * while it waits: a file and a managed process are followed by operating-system events, and a port, command or page by
 * a timer on the owner's cadence that re-arms only after its check finished. Every observation goes through the store's
 * edge rule (`observeWatch`), which fires a pending occurrence in the same write as the cursor it advances; this monitor
 * decides nothing. Nothing is evaluated while the session is closed.
 *
 * An edge the store cannot take yet (an earlier firing is not claimed, the journal is full) is kept as the routine's
 * latest observation and offered again on the next store change, so a file that does not change twice still fires once.
 */

import { type FSWatcher, watch as watchDirectory } from "node:fs";
import { basename, dirname } from "node:path";
import { harnessLog } from "../../kernel/harness-log.ts";
import { processMatrixDir } from "../process-matrix/store.ts";
import { boundedRedactedDiagnosticText } from "../security/secret-text.ts";
import type { TimerPort } from "../util/timer-port.ts";
import { type RoutineDefinitionView, type RoutineWatchSchedule, routineEnded } from "./routine-contract.ts";
import type { RoutineStorePort } from "./routine-store-port.ts";
import { type WatchCondition, watchCadenceMs } from "./watch-contract.ts";
import type { WatchSample, WatchSampler } from "./watch-evaluators.ts";

/** Wait after the last file-system event before a file or process is observed, so a burst of writes is one observation. */
const WATCH_DEBOUNCE_MS = 300;

export interface RoutineWatchMonitorDeps {
	readonly store: Pick<RoutineStorePort, "reload" | "subscribe" | "listRoutines" | "observeWatch">;
	readonly sampler: Pick<WatchSampler, "sample">;
	readonly parentSessionId: string;
	readonly timers: TimerPort;
	/** The directory process-matrix entries live in (a managed process's terminal state is a file change there). */
	readonly agentDir: () => string;
	isDisposed(): boolean;
	warn(message: string): void;
}

interface ArmedWatch {
	readonly routineId: string;
	readonly incarnationId: string;
	readonly key: string;
	readonly condition: WatchCondition;
	readonly abort: AbortController;
	timer: unknown;
	watcher: FSWatcher | undefined;
	/** The latest observation the store could not take yet. */
	pending: WatchSample | undefined;
	/** An observation is running; a trigger meanwhile asks for one more after it. */
	running: boolean;
	again: boolean;
}

/** Why a condition is not being followed, as a class for the log; never the condition itself. */
type SkipClass = "refused" | "watcher-failed";

function watchesOf(
	routine: RoutineDefinitionView,
): routine is RoutineDefinitionView & { schedule: RoutineWatchSchedule } {
	return routine.schedule.kind === "event" && routine.schedule.source === "watch";
}

export class RoutineWatchMonitor {
	private readonly deps: RoutineWatchMonitorDeps;
	private readonly armed = new Map<string, ArmedWatch>();
	/** Keys whose arming failed; they are tried again only when the routine's condition or incarnation changes. */
	private readonly skipped = new Map<string, string>();
	/** The reason last warned for each routine's failing submission; a reason warns again only after a success or a change. */
	private readonly faults = new Map<string, string>();
	private unsubscribe: (() => void) | undefined;
	private disposed = false;

	constructor(deps: RoutineWatchMonitorDeps) {
		this.deps = deps;
	}

	start(): void {
		if (this.disposed || this.unsubscribe) return;
		this.unsubscribe = this.deps.store.subscribe(() => this.onStoreChange());
		this.sync();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		for (const watch of [...this.armed.values()]) this.disarm(watch);
		this.armed.clear();
	}

	private get active(): boolean {
		return !this.disposed && !this.deps.isDisposed();
	}

	private onStoreChange(): void {
		if (!this.active) return;
		try {
			this.sync();
			for (const watch of this.armed.values()) if (watch.pending) void this.submit(watch, watch.pending);
		} catch (error) {
			this.warn(error);
		}
	}

	/** Arms what the session's enabled, unended watch routines ask for and disarms what no longer applies. */
	private sync(): void {
		const nowMs = this.deps.timers.now();
		const wanted = new Map<string, RoutineDefinitionView & { schedule: RoutineWatchSchedule }>();
		for (const routine of this.deps.store.listRoutines()) {
			if (
				!watchesOf(routine) ||
				!routine.enabled ||
				routine.target.kind !== "session" ||
				routine.target.parentSessionId !== this.deps.parentSessionId ||
				routineEnded(routine, nowMs) !== undefined
			)
				continue;
			wanted.set(routine.routineId, routine);
		}
		for (const watch of [...this.armed.values()]) {
			const routine = wanted.get(watch.routineId);
			if (!routine || watchKey(routine) !== watch.key) {
				this.disarm(watch);
				this.armed.delete(watch.routineId);
			}
		}
		for (const [routineId, key] of [...this.skipped])
			if (wanted.get(routineId) === undefined || watchKey(wanted.get(routineId)!) !== key)
				this.skipped.delete(routineId);
		for (const [routineId, routine] of wanted)
			if (!this.armed.has(routineId) && this.skipped.get(routineId) !== watchKey(routine)) this.arm(routine);
	}

	private arm(routine: RoutineDefinitionView & { schedule: RoutineWatchSchedule }): void {
		const condition = routine.schedule.condition;
		const key = watchKey(routine);
		const watch: ArmedWatch = {
			routineId: routine.routineId,
			incarnationId: routine.incarnationId,
			key,
			condition,
			abort: new AbortController(),
			timer: undefined,
			watcher: undefined,
			pending: undefined,
			running: false,
			again: false,
		};
		this.armed.set(routine.routineId, watch);
		const cadence = watchCadenceMs(condition);
		try {
			if (cadence === undefined) this.followFilesystem(watch);
		} catch (error) {
			// Without its file-system events the watch still takes its first observation, which sets the baseline or fires
			// for what changed while the session was closed.
			this.armed.delete(routine.routineId);
			this.skip(routine.routineId, key, condition, "watcher-failed", error);
			void this.observe(watch);
			return;
		}
		harnessLog.debug("routines", "a watch was armed", () => ({
			routineId: routine.routineId,
			condition: condition.type,
			timer: cadence !== undefined,
		}));
		// The first observation sets the baseline (or fires, when the store's cursor says the state changed while closed).
		void this.observe(watch);
	}

	/** A file or a managed process is followed through its directory: a rename-over save or a not-yet-existing file still reports. */
	private followFilesystem(watch: ArmedWatch): void {
		const condition = watch.condition;
		let directory: string;
		let name: string;
		if (condition.type === "file") {
			directory = dirname(condition.path);
			name = basename(condition.path);
		} else if (condition.type === "process") {
			directory = processMatrixDir(this.deps.agentDir());
			name = `${condition.processId}.json`;
		} else return;
		watch.watcher = watchDirectory(directory, { persistent: false }, (_event, filename) => {
			if (filename === null || filename.toString() === name) this.debounce(watch);
		});
		watch.watcher.on("error", (error) => {
			this.disarm(watch);
			this.armed.delete(watch.routineId);
			this.skip(watch.routineId, watch.key, condition, "watcher-failed", error);
		});
	}

	private debounce(watch: ArmedWatch): void {
		if (!this.active || watch.abort.signal.aborted) return;
		if (watch.timer !== undefined) this.deps.timers.clearTimeout(watch.timer);
		watch.timer = this.deps.timers.setTimeout(() => {
			watch.timer = undefined;
			void this.observe(watch);
		}, WATCH_DEBOUNCE_MS);
	}

	private skip(routineId: string, key: string, condition: WatchCondition, reason: SkipClass, error: unknown): void {
		this.skipped.set(routineId, key);
		harnessLog.debug("routines", "a watch was skipped", { routineId, condition: condition.type, reason });
		this.warn(error);
	}

	/** One observation, then the next on the cadence of a timer-based condition (never overlapping the last). */
	private async observe(watch: ArmedWatch): Promise<void> {
		if (watch.running) {
			watch.again = true;
			return;
		}
		watch.running = true;
		try {
			let sample: WatchSample | undefined;
			try {
				sample = await this.deps.sampler.sample(watch.condition, watch.abort.signal);
			} catch (error) {
				if (watch.abort.signal.aborted || !this.active) return;
				// The session no longer admits what it watches: the watch stops, and its routine stays for the owner to change.
				this.disarm(watch);
				this.armed.delete(watch.routineId);
				this.skip(watch.routineId, watch.key, watch.condition, "refused", error);
				return;
			}
			if (!this.active || watch.abort.signal.aborted) return;
			if (sample === undefined)
				harnessLog.debug("routines", "a watch observation was skipped", {
					routineId: watch.routineId,
					condition: watch.condition.type,
					reason: "unknown",
				});
			else await this.submit(watch, sample);
		} finally {
			watch.running = false;
			if (this.active && !watch.abort.signal.aborted && this.armed.get(watch.routineId) === watch) {
				const cadence = watchCadenceMs(watch.condition);
				if (watch.again) {
					watch.again = false;
					void this.observe(watch);
				} else if (cadence !== undefined) {
					watch.timer = this.deps.timers.setTimeout(() => {
						watch.timer = undefined;
						void this.observe(watch);
					}, cadence);
				}
			}
		}
	}

	private async submit(watch: ArmedWatch, sample: WatchSample): Promise<void> {
		if (!this.active || watch.abort.signal.aborted) return;
		try {
			const outcome = this.deps.store.observeWatch({
				routineId: watch.routineId,
				incarnationId: watch.incarnationId,
				parentSessionId: this.deps.parentSessionId,
				nowMs: this.deps.timers.now(),
				observation: sample.observation,
				event: sample.event,
			});
			watch.pending = outcome === "held" ? sample : undefined;
			if (outcome === "fired")
				harnessLog.info("routines", "a watch condition became true", {
					routineId: watch.routineId,
					condition: watch.condition.type,
					change: sample.event.change,
				});
			else if (outcome === "recorded")
				harnessLog.debug("routines", "a watch recorded its baseline or re-armed", {
					routineId: watch.routineId,
					condition: watch.condition.type,
				});
			else if (outcome === "held")
				harnessLog.debug("routines", "a watch firing waits for room", {
					routineId: watch.routineId,
					reason: "held",
				});
			this.faults.delete(watch.routineId);
		} catch (error) {
			// The write did not happen (another process holds the store lock, or the store is unreadable): the observation is
			// kept and offered again on the next store change, since an event-driven condition may never report again.
			watch.pending = sample;
			if ((error as NodeJS.ErrnoException | undefined)?.code === "ELOCKED") return;
			const reason = error instanceof Error ? error.message : String(error);
			if (this.faults.get(watch.routineId) === reason) return;
			this.faults.set(watch.routineId, reason);
			this.warn(error);
		}
	}

	private disarm(watch: ArmedWatch): void {
		watch.abort.abort();
		if (watch.timer !== undefined) this.deps.timers.clearTimeout(watch.timer);
		watch.timer = undefined;
		watch.watcher?.close();
		watch.watcher = undefined;
	}

	private warn(error: unknown): void {
		try {
			this.deps.warn(
				`Routine watch: ${boundedRedactedDiagnosticText(error instanceof Error ? error.message : String(error)) ?? "operation unavailable"}`,
			);
		} catch {
			/* Diagnostics retain no authority. */
		}
	}
}

/** Identity of what a watch observes: the routine's incarnation and condition. A prompt-only edit keeps it. */
function watchKey(routine: RoutineDefinitionView & { schedule: RoutineWatchSchedule }): string {
	return `${routine.incarnationId}:${JSON.stringify(routine.schedule.condition)}`;
}
