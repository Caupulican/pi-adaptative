/**
 * Bounded waits on worker attempts for the operator's turn: a wait on exact attempts settles as soon as one leaves
 * "running", woken by the durable orchestration store's commits, and a wait on worker agents ends early when the owner
 * steers the session. An abort rejects with its reason; the bound and session disposal settle without observing anything.
 * The coordinator supplies the worker runtime through its host port and settles the open waits when the session disposes.
 */
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import type { BackgroundLaneControllerDeps, RunningAttemptWaitOutcome } from "../background-lane-deps.ts";
import type { OrchestrationEventStore } from "../orchestration/event-store.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { createSteerAwareWait } from "../pending-input-queue-controller.ts";
import { type SteerDecision, type WaitStatusEvent, type WakeSource, waitFor } from "../util/wait.ts";
import type { WorkerAgentControlPort, WorkerAgentControlScope } from "./worker-agent-control.ts";
import { boundWorkerWaitTimeoutMs } from "./worker-agent-control-coordinator.ts";
import type { WorkerDelegationController } from "./worker-delegation-controller.ts";
import { projectWorkerAttemptLaneRecord } from "./worker-lane-projection.ts";
import type { WorkerLifecycle } from "./worker-lifecycle.ts";

/** What the waits read from the coordinator: the worker runtime, the observed terminals and the warning sink. */
export interface WorkerAttemptWaitsHost {
	workerController(): Pick<WorkerDelegationController, "getAgentControl">;
	/** The durable lifecycle once the session has loaded it; undefined before, and never built here. */
	loadedWorkerLifecycle(): WorkerLifecycle | undefined;
	/** The orchestration store once the session has loaded it; undefined before, and never built here. */
	loadedOrchestrationStore(): OrchestrationEventStore | undefined;
	observeWorkerAttemptTerminals(attemptIds: readonly string[]): void;
	observeWorkerTerminalRecords(records: readonly LaneRecord[]): void;
	warn(message: string): void;
}

/** The open waits of one session: each is settled when the session disposes, and waits on exact attempts or worker agents. */
export class WorkerAttemptWaits {
	/** Settles each unresolved running-attempt wait when the session is disposed. */
	private readonly pendingWaits = new Set<() => void>();
	private readonly deps: Pick<
		BackgroundLaneControllerDeps,
		"emit" | "getSessionManager" | "isDelegateToolActive" | "isDisposed"
	>;
	private readonly host: WorkerAttemptWaitsHost;

	constructor(
		deps: Pick<BackgroundLaneControllerDeps, "emit" | "getSessionManager" | "isDelegateToolActive" | "isDisposed">,
		host: WorkerAttemptWaitsHost,
	) {
		this.deps = deps;
		this.host = host;
	}

	/** Settles every open running-attempt wait, as session disposal does. */
	settleAll(): void {
		for (const settle of [...this.pendingWaits]) settle();
	}

	/**
	 * The root's wait signal: an owner steer aborts it, and `finalize` returns that steer's admission decision. A worker
	 * caller has no owner steer (only the session root reads the owner's queue), so its wait passes its signal through.
	 */
	private createWorkerWaitSignal(
		scope: WorkerAgentControlScope | undefined,
		signal: AbortSignal | undefined,
	): { readonly signal: AbortSignal | undefined; readonly finalize: () => Promise<SteerDecision | undefined> } {
		if (scope?.callerAgentId) {
			return { signal, finalize: () => Promise.resolve(undefined) };
		}
		const report = (event: WaitStatusEvent) => this.deps.emit(event);
		return createSteerAwareWait(this.deps.getSessionManager().getSessionId(), signal, report);
	}

