/**
 * Sleep helper that respects abort signal. Always detaches its abort listener when
 * settling, so repeated sleeps (e.g. retry backoff) on a long-lived signal do not
 * accumulate listeners for the signal's lifetime.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Aborted"));
			return;
		}

		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error("Aborted"));
		};

		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
