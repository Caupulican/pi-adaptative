/** Places immutable Anthropic cache markers and identifies the final cache-write prefix. */
import type {
	CacheControlEphemeral,
	MessageCreateParamsStreaming,
	MessageParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import { freezeOwnedJson, providerInputPrefix } from "../history-work.ts";
import type { Model } from "../types.ts";
import { shortHash } from "../utils/hash.ts";
import type { AnthropicWireRow } from "./anthropic-history.ts";

/** Anthropic accepts at most this many cache breakpoints per request, across system, tools and messages. */
const ANTHROPIC_CACHE_BREAKPOINT_LIMIT = 4;

export interface AnthropicCacheBoundary {
	messageIndex: number;
	blockIndex: number;
}

const prefixCacheKeys = new WeakMap<
	readonly unknown[],
	{
		header: string;
		providerScope: string;
		messageIndex: number;
		blockIndex: number;
		key: string;
	}
>();

const decoratedCacheRows = new WeakMap<MessageParam, { key: string; message: MessageParam }>();

function withAnthropicCacheMarkers(
	message: MessageParam,
	positions: number[],
	cacheControl: CacheControlEphemeral,
	shared: boolean,
): MessageParam {
	const key = JSON.stringify([positions, cacheControl]);
	const previous = shared && decoratedCacheRows.get(message);
	if (previous && previous.key === key) return previous.message;
	const content =
		typeof message.content === "string"
			? [{ type: "text" as const, text: message.content, cache_control: cacheControl }]
			: message.content.map((block, index) =>
					positions.includes(index) ? { ...block, cache_control: cacheControl } : block,
				);
	const marked = { ...message, content };
	if (shared) {
		freezeOwnedJson(marked);
		decoratedCacheRows.set(message, { key, message: marked });
	}
	return marked;
}

/** Allocate request-local markers, keeping shared history rows free of request-specific cache policy. */
export function placeCacheBoundaryMarkers(
	params: MessageCreateParamsStreaming,
	rows: readonly AnthropicWireRow[],
	cacheControl: CacheControlEphemeral | undefined,
	shared: boolean,
): AnthropicCacheBoundary | undefined {
	const messages = params.messages;
	if (!cacheControl || messages.length === 0) return undefined;
	const marked = new Map<number, number[]>();
	const mark = (index: number, block: number) => {
		const positions = marked.get(index);
		if (positions) {
			if (!positions.includes(block)) positions.push(block);
		} else {
			marked.set(index, [block]);
		}
	};

	const last = messages.at(-1)!;
	if (last.role === "user") {
		if (typeof last.content === "string") {
			mark(messages.length - 1, 0);
		} else {
			const block = last.content.at(-1);
			if (block?.type === "text" || block?.type === "image" || block?.type === "tool_result") {
				mark(messages.length - 1, last.content.length - 1);
			}
		}
	}
	const system = Array.isArray(params.system) ? params.system : [];
	const existing = [...system, ...(params.tools ?? [])].filter(
		(block) => "cache_control" in block && block.cache_control,
	).length;
	let available = ANTHROPIC_CACHE_BREAKPOINT_LIMIT - existing - marked.size;
	let newestPlaced: AnthropicCacheBoundary | undefined;
	let messageIndex = messages.length;
	for (let rowIndex = rows.length - 1; rowIndex >= 0 && available > 0; rowIndex--) {
		const row = rows[rowIndex]!;
		if (row.message) messageIndex--;
		const blocks = row.boundaries;
		if (!blocks) continue;
		for (let index = blocks.length - 1; index >= 0 && available > 0; index--) {
			const blockIndex = blocks[index]!;
			available--;
			if (blockIndex < 0) continue;
			mark(messageIndex, blockIndex);
			newestPlaced ??= { messageIndex, blockIndex };
		}
	}
	for (const [index, positions] of marked) {
		messages[index] = withAnthropicCacheMarkers(messages[index]!, positions, cacheControl, shared);
	}
	return newestPlaced;
}

/**
 * Identity of the final serialized wire prefix through the semantic view boundary. Post-boundary live state and the
 * current user message deliberately do not participate, so concurrent compactions over one view share one writer.
 */
export function cacheBoundaryPrefixKey(
	model: Model<"anthropic-messages">,
	params: MessageCreateParamsStreaming,
	boundary: AnthropicCacheBoundary | undefined,
	accountScope?: string,
): string | undefined {
	if (boundary === undefined) return undefined;
	const boundaryMessage = params.messages[boundary.messageIndex];
	if (boundaryMessage === undefined || !Array.isArray(boundaryMessage.content)) return undefined;
	const boundaryBlock = boundaryMessage.content[boundary.blockIndex];
	if (boundaryBlock === undefined || !("cache_control" in boundaryBlock) || !boundaryBlock.cache_control) {
		return undefined;
	}
	const receipt = providerInputPrefix(params.messages);
	const providerScope = [model.provider, model.id, accountScope ?? ""].join("|");
	const header = receipt ? JSON.stringify([params.system, params.tools]) : undefined;
	if (receipt?.previous && receipt.count > boundary.messageIndex) {
		const prior = prefixCacheKeys.get(receipt.previous);
		if (
			prior?.providerScope === providerScope &&
			prior.header === header &&
			prior.messageIndex === boundary.messageIndex &&
			prior.blockIndex === boundary.blockIndex
		) {
			prefixCacheKeys.set(params.messages, prior);
			return prior.key;
		}
	}
	const messages = [
		...params.messages.slice(0, boundary.messageIndex),
		{ ...boundaryMessage, content: boundaryMessage.content.slice(0, boundary.blockIndex + 1) },
	];
	const prefix = JSON.stringify([params.system, params.tools, messages]);
	const key = `${providerScope}|${shortHash(prefix)}`;
	if (header !== undefined) prefixCacheKeys.set(params.messages, { header, providerScope, ...boundary, key });
	return key;
}
