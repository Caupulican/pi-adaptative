/**
 * What a delegated lane's memory read may add to the lane's NEXT request, measured on the lane itself: its
 * own model window, its last accepted request (system prompt, tool schemas and messages as sent), the reply
 * room it keeps free and the tokens its grant still allows. A read runs inside a tool call, so the figures
 * are those of the last accepted request; the lane sends no other request while the read is in flight.
 */

import type { Api, Context, Model } from "@caupulican/pi-ai";
import { estimateProviderRequestTokens } from "../../kernel/provider-request-estimator.ts";
import { estimateReplyReserveTokens } from "../context/prompt-headroom.ts";
import type { LaneMemoryCapacity, LaneMemoryCapacitySource } from "../memory/worker-memory-tools.ts";

export interface LaneMemoryCapacityTrackerOptions {
	/** The model the lane's requests are sent to. */
	model: Model<Api>;
	/** The lane's compaction reserve, already bounded to the lane's own window. */
	compactionReserveTokens: number;
	/** The output cap the lane's requests are sent with. */
	maxOutputTokens: number;
	/** Tokens the lane may still spend under its grant and its tree's, read at use. */
	remainingTokenAllowance(): number | undefined;
}

export class LaneMemoryCapacityTracker {
	private readonly options: LaneMemoryCapacityTrackerOptions;
	private lastAccepted: Context | undefined;
	private revision = 0;

	constructor(options: LaneMemoryCapacityTrackerOptions) {
		this.options = options;
	}

	/** The lane's provider request was accepted: later reads size against it. */
	noteRequestAccepted(context: Context): void {
		this.lastAccepted = context;
		this.revision += 1;
	}

	/** Live capacity; undefined (unknown) until the lane has sent a request or when its model declares no window. */
	readonly source: LaneMemoryCapacitySource = (): LaneMemoryCapacity | undefined => {
		const { model } = this.options;
		const contextWindow = model.contextWindow;
		if (this.lastAccepted === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
		const remainingTokenAllowance = this.options.remainingTokenAllowance();
		return {
			contextWindow,
			currentPromptTokens: estimateProviderRequestTokens(this.lastAccepted, model),
			reservedTokens: estimateReplyReserveTokens({
				contextWindow,
				compactionReserveTokens: this.options.compactionReserveTokens,
				maxOutputTokens: this.options.maxOutputTokens,
			}),
			...(remainingTokenAllowance !== undefined ? { remainingTokenAllowance } : {}),
			revision: this.revision,
		};
	};
}
