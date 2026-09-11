/**
 * Park a waiter in `queue` until whoever drains the queue admits it, unless `signal` aborts first.
 * An abort removes the waiter from the queue, rejects with the signal's reason and runs
 * `onAbandoned` (the abandoned position may have been the one blocking everything behind it).
 * `create` builds the queue entry from the promise's settlers; the `detach` it receives removes the
 * abort listener, so an entry admitted normally leaves nothing armed behind it.
 */
export function waitInQueue<TWaiter, TValue>(
	queue: TWaiter[],
	signal: AbortSignal | undefined,
	create: (admit: (value: TValue) => void, reject: (reason: unknown) => void, detach: () => void) => TWaiter,
	onAbandoned?: () => void,
): Promise<TValue> {
	return new Promise<TValue>((admit, reject) => {
		let waiter!: TWaiter;
		const onAbort = (): void => {
			const position = queue.indexOf(waiter);
			if (position !== -1) queue.splice(position, 1);
			reject(signal?.reason);
			onAbandoned?.();
		};
		const detach = (): void => signal?.removeEventListener("abort", onAbort);
		waiter = create(admit, reject, detach);
		queue.push(waiter);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
