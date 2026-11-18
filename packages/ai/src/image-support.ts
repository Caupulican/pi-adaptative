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

/** Construct the model's image policy once for a batch of rows. */
export function modelImageProjection<TApi extends Api>(
	model: Model<TApi>,
): ((message: Message) => Message) | undefined {
	if (model.input.includes("image") && !model.supportedImageMimeTypes) return undefined;
	const supported = model.input.includes("image")
		? new Set(model.supportedImageMimeTypes?.map((type) => type.toLowerCase()))
		: undefined;
	const isSupported = (block: ImageContent): boolean => supported?.has(block.mimeType.toLowerCase()) === true;
	return (message) => {
		if ((message.role !== "user" && message.role !== "toolResult") || !Array.isArray(message.content)) return message;
		const placeholder =
			message.role === "user" ? NON_VISION_USER_IMAGE_PLACEHOLDER : NON_VISION_TOOL_IMAGE_PLACEHOLDER;
		const content = replaceUnsupportedImagesWithPlaceholder(message.content, placeholder, isSupported);
		return content === message.content ? message : { ...message, content };
	};
}

/** Provider capability projection shared by transport, token admission, and request-body budgeting. */
export function projectMessagesForModelImageSupport<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
): Message[] {
	const project = modelImageProjection(model);
	if (!project) return messages;
	let result: Message[] | undefined;
	for (let i = 0; i < messages.length; i++) {
		const message = project(messages[i]!);
		if (message !== messages[i]) {
			result ??= messages.slice();
			result[i] = message;
		}
	}
	return result ?? messages;
}
