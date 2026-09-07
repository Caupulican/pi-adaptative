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

/** Refuse async facts in a sync caller, retaining settlement ownership of read-only probes. */
export function requireSynchronousPreflight<T>(value: T | Promise<T>): T {
	if (value !== null && typeof value === "object" && "then" in value && typeof value.then === "function") {
		// The probe has already started. Observe even a late rejection; its outcome cannot authorize this call.
		void Promise.resolve(value).catch(() => {});
		throw new Error("Cannot synchronously resolve path with an asynchronous authority");
	}
	return value as T;
}
