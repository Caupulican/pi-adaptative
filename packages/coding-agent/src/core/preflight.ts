/**
 * Cancel a caller's read-only preflight wait without abandoning rejection handling or
 * canceling shared provisioning. Never use this to detach an operation with user-data effects.
 */
export function awaitPreflight<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	signal?.throwIfAborted();
	const pending = operation();
	if (!signal) return pending;
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		pending.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
		if (signal.aborted) onAbort();
	});
}
