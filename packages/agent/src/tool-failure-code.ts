const MAX_FAILURE_CODE_CHARS = 48;

/** Accept the canonical ASCII code and its existing terminal truncation marker. */
export function isBoundedFailureCode(value: unknown): value is string {
	return (
		typeof value === "string" && value.length > 0 && value.length <= MAX_FAILURE_CODE_CHARS &&
		/^[a-z0-9_.:-]+(?:…)?$/.test(value)
	);
}

/** Canonical bounded failure identity shared by recovery memory and executor receipts. */
export function boundedFailureCode(value: string): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_.:-]+/g, "_")
		.replace(/^_+|_+$/g, "");
	const code = normalized || "tool_error";
	return code.length <= MAX_FAILURE_CODE_CHARS ? code : `${code.slice(0, MAX_FAILURE_CODE_CHARS - 1)}…`;
}