	async withWorkerWait<T extends { terminalAttemptIds?: readonly string[]; steered?: SteerDecision }>(
		scope: WorkerAgentControlScope | undefined,
		signal: AbortSignal | undefined,
		run: (control: WorkerAgentControlPort, waitSignal: AbortSignal | undefined) => Promise<T>,
	): Promise<T> {
		if (!this.deps.isDelegateToolActive())
			throw new Error("Worker delegation control is unavailable in this UAC surface.");
		const control = this.host.workerController().getAgentControl();
		const waitSignal = this.createWorkerWaitSignal(scope, signal);
		let result: T;
		try {
			result = await run(control, waitSignal.signal);
			this.host.observeWorkerAttemptTerminals(result.terminalAttemptIds ?? []);
		} catch (error) {
			await waitSignal.finalize();
			throw error;
		}
		// A steer ended the wait: the result says so, so it never reads as a wait that simply returned.
		const steered = await waitSignal.finalize();
		return steered === undefined ? result : { ...result, steered };
	}

	/**
	 * Event-driven wait on exact attempts, of in-process and managed workers alike: it settles as soon
	 * as any captured attempt leaves "running", woken by the durable orchestration store's commit
	 * events. A captured attempt missing from the runtime is an error, never completion. An abort rejects
	 * with the signal's reason; the bound and session disposal settle without observing anything.
	 */
	async waitForRunningAttempts(
		attemptIds: readonly string[],
		options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
	): Promise<RunningAttemptWaitOutcome> {
		const { signal } = options;
		if (signal?.aborted) throw signal.reason;
		const captured = [...new Set(attemptIds)];
		if (captured.length === 0) throw new Error("A running-attempt wait needs at least one attempt.");
		if (this.deps.isDisposed()) return { kind: "disposed" };
		const lifecycle = this.host.loadedWorkerLifecycle();
		const store = this.host.loadedOrchestrationStore();
		if (!lifecycle || !store) {
			throw new Error(`Running attempts ${captured.join(", ")} are unknown: this session has no worker runtime.`);
		}
		const terminal: WakeSource<{ readonly snapshot: TaskRuntimeProjection; readonly changed: string[] }> = {
			id: "attempt.terminal",
			// A commit notifies before the runtime adopts it: read the projection after the commit returns.
			subscribe: (onWake) => {
				let queued = false;
				return store.subscribe(() => {
					if (queued) return;
					queued = true;
					queueMicrotask(() => {
						queued = false;
						onWake();
					});
				});
			},
			check: () => {
				const snapshot = lifecycle.getTaskRuntimeSnapshot();
				const missing = captured.filter((attemptId) => !snapshot.attempts[attemptId]);
				if (missing.length > 0) {
					throw new Error(`Running attempts ${missing.join(", ")} are not in the task runtime.`);
				}
				const changed = captured.filter((attemptId) => snapshot.attempts[attemptId]?.status !== "running");
				return changed.length > 0 ? { kind: "satisfied", value: { snapshot, changed } } : undefined;
			},
		};
		const { end, value } = await waitFor({
			id: "objective.running_attempts",
			wake: [terminal],
			signal,
			steer: {
				mode: "exempt",
				reason: "the objective loop holds no foreground lease while it waits, so owner input runs its own turn",
			},
			bound: { kind: "deadline", ms: boundWorkerWaitTimeoutMs(options.timeoutMs) },
			disposed: {
				isDisposed: () => this.deps.isDisposed(),
				subscribe: (onDispose) => {
					this.pendingWaits.add(onDispose);
					return () => this.pendingWaits.delete(onDispose);
				},
			},
			report: (event) => this.deps.emit(event),
		});
		if (end.kind === "satisfied" && value) {
			this.observeExactAttemptTerminals(value.snapshot, value.changed);
			return { kind: "changed", attemptIds: value.changed };
		}
		if (end.kind === "timed_out") return { kind: "timed_out" };
		if (end.kind === "disposed") return { kind: "disposed" };
		if (end.kind === "aborted") throw signal?.reason;
		throw new Error(`The running-attempt wait ended ${end.kind}.`);
	}

	/** Observe terminals of exactly these attempts, never a newer generation of the same lane. */
	observeExactAttemptTerminals(snapshot: TaskRuntimeProjection, attemptIds: readonly string[]): void {
		try {
			this.host.observeWorkerTerminalRecords(
				attemptIds.flatMap((attemptId) => {
					const record = projectWorkerAttemptLaneRecord(snapshot, attemptId);
					return record ? [record] : [];
				}),
			);
		} catch (error) {
			this.host.warn(
				`Worker terminal observation failed after a running-attempt wait: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}
