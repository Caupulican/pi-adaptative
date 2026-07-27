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
