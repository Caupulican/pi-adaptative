import { projectMessagesForModelImageSupport } from "@caupulican/pi-ai/image-support";
import type { Api, Context, ImageContent, Message, Model, TextContent } from "@caupulican/pi-ai/types";

const CHARS_PER_TOKEN_ESTIMATE = 4;
export const ESTIMATED_IMAGE_TOKENS = 1_200;
export const ESTIMATED_IMAGE_CHARS = ESTIMATED_IMAGE_TOKENS * CHARS_PER_TOKEN_ESTIMATE;

type JsonStringMeasure = (value: string) => number;

function jsonStringUtf16Length(value: string): number {
	let length = 2;
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
				length += 2;
				index++;
			} else {
				length += 6;
			}
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			length += 6;
		} else {
			length++;
		}
	}
	return length;
}

function jsonStringUtf8Bytes(value: string): number {
	let bytes = 2;
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
			bytes += 2;
		} else if (code < 0x20) {
			bytes += 6;
		} else if (code <= 0x7f) {
			bytes++;
		} else if (code <= 0x7ff) {
			bytes += 2;
		} else if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				index++;
			} else {
				bytes += 6;
			}
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			bytes += 6;
		} else {
			bytes += 3;
		}
	}
	return bytes;
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
	return measuredJsonValue(value, "", new Set(), jsonStringUtf8Bytes);
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

function semanticMessages(messages: Message[], addImageChars: () => void): Message[] {
	let changed = false;
	const projected = messages.map((message) => {
		if (message.role === "user" && Array.isArray(message.content)) {
			const content = semanticImageContent(message.content, addImageChars);
			if (content === message.content) return message;
			changed = true;
			return { ...message, content };
		}
		if (message.role === "toolResult") {
			const content = semanticImageContent(message.content, addImageChars);
			if (content === message.content) return message;
			changed = true;
			return { ...message, content };
		}
		return message;
	});
	return changed ? projected : messages;
}

/** Bounded semantic planning estimate over the complete, already-materialized provider Context. */
export function estimateProviderRequestTokens(context: Context, model?: Model<Api>): number {
	let imageChars = 0;
	const imageAwareMessages = model ? projectMessagesForModelImageSupport(context.messages, model) : context.messages;
	const messages = semanticMessages(imageAwareMessages, () => {
		imageChars += ESTIMATED_IMAGE_CHARS;
	});
	const serializedLength = measureJsonLength({
		systemPrompt: context.systemPrompt,
		messages,
		tools: context.tools,
	});
	return serializedLength === undefined ? 0 : Math.ceil((serializedLength + imageChars) / CHARS_PER_TOKEN_ESTIMATE);
}
