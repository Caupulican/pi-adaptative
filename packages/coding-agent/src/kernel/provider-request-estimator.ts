import { projectMessagesForModelImageSupport } from "@caupulican/pi-ai";
import type { Api, Context, ImageContent, Message, Model, TextContent } from "@caupulican/pi-ai/types";
import { PrefixFoldByFirstItem } from "./prefix-fold.ts";

const CHARS_PER_TOKEN_ESTIMATE = 4;
export const ESTIMATED_IMAGE_TOKENS = 1_200;
export const ESTIMATED_IMAGE_CHARS = ESTIMATED_IMAGE_TOKENS * CHARS_PER_TOKEN_ESTIMATE;

type JsonStringMeasure = (value: string) => number;

function measureJsonString(value: string, utf8: boolean, maximumLength: number): number {
	let length = 2;
	if (length > maximumLength) return maximumLength + 1;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (
			code === 0x22 ||
			code === 0x5c ||
			code === 0x08 ||
			code === 0x09 ||
			code === 0x0a ||
			code === 0x0c ||
			code === 0x0d
		) {
			length += 2;
		} else if (code < 0x20) {
			length += 6;
		} else if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				length += utf8 ? 4 : 2;
				index++;
			} else {
				length += 6;
			}
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			length += 6;
		} else if (!utf8 || code <= 0x7f) {
			length++;
		} else if (code <= 0x7ff) {
			length += 2;
		} else {
			length += 3;
		}
		if (length > maximumLength) return maximumLength + 1;
	}
	return length;
}

function jsonStringUtf16Length(value: string): number {
	return measureJsonString(value, false, Number.POSITIVE_INFINITY);
}

/** Exact UTF-8 byte length of a JSON string, or `maximumBytes + 1` once its bound is exceeded. */
export function measureJsonStringUtf8Bytes(value: string, maximumBytes = Number.POSITIVE_INFINITY): number {
	return measureJsonString(value, true, maximumBytes);
}

function measuredJsonValue(
	value: unknown,
	key: string,
	active: Set<object>,
	measureString: JsonStringMeasure,
): number | undefined {
	if (typeof value === "object" && value !== null) {
		const toJSON = Reflect.get(value, "toJSON");
		if (typeof toJSON === "function") value = Reflect.apply(toJSON, value, [key]) as unknown;
	}

	switch (typeof value) {
		case "string":
			return measureString(value);
		case "number":
			return Number.isFinite(value) ? (Object.is(value, -0) ? 1 : String(value).length) : 4;
		case "boolean":
			return value ? 4 : 5;
		case "bigint":
			throw new TypeError("Do not know how to serialize a BigInt");
		case "undefined":
		case "function":
		case "symbol":
			return undefined;
		case "object":
			break;
	}

	if (value === null) return 4;
	if (value instanceof String || value instanceof Number || value instanceof Boolean) {
		return measuredJsonValue(value.valueOf(), key, active, measureString);
	}
	if (active.has(value)) throw new TypeError("Converting circular structure to JSON");
	active.add(value);
	try {
		if (Array.isArray(value)) {
			let length = 2 + Math.max(0, value.length - 1);
			for (let index = 0; index < value.length; index++) {
				length += measuredJsonValue(value[index], String(index), active, measureString) ?? 4;
			}
			return length;
		}

		let length = 2;
		let fields = 0;
		for (const field of Object.keys(value)) {
			const fieldLength = measuredJsonValue(Reflect.get(value, field), field, active, measureString);
			if (fieldLength === undefined) continue;
			if (fields > 0) length++;
			length += measureString(field) + 1 + fieldLength;
			fields++;
		}
		return length;
	} finally {
		active.delete(value);
	}
}

/** Exact UTF-16 length of standard JSON-compatible data without allocating its serialized copy. */
export function measureJsonLength(value: unknown): number | undefined {
	return measuredJsonValue(value, "", new Set(), jsonStringUtf16Length);
}

/** Exact UTF-8 byte length of standard JSON-compatible data without allocating its serialized copy. */
export function measureJsonUtf8Bytes(value: unknown): number | undefined {
	return measuredJsonValue(value, "", new Set(), measureJsonStringUtf8Bytes);
}

function semanticImageContent(
	content: (TextContent | ImageContent)[],
	addImageChars: () => void,
): (TextContent | ImageContent)[] {
	let changed = false;
	const projected = content.map((block) => {
		if (block.type !== "image") return block;
		changed = true;
		addImageChars();
		return { type: "image" as const, data: "", mimeType: block.mimeType };
	});
	return changed ? projected : content;
}

function semanticMessage(message: Message, addImageChars: () => void): unknown {
	switch (message.role) {
		case "user":
			return {
				role: message.role,
				content: Array.isArray(message.content)
					? semanticImageContent(message.content, addImageChars)
					: message.content,
			};
		case "assistant":
			return {
				role: message.role,
				content: message.content,
				api: message.api,
				provider: message.provider,
				model: message.model,
			};
		case "toolResult":
			return {
				role: message.role,
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				content: semanticImageContent(message.content, addImageChars),
				isError: message.isError,
			};
	}
	const exhaustive: never = message;
	return exhaustive;
}

