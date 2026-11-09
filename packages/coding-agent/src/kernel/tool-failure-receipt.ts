/**
 * Bounded structured facts a tool attaches to a failed call's persisted result, beside the flat outcome details.
 * A receipt states the tool's own fixed facts, such as the stakes the host read from a script the call failed to run.
 * It carries no output text and no paths. The kernel copies it strictly, so nothing a runtime copy of the error holds
 * (getters, cycles, unbounded data) reaches the record, and the failed result is built here.
 */
import type { AgentToolOutcomeDetails, AgentToolResult } from "./types.ts";

/** A value a receipt may hold: a JSON primitive, or an array or record of the same. */
export type ToolReceiptValue =
	| string
	| number
	| boolean
	| null
	| readonly ToolReceiptValue[]
	| { readonly [key: string]: ToolReceiptValue };

/** The facts one failed call attaches to its persisted result, keyed by name. */
export type AgentToolFailureReceipt = Readonly<Record<string, ToolReceiptValue>>;

/** Objects and arrays may nest at most this many levels, the receipt's own object being level 1. */
const MAX_RECEIPT_DEPTH = 3;
const MAX_RECEIPT_KEYS = 16;
const MAX_RECEIPT_ITEMS = 32;
const MAX_RECEIPT_STRING_CHARS = 512;
/** The receipt's JSON text, in characters: a bound on what one tool may persist for one failed call. */
const MAX_RECEIPT_JSON_CHARS = 8 * 1024;

/**
 * A strict copy of a receipt read from a runtime copy of an error or a result, or undefined when the value is not a
 * receipt of the bounded shape. Own data properties only: no getter runs, and the copy is frozen.
 */
export function readAgentToolFailureReceipt(value: unknown): AgentToolFailureReceipt | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const copy = copyRecord(value, 1);
	if (copy === undefined || Object.keys(copy).length === 0) return undefined;
	return JSON.stringify(copy).length <= MAX_RECEIPT_JSON_CHARS ? copy : undefined;
}

/**
 * The persisted result of a failed call: its message, its flat outcome details, and the receipt the tool attached.
 * Flat details win a key clash, so a receipt cannot overwrite the tool's own outcome fields.
 */
export function createErrorToolResult(
	message: string,
	details?: AgentToolOutcomeDetails,
	receipt?: AgentToolFailureReceipt,
): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: { ...receipt, ...details },
	};
}

/** Copies a value under the receipt bounds. Undefined rejects it; no valid receipt value is undefined. */
function copyValue(value: unknown, depth: number): ToolReceiptValue | undefined {
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") return value.length <= MAX_RECEIPT_STRING_CHARS ? value : undefined;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value !== "object" || value === null || depth > MAX_RECEIPT_DEPTH) return undefined;
	return Array.isArray(value) ? copyArray(value, depth) : copyRecord(value, depth);
}

function copyRecord(value: object, depth: number): Readonly<Record<string, ToolReceiptValue>> | undefined {
	const keys = Object.keys(value);
	if (keys.length > MAX_RECEIPT_KEYS) return undefined;
	const entries: [string, ToolReceiptValue][] = [];
	for (const key of keys) {
		const item = copyOwnValue(value, key, depth + 1);
		if (item === undefined) return undefined;
		entries.push([key, item]);
	}
	// Object.fromEntries defines each key as an own property, so a key named `__proto__` stays data.
	return Object.freeze(Object.fromEntries(entries));
}

function copyArray(value: readonly unknown[], depth: number): readonly ToolReceiptValue[] | undefined {
	if (value.length > MAX_RECEIPT_ITEMS) return undefined;
	const items: ToolReceiptValue[] = [];
	for (let index = 0; index < value.length; index++) {
		const item = copyOwnValue(value, String(index), depth + 1);
		if (item === undefined) return undefined;
		items.push(item);
	}
	return Object.freeze(items);
}

/** The own data property `key` of `holder`, copied under the bounds. An accessor, a hole or a missing key rejects. */
function copyOwnValue(holder: object, key: string, depth: number): ToolReceiptValue | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(holder, key);
	if (!descriptor || !("value" in descriptor)) return undefined;
	return copyValue(descriptor.value, depth);
}
