/**
 * The leaf of a tool call or tool result, built from code facts alone. A call's name and chief arguments and a result's
 * size, head and tail are known without reading for meaning, so such a message needs no model call to reach the tree;
 * the model's summaries stay for words (the user's, the agent's, a work report).
 */

import { isPlainRecord } from "../util/value-guards.ts";
import type { ContinuousChatRecord } from "./continuous-chat-contracts.ts";
import { CONTINUOUS_CHAT_NODE_TARGET_BYTES } from "./continuous-chat-tree.ts";

/** Longest tool name read from a call record; anything else on the first line is not a name. */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
/** Value budgets, in bytes: a command is worth more room than a path, everything else is an identifier or a flag. */
const COMMAND_VALUE_BYTES = 240;
const DEFAULT_VALUE_BYTES = 120;
const FALLBACK_KEY_COUNT = 4;
const LIST_ITEMS_SHOWN = 3;
const LIST_ITEM_BYTES = 60;
/** Share of an excerpt's room given to the head; the rest shows the tail. */
const HEAD_SHARE = 0.6;
const EXCERPT_TEXT_LABEL = "text: ";
const EXCERPT_HEAD_LABEL = "head: ";
const EXCERPT_TAIL_JOINT = " ... tail: ";

interface ToolArgumentMap {
	/** Arguments shown with their value, in this order. */
	show: readonly string[];
	/** Arguments shown only by size (a body or a list), in this order. */
	size?: readonly string[];
}

/** The most identifying arguments of the common tools. Any other tool shows its first keys. */
const TOOL_ARGUMENTS: Readonly<Record<string, ToolArgumentMap>> = {
	read: { show: ["path", "offset", "limit"] },
	edit: { show: ["path"], size: ["edits", "oldText", "newText"] },
	write: { show: ["path"], size: ["content"] },
	grep: { show: ["pattern", "path", "glob"] },
	find: { show: ["pattern", "name", "path"] },
	ls: { show: ["path"] },
	bash: { show: ["command"] },
	delegate: { show: ["action", "name", "id", "goal", "task", "path"] },
	assign: { show: ["task", "files", "deep"] },
	goal: { show: ["action", "goalId", "requirementId", "objective", "userGoal", "text"] },
	task_steps: { show: ["action", "id"], size: ["steps"] },
};

/** Why a reader meets this line instead of the message, and how to reach the message. */
const CALL_NOTE = "auto-summary: zoom for the exact call";
const RESULT_NOTE = "auto-summary: zoom for the exact result";

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function collapse(text: string): string {
	return text.replaceAll(/\s+/g, " ").trim();
}

/** Longest prefix within maxBytes, with " ..." marking a cut. Never splits a code point; the result is one line. */
export function clipUtf8SingleLine(text: string, maxBytes: number): string {
	const singleLine = text.replaceAll(/\r?\n/g, " ");
	if (byteLength(singleLine) <= maxBytes) return singleLine;
	const suffix = " ...";
	const budget = Math.max(0, maxBytes - byteLength(suffix));
	let used = 0;
	let out = "";
	for (const char of singleLine) {
		const charBytes = byteLength(char);
		if (used + charBytes > budget) break;
		out += char;
		used += charBytes;
	}
	return `${out}${suffix}`;
}

function prefixUtf8(text: string, maxBytes: number): string {
	let used = 0;
	let out = "";
	for (const char of text) {
		const charBytes = byteLength(char);
		if (used + charBytes > maxBytes) break;
		out += char;
		used += charBytes;
	}
	return out;
}

function suffixUtf8(text: string, maxBytes: number): string {
	const characters = Array.from(text);
	let used = 0;
	let start = characters.length;
	while (start > 0) {
		const charBytes = byteLength(characters[start - 1]!);
		if (used + charBytes > maxBytes) break;
		used += charBytes;
		start--;
	}
	return characters.slice(start).join("");
}

/** Whole text when it fits the budget; otherwise its head and its tail, so neither the opening nor the ending is lost. */
function excerpt(text: string, budget: number): string {
	const collapsed = collapse(text);
	if (collapsed.length === 0) return "no visible text";
	if (byteLength(EXCERPT_TEXT_LABEL) + byteLength(collapsed) <= budget) return `${EXCERPT_TEXT_LABEL}${collapsed}`;
	const room = Math.max(0, budget - byteLength(EXCERPT_HEAD_LABEL) - byteLength(EXCERPT_TAIL_JOINT));
	const headBytes = Math.ceil(room * HEAD_SHARE);
	const head = prefixUtf8(collapsed, headBytes).trimEnd();
	const tail = suffixUtf8(collapsed, room - headBytes).trimStart();
	return `${EXCERPT_HEAD_LABEL}${head}${EXCERPT_TAIL_JOINT}${tail}`;
}

