/**
 * Headroom of the provider request the memory block will join: how many tokens the request already
 * carries and how many the window must keep free, so the memory allowance is bounded by the real
 * request and not by the context window alone.
 */

import type { Api, Model, SimpleStreamOptions, Tool } from "@caupulican/pi-ai";
import { materializeProviderRequest } from "@caupulican/pi-ai/stream";
import { estimateContextTokens } from "../../kernel/compaction/compaction.ts";
import { estimateProviderRequestTokens } from "../../kernel/provider-request-estimator.ts";
import { projectToolsForProvider } from "../../kernel/provider-tool-projection.ts";
import type { AgentMessage } from "../../kernel/types.ts";

/** Largest share of the context window the output cap may reserve (compaction bounds its reserve the same way). */
const OUTPUT_RESERVE_WINDOW_SHARE = 0.25;

export interface PromptHeadroom {
	/** Estimated tokens the request carries before the memory block is added. */
	currentPromptTokens: number;
	/** Tokens the window keeps free for the reply and for compaction to act. */
	reservedTokens: number;
}

export interface PromptHeadroomInput {
	model: Model<Api> | undefined;
	systemPrompt: string;
	tools: readonly Tool[];
	textToolCallProtocol: SimpleStreamOptions["textToolCallProtocol"];
	/** The messages the request will carry, without the memory block. */
	messages: readonly AgentMessage[];
	/** The compaction reserve in force for this model (already adapted to its window): the room kept for the reply. */
	compactionReserveTokens: number;
	/** The output cap the request will be sent with, when known. */
	maxOutputTokens: number | undefined;
}

/**
 * The reply reserve is the larger of the compaction reserve and the output cap, not their sum: the
 * compaction reserve is already the room kept free for the reply, so adding the output cap would count
 * the same reply twice and switch memory off on windows where it fits. The output cap counts for at most
 * a quarter of the window (the same bound compaction applies to its reserve), because the planner
 * narrows an oversized cap to what the window leaves rather than refusing the request.
 *
 * When an assistant usage report covers the message prefix, its total already includes the system
 * prompt and the tool schemas, so only the unreported tail is added to it; without one, the envelope
 * (system prompt and tools) is estimated and added to the message estimate.
 */
export function estimatePromptHeadroom(input: PromptHeadroomInput): PromptHeadroom {
	const contextWindow = input.model?.contextWindow ?? 0;
	const outputReserve = Math.min(input.maxOutputTokens ?? 0, Math.floor(contextWindow * OUTPUT_RESERVE_WINDOW_SHARE));
	const messages = estimateContextTokens(input.messages);
	const envelopeTokens =
		messages.lastUsageIndex === null
			? estimateProviderRequestTokens(
					materializeProviderRequest(
						{
							systemPrompt: input.systemPrompt,
							messages: [],
							tools: projectToolsForProvider(input.tools),
						},
						{ textToolCallProtocol: input.textToolCallProtocol },
					).context,
					input.model,
				)
			: 0;
	return {
		currentPromptTokens: envelopeTokens + messages.tokens,
		reservedTokens: Math.max(input.compactionReserveTokens, outputReserve),
	};
}
