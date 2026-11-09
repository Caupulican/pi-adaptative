/** One settled wait over logical worker agents: the bounded wait duration, the completion and timeout rules, and the caller write-reservation restore a wait may need before it returns. */

import { agentTurnBasis } from "../orchestration/agent-turn-basis.ts";
import type { AgentBindingContract } from "../orchestration/contracts.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { terminalAttemptStatus } from "../orchestration/task-runtime-state.ts";
import { SYSTEM_TIMER_PORT, type TimerPort } from "../util/timer-port.ts";
import type {
	WorkerAgentActivity,
	WorkerAgentControlScope,
	WorkerAgentWaitMode,
	WorkerAgentWaitResult,
} from "./worker-agent-control.ts";
import type { WorkerDispatchScheduler } from "./worker-dispatch-scheduler.ts";
import type { WorkerLifecycle } from "./worker-lifecycle.ts";

/**
 * Independent bound on how long a blocked restore may wait for a reservation-availability event,
 * deliberately NOT derived from the caller's own (possibly very short, e.g. test-only 1ms) wait
 * timeoutMs: the original wait already finished (satisfied or timed out) by the time restoration
 * starts. This is a watchdog, not a poll — retries are driven by subscribeReservationAvailability.
 * Mirrors the documented 300s absolute ceiling used elsewhere in this method.
 */
const WORKER_WAIT_RESTORE_MAX_MS = 300_000;

export const WORKER_WAIT_DEFAULT_MS = 30_000;

/** The bounded duration of one worker wait: whole milliseconds in [1, 300s]; non-finite input waits the default. */
/** The bounded duration of one worker wait: whole milliseconds in [1, 300s]; non-finite input waits the default. */
export function boundWorkerWaitTimeoutMs(timeoutMs: number): number {
	return Number.isFinite(timeoutMs) ? Math.max(1, Math.min(Math.floor(timeoutMs), 300_000)) : WORKER_WAIT_DEFAULT_MS;
}

export interface WorkerAgentWaitOptions {
	getLifecycle(): WorkerLifecycle;
	scheduler: Partial<Pick<WorkerDispatchScheduler, "getWaitState">>;
	isSpecialistSettled?(agentId: string): boolean;
	yieldCallerForWait?(callerAgentId: string): (() => boolean | undefined) | undefined;
	waitBlockedByCaller?(callerAgentId: string, targetAgentIds: readonly string[]): readonly string[];
	subscribeReservationAvailability?(listener: () => void): () => void;
	timers?: TimerPort;
}

interface WorkerAgentWaitPort {
	readonly options: WorkerAgentWaitOptions;
	readonly subscribeStateChanges: (listener: () => void) => () => void;
	readonly projectAgentActivity: (
		agent: AgentBindingContract,
		attempt: AttemptRuntimeState | undefined,
	) => WorkerAgentActivity;
	readonly latestAttemptsByAgent: (snapshot: TaskRuntimeProjection) => ReadonlyMap<string, AttemptRuntimeState>;
}

/** Settles one wait over durable agent projections; the coordinator owns the state it reads and the admission around it. */
export class WorkerAgentWaiter {
	private readonly options: WorkerAgentWaitOptions;
	private readonly subscribeStateChanges: (listener: () => void) => () => void;
	private readonly projectAgentActivity: (
		agent: AgentBindingContract,
		attempt: AttemptRuntimeState | undefined,
	) => WorkerAgentActivity;
	private readonly latestAttemptsByAgent: (
		snapshot: TaskRuntimeProjection,
	) => ReadonlyMap<string, AttemptRuntimeState>;

	constructor(port: WorkerAgentWaitPort) {
		this.options = port.options;
		this.subscribeStateChanges = port.subscribeStateChanges;
		this.projectAgentActivity = port.projectAgentActivity;
		this.latestAttemptsByAgent = port.latestAttemptsByAgent;
	}

