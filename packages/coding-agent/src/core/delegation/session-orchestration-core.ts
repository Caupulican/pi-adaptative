/**
 * The session's orchestration core: the event store and the durable worker lifecycle over it, built from the session's
 * orchestration home, the session id and the timer source alone. The lane controller opens it on first use. The retention pass reads
 * the store and the runtime through it without the worker composition, and the full composition adopts the same pair, so a
 * session keeps one store and one durable runtime.
 */

import type { SessionManager } from "../../kernel/node.ts";
import { type OrchestrationHome, orchestrationEventStoreDir } from "../agent-paths.ts";
import type { GoalState } from "../goals/goal-state.ts";
import { goalSourcePosition } from "../goals/session-goal-correction.ts";
import { assertGoalIdentityUnambiguous } from "../goals/session-goal-state.ts";
import { OrchestrationEventStore } from "../orchestration/event-store.ts";
import { goalObjectiveId } from "../orchestration/goal-objective-id.ts";
import type { TimerSource } from "../util/timer-port.ts";
import { WorkerLifecycle } from "./worker-lifecycle.ts";
import { accessExistingWorkerStore } from "./worker-receipt-delivery.ts";

export interface SessionOrchestrationCore {
	readonly store: OrchestrationEventStore;
	readonly lifecycle: WorkerLifecycle;
}

export interface SessionOrchestrationCoreOptions {
	readonly orchestrationHome: OrchestrationHome;
	readonly sessionId: string;
	readonly timers: TimerSource;
	readonly assertGoalIdentity?: (goal: GoalState | string) => void;
	readonly identitySource?: SessionManager;
}

export function openSessionOrchestrationCore(options: SessionOrchestrationCoreOptions): SessionOrchestrationCore {
	// The retry ladder persists its deadline on the orchestration clock; the runtime rechecks it on the same clock, and the
	// store stamps every event on it too, because the reducer compares a start's event time with that deadline.
	const orchestrationClock = options.timers.port("orchestration");
	const store = new OrchestrationEventStore({
		orchestrationHome: options.orchestrationHome,
		sessionId: options.sessionId,
		now: () => new Date(orchestrationClock.now()).toISOString(),
		sleepSync: (delayMs) => options.timers.sleepSync(delayMs),
	});
	const lifecycle = new WorkerLifecycle({
		orchestrationHome: options.orchestrationHome,
		sessionId: options.sessionId,
		store,
		goalSourcePosition: options.identitySource
			? (goal) => goalSourcePosition(options.identitySource!, goal)
			: undefined,
		assertGoalIdentity:
			options.assertGoalIdentity ??
			(options.identitySource ? (goal) => assertGoalIdentityUnambiguous(options.identitySource!, goal) : undefined),
		now: () => orchestrationClock.now(),
	});
	return { store, lifecycle };
}

/** Cold durable access shares the same store later adopted by the complete worker composition. */
export class SessionOrchestrationCoreCache {
	private core?: SessionOrchestrationCore;
	private readonly options: () => SessionOrchestrationCoreOptions;
	constructor(options: () => SessionOrchestrationCoreOptions) {
		this.options = options;
	}
	get(): SessionOrchestrationCore {
		this.core ??= openSessionOrchestrationCore(this.options());
		return this.core;
	}
	peek(): SessionOrchestrationCore | undefined {
		return this.core;
	}
	existing(): SessionOrchestrationCore | undefined {
		if (this.core) return this.core;
		const options = this.options();
		if (
			!accessExistingWorkerStore(
				() => orchestrationEventStoreDir(options.orchestrationHome, options.sessionId),
				undefined,
				(message) => {
					throw new Error(message);
				},
			)
		)
			return undefined;
		return this.get();
	}
	hasGoalObjective(goalId: string): boolean {
		return Boolean(this.existing()?.lifecycle.getTaskRuntimeSnapshot().objectives[goalObjectiveId(goalId)]);
	}
}