function scalarText(value: string | number | boolean | null, maxBytes: number): string {
	if (typeof value !== "string") return String(value);
	const text = collapse(value);
	const clipped = clipUtf8SingleLine(text, maxBytes);
	return /\s/.test(clipped) ? `"${clipped}"` : clipped;
}

/** One argument value as a code fact: a scalar clipped, a list of strings by its first items, anything else by its shape. */
function valueText(value: unknown, maxBytes: number): string {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return scalarText(value, maxBytes);
	}
	if (Array.isArray(value)) {
		const strings = value.every((item) => typeof item === "string");
		if (!strings || value.length === 0) return `[${value.length} items]`;
		const shown = value.slice(0, LIST_ITEMS_SHOWN).map((item) => clipUtf8SingleLine(collapse(item), LIST_ITEM_BYTES));
		const more = value.length > LIST_ITEMS_SHOWN ? ` +${value.length - LIST_ITEMS_SHOWN}` : "";
		return `[${shown.join(", ")}${more}]`;
	}
	return `{${isPlainRecord(value) ? Object.keys(value).length : 0} keys}`;
}

function sizeText(value: unknown): string {
	if (typeof value === "string") return `${byteLength(value)} bytes`;
	if (Array.isArray(value)) return `${value.length} items`;
	return valueText(value, DEFAULT_VALUE_BYTES);
}

function argumentsText(name: string, args: Record<string, unknown>): string {
	const map = TOOL_ARGUMENTS[name];
	const parts: string[] = [];
	if (map === undefined) {
		for (const key of Object.keys(args).slice(0, FALLBACK_KEY_COUNT)) {
			parts.push(`${key}=${valueText(args[key], DEFAULT_VALUE_BYTES)}`);
		}
		return parts.join(" ");
	}
	for (const key of map.show) {
		if (args[key] === undefined) continue;
		parts.push(`${key}=${valueText(args[key], key === "command" ? COMMAND_VALUE_BYTES : DEFAULT_VALUE_BYTES)}`);
	}
	for (const key of map.size ?? []) {
		if (args[key] !== undefined) parts.push(`${key}=${sizeText(args[key])}`);
	}
	return parts.join(" ");
}

/** The call's name and the text after it, or undefined for a continuation chunk of a call split at the record limit. */
function splitToolCall(record: ContinuousChatRecord): { name: string; rest: string } | undefined {
	if (record.source !== undefined && record.source.unit > 0) return undefined;
	const newline = record.text.indexOf("\n");
	const name = newline < 0 ? record.text : record.text.slice(0, newline);
	if (!TOOL_NAME_PATTERN.test(name)) return undefined;
	return { name, rest: newline < 0 ? "" : record.text.slice(newline + 1) };
}

function parseArguments(text: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(text);
		return isPlainRecord(parsed) ? parsed : undefined;
	} catch {
		// A call split at the record limit holds a cut JSON text: its raw head and tail are shown instead.
		return undefined;
	}
}

function toolCallLine(record: ContinuousChatRecord): string {
	const call = splitToolCall(record);
	if (call === undefined) {
		const lead = `tool: continuation, ${record.textBytes} bytes, ${CALL_NOTE}. `;
		return `${lead}${excerpt(record.text, CONTINUOUS_CHAT_NODE_TARGET_BYTES - byteLength(lead))}`;
	}
	const args = parseArguments(call.rest);
	if (args === undefined) {
		const lead = `tool: ${call.name} ${byteLength(call.rest)} bytes of arguments, ${CALL_NOTE}. `;
		return `${lead}${excerpt(call.rest, CONTINUOUS_CHAT_NODE_TARGET_BYTES - byteLength(lead))}`;
	}
	const lead = `tool: ${call.name}`;
	const room = CONTINUOUS_CHAT_NODE_TARGET_BYTES - byteLength(lead) - byteLength(` (${CALL_NOTE})`) - 1;
	const body = clipUtf8SingleLine(argumentsText(call.name, args), Math.max(0, room));
	return `${lead}${body.length > 0 ? ` ${body}` : ""} (${CALL_NOTE})`;
}

function toolResultLine(record: ContinuousChatRecord): string {
	const clipped =
		record.toolClipping === undefined ? "" : ` (clipped from ${record.toolClipping.originalCharacters} characters)`;
	const lead = `echo: ${record.textBytes} bytes${clipped}, ${RESULT_NOTE}. `;
	return `${lead}${excerpt(record.text, CONTINUOUS_CHAT_NODE_TARGET_BYTES - byteLength(lead))}`;
}

/**
 * The deterministic leaf text of a `tool` or `echo` record, within the node target; undefined for any other kind. A line
 * says it is an automatic summary, so a reader knows `zoom` on the message gives the exact text. A result's tool name
 * and success are not in its record, so neither is claimed.
 */
export function buildContinuousChatToolLeafText(record: ContinuousChatRecord): string | undefined {
	if (record.kind === "tool") return toolCallLine(record);
	if (record.kind === "echo") return toolResultLine(record);
	return undefined;
}
