/**
 * Write gate for one cacheable request prefix. The first request for a prefix holds it until its response starts; an
 * identical prefix that arrives meanwhile waits, so a burst of parallel calls pays for one cache write instead of one
 * per call. The holder releases when the HTTP response starts or errors. Its abort releases it as well, so a waiter never
 * outlives the request holding the prefix; an abort wrote nothing, so the first waiter takes the prefix over. Release is
 * idempotent.
 */

export interface PromptCacheWriteReservation {
	release(): void;
}

/** How a waiter is woken: the holder released after its write started, or it aborted and handed the prefix on. */
type PrefixWake = "released" | "handoff";

/** Waiters of each prefix that is held, in arrival order. A key is present exactly while its prefix is held. */
const heldPrefixes = new Map<string, Array<(wake: PrefixWake) => void>>();

/** A waiter never holds the prefix: it proceeds once the holder releases, and the cache then serves it. */
const notHeld: PromptCacheWriteReservation = { release: () => undefined };

export async function acquirePromptCacheWrite(key: string, signal?: AbortSignal): Promise<PromptCacheWriteReservation> {
	signal?.throwIfAborted();
	const waiters = heldPrefixes.get(key);
	if (waiters === undefined) {
		heldPrefixes.set(key, []);
		return holdPrefix(key, signal);
	}
	const wake = await new Promise<PrefixWake>((resolve, reject) => {
		const onWake = (outcome: PrefixWake): void => {
			signal?.removeEventListener("abort", abort);
			resolve(outcome);
		};
		const abort = (): void => {
			signal?.removeEventListener("abort", abort);
			const index = waiters.indexOf(onWake);
			if (index !== -1) waiters.splice(index, 1);
			reject(signal?.reason);
		};
		waiters.push(onWake);
		signal?.addEventListener("abort", abort, { once: true });
		// Close the race between the initial throwIfAborted() and listener registration.
		if (signal?.aborted) abort();
	});
	return wake === "released" ? notHeld : holdPrefix(key, signal);
}

/** The hold lasts until release or until `signal` aborts; whichever comes first settles it once. */
function holdPrefix(key: string, signal: AbortSignal | undefined): PromptCacheWriteReservation {
	let settled = false;
	const settle = (written: boolean): void => {
		if (settled) return;
		settled = true;
		signal?.removeEventListener("abort", onAbort);
		const waiters = heldPrefixes.get(key) ?? [];
		// Nothing was written on abort: the first waiter takes the prefix and the rest keep waiting behind it.
		if (!written && waiters.length > 0) {
			waiters.shift()?.("handoff");
			return;
		}
		heldPrefixes.delete(key);
		for (const wake of waiters) wake("released");
	};
	const onAbort = (): void => settle(false);
	signal?.addEventListener("abort", onAbort, { once: true });
	// A handed-off waiter whose signal already fired passes the prefix on at once.
	if (signal?.aborted) onAbort();
	return { release: () => settle(true) };
}
