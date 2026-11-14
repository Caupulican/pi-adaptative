/**
 * The scalar readers the durable orchestration codecs share: a non-empty string, a finite number and a bounded identifier.
 * Each throws a DurableTaskRuntimeError that names its field, so a corrupt record fails where it is read. They sit apart from
 * the record codecs so a small decoder module can read its fields without importing the codecs, which would form a cycle.
 */

import { MAX_ORCHESTRATION_IDENTIFIER_LENGTH } from "./contracts.ts";
import { DurableTaskRuntimeError } from "./task-runtime-state.ts";

/** The largest epoch milliseconds a JavaScript Date holds; a durable instant past it is invalid. */
export const MAX_DATE_EPOCH_MS = 8_640_000_000_000_000;

export function string(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new DurableTaskRuntimeError(`${label} is required.`);
	return value;
}

export function number(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new DurableTaskRuntimeError(`${label} is invalid.`);
	return value;
}

export function dispatchIdentifier(value: unknown, label: string): string {
	const identifier = string(value, label);
	if (identifier.length > MAX_ORCHESTRATION_IDENTIFIER_LENGTH) {
		throw new DurableTaskRuntimeError(`${label} exceeds its durable size bound.`);
	}
	return identifier;
}
