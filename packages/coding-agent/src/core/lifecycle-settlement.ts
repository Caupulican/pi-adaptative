/** Attempt every lifecycle terminal, together by default or in settlement order, then preserve their failures. */
export async function settleIndependentLifecycle(
	actions: readonly (() => unknown | PromiseLike<unknown>)[],
	aggregateMessage: string,
	options?: { readonly sequential?: boolean },
): Promise<void> {
	let previous: Promise<unknown> = Promise.resolve();
	const pending = actions.map((action) => {
		const result = (options?.sequential ? previous : Promise.resolve()).then(action);
		if (options?.sequential)
			previous = result.then(
				() => undefined,
				() => undefined,
			);
		return result;
	});
	const results = await Promise.allSettled(pending);
	const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, aggregateMessage);
}
