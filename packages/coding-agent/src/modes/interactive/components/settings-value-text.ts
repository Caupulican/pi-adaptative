/**
 * How a settings row turns a stored value into the text its value column shows: booleans, optional strings and numbers.
 * The value strings are also what the rows compare their options against, so they are machinery, not prose; the one
 * exception is the word shown for an absent optional string, which the catalogue supplies.
 */

import { interfaceText } from "../../../core/language/interface-text.ts";

export function booleanSettingValue(value: boolean | undefined, defaultValue = false): string {
	return (value ?? defaultValue) ? "true" : "false";
}

export function optionalStringValue(value: string | undefined, fallback?: string): string {
	const trimmed = value?.trim();
	if (trimmed && trimmed.length > 0) return trimmed;
	return fallback ?? interfaceText().settingsScreen.values.notSet;
}

export function normalizeOptionalString(value: string): string | undefined {
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function numberSettingValue(value: number | undefined, defaultValue: number): string {
	return String(value ?? defaultValue);
}
