import { createHash } from "node:crypto";
import { strictCanonicalJson } from "../../kernel/utils/strict-canonical-json.ts";

export { strictCanonicalJson, withoutUndefinedMembers } from "../../kernel/utils/strict-canonical-json.ts";

/**
 * Lenient canonical JSON for display and stored text. It drops undefined members and reads a non-plain value (a Map, a
 * class instance) as its enumerable fields, so two different values can share its text. Identity keys use
 * strictCanonicalDigest.
 */
export function canonicalJson(value: unknown): string {
	if (value === undefined || value === null || typeof value !== "object") {
		return JSON.stringify(value === undefined ? null : value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	}
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj)
		.filter((key) => obj[key] !== undefined)
		.sort();
	const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`);
	return `{${entries.join(",")}}`;
}

/** The lenient digest of canonicalJson, kept where a caller may hold a non-plain value. Prefer strictCanonicalDigest. */
export function canonicalDigest(value: unknown): string {
	return createHash("sha256")
		.update(canonicalJson(value ?? null))
		.digest("hex");
}

/** SHA-256 of the strict canonical JSON: the digest of an identity value made only of JSON data. */
export function strictCanonicalDigest(value: unknown): string {
	return createHash("sha256").update(strictCanonicalJson(value)).digest("hex");
}
