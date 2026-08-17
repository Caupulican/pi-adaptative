import type { Api, ImageContent, Message, Model, TextContent } from "./types.ts";

export const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
export const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

function replaceUnsupportedImagesWithPlaceholder(
	content: (TextContent | ImageContent)[],
	placeholder: string,
	isSupported: (block: ImageContent) => boolean,
): (TextContent | ImageContent)[] {
	let changed = false;
	const result: (TextContent | ImageContent)[] = [];
	let previousWasPlaceholder = false;

	for (const block of content) {
		if (block.type === "image" && !isSupported(block)) {
			changed = true;
			if (!previousWasPlaceholder) result.push({ type: "text", text: placeholder });
			previousWasPlaceholder = true;
			continue;
		}

		result.push(block);
		previousWasPlaceholder = block.type === "text" && block.text === placeholder;
	}

	return changed ? result : content;
}

/** Provider capability projection shared by transport, token admission, and request-body budgeting. */
export function projectMessagesForModelImageSupport<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
): Message[] {
	if (model.input.includes("image") && !model.supportedImageMimeTypes) return messages;

	const supportedMimeTypes = model.input.includes("image")
		? new Set(model.supportedImageMimeTypes?.map((mimeType) => mimeType.toLowerCase()))
		: undefined;
	const isSupported = (block: ImageContent): boolean => supportedMimeTypes?.has(block.mimeType.toLowerCase()) === true;
	let changed = false;
	const projected = messages.map((message) => {
		if (message.role === "user" && Array.isArray(message.content)) {
			const content = replaceUnsupportedImagesWithPlaceholder(
				message.content,
				NON_VISION_USER_IMAGE_PLACEHOLDER,
				isSupported,
			);
			if (content === message.content) return message;
			changed = true;
			return { ...message, content };
		}

		if (message.role === "toolResult") {
			const content = replaceUnsupportedImagesWithPlaceholder(
				message.content,
				NON_VISION_TOOL_IMAGE_PLACEHOLDER,
				isSupported,
			);
			if (content === message.content) return message;
			changed = true;
			return { ...message, content };
		}

		return message;
	});
	return changed ? projected : messages;
}
