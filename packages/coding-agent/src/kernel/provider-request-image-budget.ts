import { projectMessagesForModelImageSupport } from "@caupulican/pi-ai";
import type { Api, Context, ImageContent, Message, Model, TextContent } from "@caupulican/pi-ai/types";
import { PrefixFirstMatchByFirstItem } from "./prefix-fold.ts";
import { measureJsonUtf8Bytes } from "./provider-request-estimator.ts";

export const USER_IMAGE_BUDGET_PLACEHOLDER =
	"[An earlier image was removed to keep the request within its size limit and is no longer visible. Do not describe or reason about its contents from memory; ask the user to re-share it if you need to see it again.]";
export const TOOL_IMAGE_BUDGET_NOTE =
	"[One or more images from this tool result were removed to keep the request within its size limit and are no longer visible. Do not describe or reason about their contents from memory.]";

const MEBIBYTE = 1024 * 1024;

export interface ProviderRequestImageBudgetPolicy {
	readonly hardLimitBytes: number;
	readonly triggerBytes: number;
	readonly reclaimTargetBytes: number;
}

export const XAI_PROVIDER_REQUEST_IMAGE_BUDGET: ProviderRequestImageBudgetPolicy = Object.freeze({
	hardLimitBytes: 50 * MEBIBYTE,
	triggerBytes: 47 * MEBIBYTE,
	reclaimTargetBytes: 25 * MEBIBYTE,
});

export const BEDROCK_PROVIDER_REQUEST_IMAGE_BUDGET: ProviderRequestImageBudgetPolicy = Object.freeze({
	hardLimitBytes: 25_000_000,
	triggerBytes: 22_000_000,
	reclaimTargetBytes: 12_500_000,
});

/** Safe provider-neutral ceiling for APIs without a tighter transport-specific policy. */
export const GENERIC_PROVIDER_REQUEST_IMAGE_BUDGET: ProviderRequestImageBudgetPolicy = Object.freeze({
	hardLimitBytes: 32 * MEBIBYTE,
	triggerBytes: 29 * MEBIBYTE,
	reclaimTargetBytes: 16 * MEBIBYTE,
});

export interface ProviderRequestImageBudgetOutcome extends ProviderRequestImageBudgetPolicy {
	bodyBytes: number;
	bodyBytesAfter: number;
	inlineImages: number;
	needsImageCompaction: boolean;
	evicted: number;
}

export interface BudgetedProviderRequestContext {
	context: Context;
	outcome?: ProviderRequestImageBudgetOutcome;
}

interface ImageLocation {
	messageIndex: number;
	serializedBytes: number;
}

interface ContextImageMeasurement {
	bodyBytes: number;
	locations: ImageLocation[];
}

export function resolveProviderRequestImageBudget(model: Model<Api>): ProviderRequestImageBudgetPolicy {
	if (model.api === "bedrock-converse-stream" || model.provider === "amazon-bedrock") {
		return BEDROCK_PROVIDER_REQUEST_IMAGE_BUDGET;
	}
	if (model.provider === "xai") return XAI_PROVIDER_REQUEST_IMAGE_BUDGET;
	return GENERIC_PROVIDER_REQUEST_IMAGE_BUDGET;
}

function validatePolicy(policy: ProviderRequestImageBudgetPolicy): void {
	if (
		!Number.isSafeInteger(policy.hardLimitBytes) ||
		!Number.isSafeInteger(policy.triggerBytes) ||
		!Number.isSafeInteger(policy.reclaimTargetBytes) ||
		policy.reclaimTargetBytes < 0 ||
		policy.reclaimTargetBytes >= policy.triggerBytes ||
		policy.triggerBytes >= policy.hardLimitBytes
	) {
		throw new TypeError("provider request image budget must satisfy 0 <= reclaim target < trigger < hard limit");
	}
}

function measureContent(
	content: (TextContent | ImageContent)[],
	messageIndex: number,
	locations: ImageLocation[],
): { content: (TextContent | ImageContent)[]; dataBytes: number } {
	let changed = false;
	let dataBytes = 0;
	const projected = content.map((block) => {
		if (block.type !== "image") return block;
		changed = true;
		// ImageContent.data is base64 by contract, so every code unit is one unescaped JSON byte.
		const bytes = block.data.length;
		const blank = { type: "image" as const, data: "", mimeType: block.mimeType };
		const blankBytes = measureJsonUtf8Bytes(blank);
		if (blankBytes === undefined) throw new TypeError("image content must be JSON serializable");
		locations.push({ messageIndex, serializedBytes: blankBytes + bytes });
		dataBytes += bytes;
		return blank;
	});
	return { content: changed ? projected : content, dataBytes };
}

function measureContextImages(context: Context): ContextImageMeasurement {
	const locations: ImageLocation[] = [];
	let dataBytes = 0;
	let changed = false;
	const messages = context.messages.map((message, messageIndex) => {
		if ((message.role !== "user" && message.role !== "toolResult") || !Array.isArray(message.content)) return message;
		const measured = measureContent(message.content, messageIndex, locations);
		dataBytes += measured.dataBytes;
		if (measured.content === message.content) return message;
		changed = true;
		return { ...message, content: measured.content };
	});
	const blankBytes = measureJsonUtf8Bytes({
		systemPrompt: context.systemPrompt,
		messages: changed ? messages : context.messages,
		tools: context.tools,
	});
	if (blankBytes === undefined) throw new TypeError("provider request context must be JSON serializable");
	return { bodyBytes: blankBytes + dataBytes, locations };
}

