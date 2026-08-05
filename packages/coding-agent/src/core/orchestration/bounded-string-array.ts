import { MAX_ORCHESTRATION_COLLECTION_LENGTH, MAX_ORCHESTRATION_IDENTIFIER_LENGTH } from "./contracts.ts";

export interface BoundedStringArrayOptions {
	maxEntries?: number;
	maxLength?: number;
	trim?: boolean;
	invalidMessage: string;
	duplicateMessage: string;
	createError(message: string): Error;
}

/** Mandatory parser for unique string collections crossing the orchestration trust boundary. */
export function parseBoundedStringArray(value: unknown, options: BoundedStringArrayOptions): string[] {
	const maxEntries = options.maxEntries ?? MAX_ORCHESTRATION_COLLECTION_LENGTH;
	const maxLength = options.maxLength ?? MAX_ORCHESTRATION_IDENTIFIER_LENGTH;
	if (!Array.isArray(value) || value.length > maxEntries || !value.every((entry) => typeof entry === "string")) {
		throw options.createError(options.invalidMessage);
	}
	const strings = value.map((entry) => (options.trim ? entry.trim() : entry));
	if (strings.some((entry) => entry.length === 0 || entry.length > maxLength)) {
		throw options.createError(options.invalidMessage);
	}
	if (new Set(strings).size !== strings.length) throw options.createError(options.duplicateMessage);
	return strings;
}
