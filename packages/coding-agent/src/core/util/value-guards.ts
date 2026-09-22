import { isRecord as isRecordObject } from "@caupulican/pi-ai";

/** Accepts non-null object records while excluding arrays; custom prototypes remain valid (owned by pi-ai). */
export { isRecordObject };

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

/** An array whose every entry is a string. */
export function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
