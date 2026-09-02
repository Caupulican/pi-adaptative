import { projectMessagesForModelImageSupport } from "@caupulican/pi-ai";
import type { Api, Context, ImageContent, Message, Model, TextContent } from "@caupulican/pi-ai/types";
import { PrefixFoldByFirstItem } from "./prefix-fold.ts";
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
	role: "user" | "toolResult";
	block: ImageContent;
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
	role: ImageLocation["role"],
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
		locations.push({ messageIndex, role, block, serializedBytes: blankBytes + bytes });
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
		if (message.role === "user" && Array.isArray(message.content)) {
			const measured = measureContent(message.content, messageIndex, "user", locations);
			dataBytes += measured.dataBytes;
			if (measured.content === message.content) return message;
			changed = true;
			return { ...message, content: measured.content };
		}
		if (message.role === "toolResult") {
			const measured = measureContent(message.content, messageIndex, "toolResult", locations);
			dataBytes += measured.dataBytes;
			if (measured.content === message.content) return message;
			changed = true;
			return { ...message, content: measured.content };
		}
		return message;
	});
	const blankBytes = measureJsonUtf8Bytes({
		systemPrompt: context.systemPrompt,
		messages: changed ? messages : context.messages,
		tools: context.tools,
	});
	if (blankBytes === undefined) throw new TypeError("provider request context must be JSON serializable");
	return { bodyBytes: blankBytes + dataBytes, locations };
}

function cloneImageBearingMessages(messages: Message[]): Message[] {
	return messages.map((message) => {
		if (message.role === "user" && Array.isArray(message.content)) {
			return { ...message, content: message.content.slice() };
		}
		if (message.role === "toolResult") return { ...message, content: message.content.slice() };
		return message;
	});
}

function hasInlineImage(message: Message): boolean {
	if (message.role === "user")
		return Array.isArray(message.content) && message.content.some((block) => block.type === "image");
	return message.role === "toolResult" && message.content.some((block) => block.type === "image");
}

/** Whether any message carries an inline image, scanned once per appended message. */
const inlineImageScans = new PrefixFoldByFirstItem<Message, { found: boolean }>(
	() => ({ found: false }),
	(state, message) => {
		if (!state.found && hasInlineImage(message)) state.found = true;
	},
);

/** Exported for its equivalence test; the scan resumes past the prefix it already answered for. */
export function hasInlineImages(messages: readonly Message[]): boolean {
	return inlineImageScans.fold(messages).found;
}

/**
 * Applies high-water/low-water image eviction to a request-local Context copy. Durable history is
 * never mutated; evicted images are replaced with explicit anti-hallucination notices.
 */
export function applyProviderRequestImageBudget(
	context: Context,
	model: Model<Api>,
	policy: ProviderRequestImageBudgetPolicy = resolveProviderRequestImageBudget(model),
): BudgetedProviderRequestContext {
	validatePolicy(policy);
	if (!hasInlineImages(context.messages)) return { context };
	const projectedMessages = projectMessagesForModelImageSupport(context.messages, model);
	const projectedContext =
		projectedMessages === context.messages ? context : { ...context, messages: projectedMessages };
	if (!hasInlineImages(projectedMessages)) return { context: projectedContext };
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

	const messages = cloneImageBearingMessages(projectedContext.messages);
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

	for (const location of measurement.locations) {
		if (bodyBytesAfter <= policy.reclaimTargetBytes) break;
		const message = messages[location.messageIndex];
		if (location.role === "user") {
			if (message?.role !== "user" || !Array.isArray(message.content)) {
				throw new TypeError("provider request image location changed during budgeting");
			}
			const blockIndex = message.content.indexOf(location.block);
			if (blockIndex < 0) throw new TypeError("provider request user image disappeared during budgeting");
			message.content[blockIndex] = userPlaceholder;
			bodyBytesAfter -= location.serializedBytes - userPlaceholderBytes;
		} else {
			if (message?.role !== "toolResult") {
				throw new TypeError("provider request image location changed during budgeting");
			}
			const blockIndex = message.content.indexOf(location.block);
			if (blockIndex < 0) throw new TypeError("provider request tool image disappeared during budgeting");
			const hasNote = message.content.some(
				(block) => block.type === "text" && block.text === TOOL_IMAGE_BUDGET_NOTE,
			);
			if (!hasNote) {
				bodyBytesAfter += toolNoteBytes + (message.content.length > 0 ? 1 : 0);
				message.content.push(toolNote);
			}
			message.content.splice(blockIndex, 1);
			bodyBytesAfter -= location.serializedBytes + 1;
		}
		evicted++;
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
