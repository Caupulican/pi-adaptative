import {
	type CiCurrentObservation,
	ciSubjectKey,
	MAX_HOST_EVENT_SUBJECTS,
} from "../../core/events/host-event-contract.ts";
import type { CiProvider } from "./ci-provider.ts";

const MAX_ACTIVE_RUN_WATCHERS = 4;
/** A watch that ended while its run still looks pending is re-armed after this delay, never in a tight loop. */
export const CI_RUN_WATCH_RETRY_MS = 30_000;

interface WatchedRun {
	readonly observation: CiCurrentObservation;
	started: boolean;
	abort?: AbortController;
	retry?: ReturnType<typeof setTimeout>;
}

/** Observed pending runs are the restart handoff; process completion requests a fresh authoritative seal. */
export class CiRunMonitor {
	private readonly provider: CiProvider;
	private readonly signal: AbortSignal;
	private readonly onTerminal: () => void;
	private readonly onFailure: (error: unknown) => void;
	private readonly pending = new Map<string, WatchedRun>();
	private readonly running = new Set<Promise<void>>();
	private stopped = false;

	constructor(provider: CiProvider, signal: AbortSignal, onTerminal: () => void, onFailure: (error: unknown) => void) {
		this.provider = provider;
		this.signal = signal;
		this.onTerminal = onTerminal;
		this.onFailure = onFailure;
	}

	/** Watches exactly the pending observations; runs of subjects in `unresolved` keep their watch. */
	reconcile(observations: readonly CiCurrentObservation[], unresolved: ReadonlySet<string> = new Set()): void {
		if (this.stopped || this.signal.aborted) return;
		if (observations.length > MAX_HOST_EVENT_SUBJECTS) throw new Error("CI run monitor subject capacity reached.");
		const desired = new Map(
			observations
				.filter((observation) => observation.status !== "completed")
				.map((observation) => [
					`${ciSubjectKey(observation.subject)}:${observation.runId}:${observation.runAttempt}`,
					observation,
				]),
		);
		for (const [key, watched] of this.pending) {
			if (desired.has(key) || unresolved.has(ciSubjectKey(watched.observation.subject))) continue;
			this.discard(key, watched, "CI run is no longer pending in the watched scope.");
		}
		for (const [key, observation] of desired) {
			if (!this.pending.has(key)) this.pending.set(key, { observation, started: false });
		}
		this.pump();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		for (const [key, watched] of this.pending) this.discard(key, watched, "CI run monitor stopped.");
		await Promise.allSettled([...this.running]);
	}

	private discard(key: string, watched: WatchedRun, reason: string): void {
		watched.abort?.abort(new Error(reason));
		if (watched.retry) clearTimeout(watched.retry);
		watched.retry = undefined;
		this.pending.delete(key);
	}

	private pump(): void {
		if (this.stopped || this.signal.aborted) return;
		for (const [key, watched] of this.pending) {
			if (this.running.size >= MAX_ACTIVE_RUN_WATCHERS) break;
			if (watched.started || watched.retry) continue;
			watched.started = true;
			watched.abort = new AbortController();
			const signal = AbortSignal.any([this.signal, watched.abort.signal]);
			let completed = false;
			const work = Promise.resolve()
				.then(() => {
					signal.throwIfAborted();
					return this.provider.waitForRun(watched.observation.runId, signal);
				})
				.then(
					() => {
						completed = true;
					},
					(error: unknown) => {
						if (!signal.aborted) this.onFailure(error);
					},
				)
				.catch((error: unknown) => {
					try {
						this.onFailure(error);
					} catch {
						/* Observer failure cannot orphan a process or erase retained source custody. */
					}
				})
				.finally(() => {
					this.running.delete(work);
					// A watch that ended keeps its entry, so the run is re-armed (after a bounded delay)
					// unless the next authoritative observation shows it completed. Provider lag after a
					// normal exit cannot spin a watch/reconcile loop.
					if (this.pending.get(key) === watched && !this.stopped && !this.signal.aborted) {
						watched.started = false;
						watched.abort = undefined;
						watched.retry = setTimeout(() => {
							watched.retry = undefined;
							this.pump();
						}, CI_RUN_WATCH_RETRY_MS);
						watched.retry.unref();
					}
					if (completed && !signal.aborted) {
						try {
							this.onTerminal();
						} catch (error) {
							this.onFailure(error);
						}
					}
					this.pump();
				});
			this.running.add(work);
		}
	}
}
