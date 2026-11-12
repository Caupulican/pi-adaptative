/**
 * Arms the session's watch routines and reports what they observe to the routine store. A watch costs no model call
 * while it waits: a path (a file, a folder or a glob pattern) and a managed process are followed by operating-system
 * events, and a process id, port, command or page by a timer on the owner's cadence that re-arms only after its check
 * finished. Every observation goes through the store's
 * edge rule (`observeWatch`), which fires a pending occurrence in the same write as the cursor it advances; this monitor
 * decides nothing. Nothing is evaluated while the session is closed.
 *
 * An edge the store cannot take yet (an earlier firing is not claimed, the journal is full) is kept as the routine's
 * latest observation and offered again on the next store change, so a file that does not change twice still fires once.
 */

import { type FSWatcher, statSync, watch as watchDirectory } from "node:fs";
import { basename, dirname } from "node:path";
import { harnessLog } from "../../kernel/harness-log.ts";
import { processMatrixDir } from "../process-matrix/store.ts";
import { boundedRedactedDiagnosticText } from "../security/secret-text.ts";
import type { TimerPort } from "../util/timer-port.ts";
import { type RoutineDefinitionView, type RoutineWatchSchedule, routineEnded } from "./routine-contract.ts";
import type { RoutineStorePort } from "./routine-store-port.ts";
import { isWatchGlob, splitWatchPattern, type WatchCondition, watchCadenceMs } from "./watch-contract.ts";
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
	/** The directory watchers that report this watch's file-system events, by {@link followKey}. */
	readonly watchers: Map<string, FSWatcher>;
	/** The latest observation the store could not take yet. */
	pending: WatchSample | undefined;
	/** An observation is running; a trigger meanwhile asks for one more after it. */
	running: boolean;
	again: boolean;
}

/** Why a condition is not being followed, as a class for the log; never the condition itself. */
type SkipClass = "watcher-failed";

/** One directory whose events report a path or a managed process; `name` limits them to one entry of it. */
interface FollowTarget {
	readonly directory: string;
	readonly recursive: boolean;
	readonly name?: string;
}