interface SemanticMessageMeasure {
	/** JSON length of the message's semantic projection, or the `null` length when unmeasurable. */
	readonly length: number;
	/** Image blocks the projection replaced, each worth ESTIMATED_IMAGE_CHARS. */
	readonly images: number;
}

/**
 * Per-message measurements, keyed by message identity. A request is estimated at least twice per
 * provider call (admission plus the non-compactable floor) over the WHOLE context, and messages are
 * immutable once built and keep their identity across requests unless a pipeline stage rewrites them,
 * so measuring every message on every request re-walked the entire transcript: 8% of host CPU over a
 * 1,500-turn session, growing with the transcript. Now only messages this process has never measured
 * are walked. `WeakMap`, so a message that leaves the context takes its measurement with it.
 */
const semanticMessageMeasures = new WeakMap<Message, SemanticMessageMeasure>();

function measureSemanticMessage(message: Message): SemanticMessageMeasure {
	const cached = semanticMessageMeasures.get(message);
	if (cached) return cached;
	let images = 0;
	const projected = semanticMessage(message, () => {
		images += 1;
	});
	// `undefined` only for values JSON omits; a message is an object, so it serializes as `null` at worst.
	const measure: SemanticMessageMeasure = { length: measureJsonLength(projected) ?? 4, images };
	semanticMessageMeasures.set(message, measure);
	return measure;
}

/**
 * The `[...]` length and image count of a message array, summed once per appended message: the
 * per-message measure above is memoized, but adding up every message on every request was still
 * a full pass over the transcript, twice per provider call.
 */
const messagesMeasures = new PrefixFoldByFirstItem<Message, { length: number; imageChars: number }>(
	() => ({ length: 2, imageChars: 0 }),
	(state, message, index) => {
		const measure = measureSemanticMessage(message);
		state.length += measure.length + (index > 0 ? 1 : 0);
		state.imageChars += measure.images * ESTIMATED_IMAGE_CHARS;
	},
);

const MESSAGES_FIELD_LENGTH = jsonStringUtf16Length("messages") + 1;
const TOOLS_FIELD_LENGTH = jsonStringUtf16Length("tools") + 1;
const SYSTEM_PROMPT_FIELD_LENGTH = jsonStringUtf16Length("systemPrompt") + 1;

/**
 * The two bounded fields are still tens of kilobytes measured per request for the same answer:
 * the system prompt is one string repeated on nearly every request, and each projected tool
 * object is identity-stable across requests (provider-tool-projection memoizes it). Remembered
 * by value for the prompt and by identity per tool.
 */
let lastSystemPromptMeasure: { readonly prompt: string; readonly length: number } | undefined;
function systemPromptLength(prompt: string): number {
	if (lastSystemPromptMeasure && lastSystemPromptMeasure.prompt === prompt) return lastSystemPromptMeasure.length;
	const length = jsonStringUtf16Length(prompt);
	lastSystemPromptMeasure = { prompt, length };
	return length;
}

const toolMeasures = new WeakMap<object, number>();
function toolsLength(tools: readonly unknown[]): number {
	let length = 2;
	for (let index = 0; index < tools.length; index++) {
		const tool = tools[index];
		let measured: number | undefined;
		if (tool && typeof tool === "object") {
			measured = toolMeasures.get(tool);
			if (measured === undefined) {
				measured = measureJsonLength(tool) ?? 4;
				toolMeasures.set(tool, measured);
			}
		} else {
			measured = measureJsonLength(tool) ?? 4;
		}
		length += measured + (index > 0 ? 1 : 0);
	}
	return length;
}

/**
 * Bounded semantic planning estimate over the complete, already-materialized provider Context.
 *
 * Assembles the exact length of `{"systemPrompt":…,"messages":[…],"tools":…}` from the memoized
 * per-message measurements above plus a direct measurement of the two bounded fields, so the result
 * is byte-identical to measuring the assembled object -- pinned by test -- without walking messages
 * measured on an earlier request.
 */
export function estimateProviderRequestTokens(context: Context, model?: Model<Api>): number {
	const imageAwareMessages = model ? projectMessagesForModelImageSupport(context.messages, model) : context.messages;
	const measured = messagesMeasures.fold(imageAwareMessages);
	const messagesLength = measured.length;
	const imageChars = measured.imageChars;
	// Exact assembly of `{"systemPrompt":…,"messages":[…],"tools":…}`: braces, each present field's
	// name, colon and value, and a comma between fields. `undefined` fields are omitted, as JSON does.
	let serializedLength = 2;
	let fields = 0;
	if (context.systemPrompt !== undefined) {
		serializedLength += SYSTEM_PROMPT_FIELD_LENGTH + systemPromptLength(context.systemPrompt);
		fields += 1;
	}
	serializedLength += (fields > 0 ? 1 : 0) + MESSAGES_FIELD_LENGTH + messagesLength;
	fields += 1;
	if (context.tools !== undefined) {
		serializedLength += 1 + TOOLS_FIELD_LENGTH + toolsLength(context.tools);
	}
	return Math.ceil((serializedLength + imageChars) / CHARS_PER_TOKEN_ESTIMATE);
}
