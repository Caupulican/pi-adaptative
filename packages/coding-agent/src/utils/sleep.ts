import { sleepWithAbortError } from "@caupulican/pi-ai/abort-signals";

/**
 * Sleep helper that respects abort signal. Always detaches its abort listener when
 * settling, so repeated sleeps (e.g. retry backoff) on a long-lived signal do not
 * accumulate listeners for the signal's lifetime.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return sleepWithAbortError(ms, signal, () => new Error("Aborted"));
}
