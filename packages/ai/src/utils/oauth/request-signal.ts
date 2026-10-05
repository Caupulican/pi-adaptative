/** One deadline covers OAuth response headers and body consumption; caller cancellation wins upstream. */
export function createOAuthRequestSignal(signal?: AbortSignal): AbortSignal {
	signal?.throwIfAborted();
	const timeout = AbortSignal.timeout(30_000);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
