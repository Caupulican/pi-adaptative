/**
 * Freeze an object graph in place so one immutable value can be shared by every reader instead of
 * each reader receiving its own deep clone. Already-frozen subtrees are skipped, so freezing the
 * result of a structurally shared update costs only the objects that update created. Mutators
 * never see frozen data; they work on a fresh copy.
 */
export function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
	return value;
}
