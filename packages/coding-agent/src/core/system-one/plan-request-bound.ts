/**
 * The bound on one plan judgment's System One request. A request that does not answer within its bound is unjudged:
 * the caller's exits read it as no answer, so they fall to the code facts. The answer races the bound itself, so an
 * engine that ignores the abort signal still cannot hold a plan. The caller's own abort propagates: a caller signal
 * that aborted throws, whatever the request did.
 */

import { SYSTEM_TIMER_PORT, type TimerPort } from "../../kernel/timer-port.ts";

/** The most one request may take. Every plan judgment is asked in flight together, so this bounds each wait. */
export const PLAN_REQUEST_TIMEOUT_MS = 60_000;

export interface PlanRequestBoundOptions {
	/** The caller's signal: its abort ends the request and propagates as a throw. */
	readonly caller?: AbortSignal;
	/** A wider bound (a whole review) that ends the request as expired. */
	readonly deadline?: AbortSignal;
	readonly timeoutMs?: number;
	readonly timers?: TimerPort;
}

/**
 * Runs `ask` under its bound. Resolves to its answer, or to `undefined` when the bound expired first (the request is
 * then unjudged). Rejects only with the caller's abort or with a genuine failure of `ask`.
 */
export async function withinPlanRequestBound<T>(
	ask: (signal: AbortSignal) => Promise<T>,
	options: PlanRequestBoundOptions = {},
): Promise<T | undefined> {
	const { caller, deadline, timeoutMs = PLAN_REQUEST_TIMEOUT_MS, timers = SYSTEM_TIMER_PORT } = options;
	caller?.throwIfAborted();
	const request = new AbortController();
	// Registered before anything can abort the request, so an abort that is already in effect still settles the race.
	const expired = new Promise<undefined>((resolve) => {
		request.signal.addEventListener("abort", () => resolve(undefined), { once: true });
	});
	const abort = () => request.abort();
	const handle = timers.setTimeout(abort, timeoutMs);
	caller?.addEventListener("abort", abort, { once: true });
	deadline?.addEventListener("abort", abort, { once: true });
	if (deadline?.aborted) abort();
	try {
		const answer = await Promise.race([ask(request.signal), expired]);
		caller?.throwIfAborted();
		return answer;
	} catch (error) {
		caller?.throwIfAborted();
		if (request.signal.aborted) return undefined;
		throw error;
	} finally {
		timers.clearTimeout(handle);
		caller?.removeEventListener("abort", abort);
		deadline?.removeEventListener("abort", abort);
	}
}
