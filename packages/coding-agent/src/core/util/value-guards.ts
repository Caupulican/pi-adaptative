/** Accepts non-null object records while excluding arrays; custom prototypes remain valid. */
export function isRecordObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accepts only ordinary JSON-style records, including null-prototype dictionaries. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!isRecordObject(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** Fail closed when an untrusted record contains a field outside its typed contract. */
export function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
	const allowedSet = new Set(allowed);
	return Object.keys(record).every((key) => allowedSet.has(key));
}
