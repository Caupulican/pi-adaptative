/**
 * Strict canonical JSON: the one encoder behind identity, signature and dedupe keys built from JSON data. Object keys are
 * sorted at every depth and array order is kept, so equal data always encodes to equal text. A value that is not JSON
 * data (an undefined member, a Map, Set, Date or class instance, a sparse array, a symbol key, a non-finite number, a
 * function, a bigint, a cycle) throws a TypeError naming its path, because a lenient encoder would give two different
 * values one identity. A caller whose values carry undefined members strips them first with withoutUndefinedMembers.
 */
import { isPlainRecord } from "./value-guards.ts";

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function childPath(path: string, key: string): string {
	return IDENTIFIER.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function refuse(path: string, reason: string): never {
	throw new TypeError(`strict canonical JSON cannot encode ${path}: ${reason}`);
}

function encodeAt(value: unknown, path: string, ancestors: Set<object>): string {
	switch (typeof value) {
		case "string":
		case "boolean":
			return JSON.stringify(value);
		case "number":
			if (!Number.isFinite(value)) refuse(path, `${value} is not JSON data`);
			return JSON.stringify(value);
		case "undefined":
			return refuse(path, "undefined is not JSON data; strip undefined members before encoding");
		case "object":
			break;
		default:
			return refuse(path, `a ${typeof value} is not JSON data`);
	}
	if (value === null) return "null";
	const object = value as object;
	if (ancestors.has(object)) refuse(path, "the value contains itself");
	ancestors.add(object);
	try {
		return Array.isArray(object) ? encodeArray(object, path, ancestors) : encodeObject(object, path, ancestors);
	} finally {
		ancestors.delete(object);
	}
}

function encodeArray(array: readonly unknown[], path: string, ancestors: Set<object>): string {
	const items: string[] = [];
	for (let index = 0; index < array.length; index++) {
		if (!(index in array)) refuse(`${path}[${index}]`, "a sparse array has a hole");
		items.push(encodeAt(array[index], `${path}[${index}]`, ancestors));
	}
	return `[${items.join(",")}]`;
}

function encodeObject(object: object, path: string, ancestors: Set<object>): string {
	if (!isPlainRecord(object)) refuse(path, "it is not a plain object (a class instance, Map, Set, Date or similar)");
	const record: Record<string, unknown> = object;
	if (Object.getOwnPropertySymbols(record).length > 0) refuse(path, "it has a symbol key");
	const keys = Object.keys(record);
	if (Object.getOwnPropertyNames(record).length !== keys.length) refuse(path, "it has a non-enumerable property");
	const members = keys
		.sort()
		.map((key) => `${JSON.stringify(key)}:${encodeAt(record[key], childPath(path, key), ancestors)}`);
	return `{${members.join(",")}}`;
}

/** The canonical JSON of JSON data. Anything else throws a TypeError naming the path of the first value that is not. */
export function strictCanonicalJson(value: unknown): string {
	return encodeAt(value, "$", new Set());
}

/**
 * A value the encoder refuses (a cycle, a symbol key, a non-enumerable property) is returned unchanged, so
 * strictCanonicalJson still refuses it with its path; a copy that dropped those would hide the refusal.
 */
function stripAt(value: unknown, ancestors: Set<object>): unknown {
	if (typeof value !== "object" || value === null || ancestors.has(value)) return value;
	if (!Array.isArray(value)) {
		if (!isPlainRecord(value)) return value;
		if (Object.getOwnPropertySymbols(value).length > 0) return value;
		if (Object.getOwnPropertyNames(value).length !== Object.keys(value).length) return value;
	}
	ancestors.add(value);
	try {
		if (Array.isArray(value)) return value.map((item) => stripAt(item, ancestors));
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, member]) => member !== undefined)
				.map(([key, member]) => [key, stripAt(member, ancestors)]),
		);
	} finally {
		ancestors.delete(value);
	}
}

/**
 * The value with every undefined object member removed at every depth, which is how JSON reads an undefined member.
 * Only plain objects are rebuilt; any other value passes through, so strictCanonicalJson still judges it.
 */
export function withoutUndefinedMembers(value: unknown): unknown {
	return stripAt(value, new Set());
}
