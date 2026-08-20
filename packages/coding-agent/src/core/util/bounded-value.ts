/** One primitive for required, trimmed durable text fields shared across control-plane stores. */
export function requireBoundedTrimmedText(value: string, maximum: number, label: string): string {
	if (!Number.isSafeInteger(maximum) || maximum < 1) {
		throw new TypeError("A bounded text maximum must be a positive safe integer.");
	}
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > maximum) {
		throw new TypeError(`${label} must be between 1 and ${maximum} characters.`);
	}
	return trimmed;
}

/** Return the longest prefix within a UTF-8 byte ceiling without splitting a code point. */
export function utf8PrefixByBytes(value: string, maximumBytes: number): string {
	if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
		throw new TypeError("A UTF-8 prefix maximum must be a non-negative safe integer.");
	}
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= maximumBytes) return value;
	let end = maximumBytes;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}
