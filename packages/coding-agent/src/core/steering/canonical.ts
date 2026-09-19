import { createHash } from "node:crypto";

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

export function canonicalDigest(value: unknown): string {
	return createHash("sha256")
		.update(canonicalJson(value ?? null))
		.digest("hex");
}
