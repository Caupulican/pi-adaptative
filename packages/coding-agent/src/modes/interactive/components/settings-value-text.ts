/**
 * How a settings row turns a stored value into the text its value column shows: booleans, optional strings and numbers.
 * The value strings are also what the rows compare their options against, so they are machinery, not prose.
 */

export function booleanSettingValue(value: boolean | undefined, defaultValue = false): string {
	return (value ?? defaultValue) ? "true" : "false";
}

export function optionalStringValue(value: string | undefined, fallback = "(not set)"): string {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

export function normalizeOptionalString(value: string): string | undefined {
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function numberSettingValue(value: number | undefined, defaultValue: number): string {
	return String(value ?? defaultValue);
}
