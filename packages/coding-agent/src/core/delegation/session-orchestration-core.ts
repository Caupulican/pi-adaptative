/**
 * The session's orchestration core: the event store and the durable worker lifecycle over it, built from the session's
 * orchestration home, the session id and the timer source alone. The lane controller opens it on first use. The retention pass reads
 * the store and the runtime through it without the worker composition, and the full composition adopts the same pair, so a
 * session keeps one store and one durable runtime.
 */

import type { OrchestrationHome } from "../../kernel/session/session-bundle-paths.ts";
import { OrchestrationEventStore } from "../orchestration/event-store.ts";
import type { TimerSource } from "../util/timer-port.ts";
import { WorkerLifecycle } from "./worker-lifecycle.ts";

export interface SessionOrchestrationCore {
	readonly store: OrchestrationEventStore;
	readonly lifecycle: WorkerLifecycle;
}

export function openSessionOrchestrationCore(options: {
	readonly orchestrationHome: OrchestrationHome;
	readonly sessionId: string;
	readonly timers: TimerSource;
}): SessionOrchestrationCore {
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
		now: () => orchestrationClock.now(),
	});
	return { store, lifecycle };
}