function hasInlineImage(message: Message): boolean {
	if (message.role === "user")
		return Array.isArray(message.content) && message.content.some((block) => block.type === "image");
	return message.role === "toolResult" && message.content.some((block) => block.type === "image");
}

/**
 * Whether a wire carries an inline image. The scan resumes past the prefix it already answered for, which holds across requests
 * because converted messages keep their objects (see `convertToLlm`); the tail, rebuilt for each request, is read again. The
 * wire and its projection are read side by side, so each has its own scan (see {@link PrefixFirstMatchByFirstItem}).
 */
const inlineImageScans = new PrefixFirstMatchByFirstItem<Message>(hasInlineImage);
const projectedInlineImageScans = new PrefixFirstMatchByFirstItem<Message>(hasInlineImage);

/** Exported for its equivalence test. */
export function hasInlineImages(messages: readonly Message[]): boolean {
	return inlineImageScans.find(messages) >= 0;
}

/** Map an image-free history prefix through a request-local insertion and an optional text guard. */
export function imageFreeProviderPrefix(
	historyLength: number,
	insertAt: number,
	inserted: readonly Message[],
	textGuard: boolean,
): number {
	if (historyLength === 0) return 0;
	if (insertAt > historyLength) return historyLength + Number(textGuard);
	// A knowledge note can change on every request. Inspect those fresh rows before skipping
	// the rest of the already-checked history. An inserted image must reach the normal budget.
	const prefix = inserted.some(hasInlineImage) ? insertAt : historyLength + inserted.length;
	return prefix + Number(textGuard);
}

/**
 * Applies high-water/low-water image eviction to a request-local Context copy. Durable history is
 * never mutated; evicted images are replaced with explicit anti-hallucination notices.
 */
export function applyProviderRequestImageBudget(
	context: Context,
	model: Model<Api>,
	policy: ProviderRequestImageBudgetPolicy = resolveProviderRequestImageBudget(model),
	knownImageFreePrefix = 0,
): BudgetedProviderRequestContext {
	validatePolicy(policy);
	if (knownImageFreePrefix === 0) {
		if (!hasInlineImages(context.messages)) return { context };
	} else {
		let index = knownImageFreePrefix;
		while (index < context.messages.length && !hasInlineImage(context.messages[index]!)) index++;
		if (index === context.messages.length) return { context };
	}
	const projectedMessages = projectMessagesForModelImageSupport(context.messages, model);
	const projectedContext =
		projectedMessages === context.messages ? context : { ...context, messages: projectedMessages };
	if (projectedInlineImageScans.find(projectedMessages) < 0) return { context: projectedContext };
	const measurement = measureContextImages(projectedContext);

	const needsImageCompaction = measurement.bodyBytes >= policy.triggerBytes;
	if (!needsImageCompaction || measurement.bodyBytes <= policy.reclaimTargetBytes) {
		return {
			context: projectedContext,
			outcome: {
				...policy,
				bodyBytes: measurement.bodyBytes,
				bodyBytesAfter: measurement.bodyBytes,
				inlineImages: measurement.locations.length,
				needsImageCompaction,
				evicted: 0,
			},
		};
	}

	const messages = projectedContext.messages.slice();
	const budgetedContext = { ...projectedContext, messages };
	const userPlaceholder: TextContent = { type: "text", text: USER_IMAGE_BUDGET_PLACEHOLDER };
	const toolNote: TextContent = { type: "text", text: TOOL_IMAGE_BUDGET_NOTE };
	const userPlaceholderBytes = measureJsonUtf8Bytes(userPlaceholder);
	const toolNoteBytes = measureJsonUtf8Bytes(toolNote);
	if (userPlaceholderBytes === undefined || toolNoteBytes === undefined) {
		throw new TypeError("image budget placeholders must be JSON serializable");
	}
	let bodyBytesAfter = measurement.bodyBytes;
	let evicted = 0;

	// Locations are in message and block order. Decide a whole message's evictions before rewriting
	// its content once. Earlier versions searched and spliced the same content array for each image.
	while (evicted < measurement.locations.length && bodyBytesAfter > policy.reclaimTargetBytes) {
		const start = evicted;
		const { messageIndex } = measurement.locations[start]!;
		const message = messages[messageIndex]!;
		if ((message.role !== "toolResult" && message.role !== "user") || !Array.isArray(message.content)) {
			throw new TypeError("provider request image location changed during budgeting");
		}
		const content = message.content;
		const appendNote =
			message.role === "toolResult" &&
			!content.some((block) => block.type === "text" && block.text === TOOL_IMAGE_BUDGET_NOTE);
		if (appendNote) bodyBytesAfter += toolNoteBytes + 1;
		do {
			const imageBytes = measurement.locations[evicted++]!.serializedBytes;
			bodyBytesAfter -= message.role === "user" ? imageBytes - userPlaceholderBytes : imageBytes + 1;
		} while (
			bodyBytesAfter > policy.reclaimTargetBytes &&
			measurement.locations[evicted]?.messageIndex === messageIndex
		);

		let remaining = evicted - start;
		const kept: (TextContent | ImageContent)[] = [];
		for (const block of content) {
			if (remaining > 0 && block.type === "image") {
				remaining--;
				if (message.role === "user") kept.push(userPlaceholder);
			} else kept.push(block);
		}
		if (appendNote) kept.push(toolNote);
		messages[messageIndex] = { ...message, content: kept };
	}

	return {
		context: budgetedContext,
		outcome: {
			...policy,
			bodyBytes: measurement.bodyBytes,
			bodyBytesAfter,
			inlineImages: measurement.locations.length,
			needsImageCompaction,
			evicted,
		},
	};
}
