/** Run independent lifecycle terminals together, wait for every one, then preserve their failures. */
export async function settleIndependentLifecycle(
	actions: readonly (() => unknown | PromiseLike<unknown>)[],
	aggregateMessage: string,
): Promise<void> {
	const results = await Promise.allSettled(actions.map((action) => Promise.resolve().then(action)));
	const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, aggregateMessage);
}
