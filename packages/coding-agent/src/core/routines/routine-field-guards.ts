/**
 * The bounded-text check the routine parsers share, so the contract and the leaf modules that read stored routine
 * fields refuse the same malformed values in the same words.
 */

/** A non-empty string without surrounding space or NUL, at most `maximum` characters; `label` names it in the refusal. */
export function boundedRoutineText(value: unknown, maximum: number, label: string): string {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.length > maximum ||
		value.trim() !== value ||
		value.includes("\0")
	)
		throw new TypeError(`Routine ${label} is invalid.`);
	return value;
}
