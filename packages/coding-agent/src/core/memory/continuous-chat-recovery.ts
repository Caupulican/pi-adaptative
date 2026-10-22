import { setImmediate as yieldToEventLoop } from "node:timers/promises";

/** Let startup cancellation arrive even when a scan's cached reads resolve in microtasks. */
export async function checkpointContinuousChatRecovery(signal?: AbortSignal, visited = 0): Promise<void> {
	signal?.throwIfAborted();
	if (signal !== undefined && visited % 256 === 0) await yieldToEventLoop(undefined, { signal });
}
