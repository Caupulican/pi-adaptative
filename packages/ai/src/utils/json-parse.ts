import { parse as partialParse } from "partial-json";
import type { ToolCall } from "../types.ts";

const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

function isControlCharacter(char: string): boolean {
	const codePoint = char.codePointAt(0);
	return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

function escapeControlCharacter(char: string): string {
	switch (char) {
		case "\b":
			return "\\b";
		case "\f":
			return "\\f";
		case "\n":
			return "\\n";
		case "\r":
			return "\\r";
		case "\t":
			return "\\t";
		default:
			return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
	}
}

/**
 * Repairs malformed JSON string literals by:
 * - escaping raw control characters inside strings
 * - doubling backslashes before invalid escape characters
 */
export function repairJson(json: string): string {
	const repaired: string[] = [];
	let unchangedStart = 0;
	let inString = false;
	const replaceCharacter = (index: number, replacement: string) => {
		if (unchangedStart < index) repaired.push(json.slice(unchangedStart, index));
		repaired.push(replacement);
		unchangedStart = index + 1;
	};

	for (let index = 0; index < json.length; index++) {
		const char = json[index];

		if (!inString) {
			if (char === '"') {
				inString = true;
			}
			continue;
		}

		if (char === '"') {
			inString = false;
			continue;
		}

		if (char === "\\") {
			const nextChar = json[index + 1];
			if (nextChar === undefined) {
				replaceCharacter(index, "\\\\");
				continue;
			}

			if (nextChar === "u") {
				const unicodeDigits = json.slice(index + 2, index + 6);
				if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
					index += 5;
					continue;
				}
				replaceCharacter(index, "\\\\");
				continue;
			}

			if (VALID_JSON_ESCAPES.has(nextChar)) {
				index += 1;
				continue;
			}

			replaceCharacter(index, "\\\\");
			continue;
		}

		if (isControlCharacter(char)) replaceCharacter(index, escapeControlCharacter(char));
	}

	if (repaired.length === 0) return json;
	if (unchangedStart < json.length) repaired.push(json.slice(unchangedStart));
	return repaired.join("");
}

export function parseJsonWithRepair<T>(json: string): T {
	try {
		return JSON.parse(json) as T;
	} catch (error) {
		const repairedJson = repairJson(json);
		if (repairedJson !== json) {
			return JSON.parse(repairedJson) as T;
		}
		throw error;
	}
}

/**
 * Attempts to parse potentially incomplete JSON during streaming.
 * Always returns a valid object, even if the JSON is incomplete.
 *
 * @param partialJson The partial JSON string from streaming
 * @returns Parsed object or empty object if parsing fails
 */
export interface StreamingJsonParseResult<T> {
	complete: boolean;
	value: T;
}

export function parseStreamingJsonState<T = Record<string, unknown>>(
	partialJson: string | undefined,
): StreamingJsonParseResult<T> {
	if (!partialJson || partialJson.trim() === "") {
		return { complete: true, value: {} as T };
	}

	try {
		return { complete: true, value: parseJsonWithRepair<T>(partialJson) };
	} catch {
		try {
			const result = partialParse(partialJson);
			return { complete: false, value: (result ?? {}) as T };
		} catch {
			try {
				const result = partialParse(repairJson(partialJson));
				return { complete: false, value: (result ?? {}) as T };
			} catch {
				return { complete: false, value: {} as T };
			}
		}
	}
}

export function parseStreamingJson<T = Record<string, unknown>>(partialJson: string | undefined): T {
	return parseStreamingJsonState<T>(partialJson).value;
}

interface PendingToolArguments {
	text: string;
	value: ToolCall["arguments"] | undefined;
	read: boolean;
	probeAfter: number;
	openString?: OpenToolArgumentString;
}

const pendingToolArguments = new WeakMap<ToolCall, PendingToolArguments>();

interface OpenToolArgumentString {
	base: ToolCall["arguments"];
	key: string;
	text: string;
	suffix: string;
}

/**
 * Certify the common file-write shape by completing the open string with one extra character.
 * Compare against the authoritative partial parser before enabling incremental decoding.
 */
function openToolArgumentString(text: string, value: ToolCall["arguments"]): OpenToolArgumentString | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const prefix = text.trimEnd();
	let completed: ToolCall["arguments"];
	try {
		completed = JSON.parse(`${prefix}~"}`);
	} catch {
		return undefined;
	}
	const keys = Object.keys(completed);
	if (keys.length !== Object.keys(value).length) return undefined;
	let key: string | undefined;
	for (const field of keys) {
		const before = value[field];
		const after = completed[field];
		if (!Object.hasOwn(value, field) || (before !== null && typeof before === "object")) return undefined;
		if (Object.is(before, after)) continue;
		if (key !== undefined || typeof before !== "string" || after !== `${before}~`) return undefined;
		key = field;
	}
	if (key === undefined) return undefined;
	return { base: { ...value }, key, text: value[key] as string, suffix: text.slice(prefix.length) };
}

function projectToolArguments(state: PendingToolArguments): ToolCall["arguments"] {
	const open = state.openString;
	if (open) {
		const suffix = open.suffix.trimEnd();
		try {
			// A closing quote, split escape or malformed fragment goes through the existing parser.
			const decoded = /["\\\x00-\x1f]/u.test(suffix) ? (JSON.parse(`"${suffix}"`) as string) : suffix;
			open.text += decoded;
			open.suffix = open.suffix.slice(suffix.length);
			return { ...open.base, [open.key]: open.text };
		} catch {
			state.openString = undefined;
		}
	}
	const value = parseStreamingJson(state.text);
	if (state.text.length >= state.probeAfter) {
		state.probeAfter = state.text.length * 2;
		state.openString = openToolArgumentString(state.text, value);
	}
	return value;
}

/** Each consumer can read the current prefix. Unobserved deltas need only update its source. */
export function stageToolArguments(call: ToolCall, text: string, delta: string): void {
	const pending = pendingToolArguments.get(call);
	if (pending) {
		if (pending.openString) pending.openString.suffix += delta;
		pending.text = text;
		pending.value = undefined;
		pending.read = false;
		return;
	}

	const state: PendingToolArguments = { text, value: undefined, read: false, probeAfter: 4096 };
	Object.defineProperty(call, "arguments", {
		enumerable: true,
		configurable: true,
		get: () => {
			if (!state.read) {
				state.value = projectToolArguments(state);
				state.read = true;
			}
			return state.value;
		},
		set: (value: ToolCall["arguments"]) => {
			state.value = value;
			state.read = true;
		},
	});
	pendingToolArguments.set(call, state);
}

/** Terminal events expose ordinary writable argument data with no retained JSON prefix. */
export function settleToolArguments(call: ToolCall): void {
	if (!pendingToolArguments.delete(call)) return;
	Object.defineProperty(call, "arguments", {
		enumerable: true,
		configurable: true,
		writable: true,
		value: call.arguments,
	});
}