function followKey(target: FollowTarget): string {
	return `${target.directory}|${target.recursive}|${target.name ?? ""}`;
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** The directories to watch for a path that is not a file: a pattern's fixed base (the nearest one that exists), recursive when it reaches deeper than one level. */
function patternTarget(pattern: string): FollowTarget {
	const { base, deeper } = splitWatchPattern(pattern);
	let directory = base;
	while (!isDirectory(directory) && dirname(directory) !== directory) directory = dirname(directory);
	return { directory, recursive: deeper };
}

/**
 * Where the events of a condition come from: a file or folder through its own folder (a rename-over save or a
 * not-yet-existing path still reports) and, for a folder watched for changes, the folder itself; a pattern through
 * its base; a managed process through the process matrix. Evaluated again after each observation, since a pattern's
 * base or a watched folder may appear later.
 */
function followTargets(condition: WatchCondition, agentDir: string): FollowTarget[] {
	if (condition.type === "process")
		return [{ directory: processMatrixDir(agentDir), recursive: false, name: `${condition.processId}.json` }];
	if (condition.type !== "file") return [];
	if (isWatchGlob(condition.path)) return [patternTarget(condition.path)];
	const targets: FollowTarget[] = [
		{ directory: dirname(condition.path), recursive: false, name: basename(condition.path) },
	];
	if (condition.on === "changed" && isDirectory(condition.path))
		targets.push({ directory: condition.path, recursive: false });
	return targets;
}

function watchesOf(
	routine: RoutineDefinitionView,
): routine is RoutineDefinitionView & { schedule: RoutineWatchSchedule } {
	return routine.schedule.kind === "event" && routine.schedule.source === "watch";
}

export class RoutineWatchMonitor {
	private readonly deps: RoutineWatchMonitorDeps;
	private readonly armed = new Map<string, ArmedWatch>();
	/** Watchers retained after arming fails to close, so shutdown still owns their final cleanup attempt. */
	private readonly retiredWatchers = new Set<ArmedWatch>();
	/** Keys whose arming failed; they are tried again only when the routine's condition or incarnation changes. */
	private readonly skipped = new Map<string, string>();
	/** The reason last warned for each routine's failing submission; a reason warns again only after a success or a change. */
	private readonly faults = new Map<string, string>();
	/** Every sampling pass is retained until its sampler continuation settles, including a watch removed after arm fails. */
	private readonly observations = new Map<ArmedWatch, Set<Promise<void>>>();
	private unsubscribe: (() => void) | undefined;
	private disposed = false;
	private disposeCompletion: Promise<void> | undefined;

	constructor(deps: RoutineWatchMonitorDeps) {
		this.deps = deps;
	}

	start(): void {
		if (this.disposed || this.unsubscribe) return;
		this.unsubscribe = this.deps.store.subscribe(() => this.onStoreChange());
		this.sync();
	}

	dispose(): Promise<void> {
		if (this.disposeCompletion) return this.disposeCompletion;
		this.disposed = true;
		let complete!: () => void;
		let fail!: (error: unknown) => void;
		this.disposeCompletion = new Promise<void>((resolve, reject) => {
			complete = resolve;
			fail = reject;
		});
		const failures: unknown[] = [];
		const attempt = (operation: () => void): void => {
			try {
				operation();
			} catch (error) {
				failures.push(error);
			}
		};
		attempt(() => this.unsubscribe?.());
		this.unsubscribe = undefined;
		for (const watch of new Set([...this.armed.values(), ...this.retiredWatchers, ...this.observations.keys()]))
			failures.push(...this.release(watch));
		this.armed.clear();
		const observations = [...this.observations.values()].flatMap((active) => [...active]);
		void Promise.allSettled(observations).then((settled) => {
			failures.push(...settled.flatMap((entry) => (entry.status === "rejected" ? [entry.reason] : [])));
			if (failures.length === 0) complete();
			else fail(new AggregateError(failures, "Routine watch disposal or observation failed during shutdown"));
		});
		return this.disposeCompletion;
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
			watchers: new Map(),
			pending: undefined,
			running: false,
			again: false,
		};
		this.armed.set(routine.routineId, watch);
		const cadence = watchCadenceMs(condition);
		try {
			if (cadence === undefined) this.follow(watch);
		} catch (error) {
			// Without its file-system events the watch still takes its first observation, which sets the baseline or fires
			// for what changed while the session was closed.
			this.armed.delete(routine.routineId);
			const closeFailures = this.closeWatchers(watch);
			if (closeFailures.length > 0)
				this.warn(new AggregateError(closeFailures, "Routine watch could not close partially armed watchers"));
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

	/** Brings the directory watchers of an event-driven condition in line with where its events come from now. */
	private follow(watch: ArmedWatch): void {
		const wanted = new Map(
			followTargets(watch.condition, this.deps.agentDir()).map((target) => [followKey(target), target] as const),
		);
		for (const [key, watcher] of [...watch.watchers])
			if (!wanted.has(key)) {
				watcher.close();
				watch.watchers.delete(key);
			}
		for (const [key, target] of wanted) {
			if (watch.watchers.has(key)) continue;
			const watcher = watchDirectory(
				target.directory,
				{ persistent: false, recursive: target.recursive },
				(_event, filename) => {
					if (target.name === undefined || filename === null || filename.toString() === target.name)
						this.debounce(watch);
				},
			);
			watcher.on("error", (error) => {
				this.disarm(watch);
				if (this.armed.get(watch.routineId) === watch) {
					this.armed.delete(watch.routineId);
					if (this.active) this.skip(watch.routineId, watch.key, watch.condition, "watcher-failed", error);
				}
			});
			watch.watchers.set(key, watcher);
		}
	}

	private debounce(watch: ArmedWatch): void {
		if (!this.active || watch.abort.signal.aborted || this.armed.get(watch.routineId) !== watch) return;
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
	private observe(watch: ArmedWatch): Promise<void> {
		if (watch.running) {
			watch.again = true;
			return Promise.resolve();
		}
		watch.running = true;
		const observation = this.observeRunning(watch);
		const active = this.observations.get(watch) ?? new Set<Promise<void>>();
		active.add(observation);
		this.observations.set(watch, active);
		void observation.then(
			() => this.forgetObservation(watch, active, observation),
			() => this.forgetObservation(watch, active, observation),
		);
		return observation;
	}

	private forgetObservation(watch: ArmedWatch, active: Set<Promise<void>>, observation: Promise<void>): void {
		active.delete(observation);
		if (active.size === 0 && this.observations.get(watch) === active) this.observations.delete(watch);
	}

	private async observeRunning(watch: ArmedWatch): Promise<void> {
		try {
			let sample: WatchSample | undefined;
			try {
				sample = await this.deps.sampler.sample(watch.condition, watch.abort.signal);
			} catch (error) {
				if (watch.abort.signal.aborted || !this.active) return;
				this.refuse(watch, error);
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
				if (cadence === undefined) this.refollow(watch);
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

	/**
	 * The session does not admit this check now (a command its rules refuse): nothing is observed, nothing fires, and the
	 * reason is recorded once in plain words. The watch stays armed and tries again on its next tick, since a grant the
	 * owner gives later lifts the refusal; a success starts the reporting again.
	 */
	private refuse(watch: ArmedWatch, error: unknown): void {
		harnessLog.debug("routines", "a watch observation was refused", {
			routineId: watch.routineId,
			condition: watch.condition.type,
		});
		this.reportOnce(watch.routineId, error);
	}

	/** One plain-words warning per distinct reason: a watch that keeps failing the same way says so once. */
	private reportOnce(routineId: string, error: unknown): void {
		const reason = error instanceof Error ? error.message : String(error);
		if (this.faults.get(routineId) === reason) return;
		this.faults.set(routineId, reason);
		this.warn(error);
	}

	/** A pattern's base or a watched folder may appear after the watch is armed: its watchers move with it. */
	private refollow(watch: ArmedWatch): void {
		try {
			this.follow(watch);
		} catch (error) {
			this.disarm(watch);
			this.armed.delete(watch.routineId);
			this.skip(watch.routineId, watch.key, watch.condition, "watcher-failed", error);
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
			this.reportOnce(watch.routineId, error);
		}
	}

	private disarm(watch: ArmedWatch): void {
		const failures = this.release(watch);
		if (failures.length > 0)
			this.warn(new AggregateError(failures, "Routine watch could not close its directory watchers"));
	}

	/** Abort sampling, clear cadence, and close every owned handle; callers decide how to report captured failures. */
	private release(watch: ArmedWatch): unknown[] {
		const failures: unknown[] = [];
		try {
			watch.abort.abort();
		} catch (error) {
			failures.push(error);
		}
		if (watch.timer !== undefined) {
			try {
				this.deps.timers.clearTimeout(watch.timer);
			} catch (error) {
				failures.push(error);
			}
			watch.timer = undefined;
		}
		failures.push(...this.closeWatchers(watch));
		return failures;
	}

	private closeWatchers(watch: ArmedWatch): unknown[] {
		const failures: unknown[] = [];
		for (const [key, watcher] of watch.watchers) {
			try {
				watcher.close();
				watch.watchers.delete(key);
			} catch (error) {
				failures.push(error);
			}
		}
		if (watch.watchers.size > 0) this.retiredWatchers.add(watch);
		else this.retiredWatchers.delete(watch);
		return failures;
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
