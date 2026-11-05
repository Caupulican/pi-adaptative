import {
	type CiCurrentObservation,
	ciSubjectKey,
	MAX_HOST_EVENT_SUBJECTS,
} from "../../core/events/host-event-contract.ts";
import type { CiProvider } from "./ci-provider.ts";

const MAX_ACTIVE_RUN_WATCHERS = 4;

interface WatchedRun {
	readonly observation: CiCurrentObservation;
	started: boolean;
	abort?: AbortController;
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

	reconcile(observations: readonly CiCurrentObservation[]): void {
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
			if (desired.has(key)) continue;
			watched.abort?.abort(new Error("CI run is no longer pending in the watched scope."));
			this.pending.delete(key);
		}
		for (const [key, observation] of desired) {
			if (!this.pending.has(key)) this.pending.set(key, { observation, started: false });
		}
		this.pump();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		for (const watched of this.pending.values()) watched.abort?.abort(new Error("CI run monitor stopped."));
		this.pending.clear();
		await Promise.allSettled([...this.running]);
	}

	private pump(): void {
		if (this.stopped || this.signal.aborted) return;
		for (const watched of this.pending.values()) {
			if (this.running.size >= MAX_ACTIVE_RUN_WATCHERS) break;
			if (watched.started) continue;
			watched.started = true;
			watched.abort = new AbortController();
			const signal = AbortSignal.any([this.signal, watched.abort.signal]);
			const work = Promise.resolve()
				.then(() => {
					signal.throwIfAborted();
					return this.provider.waitForRun(watched.observation.runId, signal);
				})
				.then(
					() => {
						if (!signal.aborted) this.onTerminal();
					},
					(error: unknown) => {
						if (!signal.aborted) {
							this.onFailure(error);
							this.onTerminal();
						}
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
					this.pump();
				});
			this.running.add(work);
		}
	}
}
