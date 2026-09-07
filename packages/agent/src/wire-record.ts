/** Exact data-only wire shape. Accept null prototypes, but never inherited fields or accessors. */
export function readWireRecord(value: unknown, allowed: ReadonlySet<string>): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object") return undefined;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== null && prototype !== Object.prototype) return undefined;
	const keys = Reflect.ownKeys(value);
	if (keys.length > allowed.size || keys.some((key) => typeof key !== "string" || !allowed.has(key))) return undefined;
	const fields: Record<string, unknown> = {};
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !("value" in descriptor)) return undefined;
		fields[key as string] = descriptor.value;
	}
	return fields;
}
