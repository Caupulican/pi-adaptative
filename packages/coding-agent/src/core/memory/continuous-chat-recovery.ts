import { setImmediate as yieldToEventLoop } from "node:timers/promises";

/**
 * Let startup cancellation arrive, and let the event loop run, during a store scan whose cached reads resolve in
 * microtasks: every 256th unit of work yields, with or without a signal (a signal makes the yield abortable).
 */
export async function checkpointContinuousChatRecovery(signal?: AbortSignal, visited = 0): Promise<void> {
	signal?.throwIfAborted();
	if (visited % 256 === 0) await yieldToEventLoop(undefined, signal === undefined ? undefined : { signal });
}