	waitForAgents(
		canonicalAgentIds: string[],
		mode: WorkerAgentWaitMode,
		timeoutMs: number,
		scope: WorkerAgentControlScope,
		signal?: AbortSignal,
	): Promise<WorkerAgentWaitResult> {
		const baselineSnapshot = this.options.getLifecycle().getTaskRuntimeSnapshot();
		let callerAgentId: string | undefined;
		if (scope.callerAgentId) {
			callerAgentId = scope.callerAgentId.trim();
			if (!callerAgentId || !baselineSnapshot.agents[callerAgentId]) {
				throw new Error(`Unknown logical worker agent '${callerAgentId}'.`);
			}
		}
		const boundedTimeoutMs = boundWorkerWaitTimeoutMs(timeoutMs);
		const statusesFromSnapshot = (snapshot: TaskRuntimeProjection) => {
			const latestAttempts = this.latestAttemptsByAgent(snapshot);
			return canonicalAgentIds.map((agentId) => {
				const agent = snapshot.agents[agentId];
				return {
					agentId,
					status: agent
						? this.projectAgentActivity(agent, latestAttempts.get(agent.agentId))
						: ("unknown" as const),
				};
			});
		};
		const currentSnapshot = () => this.options.getLifecycle().getTaskRuntimeSnapshot();
		const baselineStatuses = statusesFromSnapshot(baselineSnapshot);
		const baselineByAgentId = new Map(baselineStatuses.map(({ agentId, status }) => [agentId, status]));
		const updatedAgentIds = new Set<string>();
		const recordUpdates = (statuses: typeof baselineStatuses) => {
			for (const { agentId, status } of statuses) {
				if (baselineByAgentId.get(agentId) !== status) updatedAgentIds.add(agentId);
			}
		};
		const waitSatisfied = (statuses: typeof baselineStatuses) => {
			// Durable idleness can precede tool-surface disposal. The same resource owner that
			// gates reuse must release the specialist before an idle wait can report readiness.
			const ready = ({ agentId, status }: (typeof statuses)[number]) =>
				status !== "active" && (status !== "idle" || this.options.isSpecialistSettled?.(agentId) !== false);
			return mode === "any" ? statuses.some(ready) : statuses.every(ready);
		};
		const result = (statuses: typeof baselineStatuses, timedOut: boolean, snapshot: TaskRuntimeProjection) => {
			const statusByAgentId = new Map(statuses.map(({ agentId, status }) => [agentId, status]));
			// An idle agent's latest turn is reported even after retention released it: the basis stands in for the attempt.
			const terminalTurns = canonicalAgentIds.flatMap((agentId) => {
				const turn = agentTurnBasis(snapshot, agentId);
				return statusByAgentId.get(agentId) === "idle" && turn && terminalAttemptStatus(turn.status) ? [turn] : [];
			});
			return {
				statuses,
				updatedAgentIds: canonicalAgentIds.filter((agentId) => updatedAgentIds.has(agentId)),
				timedOut,
				terminalLaneIds: terminalTurns.map((turn) => turn.taskId),
				terminalAttemptIds: terminalTurns.map((turn) => turn.attemptId),
			};
		};
		if (waitSatisfied(baselineStatuses)) return Promise.resolve(result(baselineStatuses, false, baselineSnapshot));
		if (callerAgentId) {
			const activeAgentIds = new Set(
				baselineStatuses.filter(({ status }) => status === "active").map(({ agentId }) => agentId),
			);
			if (activeAgentIds.has(callerAgentId)) {
				throw new Error(
					`Worker wait would deadlock: logical worker '${callerAgentId}' cannot wait for itself. Finish the caller task instead.`,
				);
			}
		}
		if (signal?.aborted) return Promise.resolve(result(baselineStatuses, false, baselineSnapshot));
		// A root wait on a worker the scheduler holds for the foreground turn can never be satisfied inside
		// this turn: the hold lifts only when the turn ends, and a model waiting through it burns its own
		// turn. Return at once and say so. Workers waiting on a sibling keep the ordinary wait.
		if (callerAgentId === undefined && scope.returnWhenForegroundHeld === true) {
			const latestAttempts = this.latestAttemptsByAgent(baselineSnapshot);
			const activeIds = baselineStatuses.filter(({ status }) => status === "active").map(({ agentId }) => agentId);
			const heldIds = activeIds.filter((agentId) => {
				const attempt = latestAttempts.get(agentId);
				return (
					attempt !== undefined && this.options.scheduler.getWaitState?.(attempt.taskId)?.reason === "foreground"
				);
			});
			if (heldIds.length > 0 && (mode === "all" || heldIds.length === activeIds.length)) {
				return Promise.resolve({
					...result(baselineStatuses, false, baselineSnapshot),
					foregroundHeldAgentIds: heldIds,
				});
			}
		}
		return new Promise((resolve, reject) => {
			let settled = false;
			let completionTimedOut: boolean | undefined;
			let abortedBySignal = false;
			let failure: unknown;
			let hasFailure = false;
			let yieldInitialized = callerAgentId === undefined;
			let restoreYield: (() => boolean | undefined) | undefined;
			let unsubscribeState = (): void => undefined;
			const timers = this.options.timers ?? SYSTEM_TIMER_PORT;
			let timeout: unknown;
			// A blocked restore (another lane still holds the caller's write reservation) is a
			// live-lock, not a terminal failure or success. subscribeStateChanges is not that
			// wakeup — reservation release is. subscribeReservationAvailability is the event;
			// restoreDeadlineTimer is only the watchdog if that event never arrives.
			let unsubscribeReservation = (): void => undefined;
			let restoreDeadlineTimer: unknown;
			let restoreRetryDeadline: number | undefined;
			const onSignalAbort = () => {
				if (settled) return;
				abortedBySignal = true;
				if (completionTimedOut === undefined) completionTimedOut = false;
				settle();
			};
			const cleanup = () => {
				unsubscribeState();
				unsubscribeReservation();
				signal?.removeEventListener("abort", onSignalAbort);
				if (timeout !== undefined) timers.clearTimeout(timeout);
				if (restoreDeadlineTimer !== undefined) timers.clearTimeout(restoreDeadlineTimer);
			};
			const restoreCaller = (): boolean => {
				if (!restoreYield) return true;
				const restored = restoreYield();
				if (restored === false) return false;
				restoreYield = undefined;
				return true;
			};
			const settle = () => {
				if (settled || !yieldInitialized) return;
				const snapshot = currentSnapshot();
				const statuses = statusesFromSnapshot(snapshot);
				recordUpdates(statuses);
				if (!hasFailure && completionTimedOut === undefined && !abortedBySignal) {
					if (!waitSatisfied(statuses)) return;
					completionTimedOut = false;
					if (timeout !== undefined) {
						timers.clearTimeout(timeout);
						timeout = undefined;
					}
				}
				try {
					if (!restoreCaller()) {
						restoreRetryDeadline ??= timers.now() + WORKER_WAIT_RESTORE_MAX_MS;
						const remainingMs = restoreRetryDeadline - timers.now();
						if (remainingMs <= 0) {
							failure = new Error(
								"Worker wait completed but could not restore the caller's write reservation within the retry bound; another lane continues to hold it.",
							);
							hasFailure = true;
						} else {
							restoreDeadlineTimer ??= timers.setTimeout(settle, remainingMs);
							return;
						}
					}
				} catch (error) {
					failure = error;
					hasFailure = true;
				}
				settled = true;
				cleanup();
				if (hasFailure) reject(failure);
				else resolve(result(statuses, completionTimedOut ?? false, snapshot));
			};
			unsubscribeState = this.subscribeStateChanges(settle);
			if (this.options.subscribeReservationAvailability) {
				unsubscribeReservation = this.options.subscribeReservationAvailability(settle);
			}
			if (signal?.aborted) {
				abortedBySignal = true;
				completionTimedOut = false;
			} else {
				signal?.addEventListener("abort", onSignalAbort, { once: true });
			}
			timeout = timers.setTimeout(() => {
				if (settled) return;
				timeout = undefined;
				if (completionTimedOut === undefined) completionTimedOut = true;
				settle();
			}, boundedTimeoutMs);
			try {
				let yielded = false;
				if (callerAgentId && this.options.yieldCallerForWait) {
					restoreYield = this.options.yieldCallerForWait(callerAgentId);
					yielded = restoreYield !== undefined;
				}
				if (!yielded && callerAgentId) {
					const statuses = statusesFromSnapshot(currentSnapshot());
					const activeAgentIds = new Set(
						statuses.filter(({ status }) => status === "active").map(({ agentId }) => agentId),
					);
					const blockedAgentIdSet = new Set(
						this.options.waitBlockedByCaller?.(callerAgentId, canonicalAgentIds) ?? [],
					);
					const blockedAgentIds = canonicalAgentIds.filter(
						(agentId) => activeAgentIds.has(agentId) && blockedAgentIdSet.has(agentId),
					);
					if (blockedAgentIds.length > 0) {
						hasFailure = true;
						failure = new Error(
							`Worker wait would deadlock: ${blockedAgentIds.join(", ")} ${blockedAgentIds.length === 1 ? "is" : "are"} blocked by the caller's write reservation.`,
						);
					}
				}
				yieldInitialized = true;
			} catch (error) {
				yieldInitialized = true;
				hasFailure = true;
				failure = error;
			}
			settle();
		});
	}
}
