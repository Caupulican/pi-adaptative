import type { Api, ImageContent, Message, Model, TextContent } from "./types.ts";

export const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
export const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

function replaceUnsupportedImagesWithPlaceholder(
	content: (TextContent | ImageContent)[],
	placeholder: string,
	isSupported: (block: ImageContent) => boolean,
): (TextContent | ImageContent)[] {
	let result: (TextContent | ImageContent)[] | undefined;
	let previousWasPlaceholder = false;
	for (let index = 0; index < content.length; index++) {
		const block = content[index]!;
		if (block.type === "image" && !isSupported(block)) {
			result ??= content.slice(0, index);
			if (!previousWasPlaceholder) result.push({ type: "text", text: placeholder });
			previousWasPlaceholder = true;
			continue;
		}
		result?.push(block);
		previousWasPlaceholder = block.type === "text" && block.text === placeholder;
	}
	return result ?? content;
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
	let projected: Message[] | undefined;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]!;
		if ((message.role !== "user" && message.role !== "toolResult") || !Array.isArray(message.content)) continue;
		const placeholder =
			message.role === "user" ? NON_VISION_USER_IMAGE_PLACEHOLDER : NON_VISION_TOOL_IMAGE_PLACEHOLDER;
		const content = replaceUnsupportedImagesWithPlaceholder(message.content, placeholder, isSupported);
		if (content !== message.content) {
			projected ??= messages.slice();
			projected[index] = { ...message, content };
		}
	}
	return projected ?? messages;
}
