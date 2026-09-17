/**
 * Detach tool-result data containers at extension admission boundaries. Callable values,
 * accessors and class instances are opaque handles: preserve their behavior and identity,
 * rather than claiming to clone or roll back arbitrary extension side effects.
 */
export function snapshotToolResultData<T>(value: T): T {
	return copyData(value, new WeakMap()) as T;
}

function copyData(value: unknown, seen: WeakMap<object, object>): unknown {
	if (value === null || typeof value !== "object") return value;
	const prototype: object | null = Object.getPrototypeOf(value);
	const array = Array.isArray(value);
	if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return value;
	const previous = seen.get(value);
	if (previous) return previous;
	const copy: object = array ? [] : Object.create(prototype);
	seen.set(value, copy);
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor) continue;
		if ("value" in descriptor) descriptor.value = copyData(descriptor.value, seen);
		Object.defineProperty(copy, key, descriptor);
	}
	return copy;
}
